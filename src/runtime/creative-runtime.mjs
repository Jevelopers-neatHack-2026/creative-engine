import {
  ContractError,
  canonicalHash,
  canonicalSerialize,
  validateCreativeBrief,
  validateDesignVersion,
  validateEditPlan,
  computeDesignVersionHash,
} from "../contracts/index.mjs";
import {
  validateDecisionRequest,
  validateDecisionResult,
  PINNED_JEV_MODEL_ID,
} from "../contracts/decision-port/v1.mjs";
import {
  ApprovalHandoffContractError,
  createArtworkHandoff,
  hashCompositionLayerManifest,
  validateArtworkHandoff,
  validateApprovalBinding,
  validateConsumptionReceipt,
  verifyHandoffApproval,
} from "../contracts/approval-handoff.mjs";
import {
  MeteringContractError,
  METERING_PROPOSAL_VERSION,
  executeMeteredAttempt,
} from "../contracts/metering.mjs";

export const CREATIVE_API_VERSION = "1.0";
export const CREATIVE_API_OPERATIONS = Object.freeze([
  "generate", "edit", "inspect", "list", "compare", "restore", "cancel", "handoff", "job.status",
]);

const MUTATIONS = new Set(["generate", "edit", "inspect", "restore", "cancel", "handoff"]);
const READ_OPERATIONS = new Set(["list", "compare", "job.status"]);
const OPERATION_PERMISSION = Object.freeze({
  generate: "creative.generate",
  edit: "creative.edit",
  inspect: "creative.read",
  list: "creative.read",
  compare: "creative.read",
  restore: "creative.restore",
  cancel: "creative.cancel",
  handoff: "creative.handoff",
  "job.status": "creative.read",
});
const REQUEST_KEYS = [
  "contract", "schema_version", "event_id", "request_id", "tenant_id", "project_id",
  "correlation_id", "producer", "occurred_at", "ingested_at", "environment", "billing_mode",
  "source_refs", "operation", "action_id", "payload",
];
const REQUEST_CONTRACT = "CreativeApiRequest";
const ERROR_MESSAGES = Object.freeze({
  invalid_request: "The request does not match the supported API contract.",
  unsupported_version: "The requested API version is not supported.",
  unauthorized: "Trusted application context is missing or expired.",
  permission_denied: "The trusted application context does not allow this operation.",
  scope_denied: "The requested resource is outside the trusted project scope.",
  not_found: "The scoped resource was not found.",
  conflict: "The operation identity conflicts with an existing operation.",
  stale_version: "The requested design version is no longer current.",
  unavailable: "A required service is unavailable; no successful result was produced.",
  budget_unavailable: "The budget authority did not authorize this operation.",
  cancelled: "The operation was cancelled before publication.",
  review_required: "The requested action requires review before it can continue.",
  failed: "The operation could not be completed.",
});
const MAX_PORT_WAIT_MS = 30_000;
const DECISION_POLICY_VERSION = "creative-engine-decision/1";

export class CreativeApiError extends Error {
  constructor(code, operation = "unknown", field = "", options = {}) {
    super(ERROR_MESSAGES[code] ?? ERROR_MESSAGES.failed);
    this.name = "CreativeApiError";
    this.code = code;
    this.module = "creative-engine.api";
    this.operation = operation;
    this.field = field;
    this.retryable = Boolean(options.retryable);
    if (options.diagnostic_ref) this.diagnostic_ref = options.diagnostic_ref;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function immutableRequestSnapshot(value) {
  const snapshot = JSON.parse(canonicalSerialize(value));
  const freeze = (current) => {
    if (current !== null && typeof current === "object") {
      for (const child of Object.values(current)) freeze(child);
      Object.freeze(current);
    }
    return current;
  };
  return freeze(snapshot);
}

function boundedString(value, field, max = 200) {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw new CreativeApiError("invalid_request", "unknown", field);
  }
  return value;
}

const SENSITIVE_PUBLIC_TEXT = [
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}/i,
  /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|secret|password|authorization|credential|cookie)\s*[:=]\s*["']?[^\s"'&,;]+/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/i,
  /https?:\/\/[^\s"'<>]+[?&][^=\s&#]*(?:signature|sig|token|credential|secret|access[_-]?key|auth)[^=\s&#]*=[^&#\s]+/i,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /(?<!\d)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\d)/,
];

function hasSensitivePublicText(value) {
  return SENSITIVE_PUBLIC_TEXT.some((pattern) => pattern.test(value));
}

function publicReference(value, field, operation, max = 512) {
  if (typeof value !== "string" || value.trim() === "" || value.length > max ||
    !/^[A-Za-z0-9_.:-]+$/.test(value) || hasSensitivePublicText(value)) {
    throw new CreativeApiError("unavailable", operation, field);
  }
  return value;
}

function traceReference(value) {
  return typeof value === "string" && value.length <= 200 &&
    /^[A-Za-z0-9_.:-]+$/.test(value) && !hasSensitivePublicText(value) ? value : undefined;
}

function safeTraceEvent(event) {
  const safe = {
    event: ["creative_api.request", "creative_api.completed", "creative_api.rejected"].includes(event.event)
      ? event.event : "creative_api.rejected",
    operation: CREATIVE_API_OPERATIONS.includes(event.operation) ? event.operation : "unknown",
  };
  for (const field of ["request_id", "operation_id", "tenant_id", "project_id", "actor_id"]) {
    const value = traceReference(event[field]);
    if (value !== undefined) safe[field] = value;
  }
  if (Object.hasOwn(ERROR_MESSAGES, event.code)) safe.code = event.code;
  return Object.freeze(safe);
}

function inspectionText(value, field, max, operation, stored = false) {
  const valid = typeof value === "string" && value.trim() !== "" && value.length <= max;
  if (!valid || hasSensitivePublicText(value)) {
    throw new CreativeApiError(stored ? "unavailable" : "failed", operation, field);
  }
  return value;
}

function timestampMillis(value) {
  if (typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

function validatedReceiptTime(receipt, trustedNow, operation, stored = false) {
  const consumedAt = isRecord(receipt) ? timestampMillis(receipt.consumed_at) : null;
  const nowMillis = trustedNow instanceof Date ? trustedNow.getTime() : NaN;
  if (consumedAt === null || !Number.isFinite(nowMillis) || consumedAt > nowMillis) {
    throw new CreativeApiError(stored ? "unavailable" : "failed", operation, "receipt.consumed_at");
  }
  return new Date(consumedAt);
}

function assertReceiptWindow(receipt, handoff, handoffCreatedAt, trustedNow, operation, stored = false) {
  const consumedAt = timestampMillis(receipt?.consumed_at);
  const createdAt = timestampMillis(handoffCreatedAt);
  const issuedAt = timestampMillis(handoff?.approval?.issued_at);
  const expiresAt = timestampMillis(handoff?.approval?.expires_at);
  const nowMillis = trustedNow instanceof Date ? trustedNow.getTime() : NaN;
  if (consumedAt === null || createdAt === null || issuedAt === null || expiresAt === null ||
    !Number.isFinite(nowMillis) || createdAt > nowMillis || consumedAt > nowMillis ||
    issuedAt > createdAt || consumedAt < createdAt || consumedAt < issuedAt || consumedAt >= expiresAt) {
    throw new CreativeApiError(stored ? "unavailable" : "failed", operation, "receipt.consumed_at");
  }
}

function assertOnlyKeys(value, allowed, field) {
  if (!isRecord(value)) throw new CreativeApiError("invalid_request", "unknown", field);
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new CreativeApiError("invalid_request", "unknown", field);
  }
}

function assertStoredOnlyKeys(value, allowed, operation, field) {
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new CreativeApiError("unavailable", operation, field);
  }
}

function trustedString(value, field, max = 200) {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw new CreativeApiError("unauthorized", "unknown", field);
  }
  return value;
}

function validatePrincipal(principal, now) {
  if (!isRecord(principal)) throw new CreativeApiError("unauthorized");
  const actor_id = trustedString(principal.actor_id, "actor_id");
  const tenant_id = trustedString(principal.tenant_id, "tenant_id");
  const project_id = trustedString(principal.project_id, "project_id");
  const expires_at = trustedString(principal.expires_at, "expires_at", 40);
  const budget_scope_id = trustedString(principal.budget_scope_id, "budget_scope_id");
  const budget_policy_version = trustedString(principal.budget_policy_version, "budget_policy_version");
  const expiry = Date.parse(expires_at);
  if (!Number.isFinite(expiry) || expiry <= now) throw new CreativeApiError("unauthorized");
  if (!Array.isArray(principal.permissions) || principal.permissions.length > 64 ||
    principal.permissions.some((permission) => typeof permission !== "string" || permission.length > 100)) {
    throw new CreativeApiError("unauthorized");
  }
  return Object.freeze({ actor_id, tenant_id, project_id, expires_at, budget_scope_id, budget_policy_version,
    permissions: [...new Set(principal.permissions)] });
}

function validateRequest(request) {
  assertOnlyKeys(request, REQUEST_KEYS, "request");
  if (request.contract !== REQUEST_CONTRACT) throw new CreativeApiError("invalid_request", "unknown", "contract");
  if (request.schema_version !== CREATIVE_API_VERSION) throw new CreativeApiError("unsupported_version", "unknown", "schema_version");
  boundedString(request.event_id, "event_id");
  boundedString(request.request_id, "request_id");
  boundedString(request.tenant_id, "tenant_id");
  boundedString(request.project_id, "project_id");
  boundedString(request.correlation_id, "correlation_id");
  boundedString(request.producer, "producer");
  for (const key of ["occurred_at", "ingested_at"]) {
    boundedString(request[key], key, 40);
    if (!/^\d{4}-\d\d-\d\dT/.test(request[key]) || !Number.isFinite(Date.parse(request[key]))) {
      throw new CreativeApiError("invalid_request", "unknown", key);
    }
  }
  if (!['development', 'test', 'production'].includes(request.environment) ||
    !['live', 'sandbox', 'simulated'].includes(request.billing_mode)) {
    throw new CreativeApiError("invalid_request", "unknown", "environment_or_billing_mode");
  }
  if (!Array.isArray(request.source_refs) || request.source_refs.length > 100 ||
    request.source_refs.some((ref) => typeof ref !== "string" || ref.length === 0 || ref.length > 300)) {
    throw new CreativeApiError("invalid_request", "unknown", "source_refs");
  }
  if (new Set(request.source_refs).size !== request.source_refs.length) {
    throw new CreativeApiError("invalid_request", "unknown", "source_refs");
  }
  if (!CREATIVE_API_OPERATIONS.includes(request.operation)) throw new CreativeApiError("invalid_request", "unknown", "operation");
  if (MUTATIONS.has(request.operation)) boundedString(request.action_id, "action_id");
  if (request.action_id !== undefined && (typeof request.action_id !== "string" || request.action_id.length > 200)) {
    throw new CreativeApiError("invalid_request", request.operation, "action_id");
  }
  if (!isRecord(request.payload)) throw new CreativeApiError("invalid_request", request.operation, "payload");
  const allowedPayloadKeys = {
    generate: ["brief_id", "plan", "decision_request"],
    edit: ["brief_id", "design_version_id", "plan", "decision_request"],
    inspect: ["brief_id", "design_version_id"],
    list: ["brief_id", "limit", "cursor"],
    compare: ["brief_id", "left_design_version_id", "right_design_version_id"],
    restore: ["brief_id", "target_design_version_id", "expected_selection_revision"],
    cancel: ["job_id"],
    handoff: ["brief_id", "design_version_id", "approval_ref", "destination_ref"],
    "job.status": ["job_id"],
  }[request.operation];
  assertOnlyKeys(request.payload, allowedPayloadKeys, "payload");
  if (READ_OPERATIONS.has(request.operation) || request.operation === "cancel" || request.operation === "handoff") {
    if (Object.keys(request.payload).length === 0) throw new CreativeApiError("invalid_request", request.operation, "payload");
  }
  const requiredPayload = {
    generate: ["brief_id", "plan"],
    edit: ["brief_id", "design_version_id", "plan"],
    inspect: ["brief_id", "design_version_id"],
    list: ["brief_id"],
    compare: ["brief_id", "left_design_version_id", "right_design_version_id"],
    restore: ["brief_id", "target_design_version_id", "expected_selection_revision"],
    cancel: ["job_id"],
    handoff: ["brief_id", "design_version_id", "approval_ref", "destination_ref"],
    "job.status": ["job_id"],
  }[request.operation];
  for (const key of requiredPayload) {
    if (!Object.prototype.hasOwnProperty.call(request.payload, key)) throw new CreativeApiError("invalid_request", request.operation, key);
  }
  if (request.operation === "restore" && (!Number.isSafeInteger(request.payload.expected_selection_revision) ||
    request.payload.expected_selection_revision < 0)) {
    throw new CreativeApiError("invalid_request", request.operation, "payload.expected_selection_revision");
  }
  if (request.operation === "list" && request.payload.cursor !== undefined &&
    (typeof request.payload.cursor !== "string" || request.payload.cursor.length > 1024)) {
    throw new CreativeApiError("invalid_request", request.operation, "cursor");
  }
  for (const key of ["brief_id", "design_version_id", "left_design_version_id", "right_design_version_id",
    "target_design_version_id", "job_id", "approval_ref", "destination_ref"]) {
    if (Object.prototype.hasOwnProperty.call(request.payload, key)) boundedString(request.payload[key], "payload." + key);
  }
  if ((request.operation === "generate" || request.operation === "edit") && !isRecord(request.payload.plan)) {
    throw new CreativeApiError("invalid_request", request.operation, "plan");
  }
  if (request.payload.decision_request !== undefined && !isRecord(request.payload.decision_request)) {
    throw new CreativeApiError("invalid_request", request.operation, "decision_request");
  }
  if (request.payload.limit !== undefined && (!Number.isSafeInteger(request.payload.limit) || request.payload.limit < 1 || request.payload.limit > 100)) {
    throw new CreativeApiError("invalid_request", request.operation, "limit");
  }
  return request;
}

function scopeFor(principal, brief_id) {
  return Object.freeze({
    tenant_id: principal.tenant_id,
    project_id: principal.project_id,
    ...(brief_id ? { brief_id } : {}),
  });
}

function assertRequestScope(principal, request) {
  if (request.tenant_id !== principal.tenant_id || request.project_id !== principal.project_id) {
    throw new CreativeApiError("scope_denied", request.operation);
  }
  if (!principal.permissions.includes(OPERATION_PERMISSION[request.operation])) {
    throw new CreativeApiError("permission_denied", request.operation);
  }
}

function assertScopedRecord(record, scope, operation, expectedBriefId) {
  if (!isRecord(record)) throw new CreativeApiError("failed", operation);
  if (record.tenant_id !== scope.tenant_id || record.project_id !== scope.project_id ||
    (expectedBriefId && record.brief_id !== expectedBriefId)) {
    throw new CreativeApiError("scope_denied", operation);
  }
}

function publicJob(job, operation_id) {
  if (!isRecord(job) || !["queued", "running", "completed", "cancelled", "failed"].includes(job.status)) {
    throw new CreativeApiError("unavailable", "unknown");
  }
  const job_id = publicReference(job.job_id, "job_id", job.operation, 256);
  if (operation_id !== undefined) publicReference(operation_id, "operation_id", job.operation, 256);
  const result_ref = job.result_ref === undefined ? undefined
    : publicReference(job.result_ref, "result_ref", job.operation, 512);
  return Object.freeze({
    contract: "CreativeJob",
    schema_version: "1.0",
    operation_id,
    job_id,
    status: job.status,
    ...(result_ref ? { result_ref } : {}),
    ...(job.error ? { error: safeStoredJobError(job.error, job.operation) } : {}),
  });
}

function safeDiagnosticRef(value, fallback) {
  return typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,200}$/.test(value) &&
    !hasSensitivePublicText(value) ? value : fallback;
}

function safeFieldPath(value) {
  if (typeof value !== "string" || value.length > 120 ||
    !/^[A-Za-z][A-Za-z0-9_-]*(?:\[\d+\])?(?:\.[A-Za-z][A-Za-z0-9_-]*(?:\[\d+\])?)*$/.test(value) ||
    /token|secret|credential|password|api[_-]?key|authorization|cookie|bearer/i.test(value)) return "";
  return value;
}

function creativeContextFence(brief, design = null, expectedCurrentDesignVersionId = undefined) {
  return Object.freeze({
    brief_id: brief.brief_id,
    brief_hash: canonicalHash(brief),
    ...(design ? { design_version_id: design.design_version_id, design_hash: design.design_hash } : {}),
    ...(expectedCurrentDesignVersionId !== undefined ? {
      expected_current_design_version_id: expectedCurrentDesignVersionId,
      expected_current_design_hash: design?.design_hash ?? null,
    } : {}),
  });
}

function safeStoredJobError(error, operation) {
  if (!isRecord(error) || !Object.hasOwn(ERROR_MESSAGES, error.code)) {
    throw new CreativeApiError("unavailable", operation ?? "unknown");
  }
  const field = safeFieldPath(error.field);
  return Object.freeze({
    code: error.code,
    operation: CREATIVE_API_OPERATIONS.includes(operation) ? operation : "unknown",
    module: "creative-engine.api",
    field,
    retryable: error.retryable === true,
    message: ERROR_MESSAGES[error.code],
    diagnostic_ref: safeDiagnosticRef(error.diagnostic_ref, `creative-api:${error.code}`),
  });
}

function normalizeUsage(value) {
  if (!isRecord(value) || !["complete", "partial", "incomplete", "unknown"].includes(value.completeness)) {
    return Object.freeze({ completeness: "unknown", reason: "usage_unavailable" });
  }
  const normalized = { completeness: value.completeness === "partial" ? "incomplete" : value.completeness };
  for (const field of ["input_tokens", "output_tokens"]) {
    if (value[field] === undefined) continue;
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) {
      return Object.freeze({ completeness: "incomplete", reason: "usage_malformed" });
    }
    normalized[field] = value[field];
  }
  return Object.freeze(normalized);
}

function meteredTrustedScope(principal) {
  return Object.freeze({ tenant_id: principal.tenant_id, project_id: principal.project_id,
    budget_scope_id: principal.budget_scope_id });
}

function meteredAttempt(principal, request, attempt_id, operation_kind, route) {
  if (!isRecord(route) || !isRecord(route.provider) || typeof route.retry_mapping_ref !== "string") {
    throw new CreativeApiError("unavailable", request.operation, "provider_route");
  }
  const attempt = {
    schema_version: METERING_PROPOSAL_VERSION,
    ...meteredTrustedScope(principal),
    logical_operation_id: request.action_id,
    billable_attempt_id: attempt_id,
    retry_mapping_ref: route.retry_mapping_ref,
    environment: request.environment,
    billing_mode: request.billing_mode,
    operation_kind,
    budget: { scope_id: principal.budget_scope_id, policy_version: principal.budget_policy_version },
    provider: route.provider,
    correlation_id: request.correlation_id,
  };
  return attempt;
}

function startDeadline(operation, durationMs, clock = Date.now) {
  const controller = new AbortController();
  const deadline_at = new Date(clock() + durationMs).toISOString();
  const timer = setTimeout(() => controller.abort(), durationMs);
  return Object.freeze({
    signal: controller.signal,
    deadline_at,
    dispose: () => clearTimeout(timer),
  });
}

function exactUsageQuantity(value) {
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/.test(value)) return value;
  return undefined;
}

function usageObservation(attempt, rawUsage, idFactory = () => globalThis.crypto.randomUUID()) {
  const usage = isRecord(rawUsage) ? rawUsage : {};
  let completeness = ["complete", "partial", "unknown", "incomplete"].includes(usage.completeness)
    ? usage.completeness : "unknown";
  if (completeness === "incomplete") completeness = "partial";
  const missing = new Set(Array.isArray(usage.missing_fields)
    ? usage.missing_fields.filter((item) => typeof item === "string" && /^[a-zA-Z0-9_.-]{1,120}$/.test(item))
    : []);
  const units = [];
  for (const field of ["input_tokens", "output_tokens"]) {
    if (!Object.hasOwn(usage, field)) {
      if (completeness === "complete") missing.add(field);
      continue;
    }
    const quantity = exactUsageQuantity(usage[field]);
    if (quantity === undefined) {
      missing.add(field);
      continue;
    }
    units.push({ name: field, quantity, relation: "standalone" });
  }
  if (completeness === "unknown") {
    units.length = 0;
    if (missing.size === 0) missing.add("provider_usage");
  } else if (missing.size > 0 || units.length === 0) {
    completeness = units.length === 0 ? "unknown" : "partial";
    if (completeness === "unknown" && missing.size === 0) missing.add("provider_usage");
    if (completeness === "partial" && missing.size === 0) missing.add("provider_usage_completeness");
  }
  const observation = {
    schema_version: METERING_PROPOSAL_VERSION,
    tenant_id: attempt.tenant_id,
    project_id: attempt.project_id,
    budget_scope_id: attempt.budget_scope_id,
    logical_operation_id: attempt.logical_operation_id,
    billable_attempt_id: attempt.billable_attempt_id,
    source_observation_id: "usage:" + idFactory(),
    source: "provider_response",
    provider_name: attempt.provider.name,
    model: attempt.provider.model,
    environment: attempt.environment,
    billing_mode: attempt.billing_mode,
    completeness,
    missing_fields: [...missing],
  };
  if (units.length > 0) observation.usage_units = units;
  if (typeof usage.provider_request_id === "string") observation.provider_request_id = usage.provider_request_id;
  if (typeof usage.transport_attempt_id === "string") observation.transport_attempt_id = usage.transport_attempt_id;
  return observation;
}

function meteringFailure(outcome, operation) {
  if (outcome?.status === "reservation_denied") {
    return new CreativeApiError("budget_unavailable", operation, "budget");
  }
  if (["cancelled_before_dispatch", "cancelled_after_dispatch"].includes(outcome?.status)) {
    return new CreativeApiError("cancelled", operation);
  }
  return new CreativeApiError("unavailable", operation, "metering", { retryable: true });
}

function safeError(error, operation) {
  if (error instanceof CreativeApiError) {
    const operationId = CREATIVE_API_OPERATIONS.includes(error.operation)
      ? error.operation
      : (CREATIVE_API_OPERATIONS.includes(operation) ? operation : "unknown");
    const code = Object.hasOwn(ERROR_MESSAGES, error.code) ? error.code : "failed";
    const field = safeFieldPath(error.field);
    const safe = new CreativeApiError(code, operationId, field, { retryable: error.retryable === true });
    safe.diagnostic_ref = safeDiagnosticRef(error.diagnostic_ref, undefined);
    return safe;
  }
  if (error instanceof ApprovalHandoffContractError) {
    const code = error.code === "verifier_unavailable" ? "unavailable"
      : error.code.includes("scope") ? "scope_denied"
        : error.code.includes("approval") ? "permission_denied" : "invalid_request";
    return new CreativeApiError(code, operation, safeFieldPath(error.field));
  }
  if (error instanceof MeteringContractError) return new CreativeApiError("unavailable", operation, "metering", { retryable: true });
  if (error instanceof ContractError) {
    const code = error.code === "unsupported_version" || error.code === "unsupported_major"
      ? "unsupported_version"
      : (error.code.includes("scope") ? "scope_denied" : "invalid_request");
    return new CreativeApiError(code, operation, safeFieldPath(error.field));
  }
  return new CreativeApiError("failed", operation);
}

function encodeCursor(scope, brief_id, item) {
  const body = JSON.stringify({
    tenant_id: scope.tenant_id,
    project_id: scope.project_id,
    brief_id,
    occurred_at: item.occurred_at,
    design_version_id: item.design_version_id,
  });
  return Buffer.from(body, "utf8").toString("base64url");
}

function decodeCursor(cursor, scope, brief_id) {
  if (cursor === undefined) return undefined;
  boundedString(cursor, "cursor", 1024);
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!isRecord(parsed) || Object.keys(parsed).some((key) => !["tenant_id", "project_id", "brief_id", "occurred_at", "design_version_id"].includes(key)) ||
      parsed.tenant_id !== scope.tenant_id || parsed.project_id !== scope.project_id || parsed.brief_id !== brief_id) {
      throw new Error("scope");
    }
    boundedString(parsed.occurred_at, "cursor.occurred_at", 40);
    if (!/^\d{4}-\d\d-\d\dT/.test(parsed.occurred_at) || !Number.isFinite(Date.parse(parsed.occurred_at))) throw new Error("date");
    boundedString(parsed.design_version_id, "cursor.design_version_id");
    return Object.freeze({ occurred_at: parsed.occurred_at, design_version_id: parsed.design_version_id });
  } catch {
    throw new CreativeApiError("invalid_request", "list", "cursor");
  }
}

function actionRequestHash(request) {
  return canonicalHash({
    contract: request.contract,
    schema_version: request.schema_version,
    tenant_id: request.tenant_id,
    project_id: request.project_id,
    operation: request.operation,
    action_id: request.action_id,
    environment: request.environment,
    billing_mode: request.billing_mode,
    source_refs: request.source_refs,
    payload: request.payload,
  });
}

function compareOrder(a, b) {
  const byTime = b.occurred_at.localeCompare(a.occurred_at);
  return byTime || a.design_version_id.localeCompare(b.design_version_id);
}

function isAfterCursor(item, cursor) {
  return item.occurred_at < cursor.occurred_at ||
    (item.occurred_at === cursor.occurred_at && item.design_version_id > cursor.design_version_id);
}

function requiredPort(ports, path, operation) {
  const found = path.split(".").reduce((current, key) => current?.[key], ports);
  if (typeof found !== "function") throw new CreativeApiError("unavailable", operation, path);
  return found;
}

export function createCreativeApi(options = {}) {
  const ports = options.ports ?? {};
  const now = options.now ?? (() => Date.now());
  const idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
  const emitTrace = async (event) => {
    if (typeof ports.trace?.record === "function") {
      try { await ports.trace.record(safeTraceEvent(event)); } catch { /* trace failure must not expose details */ }
    }
  };
  const failResponse = (error, operation = "unknown") => {
    const safe = safeError(error, operation);
    return Object.freeze({
      ok: false,
      contract: "CreativeApiResponse",
      schema_version: CREATIVE_API_VERSION,
      error: Object.freeze({
        code: safe.code,
        operation: safe.operation,
        module: safe.module,
        field: safe.field,
        retryable: safe.retryable,
        message: safe.message,
        diagnostic_ref: safeDiagnosticRef(safe.diagnostic_ref,
          `creative-api:${safe.code}:${safeDiagnosticRef(idFactory(), "request")}`),
      }),
    });
  };

  async function loadBrief(scope, briefId, operation) {
    boundedString(briefId, "brief_id");
    const getBrief = requiredPort(ports, "storage.getBrief", operation);
    const brief = await getBrief(Object.freeze({ scope, brief_id: briefId }));
    if (!brief) throw new CreativeApiError("not_found", operation, "brief_id");
    assertScopedRecord(brief, scope, operation, briefId);
    return validateCreativeBrief(brief, { trustedScope: scope });
  }

  async function loadDesign(scope, brief, designVersionId, operation) {
    boundedString(designVersionId, "design_version_id");
    const getDesignVersion = requiredPort(ports, "storage.getDesignVersion", operation);
    const design = await getDesignVersion(Object.freeze({ scope, brief_id: brief.brief_id, design_version_id: designVersionId }));
    if (!design) throw new CreativeApiError("not_found", operation, "design_version_id");
    assertScopedRecord(design, scope, operation, brief.brief_id);
    if (design.design_version_id !== designVersionId) throw new CreativeApiError("scope_denied", operation, "design_version_id");
    return validateDesignVersion(design, {
      trustedScope: { ...scope, design_version_id: designVersionId },
      brief_hash: canonicalHash(brief),
      known_source_refs: brief.source_identity.map((source) => source.source_id),
    });
  }

  async function assertCurrentCreativeContext(scope, brief, design, operation, expectedCurrentDesignVersionId = undefined) {
    const currentBrief = await loadBrief(scope, brief.brief_id, operation);
    if (canonicalHash(currentBrief) !== canonicalHash(brief)) {
      throw new CreativeApiError("stale_version", operation, "brief_hash");
    }
    if (design) {
      const currentDesign = await loadDesign(scope, currentBrief, design.design_version_id, operation);
      if (currentDesign.design_hash !== design.design_hash ||
        currentDesign.artifact.content_hash !== design.artifact.content_hash) {
        throw new CreativeApiError("stale_version", operation, "design_hash");
      }
    }
    if (expectedCurrentDesignVersionId !== undefined) {
      const getCurrent = requiredPort(ports, "storage.getCurrentDesignVersion", operation);
      const selected = await getCurrent(Object.freeze({ scope, brief_id: brief.brief_id }));
      if (selected !== null && !isRecord(selected)) throw new CreativeApiError("unavailable", operation, "current_design_version");
      if ((selected?.design_version_id ?? null) !== expectedCurrentDesignVersionId) {
        throw new CreativeApiError("stale_version", operation, "design_version_id");
      }
      if (selected) {
        assertScopedRecord(selected, scope, operation, brief.brief_id);
        const validated = validateDesignVersion(selected, {
          trustedScope: { ...scope, design_version_id: selected.design_version_id },
          brief_hash: canonicalHash(currentBrief),
          known_source_refs: currentBrief.source_identity.map((source) => source.source_id),
        });
        if (design && validated.design_hash !== design.design_hash) {
          throw new CreativeApiError("stale_version", operation, "design_hash");
        }
      }
    }
    return currentBrief;
  }

  async function beginMutation(principal, request) {
    const begin = requiredPort(ports, "jobs.begin", request.operation);
    const scope = scopeFor(principal, request.payload.brief_id);
    const request_hash = actionRequestHash(request);
    const record = await begin(Object.freeze({
      scope,
      actor_id: principal.actor_id,
      action_id: request.action_id,
      request_hash,
      operation: request.operation,
    }));
    if (!isRecord(record) || !["started", "existing", "conflict"].includes(record.kind)) {
      throw new CreativeApiError("unavailable", request.operation);
    }
    if (record.kind === "conflict") throw new CreativeApiError("conflict", request.operation, "action_id");
    if (record.kind === "existing") {
      if (!isRecord(record.job)) throw new CreativeApiError("unavailable", request.operation);
      assertScopedRecord(record.job, scope, request.operation);
      if (record.job.job_id === undefined || record.job.request_hash !== request_hash ||
        record.job.action_id !== request.action_id || record.job.actor_id !== principal.actor_id ||
        record.job.operation !== request.operation) throw new CreativeApiError("conflict", request.operation, "action_id");
      return { replayed: true, scope, request_hash, job: record.job };
    }
    if (typeof record.job_id !== "string" || typeof record.lease_token !== "string") {
      throw new CreativeApiError("unavailable", request.operation);
    }
    return { replayed: false, scope, request_hash, job_id: record.job_id, lease_token: record.lease_token };
  }

  async function publish(principal, request, started, result, persist, publicationFence) {
    const completeIfActive = requiredPort(ports, "jobs.completeIfActive", request.operation);
    const record = await completeIfActive(Object.freeze({
      scope: started.scope,
      actor_id: principal.actor_id,
      job_id: started.job_id,
      lease_token: started.lease_token,
      result,
      publication_fence: publicationFence,
    }), persist);
    if (!isRecord(record)) throw new CreativeApiError("unavailable", request.operation);
    if (record.status === "cancelled") throw new CreativeApiError("cancelled", request.operation);
    if (record.status === "stale_context") throw new CreativeApiError("stale_version", request.operation, "creative_context");
    if (record.status !== "completed" || !record.job) throw new CreativeApiError("unavailable", request.operation);
    assertScopedRecord(record.job, started.scope, request.operation);
    if (record.job.job_id !== started.job_id || record.job.actor_id !== principal.actor_id ||
      record.job.action_id !== request.action_id || record.job.operation !== request.operation ||
      record.job.request_hash !== started.request_hash) throw new CreativeApiError("unavailable", request.operation);
    return record.job;
  }

  function routeFor(route, operation) {
    if (!isRecord(route)) throw new CreativeApiError("unavailable", operation, "provider_route");
    assertOnlyKeys(route, ["retry_mapping_ref", "provider"], "provider_route");
    boundedString(route.retry_mapping_ref, "provider_route.retry_mapping_ref", 256);
    const provider = route.provider;
    assertOnlyKeys(provider, ["name", "model", "endpoint", "sdk"], "provider_route.provider");
    boundedString(provider.name, "provider_route.provider.name", 256);
    boundedString(provider.model, "provider_route.provider.model", 256);
    boundedString(provider.endpoint, "provider_route.provider.endpoint", 256);
    assertOnlyKeys(provider.sdk, ["name", "version"], "provider_route.provider.sdk");
    boundedString(provider.sdk.name, "provider_route.provider.sdk.name", 256);
    boundedString(provider.sdk.version, "provider_route.provider.sdk.version", 256);
    return Object.freeze({
      retry_mapping_ref: route.retry_mapping_ref,
      provider: Object.freeze({ ...provider, sdk: Object.freeze({ ...provider.sdk }) }),
    });
  }

  function newBillableAttempt(request) {
    let attemptId = boundedString(idFactory(), "billable_attempt_id", 256);
    if (attemptId === request.action_id) attemptId = "attempt:" + attemptId;
    if (attemptId.length > 256 || attemptId === request.action_id) {
      throw new CreativeApiError("unavailable", request.operation, "billable_attempt_id");
    }
    return attemptId;
  }

  async function authorizeJobDispatch(principal, request, started, transportAttemptId, billableAttemptId, contextFence) {
    const authorize = requiredPort(ports, "jobs.authorizeDispatch", request.operation);
    let result;
    try {
      result = await authorize(Object.freeze({
        scope: started.scope,
        actor_id: principal.actor_id,
        job_id: started.job_id,
        lease_token: started.lease_token,
        action_id: request.action_id,
        operation: request.operation,
        ...(billableAttemptId ? { billable_attempt_id: billableAttemptId } : {}),
        transport_attempt_id: boundedString(transportAttemptId, "transport_attempt_id", 256),
        context_fence: contextFence,
      }));
    } catch {
      throw new CreativeApiError("unavailable", request.operation, "dispatch_authorization", { retryable: true });
    }
    if (!isRecord(result)) throw new CreativeApiError("unavailable", request.operation, "dispatch_authorization");
    if (result.status === "cancelled" || result.status === "lease_lost") {
      throw new CreativeApiError("cancelled", request.operation, "dispatch_authorization");
    }
    if (result.status === "stale_context") {
      throw new CreativeApiError("stale_version", request.operation, "creative_context");
    }
    if (result.status !== "authorized") throw new CreativeApiError("unavailable", request.operation, "dispatch_authorization");
    return boundedString(result.dispatch_intent_ref, "dispatch_intent_ref", 256);
  }

  async function runMetered(principal, request, started, operationKind, route, portPath, invokePort, preDispatchGuard,
    contextFence) {
    if (preDispatchGuard) await preDispatchGuard();
    requiredPort(ports, "metering.reserveAttempt", request.operation);
    const metering = ports.metering;
    const method = requiredPort(ports, portPath, request.operation);
    const checkedRoute = routeFor(route, request.operation);
    const attemptId = newBillableAttempt(request);
    const attempt = meteredAttempt(principal, request, attemptId, operationKind, checkedRoute);
    const deadline = startDeadline(request.operation, MAX_PORT_WAIT_MS, now);
    let providerValue;
    let validatedDecisionRequest;
    let preDispatchError;
    const dispatchIntentRefs = new Map();
    const checkDispatchFence = async () => {
      if (!preDispatchGuard) return;
      try { await preDispatchGuard(); }
      catch (error) { preDispatchError = error; throw error; }
    };
    const authorizeTransport = async (transportAttemptId) => {
      boundedString(transportAttemptId, "transport_attempt_id", 256);
      await checkDispatchFence();
      const existing = dispatchIntentRefs.get(transportAttemptId);
      if (existing) {
        if (deadline.signal.aborted) throw new CreativeApiError("cancelled", request.operation, "deadline");
        return existing;
      }
      let intentRef;
      try {
        intentRef = await authorizeJobDispatch(principal, request, started, transportAttemptId,
          attempt.billable_attempt_id, contextFence);
      } catch (error) {
        preDispatchError = error;
        throw error;
      }
      if (deadline.signal.aborted) throw new CreativeApiError("cancelled", request.operation, "deadline");
      await checkDispatchFence();
      dispatchIntentRefs.set(transportAttemptId, intentRef);
      return intentRef;
    };
    let outcome;
    try {
      outcome = await executeMeteredAttempt({
      port: metering,
      request: attempt,
      trustedScope: meteredTrustedScope(principal),
      signal: deadline.signal,
      dispatch: async (dispatchContext) => {
        const transportAttemptId = boundedString(idFactory(), "transport_attempt_id", 256);
        const dispatch_intent_ref = await authorizeTransport(transportAttemptId);
        if (dispatchContext.signal?.aborted) throw new CreativeApiError("cancelled", request.operation, "deadline");
        let dispatched;
        try { dispatched = await invokePort({
          method,
          request,
          principal,
          started,
          route: checkedRoute,
          attempt: dispatchContext.attempt,
          reservation_ref: dispatchContext.reservation_ref,
          signal: dispatchContext.signal,
          deadline_at: deadline.deadline_at,
          transportAttemptId,
          dispatch_intent_ref,
          async recordTransportAttempt(transportId) {
            const intentRef = await authorizeTransport(transportId);
            if (dispatchContext.signal?.aborted) throw new CreativeApiError("cancelled", request.operation, "deadline");
            await dispatchContext.recordTransportAttempt(transportId);
            if (dispatchContext.signal?.aborted) throw new CreativeApiError("cancelled", request.operation, "deadline");
            return intentRef;
          },
          setDecisionRequest(value) { validatedDecisionRequest = value; },
        }); } catch (error) { throw error; }
        providerValue = dispatched?.value;
        const rawUsage = dispatched?.usage;
        const usage_observation = usageObservation(dispatchContext.attempt, {
          ...(isRecord(rawUsage) ? rawUsage : {}),
          ...(rawUsage?.transport_attempt_id === undefined ? { transport_attempt_id: transportAttemptId } : {}),
        }, idFactory);
        return { provider_outcome: dispatched?.provider_outcome ?? "succeeded", usage_observation };
      },
    });
    } finally {
      deadline.dispose();
    }
    if (outcome.status !== "settled" || outcome.provider_outcome !== "succeeded") {
      if (preDispatchError) throw preDispatchError;
      throw meteringFailure(outcome, request.operation);
    }
    return { value: providerValue, attempt_id: attemptId, decision_request: validatedDecisionRequest, metering: outcome };
  }

  function decisionInput(decisionRequest, principal, request, brief, started) {
    assertOnlyKeys(decisionRequest, ["execution_mode", "state", "questions"], "decision_request");
    const input = {
      execution_mode: decisionRequest.execution_mode,
      state: decisionRequest.state,
      questions: decisionRequest.questions,
    };
    if (!isRecord(input.state) || !isRecord(input.questions)) throw new CreativeApiError("invalid_request", request.operation, "decision_request");
    if (request.source_refs.some((ref) => !brief.source_identity.some((source) => source.source_id === ref))) {
      throw new CreativeApiError("scope_denied", request.operation, "source_refs");
    }
    return input;
  }

  async function decision(principal, request, started, brief, decisionRequest, baseDesign = null) {
    if (decisionRequest === undefined) return undefined;
    const expectedCurrentDesignVersionId = baseDesign?.design_version_id ?? null;
    await assertCurrentCreativeContext(started.scope, brief, baseDesign, request.operation,
      expectedCurrentDesignVersionId);
    const input = decisionInput(decisionRequest, principal, request, brief, started);
    const resolveRoute = requiredPort(ports, "decisionPort.resolveRoute", request.operation);
    const route = routeFor(await resolveRoute(Object.freeze({ scope: started.scope, actor_id: principal.actor_id, decision: input })), request.operation);
    await assertCurrentCreativeContext(started.scope, brief, baseDesign, request.operation,
      expectedCurrentDesignVersionId);
    if (route.provider.model !== PINNED_JEV_MODEL_ID) throw new CreativeApiError("unsupported_version", request.operation, "decision_route.model");
    const result = await runMetered(principal, request, started, "jev_decision", route, "decisionPort.execute",
      async ({ method, attempt, reservation_ref, signal, deadline_at, transportAttemptId, dispatch_intent_ref, recordTransportAttempt, setDecisionRequest }) => {
        const timestamp = new Date(now()).toISOString();
        const boundRequest = {
          contract: "DecisionPortRequest",
          schema_version: "1.0",
          event_id: boundedString(idFactory(), "decision_request.event_id", 200),
          tenant_id: principal.tenant_id,
          project_id: principal.project_id,
          correlation_id: request.correlation_id,
          producer: "creative-runtime",
          occurred_at: timestamp,
          ingested_at: timestamp,
          environment: request.environment,
          billing_mode: request.billing_mode,
          source_refs: [...new Set(request.source_refs)],
          request_id: boundedString(idFactory(), "decision_request.request_id", 200),
          logical_operation_id: attempt.logical_operation_id,
          billable_attempt_id: attempt.billable_attempt_id,
          attempt_number: 1,
          attempt_limit: 1,
          budget_ref: {
            budget_scope_ref: principal.budget_scope_id,
            reservation_ref,
            policy_version: principal.budget_policy_version,
          },
          deadline_at,
          cancellation_ref: started.job_id,
          model_policy: { model_id: PINNED_JEV_MODEL_ID, policy_version: DECISION_POLICY_VERSION },
          execution_mode: input.execution_mode,
          state: input.state,
          questions: input.questions,
          job_id: started.job_id,
        };
        let validated;
        // DecisionPort envelopes carry job_id. Bind that optional reference to
        // the job identity allocated by the trusted idempotency port.
        const decisionScope = { ...started.scope, job_id: started.job_id };
        try { validated = validateDecisionRequest(boundRequest, { trustedScope: decisionScope }); }
        catch (error) { throw safeError(error, request.operation); }
        setDecisionRequest(validated);
        const raw = await method(Object.freeze({ scope: started.scope, actor_id: principal.actor_id,
          request: validated, attempt, reservation_ref, transport_attempt_id: transportAttemptId,
          dispatch_intent_ref, recordTransportAttempt, signal, deadline_at }));
        return { value: raw, usage: raw?.usage, provider_outcome: raw?.status === "complete" || raw?.status === "review" ? "succeeded" : "failed" };
      }, () => assertCurrentCreativeContext(started.scope, brief, baseDesign,
        request.operation, expectedCurrentDesignVersionId),
      creativeContextFence(brief, baseDesign, expectedCurrentDesignVersionId));
    if (!result.decision_request) throw new CreativeApiError("unavailable", request.operation, "decision_request");
    let validated;
    try { validated = validateDecisionResult(result.decision_request, result.value, {
      trustedScope: { ...started.scope, job_id: started.job_id },
    }); }
    catch (error) { throw safeError(error, request.operation); }
    if (validated.status === "review") throw new CreativeApiError("review_required", request.operation, "decision_result");
    if (validated.status === "cancelled") throw new CreativeApiError("cancelled", request.operation, "decision_result");
    if (validated.status !== "complete") throw new CreativeApiError("unavailable", request.operation, "decision_result");
    return validated;
  }

  async function runImageOperation(principal, request, started, brief, baseDesign) {
    const operation = request.operation;
    const plan = request.payload.plan;
    if (!isRecord(plan)) throw new CreativeApiError("invalid_request", operation, "plan");
    const briefHash = canonicalHash(brief);
    const rootDesignId = "root:" + brief.brief_id;
    const expectedBaseHash = baseDesign ? baseDesign.design_hash : canonicalHash({ contract: "DesignRoot", schema_version: "1.0", brief_id: brief.brief_id });
    const knownDesignIds = baseDesign ? [baseDesign.design_version_id] : [rootDesignId];
    const allowedSourceRefs = brief.source_identity.map((source) => source.source_id);
    if (operation === "generate" && plan.operation !== "concept.generate") throw new CreativeApiError("invalid_request", operation, "plan.operation");
    if (operation === "edit" && !["image.edit", "composition.update", "correction.apply"].includes(plan.operation)) {
      throw new CreativeApiError("invalid_request", operation, "plan.operation");
    }
    validateEditPlan(plan, {
      trustedScope: started.scope,
      brief_hash: briefHash,
      design_hash: expectedBaseHash,
      design_version_ids: knownDesignIds,
      known_artifact_ids: baseDesign ? [baseDesign.artifact.artifact_id] : [],
      known_source_refs: allowedSourceRefs,
      known_asset_ids: (brief.permissions?.items ?? []).filter((item) => item.status === "granted").map((item) => item.asset_id),
      known_fact_ids: [...brief.facts.verified, ...brief.facts.unresolved].map((fact) => fact.fact_id),
    });
    for (const step of plan.steps) {
      const assetIds = [step.parameters?.asset_id,
        ...(Array.isArray(step.parameters?.changes) ? step.parameters.changes.map((change) => change?.asset_id) : [])]
        .filter((assetId) => assetId !== undefined);
      for (const assetId of assetIds) {
        const requiredAction = step.action === "concept.generate" ? "reproduce" : "modify";
        const permission = brief.permissions.items.find((item) => item.asset_id === assetId && item.action === requiredAction);
        if (!permission || permission.status !== "granted") {
          throw new CreativeApiError("permission_denied", operation, "plan.steps.parameters.asset_id");
        }
      }
    }
    if (baseDesign && plan.base.design_version_id !== baseDesign.design_version_id) {
      throw new CreativeApiError("stale_version", operation, "plan.base.design_version_id");
    }
    if (plan.expected_result.parent_version_id !== (baseDesign?.design_version_id ?? rootDesignId)) {
      throw new CreativeApiError("stale_version", operation, "plan.expected_result.parent_version_id");
    }
    if (!baseDesign && plan.base.design_version_id !== undefined) {
      throw new CreativeApiError("invalid_request", operation, "plan.base.design_version_id");
    }
    // Composition changes require deterministic layout-only execution. This
    // runtime has no injected composition executor yet, so fail before any
    // provider routing, reservation, or image transport.
    if (operation === "edit" && plan.operation === "composition.update") {
      throw new CreativeApiError("unavailable", operation, "composition_executor");
    }
    // Corrections change the authoritative research facts and require a
    // research-owner handoff plus invalidation of dependent creative state.
    // Until that capability is injected, do not reinterpret the correction
    // as an image edit or let optional DecisionPort work run first.
    if (operation === "edit" && plan.operation === "correction.apply") {
      throw new CreativeApiError("unavailable", operation, "correction_handoff");
    }
    const expectedCurrentDesignVersionId = baseDesign?.design_version_id ?? null;
    await assertCurrentCreativeContext(started.scope, brief, baseDesign, operation,
      expectedCurrentDesignVersionId);
    const decisionResult = await decision(principal, request, started, brief,
      request.payload.decision_request, baseDesign);
    const method = operation === "generate" ? "provider.generate" : "provider.edit";
    const resolveRoute = requiredPort(ports, "provider.resolveRoute", operation);
    const route = routeFor(await resolveRoute(Object.freeze({ scope: started.scope, actor_id: principal.actor_id, operation, plan })), operation);
    await assertCurrentCreativeContext(started.scope, brief, baseDesign, operation,
      expectedCurrentDesignVersionId);
    const metered = await runMetered(principal, request, started, operation === "generate" ? "image_generation" : "image_edit", route, method,
      async ({ method: dispatch, scope, actor_id, started: job, route: resolved, attempt, signal, deadline_at,
        transportAttemptId, dispatch_intent_ref, recordTransportAttempt }) => {
        const value = await dispatch(Object.freeze({ scope: started.scope, actor_id: principal.actor_id,
          job_id: started.job_id, attempt, route: resolved, brief, base_design: baseDesign, plan,
          decision_result: decisionResult, transport_attempt_id: transportAttemptId, dispatch_intent_ref,
          recordTransportAttempt,
          signal, deadline_at }));
        return { value, usage: value?.usage, provider_outcome: "succeeded" };
      }, () => assertCurrentCreativeContext(started.scope, brief, baseDesign, operation,
        expectedCurrentDesignVersionId),
      creativeContextFence(brief, baseDesign, expectedCurrentDesignVersionId));
    const generated = metered.value;
    const usage = normalizeUsage(generated?.usage);
    if (!isRecord(generated) || !isRecord(generated.artifact) ||
      typeof generated.artifact.artifact_id !== "string" || typeof generated.artifact.content_hash !== "string" ||
      typeof generated.artifact.media_type !== "string") {
      throw new CreativeApiError("failed", operation, "provider_result");
    }
    const design_version_id = boundedString(generated.design_version_id ?? idFactory(), "design_version_id");
    boundedString(generated.provider, "provider_result.provider", 100);
    boundedString(generated.model, "provider_result.model", 100);
    if (generated.provider !== route.provider.name || generated.model !== route.provider.model) {
      throw new CreativeApiError("failed", operation, "provider_identity");
    }
    const parent_version_id = baseDesign?.design_version_id ?? null;
    const designBase = {
      contract: "DesignVersion",
      schema_version: "1.0",
      event_id: idFactory(),
      tenant_id: principal.tenant_id,
      project_id: principal.project_id,
      correlation_id: request.correlation_id,
      producer: "creative-runtime",
      occurred_at: new Date(now()).toISOString(),
      ingested_at: new Date(now()).toISOString(),
      environment: request.environment,
      billing_mode: request.billing_mode,
      source_refs: [...new Set([...request.source_refs, ...plan.source_refs])],
      logical_operation_id: request.action_id,
      design_version_id,
      brief_id: brief.brief_id,
      parent_version_id,
      brief_hash: briefHash,
      artifact: generated.artifact,
      provider: route.provider.name,
      model: route.provider.model,
      billable_attempt_id: metered.attempt_id,
      usage_status: usage.completeness === "complete" ? "complete" : "incomplete",
    };
    const design = { ...designBase, design_hash: computeDesignVersionHash(designBase) };
    validateDesignVersion(design, {
      trustedScope: { ...started.scope, design_version_id },
      brief_hash: briefHash,
      design_version_ids: baseDesign ? [baseDesign.design_version_id] : [],
      known_source_refs: allowedSourceRefs,
    });
    return { design, usage: { completeness: usage.completeness ?? "unknown" }, attempt_id: metered.attempt_id };
  }

  async function executeNew(principal, request, started) {
    const operation = request.operation;
    const payload = request.payload;
    const scope = started.scope;
    if (operation === "inspect") {
      const brief = await loadBrief(scope, payload.brief_id, operation);
      const design = await loadDesign(scope, brief, payload.design_version_id, operation);
      await assertCurrentCreativeContext(scope, brief, design, operation);
      const resolveRoute = requiredPort(ports, "inspection.resolveRoute", operation);
      const inspect = requiredPort(ports, "inspection.inspect", operation);
      const route = routeFor(await resolveRoute(Object.freeze({ scope, actor_id: principal.actor_id, design_version: design })), operation);
      await assertCurrentCreativeContext(scope, brief, design, operation);
      const metered = await runMetered(principal, request, started, "vision_observation", route, "inspection.inspect",
        async ({ attempt, signal, deadline_at, transportAttemptId, dispatch_intent_ref, recordTransportAttempt }) => {
          const value = await inspect(Object.freeze({ scope, actor_id: principal.actor_id, job_id: started.job_id,
            attempt, brief, design_version: design, transport_attempt_id: transportAttemptId,
            signal, deadline_at, dispatch_intent_ref, recordTransportAttempt }));
          return { value, usage: value?.usage, provider_outcome: "succeeded" };
        }, () => assertCurrentCreativeContext(scope, brief, design, operation),
        creativeContextFence(brief, design));
      const result = metered.value;
      if (!isRecord(result)) throw new CreativeApiError("failed", operation, "inspection_result");
      assertOnlyKeys(result, ["tenant_id", "project_id", "brief_id", "design_version_id", "artifact_id", "artifact_hash",
        "design_hash", "inspection_id", "observations", "usage"], "inspection_result");
      if (result.tenant_id !== scope.tenant_id || result.project_id !== scope.project_id || result.brief_id !== brief.brief_id ||
        result.design_version_id !== design.design_version_id || result.artifact_id !== design.artifact.artifact_id ||
        result.artifact_hash !== design.artifact.content_hash || result.design_hash !== design.design_hash) {
        throw new CreativeApiError("stale_version", operation, "inspection_binding");
      }
      boundedString(result.inspection_id, "inspection_id", 256);
      if (!Array.isArray(result.observations) || result.observations.length > 64) throw new CreativeApiError("failed", operation, "observations");
      const observations = result.observations.map((item, index) => {
        const field = `observations[${index}]`;
        assertOnlyKeys(item, ["observer", "content_hash", "uncertainty", "summary", "source_ref"], field);
        if (!isRecord(item.observer) || !["human", "model", "system"].includes(item.observer.type)) throw new CreativeApiError("failed", operation, `observations[${index}].observer`);
        assertOnlyKeys(item.observer, ["type", "id"], `${field}.observer`);
        inspectionText(item.observer.id, `observations[${index}].observer.id`, 200, operation);
        if (item.content_hash !== design.artifact.content_hash || !isRecord(item.uncertainty) ||
          !["measured", "not_measured", "unknown"].includes(item.uncertainty.status)) {
          throw new CreativeApiError("failed", operation, `observations[${index}].content_hash`);
        }
        assertOnlyKeys(item.uncertainty, ["status", "note"], `${field}.uncertainty`);
        if (item.uncertainty.note !== undefined) {
          inspectionText(item.uncertainty.note, `observations[${index}].uncertainty.note`, 500, operation);
        }
        inspectionText(item.summary, `observations[${index}].summary`, 1500, operation);
        if (item.source_ref !== undefined && !brief.source_identity.some((source) => source.source_id === item.source_ref)) {
          throw new CreativeApiError("scope_denied", operation, `observations[${index}].source_ref`);
        }
        if (item.source_ref !== undefined) inspectionText(item.source_ref, `observations[${index}].source_ref`, 200, operation);
        return Object.freeze({
          observer: Object.freeze({ type: item.observer.type, id: item.observer.id }),
          content_hash: item.content_hash,
          uncertainty: Object.freeze({ status: item.uncertainty.status,
            ...(item.uncertainty.note !== undefined ? { note: item.uncertainty.note } : {}) }),
          summary: item.summary,
          ...(item.source_ref !== undefined ? { source_ref: item.source_ref } : {}),
        });
      });
      await assertCurrentCreativeContext(scope, brief, design, operation);
      const inspectionUsage = normalizeUsage(result.usage);
      if (inspectionUsage.completeness !== "complete") throw new CreativeApiError("failed", operation, "inspection_usage");
      const inspection = Object.freeze({ tenant_id: scope.tenant_id, project_id: scope.project_id,
        brief_id: brief.brief_id, design_version_id: design.design_version_id,
        artifact_id: design.artifact.artifact_id, artifact_hash: design.artifact.content_hash,
        design_hash: design.design_hash, inspection_id: result.inspection_id,
        observations: Object.freeze(observations), usage: inspectionUsage });
      const output = { inspection, attempt_id: metered.attempt_id };
      const job = await publish(principal, request, started, output, async () => undefined, {
        brief_id: brief.brief_id, brief_hash: canonicalHash(brief),
        design_version_id: design.design_version_id, design_hash: design.design_hash,
      });
      return Object.freeze({ ok: true, contract: "CreativeApiResponse", schema_version: CREATIVE_API_VERSION,
        operation_id: job.job_id, job: publicJob(job, job.job_id), result: inspection });
    }
    if (operation === "generate" || operation === "edit") {
      const brief = await loadBrief(scope, payload.brief_id, operation);
      const baseDesign = operation === "edit"
        ? await loadDesign(scope, brief, payload.design_version_id, operation)
        : null;
      if (operation === "edit") {
        const getCurrent = requiredPort(ports, "storage.getCurrentDesignVersion", operation);
        const current = await getCurrent(Object.freeze({ scope, brief_id: brief.brief_id }));
        if (!current || current.design_version_id !== baseDesign.design_version_id) {
          throw new CreativeApiError("stale_version", operation, "design_version_id");
        }
        assertScopedRecord(current, scope, operation, brief.brief_id);
        validateDesignVersion(current, { trustedScope: { ...scope, design_version_id: current.design_version_id }, brief_hash: canonicalHash(brief),
          known_source_refs: brief.source_identity.map((source) => source.source_id) });
        if (current.design_hash !== baseDesign.design_hash) throw new CreativeApiError("stale_version", operation, "design_hash");
      } else {
        const getCurrent = requiredPort(ports, "storage.getCurrentDesignVersion", operation);
        const current = await getCurrent(Object.freeze({ scope, brief_id: brief.brief_id }));
        if (current !== null) throw new CreativeApiError("stale_version", operation, "brief_id");
      }
      const output = await runImageOperation(principal, request, started, brief, baseDesign);
      const job = await publish(principal, request, started, output, async () => {
        const save = requiredPort(ports, "storage.saveDesignVersion", operation);
        const saved = await save(Object.freeze({ scope, brief_id: brief.brief_id,
          design_version: output.design,
          expected_brief_hash: canonicalHash(brief),
          expected_current_design_version_id: baseDesign?.design_version_id ?? null,
          expected_current_design_hash: baseDesign?.design_hash ?? null }));
        if (!isRecord(saved) || saved.status !== "saved") throw new CreativeApiError("stale_version", operation);
      }, creativeContextFence(brief, baseDesign));
      return Object.freeze({ ok: true, contract: "CreativeApiResponse", schema_version: CREATIVE_API_VERSION,
        operation_id: job.job_id, job: publicJob(job, job.job_id), result: Object.freeze({ design_version: output.design, usage: output.usage }) });
    }
    if (operation === "restore") {
      const brief = await loadBrief(scope, payload.brief_id, operation);
      const target = await loadDesign(scope, brief, payload.target_design_version_id, operation);
      const getSelection = requiredPort(ports, "storage.getSelection", operation);
      const selection = await getSelection(Object.freeze({ scope, brief_id: brief.brief_id }));
      if (!selection) throw new CreativeApiError("not_found", operation, "selection");
      assertScopedRecord(selection, scope, operation, brief.brief_id);
      if (!Number.isSafeInteger(selection.revision) || selection.revision < 0 ||
        selection.revision !== payload.expected_selection_revision) throw new CreativeApiError("stale_version", operation, "expected_selection_revision");
      const selectedDesign = await loadDesign(scope, brief, boundedString(selection.design_version_id, "selection.design_version_id"), operation);
      const selected = await publish(principal, request, started, { selection: {
        tenant_id: scope.tenant_id, project_id: scope.project_id, brief_id: brief.brief_id,
        design_version_id: target.design_version_id, revision: selection.revision + 1,
      } }, async () => {
        const select = requiredPort(ports, "storage.selectDesignVersion", operation);
        const selectedResult = await select(Object.freeze({ scope, brief_id: brief.brief_id,
          design_version_id: target.design_version_id, expected_brief_hash: canonicalHash(brief),
          expected_target_design_hash: target.design_hash,
          expected_selected_design_version_id: selectedDesign.design_version_id,
          expected_selected_design_hash: selectedDesign.design_hash,
          expected_selection_revision: selection.revision }));
        if (!isRecord(selectedResult) || selectedResult.status !== "selected") throw new CreativeApiError("stale_version", operation);
        assertScopedRecord(selectedResult.selection, scope, operation, brief.brief_id);
        if (selectedResult.selection.design_version_id !== target.design_version_id ||
          selectedResult.selection.revision !== selection.revision + 1) throw new CreativeApiError("failed", operation, "selection");
      }, creativeContextFence(brief, target));
      return Object.freeze({ ok: true, contract: "CreativeApiResponse", schema_version: CREATIVE_API_VERSION,
        operation_id: selected.job_id, job: publicJob(selected, selected.job_id),
        result: Object.freeze({ selection: { tenant_id: scope.tenant_id, project_id: scope.project_id, brief_id: brief.brief_id,
          design_version_id: target.design_version_id, revision: selection.revision + 1 } }) });
    }
    if (operation === "handoff") {
      const briefId = boundedString(payload.brief_id, "brief_id");
      const handoffScope = scopeFor(principal, briefId);
      const brief = await loadBrief(handoffScope, briefId, operation);
      const design = await loadDesign(handoffScope, brief, payload.design_version_id, operation);
      const getContext = requiredPort(ports, "storage.getHandoffContext", operation);
      const resolveDestination = requiredPort(ports, "handoff.resolveDestination", operation);
      const submit = requiredPort(ports, "handoff.submit", operation);
      const approvalVerifier = ports.approval;
      requiredPort(ports, "approval.verifyApproval", operation);
      const asHex = (value, field) => {
        if (typeof value === "string" && /^[a-f0-9]{64}$/.test(value)) return value;
        if (typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value)) return value.slice(7);
        throw new CreativeApiError("failed", operation, field);
      };
      const readContext = async () => {
        const raw = await getContext(Object.freeze({ scope: handoffScope, brief_id: brief.brief_id,
          design_version_id: design.design_version_id }));
        if (!isRecord(raw) || !isRecord(raw.binding) || !isRecord(raw.artifact) || !Array.isArray(raw.layer_manifest)) {
          throw new CreativeApiError("unavailable", operation, "handoff_context");
        }
        const proposedBinding = { ...raw.binding, action_id: request.action_id, actor_id: principal.actor_id };
        const binding = validateApprovalBinding(proposedBinding, handoffScope);
        if (binding.brief.brief_id !== brief.brief_id || binding.brief.sha256 !== asHex(canonicalHash(brief), "binding.brief.sha256") ||
          binding.design_version.design_version_id !== design.design_version_id ||
          binding.design_version.artwork_sha256 !== asHex(design.artifact.content_hash, "binding.design_version.artwork_sha256") ||
          binding.facts.sha256 !== asHex(canonicalHash(brief.facts), "binding.facts.sha256")) {
          throw new CreativeApiError("stale_version", operation, "handoff_binding");
        }
        for (const asset of binding.assets) {
          const permission = brief.permissions.items.find((item) => item.asset_id === asset.asset_id &&
            item.action === asset.intended_use && item.status === "granted" && item.evidence_refs.includes(asset.permission_ref));
          if (!permission) throw new CreativeApiError("permission_denied", operation, "binding.assets");
        }
        if (raw.artifact.sha256 !== binding.design_version.artwork_sha256 ||
          raw.artifact.mime_type !== design.artifact.media_type) throw new CreativeApiError("stale_version", operation, "artifact");
        hashCompositionLayerManifest({ binding, artifact: raw.artifact, layer_manifest: raw.layer_manifest, trustedScope: handoffScope });
        return { binding, artifact: structuredClone(raw.artifact), layer_manifest: structuredClone(raw.layer_manifest) };
      };
      const initialContext = await readContext();
      const destination = await resolveDestination(Object.freeze({ scope: handoffScope, actor_id: principal.actor_id,
        destination_ref: boundedString(payload.destination_ref, "destination_ref") }));
      if (!isRecord(destination) || typeof destination.expected_audience !== "string") throw new CreativeApiError("unavailable", operation, "destination");
      const handoff = await createArtworkHandoff({
        approvalVerifier,
        approval_reference: boundedString(payload.approval_ref, "approval_ref"),
        expected_audience: boundedString(destination.expected_audience, "destination.expected_audience", 200),
        binding: initialContext.binding,
        artifact: initialContext.artifact,
        layer_manifest: initialContext.layer_manifest,
        handoff_id: boundedString(idFactory(), "handoff_id", 256),
        trustedScope: handoffScope,
        trace_refs: [started.job_id],
        usage_refs: [],
        now: new Date(now()),
      });
      const handoffCreatedAt = new Date(now()).toISOString();
      const afterBuild = await readContext();
      if (canonicalSerialize(afterBuild) !== canonicalSerialize(initialContext)) throw new CreativeApiError("stale_version", operation, "handoff_context");
      const beforeSubmit = await readContext();
      if (canonicalSerialize(beforeSubmit) !== canonicalSerialize(initialContext)) throw new CreativeApiError("stale_version", operation, "handoff_context");
      const transportAttemptId = boundedString(idFactory(), "transport_attempt_id", 256);
      const dispatchIntentRef = await authorizeJobDispatch(principal, request, started, transportAttemptId, undefined,
        creativeContextFence(brief, design));
      const result = { handoff, receipt: null, handoff_created_at: handoffCreatedAt };
      const job = await publish(principal, request, started, result, async () => {
        const assertHandoffContextCurrent = async () => {
          const currentBrief = await loadBrief(handoffScope, briefId, operation);
          const currentDesign = await loadDesign(handoffScope, currentBrief, design.design_version_id, operation);
          const currentContext = await readContext();
          if (canonicalHash(currentBrief) !== canonicalHash(brief) || currentDesign.design_hash !== design.design_hash ||
            canonicalSerialize(currentContext) !== canonicalSerialize(initialContext)) {
            throw new CreativeApiError("stale_version", operation, "handoff_binding");
          }
        };
        await assertHandoffContextCurrent();
        try {
          await verifyHandoffApproval({ approvalVerifier, handoff, expected_audience: destination.expected_audience,
            trustedScope: handoffScope, now: new Date(now()) });
        } catch (error) { throw safeError(error, operation); }
        // Approval verification is asynchronous, so re-read every authoritative
        // component it binds before handing the request to the consumer. The
        // consumer must atomically consume the same approval and binding.
        await assertHandoffContextCurrent();
        const receipt = await submit(Object.freeze({ scope: handoffScope, actor_id: principal.actor_id,
          job_id: started.job_id, destination_ref: payload.destination_ref, handoff,
          transport_attempt_id: transportAttemptId, dispatch_intent_ref: dispatchIntentRef }));
        const receiptNow = new Date(now());
        const consumedAt = validatedReceiptTime(receipt, receiptNow, operation);
        assertReceiptWindow(receipt, handoff, handoffCreatedAt, receiptNow, operation);
        // A consumer may return a valid receipt after the approval expires.
        // The receipt is accepted only if its trusted consumption timestamp is
        // within the original approval window and no later than trusted now.
        result.receipt = validateConsumptionReceipt(receipt, handoff, { trustedScope: handoffScope, now: consumedAt });
      }, creativeContextFence(brief, design));
      assertScopedRecord(job, handoffScope, operation);
      return Object.freeze({ ok: true, contract: "CreativeApiResponse", schema_version: CREATIVE_API_VERSION,
        operation_id: job.job_id, job: publicJob(job, job.job_id),
        result: Object.freeze({ handoff: result.handoff, receipt: result.receipt }) });
    }
    throw new CreativeApiError("invalid_request", operation);
  }

  async function validateReplay(principal, request, started) {
    const job = started.job;
    assertScopedRecord(job, started.scope, request.operation, request.payload.brief_id);
    if (job.job_id !== started.job.job_id || job.actor_id !== principal.actor_id || job.action_id !== request.action_id ||
      job.operation !== request.operation || job.request_hash !== started.request_hash || !isRecord(job.result)) {
      throw new CreativeApiError("unavailable", request.operation, "stored_result");
    }
    if (["generate", "edit"].includes(request.operation)) {
      assertStoredOnlyKeys(job.result, ["design", "usage", "attempt_id"], request.operation, "stored_result");
      const brief = await loadBrief(started.scope, request.payload.brief_id, request.operation);
      const stored = validateDesignVersion(job.result.design, {
        trustedScope: { ...started.scope, design_version_id: job.result.design?.design_version_id },
        brief_hash: canonicalHash(brief), known_source_refs: brief.source_identity.map((source) => source.source_id),
      });
      const current = await loadDesign(started.scope, brief, stored.design_version_id, request.operation);
      if (canonicalSerialize(stored) !== canonicalSerialize(current) || !isRecord(job.result.usage) ||
        job.result.usage.completeness !== "complete" || typeof job.result.attempt_id !== "string") {
        throw new CreativeApiError("unavailable", request.operation, "stored_result");
      }
      return Object.freeze({ design_version: current, usage: Object.freeze({ completeness: "complete" }) });
    }
    if (request.operation === "restore") {
      assertStoredOnlyKeys(job.result, ["selection"], request.operation, "stored_result");
      const selection = job.result.selection;
      assertStoredOnlyKeys(selection, ["tenant_id", "project_id", "brief_id", "design_version_id", "revision"],
        request.operation, "stored_selection");
      if (!isRecord(selection) || selection.tenant_id !== principal.tenant_id || selection.project_id !== principal.project_id ||
        selection.brief_id !== request.payload.brief_id || selection.design_version_id !== request.payload.target_design_version_id ||
        !Number.isSafeInteger(selection.revision) ||
        selection.revision !== request.payload.expected_selection_revision + 1) {
        throw new CreativeApiError("unavailable", request.operation, "stored_selection");
      }
      const brief = await loadBrief(started.scope, request.payload.brief_id, request.operation);
      await loadDesign(started.scope, brief, selection.design_version_id, request.operation);
      return Object.freeze({ selection: Object.freeze({ tenant_id: selection.tenant_id,
        project_id: selection.project_id, brief_id: selection.brief_id,
        design_version_id: selection.design_version_id, revision: selection.revision }) });
    }
    if (request.operation === "inspect") {
      assertStoredOnlyKeys(job.result, ["inspection", "attempt_id"], request.operation, "stored_result");
      const brief = await loadBrief(started.scope, request.payload.brief_id, request.operation);
      const design = await loadDesign(started.scope, brief, request.payload.design_version_id, request.operation);
      const result = job.result.inspection;
      if (!isRecord(result)) throw new CreativeApiError("unavailable", request.operation, "stored_inspection");
      assertStoredOnlyKeys(result, ["tenant_id", "project_id", "brief_id", "design_version_id", "artifact_id", "artifact_hash",
        "design_hash", "inspection_id", "observations", "usage"], request.operation, "stored_inspection");
      if (result.tenant_id !== principal.tenant_id || result.project_id !== principal.project_id || result.brief_id !== brief.brief_id ||
        result.design_version_id !== design.design_version_id || result.artifact_id !== design.artifact.artifact_id ||
        result.artifact_hash !== design.artifact.content_hash || result.design_hash !== design.design_hash ||
        typeof result.inspection_id !== "string" || !Array.isArray(result.observations) || result.observations.length > 64 ||
        !isRecord(result.usage)) throw new CreativeApiError("unavailable", request.operation, "stored_inspection");
      assertStoredOnlyKeys(result.usage, ["completeness", "input_tokens", "output_tokens"],
        request.operation, "stored_inspection.usage");
      const normalizedUsage = normalizeUsage(result.usage);
      if (normalizedUsage.completeness !== "complete" ||
        canonicalSerialize(normalizedUsage) !== canonicalSerialize(result.usage)) {
        throw new CreativeApiError("unavailable", request.operation, "stored_inspection.usage");
      }
      const observations = result.observations.map((observation, index) => {
        const field = `stored_inspection.observations[${index}]`;
        assertStoredOnlyKeys(observation, ["observer", "content_hash", "uncertainty", "summary", "source_ref"], request.operation, field);
        if (!isRecord(observation.observer) || !["human", "model", "system"].includes(observation.observer.type) ||
          observation.content_hash !== design.artifact.content_hash || !isRecord(observation.uncertainty) ||
          !["measured", "not_measured", "unknown"].includes(observation.uncertainty.status) ||
          (observation.source_ref !== undefined && !brief.source_identity.some((source) => source.source_id === observation.source_ref))) {
          throw new CreativeApiError("unavailable", request.operation, "stored_inspection");
        }
        assertStoredOnlyKeys(observation.observer, ["type", "id"], request.operation, `${field}.observer`);
        assertStoredOnlyKeys(observation.uncertainty, ["status", "note"], request.operation, `${field}.uncertainty`);
        inspectionText(observation.observer.id, `${field}.observer.id`, 200, request.operation, true);
        if (observation.uncertainty.note !== undefined) {
          inspectionText(observation.uncertainty.note, `${field}.uncertainty.note`, 500, request.operation, true);
        }
        inspectionText(observation.summary, `${field}.summary`, 1500, request.operation, true);
        if (observation.source_ref !== undefined) {
          inspectionText(observation.source_ref, `${field}.source_ref`, 200, request.operation, true);
        }
        return Object.freeze({ observer: Object.freeze({ type: observation.observer.type, id: observation.observer.id }),
          content_hash: observation.content_hash,
          uncertainty: Object.freeze({ status: observation.uncertainty.status,
            ...(observation.uncertainty.note !== undefined ? { note: observation.uncertainty.note } : {}) }),
          summary: observation.summary,
          ...(observation.source_ref !== undefined ? { source_ref: observation.source_ref } : {}) });
      });
      if (typeof started.job.result.attempt_id !== "string") throw new CreativeApiError("unavailable", request.operation, "stored_inspection");
      boundedString(result.inspection_id, "stored_inspection.inspection_id", 256);
      return Object.freeze({ tenant_id: result.tenant_id, project_id: result.project_id, brief_id: result.brief_id,
        design_version_id: result.design_version_id, artifact_id: result.artifact_id,
        artifact_hash: result.artifact_hash, design_hash: result.design_hash,
        inspection_id: result.inspection_id, observations: Object.freeze(observations), usage: normalizedUsage });
    }
    if (request.operation === "handoff") {
      assertStoredOnlyKeys(job.result, ["handoff", "receipt", "handoff_created_at"], request.operation, "stored_result");
      const brief = await loadBrief(started.scope, request.payload.brief_id, request.operation);
      const design = await loadDesign(started.scope, brief, request.payload.design_version_id, request.operation);
      const replayNow = new Date(now());
      const consumedAt = validatedReceiptTime(job.result.receipt, replayNow, request.operation, true);
      let handoff;
      try {
        handoff = validateArtworkHandoff(job.result.handoff, started.scope, { now: consumedAt });
      } catch {
        throw new CreativeApiError("unavailable", request.operation, "stored_handoff");
      }
      assertReceiptWindow(job.result.receipt, handoff, job.result.handoff_created_at, replayNow, request.operation, true);
      if (handoff.binding.brief.brief_id !== brief.brief_id || handoff.binding.brief.sha256 !== canonicalHash(brief).slice(7) ||
        handoff.binding.design_version.design_version_id !== design.design_version_id ||
        handoff.binding.design_version.artwork_sha256 !== design.artifact.content_hash.replace(/^sha256:/, "")) {
        throw new CreativeApiError("unavailable", request.operation, "stored_handoff");
      }
      let receipt;
      try {
        receipt = validateConsumptionReceipt(job.result.receipt, handoff, { trustedScope: started.scope, now: consumedAt });
      } catch {
        throw new CreativeApiError("unavailable", request.operation, "stored_receipt");
      }
      return Object.freeze({ handoff, receipt });
    }
    throw new CreativeApiError("unavailable", request.operation, "stored_result");
  }

  async function invoke(principalInput, requestInput) {
    let operation = "unknown";
    let request;
    let principal;
    try {
      const snapshot = immutableRequestSnapshot(requestInput);
      operation = CREATIVE_API_OPERATIONS.includes(snapshot?.operation) ? snapshot.operation : "unknown";
      request = validateRequest(snapshot);
      operation = request.operation;
      principal = validatePrincipal(principalInput, now());
      assertRequestScope(principal, request);
      await emitTrace({ event: "creative_api.request", operation, request_id: request.request_id,
        tenant_id: principal.tenant_id, project_id: principal.project_id, actor_id: principal.actor_id });
      if (operation === "list") {
        const scope = scopeFor(principal, boundedString(request.payload.brief_id, "brief_id"));
        const limit = request.payload.limit === undefined ? 20 : request.payload.limit;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new CreativeApiError("invalid_request", operation, "limit");
        const after = decodeCursor(request.payload.cursor, scope, scope.brief_id);
        const list = requiredPort(ports, "storage.listDesignVersions", operation);
        const page = await list(Object.freeze({ scope, brief_id: scope.brief_id, limit: limit + 1, after }));
        if (!isRecord(page) || !Array.isArray(page.items) || page.items.length > limit + 1 || typeof page.has_more !== "boolean") {
          throw new CreativeApiError("unavailable", operation);
        }
        const brief = await loadBrief(scope, scope.brief_id, operation);
        const items = page.items.map((item) => {
          assertScopedRecord(item, scope, operation, scope.brief_id);
          return validateDesignVersion(item, { trustedScope: { ...scope, design_version_id: item.design_version_id }, brief_hash: canonicalHash(brief),
            known_source_refs: brief.source_identity.map((source) => source.source_id) });
        });
        const sorted = [...items].sort(compareOrder);
        if (canonicalSerialize(sorted) !== canonicalSerialize(items) ||
          (after && items.some((item) => !isAfterCursor(item, after)))) throw new CreativeApiError("failed", operation, "page_order");
        const visible = items.slice(0, limit);
        const hasMore = page.has_more || items.length > limit;
        return Object.freeze({ ok: true, contract: "CreativeApiResponse", schema_version: CREATIVE_API_VERSION,
          result: Object.freeze({ items: visible, next_cursor: hasMore && visible.length ? encodeCursor(scope, scope.brief_id, visible.at(-1)) : null }) });
      }
      if (operation === "compare") {
        const scope = scopeFor(principal, boundedString(request.payload.brief_id, "brief_id"));
        const brief = await loadBrief(scope, scope.brief_id, operation);
        const [left, right] = await Promise.all([
          loadDesign(scope, brief, request.payload.left_design_version_id, operation),
          loadDesign(scope, brief, request.payload.right_design_version_id, operation),
        ]);
        return Object.freeze({ ok: true, contract: "CreativeApiResponse", schema_version: CREATIVE_API_VERSION,
          result: Object.freeze({ left, right, changed_fields: Object.freeze([
            ...(left.artifact.content_hash !== right.artifact.content_hash ? ["artifact.content_hash"] : []),
            ...(left.parent_version_id !== right.parent_version_id ? ["parent_version_id"] : []),
            ...(left.brief_hash !== right.brief_hash ? ["brief_hash"] : []),
          ]) }) });
      }
      if (operation === "job.status") {
        const scope = scopeFor(principal);
        const get = requiredPort(ports, "jobs.get", operation);
        const job = await get(Object.freeze({ scope, job_id: boundedString(request.payload.job_id, "job_id") }));
        if (!job) throw new CreativeApiError("not_found", operation, "job_id");
        assertScopedRecord(job, scope, operation);
        if (job.job_id !== request.payload.job_id || typeof job.action_id !== "string" || typeof job.request_hash !== "string" ||
          typeof job.actor_id !== "string" || !CREATIVE_API_OPERATIONS.includes(job.operation)) {
          throw new CreativeApiError("scope_denied", operation, "job_id");
        }
        return Object.freeze({ ok: true, contract: "CreativeApiResponse", schema_version: CREATIVE_API_VERSION,
          job: publicJob(job, job.job_id) });
      }
      if (operation === "cancel") {
        const scope = scopeFor(principal);
        const job_id = boundedString(request.payload.job_id, "job_id");
        const get = requiredPort(ports, "jobs.get", operation);
        const target = await get(Object.freeze({ scope, job_id }));
        if (!target) throw new CreativeApiError("not_found", operation, "job_id");
        assertScopedRecord(target, scope, operation);
        if (target.job_id !== job_id || typeof target.action_id !== "string" || typeof target.request_hash !== "string" ||
          typeof target.actor_id !== "string" || !CREATIVE_API_OPERATIONS.includes(target.operation)) {
          throw new CreativeApiError("not_found", operation, "job_id");
        }
        const cancel = requiredPort(ports, "jobs.cancel", operation);
        const record = await cancel(Object.freeze({ scope, actor_id: principal.actor_id,
          job_id, target_action_id: target.action_id, action_id: request.action_id,
          request_hash: actionRequestHash(request) }));
        if (!isRecord(record) || !record.job || !["cancelled", "replayed"].includes(record.kind)) {
          if (record?.kind === "conflict") throw new CreativeApiError("conflict", operation, "action_id");
          throw new CreativeApiError("not_found", operation, "job_id");
        }
        assertScopedRecord(record.job, scope, operation);
        if (record.job.job_id !== job_id || record.job.action_id !== target.action_id || record.job.request_hash !== target.request_hash) {
          throw new CreativeApiError("scope_denied", operation, "job_id");
        }
        return Object.freeze({ ok: true, contract: "CreativeApiResponse", schema_version: CREATIVE_API_VERSION,
          job: publicJob(record.job, record.job.job_id) });
      }
      const started = await beginMutation(principal, request);
      if (started.replayed) {
        if (started.job.status === "completed") {
          const replayedResult = await validateReplay(principal, request, started);
          return Object.freeze({ ok: true, contract: "CreativeApiResponse", schema_version: CREATIVE_API_VERSION,
            operation_id: started.job.job_id, replayed: true, job: publicJob(started.job, started.job.job_id),
            result: replayedResult });
        }
        return Object.freeze({ ok: true, contract: "CreativeApiResponse", schema_version: CREATIVE_API_VERSION,
          operation_id: started.job.job_id, replayed: true, job: publicJob(started.job, started.job.job_id),
        });
      }
      let response;
      try {
        response = await executeNew(principal, request, started);
      } catch (error) {
        const safe = safeError(error, operation);
        const failIfActive = requiredPort(ports, "jobs.failIfActive", operation);
        const failed = await failIfActive(Object.freeze({ scope: started.scope, actor_id: principal.actor_id,
          job_id: started.job_id, lease_token: started.lease_token, error: {
            code: safe.code, module: "creative-engine.api", operation: safe.operation, field: safe.field,
            retryable: safe.retryable, message: safe.message, diagnostic_ref: safe.diagnostic_ref ?? `creative-api:${safe.code}:${idFactory()}`,
          } }));
        if (!isRecord(failed) || !failed.job || !["failed", "cancelled"].includes(failed.status)) {
          throw new CreativeApiError("unavailable", operation, "job_failure_state");
        }
        if (failed.status === "cancelled") throw new CreativeApiError("cancelled", operation);
        assertScopedRecord(failed.job, started.scope, operation);
        throw safe;
      }
      await emitTrace({ event: "creative_api.completed", operation, operation_id: response.operation_id,
        tenant_id: principal.tenant_id, project_id: principal.project_id, actor_id: principal.actor_id });
      return response;
    } catch (error) {
      await emitTrace({ event: "creative_api.rejected", operation, code: safeError(error, operation).code });
      return failResponse(error, operation);
    }
  }

  return Object.freeze({ invoke });
}

export const createCreativeRuntime = createCreativeApi;
