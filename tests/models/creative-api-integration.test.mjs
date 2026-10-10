import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCreativeApi } from "../../src/api/v1.mjs";
import { canonicalHash, normalizeResearchPackage, validateCreativeBrief } from "../../src/contracts/index.mjs";
import { createOpenAIImagesProvider } from "creative-engine/models";
import { createCreativeVersionApiPorts } from "../../src/versions/api-ports.mjs";
import { CreativeVersionStore } from "../../src/versions/store.mjs";
import { createSqliteTelemetryOutbox, USAGE_PROFILE } from "../../src/telemetry/index.mjs";
import { completeResearchPackage } from "../../fixtures/planning/research-packages.mjs";
import { makePng } from "../../fixtures/models/png.mjs";

const NOW = Date.parse("2026-10-10T18:00:00.000Z");
const MODEL = "gpt-image-2.5-sunburst-2026-09-08";
const SCOPE = Object.freeze({ tenant_id: "tenant-api-1", project_id: "project-api-1", brief_id: "brief-api-1" });
const hash = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

async function jsonFixture(path) {
  return JSON.parse(await readFile(new URL(`../../fixtures/api/${path}.json`, import.meta.url), "utf8"));
}

function authorizedActor() {
  return { actor_id: "actor-api-1", tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id,
    expires_at: "2026-10-11T00:00:00.000Z",
    permissions: ["creative.generate", "creative.edit", "creative.read", "creative.restore", "creative.cancel"],
    budget_scope_id: "budget-api-1", budget_policy_version: "budget-policy/1" };
}

function apiRequest(actionId, operation, plan, sourceRef, payload = {}) {
  const occurred = "2026-10-10T12:20:00.000Z";
  return { contract: "CreativeApiRequest", schema_version: "1.0", event_id: `event-${actionId}`,
    request_id: `request-${actionId}`, tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id,
    correlation_id: `correlation-${actionId}`, producer: "creative-image-api-integration",
    occurred_at: occurred, ingested_at: occurred, environment: "test", billing_mode: "simulated",
    source_refs: [sourceRef], operation, action_id: actionId,
    payload: { brief_id: SCOPE.brief_id, plan, ...payload } };
}

function cancelRequest(actionId, jobId) {
  return { contract: "CreativeApiRequest", schema_version: "1.0", event_id: `event-${actionId}`,
    request_id: `request-${actionId}`, tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id,
    correlation_id: `correlation-${actionId}`, producer: "creative-image-api-integration",
    occurred_at: "2026-10-10T12:20:00.000Z", ingested_at: "2026-10-10T12:20:00.000Z",
    environment: "test", billing_mode: "simulated", source_refs: [], operation: "cancel", action_id: actionId,
    payload: { job_id: jobId } };
}

function authorityPorts() {
  const evidenceHash = `sha256:${"a".repeat(64)}`;
  const capabilityFor = (input) => ({ status: "verified", eligible: true, revoked: false,
    operation_permission: "allowed", quota_status: "available", service: "openai",
    account_ref: "org-synthetic", project_ref: "proj-synthetic",
    tenant_id: input.scope.tenant_id, project_id: input.scope.project_id,
    budget_scope_id: input.attempt.budget_scope_id, operation: input.operation, model: input.model,
    target_binding_sha256: input.target_binding_sha256,
    expires_at: new Date(NOW + 10 * 60_000).toISOString(),
    evidence_ref: "fixture-capability-proof", evidence_sha256: evidenceHash });
  const authorityFor = (input) => {
    const grant = { service: "openai", grant_ref: "grant-synthetic", account_ref: "org-synthetic",
      project_ref: "proj-synthetic", tenant_id: input.scope.tenant_id, project_id: input.scope.project_id,
      target_binding_sha256: input.target_binding_sha256, operation: input.operation, model: MODEL,
      permission: "allowed", revoked: false, expires_at: new Date(NOW + 10 * 60_000).toISOString(),
      evidence_ref: "fixture-grant-proof", evidence_sha256: evidenceHash };
    const finance = { status: "held", revoked: false, reservation_ref: input.reservation_ref,
      billable_attempt_id: input.billable_attempt_id, budget_scope_id: input.budget_scope_id,
      lease_ref: "finance-lease-synthetic", grant_ref: grant.grant_ref,
      account_ref: grant.account_ref, project_ref: grant.project_ref, tenant_id: grant.tenant_id,
      project_id: grant.project_id, provider: "openai", model: MODEL, operation: input.operation,
      target_binding_sha256: input.target_binding_sha256,
      held_amount: { amount: "1.00", currency: "USD" }, authorized_cap: { amount: "2.00", currency: "USD" },
      expires_at: new Date(NOW + 10 * 60_000).toISOString(), evidence_ref: "fixture-finance-proof",
      evidence_sha256: evidenceHash };
    return { status: "authorized", revoked: false, grant, finance };
  };
  return {
    capabilityPort: { verify: capabilityFor, revalidate: capabilityFor },
    authorizationPort: { revalidate: authorityFor },
    credentialPort: { async resolveCredential(input) { return {
      status: "resolved", token: "synthetic-offline-token",
      binding: { service: "openai", account_ref: input.account_ref, project_ref: input.project_ref,
        grant_ref: input.grant_ref, target_binding_sha256: input.target_binding_sha256 },
      provider_scope: { organization_id: input.account_ref, project_id: input.project_ref },
      expires_at: new Date(NOW + 10 * 60_000).toISOString(),
      evidence: { ref: "fixture-credential-proof", sha256: evidenceHash },
    }; } },
  };
}

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "creative-image-api-integration-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  let runtimeNow = NOW;
  const store = new CreativeVersionStore({ databasePath: join(root, "versions.sqlite"),
    objectRoot: join(root, "objects"), now: () => runtimeNow });
  t.after(() => store.close());

  const referenceBytes = makePng({ width: 16, height: 16 });
  const researchInput = completeResearchPackage();
  researchInput.tenant_id = SCOPE.tenant_id;
  researchInput.project_id = SCOPE.project_id;
  researchInput.package_id = "research-image-api-1";
  researchInput.source_refs.push("source:page-2", "asset:asset-2");
  researchInput.source_identity.push({ source_id: "page-2", uri: "https://example.test/reference-2.png",
    retrieved_at: "2026-10-10T12:00:00Z", content_hash: hash(referenceBytes) });
  researchInput.assets.items.push({ asset_id: "asset-2", source_id: "page-2",
    content_hash: hash(referenceBytes), media_type: "image/png" });
  researchInput.permissions.items.push({ asset_id: "asset-2", action: "modify", status: "granted",
    evidence_refs: ["page-2"] });
  const research = normalizeResearchPackage(researchInput, { tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id });

  const brief = await jsonFixture("brief");
  brief.research_package_ref.package_id = research.package_id;
  brief.research_package_ref.content_hash = canonicalHash(research);
  brief.source_identity = research.source_identity.map(({ source_id, uri }) => ({ source_id, uri }));
  brief.facts.verified[0].provenance_refs = ["page-1"];
  brief.permissions.items = [
    { asset_id: "asset-1", action: "reproduce", status: "granted", evidence_refs: ["page-1"] },
    { asset_id: "asset-2", action: "modify", status: "granted", evidence_refs: ["page-2"] },
  ];
  const trustedBrief = validateCreativeBrief(brief, { trustedScope: SCOPE });
  store.putBrief({ scope: { tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id }, brief: trustedBrief });

  const referenceAssetBytes = new Map([["asset-2", referenceBytes]]);
  const counters = { seed_dispatches: 0, provider_posts: 0, reserves: 0, settlements: 0, held: 0,
    usage_observations: [] };
  let id = 0;
  const metering = {
    async reserveAttempt(attempt) {
      counters.reserves += 1;
      return { status: "reserved", reservation_id: `reservation:${attempt.billable_attempt_id}`,
        billable_attempt_id: attempt.billable_attempt_id, held_amount: { amount: "1.00", currency: "USD" },
        lease_id: `finance-lease:${attempt.billable_attempt_id}` };
    },
    async releaseBeforeDispatch() { return { status: "released" }; },
    async markAttemptInFlight(input) { return { status: "in_flight", reservation_id: input.reservation_id }; },
    async recordTransportAttempt() { return { status: "recorded" }; },
    async recordUsageObservation(input) {
      counters.usage_observations.push(structuredClone(input.observation));
      return { status: "accepted",
      source_observation_id: input.observation.source_observation_id,
      effective_billable_attempt_id: input.observation.billable_attempt_id }; },
    async settleReservation(input) {
      counters.settlements += 1;
      return { status: "settled", reservation_id: input.reservation_id,
        consumed_amount: { amount: "0.10", currency: "USD" },
        released_unused_amount: { amount: "0.90", currency: "USD" } };
    },
    async markOutcomeUnknown() { counters.held += 1; return { status: "held_for_reconciliation" }; },
  };
  const fixtureBytes = makePng({ width: 16, height: 16 });
  const fixtureHash = hash(fixtureBytes);
  const provider = {
    resolveRoute: ({ operation }) => ({ retry_mapping_ref: "retry:fixture/1", provider: {
      name: "fixture-provider", model: "fixture-model", endpoint: `test:/images/${operation}`,
      sdk: { name: "fixture-sdk", version: "1" },
    } }),
    async generate(input) {
      counters.seed_dispatches += 1;
      await input.recordTransportAttempt(input.transport_attempt_id);
      return { design_version_id: "design-image-parent-1",
        artifact: { artifact_id: "artifact-image-parent-1", content_hash: fixtureHash, media_type: "image/png" },
        artifact_bytes: Uint8Array.from(fixtureBytes), provider: "fixture-provider", model: "fixture-model",
        usage: { completeness: "complete", input_tokens: 3, output_tokens: 5 } };
    },
    async edit() { throw new Error("fixture edit should not be used"); },
  };
  let assetPermissionRevoked = false;
  const permissionVerifier = {
    async verifyAssetUse(input) { return { status: assetPermissionRevoked ? "denied" : "granted",
      owner_evidence_status: "verified",
      tenant_id: input.tenant_id, project_id: input.project_id, asset_id: input.asset_id,
      content_hash: input.content_hash, action: input.action, package_id: input.package_id,
      package_hash: input.package_hash, checked_at: input.now,
      expires_at: new Date(NOW + 5 * 60_000).toISOString(), evidence_ref: "synthetic-permission-proof" }; },
  };
  const adapted = createCreativeVersionApiPorts({ store, idFactory: () => `version-port-${++id}`, leaseDurationMs: 60_000,
    otherPorts: { provider, metering, planning: { getCurrentResearchPackage: () => research,
      assetPermissionVerifier: permissionVerifier } } });
  const ports = { ...adapted.ports,
    telemetry: { outbox: createSqliteTelemetryOutbox({ database: store.db, clock: () => NOW }),
      modes: { provider_execution_mode: "mock", commerce_mode: "simulated" },
      usage_profiles: { image_generation: USAGE_PROFILE.NORMALIZED, image_edit: USAGE_PROFILE.NORMALIZED,
        vision_observation: USAGE_PROFILE.NORMALIZED, jev_decision: USAGE_PROFILE.TYPESAFE_DECISION } },
  };
  const api = createCreativeApi({ ports, now: () => runtimeNow, idFactory: () => `api-id-${++id}` });
  return { store, api, ports, research, brief: trustedBrief, referenceBytes, referenceAssetBytes, counters,
    revokeAssetPermission() { assetPermissionRevoked = true; }, advanceClock(milliseconds) { runtimeNow += milliseconds; } };
}

function createNativeProvider({ referenceAssetBytes, store, fetchImpl, authorityOverrides = {} }) {
  return createOpenAIImagesProvider({
    model_id: MODEL,
    configuration: { quality: "low", size: "16x16", output_format: "png", background: "opaque", moderation: "auto" },
    ...authorityPorts(),
    ...authorityOverrides,
    promptPort: { async render() { return "Synthetic integration prompt with no model authority."; } },
    assetPort: {
      async readArtifact(input) { return store.getArtifactBytes({ scope: { ...input.scope, brief_id: SCOPE.brief_id },
        brief_id: SCOPE.brief_id, design_version_id: "design-image-parent-1" }); },
      async readReference(input) { return referenceAssetBytes.get(input.asset_id); },
    },
    fetchImpl,
    now: () => NOW,
    idFactory: () => "artifact-native-image-output",
  });
}

function mockOwnerUsageProfileAuthority({ transformResult = (result) => result, beforeMap } = {}) {
  const profileSha = `sha256:${"b".repeat(64)}`;
  return Object.freeze({
    async mapProviderUsage(input) {
      await beforeMap?.(input);
      if (input.attempt.provider.name !== "openai" || input.attempt.provider.model !== MODEL ||
          input.rawUsage.transport_attempt_id !== input.transportAttemptId ||
          input.rawUsage.completeness !== "unknown" ||
          JSON.stringify(input.rawUsage.missing_fields) !== JSON.stringify(["usage.profile_mapping_pending"])) {
        return { status: "unknown" };
      }
      const attempt = input.attempt;
      const raw = input.rawUsage;
      const observation = {
        schema_version: "creative.metering.proposal/v1",
        tenant_id: attempt.tenant_id,
        project_id: attempt.project_id,
        budget_scope_id: attempt.budget_scope_id,
        logical_operation_id: attempt.logical_operation_id,
        billable_attempt_id: attempt.billable_attempt_id,
        source_observation_id: input.sourceObservationId,
        source: "provider_response",
        provider_name: attempt.provider.name,
        model: attempt.provider.model,
        ...(raw.provider_request_id ? { provider_request_id: raw.provider_request_id } : {}),
        transport_attempt_id: input.transportAttemptId,
        environment: attempt.environment,
        billing_mode: attempt.billing_mode,
        completeness: "complete",
        missing_fields: [],
        usage_units: [
          { name: "input_tokens", quantity: String(raw.input_tokens), relation: "included_subset", included_in: "total_tokens" },
          { name: "output_tokens", quantity: String(raw.output_tokens), relation: "included_subset", included_in: "total_tokens" },
          { name: "total_tokens", quantity: String(raw.total_tokens), relation: "standalone" },
          { name: "input_tokens_details.image_tokens", quantity: String(raw.input_tokens_details.image_tokens), relation: "included_subset", included_in: "input_tokens" },
          { name: "input_tokens_details.text_tokens", quantity: String(raw.input_tokens_details.text_tokens), relation: "included_subset", included_in: "input_tokens" },
          { name: "output_tokens_details.image_tokens", quantity: String(raw.output_tokens_details.image_tokens), relation: "included_subset", included_in: "output_tokens" },
          { name: "output_tokens_details.text_tokens", quantity: String(raw.output_tokens_details.text_tokens), relation: "included_subset", included_in: "output_tokens" },
        ],
      };
      return transformResult({
        status: "mapped",
        profile_ref: "mock-owner-profile:gpt-image-2.5-fixture/1",
        profile_sha256: profileSha,
        raw_usage_sha256: input.rawUsageSha256,
        target_binding_sha256: input.targetBindingSha256,
        attempt_binding_sha256: input.attemptBindingSha256,
        observation,
      }, input);
    },
  });
}

test("actual Creative API edit serializes parent plus authorized reference; unknown usage holds and raw request ID persists privately", async (t) => {
  const context = await setup(t);
  const plan = await jsonFixture("generate-plan");
  plan.base.brief_hash = canonicalHash(context.brief);
  plan.source_refs = ["page-1"];
  plan.steps[0].source_refs = ["page-1"];
  const seed = await context.api.invoke(authorizedActor(), apiRequest("image-parent-action", "generate", plan, "page-1"));
  assert.equal(seed.ok, true, JSON.stringify(seed));
  assert.equal(context.counters.settlements, 1);
  assert.equal(context.counters.seed_dispatches, 1);

  const outputBytes = makePng({ width: 16, height: 16 });
  let postedUrl;
  let observedInputFiles;
  const provider = createNativeProvider({ store: context.store, referenceAssetBytes: context.referenceAssetBytes,
    fetchImpl: async (url, init) => {
      context.counters.provider_posts += 1;
      postedUrl = String(url);
      observedInputFiles = init.body.getAll("image[]");
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "error");
      assert.equal(init.cache, "no-store");
      return new Response(JSON.stringify({ data: [{ b64_json: outputBytes.toString("base64") }],
        usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30,
          input_tokens_details: { image_tokens: 18, text_tokens: 2 },
          output_tokens_details: { image_tokens: 9, text_tokens: 1 } } }),
      { status: 200, headers: { "content-type": "application/json", "x-request-id": "req-private-image-edit-01" } });
    } });
  context.ports.provider = provider;

  const editPlan = await jsonFixture("edit-plan");
  editPlan.base.brief_hash = canonicalHash(context.brief);
  editPlan.base.design_hash = seed.result.design_version.design_hash;
  editPlan.base.design_version_id = seed.result.design_version.design_version_id;
  editPlan.source_refs = ["page-2"];
  editPlan.steps[0].source_refs = ["page-2"];
  editPlan.steps[0].parameters.design_version_id = seed.result.design_version.design_version_id;
  editPlan.steps[0].parameters.artifact_id = seed.result.design_version.artifact.artifact_id;
  editPlan.expected_result.parent_version_id = seed.result.design_version.design_version_id;
  const manifest = { contract: "CreativeImageReferenceManifest", schema_version: "1.0",
    tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id, brief_id: SCOPE.brief_id,
    brief_hash: canonicalHash(context.brief), research_package_id: context.research.package_id,
    research_package_hash: canonicalHash(context.research),
    base_design_version_id: seed.result.design_version.design_version_id,
    base_design_hash: seed.result.design_version.design_hash,
    references: [{ source_ref: "page-2", asset_id: "asset-2", content_hash: hash(context.referenceBytes),
      media_type: "image/png", width: 16, height: 16 }] };
  const result = await context.api.invoke(authorizedActor(), apiRequest("image-edit-action", "edit", editPlan, "page-2", {
    design_version_id: seed.result.design_version.design_version_id,
    image_reference_manifest: manifest,
  }));
  assert.equal(result.ok, false, "unmapped GPT Image 2.5 usage must not authorize settlement or publication");
  assert.equal(context.counters.provider_posts, 1, JSON.stringify(result));
  assert.equal(postedUrl, "https://api.openai.com/v1/images/edits");
  assert.equal(observedInputFiles.length, 2, "parent plus exactly one authorized reference is sent as image[]");
  assert.deepEqual(Buffer.from(await observedInputFiles[0].arrayBuffer()), outputBytes,
    "selected immutable parent bytes are first");
  assert.deepEqual(Buffer.from(await observedInputFiles[1].arrayBuffer()), context.referenceBytes,
    "manifest reference bytes follow in manifest order");
  assert.equal(context.counters.held, 1);
  assert.equal(context.counters.settlements, 1, "the initial fixture generation alone settles");
  assert.equal(context.store.listDesignVersions({ scope: SCOPE, brief_id: SCOPE.brief_id, limit: 10 }).items.length, 1,
    "unmapped image usage leaves the exact returned bytes unpublished");

  const attribution = context.store.db.prepare(`SELECT * FROM private_provider_attributions
    WHERE action_id='image-edit-action'`).get();
  assert.ok(attribution);
  assert.equal(attribution.provider_request_id, "req-private-image-edit-01");
  assert.equal(attribution.operation, "edit");
  assert.equal(attribution.reservation_ref.startsWith("reservation:"), true);
  assert.equal(attribution.billable_attempt_id.length > 0, true);
  assert.equal(attribution.dispatch_intent_ref.length > 0, true);
  const rawUsageAttribution = context.store.db.prepare(`SELECT * FROM private_provider_usage_attributions
    WHERE action_id='image-edit-action'`).get();
  assert.ok(rawUsageAttribution, "raw provider counters are retained separately from owner normalization");
  assert.equal(rawUsageAttribution.provider_model, MODEL);
  assert.equal(rawUsageAttribution.target_binding_sha256.startsWith("sha256:"), true);
  const privateUsage = JSON.parse(rawUsageAttribution.usage_json);
  assert.equal(privateUsage.input_tokens, 20);
  assert.equal(privateUsage.output_tokens_details.image_tokens, 9);
  assert.deepEqual(privateUsage.missing_fields, ["usage.profile_mapping_pending"],
    "the private record retains that no accepted profile mapped these native counts");
  assert.doesNotMatch(rawUsageAttribution.usage_json, /req-private-image-edit-01/);
  const publicRows = context.store.db.prepare(`SELECT result_json,error_json FROM creative_jobs WHERE action_id='image-edit-action'`).get();
  assert.doesNotMatch(JSON.stringify(publicRows), /req-private-image-edit-01/);
  const telemetryRows = context.store.db.prepare(`SELECT payload_json FROM creative_telemetry_evidence_outbox_v1`).all();
  assert.doesNotMatch(JSON.stringify(telemetryRows), /req-private-image-edit-01/);

  const databasePath = context.store.databasePath;
  const objectRoot = context.store.objectRoot;
  context.store.close();
  const reopened = new (context.store.constructor)({ databasePath, objectRoot, now: () => NOW });
  t.after(() => reopened.close());
  const persisted = reopened.db.prepare(`SELECT provider_request_id,provider_request_ref,reservation_ref,transport_attempt_id
    FROM private_provider_attributions WHERE action_id='image-edit-action'`).get();
  assert.equal(persisted.provider_request_id, "req-private-image-edit-01", "private attribution survives process/store restart");
  assert.match(persisted.provider_request_ref, /^provider-request-[a-f0-9]{64}$/);
  const persistedUsage = reopened.db.prepare(`SELECT usage_sha256,usage_json FROM private_provider_usage_attributions
    WHERE action_id='image-edit-action'`).get();
  assert.ok(persistedUsage, "bounded usage attribution survives process/store restart");
  assert.equal(canonicalHash(JSON.parse(persistedUsage.usage_json)), persistedUsage.usage_sha256);
});

test("actual API holds and stages native response attribution on a transient usage writer failure", async (t) => {
  const context = await setup(t);
  const outputBytes = makePng({ width: 16, height: 16 });
  const provider = createNativeProvider({ store: context.store, referenceAssetBytes: context.referenceAssetBytes,
    fetchImpl: async () => {
      context.counters.provider_posts += 1;
      return new Response(JSON.stringify({ data: [{ b64_json: outputBytes.toString("base64") }],
        usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 } }),
      { status: 200, headers: { "content-type": "application/json", "x-request-id": "req-private-transient-usage-01" } });
    } });
  context.ports.provider = provider;
  const originalJobs = context.ports.jobs;
  let stageCalls = 0;
  let stageFailure;
  context.ports.jobs = { ...originalJobs, async recordPrivateProviderAttribution(input) {
    return { status: "recorded", transport_attempt_id: "transport-foreign",
      provider_request_ref: input.provider_request_ref };
  }, async recordPrivateProviderUsageAttribution() {
    throw new Error("transient private usage store interruption");
  }, async stagePrivateProviderAttribution(input) {
    stageCalls += 1;
    try { return await originalJobs.stagePrivateProviderAttribution(input); }
    catch (error) { stageFailure = `${error.code ?? "error"}:${error.field ?? ""}`; throw error; }
  } };
  const plan = await jsonFixture("generate-plan");
  plan.base.brief_hash = canonicalHash(context.brief);
  plan.source_refs = [];
  plan.steps[0].source_refs = [];
  const request = apiRequest("image-stage-usage-action", "generate", plan, "page-1");
  request.source_refs = [];
  const result = await context.api.invoke(authorizedActor(), request);
  assert.equal(result.ok, false);
  assert.equal(context.counters.provider_posts, 1);
  assert.equal(context.counters.held, 1);
  assert.equal(context.counters.settlements, 0);
  assert.equal(context.store.listDesignVersions({ scope: SCOPE, brief_id: SCOPE.brief_id, limit: 10 }).items.length, 0);
  assert.equal(context.store.db.prepare("SELECT COUNT(*) AS count FROM private_provider_attributions WHERE action_id=?")
    .get("image-stage-usage-action").count, 0, "an unavailable ACK is not accepted as a recorded identity");
  assert.equal(context.store.db.prepare("SELECT COUNT(*) AS count FROM private_provider_usage_attributions WHERE action_id=?")
    .get("image-stage-usage-action").count, 0);
  const jobRow = context.store.db.prepare("SELECT job_id,status FROM creative_jobs WHERE action_id=?")
    .get("image-stage-usage-action");
  assert.equal(jobRow.status, "failed");
  const staged = context.store.db.prepare("SELECT payload_json,payload_sha256 FROM private_provider_attribution_pending WHERE job_id=?")
    .get(jobRow.job_id);
  assert.ok(staged, `${JSON.stringify(result)}; stageCalls=${stageCalls}; stageFailure=${stageFailure ?? "none"}`);
  assert.equal(stageCalls, 1);
  assert.equal(stageFailure, undefined);
  const stagedPayload = JSON.parse(staged.payload_json);
  assert.equal(stagedPayload.provider_request_id, "req-private-transient-usage-01");
  assert.equal(stagedPayload.usage.input_tokens, 12);
  assert.equal(stagedPayload.usage.output_tokens, 8);
  assert.equal(canonicalHash(stagedPayload), staged.payload_sha256);
  assert.doesNotMatch(JSON.stringify(result), /req-private-transient-usage-01/);

  const reconciled = await context.ports.jobs.reconcilePrivateProviderAttributions({ scope: SCOPE, limit: 10 });
  assert.deepEqual(reconciled, { reconciled: 1, remaining: 0 });
  assert.equal(context.counters.provider_posts, 1, "reconciliation never redispatches the provider request");
  assert.equal(context.store.db.prepare("SELECT provider_request_id FROM private_provider_attributions WHERE action_id=?")
    .get("image-stage-usage-action").provider_request_id, "req-private-transient-usage-01");
  const persistedUsage = context.store.db.prepare(`SELECT usage_json FROM private_provider_usage_attributions WHERE action_id=?`)
    .get("image-stage-usage-action");
  assert.ok(persistedUsage);
  assert.equal(JSON.parse(persistedUsage.usage_json).total_tokens, 20);
  assert.deepEqual(await context.ports.jobs.reconcilePrivateProviderAttributions({ scope: SCOPE, limit: 10 }),
    { reconciled: 0, remaining: 0 });
});

test("wide native usage preserves bounded counters and private request identity before rejecting the response", async (t) => {
  const cases = [
    ["200 root width", 200, "root"],
    ["200 detail width", 200, "details"],
    ["400 root width", 400, "root"],
    ["400 detail width", 400, "details"],
  ];
  for (const [index, [label, status, width]] of cases.entries()) {
    await t.test(label, async (subtest) => {
      const context = await setup(subtest);
      const outputBytes = makePng({ width: 16, height: 16 });
      const rawUsage = { input_tokens: 12, output_tokens: 8, total_tokens: 20,
        input_tokens_details: { image_tokens: 10, text_tokens: 2 },
        output_tokens_details: { image_tokens: 7, text_tokens: 1 } };
      if (width === "root") {
        for (let extra = 0; extra < 33; extra += 1) rawUsage[`extension_${extra}`] = extra;
      } else {
        for (let extra = 0; extra < 33; extra += 1) rawUsage.input_tokens_details[`extension_${extra}`] = extra;
      }
      const requestId = `req-private-wide-usage-${index}`;
      context.ports.provider = createNativeProvider({ store: context.store,
        referenceAssetBytes: context.referenceAssetBytes, fetchImpl: async () => {
          context.counters.provider_posts += 1;
          return new Response(JSON.stringify(status === 200
            ? { data: [{ b64_json: outputBytes.toString("base64") }], usage: rawUsage }
            : { error: { code: "invalid_request" }, usage: rawUsage }),
          { status, headers: { "content-type": "application/json", "x-request-id": requestId } });
        } });
      const plan = await jsonFixture("generate-plan");
      plan.base.brief_hash = canonicalHash(context.brief);
      plan.source_refs = [];
      plan.steps[0].source_refs = [];
      const request = apiRequest(`image-wide-usage-${index}`, "generate", plan, "page-1");
      request.source_refs = [];
      const result = await context.api.invoke(authorizedActor(), request);

      assert.equal(result.ok, false, JSON.stringify(result));
      assert.equal(context.counters.provider_posts, 1);
      assert.equal(context.counters.held, 1);
      assert.equal(context.counters.settlements, 0);
      assert.equal(context.store.listDesignVersions({ scope: SCOPE, brief_id: SCOPE.brief_id, limit: 10 }).items.length, 0);
      assert.equal(context.counters.usage_observations.length, 1);
      assert.notEqual(context.counters.usage_observations[0].completeness, "complete");
      assert.doesNotMatch(JSON.stringify(context.counters.usage_observations[0]), /extension_/,
        "unrecognized provider extensions are never copied into public telemetry");

      const job = context.store.db.prepare("SELECT job_id FROM creative_jobs WHERE action_id=?")
        .get(`image-wide-usage-${index}`);
      const identity = context.store.db.prepare("SELECT provider_request_id FROM private_provider_attributions WHERE job_id=?")
        .get(job.job_id);
      assert.equal(identity?.provider_request_id, requestId, "the bounded provider identity is retained privately");
      const usageRow = context.store.db.prepare("SELECT usage_json FROM private_provider_usage_attributions WHERE job_id=?")
        .get(job.job_id);
      assert.ok(usageRow, "recognized native counters are durably retained despite unsupported width");
      const safeUsage = JSON.parse(usageRow.usage_json);
      assert.equal(safeUsage.completeness, "unknown");
      assert.equal(safeUsage.input_tokens, 12);
      assert.equal(safeUsage.output_tokens, 8);
      assert.equal(safeUsage.total_tokens, 20);
      assert.doesNotMatch(JSON.stringify(safeUsage), /extension_/);
      assert.deepEqual(safeUsage.input_tokens_details, { image_tokens: 10, text_tokens: 2 });
      assert.deepEqual(safeUsage.output_tokens_details, { image_tokens: 7, text_tokens: 1 });
      assert.ok(safeUsage.missing_fields.includes(width === "root"
        ? "usage.too_many_fields" : "usage.input_tokens_details.too_many_fields"),
      JSON.stringify(safeUsage.missing_fields));
      assert.doesNotMatch(JSON.stringify(result), new RegExp(requestId));
      assert.equal(context.counters.provider_posts, 1, "usage rejection never retries or redispatches the response");
    });
  }
});

test("wide native usage survives a transient writer failure, store reopen, and one reconciliation without redispatch", async (t) => {
  const context = await setup(t);
  const outputBytes = makePng({ width: 16, height: 16 });
  const rawUsage = { input_tokens: 12, output_tokens: 8, total_tokens: 20,
    input_tokens_details: { image_tokens: 10, text_tokens: 2 },
    output_tokens_details: { image_tokens: 7, text_tokens: 1 } };
  for (let extra = 0; extra < 33; extra += 1) rawUsage.input_tokens_details[`extension_${extra}`] = extra;
  const requestId = "req-private-wide-transient-usage";
  context.ports.provider = createNativeProvider({ store: context.store, referenceAssetBytes: context.referenceAssetBytes,
    fetchImpl: async () => {
      context.counters.provider_posts += 1;
      return new Response(JSON.stringify({ data: [{ b64_json: outputBytes.toString("base64") }], usage: rawUsage }),
        { status: 200, headers: { "content-type": "application/json", "x-request-id": requestId } });
    } });
  const originalJobs = context.ports.jobs;
  context.ports.jobs = { ...originalJobs,
    async recordPrivateProviderAttribution(input) {
      return { status: "unavailable", transport_attempt_id: input.transport_attempt_id,
        provider_request_ref: input.provider_request_ref };
    },
    async recordPrivateProviderUsageAttribution() { throw new Error("transient usage storage outage"); },
    async stagePrivateProviderAttribution(input) { return originalJobs.stagePrivateProviderAttribution(input); },
  };
  const plan = await jsonFixture("generate-plan");
  plan.base.brief_hash = canonicalHash(context.brief);
  plan.source_refs = [];
  plan.steps[0].source_refs = [];
  const request = apiRequest("image-wide-transient-action", "generate", plan, "page-1");
  request.source_refs = [];
  const result = await context.api.invoke(authorizedActor(), request);

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(context.counters.provider_posts, 1);
  assert.equal(context.counters.held, 1);
  assert.equal(context.counters.settlements, 0);
  assert.equal(context.store.listDesignVersions({ scope: SCOPE, brief_id: SCOPE.brief_id, limit: 10 }).items.length, 0);
  const job = context.store.db.prepare("SELECT job_id FROM creative_jobs WHERE action_id=?")
    .get("image-wide-transient-action");
  const pending = context.store.db.prepare("SELECT pending_ref,payload_json,payload_sha256 FROM private_provider_attribution_pending WHERE job_id=?")
    .get(job.job_id);
  assert.ok(pending, "the real store staged the unavailable private writes");
  assert.equal(canonicalHash(JSON.parse(pending.payload_json)), pending.payload_sha256);
  const staged = JSON.parse(pending.payload_json);
  assert.equal(staged.provider_request_id, requestId);
  assert.equal(staged.usage.input_tokens, 12);
  assert.equal(staged.usage.output_tokens, 8);
  assert.equal(staged.usage.total_tokens, 20);
  assert.equal(staged.usage.completeness, "unknown");
  assert.ok(staged.usage.missing_fields.includes("usage.input_tokens_details.too_many_fields"));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(requestId));

  const databasePath = context.store.databasePath;
  const objectRoot = context.store.objectRoot;
  context.store.close();
  const reopened = new CreativeVersionStore({ databasePath, objectRoot, now: () => NOW });
  t.after(() => reopened.close());
  assert.deepEqual(reopened.reconcilePrivateProviderAttributions({ scope: SCOPE, limit: 10 }),
    { reconciled: 1, remaining: 0 });
  const privateIdentity = reopened.db.prepare("SELECT provider_request_id,transport_attempt_id FROM private_provider_attributions WHERE job_id=?")
    .get(job.job_id);
  assert.equal(privateIdentity.provider_request_id, requestId);
  const privateUsage = reopened.db.prepare("SELECT usage_json FROM private_provider_usage_attributions WHERE job_id=?")
    .get(job.job_id);
  assert.ok(privateUsage);
  assert.equal(JSON.parse(privateUsage.usage_json).input_tokens_details.image_tokens, 10);
  assert.deepEqual(reopened.reconcilePrivateProviderAttributions({ scope: SCOPE, limit: 10 }),
    { reconciled: 0, remaining: 0 }, "reopen reconciliation is idempotent");
  assert.equal(context.counters.provider_posts, 1, "reconciliation does not call the provider again");
  assert.equal(reopened.db.prepare("SELECT COUNT(*) AS count FROM design_versions WHERE tenant_id=? AND project_id=? AND brief_id=?")
    .get(SCOPE.tenant_id, SCOPE.project_id, SCOPE.brief_id).count, 0, "failed unknown usage never publishes artwork");
});

test("runtime rejects a staged attribution ACK unless ref and hash bind the exact pending payload", async (t) => {
  const context = await setup(t);
  const outputBytes = makePng({ width: 16, height: 16 });
  const requestId = "req-private-stale-pending-ack";
  context.ports.provider = createNativeProvider({ store: context.store, referenceAssetBytes: context.referenceAssetBytes,
    fetchImpl: async () => {
      context.counters.provider_posts += 1;
      return new Response(JSON.stringify({ data: [{ b64_json: outputBytes.toString("base64") }],
        usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } }),
      { status: 200, headers: { "content-type": "application/json", "x-request-id": requestId } });
    } });
  const originalJobs = context.ports.jobs;
  context.ports.jobs = { ...originalJobs,
    async recordPrivateProviderAttribution(input) {
      return { status: "unavailable", transport_attempt_id: input.transport_attempt_id,
        provider_request_ref: input.provider_request_ref };
    },
    async recordPrivateProviderUsageAttribution() { throw new Error("transient usage storage outage"); },
    async stagePrivateProviderAttribution(input) {
      return { status: "staged", transport_attempt_id: input.transport_attempt_id,
        pending_ref: `private-attribution:${"f".repeat(64)}`, payload_sha256: `sha256:${"e".repeat(64)}` };
    },
  };
  const plan = await jsonFixture("generate-plan");
  plan.base.brief_hash = canonicalHash(context.brief);
  plan.source_refs = [];
  plan.steps[0].source_refs = [];
  const request = apiRequest("image-stale-pending-ack-action", "generate", plan, "page-1");
  request.source_refs = [];
  const result = await context.api.invoke(authorizedActor(), request);

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(context.counters.provider_posts, 1);
  assert.equal(context.counters.held, 1);
  assert.equal(context.counters.settlements, 0);
  assert.equal(context.store.listDesignVersions({ scope: SCOPE, brief_id: SCOPE.brief_id, limit: 10 }).items.length, 0);
  const job = context.store.db.prepare("SELECT job_id FROM creative_jobs WHERE action_id=?")
    .get("image-stale-pending-ack-action");
  for (const table of ["private_provider_attributions", "private_provider_usage_attributions",
    "private_provider_attribution_pending"]) {
    assert.equal(context.store.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE job_id=?`).get(job.job_id).count, 0,
      `${table} did not persist a row for the stale ACK`);
  }
  assert.equal(context.counters.usage_observations.length, 1);
  assert.ok(context.counters.usage_observations[0].missing_fields.includes("private_attribution_unavailable"));
  assert.ok(!context.counters.usage_observations[0].missing_fields.includes("private_attribution_pending_reconciliation"));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(requestId));
});

test("actual API refreshes current job and asset authority after native post-ack awaits and before POST", async (t) => {
  for (const kind of ["cancelled", "asset_revoked", "lease_expired"]) await t.test(kind, async (subtest) => {
    const context = await setup(subtest);
    const authority = authorityPorts();
    const actionId = `image-${kind}-during-native-revalidate`;
    let cancelResult;
    const outputBytes = makePng({ width: 16, height: 16 });
    const provider = createNativeProvider({ store: context.store, referenceAssetBytes: context.referenceAssetBytes,
      authorityOverrides: { capabilityPort: {
        verify: authority.capabilityPort.verify,
        async revalidate(input) {
          const result = await authority.capabilityPort.revalidate(input);
          if (input.phase === "post_transport_ack") {
            const job = context.store.db.prepare("SELECT job_id FROM creative_jobs WHERE action_id=?").get(actionId);
            assert.ok(job);
            if (kind === "cancelled") {
              cancelResult = await context.api.invoke(authorizedActor(),
                cancelRequest(`cancel-after-native-capability-${kind}`, job.job_id));
            } else if (kind === "asset_revoked") {
              context.revokeAssetPermission();
            } else {
              context.store.db.prepare("UPDATE creative_jobs SET lease_expires_at=? WHERE job_id=?")
                .run(new Date(NOW - 1).toISOString(), job.job_id);
            }
          }
          return result;
        },
      } },
      fetchImpl: async () => {
        context.counters.provider_posts += 1;
        return new Response(JSON.stringify({ data: [{ b64_json: outputBytes.toString("base64") }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }),
        { status: 200, headers: { "content-type": "application/json", "x-request-id": "req-never-posted" } });
      } });
    context.ports.provider = provider;
    const plan = await jsonFixture("generate-plan");
    plan.base.brief_hash = canonicalHash(context.brief);
    // Bind an actual research asset permission so the post-ack revocation
    // case exercises the same verifier used by production dispatch.
    plan.source_refs = ["page-1"];
    plan.steps[0].source_refs = ["page-1"];
    const request = apiRequest(actionId, "generate", plan, "page-1");
    const result = await context.api.invoke(authorizedActor(), request);
    assert.equal(result.ok, false, JSON.stringify(result));
    if (kind === "cancelled") {
      assert.equal(cancelResult.ok, true);
      assert.equal(context.store.db.prepare("SELECT status FROM creative_jobs WHERE action_id=?").get(actionId).status, "cancelled");
    } else if (kind === "asset_revoked") {
      assert.equal(context.store.db.prepare("SELECT status FROM creative_jobs WHERE action_id=?").get(actionId).status, "failed");
    } else {
      assert.equal(result.error.code, "cancelled");
      assert.equal(context.store.db.prepare("SELECT status FROM creative_jobs WHERE action_id=?").get(actionId).status, "failed");
    }
    assert.equal(context.counters.provider_posts, 0, `${kind} during post-ack capability I/O prevents POST`);
    assert.equal(context.counters.settlements, 0);
    assert.equal(context.counters.held, 1);
    assert.equal(context.store.listDesignVersions({ scope: SCOPE, brief_id: SCOPE.brief_id, limit: 10 }).items.length, 0);
  });
});

test("actual native direct generation has no image inputs and refuses an unsafe reference-manifest extension before reservation", async (t) => {
  const context = await setup(t);
  const outputBytes = makePng({ width: 16, height: 16 });
  let generationBody;
  const provider = createNativeProvider({ store: context.store, referenceAssetBytes: context.referenceAssetBytes,
    fetchImpl: async (url, init) => {
      context.counters.provider_posts += 1;
      assert.equal(String(url), "https://api.openai.com/v1/images/generations");
      generationBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ data: [{ b64_json: outputBytes.toString("base64") }],
        usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } }),
      { status: 200, headers: { "content-type": "application/json", "x-request-id": "req-private-image-generate-01" } });
    } });
  context.ports.provider = provider;
  const plan = await jsonFixture("generate-plan");
  plan.base.brief_hash = canonicalHash(context.brief);
  plan.source_refs = [];
  plan.steps[0].source_refs = [];
  const request = apiRequest("image-generate-action", "generate", plan, "page-1");
  request.source_refs = [];
  const result = await context.api.invoke(authorizedActor(), request);
  assert.equal(context.counters.provider_posts, 1);
  assert.equal(generationBody.model, MODEL);
  assert.equal(generationBody.n, 1);
  assert.equal(Object.hasOwn(generationBody, "image"), false);
  assert.equal(Object.hasOwn(generationBody, "images"), false);
  assert.equal(result.ok, false, "the candidate has no reviewed GPT Image 2.5 usage mapping, so C03 retains the hold");
  assert.equal(context.counters.held, 1);
  assert.equal(context.store.listDesignVersions({ scope: SCOPE, brief_id: SCOPE.brief_id, limit: 10 }).items.length, 0);

  const unsafe = structuredClone(request);
  unsafe.action_id = "generation-with-edit-reference";
  unsafe.payload.image_reference_manifest = { contract: "CreativeImageReferenceManifest" };
  const beforeReservations = context.counters.reserves;
  const blocked = await context.api.invoke(authorizedActor(), unsafe);
  assert.equal(blocked.ok, false);
  assert.equal(context.counters.provider_posts, 1, "generation never sends edit-only image[] references");
  assert.equal(context.counters.reserves, beforeReservations, "unsupported generation inputs reject before C03 reservation");
});

test("only an injected exact attempt and target bound MOCK usage map can settle and publish native image bytes", async (t) => {
  const context = await setup(t);
  const outputBytes = makePng({ width: 16, height: 16 });
  context.ports.telemetry = {
    ...context.ports.telemetry,
    usage_profile_authority: mockOwnerUsageProfileAuthority(),
  };
  const provider = createNativeProvider({ store: context.store, referenceAssetBytes: context.referenceAssetBytes,
    fetchImpl: async (url, init) => {
      context.counters.provider_posts += 1;
      assert.equal(String(url), "https://api.openai.com/v1/images/generations");
      assert.equal(init.method, "POST");
      return new Response(JSON.stringify({ data: [{ b64_json: outputBytes.toString("base64") }],
        usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20,
          input_tokens_details: { image_tokens: 10, text_tokens: 2 },
          output_tokens_details: { image_tokens: 7, text_tokens: 1 } } }),
      { status: 200, headers: { "content-type": "application/json", "x-request-id": "req-private-image-mock-profile" } });
    } });
  context.ports.provider = provider;
  const plan = await jsonFixture("generate-plan");
  plan.base.brief_hash = canonicalHash(context.brief);
  plan.source_refs = ["page-1"];
  plan.steps[0].source_refs = ["page-1"];
  const result = await context.api.invoke(authorizedActor(), apiRequest("image-mapped-action", "generate", plan, "page-1"));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(context.counters.provider_posts, 1);
  assert.equal(context.counters.settlements, 1);
  assert.equal(context.counters.held, 0);
  assert.equal(result.result.design_version.artifact.content_hash, hash(outputBytes));
  const versions = context.store.listDesignVersions({ scope: SCOPE, brief_id: SCOPE.brief_id, limit: 10 }).items;
  assert.equal(versions.length, 1);
  assert.deepEqual(Buffer.from(await context.store.getArtifactBytes({ scope: SCOPE, brief_id: SCOPE.brief_id,
    design_version_id: result.result.design_version.design_version_id })), outputBytes,
  "published immutable version retains the exact decoded native bytes");
  const observationRows = context.store.db.prepare(`SELECT payload_json FROM creative_telemetry_observations_v1
    WHERE logical_operation_id='image-mapped-action'`).all();
  assert.equal(observationRows.length, 1);
  const observation = JSON.parse(observationRows[0].payload_json).observation;
  assert.equal(observation.completeness, "complete");
  assert.equal(observation.usage_units.find((unit) => unit.name === "total_tokens").quantity, "20");
  assert.equal(observation.usage_units.find((unit) => unit.name === "input_tokens_details.image_tokens").included_in, "input_tokens");
  assert.equal(observation.usage_units.find((unit) => unit.name === "output_tokens_details.image_tokens").included_in, "output_tokens");
  assert.doesNotMatch(JSON.stringify(result), /req-private-image-mock-profile/);
  const rawUsageRow = context.store.db.prepare(`SELECT usage_json FROM private_provider_usage_attributions
    WHERE action_id='image-mapped-action'`).get();
  assert.ok(rawUsageRow, "the mapped MOCK observation did not replace private raw provider attribution");
  assert.deepEqual(JSON.parse(rawUsageRow.usage_json).missing_fields, ["usage.profile_mapping_pending"]);
  assert.doesNotMatch(rawUsageRow.usage_json, /req-private-image-mock-profile/);
  const databasePath = context.store.databasePath;
  const objectRoot = context.store.objectRoot;
  context.store.close();
  const reopened = new (context.store.constructor)({ databasePath, objectRoot, now: () => NOW });
  t.after(() => reopened.close());
  const reopenedBytes = await reopened.getArtifactBytes({ scope: SCOPE, brief_id: SCOPE.brief_id,
    design_version_id: result.result.design_version.design_version_id });
  assert.deepEqual(Buffer.from(reopenedBytes), outputBytes,
    "the exact successful native bytes and immutable design version survive store reopen");
  const reopenedUsage = reopened.db.prepare(`SELECT usage_sha256,usage_json FROM private_provider_usage_attributions
    WHERE action_id='image-mapped-action'`).get();
  assert.ok(reopenedUsage);
  assert.equal(canonicalHash(JSON.parse(reopenedUsage.usage_json)), reopenedUsage.usage_sha256);
});

test("settled native edit mapping metadata matches persisted result and exact completed replay", async (t) => {
  const context = await setup(t);
  const seedPlan = await jsonFixture("generate-plan");
  seedPlan.base.brief_hash = canonicalHash(context.brief);
  seedPlan.source_refs = ["page-1"];
  seedPlan.steps[0].source_refs = ["page-1"];
  const seed = await context.api.invoke(authorizedActor(), apiRequest("image-mapped-edit-parent", "generate", seedPlan, "page-1"));
  assert.equal(seed.ok, true, JSON.stringify(seed));
  assert.equal(context.counters.settlements, 1);

  const outputBytes = makePng({ width: 16, height: 16 });
  context.ports.telemetry = { ...context.ports.telemetry,
    usage_profile_authority: mockOwnerUsageProfileAuthority() };
  let postedFiles;
  context.ports.provider = createNativeProvider({ store: context.store, referenceAssetBytes: context.referenceAssetBytes,
    fetchImpl: async (url, init) => {
      context.counters.provider_posts += 1;
      assert.equal(String(url), "https://api.openai.com/v1/images/edits");
      postedFiles = init.body.getAll("image[]");
      return new Response(JSON.stringify({ data: [{ b64_json: outputBytes.toString("base64") }],
        usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30,
          input_tokens_details: { image_tokens: 18, text_tokens: 2 },
          output_tokens_details: { image_tokens: 9, text_tokens: 1 } } }),
      { status: 200, headers: { "content-type": "application/json", "x-request-id": "req-private-mapped-edit-replay" } });
    } });
  const editPlan = await jsonFixture("edit-plan");
  editPlan.base.brief_hash = canonicalHash(context.brief);
  editPlan.base.design_hash = seed.result.design_version.design_hash;
  editPlan.base.design_version_id = seed.result.design_version.design_version_id;
  editPlan.source_refs = ["page-2"];
  editPlan.steps[0].source_refs = ["page-2"];
  editPlan.steps[0].parameters.design_version_id = seed.result.design_version.design_version_id;
  editPlan.steps[0].parameters.artifact_id = seed.result.design_version.artifact.artifact_id;
  editPlan.expected_result.parent_version_id = seed.result.design_version.design_version_id;
  const manifest = { contract: "CreativeImageReferenceManifest", schema_version: "1.0",
    tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id, brief_id: SCOPE.brief_id,
    brief_hash: canonicalHash(context.brief), research_package_id: context.research.package_id,
    research_package_hash: canonicalHash(context.research),
    base_design_version_id: seed.result.design_version.design_version_id,
    base_design_hash: seed.result.design_version.design_hash,
    references: [{ source_ref: "page-2", asset_id: "asset-2", content_hash: hash(context.referenceBytes),
      media_type: "image/png", width: 16, height: 16 }] };
  const request = apiRequest("image-mapped-edit-replay", "edit", editPlan, "page-2", {
    design_version_id: seed.result.design_version.design_version_id, image_reference_manifest: manifest,
  });
  const result = await context.api.invoke(authorizedActor(), request);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(context.counters.provider_posts, 1);
  assert.equal(context.counters.settlements, 2);
  assert.equal(result.result.usage.completeness, "complete");
  assert.equal(result.result.design_version.usage_status, "complete");
  assert.equal(postedFiles.length, 2);
  assert.deepEqual(Buffer.from(await postedFiles[0].arrayBuffer()), context.counters.seed_bytes ??
    Buffer.from(await context.store.getArtifactBytes({ scope: SCOPE, brief_id: SCOPE.brief_id,
      design_version_id: seed.result.design_version.design_version_id })));
  assert.deepEqual(Buffer.from(await postedFiles[1].arrayBuffer()), context.referenceBytes);
  assert.doesNotMatch(JSON.stringify(result), /req-private-mapped-edit-replay|mock-owner-profile/);

  const storedJob = context.store.db.prepare("SELECT result_json FROM creative_jobs WHERE action_id=?")
    .get("image-mapped-edit-replay");
  const storedResult = JSON.parse(storedJob.result_json);
  assert.equal(storedResult.usage.completeness, "complete");
  assert.equal(storedResult.design.usage_status, "complete");
  assert.equal(storedResult.usage_evidence.status, "settled_owner_mapping");
  assert.equal(storedResult.usage_evidence.billable_attempt_id, storedResult.design.billable_attempt_id);
  assert.equal(storedResult.usage_evidence.provider_name, "openai");
  assert.equal(storedResult.usage_evidence.model, MODEL);
  assert.match(storedResult.usage_evidence.observation_sha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(storedResult.usage_evidence.source_observation_id,
    context.counters.usage_observations.at(-1).source_observation_id);
  assert.equal(storedResult.usage_evidence.observation_sha256,
    canonicalHash(context.counters.usage_observations.at(-1)),
  "stored settled evidence hashes the exact C03 observation, not the raw candidate counters");
  const privateUsage = JSON.parse(context.store.db.prepare(`SELECT usage_json FROM private_provider_usage_attributions
    WHERE action_id='image-mapped-edit-replay'`).get().usage_json);
  assert.equal(storedResult.usage_evidence.raw_usage_sha256, canonicalHash(privateUsage));
  assert.deepEqual(privateUsage.missing_fields, ["usage.profile_mapping_pending"],
    "the raw provider record remains unknown even though the separate MOCK mapping was settled");

  const beforeReplay = { posts: context.counters.provider_posts, reserves: context.counters.reserves,
    settlements: context.counters.settlements };
  const replay = await context.api.invoke(authorizedActor(), request);
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.equal(replay.replayed, true);
  assert.equal(replay.result.design_version.design_version_id, result.result.design_version.design_version_id);
  assert.deepEqual({ posts: context.counters.provider_posts, reserves: context.counters.reserves,
    settlements: context.counters.settlements }, beforeReplay,
  "historical owner-mapped result replay performs no extra POST, reservation, or settlement");
});

test("malformed or misbound usage-profile results retain the hold and never publish native bytes", async (t) => {
  const cases = [
    ["wrong raw usage hash", (result) => ({ ...result, raw_usage_sha256: hash("other raw usage") })],
    ["wrong target binding", (result) => ({ ...result, target_binding_sha256: hash("other target") })],
    ["wrong attempt binding", (result) => ({ ...result, attempt_binding_sha256: hash("other attempt") })],
    ["wrong provider identity", (result) => ({ ...result, observation: { ...result.observation, provider_name: "other-provider" } })],
    ["wrong transport identity", (result) => ({ ...result, observation: {
      ...result.observation, transport_attempt_id: "transport-for-another-attempt",
    } })],
    ["malformed usage quantity", (result) => ({ ...result, observation: { ...result.observation,
      usage_units: result.observation.usage_units.map((unit, index) => index === 0 ? { ...unit, quantity: "-1" } : unit),
    } })],
    ["incomplete mapping", (result) => ({ ...result, observation: { ...result.observation,
      completeness: "partial", missing_fields: ["usage.unmapped_provider_dimension"],
    } })],
    ["throwing mapper", (_result) => { throw new Error("Bearer private mapper failure marker"); }],
    ["throwing result getter", (result) => Object.defineProperty(result, "observation", {
      enumerable: true, get() { throw new Error("Bearer private mapper getter marker"); },
    })],
    ["malformed profile hash", (result) => ({ ...result, profile_sha256: "not-a-pinned-hash" })],
  ];

  for (const [caseIndex, [label, transformResult]] of cases.entries()) {
    await t.test(label, async (subtest) => {
      const context = await setup(subtest);
      const outputBytes = makePng({ width: 16, height: 16 });
      context.ports.telemetry = { ...context.ports.telemetry,
        usage_profile_authority: mockOwnerUsageProfileAuthority({ transformResult }) };
      context.ports.provider = createNativeProvider({ store: context.store, referenceAssetBytes: context.referenceAssetBytes,
        fetchImpl: async () => {
          context.counters.provider_posts += 1;
          return new Response(JSON.stringify({ data: [{ b64_json: outputBytes.toString("base64") }],
            usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20,
              input_tokens_details: { image_tokens: 10, text_tokens: 2 },
              output_tokens_details: { image_tokens: 7, text_tokens: 1 } } }),
          { status: 200, headers: { "content-type": "application/json", "x-request-id": "req-private-mapper-probe" } });
        } });
      const plan = await jsonFixture("generate-plan");
      plan.base.brief_hash = canonicalHash(context.brief);
      plan.source_refs = ["page-1"];
      plan.steps[0].source_refs = ["page-1"];
      const result = await context.api.invoke(authorizedActor(), apiRequest(`mapper-${caseIndex}`, "generate", plan, "page-1"));

      assert.equal(result.ok, false, JSON.stringify(result));
      assert.equal(context.counters.provider_posts, 1);
      assert.equal(context.counters.settlements, 0, "an unverified or incomplete mapping cannot settle the reservation");
      assert.equal(context.counters.held, 1);
      assert.equal(context.store.listDesignVersions({ scope: SCOPE, brief_id: SCOPE.brief_id, limit: 10 }).items.length, 0,
        "provider bytes remain unpublished when the mapping cannot be bound and validated");
      assert.doesNotMatch(JSON.stringify(result), /req-private-mapper-probe|input_tokens|total_tokens|Bearer private mapper/);
      const privateUsage = context.store.db.prepare(`SELECT usage_json FROM private_provider_usage_attributions
        WHERE action_id LIKE 'mapper-%'`).get();
      assert.ok(privateUsage, "observed native counters remain available in the restricted attribution table");
      assert.deepEqual(JSON.parse(privateUsage.usage_json).missing_fields, ["usage.profile_mapping_pending"]);
      assert.doesNotMatch(privateUsage.usage_json, /req-private-mapper-probe/);
    });
  }
});

test("cancellation, expired deadline, or revoked asset permission during async usage mapping retains the C03 hold", async (t) => {
  const cases = ["cancelled", "deadline_elapsed", "asset_permission_revoked"];
  for (const [index, kind] of cases.entries()) {
    await t.test(kind, async (subtest) => {
      const context = await setup(subtest);
      const outputBytes = makePng({ width: 16, height: 16 });
      const actionId = `image-map-late-${index}`;
      let entered;
      const mapEntered = new Promise((resolve) => { entered = resolve; });
      let release;
      const waitForRelease = new Promise((resolve) => { release = resolve; });
      context.ports.telemetry = { ...context.ports.telemetry,
        usage_profile_authority: mockOwnerUsageProfileAuthority({ beforeMap: async () => {
          entered();
          await waitForRelease;
        } }) };
      context.ports.provider = createNativeProvider({ store: context.store, referenceAssetBytes: context.referenceAssetBytes,
        fetchImpl: async () => {
          context.counters.provider_posts += 1;
          return new Response(JSON.stringify({ data: [{ b64_json: outputBytes.toString("base64") }],
            usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20,
              input_tokens_details: { image_tokens: 10, text_tokens: 2 },
              output_tokens_details: { image_tokens: 7, text_tokens: 1 } } }),
          { status: 200, headers: { "content-type": "application/json", "x-request-id": "req-private-late-map" } });
        } });
      const plan = await jsonFixture("generate-plan");
      plan.base.brief_hash = canonicalHash(context.brief);
      plan.source_refs = ["page-1"];
      plan.steps[0].source_refs = ["page-1"];
      const generation = context.api.invoke(authorizedActor(), apiRequest(actionId, "generate", plan, "page-1"));
      await mapEntered;
      const job = context.store.db.prepare("SELECT job_id FROM creative_jobs WHERE action_id=?").get(actionId);
      assert.ok(job?.job_id, "job is active while the trusted mapper is paused");
      if (kind === "cancelled") {
        const cancelled = await context.api.invoke(authorizedActor(), cancelRequest(`cancel-${actionId}`, job.job_id));
        assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
        assert.equal(cancelled.job.status, "cancelled");
      } else if (kind === "deadline_elapsed") {
        context.advanceClock(30_001);
      } else {
        context.revokeAssetPermission();
      }
      release();
      const result = await generation;
      assert.equal(result.ok, false, JSON.stringify(result));
      assert.equal(context.counters.provider_posts, 1);
      assert.equal(context.counters.settlements, 0, "late mapping cannot settle after its authorization fence closes");
      assert.equal(context.counters.held, 1);
      assert.equal(context.store.listDesignVersions({ scope: SCOPE, brief_id: SCOPE.brief_id, limit: 10 }).items.length, 0);
      assert.doesNotMatch(JSON.stringify(result), /req-private-late-map|input_tokens|total_tokens/);
      assert.equal(context.counters.usage_observations.length, 1,
        "C03 receives the observed usage even though the dispatch fence no longer permits settlement");
      const lateObservation = context.counters.usage_observations[0];
      assert.equal(lateObservation.completeness, "partial");
      assert.ok(lateObservation.missing_fields.includes("usage.dispatch_authorization_not_current"));
      assert.ok(lateObservation.usage_units.some((unit) => unit.name === "total_tokens" && unit.quantity === "20"),
        "known token counts remain available for reconciliation without authorizing settlement");
      const rawUsage = context.store.db.prepare("SELECT usage_json FROM private_provider_usage_attributions WHERE action_id=?").get(actionId);
      assert.ok(rawUsage, "known native counters stay in the restricted attribution record for reconciliation");
      assert.deepEqual(JSON.parse(rawUsage.usage_json).missing_fields, ["usage.profile_mapping_pending"]);
    });
  }
});
