import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { cp, readFile, unlink } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCreativeApi } from "../../src/api/v1.mjs";
import { canonicalHash, canonicalSerialize } from "../../src/contracts/index.mjs";
import { createCreativeVersionApiPorts } from "../../src/versions/api-ports.mjs";
import { CreativeVersionStore, VersionStoreError } from "../../src/versions/store.mjs";
import { createSqliteTelemetryOutbox, deliverPendingUsageObservations, USAGE_PROFILE } from "../../src/telemetry/index.mjs";

const NOW = Date.parse("2026-10-10T12:30:00.000Z");
const SCOPE = Object.freeze({ tenant_id: "tenant-api-1", project_id: "project-api-1", brief_id: "brief-api-1" });
const API_CRASH_WORKER = new URL("../../fixtures/versions/api-crash-worker.mjs", import.meta.url);

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`../../fixtures/api/${name}.json`, import.meta.url), "utf8"));
}

function actor() {
  return { actor_id: "actor-api-1", tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id,
    expires_at: "2026-10-11T00:00:00.000Z",
    permissions: ["creative.generate", "creative.edit", "creative.read", "creative.restore", "creative.cancel"],
    budget_scope_id: "budget-api-1", budget_policy_version: "budget-policy/1" };
}

function request(actionId, plan) {
  return { contract: "CreativeApiRequest", schema_version: "1.0", event_id: `event-${actionId}`,
    request_id: `request-${actionId}`, tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id,
    correlation_id: `correlation-${actionId}`, producer: "versions-api-integration",
    occurred_at: "2026-10-10T12:20:00.000Z", ingested_at: "2026-10-10T12:20:00.000Z",
    environment: "test", billing_mode: "simulated", source_refs: ["source-api-1"],
    operation: "generate", action_id: actionId, payload: { brief_id: SCOPE.brief_id, plan } };
}

function substituteAttemptIdentity(intentJson) {
  const intent = JSON.parse(intentJson);
  intent.evidence.creation.billable_attempt_id = "billable-substituted-after-prepare";
  intent.evidence.attempt_identities.billable_attempt_id = "billable-substituted-after-prepare";
  return canonicalSerialize(intent);
}

function portsFor(store, counters, idFactory, { leaseDurationMs = 60_000 } = {}) {
  const bytes = Buffer.from("durable exact artwork bytes");
  const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const provider = {
    resolveRoute: () => ({ retry_mapping_ref: "retry:fixture/1", provider: {
      name: "fixture-provider", model: "fixture-model", endpoint: "test:/image",
      sdk: { name: "fixture-sdk", version: "1.0" },
    } }),
    async generate(input) {
      counters.provider += 1;
      (counters.providerTransportIds ??= []).push(input.transport_attempt_id);
      await input.recordTransportAttempt(input.transport_attempt_id);
      return { design_version_id: "design-durable-api-1",
        artifact: { artifact_id: "artifact-durable-api-1", content_hash: hash, media_type: "image/png" },
        artifact_bytes: Uint8Array.from(bytes), provider: "fixture-provider", model: "fixture-model",
        usage: { completeness: "complete", input_tokens: 2, output_tokens: 4 } };
    },
    async edit(input) {
      counters.provider += 1;
      (counters.providerTransportIds ??= []).push(input.transport_attempt_id);
      await input.recordTransportAttempt(input.transport_attempt_id);
      return { design_version_id: `design-durable-edit-${counters.provider}`,
        artifact: { artifact_id: `artifact-durable-edit-${counters.provider}`, content_hash: hash, media_type: "image/png" },
        artifact_bytes: Uint8Array.from(bytes), provider: "fixture-provider", model: "fixture-model",
        usage: { completeness: "complete", input_tokens: 2, output_tokens: 4 } };
    },
  };
  const metering = {
    async reserveAttempt(attempt) { counters.reserved += 1; return { status: "reserved",
      reservation_id: `reservation:${attempt.billable_attempt_id}`, billable_attempt_id: attempt.billable_attempt_id,
      held_amount: { amount: "1.00", currency: "USD" }, lease_id: `finance-lease:${attempt.billable_attempt_id}` }; },
    async releaseBeforeDispatch() { return { status: "released" }; },
    async markAttemptInFlight(input) { return { status: "in_flight", reservation_id: input.reservation_id }; },
    async recordTransportAttempt(input) {
      (counters.financeTransportIds ??= []).push(input.transport_attempt_id);
      return { status: "recorded" };
    },
    async recordUsageObservation(input) { return { status: "accepted",
      source_observation_id: input.observation.source_observation_id,
      effective_billable_attempt_id: input.observation.billable_attempt_id }; },
    async settleReservation(input) { return { status: "settled", reservation_id: input.reservation_id,
      consumed_amount: { amount: "0.10", currency: "USD" },
      released_unused_amount: { amount: "0.90", currency: "USD" } }; },
    async markOutcomeUnknown() { return { status: "held_for_reconciliation" }; },
  };
  const adapted = createCreativeVersionApiPorts({ store, otherPorts: { provider, metering }, idFactory, leaseDurationMs });
  return {
    ...adapted.ports,
    telemetry: {
      outbox: createSqliteTelemetryOutbox({ database: store.db, clock: () => NOW }),
      modes: { provider_execution_mode: "mock", commerce_mode: "simulated" },
      usage_profiles: {
        image_generation: "creative.normalized-token-usage/1",
        image_edit: "creative.normalized-token-usage/1",
        vision_observation: "creative.normalized-token-usage/1",
        jev_decision: "typesafe.systemone-usage/2026-10-10",
      },
    },
  };
}

test("real API invocation commits job, exact artifact bytes, version and selection through one durable adapter", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "creative-version-api-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const plan = await fixture("generate-plan");
  const brief = await fixture("brief");
  const store = new CreativeVersionStore({ databasePath: join(root, "versions.sqlite"), objectRoot: join(root, "objects"), now: () => NOW });
  t.after(() => store.close());
  assert.equal(store.putBrief({ scope: { tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id }, brief }).status, "saved");
  const counters = { provider: 0, reserved: 0 };
  let id = 0;
  const api = createCreativeApi({ ports: portsFor(store, counters, () => `fixture-id-${++id}`), now: () => NOW,
    idFactory: () => `api-id-${++id}` });
  const body = request("durable-api-generation-1", plan);
  const result = await api.invoke(actor(), body);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(counters.provider, 1);
  assert.equal(counters.reserved, 1);
  const design = result.result.design_version;
  const persisted = store.getDesignVersion({ scope: SCOPE, brief_id: SCOPE.brief_id,
    design_version_id: design.design_version_id });
  assert.equal(persisted.design_hash, design.design_hash);
  assert.deepEqual(Buffer.from(await store.getArtifactBytes({ scope: SCOPE, brief_id: SCOPE.brief_id,
    design_version_id: design.design_version_id })), Buffer.from("durable exact artwork bytes"));
  assert.equal(store.getSelection({ scope: SCOPE, brief_id: SCOPE.brief_id }).design_version_id, design.design_version_id);
  const job = store.db.prepare("SELECT status,result_json,attempt_evidence_json FROM creative_jobs WHERE action_id=?")
    .get("durable-api-generation-1");
  assert.equal(job.status, "completed");
  assert.equal(JSON.parse(job.result_json).design.design_hash, design.design_hash);
  const attemptEvidence = JSON.parse(job.attempt_evidence_json);
  assert.equal(attemptEvidence.billable_attempt_id, design.billable_attempt_id);
  assert.equal(attemptEvidence.transport_attempt_ids.length, 1);
  assert.equal(typeof attemptEvidence.transport_attempt_ids[0], "string");
  assert.deepEqual(counters.providerTransportIds, attemptEvidence.transport_attempt_ids);
  assert.deepEqual(counters.financeTransportIds, attemptEvidence.transport_attempt_ids);
  assert.equal(attemptEvidence.usage_refs.length, 1);
  assert.equal(attemptEvidence.trace_refs.length, 3);
  assert.equal(new Set(attemptEvidence.trace_refs).size, 3);
  assert.ok(attemptEvidence.trace_refs.every((eventId) => store.db.prepare(
    "SELECT 1 AS found FROM creative_telemetry_evidence_outbox_v1 WHERE event_id=?").get(eventId)));
  const telemetryRows = store.db.prepare("SELECT event_type,status FROM creative_telemetry_evidence_outbox_v1 ORDER BY rowid").all();
  assert.deepEqual(telemetryRows.map((row) => row.event_type), ["attempt_intent", "transport_intent", "attempt_outcome"]);
  assert.ok(telemetryRows.every((row) => row.status === "pending"));
  const transportEvent = store.db.prepare("SELECT payload_json FROM creative_telemetry_evidence_outbox_v1 WHERE event_type='transport_intent'").get();
  assert.deepEqual(JSON.parse(transportEvent.payload_json).transport_attempt_id, attemptEvidence.transport_attempt_ids[0]);
  const dispatchIntent = store.db.prepare("SELECT transport_attempt_id FROM creative_dispatch_intents WHERE job_id=?")
    .get(attemptEvidence.job_id);
  assert.equal(dispatchIntent.transport_attempt_id, attemptEvidence.transport_attempt_ids[0]);
  const observationRows = store.db.prepare("SELECT status,source_observation_id FROM creative_telemetry_observations_v1").all();
  assert.equal(observationRows.length, 1);
  assert.equal(observationRows[0].status, "delivered");
  assert.match(observationRows[0].source_observation_id, /^usage:/);
  const action = store.db.prepare("SELECT state FROM creation_actions WHERE action_id=?")
    .get("durable-api-generation-1");
  assert.equal(action.state, "committed");

  store.close();
  const reopened = new CreativeVersionStore({ databasePath: join(root, "versions.sqlite"), objectRoot: join(root, "objects"), now: () => NOW });
  t.after(() => reopened.close());
  const recovered = await reopened.recover();
  assert.deepEqual(recovered, { examined: 0, committed: 0, conflicts: 0, unknown: 0 });
  const replayApi = createCreativeApi({ ports: portsFor(reopened, counters, () => `replay-id-${++id}`), now: () => NOW,
    idFactory: () => `replay-api-id-${++id}` });
  const replayRequest = { ...body, event_id: "event-retry", request_id: "request-retry", correlation_id: "correlation-retry" };
  const replay = await replayApi.invoke(actor(), replayRequest);
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.equal(replay.replayed, true);
  assert.equal(counters.provider, 1, "completed replay must not dispatch again");
  const changedPayload = { ...replayRequest, payload: structuredClone(replayRequest.payload) };
  changedPayload.payload.plan.steps[0].parameters.variant_count = 2;
  const conflict = await replayApi.invoke(actor(), changedPayload);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error.code, "conflict");
  assert.equal(counters.provider, 1, "conflicting action replay must not dispatch again");
});

test("populated BASE4e v4 database migrates to v6 and replays historical generation, edit, and inspection after restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "creative-base4e-v4-migration-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const fixtureRoot = new URL("../../fixtures/versions/base4-populated-v4/", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("manifest.json", fixtureRoot), "utf8"));
  const databaseBytes = await readFile(new URL("creative.sqlite", fixtureRoot));
  const requests = JSON.parse(await readFile(new URL("requests.json", fixtureRoot), "utf8"));
  const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  assert.equal(manifest.base_commit, "4e28839ea8baeb4112a4f12340ef2fe84f5c8efe");
  assert.equal(manifest.storage_user_version, 4);
  assert.equal(sha256(databaseBytes), manifest.database_sha256);
  assert.equal(sha256(Buffer.from(JSON.stringify(requests, null, 2) + "\n")), manifest.requests_sha256);
  assert.equal(requests.artifact_sha256, manifest.artifact_sha256);
  assert.equal(sha256(Buffer.from("durable exact artwork bytes")), manifest.artifact_sha256);
  const databasePath = join(root, "versions.sqlite");
  const objectRoot = join(root, "objects");
  await cp(new URL("creative.sqlite", fixtureRoot), databasePath);
  await cp(new URL("objects", fixtureRoot), objectRoot, { recursive: true });

  const baseline = new DatabaseSync(databasePath);
  assert.equal(baseline.prepare("PRAGMA user_version").get().user_version, 4);
  assert.deepEqual(baseline.prepare("SELECT action_id,operation,status FROM creative_jobs ORDER BY operation").all()
    .map((row) => ({ ...row })), [
    { action_id: "base4-edit-action", operation: "edit", status: "completed" },
    { action_id: "base4-generate-action", operation: "generate", status: "completed" },
    { action_id: "base4-inspect-action", operation: "inspect", status: "completed" },
  ]);
  const v4DispatchColumns = baseline.prepare("PRAGMA table_info(creative_dispatch_intents)").all().map((column) => column.name);
  for (const column of ["reservation_ref", "provider_name", "provider_model"]) assert.equal(v4DispatchColumns.includes(column), false);
  assert.equal(baseline.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='private_provider_attributions'").get(), undefined);
  baseline.close();

  let migrated = new CreativeVersionStore({ databasePath, objectRoot, now: () => NOW });
  assert.equal(migrated.db.prepare("PRAGMA user_version").get().user_version, 6);
  const v6DispatchColumns = migrated.db.prepare("PRAGMA table_info(creative_dispatch_intents)").all().map((column) => column.name);
  for (const column of ["reservation_ref", "provider_name", "provider_model"]) assert.equal(v6DispatchColumns.includes(column), true);
  assert.ok(migrated.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='private_provider_attributions'").get());
  for (const designVersionId of [requests.expected_generate_design_version_id, requests.expected_edit_design_version_id]) {
    const design = migrated.getDesignVersion({ scope: SCOPE, brief_id: SCOPE.brief_id, design_version_id: designVersionId });
    assert.ok(design, designVersionId);
    assert.deepEqual(Buffer.from(await migrated.getArtifactBytes({ scope: SCOPE, brief_id: SCOPE.brief_id,
      design_version_id: designVersionId })), Buffer.from("durable exact artwork bytes"));
  }
  assert.equal(migrated.db.prepare("SELECT COUNT(*) AS count FROM creative_jobs WHERE status='completed'").get().count, 3);
  migrated.close();

  migrated = new CreativeVersionStore({ databasePath, objectRoot, now: () => NOW });
  t.after(() => migrated.close());
  assert.equal(migrated.db.prepare("PRAGMA user_version").get().user_version, 6);
  const counters = { provider: 0, reserved: 0, inspection: 0 };
  let id = 0;
  const ports = portsFor(migrated, counters, () => `base4-replay-port-${++id}`);
  ports.inspection = {
    resolveRoute: () => ({ retry_mapping_ref: "retry:fixture/1", provider: { name: "fixture-provider", model: "fixture-model",
      endpoint: "test:/vision", sdk: { name: "fixture-sdk", version: "1.0" } } }),
    async inspect() { counters.inspection += 1; throw new Error("historical inspection replay must not dispatch"); },
  };
  const api = createCreativeApi({ ports,
    now: () => NOW, idFactory: () => `base4-replay-api-${++id}` });
  const generatedReplay = await api.invoke(actor(), requests.generate_request);
  assert.equal(generatedReplay.ok, true, JSON.stringify(generatedReplay));
  assert.equal(generatedReplay.replayed, true);
  assert.equal(generatedReplay.result.design_version.design_version_id, requests.expected_generate_design_version_id);
  const editedReplay = await api.invoke(actor(), requests.edit_request);
  assert.equal(editedReplay.ok, true, JSON.stringify(editedReplay));
  assert.equal(editedReplay.replayed, true);
  assert.equal(editedReplay.result.design_version.design_version_id, requests.expected_edit_design_version_id);
  const inspectedReplay = await api.invoke(actor(), requests.inspect_request);
  assert.equal(inspectedReplay.ok, true, JSON.stringify(inspectedReplay));
  assert.equal(inspectedReplay.replayed, true);
  assert.equal(inspectedReplay.result.design_version_id, requests.expected_inspection_design_version_id);
  assert.equal(counters.provider, 0, "historical replay after migration must not redispatch generation or edit");
  assert.equal(counters.inspection, 0, "historical inspection replay after migration must not inspect again");
  assert.equal(counters.reserved, 0, "historical replay after migration must not create reservations");
});

test("outcome append failure is durably staged and replayed as pending without another provider attempt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "creative-version-api-pending-outcome-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const databasePath = join(root, "versions.sqlite");
  const objectRoot = join(root, "objects");
  const store = new CreativeVersionStore({ databasePath, objectRoot, now: () => NOW });
  t.after(() => store.close());
  store.putBrief({ scope: { tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id }, brief: await fixture("brief") });
  const counters = { provider: 0, reserved: 0 };
  let id = 0;
  const ports = portsFor(store, counters, () => `pending-outcome-port-${++id}`);
  const durableOutbox = ports.telemetry.outbox;
  ports.telemetry.outbox = Object.freeze({
    ...durableOutbox,
    async append(event) {
      if (event.event_type === "attempt_outcome") throw new Error("synthetic single-append failure");
      return durableOutbox.append(event);
    },
  });
  const api = createCreativeApi({ ports, now: () => NOW, idFactory: () => `pending-outcome-api-${++id}` });
  const body = request("pending-outcome-action", await fixture("generate-plan"));
  const result = await api.invoke(actor(), body);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.result.telemetry_evidence.local_status, "pending");
  assert.equal(result.result.telemetry_evidence.pending_event_staged, true);
  assert.equal(typeof result.result.telemetry_evidence.pending_event_id, "string");
  assert.equal("pending_event" in result.result.telemetry_evidence, false);
  assert.equal(counters.provider, 1);
  assert.equal(counters.reserved, 1);
  const eventRows = store.db.prepare("SELECT event_id,event_type,status FROM creative_telemetry_evidence_outbox_v1 ORDER BY rowid").all();
  assert.deepEqual(eventRows.map((row) => row.event_type), ["attempt_intent", "transport_intent", "attempt_outcome"]);
  assert.ok(eventRows.every((row) => row.status === "pending"));
  assert.equal(eventRows[2].event_id, result.result.telemetry_evidence.pending_event_id);

  store.close();
  const reopened = new CreativeVersionStore({ databasePath, objectRoot, now: () => NOW });
  t.after(() => reopened.close());
  const replayApi = createCreativeApi({ ports: portsFor(reopened, counters, () => `pending-outcome-replay-${++id}`),
    now: () => NOW, idFactory: () => `pending-outcome-replay-api-${++id}` });
  const replay = await replayApi.invoke(actor(), { ...body, event_id: "pending-outcome-replay-event",
    request_id: "pending-outcome-replay-request", correlation_id: "pending-outcome-replay-correlation" });
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.equal(replay.replayed, true);
  assert.equal(replay.result.telemetry_evidence.local_status, "pending");
  assert.equal(replay.result.telemetry_evidence.pending_event_id, result.result.telemetry_evidence.pending_event_id);
  assert.equal(replay.result.telemetry_evidence.pending_event_staged, true);
  assert.equal(counters.provider, 1, "replay must not redispatch after staging the outcome");
  assert.equal(counters.reserved, 1, "replay must not allocate another reservation");
  const claims = await createSqliteTelemetryOutbox({ database: reopened.db, clock: () => NOW })
    .claimPendingEvidence({ limit: 3 });
  assert.ok(claims.records.some((record) => record.event.event_type === "attempt_outcome" &&
    record.event.event_id === result.result.telemetry_evidence.pending_event_id));
});

test("final Finance transport acknowledgement is followed by an atomic active-lease fence before provider dispatch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "creative-version-api-transport-ack-expiry-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  let now = NOW;
  const store = new CreativeVersionStore({ databasePath: join(root, "versions.sqlite"),
    objectRoot: join(root, "objects"), now: () => now });
  t.after(() => store.close());
  store.putBrief({ scope: { tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id }, brief: await fixture("brief") });
  const counters = { provider: 0, reserved: 0 };
  let id = 0;
  const ports = portsFor(store, counters, () => `transport-ack-expiry-port-${++id}`, { leaseDurationMs: 1_000 });
  const recordTransportAttempt = ports.metering.recordTransportAttempt;
  let unknownOutcomes = 0;
  const markOutcomeUnknown = ports.metering.markOutcomeUnknown;
  ports.metering.recordTransportAttempt = async (input) => {
    const ack = await recordTransportAttempt(input);
    now = NOW + 120_000;
    return ack;
  };
  ports.metering.markOutcomeUnknown = async (...args) => {
    unknownOutcomes += 1;
    return markOutcomeUnknown(...args);
  };
  const api = createCreativeApi({ ports, now: () => now, idFactory: () => `transport-ack-expiry-api-${++id}` });
  const result = await api.invoke(actor(), request("transport-ack-expiry", await fixture("generate-plan")));
  assert.equal(result.ok, false);
  assert.equal(counters.provider, 0, "expired lease after Finance ACK must prevent provider transport");
  assert.equal(counters.reserved, 1);
  assert.equal(unknownOutcomes, 1, "uncertain in-flight Finance state remains held for reconciliation");
  assert.equal(store.listDesignVersions({ scope: SCOPE, brief_id: SCOPE.brief_id, limit: 10 }).items.length, 0);
});

test("cached transport identity rechecks the current job lease without repeating the Finance ACK", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "creative-version-api-cached-transport-expiry-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  let now = NOW;
  const store = new CreativeVersionStore({ databasePath: join(root, "versions.sqlite"),
    objectRoot: join(root, "objects"), now: () => now });
  t.after(() => store.close());
  store.putBrief({ scope: { tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id }, brief: await fixture("brief") });
  const counters = { provider: 0, reserved: 0, mockPost: 0 };
  let id = 0;
  const ports = portsFor(store, counters, () => `cached-transport-port-${++id}`, { leaseDurationMs: 1_000 });
  const generate = ports.provider.generate;
  ports.provider.generate = async (input) => {
    await Promise.resolve();
    now = NOW + 120_000;
    await input.recordTransportAttempt(input.transport_attempt_id);
    counters.mockPost += 1;
    return generate({ ...input, recordTransportAttempt: async () => input.dispatch_intent_ref });
  };
  const recordTransport = ports.metering.recordTransportAttempt;
  ports.metering.recordTransportAttempt = async (input) => {
    counters.financeTransportAcks = (counters.financeTransportAcks ?? 0) + 1;
    return recordTransport(input);
  };
  const api = createCreativeApi({ ports, now: () => now, idFactory: () => `cached-transport-api-${++id}` });
  const result = await api.invoke(actor(), request("cached-transport-expiry", await fixture("generate-plan")));
  assert.equal(result.ok, false);
  assert.equal(counters.reserved, 1);
  assert.equal(counters.financeTransportAcks, 1, "cached transport must not repeat Finance's ACK");
  assert.equal(counters.mockPost, 0, "expired lease on cached ID must stop transport before its side effect");
  assert.equal(counters.provider, 0);
  assert.equal(store.listDesignVersions({ scope: SCOPE, brief_id: SCOPE.brief_id, limit: 10 }).items.length, 0);
});

test("cached transport identity is rechecked against changed brief context and persisted cancellation", async (t) => {
  for (const change of ["brief", "cancel"]) {
    const root = await mkdtemp(join(tmpdir(), `creative-version-api-cached-transport-${change}-`));
    t.after(async () => rm(root, { recursive: true, force: true }));
    const brief = await fixture("brief");
    const store = new CreativeVersionStore({ databasePath: join(root, "versions.sqlite"),
      objectRoot: join(root, "objects"), now: () => NOW });
    t.after(() => store.close());
    store.putBrief({ scope: { tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id }, brief });
    const counters = { provider: 0, reserved: 0, mockPost: 0, financeTransportAcks: 0 };
    let id = 0;
    const ports = portsFor(store, counters, () => `cached-${change}-port-${++id}`);
    const recordTransport = ports.metering.recordTransportAttempt;
    ports.metering.recordTransportAttempt = async (input) => {
      counters.financeTransportAcks += 1;
      return recordTransport(input);
    };
    let nestedCancel;
    let startedJobId;
    const generate = ports.provider.generate;
    let api;
    ports.provider.generate = async (input) => {
      startedJobId = input.job_id;
      if (change === "brief") {
        const updated = structuredClone(brief);
        updated.facts.verified[0].value = "Changed after the first transport intent";
        const saved = store.putBrief({ scope: { tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id },
          brief: updated, expected_brief_hash: canonicalHash(brief) });
        assert.equal(saved.status, "saved");
      } else {
        const body = { ...request("cancel-during-cached-transport", await fixture("generate-plan")),
          operation: "cancel", payload: { job_id: input.job_id } };
        nestedCancel = await api.invoke(actor(), body);
        assert.equal(nestedCancel.ok, true, JSON.stringify(nestedCancel));
      }
      await input.recordTransportAttempt(input.transport_attempt_id);
      counters.mockPost += 1;
      return generate({ ...input, recordTransportAttempt: async () => input.dispatch_intent_ref });
    };
    api = createCreativeApi({ ports, now: () => NOW, idFactory: () => `cached-${change}-api-${++id}` });
    const result = await api.invoke(actor(), request(`cached-transport-${change}`, await fixture("generate-plan")));
    assert.equal(result.ok, false);
    assert.equal(counters.reserved, 1);
    assert.equal(counters.financeTransportAcks, 1, "revalidation must not repeat Finance's transport ACK");
    assert.equal(counters.mockPost, 0, `${change} must fence before the provider's mock transport`);
    assert.equal(counters.provider, 0);
    assert.equal(store.listDesignVersions({ scope: SCOPE, brief_id: SCOPE.brief_id, limit: 10 }).items.length, 0);
    if (change === "cancel") {
      assert.equal(nestedCancel.job.status, "cancelled");
      const row = await ports.jobs.get({ scope: { tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id }, job_id: startedJobId });
      assert.equal(row.status, "cancelled", "cached replay must honor cancellation already persisted by the store");
    }
  }
});

test("known usage attached to a failed provider error is durably observed without publishing an artifact", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "creative-version-api-failed-provider-usage-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const store = new CreativeVersionStore({ databasePath: join(root, "versions.sqlite"),
    objectRoot: join(root, "objects"), now: () => NOW });
  t.after(() => store.close());
  store.putBrief({ scope: { tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id }, brief: await fixture("brief") });
  const counters = { provider: 0, reserved: 0, settled: 0 };
  let id = 0;
  const ports = portsFor(store, counters, () => `failed-usage-port-${++id}`);
  const generate = ports.provider.generate;
  ports.provider.generate = async (input) => {
    const response = await generate(input);
    throw Object.assign(new Error("synthetic adapter error must remain private"), {
      provider_outcome: "failed",
      usage: response.usage,
    });
  };
  const settle = ports.metering.settleReservation;
  ports.metering.settleReservation = async (...args) => {
    counters.settled += 1;
    return settle(...args);
  };
  const api = createCreativeApi({ ports, now: () => NOW, idFactory: () => `failed-usage-api-${++id}` });
  const result = await api.invoke(actor(), request("failed-provider-usage", await fixture("generate-plan")));
  assert.equal(result.ok, false);
  assert.equal(counters.provider, 1);
  assert.equal(counters.reserved, 1);
  assert.equal(counters.settled, 1, "known complete usage remains available to the trusted metering authority");
  const row = store.db.prepare("SELECT status,payload_json FROM creative_telemetry_observations_v1").get();
  assert.ok(row);
  assert.equal(row.status, "delivered");
  const observation = JSON.parse(row.payload_json).observation;
  assert.equal(observation.completeness, "complete");
  assert.deepEqual(observation.usage_units.map((unit) => [unit.name, unit.quantity]), [["input_tokens", "2"], ["output_tokens", "4"]]);
  assert.equal(store.listDesignVersions({ scope: SCOPE, brief_id: SCOPE.brief_id, limit: 10 }).items.length, 0);
  assert.equal(JSON.stringify(result).includes("synthetic adapter error"), false);
});

test("incomplete usage attached to a failed provider error remains held and unpublished", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "creative-version-api-failed-partial-usage-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const store = new CreativeVersionStore({ databasePath: join(root, "versions.sqlite"),
    objectRoot: join(root, "objects"), now: () => NOW });
  t.after(() => store.close());
  store.putBrief({ scope: { tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id }, brief: await fixture("brief") });
  const counters = { provider: 0, reserved: 0, settled: 0, held: 0 };
  let id = 0;
  const ports = portsFor(store, counters, () => `failed-partial-usage-port-${++id}`);
  const generate = ports.provider.generate;
  ports.provider.generate = async (input) => {
    await generate(input);
    throw Object.assign(new Error("private partial provider failure"), {
      provider_outcome: "failed",
      usage: { completeness: "partial", input_tokens: 2, missing_fields: ["output_tokens"] },
    });
  };
  const settle = ports.metering.settleReservation;
  ports.metering.settleReservation = async (...args) => {
    counters.settled += 1;
    return settle(...args);
  };
  const markUnknown = ports.metering.markOutcomeUnknown;
  ports.metering.markOutcomeUnknown = async (...args) => {
    counters.held += 1;
    return markUnknown(...args);
  };
  const api = createCreativeApi({ ports, now: () => NOW, idFactory: () => `failed-partial-usage-api-${++id}` });
  const result = await api.invoke(actor(), request("failed-partial-provider-usage", await fixture("generate-plan")));
  assert.equal(result.ok, false);
  assert.equal(counters.provider, 1);
  assert.equal(counters.reserved, 1);
  assert.equal(counters.settled, 0);
  assert.equal(counters.held, 1, "partial failed usage cannot authorize settlement");
  const row = store.db.prepare("SELECT status,payload_json FROM creative_telemetry_observations_v1").get();
  assert.ok(row);
  const observation = JSON.parse(row.payload_json).observation;
  assert.equal(observation.completeness, "partial");
  assert.ok(observation.missing_fields.includes("output_tokens"));
  assert.equal(store.listDesignVersions({ scope: SCOPE, brief_id: SCOPE.brief_id, limit: 10 }).items.length, 0);
  assert.equal(JSON.stringify(result).includes("private partial provider failure"), false);
});

test("legacy generation, edit, and inspection results replay with unknown telemetry status", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "creative-version-api-legacy-replay-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const store = new CreativeVersionStore({ databasePath: join(root, "versions.sqlite"),
    objectRoot: join(root, "objects"), now: () => NOW });
  t.after(() => store.close());
  store.putBrief({ scope: { tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id }, brief: await fixture("brief") });
  const counters = { provider: 0, reserved: 0 };
  let id = 0;
  const ports = portsFor(store, counters, () => `legacy-replay-port-${++id}`);
  ports.inspection = {
    resolveRoute: () => ({ retry_mapping_ref: "retry:fixture/1", provider: {
      name: "fixture-provider", model: "fixture-model", endpoint: "test:/vision",
      sdk: { name: "fixture-sdk", version: "1.0" },
    } }),
    async inspect(input) {
      await input.recordTransportAttempt(input.transport_attempt_id);
      return { tenant_id: input.scope.tenant_id, project_id: input.scope.project_id,
        brief_id: input.brief.brief_id, design_version_id: input.design_version.design_version_id,
        artifact_id: input.design_version.artifact.artifact_id,
        artifact_hash: input.design_version.artifact.content_hash,
        design_hash: input.design_version.design_hash, inspection_id: `inspection:${input.job_id}`,
        observations: [], usage: { completeness: "complete", input_tokens: 1, output_tokens: 1 } };
    },
  };
  const api = createCreativeApi({ ports,
    now: () => NOW, idFactory: () => `legacy-replay-api-${++id}` });
  const stripLegacyTelemetry = (actionId, nestedInspection = false) => {
    const row = store.db.prepare("SELECT result_json FROM creative_jobs WHERE action_id=?").get(actionId);
    const legacyResult = JSON.parse(row.result_json);
    if (nestedInspection) delete legacyResult.inspection.telemetry_evidence;
    else delete legacyResult.telemetry_evidence;
    const attemptId = legacyResult.attempt_id;
    store.db.prepare(`DELETE FROM creative_telemetry_evidence_outbox_v1
      WHERE tenant_id=? AND project_id=?
        AND json_extract(payload_json, '$.logical_operation_id')=?
        AND json_extract(payload_json, '$.billable_attempt_id')=?`)
      .run(SCOPE.tenant_id, SCOPE.project_id, actionId, attemptId);
    store.db.prepare(`DELETE FROM creative_telemetry_observations_v1
      WHERE tenant_id=? AND project_id=? AND budget_scope_id=?
        AND logical_operation_id=? AND billable_attempt_id=?`)
      .run(SCOPE.tenant_id, SCOPE.project_id, "budget-api-1", actionId, attemptId);
    store.db.prepare("UPDATE creative_jobs SET result_json=? WHERE action_id=?")
      .run(JSON.stringify(legacyResult), actionId);
  };
  const replayLegacy = async (body, expectedResult) => {
    const first = await api.invoke(actor(), body);
    assert.equal(first.ok, true, JSON.stringify(first));
    stripLegacyTelemetry(body.action_id, body.operation === "inspect");
    const replay = await api.invoke(actor(), { ...body, event_id: `${body.event_id}-retry`, request_id: `${body.request_id}-retry` });
    assert.equal(replay.ok, true, JSON.stringify(replay));
    assert.equal(replay.replayed, true);
    assert.deepEqual(expectedResult(replay).telemetry_evidence, { local_status: "unknown" });
    return first.result;
  };

  const generated = await replayLegacy(request("legacy-generate-action", await fixture("generate-plan")),
    (response) => response.result);
  const editPlan = await fixture("edit-plan");
  editPlan.base = { brief_hash: generated.design_version.brief_hash,
    design_hash: generated.design_version.design_hash,
    design_version_id: generated.design_version.design_version_id };
  editPlan.steps[0].parameters.design_version_id = generated.design_version.design_version_id;
  editPlan.steps[0].parameters.artifact_id = generated.design_version.artifact.artifact_id;
  editPlan.expected_result.parent_version_id = generated.design_version.design_version_id;
  const edited = await replayLegacy({ ...request("legacy-edit-action", editPlan), operation: "edit",
    payload: { brief_id: SCOPE.brief_id, design_version_id: generated.design_version.design_version_id, plan: editPlan } },
  (response) => response.result);
  const inspected = await replayLegacy({ ...request("legacy-inspect-action", {}), operation: "inspect",
    payload: { brief_id: SCOPE.brief_id, design_version_id: edited.design_version.design_version_id } },
  (response) => response.result);
  assert.equal(inspected.design_version_id, edited.design_version.design_version_id);
  assert.equal(counters.provider, 2, "legacy generation/edit replay must not issue provider attempts");
  assert.equal(counters.reserved, 3, "inspection is separately metered once; replay adds no reservation");
});

test("a new result with removed telemetry status fails closed instead of replaying as legacy", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "creative-version-api-missing-telemetry-status-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const store = new CreativeVersionStore({ databasePath: join(root, "versions.sqlite"),
    objectRoot: join(root, "objects"), now: () => NOW });
  t.after(() => store.close());
  store.putBrief({ scope: { tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id }, brief: await fixture("brief") });
  const counters = { provider: 0, reserved: 0 };
  let id = 0;
  const api = createCreativeApi({ ports: portsFor(store, counters, () => `missing-status-port-${++id}`),
    now: () => NOW, idFactory: () => `missing-status-api-${++id}` });
  const body = request("new-result-missing-telemetry-status", await fixture("generate-plan"));
  const first = await api.invoke(actor(), body);
  assert.equal(first.ok, true, JSON.stringify(first));
  const row = store.db.prepare("SELECT result_json FROM creative_jobs WHERE action_id=?").get(body.action_id);
  const result = JSON.parse(row.result_json);
  delete result.telemetry_evidence;
  store.db.prepare("UPDATE creative_jobs SET result_json=? WHERE action_id=?")
    .run(JSON.stringify(result), body.action_id);
  store.db.prepare(`DELETE FROM creative_telemetry_evidence_outbox_v1
    WHERE tenant_id=? AND project_id=?
      AND json_extract(payload_json, '$.logical_operation_id')=?
      AND json_extract(payload_json, '$.billable_attempt_id')=?`)
    .run(SCOPE.tenant_id, SCOPE.project_id, body.action_id, result.attempt_id);
  assert.ok(store.db.prepare(`SELECT count(*) AS count FROM creative_telemetry_observations_v1
    WHERE logical_operation_id=? AND billable_attempt_id=?`).get(body.action_id, result.attempt_id).count > 0,
  "a current C03 usage observation remains to distinguish this damaged result from a legacy job");

  const replay = await api.invoke(actor(), { ...body, event_id: `${body.event_id}-retry`, request_id: `${body.request_id}-retry` });
  assert.equal(replay.ok, false);
  assert.equal(replay.error.code, "unavailable");
  assert.equal(counters.provider, 1, "malformed replay does not redispatch provider work");
  assert.equal(counters.reserved, 1, "malformed replay does not create another reservation");
});

test("partial provider usage persists an observation before incomplete usage prevents publication", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "creative-version-api-partial-usage-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const store = new CreativeVersionStore({ databasePath: join(root, "versions.sqlite"),
    objectRoot: join(root, "objects"), now: () => NOW });
  t.after(() => store.close());
  store.putBrief({ scope: { tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id }, brief: await fixture("brief") });
  const counters = { provider: 0, reserved: 0 };
  let id = 0;
  const ports = portsFor(store, counters, () => `partial-usage-port-${++id}`);
  const generate = ports.provider.generate;
  ports.provider.generate = async (input) => ({ ...await generate(input),
    usage: { completeness: "partial", input_tokens: 2, missing_fields: ["output_tokens"] } });
  const api = createCreativeApi({ ports, now: () => NOW, idFactory: () => `partial-usage-api-${++id}` });
  const result = await api.invoke(actor(), request("partial-usage-action", await fixture("generate-plan")));
  assert.equal(result.ok, false);
  assert.equal(counters.provider, 1);
  assert.equal(counters.reserved, 1);
  const row = store.db.prepare("SELECT status,payload_json FROM creative_telemetry_observations_v1").get();
  assert.ok(row, "partial usage is retained even when it cannot authorize publication");
  const observation = JSON.parse(row.payload_json).observation;
  assert.equal(observation.completeness, "partial");
  assert.ok(observation.missing_fields.includes("output_tokens"));
  assert.equal(store.listDesignVersions({ scope: SCOPE, brief_id: SCOPE.brief_id, limit: 10 }).items.length, 0);
});

test("late usage after deadline remains a durable observation-only replay with no publication", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "creative-version-api-late-usage-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const store = new CreativeVersionStore({ databasePath: join(root, "versions.sqlite"),
    objectRoot: join(root, "objects"), now: () => NOW });
  t.after(() => store.close());
  store.putBrief({ scope: { tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id }, brief: await fixture("brief") });
  const counters = { provider: 0, reserved: 0 };
  let id = 0;
  const ports = portsFor(store, counters, () => `late-usage-port-${++id}`);
  const generate = ports.provider.generate;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(callback, delay === 30_000 ? 5 : delay, ...args);
  let result;
  try {
    ports.provider.generate = async (input) => {
      await input.recordTransportAttempt(input.transport_attempt_id);
      await new Promise((resolve) => originalSetTimeout(resolve, 20));
      return { ...await generate({ ...input, recordTransportAttempt: async () => {} }),
        usage: { completeness: "complete", input_tokens: 9, output_tokens: 4 } };
    };
    const api = createCreativeApi({ ports, now: () => NOW, idFactory: () => `late-usage-api-${++id}` });
    result = await api.invoke(actor(), request("late-usage-action", await fixture("generate-plan")));
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "cancelled");
  assert.equal(counters.reserved, 1);
  await new Promise((resolve) => originalSetTimeout(resolve, 40));
  assert.equal(counters.provider, 1);
  assert.equal(store.listDesignVersions({ scope: SCOPE, brief_id: SCOPE.brief_id, limit: 10 }).items.length, 0);
  const row = store.db.prepare("SELECT status,payload_json FROM creative_telemetry_observations_v1").get();
  assert.ok(row, "usage arriving after abort is durable for later C03 reconciliation");
  assert.equal(row.status, "pending", "late usage has not been mistaken for an already-confirmed Finance observation");
  const observation = JSON.parse(row.payload_json).observation;
  assert.equal(observation.input_tokens, undefined);
  assert.deepEqual(observation.usage_units.map((unit) => unit.quantity), ["9", "4"]);
  assert.equal(observation.transport_attempt_id, counters.providerTransportIds[0]);

  store.close();
  const reopened = new CreativeVersionStore({ databasePath: join(root, "versions.sqlite"),
    objectRoot: join(root, "objects"), now: () => NOW });
  t.after(() => reopened.close());
  const replayed = await deliverPendingUsageObservations({
    outbox: createSqliteTelemetryOutbox({ database: reopened.db, clock: () => NOW }),
    trustedScopeForRecord: async () => ({ tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id,
      budget_scope_id: "budget-api-1" }),
    meteringPort: {
      async recordUsageObservation(input) {
        return { status: "accepted", source_observation_id: input.observation.source_observation_id,
          effective_billable_attempt_id: input.observation.billable_attempt_id };
      },
    },
  });
  assert.deepEqual(replayed, { status: "complete", attempted: 1, acknowledged: 1, retained: 0 });
  assert.equal(counters.provider, 1, "reconciliation replays only the observation, never the provider call");
});

test("usage attached to a late provider rejection is durably recorded without resettlement or publication", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "creative-version-api-late-error-usage-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const store = new CreativeVersionStore({ databasePath: join(root, "versions.sqlite"),
    objectRoot: join(root, "objects"), now: () => NOW });
  t.after(() => store.close());
  store.putBrief({ scope: { tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id }, brief: await fixture("brief") });
  const counters = { provider: 0, reserved: 0, settled: 0, held: 0 };
  let id = 0;
  const ports = portsFor(store, counters, () => `late-error-usage-port-${++id}`);
  const generate = ports.provider.generate;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(callback, delay === 30_000 ? 5 : delay, ...args);
  const settle = ports.metering.settleReservation;
  ports.metering.settleReservation = async (...args) => {
    counters.settled += 1;
    return settle(...args);
  };
  const markUnknown = ports.metering.markOutcomeUnknown;
  ports.metering.markOutcomeUnknown = async (...args) => {
    counters.held += 1;
    return markUnknown(...args);
  };
  let result;
  try {
    ports.provider.generate = async (input) => {
      await input.recordTransportAttempt(input.transport_attempt_id);
      await new Promise((resolve) => originalSetTimeout(resolve, 20));
      const response = await generate({ ...input, recordTransportAttempt: async () => {} });
      throw Object.assign(new Error("late synthetic provider rejection"), {
        provider_outcome: "failed", usage: response.usage,
      });
    };
    const api = createCreativeApi({ ports, now: () => NOW, idFactory: () => `late-error-usage-api-${++id}` });
    result = await api.invoke(actor(), request("late-error-usage-action", await fixture("generate-plan")));
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "cancelled");
  assert.equal(counters.reserved, 1);
  await new Promise((resolve) => originalSetTimeout(resolve, 40));
  assert.equal(counters.provider, 1);
  assert.equal(counters.settled, 0);
  assert.equal(counters.held, 1);
  assert.equal(store.listDesignVersions({ scope: SCOPE, brief_id: SCOPE.brief_id, limit: 10 }).items.length, 0);
  const row = store.db.prepare("SELECT status,payload_json FROM creative_telemetry_observations_v1").get();
  assert.ok(row, "late rejection usage remains durable for an observation-only reconciliation pass");
  assert.equal(row.status, "pending");
  assert.equal(JSON.parse(row.payload_json).observation.completeness, "complete");
});

test("actual API usage profile persists nested provider counts as included subsets without double counting", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "creative-version-api-nested-usage-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const store = new CreativeVersionStore({ databasePath: join(root, "versions.sqlite"),
    objectRoot: join(root, "objects"), now: () => NOW });
  t.after(() => store.close());
  const brief = await fixture("brief");
  store.putBrief({ scope: { tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id }, brief });
  const counters = { provider: 0, reserved: 0 };
  let id = 0;
  const ports = portsFor(store, counters, () => `nested-usage-port-${++id}`);
  ports.telemetry.usage_profiles.image_generation = USAGE_PROFILE.OPENAI_RESPONSES;
  const artifactBytes = Buffer.from("durable exact artwork bytes");
  const artifactHash = `sha256:${createHash("sha256").update(artifactBytes).digest("hex")}`;
  ports.provider.generate = async (input) => {
    counters.provider += 1;
    (counters.providerTransportIds ??= []).push(input.transport_attempt_id);
    await input.recordTransportAttempt(input.transport_attempt_id);
    return { design_version_id: "design-nested-usage-1",
      artifact: { artifact_id: "artifact-nested-usage-1", content_hash: artifactHash, media_type: "image/png" },
      artifact_bytes: Uint8Array.from(artifactBytes), provider: "fixture-provider", model: "fixture-model",
      usage: { completeness: "complete", input_tokens: 10, output_tokens: 6, total_tokens: 16,
        input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 3 },
        provider_request_id: "provider:req-nested-usage" } };
  };
  const api = createCreativeApi({ ports, now: () => NOW, idFactory: () => `nested-usage-api-${++id}` });
  const result = await api.invoke(actor(), request("nested-usage-api", await fixture("generate-plan")));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(counters.provider, 1);
  assert.equal(counters.reserved, 1);
  const row = store.db.prepare("SELECT payload_json,status FROM creative_telemetry_observations_v1").get();
  assert.equal(row.status, "delivered");
  const observation = JSON.parse(row.payload_json).observation;
  assert.equal(observation.completeness, "complete");
  assert.equal(observation.provider_request_id, "provider:req-nested-usage");
  assert.equal(observation.transport_attempt_id, counters.providerTransportIds[0]);
  const units = new Map(observation.usage_units.map((unit) => [unit.name, unit]));
  assert.equal(units.get("total_tokens").relation, "standalone");
  assert.equal(units.get("input_tokens").relation, "included_subset");
  assert.equal(units.get("input_tokens").included_in, "total_tokens");
  assert.equal(units.get("output_tokens").included_in, "total_tokens");
  assert.equal(units.get("input_tokens_details.cached_tokens").included_in, "input_tokens");
  assert.equal(units.get("output_tokens_details.reasoning_tokens").included_in, "output_tokens");
  assert.equal(observation.usage_units.filter((unit) => unit.relation === "standalone").length, 1);
});

test("actual API refuses telemetry append inside an uncommitted shared-store transaction before reservation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "creative-version-api-telemetry-tx-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const store = new CreativeVersionStore({ databasePath: join(root, "versions.sqlite"),
    objectRoot: join(root, "objects"), now: () => NOW });
  t.after(() => store.close());
  const brief = await fixture("brief");
  store.putBrief({ scope: { tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id }, brief });
  const counters = { provider: 0, reserved: 0 };
  let id = 0;
  const ports = portsFor(store, counters, () => `outer-transaction-port-${++id}`);
  const durableOutbox = ports.telemetry.outbox;
  let guardedAttemptIntent = false;
  ports.telemetry.outbox = Object.freeze({
    ...durableOutbox,
    async append(event) {
      if (event.event_type !== "attempt_intent") return durableOutbox.append(event);
      guardedAttemptIntent = true;
      store.db.exec("BEGIN IMMEDIATE");
      try {
        return await durableOutbox.append(event);
      } finally {
        if (store.db.isTransaction) store.db.exec("ROLLBACK");
      }
    },
  });
  const api = createCreativeApi({ ports, now: () => NOW, idFactory: () => `outer-transaction-api-${++id}` });
  const result = await api.invoke(actor(), request("api-telemetry-outer-transaction", await fixture("generate-plan")));
  assert.equal(guardedAttemptIntent, true);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "unavailable");
  assert.equal(counters.reserved, 0, "an outbox row in an uncommitted outer transaction cannot authorize reservation");
  assert.equal(counters.provider, 0, "an outbox row in an uncommitted outer transaction cannot authorize provider dispatch");
  assert.equal(store.db.isTransaction, false);
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM creative_telemetry_evidence_outbox_v1").get().count, 0);
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM creative_telemetry_observations_v1").get().count, 0);
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM design_versions").get().count, 0);
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM version_selections").get().count, 0);
});

test("dispatch authorization rechecks lease expiry after the intent timestamp and retains the metering hold", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "creative-api-dispatch-expired-lease-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  let store;
  let authorizationClockReads = 0;
  const now = () => {
    if (store?.db.isTransaction === true &&
      store.db.prepare("SELECT count(*) AS count FROM creative_jobs WHERE status='running'").get().count > 0 &&
      store.db.prepare("SELECT count(*) AS count FROM creation_actions").get().count === 0) {
      authorizationClockReads += 1;
      if (authorizationClockReads >= 2) return NOW + 120_000;
    }
    return NOW;
  };
  store = new CreativeVersionStore({ databasePath: join(root, "versions.sqlite"),
    objectRoot: join(root, "objects"), now });
  t.after(() => store.close());
  const brief = await fixture("brief");
  store.putBrief({ scope: { tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id }, brief });
  const counters = { provider: 0, reserved: 0 };
  let id = 0;
  const api = createCreativeApi({ ports: portsFor(store, counters, () => `dispatch-expiry-port-${++id}`),
    now: () => NOW, idFactory: () => `dispatch-expiry-api-${++id}` });
  const response = await api.invoke(actor(), request("dispatch-expired-lease", await fixture("generate-plan")));

  assert.ok(authorizationClockReads >= 2, "the clock crosses expiry during the final dispatch authorization check");
  assert.equal(response.ok, false, JSON.stringify(response));
  assert.equal(counters.reserved, 1, "the reservation was consumed before the dispatch fence");
  assert.equal(counters.provider, 0, "expired authorization cannot start the transport");
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM creative_dispatch_intents").get().count, 0);
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM design_versions").get().count, 0);
  assert.equal(store.getSelection({ scope: SCOPE, brief_id: SCOPE.brief_id }), null);
  const job = store.db.prepare("SELECT status,result_json FROM creative_jobs WHERE action_id=?")
    .get("dispatch-expired-lease");
  assert.notEqual(job.status, "completed");
  assert.equal(job.result_json, null);
});

test("dispatch authorization replay does not reuse an intent after the lease expires during replay checks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "creative-api-dispatch-replay-expired-lease-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  let store;
  let replayClockReads = 0;
  let advanceDuringReplay = false;
  const now = () => {
    if (advanceDuringReplay && store?.db.isTransaction === true &&
      store.db.prepare("SELECT count(*) AS count FROM creative_jobs WHERE status='running'").get().count > 0 &&
      store.db.prepare("SELECT count(*) AS count FROM creative_dispatch_intents").get().count > 0) {
      replayClockReads += 1;
      if (replayClockReads >= 2) return NOW + 120_000;
    }
    return NOW;
  };
  store = new CreativeVersionStore({ databasePath: join(root, "versions.sqlite"),
    objectRoot: join(root, "objects"), now });
  t.after(() => store.close());
  const brief = await fixture("brief");
  store.putBrief({ scope: { tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id }, brief });
  const adapter = createCreativeVersionApiPorts({ store, idFactory: (() => {
    let id = 0;
    return () => `dispatch-replay-id-${++id}`;
  })() });
  const action_id = "dispatch-replay-expired-lease";
  const started = await adapter.jobs.begin({ scope: SCOPE, actor_id: "actor-api-1", action_id,
    request_hash: canonicalHash({ action_id, operation: "generate" }), operation: "generate" });
  const authorization = { scope: SCOPE, actor_id: "actor-api-1", job_id: started.job_id,
    lease_token: started.lease_token, action_id, operation: "generate",
    billable_attempt_id: "billable-replay-lease", transport_attempt_id: "transport-replay-lease",
    context_fence: { brief_id: SCOPE.brief_id, brief_hash: canonicalHash(brief),
      expected_current_design_version_id: null, expected_current_design_hash: null } };
  assert.equal((await adapter.jobs.authorizeDispatch(authorization)).status, "authorized");

  advanceDuringReplay = true;
  const replay = await adapter.jobs.authorizeDispatch(authorization);
  assert.ok(replayClockReads >= 2, "the lease expires between the initial and final replay checks");
  assert.deepEqual(replay, { status: "lease_lost" });
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM creative_dispatch_intents WHERE job_id=?")
    .get(started.job_id).count, 1, "the replay cannot create another dispatch intent");
});

test("normal paired publication rolls back when the lease expires during final result timestamping", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "creative-api-publication-expired-lease-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  let store;
  let publicationClockReads = 0;
  const now = () => {
    if (store?.db.isTransaction === true &&
      store.db.prepare("SELECT count(*) AS count FROM creation_actions WHERE state='committed'").get().count > 0) {
      publicationClockReads += 1;
      if (publicationClockReads >= 2) return NOW + 120_000;
    }
    return NOW;
  };
  store = new CreativeVersionStore({ databasePath: join(root, "versions.sqlite"),
    objectRoot: join(root, "objects"), now });
  t.after(() => store.close());
  const brief = await fixture("brief");
  store.putBrief({ scope: { tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id }, brief });
  const counters = { provider: 0, reserved: 0 };
  let id = 0;
  const api = createCreativeApi({ ports: portsFor(store, counters, () => `publication-expiry-port-${++id}`),
    now: () => NOW, idFactory: () => `publication-expiry-api-${++id}` });
  const response = await api.invoke(actor(), request("publication-expired-lease", await fixture("generate-plan")));

  assert.equal(publicationClockReads, 2, "the final persisted completion timestamp is after lease expiry");
  assert.equal(response.ok, false, JSON.stringify(response));
  assert.equal(counters.provider, 1, "the already-dispatched attempt remains attributable");
  assert.equal(counters.reserved, 1, "publication fencing cannot erase or recreate the reservation");
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM design_versions").get().count, 0);
  assert.equal(store.getSelection({ scope: SCOPE, brief_id: SCOPE.brief_id }), null);
  const job = store.db.prepare("SELECT status,result_json FROM creative_jobs WHERE action_id=?")
    .get("publication-expired-lease");
  assert.notEqual(job.status, "completed");
  assert.equal(job.result_json, null);
  const action = store.db.prepare("SELECT state FROM creation_actions WHERE action_id=?")
    .get("publication-expired-lease");
  assert.notEqual(action.state, "committed", "the version publication transaction must roll back with the job result");
});

test("paired API rejects a changed commit intent before publication and replay never redispatches", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "creative-version-intent-integrity-api-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const plan = await fixture("generate-plan");
  const brief = await fixture("brief");
  const store = new CreativeVersionStore({ databasePath: join(root, "versions.sqlite"),
    objectRoot: join(root, "objects"), now: () => NOW });
  t.after(() => store.close());
  store.putBrief({ scope: { tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id }, brief });
  const counters = { provider: 0, reserved: 0 };
  let id = 0;
  const ports = portsFor(store, counters, () => `intent-integrity-port-${++id}`);
  const prepare = ports.storage.prepareDesignVersion.bind(ports.storage);
  ports.storage.prepareDesignVersion = async (input) => {
    const prepared = await prepare(input);
    const row = store.db.prepare("SELECT intent_json FROM creation_actions WHERE action_id=?")
      .get("intent-integrity-api");
    store.db.prepare("UPDATE creation_actions SET intent_json=? WHERE action_id=?")
      .run(substituteAttemptIdentity(row.intent_json), "intent-integrity-api");
    return prepared;
  };
  const api = createCreativeApi({ ports, now: () => NOW, idFactory: () => `intent-integrity-api-${++id}` });
  const body = request("intent-integrity-api", plan);
  const first = await api.invoke(actor(), body);
  assert.equal(first.ok, false);
  assert.equal(counters.provider, 1);
  assert.equal(counters.reserved, 1);
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM design_versions WHERE action_id=?")
    .get("intent-integrity-api").count, 0);
  assert.equal(store.getSelection({ scope: SCOPE, brief_id: SCOPE.brief_id }), null);
  const job = store.db.prepare("SELECT status,result_json FROM creative_jobs WHERE action_id=?")
    .get("intent-integrity-api");
  assert.equal(job.status, "failed");
  assert.equal(job.result_json, null);
  const repeated = await api.invoke(actor(), body);
  assert.equal(counters.provider, 1, "corrupt intent replay cannot make a new provider call");
  assert.equal(counters.reserved, 1, "corrupt intent replay cannot make a new reservation");
  if (repeated.ok) assert.equal(repeated.job.status, "failed");
});

test("paired API persists explicit A/B/C branches and restore-by-selection without creating versions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "creative-version-api-branches-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const brief = await fixture("brief");
  const store = new CreativeVersionStore({ databasePath: join(root, "versions.sqlite"), objectRoot: join(root, "objects"), now: () => NOW });
  t.after(() => store.close());
  store.putBrief({ scope: { tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id }, brief });
  const counters = { provider: 0, reserved: 0 };
  let portId = 0;
  let apiId = 0;
  const api = createCreativeApi({ ports: portsFor(store, counters, () => `branch-port-${++portId}`), now: () => NOW,
    idFactory: () => `branch-api-${++apiId}` });
  const created = await api.invoke(actor(), request("branch-create-A", await fixture("generate-plan")));
  assert.equal(created.ok, true, JSON.stringify(created));
  const a = created.result.design_version;

  const makeBranch = async (actionId) => {
    const plan = await fixture("edit-plan");
    plan.base = { brief_hash: a.brief_hash, design_hash: a.design_hash, design_version_id: a.design_version_id };
    plan.steps[0].parameters.design_version_id = a.design_version_id;
    plan.steps[0].parameters.artifact_id = a.artifact.artifact_id;
    plan.expected_result.parent_version_id = a.design_version_id;
    return api.invoke(actor(), { ...request(actionId, plan), operation: "edit",
      payload: { brief_id: SCOPE.brief_id, design_version_id: a.design_version_id, selection_mode: "branch", plan } });
  };
  const bResult = await makeBranch("branch-create-B");
  const cResult = await makeBranch("branch-create-C");
  assert.equal(bResult.ok, true, JSON.stringify(bResult));
  assert.equal(cResult.ok, true, JSON.stringify(cResult));
  const b = bResult.result.design_version;
  const c = cResult.result.design_version;
  assert.equal(b.parent_version_id, a.design_version_id);
  assert.equal(c.parent_version_id, a.design_version_id);
  assert.equal(store.getSelection({ scope: SCOPE, brief_id: SCOPE.brief_id }).design_version_id, a.design_version_id,
    "explicit child branches do not move implicit current selection");

  const restore = async (actionId, target, revision) => api.invoke(actor(), {
    ...request(actionId, await fixture("generate-plan")), operation: "restore",
    payload: { brief_id: SCOPE.brief_id, target_design_version_id: target.design_version_id,
      expected_selection_revision: revision },
  });
  const selectedB = await restore("branch-select-B", b, 1);
  assert.equal(selectedB.ok, true, JSON.stringify(selectedB));
  assert.deepEqual(selectedB.result.selection, { tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id,
    brief_id: SCOPE.brief_id, design_version_id: b.design_version_id, design_hash: b.design_hash, revision: 2 });
  const beforeRestoreCount = store.listDesignVersions({ scope: SCOPE, brief_id: SCOPE.brief_id, limit: 10 }).items.length;
  const restoreA = await restore("branch-restore-A", a, 2);
  assert.equal(restoreA.ok, true, JSON.stringify(restoreA));
  assert.equal(restoreA.result.selection.design_version_id, a.design_version_id);
  assert.equal(restoreA.result.selection.design_hash, a.design_hash);
  assert.equal(restoreA.result.selection.revision, 3);
  assert.equal(store.listDesignVersions({ scope: SCOPE, brief_id: SCOPE.brief_id, limit: 10 }).items.length, beforeRestoreCount,
    "restore selects an existing immutable record and creates no version");
  assert.equal(counters.provider, 3, "selection and restore invoke no provider");
  assert.equal(counters.reserved, 3, "selection and restore invoke no metering reservation");
  assert.deepEqual(Buffer.from(await store.getArtifactBytes({ scope: SCOPE, brief_id: SCOPE.brief_id,
    design_version_id: a.design_version_id })), Buffer.from("durable exact artwork bytes"));
  const comparison = store.compareDesignVersions({ scope: SCOPE, brief_id: SCOPE.brief_id,
    left_design_version_id: b.design_version_id, right_design_version_id: c.design_version_id });
  assert.equal(comparison.left.parent_version_id, a.design_version_id);
  assert.equal(comparison.right.parent_version_id, a.design_version_id);
});

test("paired adapter refuses external handoff while a SQLite publication transaction would be open", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "creative-version-handoff-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const brief = await fixture("brief");
  const store = new CreativeVersionStore({ databasePath: join(root, "versions.sqlite"),
    objectRoot: join(root, "objects"), now: () => NOW });
  t.after(() => store.close());
  store.putBrief({ scope: { tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id }, brief });
  const adapter = createCreativeVersionApiPorts({ store, idFactory: (() => {
    let id = 0;
    return () => `handoff-adapter-id-${++id}`;
  })() });
  const action_id = "handoff-adapter-blocked";
  const request_hash = canonicalHash({ action_id, operation: "handoff" });
  const started = await adapter.jobs.begin({ scope: SCOPE, actor_id: "actor-api-1", action_id,
    request_hash, operation: "handoff" });
  assert.equal(started.kind, "started");
  let called = false;
  await assert.rejects(adapter.jobs.completeIfActive({ scope: SCOPE, actor_id: "actor-api-1",
    job_id: started.job_id, lease_token: started.lease_token, action_id, operation: "handoff",
    result: { receipt: { receipt_id: "receipt-fixture-1" } },
    publication_fence: { brief_id: SCOPE.brief_id, brief_hash: canonicalHash(brief) } }, async () => {
    called = true;
  }), (error) => error instanceof VersionStoreError && error.code === "unavailable");
  assert.equal(called, false, "external consumer submit callback must not run under SQLite write transaction");
  const job = store.db.prepare("SELECT status FROM creative_jobs WHERE job_id=?").get(started.job_id);
  assert.equal(job.status, "running");
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM creative_dispatch_intents WHERE job_id=?")
    .get(started.job_id).count, 0);
});

test("paired API reports handoff unavailable before verifier, context, destination, or consumer callbacks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "creative-version-handoff-preflight-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const brief = await fixture("brief");
  const store = new CreativeVersionStore({ databasePath: join(root, "versions.sqlite"),
    objectRoot: join(root, "objects"), now: () => NOW });
  t.after(() => store.close());
  store.putBrief({ scope: { tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id }, brief });
  const calls = { context: 0, destination: 0, verify: 0, submit: 0 };
  const adapter = createCreativeVersionApiPorts({ store, otherPorts: {
    storage: { async getHandoffContext() { calls.context += 1; return null; } },
    handoff: {
      async resolveDestination() { calls.destination += 1; return { expected_audience: "fixture" }; },
      async submit() { calls.submit += 1; throw new Error("must not submit"); },
    },
    approval: { async verifyApproval() { calls.verify += 1; return { status: "verified" }; } },
  }, idFactory: () => "handoff-preflight-id" });
  const api = createCreativeApi({ ports: adapter.ports, now: () => NOW, idFactory: () => "handoff-preflight-api" });
  const body = { ...request("handoff-preflight-action", await fixture("generate-plan")), operation: "handoff",
    payload: { brief_id: SCOPE.brief_id, design_version_id: "not-read-before-preflight",
      approval_ref: "approval-fixture-1", destination_ref: "destination-fixture-1" } };
  const response = await api.invoke({ ...actor(), permissions: [...actor().permissions, "creative.handoff"] }, body);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "unavailable");
  assert.deepEqual(calls, { context: 0, destination: 0, verify: 0, submit: 0 });
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM creative_jobs WHERE action_id=?")
    .get("handoff-preflight-action").count, 0, "unsupported paired handoff must not create a misleading job");
});

test("cancelled dispatch cannot publish but its late worker can persist attempt evidence for reconciliation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "creative-version-late-attempt-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const brief = await fixture("brief");
  const store = new CreativeVersionStore({ databasePath: join(root, "versions.sqlite"),
    objectRoot: join(root, "objects"), now: () => NOW });
  t.after(() => store.close());
  store.putBrief({ scope: { tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id }, brief });
  const adapter = createCreativeVersionApiPorts({ store, idFactory: (() => {
    let id = 0; return () => `late-attempt-id-${++id}`;
  })() });
  const action_id = "cancelled-attempt-action";
  const request_hash = canonicalHash({ action_id, operation: "generate" });
  const started = await adapter.jobs.begin({ scope: SCOPE, actor_id: "actor-api-1", action_id,
    request_hash, operation: "generate" });
  const fence = { brief_id: SCOPE.brief_id, brief_hash: canonicalHash(brief),
    expected_current_design_version_id: null, expected_current_design_hash: null };
  assert.equal((await adapter.jobs.authorizeDispatch({ scope: SCOPE, actor_id: "actor-api-1",
    job_id: started.job_id, lease_token: started.lease_token, action_id, operation: "generate",
    billable_attempt_id: "billable-late-1", transport_attempt_id: "transport-late-1", context_fence: fence })).status,
  "authorized");
  const cancelled = await adapter.jobs.cancel({ scope: SCOPE, actor_id: "actor-api-1", job_id: started.job_id,
    target_action_id: action_id, action_id: "cancel-late-worker", request_hash: canonicalHash({ cancel: action_id }) });
  assert.equal(cancelled.kind, "cancelled");
  assert.equal((await adapter.jobs.authorizeDispatch({ scope: SCOPE, actor_id: "actor-api-1",
    job_id: started.job_id, lease_token: started.lease_token, action_id, operation: "generate",
    billable_attempt_id: "billable-late-1", transport_attempt_id: "transport-late-2", context_fence: fence })).status,
  "cancelled");
  const evidence = { job_id: started.job_id, action_id, actor_id: "actor-api-1", request_hash,
    logical_operation_id: action_id, billable_attempt_id: "billable-late-1",
    transport_attempt_ids: ["transport-late-1"], provider_request_ids: ["provider-late-1"],
    usage_refs: ["usage-late-1"], trace_refs: [] };
  assert.deepEqual(await adapter.jobs.recordAttemptEvidence({ scope: SCOPE, actor_id: "actor-api-1",
    job_id: started.job_id, lease_token: started.lease_token, action_id, request_hash, creation: evidence }),
  { status: "recorded" });
  const row = store.db.prepare("SELECT status,attempt_evidence_json FROM creative_jobs WHERE job_id=?").get(started.job_id);
  assert.equal(row.status, "cancelled");
  assert.deepEqual(JSON.parse(row.attempt_evidence_json), evidence);
});

test("actual paired API cancellation after dispatch fences publication and retains attempt evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "creative-version-api-cancel-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const brief = await fixture("brief");
  const store = new CreativeVersionStore({ databasePath: join(root, "versions.sqlite"),
    objectRoot: join(root, "objects"), now: () => NOW });
  t.after(() => store.close());
  store.putBrief({ scope: { tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id }, brief });
  const counters = { provider: 0, reserved: 0 };
  let portId = 0;
  let apiId = 0;
  const ports = portsFor(store, counters, () => `cancel-port-${++portId}`);
  let signalEntered;
  const entered = new Promise((resolve) => { signalEntered = resolve; });
  let releaseProvider;
  const providerGate = new Promise((resolve) => { releaseProvider = resolve; });
  const artifactBytes = Buffer.from("durable exact artwork bytes");
  const artifactHash = `sha256:${createHash("sha256").update(artifactBytes).digest("hex")}`;
  ports.provider.generate = async (input) => {
    counters.provider += 1;
    await input.recordTransportAttempt(input.transport_attempt_id);
    signalEntered();
    await providerGate;
    return { design_version_id: "design-cancelled-durable-1",
      artifact: { artifact_id: "artifact-cancelled-durable-1", content_hash: artifactHash, media_type: "image/png" },
      artifact_bytes: Uint8Array.from(artifactBytes), provider: "fixture-provider", model: "fixture-model",
      usage: { completeness: "complete", input_tokens: 2, output_tokens: 4 } };
  };
  const api = createCreativeApi({ ports, now: () => NOW, idFactory: () => `cancel-api-${++apiId}` });
  const pending = api.invoke(actor(), request("cancel-durable-dispatch", await fixture("generate-plan")));
  await entered;
  const job = store.db.prepare("SELECT job_id FROM creative_jobs WHERE action_id=?").get("cancel-durable-dispatch");
  assert.ok(job?.job_id);
  const cancelBody = { ...request("cancel-durable-dispatch-action", await fixture("generate-plan")),
    operation: "cancel", payload: { job_id: job.job_id } };
  const cancelled = await api.invoke(actor(), cancelBody);
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
  assert.equal(cancelled.job.status, "cancelled");
  releaseProvider();
  const response = await pending;
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "cancelled");
  assert.equal(counters.provider, 1);
  const persistedJob = store.db.prepare("SELECT status,result_json,attempt_evidence_json FROM creative_jobs WHERE job_id=?")
    .get(job.job_id);
  assert.equal(persistedJob.status, "cancelled");
  assert.equal(persistedJob.result_json, null);
  const evidence = JSON.parse(persistedJob.attempt_evidence_json);
  assert.equal(typeof evidence.billable_attempt_id, "string");
  assert.equal(evidence.transport_attempt_ids.length, 1);
  assert.equal(evidence.usage_refs.length, 1);
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM design_versions WHERE creation_job_id=?")
    .get(job.job_id).count, 0);
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM creation_actions WHERE job_id=?")
    .get(job.job_id).count, 0, "late provider completion cannot create visible version intent after cancellation");
});

test("private provider attribution can be durably staged and reconciled after restart without redispatch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "creative-provider-attribution-reconcile-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const databasePath = join(root, "versions.sqlite");
  const objectRoot = join(root, "objects");
  const brief = await fixture("brief");
  let store = new CreativeVersionStore({ databasePath, objectRoot, now: () => NOW });
  t.after(() => store?.close());
  store.putBrief({ scope: { tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id }, brief });
  const basePorts = () => createCreativeVersionApiPorts({ store, idFactory: () => "attribution-dispatch-id" }).ports;
  let ports = basePorts();
  const action_id = "action-private-pending-01";
  const request_hash = canonicalHash({ action_id, operation: "generate" });
  const started = await ports.jobs.begin({ scope: SCOPE, actor_id: "actor-api-1", action_id,
    request_hash, operation: "generate" });
  assert.equal(started.kind, "started");
  const transport_attempt_id = "transport-private-pending-01";
  const billable_attempt_id = "billable-private-pending-01";
  const reservation_ref = "reservation-private-pending-01";
  const authorized = await ports.jobs.authorizeDispatch({ scope: SCOPE, actor_id: "actor-api-1",
    job_id: started.job_id, lease_token: started.lease_token, action_id, operation: "generate",
    billable_attempt_id, reservation_ref, provider_name: "openai", provider_model: "gpt-image-2.5-sunburst-2026-09-08",
    transport_attempt_id, context_fence: { brief_id: SCOPE.brief_id, brief_hash: canonicalHash(brief),
      expected_current_design_version_id: null, expected_current_design_hash: null } });
  assert.equal(authorized.status, "authorized");
  const provider_request_id = "req-private-reconcile-fixture-01";
  const provider_request_ref = `provider-request-${createHash("sha256").update(provider_request_id).digest("hex")}`;
  const usage = { completeness: "unknown", missing_fields: ["usage.profile_mapping_pending"],
    transport_attempt_id, provider_request_id: provider_request_ref, input_tokens: 12,
    output_tokens: 8, total_tokens: 20 };
  const pending = await ports.jobs.stagePrivateProviderAttribution({ scope: SCOPE, actor_id: "actor-api-1",
    job_id: started.job_id, action_id, request_hash, operation: "generate", provider: "openai",
    model: "gpt-image-2.5-sunburst-2026-09-08", reservation_ref, billable_attempt_id,
    transport_attempt_id, dispatch_intent_ref: authorized.dispatch_intent_ref,
    target_binding_sha256: `sha256:${"c".repeat(64)}`, provider_request_id, provider_request_ref, usage });
  assert.equal(pending.status, "staged");
  assert.equal(pending.transport_attempt_id, transport_attempt_id);
  assert.match(pending.payload_sha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM private_provider_attributions").get().count, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM private_provider_usage_attributions").get().count, 0);
  const pendingRow = store.db.prepare("SELECT payload_json FROM private_provider_attribution_pending WHERE pending_ref=?")
    .get(pending.pending_ref);
  assert.ok(pendingRow);
  assert.match(pendingRow.payload_json, /req-private-reconcile-fixture-01/,
    "raw response identity remains in restricted durable storage");

  store.close();
  store = new CreativeVersionStore({ databasePath, objectRoot, now: () => NOW });
  ports = basePorts();
  const reconciled = await ports.jobs.reconcilePrivateProviderAttributions({ scope: SCOPE, limit: 10 });
  assert.deepEqual(reconciled, { reconciled: 1, remaining: 0 });
  const rawRequest = store.db.prepare(`SELECT provider_request_id,provider_request_ref,transport_attempt_id
    FROM private_provider_attributions WHERE job_id=?`).get(started.job_id);
  assert.equal(rawRequest.provider_request_id, provider_request_id);
  assert.equal(rawRequest.provider_request_ref, provider_request_ref);
  assert.equal(rawRequest.transport_attempt_id, transport_attempt_id);
  const rawUsage = store.db.prepare(`SELECT usage_sha256,usage_json FROM private_provider_usage_attributions
    WHERE job_id=?`).get(started.job_id);
  assert.ok(rawUsage);
  assert.equal(canonicalHash(JSON.parse(rawUsage.usage_json)), rawUsage.usage_sha256);
  assert.equal(JSON.parse(rawUsage.usage_json).input_tokens, 12);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM private_provider_attribution_reconciliations").get().count, 1);
  assert.deepEqual(await ports.jobs.reconcilePrivateProviderAttributions({ scope: SCOPE, limit: 10 }),
    { reconciled: 0, remaining: 0 }, "replay does not create duplicates or call any provider");
});

test("artifact corruption inside paired publication rolls back the caller-owned SQLite transaction", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "creative-version-corrupt-publish-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const brief = await fixture("brief");
  const store = new CreativeVersionStore({ databasePath: join(root, "versions.sqlite"),
    objectRoot: join(root, "objects"), now: () => NOW });
  t.after(() => store.close());
  store.putBrief({ scope: { tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id }, brief });
  const counters = { provider: 0, reserved: 0 };
  let id = 0;
  const ports = portsFor(store, counters, () => `corrupt-publish-port-${++id}`);
  const prepare = ports.storage.prepareDesignVersion.bind(ports.storage);
  ports.storage.prepareDesignVersion = async (input) => {
    const prepared = await prepare(input);
    const digest = input.design_version.artifact.content_hash.slice(7);
    await unlink(join(store.objectRoot, "objects", "sha256", digest.slice(0, 2), digest));
    return prepared;
  };
  const api = createCreativeApi({ ports, now: () => NOW, idFactory: () => `corrupt-publish-api-${++id}` });
  const result = await api.invoke(actor(), request("corrupt-paired-publish", await fixture("generate-plan")));
  assert.equal(result.ok, false);
  assert.equal(counters.provider, 1);
  assert.equal(store.db.isTransaction, false, "the adapter must close its own transaction after the error");
  const job = store.db.prepare("SELECT status,result_json FROM creative_jobs WHERE action_id=?")
    .get("corrupt-paired-publish");
  assert.equal(job.status, "failed");
  assert.equal(job.result_json, null);
  const action = store.db.prepare("SELECT state FROM creation_actions WHERE action_id=?")
    .get("corrupt-paired-publish");
  assert.equal(action.state, "commit_intent", "the failed caller-owned transaction must not partially commit its unknown marker");
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM design_versions WHERE action_id=?")
    .get("corrupt-paired-publish").count, 0);
  assert.equal(store.getSelection({ scope: SCOPE, brief_id: SCOPE.brief_id }), null);
});

test("actual API process crashes preserve attempt evidence and recover without provider redispatch", async (t) => {
  const stages = ["after_object_write", "after_commit_intent", "after_metadata_write", "after_job_commit"];
  for (const [index, stage] of stages.entries()) {
    const root = await mkdtemp(join(tmpdir(), `creative-api-crash-${index}-`));
    try {
      const databasePath = join(root, "versions.sqlite");
      const objectRoot = join(root, "objects");
      const callLog = join(root, "provider-calls.log");
      const actionId = `durable-api-crash-${index}`;
      const seed = new CreativeVersionStore({ databasePath, objectRoot, now: () => NOW });
      const brief = await fixture("brief");
      seed.putBrief({ scope: { tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id }, brief });
      seed.close();
      const child = spawnSync(process.execPath, [API_CRASH_WORKER.pathname], {
        env: { ...process.env, CREATIVE_API_DATABASE: databasePath, CREATIVE_API_OBJECTS: objectRoot,
          CREATIVE_API_ACTION: actionId, CREATIVE_API_CALL_LOG: callLog, CREATIVE_API_CRASH_AT: stage },
        encoding: "utf8", timeout: 20_000,
      });
      assert.equal(child.status, 86, `${stage}: ${child.stderr}`);
      assert.equal((await readFile(callLog, "utf8")).trim().split("\n").length, 1, "one real API provider dispatch before crash");

      const recoveryNow = stage === "after_object_write" ? NOW + 120_000 : NOW;
      const reopened = new CreativeVersionStore({ databasePath, objectRoot, now: () => recoveryNow });
      const recovery = await reopened.recover();
      const row = reopened.db.prepare(`SELECT status,result_json,attempt_evidence_json FROM creative_jobs
        WHERE action_id=?`).get(actionId);
      assert.equal(typeof row.attempt_evidence_json, "string", "attempt identities survive every crash boundary");
      const evidence = JSON.parse(row.attempt_evidence_json);
      assert.equal(typeof evidence.billable_attempt_id, "string");
      assert.equal(evidence.transport_attempt_ids.length, 1);
      const action = reopened.db.prepare("SELECT state FROM creation_actions WHERE action_id=?").get(actionId);

      if (stage === "after_object_write") {
        assert.deepEqual(recovery, { examined: 1, committed: 0, conflicts: 0, unknown: 1 });
        assert.equal(row.status, "failed");
        assert.equal(row.result_json, null);
        assert.equal(action, undefined, "no visible version intent exists before object staging completes");
        assert.equal(reopened.listDesignVersions({ scope: SCOPE, brief_id: SCOPE.brief_id, limit: 10 }).items.length, 0);
      } else if (stage === "after_job_commit") {
        assert.deepEqual(recovery, { examined: 0, committed: 0, conflicts: 0, unknown: 0 });
        assert.equal(row.status, "completed");
        assert.equal(action.state, "committed");
      } else {
        assert.deepEqual(recovery, { examined: 1, committed: 1, conflicts: 0, unknown: 0 });
        assert.equal(row.status, "completed");
        assert.equal(action.state, "committed");
        const design = JSON.parse(row.result_json).design;
        assert.equal(reopened.getDesignVersion({ scope: SCOPE, brief_id: SCOPE.brief_id,
          design_version_id: design.design_version_id }).design_hash, design.design_hash);
        assert.deepEqual(Buffer.from(await reopened.getArtifactBytes({ scope: SCOPE, brief_id: SCOPE.brief_id,
          design_version_id: design.design_version_id })), Buffer.from("crash-recovery exact artifact bytes"));
      }

      const counters = { provider: 0, reserved: 0 };
      const replayApi = createCreativeApi({ ports: portsFor(reopened, counters, (() => {
        let id = 0; return () => `replay-crash-id-${index}-${++id}`;
      })()), now: () => recoveryNow, idFactory: (() => {
        let id = 0; return () => `replay-crash-api-id-${index}-${++id}`;
      })() });
      const replay = await replayApi.invoke(actor(), request(actionId, await fixture("generate-plan")));
      assert.equal(counters.provider, 0, "recovery and same-action replay never redispatch the provider");
      assert.equal(counters.reserved, 0, "same-action replay never creates another reservation");
      assert.equal(replay.ok, true);
      assert.equal(replay.replayed, true);
      if (stage === "after_object_write") assert.equal(replay.job.status, "failed");
      else assert.equal(replay.job.status, "completed");
      reopened.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("recovery quarantines a corrupted persisted intent without publishing or redispatching", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "creative-api-corrupt-intent-recovery-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const databasePath = join(root, "versions.sqlite");
  const objectRoot = join(root, "objects");
  const callLog = join(root, "provider-calls.log");
  const actionId = "corrupt-intent-recovery";
  const seed = new CreativeVersionStore({ databasePath, objectRoot, now: () => NOW });
  seed.putBrief({ scope: { tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id }, brief: await fixture("brief") });
  seed.close();
  const child = spawnSync(process.execPath, [API_CRASH_WORKER.pathname], {
    env: { ...process.env, CREATIVE_API_DATABASE: databasePath, CREATIVE_API_OBJECTS: objectRoot,
      CREATIVE_API_ACTION: actionId, CREATIVE_API_CALL_LOG: callLog, CREATIVE_API_CRASH_AT: "after_commit_intent" },
    encoding: "utf8", timeout: 20_000,
  });
  assert.equal(child.status, 86, child.stderr);
  assert.equal((await readFile(callLog, "utf8")).trim().split("\n").length, 1);

  const reopened = new CreativeVersionStore({ databasePath, objectRoot, now: () => NOW });
  t.after(() => reopened.close());
  const row = reopened.db.prepare("SELECT intent_json FROM creation_actions WHERE action_id=?").get(actionId);
  reopened.db.prepare("UPDATE creation_actions SET intent_json=? WHERE action_id=?")
    .run(substituteAttemptIdentity(row.intent_json), actionId);
  const recovery = await reopened.recover();
  assert.deepEqual(recovery, { examined: 1, committed: 0, conflicts: 0, unknown: 1 });
  const action = reopened.db.prepare("SELECT state FROM creation_actions WHERE action_id=?").get(actionId);
  const job = reopened.db.prepare("SELECT status,result_json,error_json FROM creative_jobs WHERE action_id=?").get(actionId);
  assert.equal(action.state, "unknown");
  assert.equal(job.status, "failed");
  assert.equal(job.result_json, null);
  assert.equal(JSON.parse(job.error_json).code, "integrity_error");
  assert.equal(reopened.db.prepare("SELECT count(*) AS count FROM design_versions WHERE action_id=?").get(actionId).count, 0);
  assert.equal(reopened.getSelection({ scope: SCOPE, brief_id: SCOPE.brief_id }), null);
  assert.equal(reopened.listDesignVersions({ scope: SCOPE, brief_id: SCOPE.brief_id, limit: 10 }).items.length, 0);

  const counters = { provider: 0, reserved: 0 };
  const replayApi = createCreativeApi({ ports: portsFor(reopened, counters, () => "corrupt-replay-port"),
    now: () => NOW, idFactory: () => "corrupt-replay-api" });
  const replay = await replayApi.invoke(actor(), request(actionId, await fixture("generate-plan")));
  assert.equal(replay.ok, false);
  assert.equal(counters.provider, 0);
  assert.equal(counters.reserved, 0);
  assert.equal((await readFile(callLog, "utf8")).trim().split("\n").length, 1);
});

test("recovery rechecks the job lease after metadata work before committing publication", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "creative-api-recovery-expired-lease-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const databasePath = join(root, "versions.sqlite");
  const objectRoot = join(root, "objects");
  const callLog = join(root, "provider-calls.log");
  const actionId = "recovery-expired-during-publication";
  const seed = new CreativeVersionStore({ databasePath, objectRoot, now: () => NOW });
  seed.putBrief({ scope: { tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id }, brief: await fixture("brief") });
  seed.close();
  const child = spawnSync(process.execPath, [API_CRASH_WORKER.pathname], {
    env: { ...process.env, CREATIVE_API_DATABASE: databasePath, CREATIVE_API_OBJECTS: objectRoot,
      CREATIVE_API_ACTION: actionId, CREATIVE_API_CALL_LOG: callLog, CREATIVE_API_CRASH_AT: "after_commit_intent" },
    encoding: "utf8", timeout: 20_000,
  });
  assert.equal(child.status, 86, child.stderr);
  assert.equal((await readFile(callLog, "utf8")).trim().split("\n").length, 1);

  let now = NOW;
  const reopened = new CreativeVersionStore({ databasePath, objectRoot, now: () => now });
  t.after(() => reopened.close());
  const originalTimestamp = reopened.timestamp.bind(reopened);
  let advancedDuringMetadataTimestamp = false;
  reopened.timestamp = () => {
    const value = originalTimestamp();
    if (!advancedDuringMetadataTimestamp) {
      advancedDuringMetadataTimestamp = true;
      now = NOW + 120_000;
    }
    return value;
  };

  const recovery = await reopened.recover();
  assert.equal(advancedDuringMetadataTimestamp, true);
  assert.deepEqual(recovery, { examined: 1, committed: 0, conflicts: 0, unknown: 1 });
  const job = reopened.db.prepare("SELECT status,result_json FROM creative_jobs WHERE action_id=?").get(actionId);
  const action = reopened.db.prepare("SELECT state FROM creation_actions WHERE action_id=?").get(actionId);
  assert.equal(job.status, "failed");
  assert.equal(job.result_json, null);
  assert.equal(action.state, "unknown");
  assert.equal(reopened.db.prepare("SELECT count(*) AS count FROM design_versions WHERE action_id=?").get(actionId).count, 0);
  assert.equal(reopened.getSelection({ scope: SCOPE, brief_id: SCOPE.brief_id }), null);
  assert.equal(reopened.listDesignVersions({ scope: SCOPE, brief_id: SCOPE.brief_id, limit: 10 }).items.length, 0);
  assert.equal((await readFile(callLog, "utf8")).trim().split("\n").length, 1,
    "recovery of an expired publication intent never redispatches the provider");
});
