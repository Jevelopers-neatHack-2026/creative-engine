import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUsageObservation, deliverPendingUsageObservations, TelemetryBoundaryError, USAGE_PROFILE } from "../../src/telemetry/index.mjs";
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
  assert.equal(authorityCalls, 0);
});
