import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTelemetryEvidence, createUsageObservation, deliverPendingTelemetryEvidence, deliverPendingUsageObservations, TelemetryBoundaryError, USAGE_PROFILE } from "../../src/telemetry/index.mjs";
import { validateMeteredAttempt } from "../../src/contracts/metering.mjs";
import { FakeMeteringAuthority } from "../../fixtures/contracts/metering/fake-authority.mjs";
import { JsonObservationOutboxFixture } from "../../fixtures/metering/json-observation-outbox.mjs";
import { fixtureAttempt, trustedScope } from "../../fixtures/metering/attempt.mjs";

async function setup(t, { failNextAcknowledge = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "creative-telemetry-outbox-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "outbox.json");
  const attempt = validateMeteredAttempt(fixtureAttempt(), trustedScope);
  const observation = createUsageObservation({
    attempt,
    trustedScope,
    profile: USAGE_PROFILE.NORMALIZED,
    sourceObservationId: "usage:outbox-1",
    providerRequestId: "req:outbox-1",
    transportAttemptId: "transport:outbox-1",
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  const authority = new FakeMeteringAuthority();
  await authority.reserveAttempt(attempt);
  const outbox = new JsonObservationOutboxFixture(path, { failNextAcknowledge });
  await outbox.enqueue({ record_ref: "outbox:record-1", attempt, observation });
  return { path, attempt, observation, authority, outbox };
}

test("observation acknowledgement can retry after restart without redispatching a paid operation", async (t) => {
  const state = await setup(t, { failNextAcknowledge: true });
  const first = await deliverPendingUsageObservations({
    meteringPort: state.authority,
    outbox: state.outbox,
    trustedScopeForRecord: () => trustedScope,
  });
  assert.deepEqual(first, { status: "pending", attempted: 1, acknowledged: 0, retained: 1 });
  assert.equal(state.authority.observationsById.size, 1);
  assert.equal(state.authority.effectiveChargeCount, 1);

  // A new adapter instance represents process restart; the durable fixture retains
  // the same event and C03 observes the replay as a duplicate by source identity.
  const restarted = new JsonObservationOutboxFixture(state.path);
  const replay = await deliverPendingUsageObservations({
    meteringPort: state.authority,
    outbox: restarted,
    trustedScopeForRecord: () => trustedScope,
  });
  assert.deepEqual(replay, { status: "complete", attempted: 1, acknowledged: 1, retained: 0 });
  assert.equal(await restarted.status("outbox:record-1"), "delivered");
  assert.equal(state.authority.observationsById.size, 1);
  assert.equal(state.authority.effectiveChargeCount, 1);
  assert.equal("dispatch" in restarted, false, "the retry worker has no provider transport capability");
});

test("foreign scope is retained for retry and never submitted to the authority", async (t) => {
  const state = await setup(t);
  const authorityCalls = [];
  const meteringPort = {
    async recordUsageObservation(command) {
      authorityCalls.push(command);
      return state.authority.recordUsageObservation(command);
    },
  };
  const result = await deliverPendingUsageObservations({
    meteringPort,
    outbox: state.outbox,
    trustedScopeForRecord: () => ({ ...trustedScope, project_id: "project:foreign" }),
  });
  assert.deepEqual(result, { status: "pending", attempted: 1, acknowledged: 0, retained: 1 });
  assert.equal(authorityCalls.length, 0);
  assert.equal(await state.outbox.status("outbox:record-1"), "pending");
});

test("malformed duplicate outbox references fail before any authority call", async () => {
  let authorityCalls = 0;
  const duplicate = {
    record_ref: "outbox:duplicate",
    claim_token: "claim:duplicate",
    attempt: fixtureAttempt(),
    observation: { source_observation_id: "usage:duplicate" },
  };
  await assert.rejects(() => deliverPendingUsageObservations({
    meteringPort: { async recordUsageObservation() { authorityCalls += 1; } },
    outbox: {
      async claimPending() { return { status: "claimed", records: [duplicate, duplicate] }; },
      async acknowledge() { return { status: "acknowledged", source_observation_id: "usage:duplicate" }; },
      async defer() { return { status: "retained" }; },
    },
    trustedScopeForRecord: () => trustedScope,
  }), TelemetryBoundaryError);
  await assert.rejects(() => deliverPendingUsageObservations({
    meteringPort: { async recordUsageObservation() { authorityCalls += 1; } },
    outbox: {
      async claimPending() { return { status: "claimed", records: [duplicate, { ...duplicate, record_ref: "outbox:other" }] }; },
      async acknowledge(args) { return { status: "acknowledged", source_observation_id: args.source_observation_id }; },
      async defer() { return { status: "retained" }; },
    },
    trustedScopeForRecord: () => trustedScope,
  }), (error) => error instanceof TelemetryBoundaryError && error.code === "duplicate_outbox_claim_token");
  assert.equal(authorityCalls, 0);
});

function evidenceRecord(id) {
  return {
    record_ref: `outbox:${id}`,
    claim_token: `claim:${id}`,
    event: structuredClone(createTelemetryEvidence({
      eventId: `event:${id}`,
      type: "attempt_intent",
      attempt: fixtureAttempt(),
      trustedScope,
      modes: { provider_execution_mode: "mock", commerce_mode: "simulated" },
      occurredAt: "2026-10-10T12:00:00.000Z",
    })),
  };
}

function evidenceOutbox(records, acknowledgements = [], deferrals = []) {
  return {
    async claimPendingEvidence() { return { status: "claimed", records }; },
    async acknowledgeEvidence(args) {
      acknowledgements.push(args);
      return { status: "acknowledged", event_id: args.event_id };
    },
    async deferEvidence(args) { deferrals.push(args); return { status: "retained" }; },
  };
}

test("evidence replay validates the complete batch before sending or acknowledging any event", async () => {
  const cases = [
    ["duplicate_evidence_record", (first, second) => { second.event.event_id = first.event.event_id; }],
    ["duplicate_evidence_reference", (first, second) => { second.record_ref = first.record_ref; }],
    ["duplicate_evidence_claim_token", (first, second) => { second.claim_token = first.claim_token; }],
    ["invalid_evidence_record", (_first, second) => { second.event.event_id = "Bearer synthetic-canary"; }],
    ["invalid_evidence_record", (_first, second) => { second.event.provider.model = "Bearer synthetic-canary"; }],
  ];
  for (const [code, corrupt] of cases) {
    const records = [evidenceRecord("first"), evidenceRecord("second")];
    corrupt(...records);
    let sinkCalls = 0;
    const acknowledgements = [];
    const deferrals = [];
    await assert.rejects(() => deliverPendingTelemetryEvidence({
      outbox: evidenceOutbox(records, acknowledgements, deferrals),
      sink: { async record(event) { sinkCalls += 1; return { status: "accepted", event_id: event.event_id }; } },
    }), (error) => error instanceof TelemetryBoundaryError && error.code === code);
    assert.equal(sinkCalls, 0, code);
    assert.deepEqual(acknowledgements, [], code);
    assert.deepEqual(deferrals, [], code);
  }
});

test("evidence replay snapshots later records before awaiting the sink", async () => {
  const records = [evidenceRecord("first"), evidenceRecord("second")];
  const acknowledgements = [];
  const delivered = [];
  const result = await deliverPendingTelemetryEvidence({
    outbox: evidenceOutbox(records, acknowledgements),
    sink: {
      async record(event) {
        delivered.push(event);
        if (delivered.length === 1) {
          await Promise.resolve();
          records[1].event.provider.model = "Bearer synthetic-canary";
          records[1].claim_token = "claim:replacement";
          records.push(evidenceRecord("injected"));
        }
        return { status: "accepted", event_id: event.event_id };
      },
    },
  });
  assert.deepEqual(result, { status: "complete", attempted: 2, acknowledged: 2, retained: 0 });
  assert.deepEqual(delivered.map((event) => event.event_id), ["event:first", "event:second"]);
  assert.equal(delivered[1].provider.model, fixtureAttempt().provider.model);
  assert.equal(acknowledgements[1].claim_token, "claim:second");
  assert.doesNotMatch(JSON.stringify(delivered), /synthetic-canary/);
});

test("evidence replay rejects non-JSON and oversized batches without invoking accessors or the sink", async () => {
  let getterCalls = 0;
  const accessorRecord = evidenceRecord("accessor");
  Object.defineProperty(accessorRecord.event, "provider", {
    enumerable: true,
    get() { getterCalls += 1; throw new Error("synthetic-secret"); },
  });
  const cyclicRecord = evidenceRecord("cyclic");
  cyclicRecord.event.loop = cyclicRecord.event;
  const oversizedRecord = evidenceRecord("oversized");
  oversizedRecord.event.extension = "x".repeat(128 * 1024 + 1);
  const sparseRecords = [evidenceRecord("first")];
  sparseRecords.length = 2;
  const cases = [
    ["invalid_evidence_record", [evidenceRecord("first"), null]],
    ["invalid_evidence_record", [evidenceRecord("first"), accessorRecord]],
    ["invalid_evidence_record", [evidenceRecord("first"), cyclicRecord]],
    ["invalid_evidence_record", [evidenceRecord("first"), oversizedRecord]],
    ["invalid_evidence_batch", sparseRecords],
  ];
  for (const [code, records] of cases) {
    let sinkCalls = 0;
    const acknowledgements = [];
    const deferrals = [];
    await assert.rejects(() => deliverPendingTelemetryEvidence({
      outbox: evidenceOutbox(records, acknowledgements, deferrals),
      sink: { async record() { sinkCalls += 1; } },
    }), (error) => error instanceof TelemetryBoundaryError && error.code === code && !String(error).includes("synthetic-secret"));
    assert.equal(sinkCalls, 0);
    assert.deepEqual(acknowledgements, []);
    assert.deepEqual(deferrals, []);
  }
  assert.equal(getterCalls, 0);
});
