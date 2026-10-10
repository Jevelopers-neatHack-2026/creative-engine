import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalHash, computeDesignVersionHash, ContractError } from "../../src/contracts/index.mjs";
import { ApprovalHandoffContractError, createConsumptionReceipt, hashCompositionLayerManifest } from "../../src/contracts/approval-handoff.mjs";
import { FakeMeteringAuthority } from "../../fixtures/contracts/metering/fake-authority.mjs";
import { MeteringContractError } from "../../src/contracts/metering.mjs";
import { CreativeApiError, createCreativeApi } from "../../src/api/v1.mjs";

const FIXTURE = async (name) => JSON.parse(await readFile(new URL(`../../fixtures/api/${name}.json`, import.meta.url), "utf8"));
const NOW = Date.parse("2026-10-10T12:30:00.000Z");
const PERMISSIONS = [
  "creative.generate", "creative.edit", "creative.read", "creative.restore",
  "creative.cancel", "creative.handoff",
];

let requestNumber = 0;
function request(operation, payload, action_id) {
  requestNumber += 1;
  return {
    contract: "CreativeApiRequest",
    schema_version: "1.0",
    event_id: `event-${requestNumber}`,
    request_id: `request-${requestNumber}`,
    tenant_id: "tenant-api-1",
    project_id: "project-api-1",
    correlation_id: `correlation-${requestNumber}`,
    producer: "creative-api-tests",
    occurred_at: "2026-10-10T12:20:00.000Z",
    ingested_at: "2026-10-10T12:20:00.000Z",
    environment: "test",
    billing_mode: "simulated",
    source_refs: ["source-api-1"],
    operation,
    ...(action_id ? { action_id } : {}),
    payload,
  };
}

function actor(overrides = {}) {
  return {
    actor_id: "actor-api-1",
    tenant_id: "tenant-api-1",
    project_id: "project-api-1",
    expires_at: "2026-10-11T00:00:00.000Z",
    permissions: [...PERMISSIONS],
    budget_scope_id: "budget-api-1",
    budget_policy_version: "budget-policy/1",
    ...overrides,
  };
}

function versionFrom(base, patch = {}) {
  const artifactBytes = base.artifact_bytes;
  const canonicalBase = { ...base };
  delete canonicalBase.artifact_bytes;
  const next = { ...canonicalBase, ...patch, design_hash: undefined };
  delete next.design_hash;
  return { ...next, design_hash: computeDesignVersionHash(next),
    ...(artifactBytes instanceof Uint8Array ? { artifact_bytes: artifactBytes } : {}) };
}

function sortedVersions(values) {
  return [...values].sort((a, b) => b.occurred_at.localeCompare(a.occurred_at) || a.design_version_id.localeCompare(b.design_version_id));
}

function memoryTelemetryOutbox() {
  const events = new Map();
  const observations = new Map();
  return Object.freeze({
    events,
    observations,
    async append(event) {
      const previous = events.get(event.event_id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(event)) throw new Error("event identity conflict");
      events.set(event.event_id, structuredClone(event));
      return { status: previous ? "duplicate" : "recorded", event_id: event.event_id };
    },
    async enqueueUsageObservation({ observation }) {
      const key = observation.source_observation_id;
      const previous = observations.get(key);
      if (previous && JSON.stringify(previous.observation) !== JSON.stringify(observation)) throw new Error("observation identity conflict");
      const record_ref = previous?.record_ref ?? `usage-record:${key}`;
      observations.set(key, { record_ref, observation: structuredClone(observation), status: "pending" });
      return { status: previous ? "duplicate" : "recorded", record_ref, source_observation_id: key, payload_hash: "sha256:test" };
    },
    async acknowledgeEnqueuedObservation({ record_ref, source_observation_id, effective_billable_attempt_id, authority_status }) {
      const record = observations.get(source_observation_id);
      if (!record || record.record_ref !== record_ref || record.observation.billable_attempt_id !== effective_billable_attempt_id) {
        return { status: "mismatch", source_observation_id };
      }
      record.status = "delivered";
      record.authority_status = authority_status;
      return { status: "acknowledged", source_observation_id };
    },
  });
}

function afterCursor(item, cursor) {
  return item.occurred_at < cursor.occurred_at ||
    (item.occurred_at === cursor.occurred_at && item.design_version_id > cursor.design_version_id);
}

function makeHarness({ withDesign = true, providerImpl, omit = [], foreignDesign = false, longReservationId = false,
  beforeDispatchAuthorize, clock = { now: NOW } } = {}) {
  const brief = awaitableCloneBrief();
  const designs = new Map();
  const current = new Map();
  const selectionRevisions = new Map();
  const records = new Map();
  const actions = new Map();
  const cancelActions = new Map();
  const handoffContexts = new Map();
  const stateArtifactBytes = new Map();
  const leaseTokens = new Map();
  const dispatchIntents = [];
  const calls = { storage: [], provider: 0, reserve: 0, usage: [], approval: 0, handoff: 0, cancel: 0, inspection: 0, decision: 0,
    providerReservationRefs: [], inspectionReservationRefs: [], decisionReservationRefs: [], traces: [] };
  let generated = 0;
  let jobCounter = 0;
  let idCounter = 0;
  let dispatchIntentCounter = 0;
  const lockQueues = new Map();

  function withLock(key, work) {
    const prior = lockQueues.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const queued = prior.then(() => gate);
    lockQueues.set(key, queued);
    return prior.then(work).finally(() => {
      release();
      if (lockQueues.get(key) === queued) lockQueues.delete(key);
    });
  }

  function jobKey(scope, actorId, actionId) {
    return `${scope.tenant_id}/${scope.project_id}/${actorId}/${actionId}`;
  }

  function contextFenceMatches(fence) {
    if (!fence || fence.brief_id !== brief.brief_id || fence.brief_hash !== canonicalHash(brief)) return false;
    if (fence.design_version_id !== undefined) {
      const design = designs.get(fence.design_version_id);
      if (!design || design.design_hash !== fence.design_hash) return false;
    }
    if (Object.hasOwn(fence, "expected_current_design_version_id")) {
      const selectedId = current.get(fence.brief_id) ?? null;
      if (selectedId !== fence.expected_current_design_version_id) return false;
      const selected = selectedId === null ? null : designs.get(selectedId);
      if ((selected?.design_hash ?? null) !== (fence.expected_current_design_hash ?? null)) return false;
    }
    return true;
  }

  const jobs = {
    begin(input) {
      const key = jobKey(input.scope, input.actor_id, input.action_id);
      const old = actions.get(key);
      if (old) {
        const job = records.get(old);
        return job.request_hash === input.request_hash ? { kind: "existing", job } : { kind: "conflict" };
      }
      jobCounter += 1;
      const job = {
        tenant_id: input.scope.tenant_id,
        project_id: input.scope.project_id,
        ...(input.scope.brief_id ? { brief_id: input.scope.brief_id } : {}),
        actor_id: input.actor_id,
        action_id: input.action_id,
        operation: input.operation,
        job_id: `job-api-${jobCounter}`,
        status: "running",
        request_hash: input.request_hash,
      };
      records.set(job.job_id, job);
      actions.set(key, job.job_id);
      const lease_token = `lease-${job.job_id}`;
      leaseTokens.set(job.job_id, lease_token);
      return { kind: "started", job_id: job.job_id, lease_token };
    },
    async authorizeDispatch(input) {
      return withLock(input.job_id, async () => {
        const job = records.get(input.job_id);
        if (!job || job.tenant_id !== input.scope.tenant_id || job.project_id !== input.scope.project_id ||
          job.actor_id !== input.actor_id || job.action_id !== input.action_id || job.operation !== input.operation ||
          leaseTokens.get(input.job_id) !== input.lease_token) return { status: "lease_lost" };
        if (job.status === "cancelled") return { status: "cancelled" };
        if (job.status !== "running") return { status: "lease_lost" };
        if (beforeDispatchAuthorize) await beforeDispatchAuthorize(input);
        if (!contextFenceMatches(input.context_fence)) return { status: "stale_context" };
        dispatchIntentCounter += 1;
        const dispatch_intent_ref = `dispatch-intent:${input.job_id}:${dispatchIntentCounter}`;
        dispatchIntents.push({ job_id: input.job_id, transport_attempt_id: input.transport_attempt_id,
          billable_attempt_id: input.billable_attempt_id, context_fence: structuredClone(input.context_fence), dispatch_intent_ref });
        return { status: "authorized", dispatch_intent_ref };
      });
    },
    async completeIfActive(input, publish) {
      return withLock(input.job_id, async () => {
        const job = records.get(input.job_id);
        if (!job || job.tenant_id !== input.scope.tenant_id || job.project_id !== input.scope.project_id ||
          job.actor_id !== input.actor_id || input.lease_token !== leaseTokens.get(input.job_id)) return { status: "cancelled" };
        if (job.status === "cancelled") return { status: "cancelled", job };
        if (job.status === "completed") return { status: "completed", job, result: job.result };
        if (!contextFenceMatches(input.publication_fence)) return { status: "stale_context", job };
        const publishResult = await publish();
        job.status = "completed";
        job.result = input.result;
        job.publish_result = publishResult;
        return { status: "completed", job, result: input.result };
      });
    },
    async failIfActive(input) {
      return withLock(input.job_id, async () => {
        const job = records.get(input.job_id);
        if (!job || job.tenant_id !== input.scope.tenant_id || job.project_id !== input.scope.project_id ||
          job.actor_id !== input.actor_id || input.lease_token !== leaseTokens.get(input.job_id)) return { status: "cancelled", job };
        if (job.status === "cancelled") return { status: "cancelled", job };
        if (job.status !== "running") return { status: "cancelled", job };
        job.status = "failed";
        job.error = input.error;
        return { status: "failed", job };
      });
    },
    get(input) {
      const job = records.get(input.job_id);
      if (!job || job.tenant_id !== input.scope.tenant_id || job.project_id !== input.scope.project_id) return null;
      return job;
    },
    async cancel(input) {
      calls.cancel += 1;
      return withLock(input.job_id, async () => {
        const cancellationKey = jobKey(input.scope, input.actor_id, input.action_id);
        const previous = cancelActions.get(cancellationKey);
        if (previous) {
          if (previous.request_hash !== input.request_hash || previous.target_action_id !== input.target_action_id) return { kind: "conflict" };
          const existing = records.get(previous.job_id);
          return existing ? { kind: "replayed", job: existing } : { kind: "not_found" };
        }
        const job = records.get(input.job_id);
        if (!job || job.tenant_id !== input.scope.tenant_id || job.project_id !== input.scope.project_id ||
          job.action_id !== input.target_action_id) return { kind: "not_found" };
        if (job.status === "running" || job.status === "queued") job.status = "cancelled";
        cancelActions.set(cancellationKey, { request_hash: input.request_hash, target_action_id: input.target_action_id, job_id: job.job_id });
        return { kind: "cancelled", job };
      });
    },
  };

  const storage = {
    getBrief(input) {
      calls.storage.push({ method: "getBrief", scope: input.scope });
      if (input.scope.tenant_id !== brief.tenant_id || input.scope.project_id !== brief.project_id || input.brief_id !== brief.brief_id) return null;
      return structuredClone(brief);
    },
    getDesignVersion(input) {
      calls.storage.push({ method: "getDesignVersion", scope: input.scope });
      if (foreignDesign) return { ...structuredClone(designs.get(input.design_version_id) ?? (withDesign ? initialDesign : {})), project_id: "foreign-project" };
      if (input.scope.tenant_id !== brief.tenant_id || input.scope.project_id !== brief.project_id) return null;
      const design = designs.get(input.design_version_id);
      if (!design || design.brief_id !== input.brief_id) return null;
      return structuredClone(design);
    },
    getCurrentDesignVersion(input) {
      calls.storage.push({ method: "getCurrentDesignVersion", scope: input.scope });
      const id = current.get(input.brief_id);
      return id ? structuredClone(designs.get(id)) : null;
    },
    getSelection(input) {
      calls.storage.push({ method: "getSelection", scope: input.scope });
      const id = current.get(input.brief_id);
      return id ? { tenant_id: brief.tenant_id, project_id: brief.project_id, brief_id: input.brief_id,
        design_version_id: id, revision: selectionRevisions.get(input.brief_id) ?? 0 } : null;
    },
    listDesignVersions(input) {
      calls.storage.push({ method: "listDesignVersions", scope: input.scope });
      let items = sortedVersions([...designs.values()].filter((item) => item.brief_id === input.brief_id));
      if (input.after) items = items.filter((item) => afterCursor(item, input.after));
      const has_more = items.length > input.limit;
      return { items: items.slice(0, input.limit), has_more };
    },
    saveDesignVersion(input) {
      calls.storage.push({ method: "saveDesignVersion", scope: input.scope });
      if (input.scope.tenant_id !== brief.tenant_id || input.scope.project_id !== brief.project_id) throw new Error("foreign scope");
      if (input.expected_brief_hash !== canonicalHash(brief)) return { status: "stale" };
      const currentId = current.get(input.brief_id) ?? null;
      if (input.selection_mode === "advance") {
        if (currentId !== input.expected_current_design_version_id) return { status: "stale" };
        const currentDesign = currentId === null ? null : designs.get(currentId);
        if ((currentDesign?.design_hash ?? null) !== input.expected_current_design_hash) return { status: "stale" };
      } else {
        const parent = input.expected_parent_design_version_id === null ? null : designs.get(input.expected_parent_design_version_id);
        if (!parent || parent.design_hash !== input.expected_parent_design_hash ||
          input.design_version.parent_version_id !== parent.design_version_id) return { status: "stale" };
      }
      designs.set(input.design_version.design_version_id, structuredClone(input.design_version));
      stateArtifactBytes.set(input.design_version.artifact.artifact_id, Uint8Array.from(input.artifact_bytes));
      if (input.selection_mode === "advance") {
        current.set(input.brief_id, input.design_version.design_version_id);
        selectionRevisions.set(input.brief_id, (selectionRevisions.get(input.brief_id) ?? 0) + 1);
      }
      return { status: "saved" };
    },
    selectDesignVersion(input) {
      calls.storage.push({ method: "selectDesignVersion", scope: input.scope });
      if (input.scope.tenant_id !== brief.tenant_id || input.scope.project_id !== brief.project_id) throw new Error("foreign scope");
      if (input.expected_brief_hash !== canonicalHash(brief)) return { status: "stale" };
      if (designs.get(input.design_version_id)?.design_hash !== input.expected_target_design_hash) return { status: "stale" };
      const revision = selectionRevisions.get(input.brief_id) ?? 0;
      if (revision !== input.expected_selection_revision) return { status: "stale" };
      const selectedId = current.get(input.brief_id);
      if (selectedId !== input.expected_selected_design_version_id ||
        designs.get(selectedId)?.design_hash !== input.expected_selected_design_hash) return { status: "stale" };
      current.set(input.brief_id, input.design_version_id);
      selectionRevisions.set(input.brief_id, revision + 1);
      return { status: "selected", selection: { tenant_id: brief.tenant_id, project_id: brief.project_id,
        brief_id: input.brief_id, design_version_id: input.design_version_id,
        design_hash: designs.get(input.design_version_id).design_hash, revision: revision + 1 } };
    },
    getBriefForDesign(input) {
      calls.storage.push({ method: "getBriefForDesign", scope: input.scope });
      const design = designs.get(input.design_version_id);
      if (!design || design.tenant_id !== input.scope.tenant_id || design.project_id !== input.scope.project_id) return null;
      return { tenant_id: design.tenant_id, project_id: design.project_id, brief_id: design.brief_id };
    },
    getHandoffContext(input) {
      calls.storage.push({ method: "getHandoffContext", scope: input.scope });
      const design = designs.get(input.design_version_id);
      if (!design || design.tenant_id !== input.scope.tenant_id || design.project_id !== input.scope.project_id) return null;
      const key = design.design_version_id;
      if (!handoffContexts.has(key)) {
        const bytes = stateArtifactBytes.get(design.artifact.artifact_id) ?? Buffer.from("fixture artwork bytes");
        const artworkHash = design.artifact.content_hash.replace(/^sha256:/, "");
        const artifact = { artifact_id: design.artifact.artifact_id, locator_ref: `artifact-locator:${design.artifact.artifact_id}`,
          sha256: artworkHash, mime_type: design.artifact.media_type, width_px: 640, height_px: 480, access_policy_ref: "access-policy-fixture-1" };
        const binding = {
          tenant_id: design.tenant_id, project_id: design.project_id,
          design_version: { design_version_id: design.design_version_id, artwork_sha256: artworkHash },
          brief: { brief_id: brief.brief_id, sha256: canonicalHash(brief).slice(7) },
          facts: { revision_id: "facts-revision-1", sha256: canonicalHash(brief.facts).slice(7) },
          assets: [],
          composition: { composition_id: `composition:${design.design_version_id}`, revision_id: "composition-revision-1", sha256: "0".repeat(64) },
          preview_sha256: createHash("sha256").update("fixture preview").digest("hex"),
        };
        const layer_manifest = [{ layer_id: "artwork-layer-1", kind: "artwork", artifact_id: artifact.artifact_id, sha256: artifact.sha256 }];
        binding.composition.sha256 = hashCompositionLayerManifest({ binding, artifact, layer_manifest, trustedScope: input.scope });
        handoffContexts.set(key, { binding, artifact, layer_manifest });
        if (!stateArtifactBytes.has(artifact.artifact_id)) stateArtifactBytes.set(artifact.artifact_id, bytes);
      }
      return structuredClone(handoffContexts.get(key));
    },
  };

  const imageRoute = { retry_mapping_ref: "retry:image-v1", provider: {
    name: "fixture-provider", model: "fixture-model", endpoint: "test:/image", sdk: { name: "fixture-sdk", version: "1.0" },
  } };
  const provider = {
    resolveRoute() { return structuredClone(imageRoute); },
    async generate(input) {
      calls.provider += 1;
      calls.providerReservationRefs.push(input.reservation_ref);
      await input.recordTransportAttempt(input.transport_attempt_id);
      return providerImpl ? fixtureProviderOutput(await providerImpl("generate", input)) : providerOutput();
    },
    async edit(input) {
      calls.provider += 1;
      calls.providerReservationRefs.push(input.reservation_ref);
      await input.recordTransportAttempt(input.transport_attempt_id);
      return providerImpl ? fixtureProviderOutput(await providerImpl("edit", input)) : providerOutput();
    },
  };

  function fixtureProviderOutput(value) {
    if (!value || !value.artifact || Object.hasOwn(value, "artifact_bytes")) return value;
    const bytes = Buffer.from(`fixture artifact bytes:${value.artifact.artifact_id}`);
    return { ...value, artifact: { ...value.artifact,
      content_hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}` }, artifact_bytes: bytes };
  }

  function providerOutput() {
    generated += 1;
    const artifactBytes = Buffer.from(`fixture artifact bytes:generated-${generated}`);
    return {
      design_version_id: `generated-design-${generated}`,
      artifact: {
        artifact_id: `generated-artifact-${generated}`,
        content_hash: `sha256:${createHash("sha256").update(artifactBytes).digest("hex")}`,
        media_type: "image/png",
      },
      artifact_bytes: artifactBytes,
      provider: "fixture-provider",
      model: "fixture-model",
      usage: { completeness: "complete", input_tokens: 12, output_tokens: 24 },
    };
  }

  const authority = new FakeMeteringAuthority({ budget: "100.00", defaultHold: "1.00", defaultConsumed: "0.10" });
  if (longReservationId) {
    const originalReserve = authority.reserveAttempt.bind(authority);
    authority.reserveAttempt = async (value) => {
      const response = await originalReserve(value);
      const oldId = response.reservation_id;
      const stored = authority.reservations.get(oldId);
      const longId = "r".repeat(256);
      authority.reservations.delete(oldId);
      stored.reservation_id = longId;
      authority.reservations.set(longId, stored);
      authority.byAttempt.set(value.billable_attempt_id, longId);
      response.reservation_id = longId;
      return response;
    };
  }
  const metering = {
    reserveAttempt(input) { calls.reserve += 1; return authority.reserveAttempt(input); },
    releaseBeforeDispatch: (input) => authority.releaseBeforeDispatch(input),
    markAttemptInFlight: (input) => authority.markAttemptInFlight(input),
    recordTransportAttempt: (input) => authority.recordTransportAttempt(input),
    recordUsageObservation(input) { calls.usage.push(input.observation); return authority.recordUsageObservation(input); },
    settleReservation: (input) => authority.settleReservation(input),
    markOutcomeUnknown: (input) => authority.markOutcomeUnknown(input),
  };
  const approval = {
    verifyApproval(input) {
      calls.approval += 1;
      return { status: "valid", verified_binding: structuredClone(input.expected_binding), approval: {
        approval_reference: input.approval_reference, approval_id: "approval-fixture-1", issuer_id: "issuer-fixture-1",
        audience: input.expected_audience, issued_at: "2026-10-10T12:00:00.000Z", expires_at: "2026-10-11T12:00:00.000Z",
        key_id: "key-fixture-1", key_set_version: "keys-fixture/1",
        revocation: { status: "active", checked_at: "2026-10-10T12:00:00.000Z", record_ref: "revocation-fixture-1" },
      } };
    },
  };
  const handoff = {
    resolveDestination() { return { expected_audience: "print-service-fixture" }; },
    submit(input) {
      calls.handoff += 1;
      const design = designs.get(input.handoff.binding.design_version.design_version_id);
      const bytes = stateArtifactBytes.get(design.artifact.artifact_id) ?? Buffer.from("fixture artwork bytes");
      return createConsumptionReceipt({ handoff: input.handoff,
        artifactBytesById: { [design.artifact.artifact_id]: bytes },
        trustedScope: input.scope, consumer_id: "consumer-fixture-1", receipt_id: `receipt-${calls.handoff}`,
        access_grants: [{ artifact_id: design.artifact.artifact_id, grant_ref: `grant-${calls.handoff}` }],
        consumed_at: "2026-10-10T12:30:00.000Z", now: new Date(NOW) });
    },
  };
  const inspection = {
    resolveRoute() { return { retry_mapping_ref: "retry:vision-v1", provider: {
      name: "fixture-vision", model: "fixture-vision-model", endpoint: "test:/inspect", sdk: { name: "fixture-sdk", version: "1.0" },
    } }; },
    async inspect(input) {
      calls.inspection += 1;
      calls.inspectionReservationRefs.push(input.reservation_ref);
      const transport_attempt_id = input.transport_attempt_id;
      await input.recordTransportAttempt(transport_attempt_id);
      return { tenant_id: input.scope.tenant_id, project_id: input.scope.project_id, brief_id: input.brief.brief_id,
        design_version_id: input.design_version.design_version_id, artifact_id: input.design_version.artifact.artifact_id,
        artifact_hash: input.design_version.artifact.content_hash, design_hash: input.design_version.design_hash,
        inspection_id: `inspection-${calls.inspection}`, observations: [],
        usage: { completeness: "complete", input_tokens: 1, output_tokens: 1, transport_attempt_id } };
    },
  };
  const trace = { record(event) { calls.traces.push(event); } };
  const decisionPort = {
    resolveRoute() { return { retry_mapping_ref: "retry:jev-v1", provider: {
      name: "fixture-jev", model: "jev-1.13.0", endpoint: "test:/jev", sdk: { name: "fixture-sdk", version: "1.0" },
    } }; },
    execute: async ({ request: input, transport_attempt_id, recordTransportAttempt }) => {
      await recordTransportAttempt(transport_attempt_id);
      calls.decision += 1;
      calls.decisionReservationRefs.push(input.budget_ref.reservation_ref);
      return ({ contract: "DecisionPortResult", schema_version: "1.0",
      event_id: `result:${input.event_id}`, tenant_id: input.tenant_id, project_id: input.project_id,
      correlation_id: input.correlation_id, producer: "fixture-jev", occurred_at: input.occurred_at,
      ingested_at: input.ingested_at, environment: input.environment, billing_mode: input.billing_mode,
      source_refs: input.source_refs, request_id: input.request_id, logical_operation_id: input.logical_operation_id,
      billable_attempt_id: input.billable_attempt_id, model_id: input.model_policy.model_id,
      model_policy_version: input.model_policy.policy_version, status: "complete", job_id: input.job_id,
      answers: Object.fromEntries(Object.entries(input.questions).map(([key, q]) => [key, q.type === "noul"
        ? { status: "answered", question_schema_version: q.question_schema_version, policy_version: q.policy_version, answer: { type: "noul", noul: 0.2 } }
        : q.type === "choice"
          ? { status: "answered", question_schema_version: q.question_schema_version, policy_version: q.policy_version,
            answer: { type: "choice", choice: q.eligible_candidate_ids[0], probabilities: Object.fromEntries(q.eligible_candidate_ids.map((candidate, index) => [candidate, index === 0 ? 1 : 0])), confidence: 1 } }
          : { status: "answered", question_schema_version: q.question_schema_version, policy_version: q.policy_version,
            answer: { type: "score", score: 0, legend: Object.fromEntries(q.criteria.map((value, index) => [String(index), value])),
              probabilities: Object.fromEntries(q.criteria.map((_, index) => [String(index), index === 0 ? 1 : 0])), confidence: 1 } }])),
      usage: { completeness: "complete", input_tokens: 1, output_tokens: 1, provider_request_id: `provider:jev:${input.billable_attempt_id}` } }); },
  };
  const portMap = { jobs, storage, provider, metering, approval, handoff, trace, decisionPort, inspection,
    telemetry: { outbox: memoryTelemetryOutbox(), modes: { provider_execution_mode: "mock", commerce_mode: "simulated" },
      usage_profiles: {
        image_generation: "creative.normalized-token-usage/1",
        image_edit: "creative.normalized-token-usage/1",
        vision_observation: "creative.normalized-token-usage/1",
        jev_decision: "typesafe.systemone-usage/2026-10-10",
      } } };
  for (const key of omit) delete portMap[key];

  const api = createCreativeApi({
    ports: portMap,
    now: () => clock.now,
    idFactory: () => { idCounter += 1; return `generated-id-${idCounter}`; },
  });
  const state = { brief, designs, current, selectionRevisions, jobs: records, actions, calls, authority, handoffContexts,
    stateArtifactBytes, leaseTokens, dispatchIntents, clock };
  return { api, state, ports: portMap };

}

let briefFixture;
let initialDesign;
function awaitableCloneBrief() {
  return structuredClone(briefFixture);
}

async function setup(options = {}) {
  briefFixture = await FIXTURE("brief");
  initialDesign = await FIXTURE("design-version");
  const artworkBytes = Buffer.from("fixture artwork bytes");
  initialDesign = versionFrom(initialDesign, { artifact: { ...initialDesign.artifact,
    content_hash: "sha256:" + createHash("sha256").update(artworkBytes).digest("hex") } });
  const harness = makeHarness(options);
  if (options.withDesign !== false) {
    harness.state.designs.set(initialDesign.design_version_id, structuredClone(initialDesign));
    harness.state.current.set(initialDesign.brief_id, initialDesign.design_version_id);
    harness.state.selectionRevisions.set(initialDesign.brief_id, 0);
    harness.state.stateArtifactBytes.set(initialDesign.artifact.artifact_id, artworkBytes);
    if (options.secondDesign) {
      const second = versionFrom(initialDesign, {
        event_id: "event-design-2",
        occurred_at: "2026-10-10T12:04:00.000Z",
        ingested_at: "2026-10-10T12:04:00.000Z",
        design_version_id: "design-api-2",
        parent_version_id: initialDesign.design_version_id,
        artifact: { artifact_id: "artifact-api-2", content_hash: `sha256:${"d".repeat(64)}`, media_type: "image/png" },
      });
      harness.state.designs.set(second.design_version_id, second);
      harness.state.current.set(second.brief_id, second.design_version_id);
      harness.state.selectionRevisions.set(second.brief_id, 1);
    }
  }
  return harness;
}

function generationRequest(actionId = "action-generate-1") {
  return request("generate", { brief_id: "brief-api-1", plan: structuredClone(generatePlan) }, actionId);
}

function validDecisionInput() {
  return { execution_mode: "independent_batch", state: { text: "Choose the clearest layout." },
    questions: { layout_choice: { type: "choice", question_schema_version: "1.0", policy_version: "layout/1",
      instructions: "Choose one eligible layout.", criteria: { compact: "Compact", wide: "Wide" },
      eligible_candidate_ids: ["compact", "wide"], policy: { minimum_confidence: 0.5, low_confidence_action: "review" } } } };
}

function boundEditPlan(state, designVersionId = "design-api-1") {
  const plan = structuredClone(editPlan);
  const design = state.designs.get(designVersionId);
  plan.base.brief_hash = canonicalHash(state.brief);
  plan.base.design_hash = design.design_hash;
  plan.base.design_version_id = designVersionId;
  plan.expected_result.parent_version_id = designVersionId;
  for (const step of plan.steps) {
    if (step.parameters.design_version_id !== undefined) step.parameters.design_version_id = designVersionId;
    if (step.parameters.artifact_id !== undefined) step.parameters.artifact_id = design.artifact.artifact_id;
  }
  return plan;
}

let generatePlan;
let editPlan;
async function loadPlans() {
  generatePlan = await FIXTURE("generate-plan");
  editPlan = await FIXTURE("edit-plan");
}

test("fixture scenario manifest covers every API operation and negative boundary", async () => {
  await loadPlans();
  const scenarios = await FIXTURE("scenarios");
  const operations = new Set(scenarios.cases.map((item) => item.operation));
  for (const operation of ["generate", "edit", "inspect", "list", "compare", "restore", "cancel", "handoff", "job.status"]) {
    assert.ok(operations.has(operation), `scenario missing ${operation}`);
  }
  assert.equal(scenarios.dependency_mode, "mock");
});

test("valid generation is metered before dispatch and publishes a validated immutable version", async () => {
  await loadPlans();
  const { api, state } = await setup({ withDesign: false });
  const response = await api.invoke(actor(), generationRequest());
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.job.status, "completed");
  assert.equal(response.result.design_version.parent_version_id, null);
  assert.equal(response.result.design_version.brief_id, "brief-api-1");
  assert.equal(state.calls.reserve, 1);
  assert.equal(state.calls.provider, 1);
  const providerReservationRef = state.calls.providerReservationRefs[0];
  assert.equal(typeof providerReservationRef, "string");
  assert.equal(state.authority.reservations.has(providerReservationRef), true);
  assert.equal(state.authority.reservations.get(providerReservationRef).reservation_id, providerReservationRef);
  assert.equal(state.calls.usage.length, 1);
  assert.equal(state.calls.usage[0].completeness, "complete");
  assert.equal(state.designs.has(response.result.design_version.design_version_id), true);
});

test("caller mutation after invoke cannot elevate a generate request into an edit", async () => {
  await loadPlans();
  const harness = await setup();
  const principal = actor({ permissions: ["creative.generate"] });
  const body = generationRequest("action-request-snapshot");
  const callerOwnedPayload = body.payload;
  const pending = harness.api.invoke(principal, body);
  const forgedEditPlan = boundEditPlan(harness.state);
  body.operation = "edit";
  body.action_id = "action-request-mutated";
  callerOwnedPayload.design_version_id = "design-api-1";
  callerOwnedPayload.plan = forgedEditPlan;
  body.payload = callerOwnedPayload;
  const response = await pending;
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "stale_version");
  assert.equal(harness.state.calls.provider, 0);
  assert.equal(harness.state.calls.reserve, 0);
  const job = [...harness.state.jobs.values()][0];
  assert.equal(job.operation, "generate");
  assert.equal(job.action_id, "action-request-snapshot");
  assert.equal(job.tenant_id, "tenant-api-1");
});

test("caller mutation of a nested edit plan after invoke cannot alter dispatch content", async () => {
  await loadPlans();
  const dispatchedInstructions = [];
  const harness = await setup({ providerImpl: async (_operation, input) => {
    dispatchedInstructions.push(input.plan.steps[0].parameters.instruction);
    return {
      design_version_id: "design-nested-snapshot",
      artifact: { artifact_id: "artifact-nested-snapshot", content_hash: `sha256:${"c".repeat(64)}`, media_type: "image/png" },
      provider: input.route.provider.name, model: input.route.provider.model,
      usage: { completeness: "complete", input_tokens: 1, output_tokens: 1 },
    };
  } });
  const plan = boundEditPlan(harness.state);
  const originalInstruction = plan.steps[0].parameters.instruction;
  const body = request("edit", { brief_id: "brief-api-1", design_version_id: "design-api-1", plan }, "action-nested-snapshot");
  const pending = harness.api.invoke(actor(), body);
  plan.steps[0].parameters.instruction = "Caller changed the plan after validation began.";
  const response = await pending;
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.deepEqual(dispatchedInstructions, [originalInstruction]);
  assert.notEqual(dispatchedInstructions[0], "Caller changed the plan after validation began.");
});

test("edit checks current version, known source/artifact references, and parent linkage", async () => {
  await loadPlans();
  const { api, state } = await setup();
  const response = await api.invoke(actor(), request("edit", {
    brief_id: "brief-api-1", design_version_id: "design-api-1", plan: boundEditPlan(state),
  }, "action-edit-1"));
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.result.design_version.parent_version_id, "design-api-1");
  assert.equal(state.calls.provider, 1);
  assert.equal(state.current.get("brief-api-1"), response.result.design_version.design_version_id);
});

test("explicit-parent edit branches from a retained version without moving current selection", async () => {
  await loadPlans();
  const harness = await setup({ secondDesign: true });
  const parentHash = harness.state.designs.get("design-api-1").design_hash;
  const response = await harness.api.invoke(actor(), request("edit", {
    brief_id: "brief-api-1", design_version_id: "design-api-1", selection_mode: "branch",
    plan: boundEditPlan(harness.state, "design-api-1"),
  }, "action-explicit-branch"));
  assert.equal(response.ok, true, JSON.stringify(response));
  const branch = response.result.design_version;
  assert.equal(branch.parent_version_id, "design-api-1");
  assert.equal(harness.state.current.get("brief-api-1"), "design-api-2");
  assert.equal(harness.state.designs.get("design-api-1").design_hash, parentHash);
  assert.equal(harness.state.designs.has(branch.design_version_id), true);
  assert.equal(`sha256:${createHash("sha256").update(harness.state.stateArtifactBytes.get(branch.artifact.artifact_id)).digest("hex")}`,
    branch.artifact.content_hash);
  assert.equal(harness.state.calls.provider, 1);
  const saved = harness.state.calls.storage.find((item) => item.method === "saveDesignVersion");
  assert.ok(saved);
});

test("provider artifact bytes are copied before storage awaits and must match their declared hash", async () => {
  await loadPlans();
  const originalBytes = Uint8Array.from([7, 8, 9, 10]);
  const expectedBytes = Uint8Array.from(originalBytes);
  const digest = `sha256:${createHash("sha256").update(originalBytes).digest("hex")}`;
  let externalBytes = originalBytes;
  let enteredSave;
  let releaseSave;
  const saveStarted = new Promise((resolve) => { enteredSave = resolve; });
  const saveGate = new Promise((resolve) => { releaseSave = resolve; });
  const harness = await setup({ withDesign: false, providerImpl: async () => ({
    design_version_id: "design-byte-snapshot",
    artifact: { artifact_id: "artifact-byte-snapshot", content_hash: digest, media_type: "image/png" },
    artifact_bytes: externalBytes,
    provider: "fixture-provider", model: "fixture-model",
    usage: { completeness: "complete", input_tokens: 1, output_tokens: 2 },
  }) });
  const save = harness.ports.storage.saveDesignVersion.bind(harness.ports.storage);
  harness.ports.storage.saveDesignVersion = async (input, transaction) => {
    enteredSave();
    await saveGate;
    return save(input, transaction);
  };
  const operation = harness.api.invoke(actor(), generationRequest("action-byte-snapshot"));
  await saveStarted;
  externalBytes.fill(0);
  releaseSave();
  const response = await operation;
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.result.design_version.artifact.content_hash, digest);
  assert.deepEqual(harness.state.stateArtifactBytes.get("artifact-byte-snapshot"), expectedBytes);

  const malformed = await setup({ withDesign: false, providerImpl: async () => ({
    design_version_id: "design-byte-hash-mismatch",
    artifact: { artifact_id: "artifact-byte-hash-mismatch", content_hash: `sha256:${"a".repeat(64)}`, media_type: "image/png" },
    artifact_bytes: Uint8Array.from([1, 2, 3]),
    provider: "fixture-provider", model: "fixture-model",
    usage: { completeness: "complete", input_tokens: 1, output_tokens: 2 },
  }) });
  const rejected = await malformed.api.invoke(actor(), generationRequest("action-byte-hash-mismatch"));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, "failed");
  assert.equal(rejected.error.field, "artifact_content_hash");
  assert.equal(malformed.state.calls.storage.some((item) => item.method === "saveDesignVersion"), false);
  assert.equal(malformed.state.calls.usage[0].completeness, "complete");
});

test("malformed and unsupported requests fail before billing or provider dispatch", async () => {
  await loadPlans();
  const { api, state } = await setup({ withDesign: false });
  const unsupported = generationRequest();
  unsupported.schema_version = "2.0";
  assert.equal((await api.invoke(actor(), unsupported)).error.code, "unsupported_version");
  const malformed = generationRequest();
  malformed.operation = "tool.execute";
  assert.equal((await api.invoke(actor(), malformed)).error.code, "invalid_request");
  const badPlan = structuredClone(generatePlan);
  badPlan.operation = "privileged.dynamic.action";
  const badBody = request("generate", { brief_id: "brief-api-1", plan: badPlan }, "action-bad-plan");
  assert.equal((await api.invoke(actor(), badBody)).ok, false);
  assert.equal(state.calls.provider, 0);
  assert.equal(state.calls.reserve, 0);
});

test("every API operation rejects expired trusted context before touching any port", async () => {
  await loadPlans();
  const expired = actor({ expires_at: "2026-10-10T12:29:59.999Z" });
  const requests = [
    generationRequest(),
    request("edit", { brief_id: "brief-api-1", design_version_id: "design-api-1", plan: structuredClone(editPlan) }, "edit-expired"),
    request("inspect", { brief_id: "brief-api-1", design_version_id: "design-api-1" }, "inspect-expired"),
    request("list", { brief_id: "brief-api-1" }),
    request("compare", { brief_id: "brief-api-1", left_design_version_id: "design-api-1", right_design_version_id: "design-api-1" }),
    request("restore", { brief_id: "brief-api-1", target_design_version_id: "design-api-1", expected_selection_revision: 0 }, "restore-expired"),
    request("cancel", { job_id: "job-existing" }, "cancel-expired"),
    request("handoff", { brief_id: "brief-api-1", design_version_id: "design-api-1", approval_ref: "approval-1", destination_ref: "print-1" }, "handoff-expired"),
    request("job.status", { job_id: "job-existing" }),
  ];
  for (const item of requests) {
    const { api, state } = await setup();
    const response = await api.invoke(expired, item);
    assert.equal(response.ok, false, item.operation);
    assert.equal(response.error.code, "unauthorized", item.operation);
    assert.equal(state.calls.storage.length, 0, item.operation);
    assert.equal(state.calls.provider, 0, item.operation);
  }
});

test("forged tenant or project scope and foreign artifact records never cross storage boundaries", async () => {
  await loadPlans();
  const harness = await setup({ foreignDesign: true });
  const forged = request("inspect", { brief_id: "brief-api-1", design_version_id: "design-api-1" }, "inspect-forged");
  forged.project_id = "other-project";
  assert.equal((await harness.api.invoke(actor(), forged)).error.code, "scope_denied");
  const foreign = request("inspect", { brief_id: "brief-api-1", design_version_id: "design-api-1" }, "inspect-foreign");
  assert.equal((await harness.api.invoke(actor(), foreign)).error.code, "scope_denied");
  assert.equal(harness.state.calls.provider, 0);
});

test("inspect, compare, and list use scoped reads and deterministic keyset pagination", async () => {
  await loadPlans();
  const { api, state } = await setup({ secondDesign: true });
  const inspected = await api.invoke(actor(), request("inspect", { brief_id: "brief-api-1", design_version_id: "design-api-1" }, "inspect-valid"));
  assert.equal(inspected.ok, true, JSON.stringify(inspected));
  const inspectionReservationRef = state.calls.inspectionReservationRefs[0];
  assert.equal(typeof inspectionReservationRef, "string");
  assert.equal(state.authority.reservations.has(inspectionReservationRef), true);
  assert.equal(state.authority.reservations.get(inspectionReservationRef).reservation_id, inspectionReservationRef);
  const compared = await api.invoke(actor(), request("compare", {
    brief_id: "brief-api-1", left_design_version_id: "design-api-1", right_design_version_id: "design-api-2",
  }));
  assert.equal(compared.ok, true);
  assert.deepEqual(compared.result.changed_fields, ["artifact.content_hash", "parent_version_id"]);
  const first = await api.invoke(actor(), request("list", { brief_id: "brief-api-1", limit: 1 }));
  assert.equal(first.ok, true);
  assert.equal(first.result.items.length, 1);
  assert.equal(first.result.items[0].design_version_id, "design-api-2");
  assert.ok(first.result.next_cursor);
  const second = await api.invoke(actor(), request("list", { brief_id: "brief-api-1", limit: 1, cursor: first.result.next_cursor }));
  assert.equal(second.result.items[0].design_version_id, "design-api-1");
  assert.equal(second.result.next_cursor, null);
  const forgedCursor = Buffer.from(JSON.stringify({ tenant_id: "other", project_id: "project-api-1", brief_id: "brief-api-1",
    occurred_at: "2026-10-10T12:04:00.000Z", design_version_id: "design-api-2" })).toString("base64url");
  assert.equal((await api.invoke(actor(), request("list", { brief_id: "brief-api-1", cursor: forgedCursor }))).error.code, "invalid_request");
  assert.equal(state.calls.provider, 0);
});

test("inspection usage with unknown provider fields is metered as incomplete without retaining raw fields", async () => {
  await loadPlans();
  const { api, ports, state } = await setup();
  const inspect = ports.inspection.inspect;
  ports.inspection.inspect = async (input) => ({ ...(await inspect(input)), usage: {
    completeness: "complete", input_tokens: 1, output_tokens: 1,
    transport_attempt_id: input.transport_attempt_id,
    access_token: "SYNTHETIC-NOT-A-REAL-CREDENTIAL",
    reason: "SYNTHETIC-NOT-A-REAL-CREDENTIAL",
  } });
  const response = await api.invoke(actor(), request("inspect", {
    brief_id: "brief-api-1", design_version_id: "design-api-1",
  }, "inspect-usage-scrub"));
  assert.equal(response.ok, false, JSON.stringify(response));
  assert.equal(response.error.code, "unavailable");
  assert.equal(state.calls.usage.length, 1);
  assert.equal(state.calls.usage[0].completeness, "partial");
  assert.ok(state.calls.usage[0].missing_fields.includes("usage.unmapped_extension"));
  assert.equal(JSON.stringify(state.calls.usage).includes("SYNTHETIC-NOT-A-REAL-CREDENTIAL"), false);
  assert.equal(JSON.stringify(response).includes("SYNTHETIC-NOT-A-REAL-CREDENTIAL"), false);
});

test("inspection normalizes nested observations and rejects credential-shaped nested fields on replay", async () => {
  await loadPlans();
  const malicious = await setup();
  const secret = "SYNTHETIC-NOT-A-REAL-CREDENTIAL";
  const inspect = malicious.ports.inspection.inspect;
  malicious.ports.inspection.inspect = async (input) => ({ ...(await inspect(input)), observations: [{
    observer: { type: "model", id: "observer-model", api_key: secret },
    content_hash: input.design_version.artifact.content_hash,
    uncertainty: { status: "unknown", raw_response: secret }, summary: "Observed safely.",
  }] });
  const rejected = await malicious.api.invoke(actor(), request("inspect", {
    brief_id: "brief-api-1", design_version_id: "design-api-1",
  }, "inspect-nested-private"));
  assert.equal(rejected.ok, false);
  assert.equal(JSON.stringify(rejected).includes(secret), false);
  assert.equal(malicious.state.calls.inspection, 1);

  const replayHarness = await setup();
  const replayInspect = replayHarness.ports.inspection.inspect;
  replayHarness.ports.inspection.inspect = async (input) => ({ ...(await replayInspect(input)), observations: [{
    observer: { type: "model", id: "observer-model" },
    content_hash: input.design_version.artifact.content_hash,
    uncertainty: { status: "unknown" }, summary: "Observed safely.",
  }] });
  const body = request("inspect", { brief_id: "brief-api-1", design_version_id: "design-api-1" }, "inspect-replay-private");
  const first = await replayHarness.api.invoke(actor(), body);
  assert.equal(first.ok, true, JSON.stringify(first));
  const stored = [...replayHarness.state.jobs.values()].find((job) => job.action_id === "inspect-replay-private");
  stored.result = structuredClone(stored.result);
  stored.result.inspection.observations[0].observer.api_key = secret;
  stored.result.inspection.observations[0].uncertainty.raw_response = secret;
  const replay = structuredClone(body);
  replay.event_id += ":replay";
  replay.request_id += ":replay";
  replay.correlation_id += ":replay";
  const rejectedReplay = await replayHarness.api.invoke(actor(), replay);
  assert.equal(rejectedReplay.ok, false);
  assert.equal(rejectedReplay.error.code, "unavailable");
  assert.equal(JSON.stringify(rejectedReplay).includes(secret), false);
});

test("inspection public text rejects credential, signed URL, and personal data values on fresh and replay paths", async () => {
  await loadPlans();
  const sensitiveCases = [
    { path: ["observer", "id"], value: "Bearer synthetic-private-token" },
    { path: ["uncertainty", "note"], value: "https://assets.example/art?X-Amz-Signature=synthetic-signature" },
    { path: ["summary"], value: "Visible contact: designer@example.test" },
  ];

  for (const [index, sensitive] of sensitiveCases.entries()) {
    const liveHarness = await setup();
    const liveInspect = liveHarness.ports.inspection.inspect;
    liveHarness.ports.inspection.inspect = async (input) => {
      const result = await liveInspect(input);
      const observation = {
        observer: { type: "model", id: "observer-model" },
        content_hash: input.design_version.artifact.content_hash,
        uncertainty: { status: "unknown" },
        summary: "A blue-green mark is visible near the upper right.",
      };
      let target = observation;
      for (const key of sensitive.path.slice(0, -1)) target = target[key];
      target[sensitive.path.at(-1)] = sensitive.value;
      return { ...result, observations: [observation] };
    };
    const body = request("inspect", { brief_id: "brief-api-1", design_version_id: "design-api-1" }, `inspect-text-private-${index}`);
    const rejected = await liveHarness.api.invoke(actor(), body);
    assert.equal(rejected.ok, false);
    assert.equal(JSON.stringify(rejected).includes(sensitive.value), false);

    const replayHarness = await setup();
    const replayBody = request("inspect", { brief_id: "brief-api-1", design_version_id: "design-api-1" }, `inspect-text-replay-${index}`);
    const completed = await replayHarness.api.invoke(actor(), replayBody);
    assert.equal(completed.ok, true, JSON.stringify(completed));
    const stored = [...replayHarness.state.jobs.values()].find((job) => job.action_id === replayBody.action_id);
    stored.result = structuredClone(stored.result);
    stored.result.inspection.observations = [{ observer: { type: "model", id: "observer-model" },
      content_hash: stored.result.inspection.artifact_hash, uncertainty: { status: "unknown" },
      summary: "A blue-green mark is visible near the upper right." }];
    let target = stored.result.inspection.observations[0];
    for (const key of sensitive.path.slice(0, -1)) target = target[key];
    target[sensitive.path.at(-1)] = sensitive.value;
    const replay = structuredClone(replayBody);
    replay.event_id += ":replay";
    replay.request_id += ":replay";
    replay.correlation_id += ":replay";
    const rejectedReplay = await replayHarness.api.invoke(actor(), replay);
    assert.equal(rejectedReplay.ok, false);
    assert.equal(rejectedReplay.error.code, "unavailable");
    assert.equal(JSON.stringify(rejectedReplay).includes(sensitive.value), false);
  }
});

test("all public identifier fields reject credential-shaped values on fresh and persisted inspection replay", async () => {
  await loadPlans();
  const secret = "Bearer synthetic-inspection-id-secret";
  const freshHarness = await setup();
  const freshInspect = freshHarness.ports.inspection.inspect;
  freshHarness.ports.inspection.inspect = async (input) => ({
    ...(await freshInspect(input)), inspection_id: secret,
  });
  const freshBody = request("inspect", { brief_id: "brief-api-1", design_version_id: "design-api-1" }, "inspect-id-private-fresh");
  const fresh = await freshHarness.api.invoke(actor(), freshBody);
  assert.equal(fresh.ok, false);
  assert.equal(fresh.error.code, "unavailable");
  assert.equal(JSON.stringify(fresh).includes(secret), false);

  const replayHarness = await setup();
  const replayBody = request("inspect", { brief_id: "brief-api-1", design_version_id: "design-api-1" }, "inspect-id-private-replay");
  const completed = await replayHarness.api.invoke(actor(), replayBody);
  assert.equal(completed.ok, true, JSON.stringify(completed));
  const stored = [...replayHarness.state.jobs.values()].find((job) => job.action_id === replayBody.action_id);
  stored.result = structuredClone(stored.result);
  stored.result.inspection.inspection_id = secret;
  const replayRequest = structuredClone(replayBody);
  replayRequest.event_id += ":replay";
  replayRequest.request_id += ":replay";
  replayRequest.correlation_id += ":replay";
  const replay = await replayHarness.api.invoke(actor(), replayRequest);
  assert.equal(replay.ok, false);
  assert.equal(replay.error.code, "unavailable");
  assert.equal(JSON.stringify(replay).includes(secret), false);
});

test("public projection rejects unsafe strings in nested hash-bound metadata and preserves safe optional metadata", async () => {
  await loadPlans();
  const secret = "sk-syntheticPublicIdentifierSecret123456789";
  const safeHarness = await setup();
  const original = safeHarness.state.designs.get("design-api-1");
  const withSafeMetadata = versionFrom(original, { artifact: { ...original.artifact,
    extra: JSON.parse('{"palette":"cobalt","treatment":"matte","vendor_id":42,"render_ref":{"revision":2},"optional_ref":null,"source_id":42,"usage_refs":{"vendor":2},"display":"Basic illustrations support the main headline.","style_note":"Basic shapes create a balanced composition.","__proto__":{"surface":"velvet"}}') } });
  safeHarness.state.designs.set(withSafeMetadata.design_version_id, withSafeMetadata);
  const listed = await safeHarness.api.invoke(actor(), request("list", { brief_id: "brief-api-1" }));
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.equal(listed.result.items[0].artifact.extra.palette, "cobalt");
  assert.equal(listed.result.items[0].artifact.extra.treatment, "matte");
  assert.equal(listed.result.items[0].artifact.extra.vendor_id, 42);
  assert.deepEqual(listed.result.items[0].artifact.extra.render_ref, { revision: 2 });
  assert.equal(listed.result.items[0].artifact.extra.optional_ref, null);
  assert.equal(listed.result.items[0].artifact.extra.source_id, 42);
  assert.deepEqual(listed.result.items[0].artifact.extra.usage_refs, { vendor: 2 });
  assert.equal(listed.result.items[0].artifact.extra.display, "Basic illustrations support the main headline.");
  assert.equal(listed.result.items[0].artifact.extra.style_note, "Basic shapes create a balanced composition.");
  assert.equal(Object.hasOwn(listed.result.items[0].artifact.extra, "__proto__"), true);
  assert.deepEqual(listed.result.items[0].artifact.extra.__proto__, { surface: "velvet" });
  assert.equal(listed.result.items[0].design_hash, withSafeMetadata.design_hash);

  const unsafeHarness = await setup();
  const unsafeBase = unsafeHarness.state.designs.get("design-api-1");
  const withUnsafeMetadata = versionFrom(unsafeBase, { artifact: { ...unsafeBase.artifact,
    extra: { nested: { display: secret } } } });
  unsafeHarness.state.designs.set(withUnsafeMetadata.design_version_id, withUnsafeMetadata);
  const rejectedList = await unsafeHarness.api.invoke(actor(), request("list", { brief_id: "brief-api-1" }));
  assert.equal(rejectedList.ok, false);
  assert.equal(rejectedList.error.code, "unavailable");
  assert.equal(JSON.stringify(rejectedList).includes(secret), false);
  const rejectedCompare = await unsafeHarness.api.invoke(actor(), request("compare", {
    brief_id: "brief-api-1", left_design_version_id: "design-api-1", right_design_version_id: "design-api-1",
  }));
  assert.equal(rejectedCompare.ok, false);
  assert.equal(rejectedCompare.error.code, "unavailable");
  assert.equal(JSON.stringify(rejectedCompare).includes(secret), false);
});

test("safe additive artifact metadata preserves canonical design identity across generate, replay, list, and compare", async () => {
  await loadPlans();
  const safeExtra = JSON.parse('{"vendor_id":42,"render_ref":{"revision":2},"optional_ref":null,"source_id":42,"usage_refs":{"vendor":2},"display":"Basic illustrations support the main headline.","style_note":"Basic shapes create a balanced composition."}');
  const harness = await setup({ withDesign: false });
  const originalGenerate = harness.ports.provider.generate;
  harness.ports.provider.generate = async (input) => {
    const design = await originalGenerate(input);
    return versionFrom(design, { artifact: { ...design.artifact, extra: structuredClone(safeExtra) } });
  };
  const body = generationRequest("safe-additive-metadata-roundtrip");
  const first = await harness.api.invoke(actor(), body);
  assert.equal(first.ok, true, JSON.stringify(first));
  const generated = first.result.design_version;
  assert.deepEqual(generated.artifact.extra, safeExtra);
  assert.equal(generated.design_hash, computeDesignVersionHash(generated));

  const replayRequest = structuredClone(body);
  replayRequest.event_id += ":retry";
  replayRequest.request_id += ":retry";
  replayRequest.correlation_id += ":retry";
  const replay = await harness.api.invoke(actor(), replayRequest);
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.result.design_version.artifact.extra, safeExtra);
  assert.equal(replay.result.design_version.design_hash, generated.design_hash);

  const listed = await harness.api.invoke(actor(), request("list", { brief_id: "brief-api-1" }, "safe-additive-metadata-list"));
  assert.equal(listed.ok, true, JSON.stringify(listed));
  const listedDesign = listed.result.items.find((item) => item.design_version_id === generated.design_version_id);
  assert.ok(listedDesign);
  assert.deepEqual(listedDesign.artifact.extra, safeExtra);
  assert.equal(listedDesign.design_hash, generated.design_hash);

  const compared = await harness.api.invoke(actor(), request("compare", {
    brief_id: "brief-api-1", left_design_version_id: generated.design_version_id,
    right_design_version_id: generated.design_version_id,
  }, "safe-additive-metadata-compare"));
  assert.equal(compared.ok, true, JSON.stringify(compared));
  assert.deepEqual(compared.result.left.artifact.extra, safeExtra);
  assert.deepEqual(compared.result.right.artifact.extra, safeExtra);
  assert.equal(compared.result.left.design_hash, generated.design_hash);
  assert.equal(compared.result.right.design_hash, generated.design_hash);
});

test("public projection rejects sensitive object keys and Basic credentials without echoing diagnostic paths", async () => {
  await loadPlans();
  const privateKey = "sk-abcdefghijklmnopqrstuvwxyz1234";
  const privateText = "sk-syntheticPublicIdentifierSecret123456789";
  const basicCredential = "Basic dXNlcjpwYXNzd29yZA==";
  const shortBasicCredential = "Basic dTpw";
  const emptyUsernameCredential = "Basic OnBhc3N3b3Jk";
  const emptyUsernamePaddedCredential = "Basic OnA=";
  const emptyUserPassCredential = "Basic Og==";
  const emptyPasswordCredential = "Basic dTo=";
  const extraPasswordColonCredential = `Basic ${Buffer.from("user:p:a:ss", "utf8").toString("base64")}`;
  const utf8Credential = `Basic ${Buffer.from("usér:päss", "utf8").toString("base64")}`;
  const cases = [
    { extra: { nested: { [privateKey]: "cobalt" } }, secrets: [privateKey], field: "result.design.artifact.extra.nested" },
    { extra: { nested: { "owner@example.test": "cobalt" } }, secrets: ["owner@example.test"], field: "result.design.artifact.extra.nested" },
    { extra: { nested: { [privateKey]: privateText } }, secrets: [privateKey, privateText], field: "result.design.artifact.extra.nested" },
    { extra: { display: basicCredential }, secrets: [basicCredential, "dXNlcjpwYXNzd29yZA=="], field: "result.design.artifact.extra.display" },
    { extra: { display: shortBasicCredential }, secrets: [shortBasicCredential, "dTpw"], field: "result.design.artifact.extra.display" },
    { extra: { display: emptyUsernameCredential }, secrets: [emptyUsernameCredential, "OnBhc3N3b3Jk"], field: "result.design.artifact.extra.display" },
    { extra: { display: emptyUsernamePaddedCredential }, secrets: [emptyUsernamePaddedCredential, "OnA="], field: "result.design.artifact.extra.display" },
    { extra: { display: emptyUserPassCredential }, secrets: [emptyUserPassCredential, "Og=="], field: "result.design.artifact.extra.display" },
    { extra: { display: emptyPasswordCredential }, secrets: [emptyPasswordCredential, "dTo="], field: "result.design.artifact.extra.display" },
    { extra: { display: extraPasswordColonCredential }, secrets: [extraPasswordColonCredential], field: "result.design.artifact.extra.display" },
    { extra: { display: utf8Credential }, secrets: [utf8Credential], field: "result.design.artifact.extra.display" },
  ];
  const markerAbsent = (response, secrets) => {
    assert.equal(response.ok, false, JSON.stringify(response));
    assert.equal(response.error.code, "unavailable");
    for (const secret of secrets) assert.equal(JSON.stringify(response).includes(secret), false);
  };

  for (const [index, testCase] of cases.entries()) {
    const freshHarness = await setup({ withDesign: false });
    const originalGenerate = freshHarness.ports.provider.generate;
    freshHarness.ports.provider.generate = async (input) => {
      const design = await originalGenerate(input);
      return versionFrom(design, { artifact: { ...design.artifact, extra: structuredClone(testCase.extra) } });
    };
    const freshRequest = generationRequest(`public-object-key-fresh-${index}`);
    const fresh = await freshHarness.api.invoke(actor(), freshRequest);
    markerAbsent(fresh, testCase.secrets);
    assert.equal(fresh.error.field, testCase.field);
    const failedReplay = await freshHarness.api.invoke(actor(), freshRequest);
    for (const secret of testCase.secrets) assert.equal(JSON.stringify(failedReplay).includes(secret), false);

    const replayHarness = await setup({ withDesign: false });
    const replayRequest = generationRequest(`public-object-key-replay-${index}`);
    const completed = await replayHarness.api.invoke(actor(), replayRequest);
    assert.equal(completed.ok, true, JSON.stringify(completed));
    const stored = [...replayHarness.state.jobs.values()].find((job) => job.action_id === replayRequest.action_id);
    const changed = versionFrom(stored.result.design, { artifact: {
      ...stored.result.design.artifact, extra: structuredClone(testCase.extra),
    } });
    replayHarness.state.designs.set(changed.design_version_id, changed);
    stored.result.design = structuredClone(changed);
    const replay = structuredClone(replayRequest);
    replay.event_id += ":retry";
    replay.request_id += ":retry";
    replay.correlation_id += ":retry";
    markerAbsent(await replayHarness.api.invoke(actor(), replay), testCase.secrets);

    const readHarness = await setup();
    const base = readHarness.state.designs.get("design-api-1");
    const unsafe = versionFrom(base, { artifact: { ...base.artifact, extra: structuredClone(testCase.extra) } });
    readHarness.state.designs.set(unsafe.design_version_id, unsafe);
    markerAbsent(await readHarness.api.invoke(actor(), request("list", { brief_id: "brief-api-1" }, `public-object-key-list-${index}`)), testCase.secrets);
    markerAbsent(await readHarness.api.invoke(actor(), request("compare", {
      brief_id: "brief-api-1", left_design_version_id: "design-api-1", right_design_version_id: "design-api-1",
    }, `public-object-key-compare-${index}`)), testCase.secrets);
  }
});

test("provider, approval, and receipt records reject credential-shaped values before exposing them", async () => {
  await loadPlans();
  const marker = "sk-syntheticPublicIdentifierSecret123456789";
  const assertRejectedWithoutMarker = (response) => {
    assert.equal(response.ok, false, JSON.stringify(response));
    assert.equal(response.error.code, "unavailable");
    assert.equal(JSON.stringify(response).includes(marker), false);
  };

  for (const field of ["design_version_id", "artifact.artifact_id", "artifact.media_type", "artifact.extra"]) {
    const harness = await setup({ withDesign: false });
    const original = harness.ports.provider.generate;
    harness.ports.provider.generate = async (input) => {
      const value = await original(input);
      const parts = field.split(".");
      if (parts.length === 2) value[parts[0]][parts[1]] = marker;
      else value[field] = marker;
      return value;
    };
    const body = generationRequest(`public-provider-${field}`);
    const first = await harness.api.invoke(actor(), body);
    assertRejectedWithoutMarker(first);
    const replay = await harness.api.invoke(actor(), body);
    assert.equal(JSON.stringify(replay).includes(marker), false);
  }

  for (const field of ["approval_id", "issuer_id", "key_id", "key_set_version", "revocation.record_ref"]) {
    const harness = await setup();
    const original = harness.ports.approval.verifyApproval;
    harness.ports.approval.verifyApproval = async (input) => {
      const value = await original(input);
      const parts = field.split(".");
      if (parts.length === 2) value.approval[parts[0]][parts[1]] = marker;
      else value.approval[field] = marker;
      return value;
    };
    const body = request("handoff", { brief_id: "brief-api-1", design_version_id: "design-api-1",
      approval_ref: "approval-1", destination_ref: "print-1" }, `public-approval-${field}`);
    assertRejectedWithoutMarker(await harness.api.invoke(actor(), body));
    assert.equal(harness.state.calls.handoff, 0, "unsafe approval proof must be rejected before consumer submission");
    const replay = await harness.api.invoke(actor(), body);
    assert.equal(JSON.stringify(replay).includes(marker), false);
  }

  for (const field of ["receipt_id", "consumer_id", "access_grants.0.grant_ref"]) {
    const harness = await setup();
    const original = harness.ports.handoff.submit;
    harness.ports.handoff.submit = async (input) => {
      const value = await original(input);
      const parts = field.split(".");
      if (parts.length === 3) value[parts[0]][0][parts[2]] = marker;
      else value[field] = marker;
      return value;
    };
    const body = request("handoff", { brief_id: "brief-api-1", design_version_id: "design-api-1",
      approval_ref: "approval-1", destination_ref: "print-1" }, `public-receipt-${field}`);
    assertRejectedWithoutMarker(await harness.api.invoke(actor(), body));
    const replay = await harness.api.invoke(actor(), body);
    assert.equal(JSON.stringify(replay).includes(marker), false);
  }

  const correlationHarness = await setup({ withDesign: false });
  const correlationBody = generationRequest("public-request-correlation");
  correlationBody.correlation_id = marker;
  assertRejectedWithoutMarker(await correlationHarness.api.invoke(actor(), correlationBody));
  assert.equal(JSON.stringify(await correlationHarness.api.invoke(actor(), correlationBody)).includes(marker), false);
});

test("restore selects the existing immutable version by selection CAS without creating a version", async () => {
  await loadPlans();
  const { api, state } = await setup({ secondDesign: true });
  const restored = await api.invoke(actor(), request("restore", {
    brief_id: "brief-api-1", target_design_version_id: "design-api-1", expected_selection_revision: 1,
  }, "action-restore-1"));
  assert.equal(restored.ok, true, JSON.stringify(restored));
  assert.deepEqual(restored.result.selection, { tenant_id: "tenant-api-1", project_id: "project-api-1", brief_id: "brief-api-1",
    design_version_id: "design-api-1", design_hash: initialDesign.design_hash, revision: 2 });
  assert.equal(state.designs.size, 2);
  assert.equal(state.designs.get("design-api-1").design_hash, initialDesign.design_hash);
  assert.equal(state.designs.has("design-api-2"), true);
  assert.equal(state.current.get("brief-api-1"), "design-api-1");
  assert.equal(state.calls.provider, 0);
});

test("completed restore replay reports its original selection after later selection changes", async () => {
  await loadPlans();
  const { api, state } = await setup({ secondDesign: true });
  const firstRequest = request("restore", {
    brief_id: "brief-api-1", target_design_version_id: "design-api-1", expected_selection_revision: 1,
  }, "action-restore-replay");
  const first = await api.invoke(actor(), firstRequest);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.result.selection.revision, 2);
  assert.equal(first.result.selection.design_hash, initialDesign.design_hash);

  const later = await api.invoke(actor(), request("restore", {
    brief_id: "brief-api-1", target_design_version_id: "design-api-2", expected_selection_revision: 2,
  }, "action-restore-later"));
  assert.equal(later.ok, true, JSON.stringify(later));
  assert.equal(state.current.get("brief-api-1"), "design-api-2");
  assert.equal(state.selectionRevisions.get("brief-api-1"), 3);

  const replay = structuredClone(firstRequest);
  replay.event_id = "restore-replay-event";
  replay.request_id = "restore-replay-request";
  replay.correlation_id = "restore-replay-correlation";
  const repeated = await api.invoke(actor(), replay);
  assert.equal(repeated.ok, true, JSON.stringify(repeated));
  assert.equal(repeated.replayed, true);
  assert.equal(repeated.result.selection.design_version_id, "design-api-1");
  assert.equal(repeated.result.selection.revision, 2);
  assert.equal(repeated.result.selection.design_hash, initialDesign.design_hash);
  assert.equal(state.current.get("brief-api-1"), "design-api-2");
  assert.equal(state.selectionRevisions.get("brief-api-1"), 3);
  assert.equal(state.calls.provider, 0);

  const stored = [...state.jobs.values()].find((job) => job.action_id === "action-restore-replay");
  assert.equal(stored.result.selection.design_hash, initialDesign.design_hash);
  stored.result.selection.authorization = "SYNTHETIC-NOT-A-REAL-CREDENTIAL";
  const privateReplay = structuredClone(firstRequest);
  privateReplay.event_id += ":private";
  privateReplay.request_id += ":private";
  privateReplay.correlation_id += ":private";
  const rejected = await api.invoke(actor(), privateReplay);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, "unavailable");
  assert.equal(JSON.stringify(rejected).includes("SYNTHETIC-NOT-A-REAL-CREDENTIAL"), false);
});

test("stale edit and restore versions fail before any provider dispatch", async () => {
  await loadPlans();
  const { api, state } = await setup({ secondDesign: true });
  const edit = await api.invoke(actor(), request("edit", {
    brief_id: "brief-api-1", design_version_id: "design-api-1", plan: boundEditPlan(state),
  }, "action-stale-edit"));
  assert.equal(edit.error.code, "stale_version");
  const restore = await api.invoke(actor(), request("restore", {
    brief_id: "brief-api-1", target_design_version_id: "design-api-1", expected_selection_revision: 0,
  }, "action-stale-restore"));
  assert.equal(restore.error.code, "stale_version");
  assert.equal(state.calls.provider, 0);
  assert.equal(state.calls.reserve, 0);
});

test("same action identity replays and changed payload conflicts, including concurrent duplicates", async () => {
  await loadPlans();
  let started;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const begun = new Promise((resolve) => { started = resolve; });
  const harness = await setup({ withDesign: false, providerImpl: async () => {
    started();
    await gate;
    return {
      design_version_id: "design-concurrent-1",
      artifact: { artifact_id: "artifact-concurrent-1", content_hash: `sha256:${"e".repeat(64)}`, media_type: "image/png" },
      provider: "fixture-provider", model: "fixture-model", usage: { completeness: "complete", input_tokens: 2, output_tokens: 3 },
    };
  } });
  const firstRequest = generationRequest("action-dedupe-1");
  const firstPromise = harness.api.invoke(actor(), firstRequest);
  await begun;
  const retry = structuredClone(firstRequest);
  retry.event_id = "different-event";
  retry.request_id = "different-request";
  retry.correlation_id = "different-correlation";
  retry.occurred_at = "2026-10-10T12:21:00.000Z";
  const duplicate = await harness.api.invoke(actor(), retry);
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.replayed, true);
  assert.equal(harness.state.calls.provider, 1);
  const conflicting = structuredClone(retry);
  conflicting.payload.plan.steps[0].parameters.variant_count = 2;
  assert.equal((await harness.api.invoke(actor(), conflicting)).error.code, "conflict");
  release();
  assert.equal((await firstPromise).ok, true);
});

test("completed replay validates persisted scope and result before returning it", async () => {
  await loadPlans();
  const harness = await setup({ withDesign: false });
  const firstRequest = generationRequest("action-replay-corrupt");
  const first = await harness.api.invoke(actor(), firstRequest);
  assert.equal(first.ok, true, JSON.stringify(first));
  const stored = [...harness.state.jobs.values()].find((job) => job.action_id === firstRequest.action_id);
  assert.ok(stored);
  stored.result.design.artifact.content_hash = `sha256:${"z".repeat(64)}`;

  const replayRequest = structuredClone(firstRequest);
  replayRequest.event_id = "corrupt-replay-event";
  replayRequest.request_id = "corrupt-replay-request";
  replayRequest.correlation_id = "corrupt-replay-correlation";
  const replay = await harness.api.invoke(actor(), replayRequest);
  assert.equal(replay.ok, false);
  assert.equal(replay.error.code, "invalid_request");
  assert.equal(harness.state.calls.provider, 1);
});

test("cancellation that wins the publication fence prevents a provider result from being saved", async () => {
  await loadPlans();
  let signalStarted;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const providerStarted = new Promise((resolve) => { signalStarted = resolve; });
  const harness = await setup({ withDesign: false, providerImpl: async () => {
    signalStarted();
    await gate;
    return {
      design_version_id: "design-cancelled-1",
      artifact: { artifact_id: "artifact-cancelled-1", content_hash: `sha256:${"f".repeat(64)}`, media_type: "image/png" },
      provider: "fixture-provider", model: "fixture-model", usage: { completeness: "complete", input_tokens: 2, output_tokens: 3 },
    };
  } });
  const generation = harness.api.invoke(actor(), generationRequest("action-cancel-target"));
  await providerStarted;
  const job = [...harness.state.jobs.values()][0];
  const cancelled = await harness.api.invoke(actor(), request("cancel", { job_id: job.job_id }, "action-cancel-1"));
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.job.status, "cancelled");
  release();
  const result = await generation;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "cancelled");
  assert.equal(harness.state.designs.has("design-cancelled-1"), false);
  assert.equal(harness.state.calls.usage[0].completeness, "complete");
});

test("cancellation during route, reservation, or in-flight waits wins before dispatch intent", async () => {
  await loadPlans();
  for (const phase of ["route", "reservation", "in_flight"]) {
    let entered;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const waiting = new Promise((resolve) => { entered = resolve; });
    const harness = await setup({ withDesign: false });
    if (phase === "route") {
      const resolveRoute = harness.ports.provider.resolveRoute;
      harness.ports.provider.resolveRoute = async (...args) => {
        entered();
        await gate;
        return resolveRoute(...args);
      };
    } else if (phase === "reservation") {
      const reserve = harness.ports.metering.reserveAttempt.bind(harness.ports.metering);
      harness.ports.metering.reserveAttempt = async (input) => {
        const result = await reserve(input);
        entered();
        await gate;
        return result;
      };
    } else {
      const mark = harness.ports.metering.markAttemptInFlight.bind(harness.ports.metering);
      harness.ports.metering.markAttemptInFlight = async (input) => {
        const result = await mark(input);
        entered();
        await gate;
        return result;
      };
    }
    const operation = harness.api.invoke(actor(), generationRequest(`action-cancel-${phase}`));
    await waiting;
    const target = [...harness.state.jobs.values()].find((job) => job.action_id === `action-cancel-${phase}`);
    const cancelled = await harness.api.invoke(actor(), request("cancel", { job_id: target.job_id }, `cancel-${phase}`));
    assert.equal(cancelled.ok, true, `${phase}: ${JSON.stringify(cancelled)}`);
    release();
    const result = await operation;
    assert.equal(result.error.code, "cancelled", `${phase}: ${JSON.stringify(result)}`);
    assert.equal(harness.state.calls.provider, 0, `${phase}: provider must not receive a call`);
    assert.equal(harness.state.dispatchIntents.length, 0, `${phase}: cancellation must precede intent`);
  }
});

test("lease replacement before intent authorization prevents every provider call", async () => {
  await loadPlans();
  const harness = await setup({ withDesign: false });
  const authorize = harness.ports.jobs.authorizeDispatch.bind(harness.ports.jobs);
  harness.ports.jobs.authorizeDispatch = async (input) => {
    harness.state.leaseTokens.set(input.job_id, "replacement-lease");
    return authorize(input);
  };
  const result = await harness.api.invoke(actor(), generationRequest("action-replaced-lease"));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "cancelled");
  assert.equal(harness.state.calls.provider, 0);
  assert.equal(harness.state.dispatchIntents.length, 0);
});

test("a transport intent authorized before cancellation retains usage and blocks later retry transport", async () => {
  await loadPlans();
  let harness;
  let retryWasBlocked = false;
  harness = await setup({ withDesign: false, providerImpl: async (_operation, input) => {
    const target = [...harness.state.jobs.values()].find((job) => job.action_id === "action-cancel-after-intent");
    const cancelled = await harness.api.invoke(actor(), request("cancel", { job_id: target.job_id }, "cancel-after-intent"));
    assert.equal(cancelled.ok, true);
    try {
      await input.recordTransportAttempt("transport:retry-after-cancel");
    } catch {
      retryWasBlocked = true;
    }
    return {
      design_version_id: "generated-after-cancel",
      artifact: {
        artifact_id: "generated-artifact-after-cancel",
        content_hash: `sha256:${"e".repeat(64)}`,
        media_type: "image/png",
      },
      provider: "fixture-provider",
      model: "fixture-model",
      usage: { completeness: "complete", input_tokens: 12, output_tokens: 24 },
    };
  } });
  const result = await harness.api.invoke(actor(), generationRequest("action-cancel-after-intent"));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "cancelled");
  assert.equal(retryWasBlocked, true);
  assert.equal(harness.state.dispatchIntents.length, 1);
  assert.equal(harness.state.calls.provider, 1);
  assert.equal(harness.state.calls.usage[0].completeness, "complete");
});

test("cancel validates the scoped target job before invoking its cancellation port", async () => {
  await loadPlans();
  const harness = await setup();
  harness.state.jobs.set("job-incomplete", {
    job_id: "job-incomplete", tenant_id: "tenant-api-1", project_id: "project-api-1",
    actor_id: "actor-api-1", operation: "generate", request_hash: "request-hash-fixture", status: "running",
  });
  const response = await harness.api.invoke(actor(), request("cancel", { job_id: "job-incomplete" }, "cancel-incomplete"));
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "not_found");
  assert.equal(harness.state.calls.cancel, 0);
});

test("trace failures do not turn a committed operation into an API failure", async () => {
  await loadPlans();
  const harness = await setup({ withDesign: false });
  harness.ports.trace.record = async () => { throw new Error("trace transport token must stay private"); };
  const response = await harness.api.invoke(actor(), generationRequest("action-trace-failure"));
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.job.status, "completed");
  assert.equal(harness.state.calls.provider, 1);
  assert.equal(JSON.stringify(response).includes("trace transport token"), false);
});

test("trace projection drops sensitive references and maps unknown operations to unknown", async () => {
  await loadPlans();
  const harness = await setup({ withDesign: false });
  const body = generationRequest("action-trace-private-reference");
  body.request_id = "Bearer synthetic-private-request-token";
  const completed = await harness.api.invoke(actor(), body);
  assert.equal(completed.ok, true, JSON.stringify(completed));
  assert.equal(JSON.stringify(harness.state.calls.traces).includes("synthetic-private-request-token"), false);
  for (const event of harness.state.calls.traces) assert.equal(Object.hasOwn(event, "request_id"), false);

  harness.state.calls.traces.length = 0;
  const malformed = generationRequest("action-trace-private-operation");
  malformed.operation = "Bearer synthetic-private-operation-token";
  const rejected = await harness.api.invoke(actor(), malformed);
  assert.equal(rejected.ok, false);
  assert.equal(JSON.stringify(harness.state.calls.traces).includes("synthetic-private-operation-token"), false);
  assert.ok(harness.state.calls.traces.every((event) => event.operation === "unknown"));
});

test("stale metered inspection is reconciled but never published", async () => {
  await loadPlans();
  const harness = await setup();
  const inspect = harness.ports.inspection.inspect;
  harness.ports.inspection.inspect = async (input) => ({ ...(await inspect(input)), design_hash: `sha256:${"0".repeat(64)}` });
  const response = await harness.api.invoke(actor(), request("inspect", {
    brief_id: "brief-api-1", design_version_id: "design-api-1",
  }, "inspect-stale-output"));
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "stale_version");
  assert.equal(harness.state.calls.inspection, 1);
  assert.equal(harness.state.calls.usage.length, 1);
  const job = [...harness.state.jobs.values()].find((entry) => entry.action_id === "inspect-stale-output");
  assert.equal(job.status, "failed");
  assert.equal(job.result, undefined);
});

test("inspection publication fence rejects brief drift after metered observation", async () => {
  await loadPlans();
  const harness = await setup();
  const complete = harness.ports.jobs.completeIfActive.bind(harness.ports.jobs);
  harness.ports.jobs.completeIfActive = async (input, persist) => {
    harness.state.brief.facts.verified[0].value = "Changed before inspection publication";
    return complete(input, persist);
  };
  const response = await harness.api.invoke(actor(), request("inspect", {
    brief_id: "brief-api-1", design_version_id: "design-api-1",
  }, "inspect-brief-drift-publication"));
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "stale_version");
  assert.equal(harness.state.calls.inspection, 1);
  assert.equal(harness.state.calls.usage.length, 1);
  const job = [...harness.state.jobs.values()].find((entry) => entry.action_id === "inspect-brief-drift-publication");
  assert.equal(job.status, "failed");
  assert.equal(job.result, undefined);
});

test("brief drift after provider route is rejected before reservation or transport", async () => {
  await loadPlans();
  const harness = await setup({ withDesign: false });
  harness.ports.provider.resolveRoute = () => {
    harness.state.brief.facts.verified[0].value = "Changed during route resolution";
    return { retry_mapping_ref: "retry:image-v1", provider: {
      name: "fixture-provider", model: "fixture-model", endpoint: "test:/image", sdk: { name: "fixture-sdk", version: "1.0" },
    } };
  };
  const response = await harness.api.invoke(actor(), generationRequest("brief-drift-in-route"));
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "stale_version");
  assert.equal(harness.state.calls.reserve, 0);
  assert.equal(harness.state.calls.provider, 0);
  assert.equal(harness.state.dispatchIntents.length, 0);
});

test("atomic dispatch authorization rejects context drift immediately before intent insertion", async () => {
  await loadPlans();
  const harness = await setup({ withDesign: false });
  const authorize = harness.ports.jobs.authorizeDispatch.bind(harness.ports.jobs);
  harness.ports.jobs.authorizeDispatch = async (input) => {
    harness.state.brief.facts.verified[0].value = "Changed inside authorization transaction";
    return authorize(input);
  };
  const response = await harness.api.invoke(actor(), generationRequest("brief-drift-in-auth"));
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "stale_version");
  assert.equal(harness.state.calls.provider, 0);
  assert.equal(harness.state.dispatchIntents.length, 0);
  assert.equal(harness.state.calls.usage.length, 0);
});

test("storage compare-and-set rejects brief drift at design publication", async () => {
  await loadPlans();
  const harness = await setup({ withDesign: false });
  const save = harness.ports.storage.saveDesignVersion.bind(harness.ports.storage);
  harness.ports.storage.saveDesignVersion = (input) => {
    harness.state.brief.facts.verified[0].value = "Changed at publication CAS";
    return save(input);
  };
  const response = await harness.api.invoke(actor(), generationRequest("brief-drift-in-storage"));
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "stale_version");
  assert.equal(harness.state.calls.provider, 1);
  assert.equal(harness.state.calls.usage.length, 1);
  assert.equal(harness.state.designs.size, 0);
  assert.equal(harness.state.current.has("brief-api-1"), false);
});

test("handoff requires a scoped approval for the exact immutable version hash", async () => {
  await loadPlans();
  const harness = await setup();
  const response = await harness.api.invoke(actor(), request("handoff", {
    brief_id: "brief-api-1", design_version_id: "design-api-1", approval_ref: "approval-exact-1", destination_ref: "production-queue-1",
  }, "action-handoff-1"));
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(harness.state.calls.approval, 2);
  assert.equal(harness.state.calls.handoff, 1);
  assert.equal(response.result.receipt.status, "consumed_exact_bytes");
  assert.equal(response.result.handoff.binding.design_version.design_version_id, "design-api-1");
  const foreign = await setup();
  foreign.ports.approval.verifyApproval = () => ({ status: "rejected" });
  const denied = await foreign.api.invoke(actor(), request("handoff", {
    brief_id: "brief-api-1", design_version_id: "design-api-1", approval_ref: "approval-forged", destination_ref: "production-queue-1",
  }, "action-handoff-forged"));
  assert.equal(denied.error.code, "permission_denied");
  assert.equal(foreign.state.calls.handoff, 0);
});

test("completed handoff replay remains valid after approval expiry without a second submission", async () => {
  await loadPlans();
  const clock = { now: NOW };
  const harness = await setup({ clock });
  const body = request("handoff", {
    brief_id: "brief-api-1", design_version_id: "design-api-1", approval_ref: "approval-historical-1", destination_ref: "production-queue-1",
  }, "action-handoff-historical-replay");
  const trustedActor = actor({ expires_at: "2026-10-14T00:00:00.000Z" });
  const first = await harness.api.invoke(trustedActor, body);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(harness.state.calls.handoff, 1);
  const stored = [...harness.state.jobs.values()].find((job) => job.action_id === body.action_id);
  assert.equal(typeof stored.result.handoff_created_at, "string");
  assert.equal(Object.hasOwn(first.result, "handoff_created_at"), false);

  harness.state.clock.now = Date.parse("2026-10-12T12:30:00.000Z");
  const replay = structuredClone(body);
  replay.event_id += ":replay";
  replay.request_id += ":replay";
  replay.correlation_id += ":replay";
  const result = await harness.api.invoke(trustedActor, replay);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.replayed, true);
  assert.equal(result.result.receipt.status, "consumed_exact_bytes");
  assert.equal(harness.state.calls.handoff, 1);
  assert.equal(harness.state.calls.approval, 2);
});

test("receipt consumed before approval expiry remains valid when its response arrives later", async () => {
  await loadPlans();
  const clock = { now: NOW };
  const harness = await setup({ clock });
  const submit = harness.ports.handoff.submit;
  harness.ports.handoff.submit = async (input) => {
    const receipt = await submit(input);
    clock.now = Date.parse("2026-10-12T12:30:00.000Z");
    return receipt;
  };
  const body = request("handoff", {
    brief_id: "brief-api-1", design_version_id: "design-api-1", approval_ref: "approval-late-receipt-1", destination_ref: "production-queue-1",
  }, "action-handoff-late-receipt");
  const response = await harness.api.invoke(actor({ expires_at: "2026-10-14T00:00:00.000Z" }), body);
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.result.receipt.consumed_at, "2026-10-10T12:30:00.000Z");
  assert.equal(harness.state.calls.handoff, 1);
  const job = [...harness.state.jobs.values()].find((entry) => entry.action_id === body.action_id);
  assert.equal(job.status, "completed");
});

test("handoff receipt timestamps reject future, pre-issue, pre-creation, and expired values", async () => {
  await loadPlans();
  const invalidCases = [
    { name: "future", consumed_at: "2026-10-11T12:30:00.000Z", now: NOW },
    { name: "pre-creation", consumed_at: "2026-10-10T12:29:59.000Z", now: NOW },
  ];
  for (const [index, invalid] of invalidCases.entries()) {
    const clock = { now: NOW };
    const harness = await setup({ clock });
    const body = request("handoff", {
      brief_id: "brief-api-1", design_version_id: "design-api-1", approval_ref: `approval-invalid-time-${index}`, destination_ref: "production-queue-1",
    }, `action-handoff-invalid-time-${index}`);
    const originalSubmit = harness.ports.handoff.submit;
    harness.ports.handoff.submit = (input) => {
      const receipt = originalSubmit(input);
      receipt.consumed_at = invalid.consumed_at;
      return receipt;
    };
    const response = await harness.api.invoke(actor({ expires_at: "2026-10-14T00:00:00.000Z" }), body);
    assert.equal(response.ok, false, invalid.name);
    assert.equal(response.error.code, "failed", invalid.name);
    assert.equal(harness.state.calls.handoff, 1, invalid.name);
  }

  const corruptedReplayCases = [
    { name: "future", now: "2026-10-12T12:30:00.000Z", consumed_at: "2026-10-13T12:30:00.000Z" },
    { name: "pre-issue", now: "2026-10-12T12:30:00.000Z", consumed_at: "2026-10-10T11:59:59.000Z",
      handoff_created_at: "2026-10-10T11:30:00.000Z" },
    { name: "pre-creation", now: "2026-10-12T12:30:00.000Z", consumed_at: "2026-10-10T12:29:59.000Z" },
    { name: "at-expiry", now: "2026-10-12T12:30:00.000Z", consumed_at: "2026-10-11T12:00:00.000Z" },
  ];
  for (const [index, invalid] of corruptedReplayCases.entries()) {
    const clock = { now: NOW };
    const replayHarness = await setup({ clock });
    const replayBody = request("handoff", {
      brief_id: "brief-api-1", design_version_id: "design-api-1", approval_ref: `approval-corrupt-time-${index}`, destination_ref: "production-queue-1",
    }, `action-handoff-corrupt-time-${index}`);
    const completed = await replayHarness.api.invoke(actor({ expires_at: "2026-10-14T00:00:00.000Z" }), replayBody);
    assert.equal(completed.ok, true, JSON.stringify(completed));
    const stored = [...replayHarness.state.jobs.values()].find((job) => job.action_id === replayBody.action_id);
    stored.result = structuredClone(stored.result);
    stored.result.receipt.consumed_at = invalid.consumed_at;
    if (invalid.handoff_created_at) stored.result.handoff_created_at = invalid.handoff_created_at;
    clock.now = Date.parse(invalid.now);
    const replay = structuredClone(replayBody);
    replay.event_id += ":replay";
    replay.request_id += ":replay";
    replay.correlation_id += ":replay";
    const rejected = await replayHarness.api.invoke(actor({ expires_at: "2026-10-14T00:00:00.000Z" }), replay);
    assert.equal(rejected.ok, false, invalid.name);
    assert.equal(rejected.error.code, "unavailable", invalid.name);
  }
});

test("handoff rechecks the exact approval binding after an asynchronous verifier call", async () => {
  await loadPlans();
  const harness = await setup();
  const verify = harness.ports.approval.verifyApproval;
  let mutated = false;
  harness.ports.approval.verifyApproval = async (input) => {
    const result = await verify(input);
    if (!mutated) {
      await Promise.resolve();
      const context = harness.state.handoffContexts.get("design-api-1");
      context.binding.preview_sha256 = "f".repeat(64);
      mutated = true;
    }
    return result;
  };
  const response = await harness.api.invoke(actor(), request("handoff", {
    brief_id: "brief-api-1", design_version_id: "design-api-1", approval_ref: "approval-race", destination_ref: "production-queue-1",
  }, "action-handoff-race"));
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "stale_version");
  assert.equal(harness.state.calls.handoff, 0);
});

test("handoff revalidates approval after dispatch authorization before consumer submission", async () => {
  await loadPlans();
  const harness = await setup();
  const authorize = harness.ports.jobs.authorizeDispatch.bind(harness.ports.jobs);
  harness.ports.jobs.authorizeDispatch = async (input) => {
    const result = await authorize(input);
    harness.ports.approval.verifyApproval = () => ({ status: "rejected" });
    return result;
  };
  const response = await harness.api.invoke(actor(), request("handoff", {
    brief_id: "brief-api-1", design_version_id: "design-api-1", approval_ref: "approval-revoked", destination_ref: "production-queue-1",
  }, "action-handoff-revoked-after-authorize"));
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "permission_denied");
  assert.equal(harness.state.calls.handoff, 0);
});

test("job status cannot disclose another project's operation", async () => {
  await loadPlans();
  const harness = await setup();
  harness.state.jobs.set("job-foreign", { job_id: "job-foreign", tenant_id: "tenant-api-1", project_id: "other-project", status: "completed" });
  const response = await harness.api.invoke(actor(), request("job.status", { job_id: "job-foreign" }));
  assert.equal(response.error.code, "not_found");
});

test("job status rejects sensitive stored public references", async () => {
  await loadPlans();
  const harness = await setup();
  const signedReference = "https://private.invalid/artifact?signature=synthetic-private-value";
  harness.state.jobs.set("job-signed-result", {
    job_id: "job-signed-result", tenant_id: "tenant-api-1", project_id: "project-api-1",
    actor_id: "actor-api-1", action_id: "action-signed-result", operation: "generate",
    request_hash: "hash-signed-result", status: "completed", result_ref: signedReference,
  });
  const response = await harness.api.invoke(actor(), request("job.status", { job_id: "job-signed-result" }));
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "unavailable");
  assert.equal(JSON.stringify(response).includes(signedReference), false);
});

test("typed read-port errors and persisted job diagnostics sanitize field paths and messages", async () => {
  await loadPlans();
  const markers = ["Bearer unsafe-field-token", "sk-abcdefghijklmnopqrstuvwxyz1234", "owner@example.test"];
  for (const marker of markers) {
    const fieldPath = `input.${marker}`;
    const typedErrors = [
      new ContractError("invalid_type", "CreativeBrief", fieldPath, marker),
      new ApprovalHandoffContractError("approval_invalid", marker, { field: fieldPath }),
      new MeteringContractError("invalid_reservation", fieldPath, marker),
      new CreativeApiError("invalid_request", "list", fieldPath),
    ];
    for (const [index, typedError] of typedErrors.entries()) {
      const harness = await setup();
      harness.ports.storage.getBrief = () => { throw typedError; };
      const response = await harness.api.invoke(actor(), request("list", { brief_id: "brief-api-1" }, undefined));
      assert.equal(response.ok, false, `typed error ${marker} ${index}`);
      assert.equal(JSON.stringify(response).includes(marker), false, `typed error ${marker} ${index}`);
      assert.notEqual(response.error.field, fieldPath);
      assert.notEqual(response.error.message, marker);
    }
  }

  const marker = "Bearer unsafe-field-token";
  const harness = await setup();
  harness.state.jobs.set("job-private-error", {
    job_id: "job-private-error", tenant_id: "tenant-api-1", project_id: "project-api-1",
    actor_id: "actor-api-1", action_id: "action-private-error", operation: "generate",
    request_hash: "hash-private-error", status: "failed",
    error: { code: "invalid_request", field: marker, message: marker, diagnostic_ref: marker },
  });
  const status = await harness.api.invoke(actor(), request("job.status", { job_id: "job-private-error" }));
  assert.equal(status.ok, true, JSON.stringify(status));
  assert.equal(status.job.error.field, "");
  assert.equal(status.job.error.message.includes(marker), false);
  assert.equal(JSON.stringify(status).includes(marker), false);
});

test("missing provider and decision ports fail closed without reporting a completed job", async () => {
  await loadPlans();
  const missingProvider = await setup({ withDesign: false, omit: ["provider"] });
  const unavailable = await missingProvider.api.invoke(actor(), generationRequest("action-no-provider"));
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.error.code, "unavailable");
  assert.equal(missingProvider.state.calls.provider, 0);
  assert.equal(missingProvider.state.calls.reserve, 0);

  const missingDecision = await setup({ withDesign: false, omit: ["decisionPort"] });
  const requestWithDecision = generationRequest("action-no-decision");
  requestWithDecision.payload.decision_request = validDecisionInput();
  const decisionUnavailable = await missingDecision.api.invoke(actor(), requestWithDecision);
  assert.equal(decisionUnavailable.error.code, "unavailable");
  assert.equal(missingDecision.state.calls.provider, 0);
  assert.equal(missingDecision.state.calls.reserve, 0);

  const missingDispatchFence = await setup({ withDesign: false });
  delete missingDispatchFence.ports.jobs.authorizeDispatch;
  const dispatchUnavailable = await missingDispatchFence.api.invoke(actor(), generationRequest("action-no-dispatch-fence"));
  assert.equal(dispatchUnavailable.error.code, "unavailable");
  assert.equal(missingDispatchFence.state.calls.provider, 0);
  assert.equal(missingDispatchFence.state.calls.reserve, 1);
});

test("missing durable telemetry fails closed before reservation or provider dispatch", async () => {
  const missing = await setup({ withDesign: false, omit: ["telemetry"] });
  const response = await missing.api.invoke(actor(), generationRequest("action-no-telemetry"));
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "unavailable");
  assert.equal(missing.state.calls.reserve, 0);
  assert.equal(missing.state.calls.provider, 0);
  assert.equal(missing.state.current.get(missing.state.brief.brief_id), undefined);
});

test("missing explicit usage profile fails before reservation or provider dispatch", async () => {
  const harness = await setup({ withDesign: false });
  delete harness.ports.telemetry.usage_profiles.image_generation;
  const response = await harness.api.invoke(actor(), generationRequest("action-no-usage-profile"));
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "unavailable");
  assert.equal(harness.state.calls.reserve, 0);
  assert.equal(harness.state.calls.provider, 0);
});

test("decision execution binds the exact reserved attempt and uses the pinned JEV route", async () => {
  await loadPlans();
  const harness = await setup({ withDesign: false });
  const body = generationRequest("action-decision-success");
  body.payload.decision_request = validDecisionInput();
  const response = await harness.api.invoke(actor(), body);
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(harness.state.calls.decision, 1);
  assert.equal(harness.state.calls.reserve, 2);
  assert.equal(harness.state.calls.usage.length, 2);
  assert.equal(harness.state.authority.reservations.has(harness.state.calls.decisionReservationRefs[0]), true);
});

test("inspection receives a declared initial transport ID and usage can omit it", async () => {
  await loadPlans();
  const harness = await setup();
  const inspect = harness.ports.inspection.inspect;
  let observedInputId;
  harness.ports.inspection.inspect = async (input) => {
    observedInputId = input.transport_attempt_id;
    const output = await inspect(input);
    const { transport_attempt_id: _transportAttemptId, ...usage } = output.usage;
    return { ...output, usage };
  };
  const response = await harness.api.invoke(actor(), request("inspect", {
    brief_id: "brief-api-1", design_version_id: "design-api-1",
  }, "inspect-initial-transport-id"));
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(typeof observedInputId, "string");
  assert.equal(harness.state.calls.usage[0].transport_attempt_id, observedInputId);
});

test("a 256-character reservation ID is passed unchanged and rejected before JEV transport", async () => {
  await loadPlans();
  const harness = await setup({ withDesign: false, longReservationId: true });
  const body = generationRequest("action-decision-long-reservation");
  body.payload.decision_request = validDecisionInput();
  const response = await harness.api.invoke(actor(), body);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "unavailable");
  assert.equal(harness.state.calls.decision, 0);
  assert.equal(harness.state.calls.provider, 0);
  const held = [...harness.state.authority.reservations.values()].find((entry) => entry.state === "held_for_reconciliation");
  assert.ok(held);
  assert.equal(held.reservation_id, "r".repeat(256));
});

test("port failure messages and malformed provider usage never leak or become zero usage", async () => {
  await loadPlans();
  const failing = await setup({ withDesign: false, providerImpl: async () => { throw new Error("secret-admission-token"); } });
  const response = await failing.api.invoke(actor(), generationRequest("action-provider-error"));
  assert.equal(response.error.code, "unavailable");
  assert.equal(JSON.stringify(response).includes("secret-admission-token"), false);
  assert.equal(failing.state.calls.usage.length, 0);

  const malformed = await setup({ withDesign: false, providerImpl: async () => ({
    design_version_id: "design-malformed-usage",
    artifact: { artifact_id: "artifact-malformed-usage", content_hash: `sha256:${"a".repeat(64)}`, media_type: "image/png" },
    provider: "fixture-provider", model: "fixture-model", usage: { completeness: "complete", input_tokens: -1 },
  }) });
  const invalidUsage = await malformed.api.invoke(actor(), generationRequest("action-malformed-usage"));
  assert.equal(invalidUsage.ok, false);
  assert.equal(invalidUsage.error.code, "unavailable");
  assert.equal(malformed.state.calls.usage[0].completeness, "unknown");
  assert.equal((malformed.state.calls.usage[0].usage_units ?? []).some((unit) => unit.name === "input_tokens"), false);
  assert.ok(malformed.state.calls.usage[0].missing_fields.includes("usage.input_tokens.invalid"));
});

test("asset inputs require the action-specific granted permission", async () => {
  await loadPlans();
  const harness = await setup();
  const plan = boundEditPlan(harness.state);
  plan.steps[0].action = "composition.update";
  plan.operation = "composition.update";
  plan.steps[0].parameters = { design_version_id: "design-api-1", changes: [
    { field: "logo", value: "asset-api-1", asset_id: "asset-api-1" },
  ] };
  plan.expected_result.parent_version_id = "design-api-1";
  harness.state.brief.permissions.items = harness.state.brief.permissions.items.filter((item) => item.action !== "modify");
  const editedBriefHash = canonicalHash(harness.state.brief);
  const baseDesign = harness.state.designs.get("design-api-1");
  const amendedDesign = versionFrom(baseDesign, { brief_hash: editedBriefHash });
  harness.state.designs.set(amendedDesign.design_version_id, amendedDesign);
  plan.base.brief_hash = editedBriefHash;
  plan.base.design_hash = amendedDesign.design_hash;
  const output = await harness.api.invoke(actor(), request("edit", {
    brief_id: "brief-api-1", design_version_id: "design-api-1", plan,
  }, "action-asset-permission"));
  assert.equal(output.error.code, "permission_denied");
  assert.equal(harness.state.calls.provider, 0);
});

test("valid deterministic composition updates fail unavailable before image route or reservation", async () => {
  await loadPlans();
  const harness = await setup();
  const plan = boundEditPlan(harness.state);
  plan.steps[0].action = "composition.update";
  plan.operation = "composition.update";
  plan.steps[0].parameters = { design_version_id: "design-api-1", changes: [
    { field: "layout", value: "centered" },
  ] };
  plan.expected_result.parent_version_id = "design-api-1";
  let routeCalls = 0;
  harness.ports.provider.resolveRoute = () => { routeCalls += 1; throw new Error("image route must not run"); };
  const response = await harness.api.invoke(actor(), request("edit", {
    brief_id: "brief-api-1", design_version_id: "design-api-1", plan,
  }, "composition-update-unavailable"));
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "unavailable");
  assert.equal(response.error.field, "composition_executor");
  assert.equal(routeCalls, 0);
  assert.equal(harness.state.calls.reserve, 0);
  assert.equal(harness.state.calls.provider, 0);
});

test("valid research corrections fail unavailable before decision, route, reservation, or image transport", async () => {
  await loadPlans();
  const harness = await setup();
  const plan = boundEditPlan(harness.state);
  plan.steps[0].action = "correction.apply";
  plan.operation = "correction.apply";
  plan.steps[0].parameters = {
    design_version_id: "design-api-1",
    fact_id: "fact-api-1",
    replacement_value: "Unverified replacement event name",
    evidence_refs: ["source-api-1"],
  };
  plan.expected_result.parent_version_id = "design-api-1";
  let routeCalls = 0;
  harness.ports.provider.resolveRoute = () => { routeCalls += 1; throw new Error("image route must not run"); };
  const body = request("edit", {
    brief_id: "brief-api-1", design_version_id: "design-api-1", plan,
    decision_request: validDecisionInput(),
  }, "correction-apply-unavailable");
  const response = await harness.api.invoke(actor(), body);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "unavailable");
  assert.equal(response.error.field, "correction_handoff");
  assert.equal(harness.state.calls.decision, 0);
  assert.equal(routeCalls, 0);
  assert.equal(harness.state.calls.reserve, 0);
  assert.equal(harness.state.calls.provider, 0);
});

test("nested correction and composition steps cannot pass as an image edit", async () => {
  await loadPlans();
  for (const [action, parameters] of [
    ["composition.update", { design_version_id: "design-api-1", changes: [{ field: "layout", value: "centered" }] }],
    ["correction.apply", { design_version_id: "design-api-1", fact_id: "fact-api-1",
      replacement_value: "Unverified replacement", evidence_refs: ["source-api-1"] }],
  ]) {
    const harness = await setup();
    const plan = boundEditPlan(harness.state);
    plan.operation = "image.edit";
    plan.steps[0].action = action;
    plan.steps[0].parameters = parameters;
    let routeCalls = 0;
    harness.ports.provider.resolveRoute = () => { routeCalls += 1; throw new Error("nested action must not route"); };
    const response = await harness.api.invoke(actor(), request("edit", {
      brief_id: "brief-api-1", design_version_id: "design-api-1", plan,
      decision_request: validDecisionInput(),
    }, `nested-${action}`));
    assert.equal(response.ok, false, action);
    assert.equal(harness.state.calls.decision, 0, action);
    assert.equal(routeCalls, 0, action);
    assert.equal(harness.state.calls.reserve, 0, action);
    assert.equal(harness.state.calls.provider, 0, action);
  }
});
