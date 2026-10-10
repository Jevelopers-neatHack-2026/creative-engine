import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createCreativeApi, CREATIVE_API_OPERATIONS } from "creative-engine/api/v1";
import { canonicalHash } from "creative-engine/contracts";
import { createCreativeVersionApiPorts, CreativeVersionStore } from "creative-engine/versions";
import { createSqliteTelemetryOutbox } from "creative-engine/telemetry";
import {
  completeResearchPackage,
  deniedAssetResearchPackage,
  injectedSourceResearchPackage,
  missingDateResearchPackage,
  syntheticAdmissionCredentialResearchPackage,
} from "../../fixtures/planning/research-packages.mjs";

const NOW = Date.parse("2026-10-10T12:30:00.000Z");
const NOW_ISO = new Date(NOW).toISOString();
const SCOPE = Object.freeze({ tenant_id: "tenant-brief-api", project_id: "project-brief-api" });
const INVALIDATION_CRASH_WORKER = fileURLToPath(new URL("../../fixtures/planning/invalidation-crash-worker.mjs", import.meta.url));

function scopedResearch(source = completeResearchPackage()) {
  return { ...source, tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id };
}

function actor(permissions = ["creative.generate", "creative.edit", "creative.read", "creative.restore",
  "creative.cancel", "creative.brief.create", "creative.brief.invalidate"]) {
  return {
    actor_id: "actor-brief-api",
    ...SCOPE,
    expires_at: "2026-10-11T00:00:00.000Z",
    permissions,
    budget_scope_id: "budget-brief-api",
    budget_policy_version: "budget-policy/fixture-1",
  };
}

function request(operation, action_id, payload = {}, source_refs = []) {
  return {
    contract: "CreativeApiRequest",
    schema_version: "1.0",
    event_id: `event:${action_id}`,
    request_id: `request:${action_id}`,
    tenant_id: SCOPE.tenant_id,
    project_id: SCOPE.project_id,
    correlation_id: `correlation:${action_id}`,
    producer: "brief-api-fixture",
    occurred_at: "2026-10-10T12:20:00.000Z",
    ingested_at: "2026-10-10T12:20:00.000Z",
    environment: "test",
    billing_mode: "simulated",
    source_refs,
    operation,
    action_id,
    payload,
  };
}

function invalidationEvent(brief, { eventId = "research-revocation-2", revision = 2, kind = "asset" } = {}) {
  const packageRef = brief.research_package_ref;
  return {
    event_id: eventId,
    tenant_id: SCOPE.tenant_id,
    project_id: SCOPE.project_id,
    source_package_id: packageRef.package_id,
    source_package_hash: packageRef.content_hash,
    source_revision: revision,
    occurred_at: "2026-10-10T12:29:00.000Z",
    kind,
    reason: kind === "asset" ? "asset_permission_revoked" : "fact_corrected",
    ...(kind === "asset"
      ? { assets: [{ asset_id: "asset-1", content_hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }] }
      : { fact_ids: ["event-date-1"] }),
    affected_briefs: [{ brief_id: brief.brief_id, brief_hash: canonicalHash(brief) }],
  };
}

function createPlan(brief, { useAsset = false, planId = "plan-brief-generate" } = {}) {
  return {
    contract: "EditPlan",
    schema_version: "1.0",
    event_id: `event:${planId}`,
    tenant_id: SCOPE.tenant_id,
    project_id: SCOPE.project_id,
    correlation_id: `correlation:${planId}`,
    producer: "brief-api-fixture",
    occurred_at: "2026-10-10T12:21:00.000Z",
    ingested_at: "2026-10-10T12:21:00.000Z",
    environment: "test",
    billing_mode: "simulated",
    source_refs: useAsset ? ["page-1"] : [],
    plan_id: planId,
    base: {
      brief_hash: canonicalHash(brief),
      design_hash: canonicalHash({ contract: "DesignRoot", schema_version: "1.0", brief_id: brief.brief_id }),
    },
    operation: "concept.generate",
    steps: [{ step_id: `${planId}:step`, action: "concept.generate", source_refs: useAsset ? ["page-1"] : [],
      parameters: { brief_id: brief.brief_id, variant_count: 1 } }],
    expected_result: { contract: "DesignVersion", schema_version: "1.0",
      parent_version_id: `root:${brief.brief_id}`, artifact_kind: "image" },
    invalidates: [],
  };
}

async function setup(t, { research = scopedResearch(), planning = {}, now = () => NOW } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "creative-brief-api-"));
  const store = new CreativeVersionStore({ databasePath: join(directory, "creative.sqlite"),
    objectRoot: join(directory, "objects"), now });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const counters = { provider: 0, provider_dispatch: 0, reserve: 0, transport: 0, package: 0, approval: 0, producerAck: 0 };
  const callbackOrder = [];
  let currentResearch = research;
  const eventById = new Map();
  const artifactBytes = Buffer.from("fixture image bytes for brief API integration");
  const artifactHash = `sha256:${createHash("sha256").update(artifactBytes).digest("hex")}`;
  let designSequence = 0;
  const provider = {
    resolveRoute() {
      return { retry_mapping_ref: "retry:fixture/1", provider: { name: "fixture-provider", model: "fixture-image",
        endpoint: "test:/image", sdk: { name: "fixture-native", version: "1.0" } } };
    },
    async generate(input) {
      counters.provider += 1;
      await input.recordTransportAttempt(input.transport_attempt_id);
      counters.provider_dispatch += 1;
      return { design_version_id: `design:brief-${++designSequence}`,
        artifact: { artifact_id: `artifact:brief-${designSequence}`, content_hash: artifactHash, media_type: "image/png" },
        artifact_bytes: Uint8Array.from(artifactBytes), provider: "fixture-provider", model: "fixture-image",
        usage: { completeness: "complete", input_tokens: 2, output_tokens: 3 } };
    },
    async edit(input) {
      counters.provider += 1;
      await input.recordTransportAttempt(input.transport_attempt_id);
      counters.provider_dispatch += 1;
      return { design_version_id: `design:brief-edit-${counters.provider}`,
        artifact: { artifact_id: `artifact:brief-edit-${counters.provider}`, content_hash: artifactHash, media_type: "image/png" },
        artifact_bytes: Uint8Array.from(artifactBytes), provider: "fixture-provider", model: "fixture-image",
        usage: { completeness: "complete", input_tokens: 2, output_tokens: 3 } };
    },
  };
  const metering = {
    async reserveAttempt(attempt) {
      counters.reserve += 1;
      return { status: "reserved", reservation_id: `reservation:${attempt.billable_attempt_id}`,
        billable_attempt_id: attempt.billable_attempt_id, held_amount: { amount: "1.00", currency: "USD" },
        lease_id: `finance-lease:${attempt.billable_attempt_id}` };
    },
    async releaseBeforeDispatch() { return { status: "released" }; },
    async markAttemptInFlight(input) { return { status: "in_flight", reservation_id: input.reservation_id }; },
    async recordTransportAttempt(input) {
      counters.transport += 1;
      return { status: "recorded", transport_attempt_id: input.transport_attempt_id };
    },
    async recordUsageObservation(input) { return { status: "accepted",
      source_observation_id: input.observation.source_observation_id,
      effective_billable_attempt_id: input.observation.billable_attempt_id }; },
    async settleReservation(input) { return { status: "settled", reservation_id: input.reservation_id,
      consumed_amount: { amount: "0.10", currency: "USD" }, released_unused_amount: { amount: "0.90", currency: "USD" } }; },
    async markOutcomeUnknown() { return { status: "held_for_reconciliation" }; },
  };
  const externalPlanning = {
    ...planning,
    async getCurrentResearchPackage({ scope }) {
      counters.package += 1;
      if (scope.tenant_id !== SCOPE.tenant_id || scope.project_id !== SCOPE.project_id) {
        throw new Error("fixture scope mismatch");
      }
      return currentResearch;
    },
    async getInvalidationEvent({ scope, event_id }) {
      if (scope.tenant_id !== SCOPE.tenant_id || scope.project_id !== SCOPE.project_id) throw new Error("fixture scope mismatch");
      return eventById.get(event_id);
    },
    invalidationVerifier: {
      async verifyInvalidation({ event, trusted_scope }) {
        return { status: "verified", classification: "synthetic_test", evidence_ref: "synthetic:owner-verifier",
          event_hash: event.content_hash, event_id: event.event_id, tenant_id: trusted_scope.tenant_id,
          project_id: trusted_scope.project_id, verified_at: NOW_ISO, valid_until: "2026-10-10T12:31:00.000Z" };
      },
    },
    approvalStaleness: {
      async markBriefStale(item) {
        counters.approval += 1;
        callbackOrder.push("approval");
        assert.equal(store.db.isTransaction, false);
        assert.equal(store.isBriefUsable({ scope: SCOPE, brief_id: item.brief_id, brief_hash: item.brief_hash }), false);
        return { ...item, status: "acknowledged" };
      },
    },
    producerAcknowledgment: {
      async acknowledgeInvalidation(input) {
        counters.producerAck += 1;
        callbackOrder.push("producer");
        assert.equal(store.db.isTransaction, false);
        const event = eventById.get(input.event_id);
        assert.ok(event);
        assert.equal(store.planningStore(SCOPE).isPackageFenced(SCOPE.tenant_id, SCOPE.project_id,
          event.source_package_id, event.source_package_hash), true);
        assert.equal(store.planningStore(SCOPE).listPendingApprovalStaleness(SCOPE.tenant_id, SCOPE.project_id,
          input.event_id).length, 0);
        return { status: "acknowledged", ...input };
      },
    },
  };
  Object.assign(externalPlanning, planning);
  const idFactory = (() => { let id = 0; return () => `fixture-id-${++id}`; })();
  const adapted = createCreativeVersionApiPorts({ store, idFactory, otherPorts: {
    provider, metering, planning: externalPlanning,
  } });
  const ports = adapted.ports;
  ports.telemetry = {
    outbox: createSqliteTelemetryOutbox({ database: store.db, clock: now }),
    modes: { provider_execution_mode: "mock", commerce_mode: "simulated" },
    usage_profiles: { image_generation: "creative.normalized-token-usage/1", image_edit: "creative.normalized-token-usage/1",
      vision_observation: "creative.normalized-token-usage/1", jev_decision: "typesafe.systemone-usage/2026-10-10" },
  };
  const api = createCreativeApi({ ports, now, idFactory });
  return {
    api, store, ports, counters, callbackOrder, eventById,
    get research() { return currentResearch; },
    set research(value) { currentResearch = value; },
  };
}

async function createBrief(api, actionId, payload = {}, principal = actor()) {
  return api.invoke(principal, request("brief.create", actionId, payload));
}

test("public operation manifest adds only the brief creation and invalidation actions", () => {
  assert.deepEqual(CREATIVE_API_OPERATIONS.slice(-2), ["brief.create", "brief.invalidate"]);
  assert.equal(new Set(CREATIVE_API_OPERATIONS).size, CREATIVE_API_OPERATIONS.length);
});

test("brief.create loads trusted research, is deterministic and replayable, and targets missing facts without a provider", async (t) => {
  const system = await setup(t);
  const input = { customer_preferences: [{ preference_id: "pref-customer-1", value: "bright colors" }],
    artistic_intent: [{ interpretation_id: "intent-customer-1", text: "warm, welcoming layout" }] };
  const first = await createBrief(system.api, "brief-create-repeatable", input);
  const replay = await createBrief(system.api, "brief-create-repeatable", input);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.replayed, false);
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.equal(replay.replayed, true);
  assert.equal(first.result.plan_hash, replay.result.plan_hash);
  assert.equal(first.result.execution_policy.provider_calls, 0);
  assert.equal(first.result.execution_policy.provider_dispatch_allowed, false);
  assert.equal(first.result.asset_readiness[0].state, "verification_required");
  assert.equal(first.result.brief.preferences.items.some((item) => item.value === "bright colors"), true);
  assert.equal(first.result.brief.interpretations.items.some((item) => item.text === "warm, welcoming layout"), true);
  assert.equal(system.counters.package, 1, "a completed action replays before loading mutable research again");
  assert.equal(system.counters.provider, 0);
  assert.equal(system.counters.reserve, 0);

  const changedPackage = scopedResearch();
  changedPackage.package_id = "current-package-replaced";
  system.research = changedPackage;
  const replayAfterPackageChange = await createBrief(system.api, "brief-create-repeatable", input);
  assert.equal(replayAfterPackageChange.ok, true, JSON.stringify(replayAfterPackageChange));
  assert.equal(replayAfterPackageChange.replayed, true);
  assert.equal(replayAfterPackageChange.result.plan_hash, first.result.plan_hash);
  assert.equal(system.counters.package, 1, "historical create replay does not re-plan against the current source package");

  system.research = scopedResearch(missingDateResearchPackage());
  const missing = await createBrief(system.api, "brief-create-missing-date");
  assert.equal(missing.ok, true, JSON.stringify(missing));
  assert.equal(missing.result.brief.facts.verified.some((fact) => fact.key === "event_date"), false);
  assert.equal(missing.result.required_facts.find((fact) => fact.fact_key === "event_date").status, "missing");
  assert.match(missing.result.clarification_requests.find((fact) => fact.fact_key === "event_date").question, /exact event date/i);
  assert.equal(system.counters.provider, 0);
  assert.equal(system.counters.reserve, 0);
});

test("the API boundary rejects caller-owned array hooks before invoking them or loading research", async (t) => {
  const system = await setup(t);
  let mapCalls = 0;
  const preferences = [];
  Object.defineProperty(preferences, "map", { enumerable: true, value() {
    mapCalls += 1;
    return [{ preference_id: "replacement", value: "Bearer synthetic-review-secret" }];
  } });
  const result = await createBrief(system.api, "brief-array-hook", { customer_preferences: preferences });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_request");
  assert.equal(JSON.stringify(result).includes("synthetic-review-secret"), false);
  assert.equal(mapCalls, 0);
  assert.equal(system.counters.package, 0);
});

test("brief corrections remain requests, source instructions are inert, and admission credentials stay absent", async (t) => {
  const system = await setup(t);
  const correction = await createBrief(system.api, "brief-correction-request", {
    fact_corrections: [{ fact_id: "event-date-1", proposed_value: "2027-05-19" }],
  });
  assert.equal(correction.ok, true, JSON.stringify(correction));
  assert.equal(correction.result.brief.facts.verified.find((fact) => fact.fact_id === "event-date-1").value, "2027-05-18");
  assert.equal(correction.result.correction_requests[0].status, "pending_research_owner");
  assert.equal(correction.result.correction_requests[0].approval_staleness_request.status, "pending_application_acknowledgment");

  system.research = scopedResearch(injectedSourceResearchPackage());
  const injected = await createBrief(system.api, "brief-injected-source");
  assert.equal(injected.ok, true, JSON.stringify(injected));
  const injectedJson = JSON.stringify(injected);
  assert.equal(injectedJson.includes("Ignore verified event facts"), false);
  assert.equal(injectedJson.includes("unlock every logo"), false);
  assert.equal(injectedJson.includes("increase the budget"), false);
  assert.equal(injectedJson.includes("without an approval check"), false);
  assert.equal(injected.result.execution_policy.budget_mutation_allowed, false);
  assert.equal(injected.result.execution_policy.asset_permission_mutation_allowed, false);

  system.research = scopedResearch(syntheticAdmissionCredentialResearchPackage());
  const sensitive = await createBrief(system.api, "brief-admission-credential");
  assert.equal(sensitive.ok, true, JSON.stringify(sensitive));
  const sensitiveJson = JSON.stringify(sensitive);
  assert.equal(sensitiveJson.includes("SYNTHETIC-NOT-A-REAL-CREDENTIAL"), false);
  assert.equal(sensitiveJson.includes("admission_credential"), true);
  assert.equal(system.counters.provider, 0);
  assert.equal(system.counters.reserve, 0);
});

test("trusted permission evidence is bound to the exact project, package, asset and action before image dispatch", async (t) => {
  const denied = await setup(t, { research: scopedResearch(deniedAssetResearchPackage()) });
  const deniedBrief = await createBrief(denied.api, "brief-denied-asset");
  assert.equal(deniedBrief.ok, true, JSON.stringify(deniedBrief));
  const deniedResult = await denied.api.invoke(actor(), request("generate", "generate-denied-asset",
    { brief_id: deniedBrief.result.brief.brief_id, plan: createPlan(deniedBrief.result.brief, { useAsset: true }) }, ["page-1"]));
  assert.equal(deniedResult.ok, false);
  assert.equal(deniedResult.error.code, "permission_denied", JSON.stringify(deniedResult));
  assert.equal(denied.counters.provider, 0);
  assert.equal(denied.counters.reserve, 0);

  for (const [label, invalidProof] of [
    ["expired", ({ asset, packageInfo }) => ({ status: "granted", owner_evidence_status: "verified",
      tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id, asset_id: asset.asset_id,
      content_hash: asset.content_hash, action: "reproduce", package_id: packageInfo.package_id,
      package_hash: packageInfo.package_hash, evidence_ref: "synthetic:expired", checked_at: NOW_ISO,
      expires_at: "2026-10-10T12:29:59.999Z" })],
    ["cross-scope", ({ asset, packageInfo }) => ({ status: "granted", owner_evidence_status: "verified",
      tenant_id: "tenant-other", project_id: SCOPE.project_id, asset_id: asset.asset_id,
      content_hash: asset.content_hash, action: "reproduce", package_id: packageInfo.package_id,
      package_hash: packageInfo.package_hash, evidence_ref: "synthetic:cross-scope", checked_at: NOW_ISO,
      expires_at: "2026-10-10T12:31:00.000Z" })],
  ]) {
    const system = await setup(t, { planning: { assetPermissionVerifier: { async verifyAssetUse(input) {
      return invalidProof({ asset: { asset_id: input.asset_id, content_hash: input.content_hash },
        packageInfo: { package_id: input.package_id, package_hash: input.package_hash } });
    } } } });
    const briefResponse = await createBrief(system.api, `brief-${label}-proof`);
    const result = await system.api.invoke(actor(), request("generate", `generate-${label}-proof`, {
      brief_id: briefResponse.result.brief.brief_id, plan: createPlan(briefResponse.result.brief, { useAsset: true, planId: `plan-${label}` }),
    }, ["page-1"]));
    assert.equal(result.ok, false, `${label}: ${JSON.stringify(result)}`);
    assert.equal(result.error.code, "permission_denied");
    assert.equal(system.counters.provider, 0);
    assert.equal(system.counters.reserve, 0);
  }
});

test("asset revocation during an awaited verifier fences the same database before route or provider dispatch", async (t) => {
  let verificationStarted;
  let finishVerification;
  const started = new Promise((resolve) => { verificationStarted = resolve; });
  const proofGate = new Promise((resolve) => { finishVerification = resolve; });
  const system = await setup(t, { planning: { assetPermissionVerifier: { async verifyAssetUse(input) {
    verificationStarted();
    await proofGate;
    return { status: "granted", owner_evidence_status: "verified", tenant_id: input.tenant_id,
      project_id: input.project_id, asset_id: input.asset_id, content_hash: input.content_hash,
      action: input.action, package_id: input.package_id, package_hash: input.package_hash,
      evidence_ref: "synthetic:late-asset-proof", checked_at: NOW_ISO, expires_at: "2026-10-10T12:31:00.000Z" };
  } } } });
  const briefResponse = await createBrief(system.api, "brief-rights-race");
  const brief = briefResponse.result.brief;
  const generation = system.api.invoke(actor(), request("generate", "generate-rights-race", {
    brief_id: brief.brief_id, plan: createPlan(brief, { useAsset: true, planId: "plan-rights-race" }),
  }, ["page-1"]));
  await started;

  const event = invalidationEvent(brief, { eventId: "asset-revoked-during-verification", revision: 2 });
  system.eventById.set(event.event_id, event);
  const invalidated = await system.api.invoke(actor(), request("brief.invalidate", "invalidate-rights-race", { event_id: event.event_id }));
  assert.equal(invalidated.ok, true, JSON.stringify(invalidated));
  assert.equal(invalidated.result.local_status, "acknowledged");
  finishVerification();

  const result = await generation;
  assert.equal(result.ok, false);
  assert.ok(["permission_denied", "stale_version"].includes(result.error.code));
  assert.equal(system.counters.provider, 0);
  assert.equal(system.counters.reserve, 0);
  assert.equal(system.counters.transport, 0);
  assert.equal(system.store.isBriefUsable({ scope: SCOPE, brief_id: brief.brief_id, brief_hash: canonicalHash(brief) }), false);
});

test("asset revocation during the C03 transport acknowledgment blocks the provider send", async (t) => {
  let transportStarted;
  let releaseTransport;
  const started = new Promise((resolve) => { transportStarted = resolve; });
  const acknowledgmentGate = new Promise((resolve) => { releaseTransport = resolve; });
  const system = await setup(t, { planning: { assetPermissionVerifier: { async verifyAssetUse(input) {
    return { status: "granted", owner_evidence_status: "verified", tenant_id: input.tenant_id,
      project_id: input.project_id, asset_id: input.asset_id, content_hash: input.content_hash,
      action: input.action, package_id: input.package_id, package_hash: input.package_hash,
      evidence_ref: "synthetic:transport-race-proof", checked_at: NOW_ISO, expires_at: "2026-10-10T12:31:00.000Z" };
  } } } });
  system.ports.metering.recordTransportAttempt = async (input) => {
    system.counters.transport += 1;
    transportStarted();
    await acknowledgmentGate;
    return { status: "recorded", transport_attempt_id: input.transport_attempt_id };
  };
  const briefResponse = await createBrief(system.api, "brief-transport-rights-race");
  const brief = briefResponse.result.brief;
  const generation = system.api.invoke(actor(), request("generate", "generate-transport-rights-race", {
    brief_id: brief.brief_id, plan: createPlan(brief, { useAsset: true, planId: "plan-transport-rights-race" }),
  }, ["page-1"]));
  await started;

  const event = invalidationEvent(brief, { eventId: "asset-revoked-during-transport-ack", revision: 2 });
  system.eventById.set(event.event_id, event);
  const invalidated = await system.api.invoke(actor(), request("brief.invalidate", "invalidate-transport-rights-race",
    { event_id: event.event_id }));
  assert.equal(invalidated.ok, true, JSON.stringify(invalidated));
  releaseTransport();

  const result = await generation;
  assert.equal(result.ok, false);
  assert.ok(["permission_denied", "stale_version"].includes(result.error.code));
  assert.equal(system.counters.provider, 0, "the provider adapter must not be called after the post-ack fence rejects");
  assert.equal(system.counters.provider_dispatch, 0, "the adapter must not send after the post-ack fence rejects");
  assert.equal(system.counters.transport, 1, "the single transport intent is preserved for reconciliation");
  assert.equal(system.store.isBriefUsable({ scope: SCOPE, brief_id: brief.brief_id, brief_hash: canonicalHash(brief) }), false);
});

test("asset proof expiry during a later current-package read blocks the request", async (t) => {
  let now = NOW;
  let proofReturned = false;
  const system = await setup(t, { now: () => now, planning: { assetPermissionVerifier: { async verifyAssetUse(input) {
    proofReturned = true;
    return { status: "granted", owner_evidence_status: "verified", tenant_id: input.tenant_id,
      project_id: input.project_id, asset_id: input.asset_id, content_hash: input.content_hash,
      action: input.action, package_id: input.package_id, package_hash: input.package_hash,
      evidence_ref: "synthetic:short-lived-proof", checked_at: new Date(now).toISOString(),
      expires_at: new Date(now + 100).toISOString() };
  } } } });
  const created = await createBrief(system.api, "brief-short-lived-proof");
  const brief = created.result.brief;
  const getPackage = system.ports.planning.getCurrentResearchPackage;
  system.ports.planning.getCurrentResearchPackage = async (input) => {
    const result = await getPackage(input);
    if (proofReturned) {
      proofReturned = false;
      now += 200;
    }
    return result;
  };
  const result = await system.api.invoke(actor(), request("generate", "generate-short-lived-proof", {
    brief_id: brief.brief_id, plan: createPlan(brief, { useAsset: true, planId: "plan-short-lived-proof" }),
  }, ["page-1"]));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "permission_denied");
  assert.equal(system.counters.reserve, 0);
  assert.equal(system.counters.transport, 0);
  assert.equal(system.counters.provider_dispatch, 0);
  assert.ok(now >= NOW + 200);
});

test("asset proof expiry during final atomic job authorization prevents provider dispatch", async (t) => {
  let now = NOW;
  let providerEntered = false;
  let providerAuthorizations = 0;
  const system = await setup(t, { now: () => now, planning: { assetPermissionVerifier: { async verifyAssetUse(input) {
    return { status: "granted", owner_evidence_status: "verified", tenant_id: input.tenant_id,
      project_id: input.project_id, asset_id: input.asset_id, content_hash: input.content_hash,
      action: input.action, package_id: input.package_id, package_hash: input.package_hash,
      evidence_ref: "synthetic:final-send-proof", checked_at: new Date(now).toISOString(),
      expires_at: new Date(now + 100).toISOString() };
  } } } });
  const created = await createBrief(system.api, "brief-final-send-proof");
  const brief = created.result.brief;
  const generate = system.ports.provider.generate;
  system.ports.provider.generate = async (input) => {
    providerEntered = true;
    return generate(input);
  };
  const authorize = system.ports.jobs.authorizeDispatch;
  system.ports.jobs.authorizeDispatch = async (input) => {
    const result = await authorize(input);
    if (providerEntered) {
      providerAuthorizations += 1;
      if (providerAuthorizations === 2) now += 200;
    }
    return result;
  };
  const result = await system.api.invoke(actor(), request("generate", "generate-final-send-proof", {
    brief_id: brief.brief_id, plan: createPlan(brief, { useAsset: true, planId: "plan-final-send-proof" }),
  }, ["page-1"]));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "permission_denied");
  assert.equal(providerAuthorizations, 2, "the expiration occurs in the final job authorization after a fresh rights check");
  assert.equal(system.counters.reserve, 1);
  assert.equal(system.counters.transport, 1);
  assert.equal(system.counters.provider, 1);
  assert.equal(system.counters.provider_dispatch, 0);
});

test("persisted cancellation during the post-ACK context lookup is caught by the final job authorization", async (t) => {
  const system = await setup(t);
  const created = await createBrief(system.api, "brief-final-cancel-fence");
  const brief = created.result.brief;
  let providerEntered = false;
  let postEntryAuthorization = false;
  let cancellationIssued = false;
  let cancelResult;
  const generate = system.ports.provider.generate;
  system.ports.provider.generate = async (input) => {
    providerEntered = true;
    return generate(input);
  };
  const authorize = system.ports.jobs.authorizeDispatch;
  system.ports.jobs.authorizeDispatch = async (input) => {
    const result = await authorize(input);
    if (providerEntered) postEntryAuthorization = true;
    return result;
  };
  const getPackage = system.ports.planning.getCurrentResearchPackage;
  system.ports.planning.getCurrentResearchPackage = async (input) => {
    const result = await getPackage(input);
    if (postEntryAuthorization && !cancellationIssued) {
      cancellationIssued = true;
      const job = system.store.db.prepare("SELECT job_id FROM creative_jobs WHERE action_id=?")
        .get("generate-final-cancel-fence");
      cancelResult = await system.api.invoke(actor(), request("cancel", "cancel-during-post-ack-context",
        { job_id: job.job_id }));
    }
    return result;
  };
  const generation = await system.api.invoke(actor(), request("generate", "generate-final-cancel-fence", {
    brief_id: brief.brief_id, plan: createPlan(brief, { planId: "plan-final-cancel-fence" }),
  }));
  assert.equal(cancelResult?.ok, true, JSON.stringify(cancelResult));
  assert.equal(generation.ok, false);
  assert.equal(generation.error.code, "cancelled");
  assert.equal(system.counters.provider, 1);
  assert.equal(system.counters.provider_dispatch, 0, "the fixture adapter never receives the post-ACK send permit");
  assert.equal(system.counters.reserve, 1);
  assert.equal(system.counters.transport, 1);
});

test("a changed trusted package appends immutable brief history while old and new designs remain comparable", async (t) => {
  const system = await setup(t);
  const firstBriefResponse = await createBrief(system.api, "brief-history-version-1");
  const firstBrief = firstBriefResponse.result.brief;
  const firstGenerationRequest = request("generate", "generate-brief-version-1", {
    brief_id: firstBrief.brief_id, plan: createPlan(firstBrief, { planId: "plan-brief-version-1" }),
  });
  const firstGeneration = await system.api.invoke(actor(), firstGenerationRequest);
  assert.equal(firstGeneration.ok, true, JSON.stringify(firstGeneration));
  const firstDesign = firstGeneration.result.design_version;
  assert.equal(firstDesign.brief_hash, canonicalHash(firstBrief));

  const changedResearch = scopedResearch();
  changedResearch.facts.find((fact) => fact.fact_id === "event-name-1").value = "Revised Festival Name";
  system.research = changedResearch;
  const secondBriefResponse = await createBrief(system.api, "brief-history-version-2");
  assert.equal(secondBriefResponse.ok, true, JSON.stringify(secondBriefResponse));
  const secondBrief = secondBriefResponse.result.brief;
  assert.equal(secondBrief.brief_id, firstBrief.brief_id);
  assert.notEqual(secondBriefResponse.result.brief_hash, canonicalHash(firstBrief));

  const replayedFirstGeneration = await system.api.invoke(actor(), firstGenerationRequest);
  assert.equal(replayedFirstGeneration.ok, true, JSON.stringify(replayedFirstGeneration));
  assert.equal(replayedFirstGeneration.replayed, true);
  assert.equal(replayedFirstGeneration.result.design_version.design_version_id, firstDesign.design_version_id);
  assert.equal(system.counters.provider, 1, "historical replay reads its exact immutable brief without a new dispatch");
  assert.equal(system.counters.reserve, 1);

  const secondGeneration = await system.api.invoke(actor(), request("generate", "generate-brief-version-2", {
    brief_id: secondBrief.brief_id, plan: createPlan(secondBrief, { planId: "plan-brief-version-2" }),
  }));
  assert.equal(secondGeneration.ok, true, JSON.stringify(secondGeneration));
  const secondDesign = secondGeneration.result.design_version;
  assert.notEqual(secondDesign.design_version_id, firstDesign.design_version_id);
  assert.equal(secondDesign.parent_version_id, null);
  assert.equal(secondDesign.brief_hash, secondBriefResponse.result.brief_hash);

  const page = await system.api.invoke(actor(), request("list", "list-brief-history", {
    brief_id: secondBrief.brief_id, limit: 10,
  }));
  assert.equal(page.ok, true, JSON.stringify(page));
  assert.deepEqual(page.result.items.map((item) => item.design_version_id), [firstDesign.design_version_id, secondDesign.design_version_id]);
  assert.equal(page.result.items[0].brief_hash, canonicalHash(firstBrief));
  assert.equal(page.result.items[1].brief_hash, secondBriefResponse.result.brief_hash);

  const comparison = await system.api.invoke(actor(), request("compare", "compare-brief-history", {
    brief_id: secondBrief.brief_id,
    left_design_version_id: firstDesign.design_version_id,
    right_design_version_id: secondDesign.design_version_id,
  }));
  assert.equal(comparison.ok, true, JSON.stringify(comparison));
  assert.equal(comparison.result.left.brief_hash, canonicalHash(firstBrief));
  assert.equal(comparison.result.right.brief_hash, secondBriefResponse.result.brief_hash);
  assert.deepEqual(comparison.result.changed_fields, ["brief_hash"]);

  const history = system.store.planningStore(SCOPE).getBriefHistory(firstBrief.brief_id);
  assert.equal(history.length, 2);
  assert.equal(canonicalHash(history[0].brief), canonicalHash(firstBrief));
  assert.equal(canonicalHash(history[1].brief), secondBriefResponse.result.brief_hash);
  assert.equal(system.counters.provider, 2);
  assert.equal(system.counters.reserve, 2);
});

test("invalidation callbacks follow durable fences, duplicate and out-of-order receipts persist, and replay cannot restore rights", async (t) => {
  const system = await setup(t);
  const created = await createBrief(system.api, "brief-before-invalidation");
  const brief = created.result.brief;
  const firstEvent = invalidationEvent(brief, { eventId: "research-revocation-2", revision: 2 });
  system.eventById.set(firstEvent.event_id, firstEvent);
  const first = await system.api.invoke(actor(), request("brief.invalidate", "invalidate-revocation-2",
    { event_id: firstEvent.event_id }));
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.result.local_status, "acknowledged");
  assert.equal(first.result.invalidation.durable_receipt.verification_classification, "synthetic_test");
  assert.equal(system.counters.approval, 1);
  assert.equal(system.counters.producerAck, 1);
  assert.deepEqual(system.callbackOrder, ["approval", "producer"]);

  const duplicate = await system.api.invoke(actor(), request("brief.invalidate", "invalidate-revocation-2-replay",
    { event_id: firstEvent.event_id }));
  assert.equal(duplicate.ok, true, JSON.stringify(duplicate));
  assert.equal(duplicate.result.invalidation.durable_receipt.receipt_id, first.result.invalidation.durable_receipt.receipt_id);
  assert.equal(system.counters.approval, 1);
  assert.equal(system.counters.producerAck, 1);
  assert.deepEqual(system.callbackOrder, ["approval", "producer"]);

  const olderEvent = invalidationEvent(brief, { eventId: "research-correction-1", revision: 1, kind: "fact" });
  system.eventById.set(olderEvent.event_id, olderEvent);
  const older = await system.api.invoke(actor(), request("brief.invalidate", "invalidate-correction-1",
    { event_id: olderEvent.event_id }));
  assert.equal(older.ok, true, JSON.stringify(older));
  assert.equal(older.result.local_status, "acknowledged");
  assert.deepEqual(system.callbackOrder, ["approval", "producer", "approval", "producer"]);
  assert.equal(system.store.isBriefUsable({ scope: SCOPE, brief_id: brief.brief_id, brief_hash: canonicalHash(brief) }), false);
  assert.equal(system.store.planningStore(SCOPE).isFactFenced(SCOPE.tenant_id, SCOPE.project_id,
    brief.research_package_ref.package_id, brief.research_package_ref.content_hash, "event-date-1"), true);

  const blockedReplay = await createBrief(system.api, "brief-same-package-after-revocation");
  assert.equal(blockedReplay.ok, false);
  assert.equal(blockedReplay.error.code, "stale_version");

  const changed = scopedResearch();
  changed.facts.find((fact) => fact.fact_id === "event-name-1").value = "Changed Festival Name";
  system.research = changed;
  const newBrief = await createBrief(system.api, "brief-new-package-hash");
  assert.equal(newBrief.ok, true, JSON.stringify(newBrief));
  assert.equal(newBrief.result.brief.brief_id, brief.brief_id);
  assert.notEqual(newBrief.result.brief_hash, canonicalHash(brief));
  assert.equal(system.store.getBrief({ scope: SCOPE, brief_id: brief.brief_id }).event_id, newBrief.result.brief.event_id);
  const history = system.store.planningStore(SCOPE).getBriefHistory(brief.brief_id);
  assert.equal(history.length, 2);
  assert.equal(canonicalHash(history[0].brief), canonicalHash(brief));
  assert.equal(canonicalHash(history[1].brief), newBrief.result.brief_hash);
  assert.equal(system.counters.provider, 0);
});

test("brief.invalidate binds one public action identity to one event while retaining event replay", async (t) => {
  const system = await setup(t);
  const created = await createBrief(system.api, "brief-public-invalidation-action");
  const brief = created.result.brief;
  const firstEvent = invalidationEvent(brief, { eventId: "public-action-event-one", revision: 2 });
  const secondEvent = invalidationEvent(brief, { eventId: "public-action-event-two", revision: 3 });
  system.eventById.set(firstEvent.event_id, firstEvent);
  system.eventById.set(secondEvent.event_id, secondEvent);

  const first = await system.api.invoke(actor(), request("brief.invalidate", "same-public-invalidation-action",
    { event_id: firstEvent.event_id }));
  assert.equal(first.ok, true, JSON.stringify(first));
  const replay = await system.api.invoke(actor(), request("brief.invalidate", "same-public-invalidation-action",
    { event_id: firstEvent.event_id }));
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.equal(replay.replayed, true);
  assert.equal(system.counters.approval, 1);
  assert.equal(system.counters.producerAck, 1);

  const conflict = await system.api.invoke(actor(), request("brief.invalidate", "same-public-invalidation-action",
    { event_id: secondEvent.event_id }));
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error.code, "conflict");
  assert.equal(system.store.planningStore(SCOPE).getInvalidationReceipt(SCOPE.tenant_id, SCOPE.project_id,
    secondEvent.event_id), null);
  assert.equal(system.counters.approval, 1);
  assert.equal(system.counters.producerAck, 1);

  const distinctAction = await system.api.invoke(actor(), request("brief.invalidate", "distinct-public-invalidation-action",
    { event_id: secondEvent.event_id }));
  assert.equal(distinctAction.ok, true, JSON.stringify(distinctAction));
  assert.equal(system.counters.approval, 2);
  assert.equal(system.counters.producerAck, 2);
});

test("an incomplete invalidation action remains retryable under the same identity", async (t) => {
  let denyApproval = true;
  let approvalCalls = 0;
  const system = await setup(t, { planning: { approvalStaleness: { async markBriefStale(item) {
    approvalCalls += 1;
    if (denyApproval) return { status: "denied", request_id: item.request_id };
    return { ...item, status: "acknowledged" };
  } } } });
  const created = await createBrief(system.api, "brief-pending-public-action");
  const event = invalidationEvent(created.result.brief, { eventId: "pending-public-event", revision: 2 });
  system.eventById.set(event.event_id, event);
  const first = await system.api.invoke(actor(), request("brief.invalidate", "retryable-public-action",
    { event_id: event.event_id }));
  assert.equal(first.ok, false);
  assert.equal(system.counters.producerAck, 0);
  denyApproval = false;
  const retry = await system.api.invoke(actor(), request("brief.invalidate", "retryable-public-action",
    { event_id: event.event_id }));
  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.equal(retry.result.local_status, "acknowledged");
  assert.equal(approvalCalls, 2);
  assert.equal(system.counters.producerAck, 1);
});

test("hard exit after local invalidation commit leaves a pending receipt that replays safely after reopen", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "creative-brief-hard-exit-"));
  const databasePath = join(directory, "creative.sqlite");
  const objectRoot = join(directory, "objects");
  let store;
  t.after(async () => { store?.close(); await rm(directory, { recursive: true, force: true }); });
  const child = spawnSync(process.execPath, [INVALIDATION_CRASH_WORKER, databasePath, objectRoot], {
    encoding: "utf8", timeout: 15_000,
  });
  assert.equal(child.status, 71, `hard-exit worker failed: ${child.stderr}\n${child.stdout}`);

  store = new CreativeVersionStore({ databasePath, objectRoot, now: () => NOW });
  const briefId = store.db.prepare("SELECT brief_id FROM creative_briefs WHERE tenant_id=? AND project_id=?")
    .get(SCOPE.tenant_id, SCOPE.project_id).brief_id;
  const brief = store.getBrief({ scope: SCOPE, brief_id: briefId });
  const event = invalidationEvent(brief, { eventId: "child-crash-revocation", revision: 2 });
  const planningStore = store.planningStore(SCOPE);
  assert.equal(store.isBriefUsable({ scope: SCOPE, brief_id: briefId, brief_hash: canonicalHash(brief) }), false);
  assert.equal(planningStore.listPendingApprovalStaleness(SCOPE.tenant_id, SCOPE.project_id, event.event_id).length, 1);
  assert.equal(planningStore.getProducerAcknowledgment(SCOPE.tenant_id, SCOPE.project_id, event.event_id), null);

  const callbackOrder = [];
  let verifierCalls = 0;
  const externalPlanning = {
    async getInvalidationEvent({ event_id }) { assert.equal(event_id, event.event_id); return event; },
    invalidationVerifier: { async verifyInvalidation() { verifierCalls += 1; throw new Error("persisted event must not be reverified"); } },
    approvalStaleness: { async markBriefStale(item) {
      callbackOrder.push("approval");
      assert.equal(store.db.isTransaction, false);
      assert.equal(store.isBriefUsable({ scope: SCOPE, brief_id: item.brief_id, brief_hash: item.brief_hash }), false);
      return { ...item, status: "acknowledged" };
    } },
    producerAcknowledgment: { async acknowledgeInvalidation(input) {
      callbackOrder.push("producer");
      assert.equal(store.db.isTransaction, false);
      assert.equal(planningStore.listPendingApprovalStaleness(SCOPE.tenant_id, SCOPE.project_id, input.event_id).length, 0);
      return { status: "acknowledged", ...input };
    } },
  };
  const adapted = createCreativeVersionApiPorts({ store, otherPorts: { planning: externalPlanning } });
  const api = createCreativeApi({ ports: adapted.ports, now: () => NOW, idFactory: () => "replay-fixture-id" });
  const replay = await api.invoke(actor(), request("brief.invalidate", "invalidation-after-reopen", { event_id: event.event_id }));
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.equal(replay.result.local_status, "acknowledged");
  assert.equal(verifierCalls, 0);
  assert.deepEqual(callbackOrder, ["approval", "producer"]);
  assert.equal(planningStore.listPendingApprovalStaleness(SCOPE.tenant_id, SCOPE.project_id, event.event_id).length, 0);
  assert.equal(planningStore.getProducerAcknowledgment(SCOPE.tenant_id, SCOPE.project_id, event.event_id).status,
    "acknowledged");
});

test("brief operations enforce explicit permissions and reject unknown operations", async (t) => {
  const system = await setup(t);
  const denied = await createBrief(system.api, "brief-without-create-permission", {}, actor(["creative.read"]));
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, "permission_denied");
  assert.equal(system.counters.package, 0);

  const unknown = await system.api.invoke(actor(), request("brief.grant-asset", "unknown-brief-operation", {}));
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, "invalid_request");
  assert.equal(system.counters.package, 0);
  assert.equal(system.counters.provider, 0);
  assert.equal(system.counters.reserve, 0);
});
