import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCreativeApi } from "../../src/api/v1.mjs";
import { canonicalHash, canonicalSerialize } from "../../src/contracts/index.mjs";
import { createCreativeVersionApiPorts } from "../../src/versions/api-ports.mjs";
import { CreativeVersionStore, VersionStoreError } from "../../src/versions/store.mjs";

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

function portsFor(store, counters, idFactory) {
  const bytes = Buffer.from("durable exact artwork bytes");
  const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const provider = {
    resolveRoute: () => ({ retry_mapping_ref: "retry:fixture/1", provider: {
      name: "fixture-provider", model: "fixture-model", endpoint: "test:/image",
      sdk: { name: "fixture-sdk", version: "1.0" },
    } }),
    async generate(input) {
      counters.provider += 1;
      await input.recordTransportAttempt(input.transport_attempt_id);
      return { design_version_id: "design-durable-api-1",
        artifact: { artifact_id: "artifact-durable-api-1", content_hash: hash, media_type: "image/png" },
        artifact_bytes: Uint8Array.from(bytes), provider: "fixture-provider", model: "fixture-model",
        usage: { completeness: "complete", input_tokens: 2, output_tokens: 4 } };
    },
    async edit(input) {
      counters.provider += 1;
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
    async recordTransportAttempt() { return { status: "recorded" }; },
    async recordUsageObservation(input) { return { status: "accepted",
      source_observation_id: input.observation.source_observation_id,
      effective_billable_attempt_id: input.observation.billable_attempt_id }; },
    async settleReservation(input) { return { status: "settled", reservation_id: input.reservation_id,
      consumed_amount: { amount: "0.10", currency: "USD" },
      released_unused_amount: { amount: "0.90", currency: "USD" } }; },
    async markOutcomeUnknown() { return { status: "held_for_reconciliation" }; },
  };
  const adapted = createCreativeVersionApiPorts({ store, otherPorts: { provider, metering }, idFactory });
  return adapted.ports;
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
  assert.equal(attemptEvidence.usage_refs.length, 1);
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
