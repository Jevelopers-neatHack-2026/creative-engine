import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createSqliteTelemetryOutbox,
  createTelemetryEvidence,
  createUsageObservation,
  deliverPendingTelemetryEvidence,
  deliverPendingUsageObservations,
  TelemetryBoundaryError,
  USAGE_PROFILE,
} from "../../src/telemetry/index.mjs";
import { FakeMeteringAuthority } from "../../fixtures/contracts/metering/fake-authority.mjs";
import { fixtureAttempt, trustedScope } from "../../fixtures/metering/attempt.mjs";

const modes = Object.freeze({ provider_execution_mode: "mock", commerce_mode: "simulated" });

async function temporaryDatabase(t) {
  const directory = await mkdtemp(join(tmpdir(), "creative-telemetry-sqlite-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "telemetry.sqlite");
}

function openDatabase(path) {
  return new DatabaseSync(path, { timeout: 5000 });
}

function makeEvent(eventId = "event:sqlite-1") {
  return createTelemetryEvidence({
    eventId,
    type: "attempt_intent",
    attempt: fixtureAttempt(),
    trustedScope,
    modes,
    occurredAt: "2026-10-10T12:00:00.000Z",
  });
}

function makeObservation({ sourceObservationId = "usage:sqlite-1", inputTokens = 8 } = {}) {
  const attempt = fixtureAttempt();
  const observation = createUsageObservation({
    attempt,
    trustedScope,
    profile: USAGE_PROFILE.NORMALIZED,
    sourceObservationId,
    providerRequestId: `req:${sourceObservationId}`,
    transportAttemptId: `transport:${sourceObservationId}`,
    usage: { input_tokens: inputTokens, output_tokens: 3 },
  });
  return { attempt, observation };
}

function runWorker(path, mode) {
  return new Promise((resolve, reject) => {
    const args = [
      new URL("../../fixtures/metering/sqlite-claim-worker.mjs", import.meta.url).pathname,
      path,
    ];
    if (mode) args.push(mode);
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      try { resolve({ code, response: JSON.parse(stdout.trim()), stderr }); }
      catch { reject(new Error(`claim worker returned invalid output after ${code}: ${stderr}`)); }
    });
  });
}

test("SQLite outbox snapshots evidence and C03 observations, fences claims, and survives reopen", async (t) => {
  const path = await temporaryDatabase(t);
  let now = 10_000;
  let sequence = 0;
  const idFactory = (kind) => `local:${kind}:${++sequence}`;
  const firstDb = openDatabase(path);
  const first = createSqliteTelemetryOutbox({ database: firstDb, clock: () => now, claimLeaseMs: 100, idFactory });

  const rawEvent = structuredClone(makeEvent());
  const appendPromise = first.append(rawEvent);
  rawEvent.provider.name = "mutated-after-append";
  assert.deepEqual(await appendPromise, { status: "recorded", event_id: "event:sqlite-1" });
  assert.deepEqual(await first.append(makeEvent()), { status: "duplicate", event_id: "event:sqlite-1" });

  const source = makeObservation();
  const enqueuePromise = first.enqueueUsageObservation({ ...source, trustedScope });
  source.attempt.billable_attempt_id = "attempt:mutated-after-enqueue";
  const inserted = await enqueuePromise;
  assert.equal(inserted.status, "recorded");
  assert.match(inserted.payload_hash, /^sha256:[a-f0-9]{64}$/);
  const duplicate = await first.enqueueUsageObservation({ ...makeObservation(), trustedScope });
  assert.equal(duplicate.status, "duplicate");
  assert.equal(duplicate.record_ref, inserted.record_ref);
  await assert.rejects(
    () => first.enqueueUsageObservation({ ...makeObservation({ inputTokens: 9 }), trustedScope }),
    (error) => error instanceof TelemetryBoundaryError && error.code === "observation_identity_conflict",
  );

  const rows = firstDb.prepare("SELECT payload_sha256, claim_token_sha256 FROM creative_telemetry_observations_v1").all();
  assert.equal(rows.length, 1);
  assert.match(rows[0].payload_sha256, /^[a-f0-9]{64}$/);
  assert.equal(rows[0].claim_token_sha256, null);
  firstDb.close();

  const reopenedDb = openDatabase(path);
  const reopened = createSqliteTelemetryOutbox({ database: reopenedDb, clock: () => now, claimLeaseMs: 100, idFactory });
  const evidenceClaim = await reopened.claimPendingEvidence({ limit: 1 });
  assert.equal(evidenceClaim.records.length, 1);
  assert.equal(evidenceClaim.records[0].event.provider.name, "openai");
  const staleEvidenceClaim = evidenceClaim.records[0];
  const observationClaim = await reopened.claimPending({ limit: 1 });
  assert.equal(observationClaim.records.length, 1);
  assert.equal(observationClaim.records[0].attempt.billable_attempt_id, "attempt:fixture-001");
  assert.equal(observationClaim.records[0].observation.source_observation_id, "usage:sqlite-1");
  assert.equal(Object.isFrozen(observationClaim.records[0].observation), true);

  now += 101;
  const reclaimedEvidence = await reopened.claimPendingEvidence({ limit: 1 });
  assert.equal(reclaimedEvidence.records.length, 1);
  assert.notEqual(reclaimedEvidence.records[0].claim_token, staleEvidenceClaim.claim_token);
  assert.deepEqual(await reopened.acknowledgeEvidence({
    event_id: "event:sqlite-1", claim_token: staleEvidenceClaim.claim_token,
  }), { status: "lease_lost", event_id: "event:sqlite-1" });
  assert.deepEqual(await reopened.acknowledgeEvidence({
    event_id: "event:sqlite-1", claim_token: reclaimedEvidence.records[0].claim_token,
  }), { status: "acknowledged", event_id: "event:sqlite-1" });

  now += 101;
  const reclaimedObservation = await reopened.claimPending({ limit: 1 });
  assert.equal(reclaimedObservation.records.length, 1);
  assert.deepEqual(await reopened.acknowledge({
    record_ref: inserted.record_ref,
    claim_token: observationClaim.records[0].claim_token,
    source_observation_id: "usage:sqlite-1",
    effective_billable_attempt_id: "attempt:fixture-001",
    authority_status: "accepted",
  }), { status: "mismatch", source_observation_id: "usage:sqlite-1" });
  assert.deepEqual(await reopened.acknowledge({
    record_ref: inserted.record_ref,
    claim_token: reclaimedObservation.records[0].claim_token,
    source_observation_id: "usage:sqlite-1",
    effective_billable_attempt_id: "attempt:fixture-001",
    authority_status: "duplicate",
  }), { status: "acknowledged", source_observation_id: "usage:sqlite-1" });
  assert.deepEqual(await reopened.status("observation", inserted.record_ref), {
    status: "delivered", claim_count: 2, created_at: 10_000, delivered_at: now,
  });
  reopenedDb.close();
});

test("durable claim generations fence stale acknowledgements when the host id factory repeats after restart", async (t) => {
  const path = await temporaryDatabase(t);
  let now = 20_000;
  const repeatedIdFactory = (kind) => `stable:${kind}`;
  const firstDb = openDatabase(path);
  const first = createSqliteTelemetryOutbox({ database: firstDb, clock: () => now, claimLeaseMs: 100,
    idFactory: repeatedIdFactory });
  await first.append(makeEvent("event:repeated-claim-id"));
  const source = makeObservation({ sourceObservationId: "usage:repeated-claim-id" });
  const queued = await first.enqueueUsageObservation({ ...source, trustedScope });
  const oldEvidence = (await first.claimPendingEvidence({ limit: 1 })).records[0];
  const oldObservation = (await first.claimPending({ limit: 1 })).records[0];
  firstDb.close();

  now += 101;
  const reopenedDb = openDatabase(path);
  const reopened = createSqliteTelemetryOutbox({ database: reopenedDb, clock: () => now, claimLeaseMs: 100,
    idFactory: repeatedIdFactory });
  const newEvidence = (await reopened.claimPendingEvidence({ limit: 1 })).records[0];
  const newObservation = (await reopened.claimPending({ limit: 1 })).records[0];
  assert.notEqual(newEvidence.claim_token, oldEvidence.claim_token);
  assert.notEqual(newObservation.claim_token, oldObservation.claim_token);
  assert.deepEqual(await reopened.acknowledgeEvidence({
    event_id: "event:repeated-claim-id", claim_token: oldEvidence.claim_token,
  }), { status: "lease_lost", event_id: "event:repeated-claim-id" });
  assert.deepEqual(await reopened.acknowledge({
    record_ref: queued.record_ref,
    claim_token: oldObservation.claim_token,
    source_observation_id: "usage:repeated-claim-id",
    effective_billable_attempt_id: "attempt:fixture-001",
    authority_status: "accepted",
  }), { status: "mismatch", source_observation_id: "usage:repeated-claim-id" });
  assert.deepEqual(await reopened.acknowledgeEvidence({
    event_id: "event:repeated-claim-id", claim_token: newEvidence.claim_token,
  }), { status: "acknowledged", event_id: "event:repeated-claim-id" });
  assert.deepEqual(await reopened.acknowledge({
    record_ref: queued.record_ref,
    claim_token: newObservation.claim_token,
    source_observation_id: "usage:repeated-claim-id",
    effective_billable_attempt_id: "attempt:fixture-001",
    authority_status: "duplicate",
  }), { status: "acknowledged", source_observation_id: "usage:repeated-claim-id" });
  assert.equal((await reopened.status("evidence", "event:repeated-claim-id")).claim_count, 2);
  assert.equal((await reopened.status("observation", queued.record_ref)).claim_count, 2);
  reopenedDb.close();
});

test("SQLite claims serialize across independent processes so one worker owns each row", async (t) => {
  const path = await temporaryDatabase(t);
  const database = openDatabase(path);
  const outbox = createSqliteTelemetryOutbox({ database, clock: () => 1_000_000 });
  const { attempt, observation } = makeObservation();
  await outbox.enqueueUsageObservation({ attempt, observation, trustedScope });
  database.close();

  const [left, right] = await Promise.all([runWorker(path), runWorker(path)]);
  assert.deepEqual([left.response.refs.length, right.response.refs.length].sort(), [0, 1]);
  assert.deepEqual([left.code, right.code], [0, 0]);
  const claimedRef = left.response.refs[0] ?? right.response.refs[0];
  assert.equal(typeof claimedRef, "string");
});

test("a process crash after claim leaves durable work recoverable after lease expiry", async (t) => {
  const path = await temporaryDatabase(t);
  const database = openDatabase(path);
  const initial = createSqliteTelemetryOutbox({ database, clock: () => 1_000_000 });
  const { attempt, observation } = makeObservation({ sourceObservationId: "usage:worker-crash" });
  await initial.enqueueUsageObservation({ attempt, observation, trustedScope });
  database.close();

  const crashed = await runWorker(path, "crash-after-claim");
  assert.equal(crashed.code, 73);
  assert.equal(crashed.response.refs.length, 1);
  assert.equal(typeof crashed.response.claim_token, "string");

  const reopenedDb = openDatabase(path);
  const recovered = createSqliteTelemetryOutbox({ database: reopenedDb, clock: () => 1_030_001 });
  const claim = await recovered.claimPending({ limit: 1 });
  assert.equal(claim.records.length, 1);
  assert.equal(claim.records[0].observation.source_observation_id, "usage:worker-crash");
  assert.notEqual(claim.records[0].claim_token, crashed.response.claim_token);
  assert.equal((await recovered.status("observation", claim.records[0].record_ref)).claim_count, 2);
  reopenedDb.close();
});

test("SQLite outbox refuses preflight evidence inside an uncommitted caller transaction", async (t) => {
  const path = await temporaryDatabase(t);
  const database = openDatabase(path);
  const outbox = createSqliteTelemetryOutbox({ database });
  const event = makeEvent("event:outer-transaction");
  database.exec("BEGIN IMMEDIATE");
  assert.equal(database.isTransaction, true);
  await assert.rejects(() => outbox.append(event), (error) =>
    error instanceof TelemetryBoundaryError && error.code === "telemetry_outer_transaction_active");
  await assert.rejects(() => outbox.claimPendingEvidence({ limit: 1 }), (error) =>
    error instanceof TelemetryBoundaryError && error.code === "telemetry_outer_transaction_active");
  assert.equal(database.isTransaction, true, "the adapter does not treat a SAVEPOINT as a durable commit");
  database.exec("ROLLBACK");
  assert.equal(database.isTransaction, false);
  database.close();

  const reopenedDb = openDatabase(path);
  const reopened = createSqliteTelemetryOutbox({ database: reopenedDb });
  assert.equal(await reopened.status("evidence", event.event_id), undefined);
  reopenedDb.close();
});

test("a direct C03 acknowledgement durably settles only the exact queued observation", async (t) => {
  const path = await temporaryDatabase(t);
  const database = openDatabase(path);
  const outbox = createSqliteTelemetryOutbox({ database, clock: () => 15_000 });
  const source = makeObservation({ sourceObservationId: "usage:direct-ack" });
  const queued = await outbox.enqueueUsageObservation({ ...source, trustedScope });
  assert.deepEqual(await outbox.acknowledgeEnqueuedObservation({
    record_ref: queued.record_ref,
    source_observation_id: "usage:direct-ack",
    effective_billable_attempt_id: "attempt:fixture-001",
    authority_status: "accepted",
  }), { status: "acknowledged", source_observation_id: "usage:direct-ack", authority_status: "accepted" });
  assert.deepEqual(await outbox.status("observation", queued.record_ref), {
    status: "delivered", claim_count: 0, created_at: 15_000, delivered_at: 15_000,
  });
  const pending = await outbox.claimPending({ limit: 1 });
  assert.equal(pending.records.length, 0);
  assert.deepEqual(await outbox.acknowledgeEnqueuedObservation({
    record_ref: queued.record_ref,
    source_observation_id: "usage:direct-ack",
    effective_billable_attempt_id: "attempt:other",
    authority_status: "duplicate",
  }), { status: "mismatch", source_observation_id: "usage:direct-ack" });
  database.close();
});

test("evidence delivery requires an event-level acknowledgement and recovers after acknowledgement loss", async (t) => {
  const path = await temporaryDatabase(t);
  let now = 25_000;
  const database = openDatabase(path);
  const initial = createSqliteTelemetryOutbox({ database, clock: () => now, claimLeaseMs: 100 });
  await initial.append(makeEvent("event:evidence-ack-loss"));
  const lostClaim = (await initial.claimPendingEvidence({ limit: 1 })).records[0];
  let remoteAccepted = 1; // The remote sink accepted before the worker lost its acknowledgement.
  database.close();

  now += 101;
  const reopenedDb = openDatabase(path);
  const reopened = createSqliteTelemetryOutbox({ database: reopenedDb, clock: () => now, claimLeaseMs: 100 });
  let sinkCalls = 0;
  const delivery = await deliverPendingTelemetryEvidence({ outbox: reopened, limit: 1, sink: {
    async record(event) {
      sinkCalls += 1;
      assert.equal(event.event_id, lostClaim.event.event_id);
      remoteAccepted += 1;
      return { status: "duplicate", event_id: event.event_id };
    },
  } });
  assert.deepEqual(delivery, { status: "complete", attempted: 1, acknowledged: 1, retained: 0 });
  assert.equal(remoteAccepted, 2, "delivery retries the same durable event after an ambiguous prior result");
  assert.equal(sinkCalls, 1);
  assert.deepEqual(await reopened.status("evidence", lostClaim.event.event_id), {
    status: "delivered", claim_count: 2, created_at: 25_000, delivered_at: now,
  });

  let nestedSinkCalls = 0;
  const stillPending = await reopened.append(makeEvent("event:evidence-transaction-refusal"));
  assert.equal(stillPending.status, "recorded");
  reopenedDb.exec("BEGIN IMMEDIATE");
  const refused = await deliverPendingTelemetryEvidence({ outbox: reopened, limit: 1, sink: {
    async record() { nestedSinkCalls += 1; return { status: "accepted", event_id: "event:evidence-transaction-refusal" }; },
  } });
  assert.deepEqual(refused, { status: "outbox_unavailable", attempted: 0, acknowledged: 0, retained: 0 });
  assert.equal(nestedSinkCalls, 0, "an uncommitted SAVEPOINT cannot authorize an external sink call");
  reopenedDb.exec("ROLLBACK");
  reopenedDb.close();
});

test("SQLite reads reject column-to-payload scope drift and roll back both claims", async (t) => {
  const path = await temporaryDatabase(t);
  const database = openDatabase(path);
  const outbox = createSqliteTelemetryOutbox({ database });
  await outbox.append(makeEvent("event:tampered-scope"));
  const source = makeObservation({ sourceObservationId: "usage:tampered-scope" });
  const observationRecord = await outbox.enqueueUsageObservation({ ...source, trustedScope });
  database.prepare("UPDATE creative_telemetry_evidence_outbox_v1 SET project_id = ? WHERE event_id = ?")
    .run("project:foreign", "event:tampered-scope");
  database.prepare("UPDATE creative_telemetry_observations_v1 SET budget_scope_id = ? WHERE record_ref = ?")
    .run("budget:foreign", observationRecord.record_ref);
  await assert.rejects(
    () => outbox.claimPendingEvidence({ limit: 1 }),
    (error) => error instanceof TelemetryBoundaryError && error.code === "corrupt_evidence_record",
  );
  assert.equal((await outbox.status("evidence", "event:tampered-scope")).status, "pending");
  await assert.rejects(
    () => outbox.claimPending({ limit: 1 }),
    (error) => error instanceof TelemetryBoundaryError && error.code === "corrupt_observation_record",
  );
  assert.equal((await outbox.status("observation", observationRecord.record_ref)).status, "pending");
  database.close();
});

test("C03 observation acknowledgement loss replays the same durable observation after reopen without dispatch", async (t) => {
  const path = await temporaryDatabase(t);
  const attempt = fixtureAttempt();
  const observation = createUsageObservation({
    attempt, trustedScope, profile: USAGE_PROFILE.NORMALIZED,
    sourceObservationId: "usage:sqlite-ack-loss", providerRequestId: "req:sqlite-ack-loss",
    transportAttemptId: "transport:sqlite-ack-loss", usage: { input_tokens: 5, output_tokens: 2 },
  });
  const authority = new FakeMeteringAuthority();
  await authority.reserveAttempt(attempt);
  const database = openDatabase(path);
  const durable = createSqliteTelemetryOutbox({ database });
  const record = await durable.enqueueUsageObservation({ attempt, observation, trustedScope });
  const acknowledge = durable.acknowledge.bind(durable);
  let loseAck = true;
  const outbox = {
    claimPending: durable.claimPending.bind(durable),
    defer: durable.defer.bind(durable),
    async acknowledge(args) {
      if (loseAck) {
        loseAck = false;
        throw new Error("synthetic local acknowledgement loss after C03 accepted usage");
      }
      return acknowledge(args);
    },
  };
  const first = await deliverPendingUsageObservations({
    meteringPort: authority,
    outbox,
    trustedScopeForRecord: () => trustedScope,
  });
  assert.deepEqual(first, { status: "pending", attempted: 1, acknowledged: 0, retained: 1 });
  assert.equal(authority.observationsById.size, 1);
  assert.equal(authority.effectiveChargeCount, 1);
  database.close();

  const restartedDb = openDatabase(path);
  const restarted = createSqliteTelemetryOutbox({ database: restartedDb });
  const replay = await deliverPendingUsageObservations({
    meteringPort: authority,
    outbox: restarted,
    trustedScopeForRecord: () => trustedScope,
  });
  assert.deepEqual(replay, { status: "complete", attempted: 1, acknowledged: 1, retained: 0 });
  assert.equal(authority.observationsById.size, 1);
  assert.equal(authority.effectiveChargeCount, 1);
  assert.equal((await restarted.status("observation", record.record_ref)).status, "delivered");
  restartedDb.close();
});

test("late usage for a cancelled in-flight attempt is durably replayed as C03 observation only", async (t) => {
  const path = await temporaryDatabase(t);
  const attempt = fixtureAttempt({ billable_attempt_id: "attempt:late-after-cancel" });
  const authority = new FakeMeteringAuthority();
  const reservation = await authority.reserveAttempt(attempt);
  await authority.markAttemptInFlight({ reservation_id: reservation.reservation_id });
  await authority.markOutcomeUnknown({ reservation_id: reservation.reservation_id, reason: "cancelled_after_dispatch" });
  const observation = createUsageObservation({
    attempt, trustedScope, profile: USAGE_PROFILE.NORMALIZED,
    sourceObservationId: "usage:late-after-cancel", providerRequestId: "req:late-after-cancel",
    transportAttemptId: "transport:late-after-cancel", usage: { input_tokens: 4, output_tokens: 1 },
  });
  const database = openDatabase(path);
  const outbox = createSqliteTelemetryOutbox({ database });
  assert.equal("dispatch" in outbox, false);
  await outbox.enqueueUsageObservation({ attempt, observation, trustedScope });
  const result = await deliverPendingUsageObservations({
    meteringPort: authority,
    outbox,
    trustedScopeForRecord: () => trustedScope,
  });
  assert.deepEqual(result, { status: "complete", attempted: 1, acknowledged: 1, retained: 0 });
  assert.equal(authority.reservationFor(attempt.billable_attempt_id).state, "held_for_reconciliation");
  assert.equal(authority.observationsById.size, 1);
  database.close();
});
