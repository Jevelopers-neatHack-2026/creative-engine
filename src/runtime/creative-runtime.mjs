import { Buffer } from "node:buffer";
import {
  ContractError,
  canonicalHash,
  canonicalSerialize,
  validateCreativeBrief,
  validateDesignVersion,
  validateEditPlan,
  computeDesignVersionHash,
} from "../contracts/index.mjs";
import { validateUsageObservation } from "../contracts/metering.mjs";
import { readPrivateOpenAIImageTargetBindingSha256 } from "../models/openai-images.mjs";
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
import { MeteringContractError, METERING_PROPOSAL_VERSION } from "../contracts/metering.mjs";
import {
  createUsageObservation,
  executeCreativeMeteredAttempt,
  projectPublicTelemetry,
  TelemetryBoundaryError,
  USAGE_PROFILE,
} from "../telemetry/index.mjs";
import { assertSafePublicIdentifier } from "../telemetry/privacy.mjs";
import { hashArtifactBytes } from "../storage/content-addressed.mjs";
import { buildCreativeBrief, CreativePlanningError } from "../planning/index.mjs";
import { normalizeResearchPackage } from "../contracts/creative/v1.mjs";

export const CREATIVE_API_VERSION = "1.0";
export const CREATIVE_API_OPERATIONS = Object.freeze([
  "generate", "edit", "inspect", "list", "compare", "restore", "cancel", "handoff", "job.status",
  "brief.create", "brief.invalidate",
]);

const MUTATIONS = new Set(["generate", "edit", "inspect", "restore", "cancel", "handoff", "brief.create", "brief.invalidate"]);
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
  "brief.create": "creative.brief.create",
  "brief.invalidate": "creative.brief.invalidate",
});
const REQUEST_KEYS = [
  "contract", "schema_version", "event_id", "request_id", "tenant_id", "project_id",
  "correlation_id", "producer", "occurred_at", "ingested_at", "environment", "billing_mode",
  "source_refs", "operation", "action_id", "payload",
];
const REQUEST_CONTRACT = "CreativeApiRequest";
const IMAGE_REFERENCE_MANIFEST_KEYS = Object.freeze([
  "contract", "schema_version", "tenant_id", "project_id", "brief_id", "brief_hash",
  "research_package_id", "research_package_hash", "base_design_version_id", "base_design_hash", "references",
]);
const IMAGE_REFERENCE_KEYS = Object.freeze([
  "source_ref", "asset_id", "content_hash", "media_type", "width", "height",
]);
const MAX_IMAGE_REFERENCES = 15;
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
  let nodes = 0;
  function copy(current, depth = 0) {
    nodes += 1;
    if (depth > 32 || nodes > 50_000) throw new CreativeApiError("invalid_request", "unknown", "request");
    if (current === null || typeof current === "string" || typeof current === "boolean") return current;
    if (typeof current === "number" && Number.isFinite(current)) return current;
    let prototype;
    let descriptors;
    try {
      prototype = Object.getPrototypeOf(current);
      descriptors = Object.getOwnPropertyDescriptors(current);
    } catch {
      throw new CreativeApiError("invalid_request", "unknown", "request");
    }
    if (Array.isArray(current)) {
      if (prototype !== Array.prototype) throw new CreativeApiError("invalid_request", "unknown", "request");
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > 10_000) {
        throw new CreativeApiError("invalid_request", "unknown", "request");
      }
      for (const key of Reflect.ownKeys(descriptors)) {
        if (key === "length") continue;
        if (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= length) {
          throw new CreativeApiError("invalid_request", "unknown", "request");
        }
      }
      const result = new Array(length);
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) {
          throw new CreativeApiError("invalid_request", "unknown", "request");
        }
        result[index] = copy(descriptor.value, depth + 1);
      }
      return result;
    }
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CreativeApiError("invalid_request", "unknown", "request");
    }
    const result = {};
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = typeof key === "string" ? descriptors[key] : undefined;
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
        throw new CreativeApiError("invalid_request", "unknown", "request");
      }
      Object.defineProperty(result, key, {
        value: copy(descriptor.value, depth + 1), enumerable: true, configurable: false, writable: false,
      });
    }
    return result;
  }
  const snapshot = copy(value);
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

const BASIC_AUTH_CANDIDATE = /\bBasic[\t ]+([A-Za-z0-9+/]+={0,2})(?![A-Za-z0-9+/=])/gi;
const MAX_BASIC_AUTH_TOKEN_CHARS = 8192;

function hasBasicAuthMaterial(value) {
  BASIC_AUTH_CANDIDATE.lastIndex = 0;
  let match;
  while ((match = BASIC_AUTH_CANDIDATE.exec(value)) !== null) {
    const token = match[1];
    const unpadded = token.replace(/=+$/, "");
    if (unpadded.length % 4 === 1) continue;
    if (token.length > MAX_BASIC_AUTH_TOKEN_CHARS) return true;
    const decoded = Buffer.from(token, "base64");
    const canonical = decoded.toString("base64");
    if (canonical !== token && canonical.replace(/=+$/, "") !== token) continue;
    const colon = decoded.indexOf(0x3a);
    if (colon < 0 || [...decoded].some((byte) => byte < 0x20 || byte === 0x7f)) continue;
    return true;
  }
  return false;
}

function hasSensitivePublicText(value) {
  return hasBasicAuthMaterial(value) || SENSITIVE_PUBLIC_TEXT.some((pattern) => pattern.test(value));
}

const SENSITIVE_PUBLIC_FIELD = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|credential|authorization|cookie|raw[_-]?response)/i;

function publicIdentifier(value, field, operation, max = 512) {
  if (typeof value !== "string" || value.trim() === "" || value.length > max || hasSensitivePublicText(value)) {
    throw new CreativeApiError("unavailable", operation, field);
  }
  return value;
}

function projectPublicIdentifiers(value, operation, path = "response", depth = 0) {
  if (depth > 32) throw new CreativeApiError("unavailable", operation, "result");
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item, index) => projectPublicIdentifiers(item, operation, `${path}[${index}]`, depth + 1)));
  }
  if (typeof value === "string") {
    if (hasSensitivePublicText(value)) throw new CreativeApiError("unavailable", operation, path);
    return value;
  }
  if (!isRecord(value)) return value;
  const projected = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_PUBLIC_FIELD.test(key) || hasSensitivePublicText(key)) {
      throw new CreativeApiError("unavailable", operation, safeFieldPath(path) || "result");
    }
    const field = `${path}.${key}`;
    const projectedValue = projectPublicIdentifiers(item, operation, field, depth + 1);
    Object.defineProperty(projected, key, { value: projectedValue, enumerable: true, writable: false, configurable: false });
  }
  return Object.freeze(projected);
}

function assertPublicIdentifiers(value, operation, path = "response", depth = 0) {
  if (depth > 32) throw new CreativeApiError("unavailable", operation, "result");
  if (typeof value === "string") {
    if (hasSensitivePublicText(value)) throw new CreativeApiError("unavailable", operation, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPublicIdentifiers(item, operation, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_PUBLIC_FIELD.test(key) || hasSensitivePublicText(key)) {
      throw new CreativeApiError("unavailable", operation, safeFieldPath(path) || "result");
    }
    const field = `${path}.${key}`;
    assertPublicIdentifiers(item, operation, field, depth + 1);
  }
}

function publicReference(value, field, operation, max = 512) {
  publicIdentifier(value, field, operation, max);
  if (!/^[A-Za-z0-9_.:-]+$/.test(value)) {
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

function validateImageReferenceManifestShape(value) {
  if (value === undefined) return undefined;
  const operation = "edit";
  if (!isRecord(value)) throw new CreativeApiError("invalid_request", operation, "image_reference_manifest");
  assertOnlyKeys(value, IMAGE_REFERENCE_MANIFEST_KEYS, "image_reference_manifest");
  if (value.contract !== "CreativeImageReferenceManifest" || value.schema_version !== "1.0") {
    throw new CreativeApiError("unsupported_version", operation, "image_reference_manifest.schema_version");
  }
  for (const key of ["tenant_id", "project_id", "brief_id", "research_package_id", "base_design_version_id"]) {
    boundedString(value[key], `image_reference_manifest.${key}`, 256);
  }
  for (const key of ["brief_hash", "research_package_hash", "base_design_hash"]) {
    if (typeof value[key] !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value[key])) {
      throw new CreativeApiError("invalid_request", operation, `image_reference_manifest.${key}`);
    }
  }
  if (!Array.isArray(value.references) || value.references.length < 1 || value.references.length > MAX_IMAGE_REFERENCES) {
    throw new CreativeApiError("invalid_request", operation, "image_reference_manifest.references");
  }
  const sourceRefs = new Set();
  const assetIds = new Set();
  for (let index = 0; index < value.references.length; index += 1) {
    const reference = value.references[index];
    const field = `image_reference_manifest.references[${index}]`;
    if (!isRecord(reference)) throw new CreativeApiError("invalid_request", operation, field);
    assertOnlyKeys(reference, IMAGE_REFERENCE_KEYS, field);
    boundedString(reference.source_ref, `${field}.source_ref`, 300);
    boundedString(reference.asset_id, `${field}.asset_id`, 256);
    if (typeof reference.content_hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(reference.content_hash) ||
        !["image/png", "image/jpeg", "image/webp"].includes(reference.media_type) ||
        !Number.isSafeInteger(reference.width) || reference.width < 1 || reference.width > 4096 ||
        !Number.isSafeInteger(reference.height) || reference.height < 1 || reference.height > 4096 ||
        reference.width * reference.height > 16_777_216) {
      throw new CreativeApiError("invalid_request", operation, field);
    }
    if (sourceRefs.has(reference.source_ref) || assetIds.has(reference.asset_id)) {
      throw new CreativeApiError("invalid_request", operation, "image_reference_manifest.references");
    }
    sourceRefs.add(reference.source_ref);
    assetIds.add(reference.asset_id);
  }
  return value;
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
    edit: ["brief_id", "design_version_id", "plan", "selection_mode", "decision_request", "image_reference_manifest"],
    inspect: ["brief_id", "design_version_id"],
    list: ["brief_id", "limit", "cursor"],
    compare: ["brief_id", "left_design_version_id", "right_design_version_id"],
    restore: ["brief_id", "target_design_version_id", "expected_selection_revision"],
    cancel: ["job_id"],
    handoff: ["brief_id", "design_version_id", "approval_ref", "destination_ref"],
    "job.status": ["job_id"],
    "brief.create": ["customer_preferences", "artistic_intent", "additional_required_fact_keys", "fact_corrections",
      "locked_fields", "expected_brief_hash"],
    "brief.invalidate": ["event_id"],
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
    "brief.create": [],
    "brief.invalidate": ["event_id"],
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
  if (request.operation === "brief.create" && request.payload.expected_brief_hash !== undefined &&
    (typeof request.payload.expected_brief_hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(request.payload.expected_brief_hash))) {
    throw new CreativeApiError("invalid_request", request.operation, "payload.expected_brief_hash");
  }
  if (request.operation === "brief.invalidate") boundedString(request.payload.event_id, "payload.event_id");
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
  if (request.operation === "edit" && request.payload.selection_mode !== undefined &&
    !["advance", "branch"].includes(request.payload.selection_mode)) {
    throw new CreativeApiError("invalid_request", request.operation, "selection_mode");
  }
  if (request.operation === "edit") validateImageReferenceManifestShape(request.payload.image_reference_manifest);
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
  return projectPublicIdentifiers(Object.freeze({
    contract: "CreativeJob",
    schema_version: "1.0",
    operation_id,
    job_id,
    status: job.status,
    ...(result_ref ? { result_ref } : {}),
    ...(job.error ? { error: safeStoredJobError(job.error, job.operation) } : {}),
  }), job.operation ?? "unknown", "job");
}

async function validateTelemetryEvidenceStatus(value, operation, expected = {}, evidenceOutbox) {
  const legacyEvidenceStatus = async () => {
    if (!isRecord(evidenceOutbox) || typeof evidenceOutbox.hasAttemptEvidence !== "function") {
      throw new CreativeApiError("unavailable", operation, "stored_result.telemetry_evidence");
    }
    let status;
    try {
      status = await evidenceOutbox.hasAttemptEvidence({
        tenant_id: expected.tenant_id,
        project_id: expected.project_id,
        budget_scope_id: expected.budget_scope_id,
        logical_operation_id: expected.logical_operation_id,
        billable_attempt_id: expected.billable_attempt_id,
      });
    } catch {
      throw new CreativeApiError("unavailable", operation, "stored_result.telemetry_evidence");
    }
    if (status !== "not_found") {
      throw new CreativeApiError("unavailable", operation, "stored_result.telemetry_evidence");
    }
    // Pre-integration jobs have no local evidence records. This status makes
    // that absence explicit without claiming any sink or owner acceptance.
    return Object.freeze({ local_status: "unknown" });
  };
  if (value === undefined) return await legacyEvidenceStatus();
  if (!isRecord(value)) throw new CreativeApiError("unavailable", operation, "stored_result.telemetry_evidence");
  assertStoredOnlyKeys(value, ["local_status", "pending_event_id", "pending_event_staged", "pending_event", "pending_event_hash"],
    operation, "stored_result.telemetry_evidence");
  if (!["recorded", "duplicate", "pending", "unknown"].includes(value.local_status)) {
    throw new CreativeApiError("unavailable", operation, "stored_result.telemetry_evidence");
  }
  if (value.local_status === "unknown") {
    if (value.pending_event_id !== undefined || value.pending_event_staged !== undefined ||
      value.pending_event !== undefined || value.pending_event_hash !== undefined) {
      throw new CreativeApiError("unavailable", operation, "stored_result.telemetry_evidence");
    }
    return await legacyEvidenceStatus();
  }
  if (value.local_status !== "pending") {
    if (value.pending_event_id !== undefined || value.pending_event_staged !== undefined ||
      value.pending_event !== undefined || value.pending_event_hash !== undefined) {
      throw new CreativeApiError("unavailable", operation, "stored_result.telemetry_evidence");
    }
    return Object.freeze({ local_status: value.local_status });
  }
  publicIdentifier(value.pending_event_id, "stored_result.telemetry_evidence.pending_event_id", operation, 256);
  if (typeof value.pending_event_staged !== "boolean") {
    throw new CreativeApiError("unavailable", operation, "stored_result.telemetry_evidence");
  }
  if (value.pending_event_staged) {
    if (value.pending_event !== undefined || value.pending_event_hash !== undefined) {
      throw new CreativeApiError("unavailable", operation, "stored_result.telemetry_evidence");
    }
    return Object.freeze({ local_status: "pending", pending_event_id: value.pending_event_id,
      pending_event_staged: true });
  }
  const event = value.pending_event;
  if (!isRecord(event) || event.schema_version !== "creative.telemetry.evidence/v1" ||
    event.event_type !== "attempt_outcome" || event.event_id !== value.pending_event_id ||
    typeof value.pending_event_hash !== "string" || canonicalHash(event) !== value.pending_event_hash ||
    (expected.tenant_id !== undefined && event.tenant_id !== expected.tenant_id) ||
    (expected.project_id !== undefined && event.project_id !== expected.project_id) ||
    (expected.budget_scope_id !== undefined && event.budget_scope_id !== expected.budget_scope_id) ||
    (expected.logical_operation_id !== undefined && event.logical_operation_id !== expected.logical_operation_id) ||
    (expected.billable_attempt_id !== undefined && event.billable_attempt_id !== expected.billable_attempt_id)) {
    throw new CreativeApiError("unavailable", operation, "stored_result.telemetry_evidence");
  }
  assertPublicIdentifiers(event, operation, "stored_result.telemetry_evidence.pending_event");
  return Object.freeze({ local_status: "pending", pending_event_id: value.pending_event_id,
    pending_event_staged: false, pending_event: event, pending_event_hash: value.pending_event_hash });
}

function safeDiagnosticRef(value, fallback) {
  return typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,200}$/.test(value) &&
    !hasSensitivePublicText(value) ? value : fallback;
}

function safeFieldPath(value) {
  if (typeof value !== "string" || value.length > 120 ||
    !/^[A-Za-z][A-Za-z0-9_-]*(?:\[\d+\])?(?:\.[A-Za-z][A-Za-z0-9_-]*(?:\[\d+\])?)*$/.test(value) ||
    /token|secret|credential|password|api[_-]?key|authorization|cookie|bearer/i.test(value) ||
    hasSensitivePublicText(value)) return "";
  return value;
}

function creativeContextFence(brief, design = null, expectedCurrentDesignVersionId = undefined,
  expectedCurrentDesignHash = design?.design_hash ?? null) {
  return Object.freeze({
    brief_id: brief.brief_id,
    brief_hash: canonicalHash(brief),
    ...(design ? { design_version_id: design.design_version_id, design_hash: design.design_hash } : {}),
    ...(expectedCurrentDesignVersionId !== undefined ? {
      expected_current_design_version_id: expectedCurrentDesignVersionId,
      expected_current_design_hash: expectedCurrentDesignHash,
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

async function usageObservation({ attempt, trustedScope, rawUsage, profile, transportAttemptId, idFactory,
  usageProfileAuthority, targetBindingSha256, reservationRef, dispatchIntentRef, providerOutcome }) {
  const sourceObservationId = `usage:${idFactory()}`;
  const fallback = () => Object.freeze({ observation: createUsageObservation({
    attempt,
    trustedScope,
    usage: isRecord(rawUsage) ? rawUsage : {},
    profile,
    sourceObservationId,
    source: "provider_response",
    transportAttemptId,
  }) });
  if (typeof usageProfileAuthority?.mapProviderUsage !== "function" || !isRecord(rawUsage) ||
      typeof targetBindingSha256 !== "string" || !/^sha256:[a-f0-9]{64}$/.test(targetBindingSha256) ||
      typeof reservationRef !== "string" || typeof dispatchIntentRef !== "string") return fallback();

  const rawUsageSha256 = canonicalHash(rawUsage);
  const attemptBindingSha256 = canonicalHash({ attempt, trusted_scope: trustedScope, reservation_ref: reservationRef,
    dispatch_intent_ref: dispatchIntentRef, transport_attempt_id: transportAttemptId,
    target_binding_sha256: targetBindingSha256, provider_outcome: providerOutcome, source_observation_id: sourceObservationId });
  const profileInput = Object.freeze({ attempt, trustedScope, rawUsage, rawUsageSha256,
    targetBindingSha256, attemptBindingSha256, sourceObservationId, transportAttemptId, providerOutcome,
    reservationRef, dispatchIntentRef });
  let mapped;
  try { mapped = await usageProfileAuthority.mapProviderUsage(profileInput); }
  catch { return fallback(); }
  try {
    if (!isRecord(mapped) || mapped.status !== "mapped" ||
        typeof mapped.profile_ref !== "string" || typeof mapped.profile_sha256 !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(mapped.profile_sha256) ||
        mapped.raw_usage_sha256 !== rawUsageSha256 || mapped.target_binding_sha256 !== targetBindingSha256 ||
        mapped.attempt_binding_sha256 !== attemptBindingSha256) return fallback();
    assertSafePublicIdentifier(mapped.profile_ref, { maxLength: 256 });
    const rawMissing = Array.isArray(rawUsage.missing_fields) ? rawUsage.missing_fields : ["usage.missing_fields"];
    // Only the adapter's explicit profile-pending marker may be resolved by a
    // trusted owner map. Invalid or unmapped provider dimensions remain gaps.
    const unresolved = rawMissing.filter((field) => field !== "usage.profile_mapping_pending");
    if (unresolved.length > 0 && mapped.observation?.completeness === "complete") return fallback();
    const observation = validateUsageObservation(mapped.observation, attempt);
    if (observation.source !== "provider_response" || observation.source_observation_id !== sourceObservationId ||
        observation.transport_attempt_id !== transportAttemptId || observation.provider_name !== attempt.provider.name ||
        observation.model !== attempt.provider.model ||
        (rawUsage.provider_request_id === undefined
          ? observation.provider_request_id !== undefined
          : observation.provider_request_id !== rawUsage.provider_request_id) ||
        observation.rate_card_ref !== undefined || observation.valuation !== undefined) return fallback();
    return Object.freeze({ observation,
      ...(observation.completeness === "complete" ? { mapping: Object.freeze({
        profile_ref: mapped.profile_ref,
        profile_sha256: mapped.profile_sha256,
        raw_usage_sha256: rawUsageSha256,
        target_binding_sha256: targetBindingSha256,
        attempt_binding_sha256: attemptBindingSha256,
        source_observation_id: sourceObservationId,
        transport_attempt_id: transportAttemptId,
        billable_attempt_id: attempt.billable_attempt_id,
        provider_name: attempt.provider.name,
        model: attempt.provider.model,
        observation_sha256: canonicalHash(observation),
      }) } : {}) });
  } catch {
    return fallback();
  }
}

function retainUsageWithoutSettlement(observation, attempt) {
  if (!isRecord(observation)) return undefined;
  try {
    const missing = Array.isArray(observation.missing_fields) ? [...observation.missing_fields] : [];
    if (!missing.includes("usage.dispatch_authorization_not_current")) {
      missing.push("usage.dispatch_authorization_not_current");
    }
    return validateUsageObservation({
      ...observation,
      completeness: observation.completeness === "unknown" ? "unknown" : "partial",
      missing_fields: missing,
    }, attempt);
  } catch {
    return undefined;
  }
}

const OMIT_FAILURE_USAGE_VALUE = Symbol("omit_failure_usage_value");

function snapshotFailureUsage(value) {
  const state = { nodes: 0, bytes: 0, incomplete: false, seen: new WeakSet() };

  function copy(current, depth) {
    state.nodes += 1;
    if (state.nodes > 512 || depth > 12) {
      state.incomplete = true;
      return OMIT_FAILURE_USAGE_VALUE;
    }
    if (current === null || typeof current === "boolean") return current;
    if (typeof current === "string") {
      if (current.length > 16 * 1024 || state.bytes + current.length > 16 * 1024) {
        state.incomplete = true;
        return OMIT_FAILURE_USAGE_VALUE;
      }
      state.bytes += current.length;
      return current;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        state.incomplete = true;
        return OMIT_FAILURE_USAGE_VALUE;
      }
      return current;
    }
    if (typeof current !== "object") {
      state.incomplete = true;
      return OMIT_FAILURE_USAGE_VALUE;
    }
    if (state.seen.has(current)) {
      state.incomplete = true;
      return OMIT_FAILURE_USAGE_VALUE;
    }
    state.seen.add(current);
    try {
      if (Array.isArray(current)) {
        if (Object.getPrototypeOf(current) !== Array.prototype) {
          state.incomplete = true;
          return OMIT_FAILURE_USAGE_VALUE;
        }
        const lengthDescriptor = Object.getOwnPropertyDescriptor(current, "length");
        const length = lengthDescriptor && Object.hasOwn(lengthDescriptor, "value")
          ? lengthDescriptor.value
          : undefined;
        if (!Number.isSafeInteger(length) || length < 0 || length > 256) {
          state.incomplete = true;
          return OMIT_FAILURE_USAGE_VALUE;
        }
        const result = [];
        let outputIndex = 0;
        for (let index = 0; index < length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
            state.incomplete = true;
            continue;
          }
          const child = copy(descriptor.value, depth + 1);
          if (child === OMIT_FAILURE_USAGE_VALUE) continue;
          Object.defineProperty(result, String(outputIndex), {
            value: child,
            enumerable: true,
            configurable: true,
            writable: true,
          });
          outputIndex += 1;
        }
        return result;
      }

      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        state.incomplete = true;
        return OMIT_FAILURE_USAGE_VALUE;
      }
      const keys = Reflect.ownKeys(current);
      const result = Object.create(null);
      for (const key of keys) {
        if (state.nodes >= 512) {
          state.incomplete = true;
          break;
        }
        if (typeof key !== "string") {
          state.incomplete = true;
          continue;
        }
        if (key.length > 1024 || state.bytes + key.length > 16 * 1024) {
          state.incomplete = true;
          continue;
        }
        state.bytes += key.length;
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
          state.incomplete = true;
          continue;
        }
        const child = copy(descriptor.value, depth + 1);
        if (child === OMIT_FAILURE_USAGE_VALUE) continue;
        Object.defineProperty(result, key, {
          value: child,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return result;
    } catch {
      state.incomplete = true;
      return OMIT_FAILURE_USAGE_VALUE;
    } finally {
      state.seen.delete(current);
    }
  }

  const snapshot = copy(value, 0);
  if (snapshot === OMIT_FAILURE_USAGE_VALUE || !isRecord(snapshot)) return undefined;
  if (!state.incomplete) return snapshot;

  function markIncomplete(counters) {
    if (!isRecord(counters)) return;
    if (counters.completeness !== "unknown") {
      Object.defineProperty(counters, "completeness", {
        value: "partial", enumerable: true, configurable: true, writable: true,
      });
    }
    const existing = Array.isArray(counters.missing_fields) ? counters.missing_fields : [];
    const missing = [];
    for (let index = 0; index < existing.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(existing, String(index));
      if (descriptor && Object.hasOwn(descriptor, "value") && typeof descriptor.value === "string") {
        Object.defineProperty(missing, String(missing.length), {
          value: descriptor.value, enumerable: true, configurable: true, writable: true,
        });
      }
    }
    if (!missing.some((field) => field === "usage.unmapped_extension")) {
      Object.defineProperty(missing, String(missing.length), {
        value: "usage.unmapped_extension", enumerable: true, configurable: true, writable: true,
      });
    }
    Object.defineProperty(counters, "missing_fields", {
      value: missing, enumerable: true, configurable: true, writable: true,
    });
  }

  markIncomplete(snapshot);
  if (Object.hasOwn(snapshot, "usage")) markIncomplete(snapshot.usage);
  return snapshot;
}

function providerFailureUsage(error) {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) return undefined;
  let usageDescriptor;
  let outcomeDescriptor;
  try {
    usageDescriptor = Object.getOwnPropertyDescriptor(error, "usage");
    outcomeDescriptor = Object.getOwnPropertyDescriptor(error, "provider_outcome");
    if (!usageDescriptor || !Object.hasOwn(usageDescriptor, "value") || !isRecord(usageDescriptor.value)) return undefined;
    const snapshot = snapshotFailureUsage(usageDescriptor.value);
    if (!snapshot) return undefined;
    const projected = projectPublicTelemetry(snapshot, { maxDepth: 8, maxNodes: 256, maxBytes: 16 * 1024 });
    const reportedOutcome = outcomeDescriptor && Object.hasOwn(outcomeDescriptor, "value")
      ? outcomeDescriptor.value : undefined;
    const providerOutcome = ["failed", "partial", "unknown"].includes(reportedOutcome) ? reportedOutcome : "unknown";
    return Object.freeze({ usage: projected.value, provider_outcome: providerOutcome,
      target_binding_sha256: readPrivateOpenAIImageTargetBindingSha256(error) });
  } catch {
    return undefined;
  }
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
  if (error instanceof TelemetryBoundaryError) return new CreativeApiError("unavailable", operation, "telemetry", { retryable: true });
  if (error instanceof CreativePlanningError) {
    const code = error.code === "scope_mismatch" ? "scope_denied"
      : error.code === "research_package_invalid" || error.code === "brief_store_unavailable" ? "unavailable"
        : error.code === "permission_proof_invalid" ? "permission_denied" : "invalid_request";
    return new CreativeApiError(code, operation, safeFieldPath(error.field));
  }
  if (error?.module === "creative-engine.versions") {
    const versionCodeMap = Object.freeze({
      invalid_request: "invalid_request",
      unsupported_version: "unsupported_version",
      scope_denied: "scope_denied",
      not_found: "not_found",
      conflict: "conflict",
      stale_version: "stale_version",
      unavailable: "unavailable",
      cancelled: "cancelled",
      integrity_error: "failed",
      unknown_completion: "unavailable",
    });
    const code = versionCodeMap[error.code] ?? "failed";
    return new CreativeApiError(code, operation, safeFieldPath(error.field), { retryable: error.retryable === true });
  }
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

  function validateSavedBriefPlan(value, scope, expectedHash, operation) {
    let plan;
    try { plan = immutableRequestSnapshot(value); }
    catch { throw new CreativeApiError("unavailable", operation, "brief_persistence"); }
    if (!isRecord(plan) || plan.contract !== "CreativeBriefPlan" || plan.schema_version !== "1.0" ||
      !isRecord(plan.brief)) throw new CreativeApiError("unavailable", operation, "brief_persistence");
    const briefId = boundedString(plan.brief.brief_id, "brief_id");
    let brief;
    try { brief = validateCreativeBrief(plan.brief, { trustedScope: { ...scope, brief_id: briefId } }); }
    catch { throw new CreativeApiError("unavailable", operation, "brief_persistence"); }
    const { plan_hash: planHash, ...planBody } = plan;
    let calculatedPlanHash;
    try { calculatedPlanHash = canonicalHash(planBody); }
    catch { throw new CreativeApiError("unavailable", operation, "brief_persistence"); }
    if (plan.brief_hash !== canonicalHash(brief) || plan.brief_hash !== expectedHash ||
      typeof planHash !== "string" || planHash !== calculatedPlanHash) {
      throw new CreativeApiError("unavailable", operation, "brief_persistence");
    }
    return plan;
  }

  async function createBrief(principal, request) {
    const scope = scopeFor(principal);
    const requestHash = actionRequestHash(request);
    const getAction = requiredPort(ports, "planning.getBriefAction", request.operation);
    const getPackage = requiredPort(ports, "planning.getCurrentResearchPackage", request.operation);
    const saveAction = requiredPort(ports, "planning.saveBriefAction", request.operation);
    const priorAction = await getAction(Object.freeze({ scope, actor_id: principal.actor_id,
      action_id: request.action_id, request_hash: requestHash }));
    if (priorAction !== null && !isRecord(priorAction)) throw new CreativeApiError("unavailable", request.operation, "brief_persistence");
    if (priorAction?.status === "conflict") throw new CreativeApiError("conflict", request.operation, "action_id");
    if (priorAction?.status === "replayed") {
      const result = validateSavedBriefPlan(priorAction.plan, scope, priorAction.brief_hash, request.operation);
      assertPublicIdentifiers(result, request.operation, "brief_plan");
      return projectPublicIdentifiers(Object.freeze({ ok: true, contract: "CreativeApiResponse",
        schema_version: CREATIVE_API_VERSION, operation_id: result.brief.brief_id, replayed: true, result }), request.operation);
    }
    if (priorAction !== null) throw new CreativeApiError("unavailable", request.operation, "brief_persistence");
    const rawPackage = await getPackage(Object.freeze({ scope }));
    let researchPackage;
    try { researchPackage = immutableRequestSnapshot(rawPackage); }
    catch { throw new CreativeApiError("unavailable", request.operation, "research_package"); }
    const { expected_brief_hash: requestedExpectedHash, ...planningInput } = request.payload;
    const plan = buildCreativeBrief({
      trusted_scope: scope,
      research_package: researchPackage,
      context: { created_at: request.occurred_at, environment: request.environment,
        billing_mode: request.billing_mode, correlation_id: request.correlation_id },
      ...planningInput,
    });
    const getBrief = requiredPort(ports, "storage.getBrief", request.operation);
    const existing = await getBrief(Object.freeze({ scope, brief_id: plan.brief.brief_id }));
    let currentHash = null;
    if (existing) {
      assertScopedRecord(existing, scope, request.operation, plan.brief.brief_id);
      const current = validateCreativeBrief(existing, { trustedScope: { ...scope, brief_id: plan.brief.brief_id } });
      currentHash = canonicalHash(current);
    }
    const expectedBriefHash = requestedExpectedHash ?? currentHash;
    const saved = await saveAction(Object.freeze({ scope, actor_id: principal.actor_id,
      action_id: request.action_id, request_hash: requestHash, plan,
      expected_brief_hash: expectedBriefHash }));
    if (!isRecord(saved)) throw new CreativeApiError("unavailable", request.operation, "brief_persistence");
    if (saved.status === "conflict") throw new CreativeApiError("conflict", request.operation, "action_id");
    if (saved.status === "stale") throw new CreativeApiError("stale_version", request.operation, "expected_brief_hash");
    if (!["saved", "replayed"].includes(saved.status) || !isRecord(saved.plan) ||
      saved.brief_hash !== saved.plan.brief_hash ||
      (saved.status === "saved" && saved.plan.brief?.brief_id !== plan.brief.brief_id)) {
      throw new CreativeApiError("unavailable", request.operation, "brief_persistence");
    }
    const result = validateSavedBriefPlan(saved.plan, scope, saved.brief_hash, request.operation);
    assertPublicIdentifiers(result, request.operation, "brief_plan");
    return projectPublicIdentifiers(Object.freeze({ ok: true, contract: "CreativeApiResponse",
      schema_version: CREATIVE_API_VERSION, operation_id: result.brief.brief_id,
      replayed: saved.status === "replayed", result }), request.operation);
  }

  async function invalidateBrief(principal, request) {
    const apply = requiredPort(ports, "planning.applyInvalidation", request.operation);
    const action = await apply(Object.freeze({
      trusted_scope: scopeFor(principal),
      actor_id: principal.actor_id,
      action_id: request.action_id,
      operation: request.operation,
      request_hash: actionRequestHash(request),
      event_id: request.payload.event_id,
    }));
    if (!isRecord(action) || action.public_action_status === "conflict") {
      if (action?.public_action_status === "conflict") throw new CreativeApiError("conflict", request.operation, "action_id");
      throw new CreativeApiError("unavailable", request.operation, "invalidation_action");
    }
    if (!["completed", "replayed", "pending"].includes(action.public_action_status) || !isRecord(action.invalidation)) {
      throw new CreativeApiError("unavailable", request.operation, "invalidation_action");
    }
    const result = action.invalidation;
    if (!isRecord(result) || result.event_id !== request.payload.event_id || !isRecord(result.durable_receipt)) {
      throw new CreativeApiError("unavailable", request.operation, "invalidation_receipt");
    }
    assertPublicIdentifiers(result, request.operation, "invalidation");
    return projectPublicIdentifiers(Object.freeze({ ok: true, contract: "CreativeApiResponse",
      schema_version: CREATIVE_API_VERSION, operation_id: result.event_id,
      replayed: action.public_action_status === "replayed",
      result: Object.freeze({ invalidation: result,
        local_status: result.producer_acknowledgment ? "acknowledged" : "pending" }) }), request.operation);
  }

  async function loadDesign(scope, brief, designVersionId, operation, { allowHistorical = false } = {}) {
    boundedString(designVersionId, "design_version_id");
    const getDesignVersion = requiredPort(ports, "storage.getDesignVersion", operation);
    const design = await getDesignVersion(Object.freeze({ scope, brief_id: brief.brief_id, design_version_id: designVersionId }));
    if (!design) throw new CreativeApiError("not_found", operation, "design_version_id");
    assertScopedRecord(design, scope, operation, brief.brief_id);
    if (design.design_version_id !== designVersionId) throw new CreativeApiError("scope_denied", operation, "design_version_id");
    let sourceBrief = brief;
    if (design.brief_hash !== canonicalHash(brief)) {
      if (!allowHistorical) throw new CreativeApiError("stale_version", operation, "brief_hash");
      const getBriefVersion = requiredPort(ports, "storage.getBriefVersionByHash", operation);
      const historical = await getBriefVersion(Object.freeze({ scope, brief_id: brief.brief_id, brief_hash: design.brief_hash }));
      if (!historical) throw new CreativeApiError("unavailable", operation, "brief_history");
      assertScopedRecord(historical, scope, operation, brief.brief_id);
      sourceBrief = validateCreativeBrief(historical, { trustedScope: { ...scope, brief_id: brief.brief_id } });
      if (canonicalHash(sourceBrief) !== design.brief_hash) throw new CreativeApiError("failed", operation, "brief_history.hash");
    }
    return validateDesignVersion(design, {
      trustedScope: { ...scope, design_version_id: designVersionId },
      brief_hash: canonicalHash(sourceBrief),
      known_source_refs: sourceBrief.source_identity.map((source) => source.source_id),
    });
  }

  async function assertCurrentCreativeContext(scope, brief, design, operation,
    expectedCurrentDesignVersionId = undefined, expectedCurrentDesignHash = undefined) {
    const currentBrief = await loadBrief(scope, brief.brief_id, operation);
    if (canonicalHash(currentBrief) !== canonicalHash(brief)) {
      throw new CreativeApiError("stale_version", operation, "brief_hash");
    }
    if (typeof ports.storage?.isBriefUsable === "function" &&
      !(await ports.storage.isBriefUsable(Object.freeze({ scope, brief_id: brief.brief_id, brief_hash: canonicalHash(brief) })))) {
      throw new CreativeApiError("stale_version", operation, "brief_invalidation");
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
        const validated = await loadDesign(scope, currentBrief, selected.design_version_id, operation, { allowHistorical: true });
        const expectedHash = expectedCurrentDesignHash === undefined ? (design?.design_hash ?? null) : expectedCurrentDesignHash;
        if (validated.design_hash !== expectedHash) throw new CreativeApiError("stale_version", operation, "design_hash");
        if (design && validated.design_hash !== design.design_hash) {
          throw new CreativeApiError("stale_version", operation, "design_hash");
        }
      }
    }
    return currentBrief;
  }

  async function verifyRequestedAssetPermissions(scope, brief, plan, operation, imageReferenceManifest,
    baseDesign, briefHash) {
    const explicit = new Map();
    const sourceRefs = new Set(Array.isArray(plan.source_refs) ? plan.source_refs : []);
    for (const step of plan.steps ?? []) {
      for (const sourceRef of step.source_refs ?? []) sourceRefs.add(sourceRef);
      const action = step.action === "concept.generate" ? "reproduce" : "modify";
      const ids = [step.parameters?.asset_id,
        ...(Array.isArray(step.parameters?.changes) ? step.parameters.changes.map((change) => change?.asset_id) : [])]
        .filter((value) => value !== undefined);
      for (const assetId of ids) explicit.set(assetId, action);
    }
    const getPackage = ports.planning?.getCurrentResearchPackage;
    if (typeof getPackage !== "function") {
      if (explicit.size > 0 || imageReferenceManifest !== undefined) {
        throw new CreativeApiError("unavailable", operation, "asset_permission_verifier");
      }
      return Object.freeze({ proofs: Object.freeze([]), image_reference_manifest: undefined });
    }
    let research;
    try {
      const raw = await getPackage(Object.freeze({ scope }));
      research = normalizeResearchPackage(immutableRequestSnapshot(raw), scope);
    } catch {
      throw new CreativeApiError("unavailable", operation, "research_package");
    }
    const packageHash = canonicalHash(research);
    if (research.package_id !== brief.research_package_ref.package_id ||
      packageHash !== brief.research_package_ref.content_hash) {
      throw new CreativeApiError("stale_version", operation, "research_package_hash");
    }
    let trustedImageReferenceManifest;
    if (imageReferenceManifest !== undefined) {
      if (operation !== "edit" || !baseDesign ||
        imageReferenceManifest.tenant_id !== scope.tenant_id ||
        imageReferenceManifest.project_id !== scope.project_id ||
        imageReferenceManifest.brief_id !== brief.brief_id || imageReferenceManifest.brief_hash !== briefHash ||
        imageReferenceManifest.research_package_id !== research.package_id ||
        imageReferenceManifest.research_package_hash !== packageHash ||
        imageReferenceManifest.base_design_version_id !== baseDesign.design_version_id ||
        imageReferenceManifest.base_design_hash !== baseDesign.design_hash) {
        throw new CreativeApiError("stale_version", operation, "image_reference_manifest.binding");
      }
      for (const reference of imageReferenceManifest.references) {
        if (!plan.source_refs.includes(reference.source_ref) ||
          !brief.source_identity.some((item) => item.source_id === reference.source_ref)) {
          throw new CreativeApiError("scope_denied", operation, "image_reference_manifest.references.source_ref");
        }
        const asset = research.assets.items.find((item) => item.asset_id === reference.asset_id);
        if (!asset || asset.source_id !== reference.source_ref || asset.content_hash !== reference.content_hash ||
            asset.media_type !== reference.media_type) {
          throw new CreativeApiError("stale_version", operation, "image_reference_manifest.references.asset_binding");
        }
        explicit.set(reference.asset_id, "modify");
      }
      trustedImageReferenceManifest = Object.freeze({
        contract: "CreativeImageReferenceManifest",
        schema_version: "1.0",
        tenant_id: scope.tenant_id,
        project_id: scope.project_id,
        brief_id: brief.brief_id,
        brief_hash: briefHash,
        research_package_id: research.package_id,
        research_package_hash: packageHash,
        base_design_version_id: baseDesign.design_version_id,
        base_design_hash: baseDesign.design_hash,
        references: Object.freeze(imageReferenceManifest.references.map((reference) => Object.freeze({
          source_ref: reference.source_ref,
          asset_id: reference.asset_id,
          content_hash: reference.content_hash,
          media_type: reference.media_type,
          width: reference.width,
          height: reference.height,
        }))),
      });
    }
    for (const asset of research.assets.items) {
      if (sourceRefs.has(asset.source_id) || sourceRefs.has(asset.asset_id) || sourceRefs.has(`asset:${asset.asset_id}`)) {
        explicit.set(asset.asset_id, explicit.get(asset.asset_id) ?? (operation === "generate" ? "reproduce" : "modify"));
      }
    }
    if (explicit.size === 0) return Object.freeze({ proofs: Object.freeze([]), image_reference_manifest: undefined });
    const requestedAssets = [];
    for (const [assetId, action] of explicit) {
      const asset = research.assets.items.find((item) => item.asset_id === assetId);
      const packagePermission = research.permissions.items.find((item) => item.asset_id === assetId && item.action === action);
      const briefPermission = brief.permissions.items.find((item) => item.asset_id === assetId && item.action === action);
      if (!asset || !packagePermission || packagePermission.status !== "granted" ||
        !briefPermission || briefPermission.status !== "granted") {
        throw new CreativeApiError("permission_denied", operation, "asset_permission");
      }
      requestedAssets.push({ asset, action });
    }
    const verifier = ports.planning?.assetPermissionVerifier;
    if (!isRecord(verifier) || typeof verifier.verifyAssetUse !== "function" ||
      typeof ports.storage?.isAssetFenced !== "function") {
      throw new CreativeApiError("unavailable", operation, "asset_permission_verifier");
    }
    const acceptedProofs = [];
    for (const { asset, action } of requestedAssets) {
      const requestedAt = new Date(now()).toISOString();
      let proof;
      try {
        proof = await verifier.verifyAssetUse({ tenant_id: scope.tenant_id, project_id: scope.project_id,
          asset_id: asset.asset_id, content_hash: asset.content_hash, action,
          package_id: research.package_id, package_hash: packageHash, now: requestedAt });
      } catch {
        throw new CreativeApiError("unavailable", operation, "asset_permission_verifier", { retryable: true });
      }
      const verifiedAt = new Date(now()).getTime();
      const checkedAt = typeof proof?.checked_at === "string" ? Date.parse(proof.checked_at) : NaN;
      const expiresAt = typeof proof?.expires_at === "string" ? Date.parse(proof.expires_at) : NaN;
      if (!isRecord(proof) || proof.status !== "granted" || proof.owner_evidence_status !== "verified" ||
        proof.tenant_id !== scope.tenant_id || proof.project_id !== scope.project_id || proof.asset_id !== asset.asset_id ||
        proof.content_hash !== asset.content_hash || proof.action !== action || proof.package_id !== research.package_id ||
        proof.package_hash !== packageHash || typeof proof.evidence_ref !== "string" || proof.evidence_ref.length < 1 ||
        !Number.isFinite(checkedAt) || checkedAt > verifiedAt || !Number.isFinite(expiresAt) || expiresAt <= verifiedAt) {
        throw new CreativeApiError("permission_denied", operation, "asset_permission_evidence");
      }
      acceptedProofs.push(Object.freeze({ asset_id: asset.asset_id, content_hash: asset.content_hash, action,
        package_id: research.package_id, package_hash: packageHash, checked_at: checkedAt, expires_at: expiresAt }));
    }
    // Bind the permission result to the still-current package after all owner
    // verifier awaits. The caller then performs its final same-DB fence/CAS.
    const currentRaw = await getPackage(Object.freeze({ scope }));
    let current;
    try { current = normalizeResearchPackage(immutableRequestSnapshot(currentRaw), scope); }
    catch { throw new CreativeApiError("unavailable", operation, "research_package"); }
    if (current.package_id !== research.package_id || canonicalHash(current) !== packageHash) {
      throw new CreativeApiError("stale_version", operation, "research_package_hash");
    }
    // The package read above can itself await. Check the durable asset fence
    // last so an invalidation committed during permission verification or the
    // current-package lookup cannot pass through to a transport call.
    for (const { asset } of requestedAssets) {
      if (await ports.storage.isAssetFenced(Object.freeze({ scope, asset_id: asset.asset_id,
        content_hash: asset.content_hash }))) {
        throw new CreativeApiError("permission_denied", operation, "asset_invalidation");
      }
    }
    const completedAt = new Date(now()).getTime();
    if (acceptedProofs.some((proof) => proof.expires_at <= completedAt)) {
      throw new CreativeApiError("permission_denied", operation, "asset_permission_evidence");
    }
    return Object.freeze({ proofs: Object.freeze(acceptedProofs), image_reference_manifest: trustedImageReferenceManifest });
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
    assertPublicIdentifiers(result, request.operation, "result");
    const record = await completeIfActive(Object.freeze({
      scope: started.scope,
      actor_id: principal.actor_id,
      job_id: started.job_id,
      lease_token: started.lease_token,
      action_id: request.action_id,
      operation: request.operation,
      result,
      publication_fence: publicationFence,
    }), async (transaction) => {
      const persisted = await persist(transaction);
      assertPublicIdentifiers(result, request.operation, "result");
      return persisted;
    });
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

  async function authorizeJobDispatch(principal, request, started, transportAttemptId, billableAttemptId,
    reservationRef, contextFence, route) {
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
        ...(reservationRef ? { reservation_ref: reservationRef } : {}),
        ...(route?.provider?.name ? { provider_name: route.provider.name } : {}),
        ...(route?.provider?.model ? { provider_model: route.provider.model } : {}),
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
    const telemetry = ports.telemetry;
    if (!isRecord(telemetry) || !isRecord(telemetry.modes) || !isRecord(telemetry.outbox) ||
      typeof telemetry.outbox.append !== "function" ||
      typeof telemetry.outbox.stagePendingEvidence !== "function" ||
      typeof telemetry.outbox.enqueueUsageObservation !== "function") {
      throw new CreativeApiError("unavailable", request.operation, "telemetry", { retryable: true });
    }
    const usageProfile = isRecord(telemetry.usage_profiles) && Object.hasOwn(telemetry.usage_profiles, operationKind)
      ? telemetry.usage_profiles[operationKind] : undefined;
    if (!Object.values(USAGE_PROFILE).includes(usageProfile)) {
      throw new CreativeApiError("unavailable", request.operation, "telemetry.usage_profile", { retryable: true });
    }
    const metering = ports.metering;
    const method = requiredPort(ports, portPath, request.operation);
    const checkedRoute = routeFor(route, request.operation);
    const attemptId = newBillableAttempt(request);
    const attempt = meteredAttempt(principal, request, attemptId, operationKind, checkedRoute);
    const deadline = startDeadline(request.operation, MAX_PORT_WAIT_MS, now);
    let providerValue;
    let validatedDecisionRequest;
    let preDispatchError;
    let currentPermissionProofs = Object.freeze([]);
    const dispatchIntentRefs = new Map();
    const checkDispatchFence = async () => {
      if (!preDispatchGuard) return;
      try {
        const current = await preDispatchGuard();
        if (Array.isArray(current)) currentPermissionProofs = current;
      }
      catch (error) { preDispatchError = error; throw error; }
    };
    const authorizeTransport = async (transportAttemptId, reservationRef) => {
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
          attempt.billable_attempt_id, reservationRef, contextFence, checkedRoute);
      } catch (error) {
        preDispatchError = error;
        throw error;
      }
      if (deadline.signal.aborted) throw new CreativeApiError("cancelled", request.operation, "deadline");
      await checkDispatchFence();
      dispatchIntentRefs.set(transportAttemptId, intentRef);
      return intentRef;
    };
    const assertFinalDispatchEligibility = (signal) => {
      const currentTime = new Date(now()).getTime();
      const deadlineTime = Date.parse(deadline.deadline_at);
      if (!Number.isFinite(currentTime) || !Number.isFinite(deadlineTime) || currentTime >= deadlineTime) {
        throw new CreativeApiError("cancelled", request.operation, "deadline");
      }
      if (signal?.aborted || deadline.signal.aborted || Date.parse(principal.expires_at) <= currentTime) {
        throw new CreativeApiError("cancelled", request.operation, "dispatch_authorization");
      }
      if (currentPermissionProofs.some((proof) => proof.expires_at <= currentTime)) {
        throw new CreativeApiError("permission_denied", request.operation, "asset_permission_evidence");
      }
    };
    const revalidateMappedDispatch = async (dispatchContext) => {
      const transportAttemptId = dispatchContext.transport_attempt_id;
      const expectedIntentRef = dispatchIntentRefs.get(transportAttemptId);
      if (!expectedIntentRef || dispatchContext.attempt.billable_attempt_id !== attempt.billable_attempt_id ||
          dispatchContext.reservation_ref === undefined || dispatchContext.dispatch_intent_ref !== expectedIntentRef ||
          dispatchContext.signal?.aborted || deadline.signal.aborted) {
        const error = new CreativeApiError("cancelled", request.operation, "dispatch_authorization");
        preDispatchError = error;
        throw error;
      }
      // Usage-profile mapping is an asynchronous trusted boundary. Recheck
      // current creative/package and per-asset rights after it, then make the
      // job/lease/context authorization the final await before C03 can decide
      // whether a complete observation is eligible for settlement.
      await checkDispatchFence();
      if (dispatchContext.signal?.aborted || deadline.signal.aborted) {
        const error = new CreativeApiError("cancelled", request.operation, "dispatch_authorization");
        preDispatchError = error;
        throw error;
      }
      let currentIntentRef;
      try {
        currentIntentRef = await authorizeJobDispatch(principal, request, started, transportAttemptId,
          attempt.billable_attempt_id, dispatchContext.reservation_ref, contextFence, checkedRoute);
      } catch (error) {
        preDispatchError = error;
        throw error;
      }
      if (currentIntentRef !== expectedIntentRef || dispatchContext.signal?.aborted || deadline.signal.aborted) {
        const error = new CreativeApiError(currentIntentRef !== expectedIntentRef ? "stale_version" : "cancelled",
          request.operation, "dispatch_authorization");
        preDispatchError = error;
        throw error;
      }
      try { assertFinalDispatchEligibility(dispatchContext.signal); }
      catch (error) {
        preDispatchError = error;
        throw error;
      }
    };
    let settledUsageMappingCandidate;
    const finishUsageMapping = async (dispatchContext, mappedUsage) => {
      const observation = mappedUsage?.observation;
      // Generic legacy consumers use a synchronous local usage profile. The
      // CE-03 owner mapper is an asynchronous authority boundary and must be
      // followed by fresh rights/job checks. If those checks fail, retain an
      // incomplete observation for reconciliation instead of dropping known
      // usage or letting C03 settle it.
      if (typeof telemetry.usage_profile_authority?.mapProviderUsage !== "function") return observation;
      try {
        await revalidateMappedDispatch(dispatchContext);
        if (mappedUsage?.mapping) settledUsageMappingCandidate = mappedUsage.mapping;
        return observation;
      } catch {
        return retainUsageWithoutSettlement(observation, dispatchContext.attempt);
      }
    };
    const revalidateTransport = async ({ transport_attempt_id, billable_attempt_id, reservation_ref,
      dispatch_intent_ref, signal }) => {
      boundedString(transport_attempt_id, "transport_attempt_id", 256);
      if (billable_attempt_id !== attempt.billable_attempt_id || signal?.aborted || deadline.signal.aborted) {
        throw new CreativeApiError("cancelled", request.operation, "dispatch_authorization");
      }
      await checkDispatchFence();
      if (signal?.aborted || deadline.signal.aborted) {
        throw new CreativeApiError("cancelled", request.operation, "dispatch_authorization");
      }
      let freshIntentRef;
      try {
        // This atomic, idempotent authorization is intentionally the final
        // awaited fence after the external Finance ACK and before dispatch.
        freshIntentRef = await authorizeJobDispatch(principal, request, started, transport_attempt_id,
          billable_attempt_id, reservation_ref, contextFence, checkedRoute);
      } catch (error) {
        preDispatchError = error;
        throw error;
      }
      if (freshIntentRef !== dispatch_intent_ref || signal?.aborted || deadline.signal.aborted) {
        const error = new CreativeApiError(signal?.aborted || deadline.signal.aborted ? "cancelled" : "stale_version",
          request.operation, "dispatch_authorization");
        preDispatchError = error;
        throw error;
      }
      dispatchIntentRefs.set(transport_attempt_id, freshIntentRef);
      try { assertFinalDispatchEligibility(signal); }
      catch (error) {
        preDispatchError = error;
        throw error;
      }
      return freshIntentRef;
    };
    let outcome;
    let evidenceRefs = [];
    let observationRef;
    let telemetryEvidence;
    try {
      const telemetryResult = await executeCreativeMeteredAttempt({
      meteringPort: metering,
      evidencePort: telemetry.outbox,
      observationOutbox: telemetry.outbox,
      request: attempt,
      trustedScope: meteredTrustedScope(principal),
      modes: telemetry.modes,
      idFactory,
      clock: () => new Date(now()),
      signal: deadline.signal,
      authorizeTransport: async ({ transport_attempt_id, reservation_ref }) =>
        authorizeTransport(transport_attempt_id, reservation_ref),
      revalidateTransport,
      dispatch: async (dispatchContext) => {
        const transportAttemptId = dispatchContext.transport_attempt_id;
        const dispatch_intent_ref = dispatchContext.dispatch_intent_ref;
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
            boundedString(transportId, "transport_attempt_id", 256);
            if (dispatchContext.signal?.aborted) throw new CreativeApiError("cancelled", request.operation, "deadline");
            // The telemetry executor owns idempotent transport identity reuse
            // and must revalidate the active job/context fence on every call.
            await dispatchContext.recordTransportAttempt(transportId);
            // C03 transport acknowledgment is an async boundary. Recheck
            // owner rights, current package, and same-database fences after it
            // and then do one final uncached atomic job/lease/context check.
            // Nothing asynchronous follows that authorization: these local
            // checks run synchronously immediately before returning the send
            // permit to the trusted provider adapter.
            await checkDispatchFence();
            const intentRef = dispatchIntentRefs.get(transportId);
            if (!intentRef) throw new CreativeApiError("unavailable", request.operation, "dispatch_authorization");
            let finalIntentRef;
            try {
              finalIntentRef = await authorizeJobDispatch(principal, request, started, transportId,
                dispatchContext.attempt.billable_attempt_id, dispatchContext.reservation_ref, contextFence, checkedRoute);
            } catch (error) {
              preDispatchError = error;
              throw error;
            }
            if (finalIntentRef !== intentRef) {
              const error = new CreativeApiError("stale_version", request.operation, "dispatch_authorization");
              preDispatchError = error;
              throw error;
            }
            try { assertFinalDispatchEligibility(dispatchContext.signal); }
            catch (error) {
              preDispatchError = error;
              throw error;
            }
            return intentRef;
          },
          async revalidateDispatch(binding) {
            if (!isRecord(binding) || binding.transport_attempt_id !== transportAttemptId ||
                binding.billable_attempt_id !== attempt.billable_attempt_id ||
                binding.reservation_ref !== dispatchContext.reservation_ref ||
                binding.dispatch_intent_ref !== dispatch_intent_ref ||
                typeof binding.target_binding_sha256 !== "string" ||
                !/^sha256:[a-f0-9]{64}$/.test(binding.target_binding_sha256) || binding.signal !== dispatchContext.signal) {
              throw new CreativeApiError("unavailable", request.operation, "dispatch_authorization");
            }
            return revalidateTransport({ transport_attempt_id: transportAttemptId,
              billable_attempt_id: attempt.billable_attempt_id, reservation_ref: dispatchContext.reservation_ref,
              dispatch_intent_ref, signal: dispatchContext.signal });
          },
          setDecisionRequest(value) { validatedDecisionRequest = value; },
        }); } catch (error) {
          const failed = providerFailureUsage(error);
          if (!failed) throw error;
          const mappedUsage = await usageObservation({ attempt: dispatchContext.attempt,
            trustedScope: meteredTrustedScope(principal), rawUsage: failed.usage, profile: usageProfile,
            transportAttemptId, idFactory, usageProfileAuthority: telemetry.usage_profile_authority,
            targetBindingSha256: failed.target_binding_sha256, reservationRef: dispatchContext.reservation_ref,
            dispatchIntentRef: dispatch_intent_ref, providerOutcome: failed.provider_outcome });
          return { provider_outcome: failed.provider_outcome,
            usage_observation: await finishUsageMapping(dispatchContext, mappedUsage) };
        }
        providerValue = dispatched?.value;
        const rawUsage = dispatched?.usage;
        const mappedUsage = await usageObservation({ attempt: dispatchContext.attempt,
          trustedScope: meteredTrustedScope(principal), rawUsage, profile: usageProfile, transportAttemptId,
          idFactory, usageProfileAuthority: telemetry.usage_profile_authority,
          targetBindingSha256: dispatched?.value?.target_binding_sha256, reservationRef: dispatchContext.reservation_ref,
          dispatchIntentRef: dispatch_intent_ref, providerOutcome: dispatched?.provider_outcome ?? "succeeded" });
        return { provider_outcome: dispatched?.provider_outcome ?? "succeeded",
          usage_observation: await finishUsageMapping(dispatchContext, mappedUsage) };
      },
    });
      outcome = telemetryResult.outcome;
      evidenceRefs = telemetryResult.evidence_refs;
      observationRef = telemetryResult.observation_ref;
      if (telemetryResult.pending_evidence) {
        const event = telemetryResult.pending_evidence;
        const staged = evidenceRefs.includes(event.event_id);
        telemetryEvidence = Object.freeze({ local_status: "pending", pending_event_id: event.event_id,
          pending_event_staged: staged,
          ...(!staged ? { pending_event: event, pending_event_hash: canonicalHash(event) } : {}) });
      } else {
        telemetryEvidence = Object.freeze({ local_status: telemetryResult.evidence_delivery });
      }
    } finally {
      deadline.dispose();
    }
    if (outcome.status !== "settled" || outcome.provider_outcome !== "succeeded") {
      if (preDispatchError) throw preDispatchError;
      throw meteringFailure(outcome, request.operation);
    }
    const mapping = settledUsageMappingCandidate;
    const usageEvidence = mapping && outcome.settlement?.status === "settled" &&
      outcome.observation_ack?.status && ["accepted", "duplicate"].includes(outcome.observation_ack.status) &&
      outcome.observation_ack.source_observation_id === mapping.source_observation_id &&
      outcome.observation_ack.effective_billable_attempt_id === mapping.billable_attempt_id &&
      mapping.billable_attempt_id === attempt.billable_attempt_id
      ? Object.freeze({ status: "settled_owner_mapping", ...mapping,
        observation_ref: observationRef ?? mapping.source_observation_id }) : undefined;
    return { value: providerValue, attempt_id: attemptId, decision_request: validatedDecisionRequest,
      metering: outcome, transport_attempt_ids: Object.freeze([...dispatchIntentRefs.keys()]),
      usage_ref: observationRef ?? outcome.observation_ack?.source_observation_id,
      ...(usageEvidence ? { usage_evidence: usageEvidence } : {}),
      evidence_refs: Object.freeze([...(evidenceRefs ?? [])]), telemetry_evidence: telemetryEvidence };
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

  async function decision(principal, request, started, brief, decisionRequest, baseDesign = null,
    selectedDesignVersionId = undefined, selectedDesignHash = undefined) {
    if (decisionRequest === undefined) return undefined;
    const branchMode = request.operation === "edit" && request.payload.selection_mode === "branch";
    const expectedCurrentDesignVersionId = branchMode ? undefined
      : (selectedDesignVersionId === undefined ? (baseDesign?.design_version_id ?? null) : selectedDesignVersionId);
    const expectedCurrentDesignHash = branchMode ? undefined
      : (selectedDesignHash === undefined ? (baseDesign?.design_hash ?? null) : selectedDesignHash);
    await assertCurrentCreativeContext(started.scope, brief, baseDesign, request.operation,
      expectedCurrentDesignVersionId, expectedCurrentDesignHash);
    const input = decisionInput(decisionRequest, principal, request, brief, started);
    const resolveRoute = requiredPort(ports, "decisionPort.resolveRoute", request.operation);
    const route = routeFor(await resolveRoute(Object.freeze({ scope: started.scope, actor_id: principal.actor_id, decision: input })), request.operation);
    await assertCurrentCreativeContext(started.scope, brief, baseDesign, request.operation,
      expectedCurrentDesignVersionId, expectedCurrentDesignHash);
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
        request.operation, expectedCurrentDesignVersionId, expectedCurrentDesignHash),
      creativeContextFence(brief, baseDesign, expectedCurrentDesignVersionId, expectedCurrentDesignHash));
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

  async function runImageOperation(principal, request, started, brief, baseDesign, expectedSelection = null) {
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
    let currentReferenceManifest;
    const assertImageContext = async () => {
      await assertCurrentCreativeContext(started.scope, brief, baseDesign, operation,
        expectedCurrentDesignVersionId, expectedCurrentDesignHash);
      const permissionContext = await verifyRequestedAssetPermissions(started.scope, brief, plan, operation,
        request.payload.image_reference_manifest, baseDesign, briefHash);
      const proofs = permissionContext.proofs;
      currentReferenceManifest = permissionContext.image_reference_manifest;
      await assertCurrentCreativeContext(started.scope, brief, baseDesign, operation,
        expectedCurrentDesignVersionId, expectedCurrentDesignHash);
      const checkedAt = new Date(now()).getTime();
      if (proofs.some((proof) => proof.expires_at <= checkedAt)) {
        throw new CreativeApiError("permission_denied", operation, "asset_permission_evidence");
      }
      return proofs;
    };
    const branchMode = operation === "edit" && request.payload.selection_mode === "branch";
    const expectedCurrentDesignVersionId = branchMode ? undefined
      : (operation === "generate" ? (expectedSelection?.design_version_id ?? null) : (baseDesign?.design_version_id ?? null));
    const expectedCurrentDesignHash = branchMode ? undefined
      : (operation === "generate" ? (expectedSelection?.design_hash ?? null) : (baseDesign?.design_hash ?? null));
    await assertImageContext();
    const decisionResult = await decision(principal, request, started, brief,
      request.payload.decision_request, baseDesign, expectedCurrentDesignVersionId, expectedCurrentDesignHash);
    const method = operation === "generate" ? "provider.generate" : "provider.edit";
    const resolveRoute = requiredPort(ports, "provider.resolveRoute", operation);
    const route = routeFor(await resolveRoute(Object.freeze({ scope: started.scope, actor_id: principal.actor_id, operation, plan })), operation);
    await assertImageContext();
      const privateAttributionPort = route.provider.name === "openai"
        ? requiredPort(ports, "jobs.recordPrivateProviderAttribution", operation)
        : ports.jobs?.recordPrivateProviderAttribution;
      const privateUsageAttributionPort = route.provider.name === "openai"
        ? requiredPort(ports, "jobs.recordPrivateProviderUsageAttribution", operation) : undefined;
      const privateAttributionPendingPort = route.provider.name === "openai"
        ? requiredPort(ports, "jobs.stagePrivateProviderAttribution", operation) : undefined;
      const metered = await runMetered(principal, request, started, operation === "generate" ? "image_generation" : "image_edit", route, method,
      async ({ method: dispatch, scope, actor_id, started: job, route: resolved, attempt, signal, deadline_at,
        reservation_ref, transportAttemptId, dispatch_intent_ref, recordTransportAttempt, revalidateDispatch }) => {
        const value = await dispatch(Object.freeze({ scope: started.scope, actor_id: principal.actor_id,
          job_id: started.job_id, attempt, route: resolved, brief, base_design: baseDesign, plan,
          ...(currentReferenceManifest ? { image_reference_manifest: currentReferenceManifest } : {}),
          decision_result: decisionResult, reservation_ref, transport_attempt_id: transportAttemptId, dispatch_intent_ref,
          recordTransportAttempt,
          revalidateDispatch,
          ...(typeof privateAttributionPort === "function" ? {
            async recordPrivateProviderRequestId(attribution) {
              if (!isRecord(attribution) || typeof attribution.provider_request_id !== "string" ||
                  typeof attribution.provider_request_ref !== "string") {
                throw new CreativeApiError("failed", operation, "provider_attribution");
              }
              const ack = await privateAttributionPort(Object.freeze({
                scope: started.scope,
                actor_id: principal.actor_id,
                job_id: started.job_id,
                action_id: request.action_id,
                request_hash: started.request_hash,
                operation,
                provider: "openai",
                model: route.provider.model,
                reservation_ref,
                billable_attempt_id: attempt.billable_attempt_id,
                transport_attempt_id: transportAttemptId,
                dispatch_intent_ref,
                provider_request_id: attribution.provider_request_id,
                provider_request_ref: attribution.provider_request_ref,
              }));
              if (!isRecord(ack) || !["recorded", "replayed"].includes(ack.status) ||
                  ack.transport_attempt_id !== transportAttemptId ||
                  ack.provider_request_ref !== attribution.provider_request_ref) {
                throw new CreativeApiError("unavailable", operation, "provider_attribution_ack");
              }
              return ack;
            },
          } : {}),
          ...(typeof privateUsageAttributionPort === "function" ? {
            async recordPrivateProviderUsage(attribution) {
              if (!isRecord(attribution) || !isRecord(attribution.usage) ||
                  typeof attribution.target_binding_sha256 !== "string") {
                throw new CreativeApiError("failed", operation, "provider_usage_attribution");
              }
              const usageHash = canonicalHash(attribution.usage);
              const ack = await privateUsageAttributionPort(Object.freeze({
                scope: started.scope,
                actor_id: principal.actor_id,
                job_id: started.job_id,
                action_id: request.action_id,
                request_hash: started.request_hash,
                operation,
                provider: "openai",
                model: route.provider.model,
                reservation_ref,
                billable_attempt_id: attempt.billable_attempt_id,
                transport_attempt_id: transportAttemptId,
                dispatch_intent_ref,
                target_binding_sha256: attribution.target_binding_sha256,
                usage_sha256: usageHash,
                usage: attribution.usage,
              }));
              if (!isRecord(ack) || !["recorded", "replayed"].includes(ack.status) ||
                  ack.transport_attempt_id !== transportAttemptId ||
                  ack.target_binding_sha256 !== attribution.target_binding_sha256 || ack.usage_sha256 !== usageHash) {
                throw new CreativeApiError("unavailable", operation, "provider_usage_attribution_ack");
              }
              return ack;
            },
          } : {}),
          ...(typeof privateAttributionPendingPort === "function" ? {
            async stagePrivateProviderAttribution(attribution) {
              if (!isRecord(attribution) || typeof attribution.target_binding_sha256 !== "string" ||
                  (attribution.provider_request_id === undefined) !== (attribution.provider_request_ref === undefined) ||
                  attribution.provider_request_id === undefined && attribution.usage === undefined) {
                throw new CreativeApiError("failed", operation, "provider_attribution_pending");
              }
              const pendingInput = Object.freeze({
                scope: started.scope,
                actor_id: principal.actor_id,
                job_id: started.job_id,
                action_id: request.action_id,
                request_hash: started.request_hash,
                operation,
                provider: "openai",
                model: route.provider.model,
                reservation_ref,
                billable_attempt_id: attempt.billable_attempt_id,
                transport_attempt_id: transportAttemptId,
                dispatch_intent_ref,
                target_binding_sha256: attribution.target_binding_sha256,
                ...(attribution.provider_request_id !== undefined ? {
                  provider_request_id: attribution.provider_request_id,
                  provider_request_ref: attribution.provider_request_ref,
                } : {}),
                ...(attribution.usage !== undefined ? { usage: attribution.usage } : {}),
              });
              const ack = await privateAttributionPendingPort(pendingInput);
              if (!isRecord(ack) || !["staged", "replayed"].includes(ack.status) ||
                  typeof ack.pending_ref !== "string" || ack.transport_attempt_id !== transportAttemptId ||
                  typeof ack.payload_sha256 !== "string" || !/^sha256:[a-f0-9]{64}$/.test(ack.payload_sha256)) {
                throw new CreativeApiError("unavailable", operation, "provider_attribution_pending_ack");
              }
              return ack;
            },
          } : {}),
          signal, deadline_at }));
        return { value, usage: value?.usage, provider_outcome: "succeeded" };
      }, assertImageContext,
      creativeContextFence(brief, baseDesign, expectedCurrentDesignVersionId, expectedCurrentDesignHash));
    const generated = metered.value;
    const usage = normalizeUsage(generated?.usage);
    const usageEvidence = metered.usage_evidence;
    const effectiveUsageCompleteness = usageEvidence?.status === "settled_owner_mapping"
      ? "complete" : (usage.completeness ?? "unknown");
    if (!isRecord(generated) || !isRecord(generated.artifact) ||
      typeof generated.artifact.artifact_id !== "string" || typeof generated.artifact.content_hash !== "string" ||
      typeof generated.artifact.media_type !== "string") {
      throw new CreativeApiError("failed", operation, "provider_result");
    }
    if (!(generated.artifact_bytes instanceof Uint8Array) || generated.artifact_bytes.byteLength === 0) {
      throw new CreativeApiError("failed", operation, "artifact_bytes");
    }
    // Copy bytes before any later storage await. Provider-owned buffers can be
    // reused or mutated after the call returns; the published hash must bind
    // the exact immutable snapshot below.
    const artifactBytes = Uint8Array.from(generated.artifact_bytes);
    if (hashArtifactBytes(artifactBytes) !== generated.artifact.content_hash) {
      throw new CreativeApiError("failed", operation, "artifact_content_hash");
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
      usage_status: effectiveUsageCompleteness === "complete" ? "complete" : "incomplete",
    };
    const design = { ...designBase, design_hash: computeDesignVersionHash(designBase) };
    validateDesignVersion(design, {
      trustedScope: { ...started.scope, design_version_id },
      brief_hash: briefHash,
      design_version_ids: baseDesign ? [baseDesign.design_version_id] : [],
      known_source_refs: allowedSourceRefs,
    });
    const providerRequestIds = [];
    if (generated.usage?.provider_request_id !== undefined) {
      providerRequestIds.push(publicIdentifier(generated.usage.provider_request_id, "provider_request_id", operation, 256));
    }
    const usageRefs = typeof metered.usage_ref === "string"
      ? [publicIdentifier(metered.usage_ref, "usage_ref", operation, 256)] : [];
    return { design, artifact_bytes: artifactBytes,
      telemetry_evidence: metered.telemetry_evidence,
      ...(usageEvidence ? { usage_evidence: usageEvidence } : {}),
      creation_evidence: { transport_attempt_ids: [...metered.transport_attempt_ids], provider_request_ids: providerRequestIds,
        usage_refs: usageRefs, evidence_refs: [...metered.evidence_refs] },
      usage: { completeness: effectiveUsageCompleteness }, attempt_id: metered.attempt_id };
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
        async ({ attempt, reservation_ref, signal, deadline_at, transportAttemptId, dispatch_intent_ref, recordTransportAttempt }) => {
          const value = await inspect(Object.freeze({ scope, actor_id: principal.actor_id, job_id: started.job_id,
            attempt, brief, design_version: design, reservation_ref, transport_attempt_id: transportAttemptId,
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
      publicIdentifier(result.inspection_id, "inspection_id", operation, 256);
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
        observations: Object.freeze(observations), usage: inspectionUsage,
        telemetry_evidence: metered.telemetry_evidence });
      const output = { inspection, attempt_id: metered.attempt_id };
      const job = await publish(principal, request, started, output, async () => undefined, {
        brief_id: brief.brief_id, brief_hash: canonicalHash(brief),
        design_version_id: design.design_version_id, design_hash: design.design_hash,
      });
      return projectPublicIdentifiers(Object.freeze({ ok: true, contract: "CreativeApiResponse", schema_version: CREATIVE_API_VERSION,
        operation_id: job.job_id, job: publicJob(job, job.job_id), result: inspection }), operation);
    }
    if (operation === "generate" || operation === "edit") {
      const brief = await loadBrief(scope, payload.brief_id, operation);
      if (typeof ports.storage?.isBriefUsable === "function" &&
        !(await ports.storage.isBriefUsable(Object.freeze({ scope, brief_id: brief.brief_id, brief_hash: canonicalHash(brief) })))) {
        throw new CreativeApiError("stale_version", operation, "brief_invalidation");
      }
      const baseDesign = operation === "edit"
        ? await loadDesign(scope, brief, payload.design_version_id, operation)
        : null;
      const branchMode = operation === "edit" && payload.selection_mode === "branch";
      let expectedSelection = Object.freeze({ design_version_id: null, design_hash: null });
      if (operation === "edit") {
        const getCurrent = requiredPort(ports, "storage.getCurrentDesignVersion", operation);
        const current = await getCurrent(Object.freeze({ scope, brief_id: brief.brief_id }));
        if (!branchMode && (!current || current.design_version_id !== baseDesign.design_version_id)) {
          throw new CreativeApiError("stale_version", operation, "design_version_id");
        }
        if (current) {
          assertScopedRecord(current, scope, operation, brief.brief_id);
          validateDesignVersion(current, { trustedScope: { ...scope, design_version_id: current.design_version_id }, brief_hash: canonicalHash(brief),
            known_source_refs: brief.source_identity.map((source) => source.source_id) });
          if (!branchMode && current.design_hash !== baseDesign.design_hash) throw new CreativeApiError("stale_version", operation, "design_hash");
        }
      } else {
        const getCurrent = requiredPort(ports, "storage.getCurrentDesignVersion", operation);
        const current = await getCurrent(Object.freeze({ scope, brief_id: brief.brief_id }));
        if (current !== null) {
          assertScopedRecord(current, scope, operation, brief.brief_id);
          const selected = await loadDesign(scope, brief, current.design_version_id, operation, { allowHistorical: true });
          if (selected.brief_hash === canonicalHash(brief)) throw new CreativeApiError("stale_version", operation, "brief_id");
          expectedSelection = Object.freeze({ design_version_id: selected.design_version_id, design_hash: selected.design_hash });
        }
      }
      const output = await runImageOperation(principal, request, started, brief, baseDesign, expectedSelection);
      const { artifact_bytes: _artifactBytes, creation_evidence: creationEvidence, ...publishedOutput } = output;
      const selectionMode = operation === "edit" && payload.selection_mode === "branch" ? "branch" : "advance";
      const creation = Object.freeze({
        job_id: started.job_id,
        action_id: request.action_id,
        actor_id: principal.actor_id,
        request_hash: started.request_hash,
        logical_operation_id: request.action_id,
        billable_attempt_id: output.design.billable_attempt_id,
        ...(baseDesign ? { parent_design_hash: baseDesign.design_hash } : {}),
        transport_attempt_ids: Object.freeze([...(creationEvidence?.transport_attempt_ids ?? [])]),
        provider_request_ids: Object.freeze([...(creationEvidence?.provider_request_ids ?? [])]),
        usage_refs: Object.freeze([...(creationEvidence?.usage_refs ?? [])]),
        trace_refs: Object.freeze([...(creationEvidence?.evidence_refs ?? [])]),
      });
      const saveInput = Object.freeze({ scope, brief_id: brief.brief_id,
        design_version: output.design,
        artifact_bytes: Uint8Array.from(output.artifact_bytes),
        selection_mode: selectionMode,
        creation,
        lease_token: started.lease_token,
        job_result: publishedOutput,
        expected_brief_hash: canonicalHash(brief),
        expected_current_design_version_id: selectionMode === "advance"
          ? (operation === "generate" ? expectedSelection.design_version_id : (baseDesign?.design_version_id ?? null)) : null,
        expected_current_design_hash: selectionMode === "advance"
          ? (operation === "generate" ? expectedSelection.design_hash : (baseDesign?.design_hash ?? null)) : null,
        expected_parent_design_version_id: baseDesign?.design_version_id ?? null,
        expected_parent_design_hash: baseDesign?.design_hash ?? null });
      const prepare = ports.storage?.prepareDesignVersion;
      const commitPrepared = ports.storage?.commitPreparedDesignVersion;
      if ((typeof prepare === "function") !== (typeof commitPrepared === "function")) {
        throw new CreativeApiError("unavailable", operation, "storage.version_transaction");
      }
      if (typeof prepare === "function") {
        const recordAttemptEvidence = requiredPort(ports, "jobs.recordAttemptEvidence", operation);
        const evidenceRecord = await recordAttemptEvidence(Object.freeze({
          scope,
          actor_id: principal.actor_id,
          job_id: started.job_id,
          lease_token: started.lease_token,
          action_id: request.action_id,
          request_hash: started.request_hash,
          creation,
        }));
        if (!isRecord(evidenceRecord) || !["recorded", "replayed"].includes(evidenceRecord.status)) {
          throw new CreativeApiError("unavailable", operation, "attempt_evidence");
        }
      }
      const prepared = typeof prepare === "function" ? await prepare(saveInput) : null;
      if (prepared !== null && (!isRecord(prepared) || prepared.status !== "prepared" ||
        prepared.action_id !== request.action_id || prepared.job_id !== started.job_id || typeof prepared.payload_hash !== "string")) {
        throw new CreativeApiError("unavailable", operation, "storage.version_intent");
      }
      const job = await publish(principal, request, started, publishedOutput, async (transaction) => {
        const saved = prepared
          ? await commitPrepared(Object.freeze({ scope, brief_id: brief.brief_id, action_id: prepared.action_id,
            job_id: prepared.job_id, payload_hash: prepared.payload_hash }), transaction)
          : await requiredPort(ports, "storage.saveDesignVersion", operation)(saveInput, transaction);
        if (!isRecord(saved) || saved.status !== "saved") throw new CreativeApiError("stale_version", operation);
      }, creativeContextFence(brief, baseDesign, branchMode ? undefined
        : (operation === "generate" ? expectedSelection.design_version_id : (baseDesign?.design_version_id ?? null)),
      branchMode ? undefined
        : (operation === "generate" ? expectedSelection.design_hash : (baseDesign?.design_hash ?? null))));
      return projectPublicIdentifiers(Object.freeze({ ok: true, contract: "CreativeApiResponse", schema_version: CREATIVE_API_VERSION,
        operation_id: job.job_id, job: publicJob(job, job.job_id), result: Object.freeze({
          design_version: output.design, usage: output.usage, telemetry_evidence: output.telemetry_evidence,
        }) }), operation);
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
        design_version_id: target.design_version_id, design_hash: target.design_hash, revision: selection.revision + 1,
      } }, async (transaction) => {
        const select = requiredPort(ports, "storage.selectDesignVersion", operation);
        const selectedResult = await select(Object.freeze({ scope, brief_id: brief.brief_id,
          design_version_id: target.design_version_id, expected_brief_hash: canonicalHash(brief),
          expected_target_design_hash: target.design_hash,
          expected_selected_design_version_id: selectedDesign.design_version_id,
          expected_selected_design_hash: selectedDesign.design_hash,
          expected_selection_revision: selection.revision }), transaction);
        if (!isRecord(selectedResult) || selectedResult.status !== "selected") throw new CreativeApiError("stale_version", operation);
        assertScopedRecord(selectedResult.selection, scope, operation, brief.brief_id);
        if (selectedResult.selection.design_version_id !== target.design_version_id ||
          selectedResult.selection.design_hash !== target.design_hash ||
          selectedResult.selection.revision !== selection.revision + 1) throw new CreativeApiError("failed", operation, "selection");
      }, Object.freeze({ ...creativeContextFence(brief, target),
        expected_current_design_version_id: selectedDesign.design_version_id,
        expected_current_design_hash: selectedDesign.design_hash }));
      return projectPublicIdentifiers(Object.freeze({ ok: true, contract: "CreativeApiResponse", schema_version: CREATIVE_API_VERSION,
        operation_id: selected.job_id, job: publicJob(selected, selected.job_id),
        result: Object.freeze({ selection: { tenant_id: scope.tenant_id, project_id: scope.project_id, brief_id: brief.brief_id,
          design_version_id: target.design_version_id, design_hash: target.design_hash, revision: selection.revision + 1 } }) }), operation);
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
      const handoff = projectPublicIdentifiers(await createArtworkHandoff({
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
      }), operation, "handoff");
      const handoffCreatedAt = new Date(now()).toISOString();
      const afterBuild = await readContext();
      if (canonicalSerialize(afterBuild) !== canonicalSerialize(initialContext)) throw new CreativeApiError("stale_version", operation, "handoff_context");
      const beforeSubmit = await readContext();
      if (canonicalSerialize(beforeSubmit) !== canonicalSerialize(initialContext)) throw new CreativeApiError("stale_version", operation, "handoff_context");
      const transportAttemptId = boundedString(idFactory(), "transport_attempt_id", 256);
      const dispatchIntentRef = await authorizeJobDispatch(principal, request, started, transportAttemptId, undefined,
        undefined, creativeContextFence(brief, design));
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
        assertPublicIdentifiers(receipt, operation, "receipt");
        const receiptNow = new Date(now());
        const consumedAt = validatedReceiptTime(receipt, receiptNow, operation);
        assertReceiptWindow(receipt, handoff, handoffCreatedAt, receiptNow, operation);
        // A consumer may return a valid receipt after the approval expires.
        // The receipt is accepted only if its trusted consumption timestamp is
        // within the original approval window and no later than trusted now.
        result.receipt = validateConsumptionReceipt(receipt, handoff, { trustedScope: handoffScope, now: consumedAt });
      }, creativeContextFence(brief, design));
      assertScopedRecord(job, handoffScope, operation);
      return projectPublicIdentifiers(Object.freeze({ ok: true, contract: "CreativeApiResponse", schema_version: CREATIVE_API_VERSION,
        operation_id: job.job_id, job: publicJob(job, job.job_id),
        result: Object.freeze({ handoff: result.handoff, receipt: result.receipt }) }), operation);
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
      assertStoredOnlyKeys(job.result, ["design", "usage", "usage_evidence", "attempt_id", "telemetry_evidence"], request.operation, "stored_result");
      const currentBrief = await loadBrief(started.scope, request.payload.brief_id, request.operation);
      const storedDesignInput = job.result.design;
      if (!isRecord(storedDesignInput) || storedDesignInput.brief_id !== currentBrief.brief_id ||
        typeof storedDesignInput.brief_hash !== "string") {
        throw new CreativeApiError("unavailable", request.operation, "stored_result");
      }
      let brief = currentBrief;
      if (storedDesignInput.brief_hash !== canonicalHash(currentBrief)) {
        const getBriefVersion = requiredPort(ports, "storage.getBriefVersionByHash", request.operation);
        const historical = await getBriefVersion(Object.freeze({ scope: started.scope,
          brief_id: currentBrief.brief_id, brief_hash: storedDesignInput.brief_hash }));
        if (!historical) throw new CreativeApiError("unavailable", request.operation, "stored_result.brief_history");
        assertScopedRecord(historical, started.scope, request.operation, currentBrief.brief_id);
        try { brief = validateCreativeBrief(historical, { trustedScope: { ...started.scope, brief_id: currentBrief.brief_id } }); }
        catch { throw new CreativeApiError("unavailable", request.operation, "stored_result.brief_history"); }
        if (canonicalHash(brief) !== storedDesignInput.brief_hash) {
          throw new CreativeApiError("unavailable", request.operation, "stored_result.brief_history");
        }
      }
      const stored = validateDesignVersion(job.result.design, {
        trustedScope: { ...started.scope, design_version_id: job.result.design?.design_version_id },
        brief_hash: canonicalHash(brief), known_source_refs: brief.source_identity.map((source) => source.source_id),
      });
      const current = await loadDesign(started.scope, brief, stored.design_version_id, request.operation);
      if (job.result.usage_evidence !== undefined) {
        const usageEvidence = job.result.usage_evidence;
        const usageEvidenceKeys = ["status", "profile_ref", "profile_sha256", "raw_usage_sha256",
          "target_binding_sha256", "attempt_binding_sha256", "source_observation_id", "transport_attempt_id",
          "billable_attempt_id", "provider_name", "model", "observation_sha256", "observation_ref"];
        try {
          assertStoredOnlyKeys(usageEvidence, usageEvidenceKeys, request.operation, "stored_result.usage_evidence");
          if (usageEvidence.status !== "settled_owner_mapping" ||
              usageEvidence.billable_attempt_id !== current.billable_attempt_id ||
              usageEvidence.provider_name !== current.provider || usageEvidence.model !== current.model ||
              current.usage_status !== "complete" || job.result.usage?.completeness !== "complete" ||
              typeof usageEvidence.profile_ref !== "string" || typeof usageEvidence.source_observation_id !== "string" ||
              typeof usageEvidence.observation_ref !== "string" || typeof usageEvidence.transport_attempt_id !== "string" ||
              !/^sha256:[a-f0-9]{64}$/.test(usageEvidence.profile_sha256) ||
              !/^sha256:[a-f0-9]{64}$/.test(usageEvidence.raw_usage_sha256) ||
              !/^sha256:[a-f0-9]{64}$/.test(usageEvidence.target_binding_sha256) ||
              !/^sha256:[a-f0-9]{64}$/.test(usageEvidence.attempt_binding_sha256) ||
              !/^sha256:[a-f0-9]{64}$/.test(usageEvidence.observation_sha256)) {
            throw new CreativeApiError("unavailable", request.operation, "stored_result.usage_evidence");
          }
          for (const field of ["profile_ref", "source_observation_id", "observation_ref", "transport_attempt_id"]) {
            assertSafePublicIdentifier(usageEvidence[field], { maxLength: 256 });
          }
        } catch {
          throw new CreativeApiError("unavailable", request.operation, "stored_result.usage_evidence");
        }
      }
      if (canonicalSerialize(stored) !== canonicalSerialize(current) || !isRecord(job.result.usage) ||
        job.result.usage.completeness !== "complete" || job.result.attempt_id !== current.billable_attempt_id) {
        throw new CreativeApiError("unavailable", request.operation, "stored_result");
      }
      const telemetryEvidence = await validateTelemetryEvidenceStatus(job.result.telemetry_evidence, request.operation, {
        tenant_id: principal.tenant_id, project_id: principal.project_id, budget_scope_id: principal.budget_scope_id,
        logical_operation_id: request.action_id, billable_attempt_id: current.billable_attempt_id,
      }, ports.telemetry?.outbox);
      return Object.freeze({ design_version: current, usage: Object.freeze({ completeness: "complete" }),
        telemetry_evidence: telemetryEvidence });
    }
    if (request.operation === "restore") {
      assertStoredOnlyKeys(job.result, ["selection"], request.operation, "stored_result");
      const selection = job.result.selection;
      assertStoredOnlyKeys(selection, ["tenant_id", "project_id", "brief_id", "design_version_id", "design_hash", "revision"],
        request.operation, "stored_selection");
      if (!isRecord(selection) || selection.tenant_id !== principal.tenant_id || selection.project_id !== principal.project_id ||
        selection.brief_id !== request.payload.brief_id || selection.design_version_id !== request.payload.target_design_version_id ||
        selection.design_hash !== undefined && (typeof selection.design_hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(selection.design_hash)) ||
        !Number.isSafeInteger(selection.revision) ||
        selection.revision !== request.payload.expected_selection_revision + 1) {
        throw new CreativeApiError("unavailable", request.operation, "stored_selection");
      }
      const brief = await loadBrief(started.scope, request.payload.brief_id, request.operation);
      const design = await loadDesign(started.scope, brief, selection.design_version_id, request.operation);
      if (selection.design_hash !== undefined && selection.design_hash !== design.design_hash) {
        throw new CreativeApiError("unavailable", request.operation, "stored_selection");
      }
      return Object.freeze({ selection: Object.freeze({ tenant_id: selection.tenant_id,
        project_id: selection.project_id, brief_id: selection.brief_id,
        design_version_id: selection.design_version_id, design_hash: design.design_hash, revision: selection.revision }) });
    }
    if (request.operation === "inspect") {
      assertStoredOnlyKeys(job.result, ["inspection", "attempt_id"], request.operation, "stored_result");
      const brief = await loadBrief(started.scope, request.payload.brief_id, request.operation);
      const design = await loadDesign(started.scope, brief, request.payload.design_version_id, request.operation);
      const result = job.result.inspection;
      if (!isRecord(result)) throw new CreativeApiError("unavailable", request.operation, "stored_inspection");
      assertStoredOnlyKeys(result, ["tenant_id", "project_id", "brief_id", "design_version_id", "artifact_id", "artifact_hash",
        "design_hash", "inspection_id", "observations", "usage", "telemetry_evidence"], request.operation, "stored_inspection");
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
      publicIdentifier(result.inspection_id, "stored_inspection.inspection_id", request.operation, 256);
      const telemetryEvidence = await validateTelemetryEvidenceStatus(result.telemetry_evidence, request.operation, {
        tenant_id: principal.tenant_id, project_id: principal.project_id, budget_scope_id: principal.budget_scope_id,
        logical_operation_id: request.action_id, billable_attempt_id: started.job.result.attempt_id,
      }, ports.telemetry?.outbox);
      return Object.freeze({ tenant_id: result.tenant_id, project_id: result.project_id, brief_id: result.brief_id,
        design_version_id: result.design_version_id, artifact_id: result.artifact_id,
        artifact_hash: result.artifact_hash, design_hash: result.design_hash,
        inspection_id: result.inspection_id, observations: Object.freeze(observations), usage: normalizedUsage,
        telemetry_evidence: telemetryEvidence });
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
      const assertOperationAvailable = ports.jobs?.assertOperationAvailable;
      if (typeof assertOperationAvailable === "function") {
        const availability = await assertOperationAvailable(Object.freeze({ operation }));
        if (!isRecord(availability) || availability.status !== "available") {
          throw new CreativeApiError("unavailable", operation, "operation_capability", { retryable: true });
        }
      }
      await emitTrace({ event: "creative_api.request", operation, request_id: request.request_id,
        tenant_id: principal.tenant_id, project_id: principal.project_id, actor_id: principal.actor_id });
      if (operation === "brief.create") return await createBrief(principal, request);
      if (operation === "brief.invalidate") return await invalidateBrief(principal, request);
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
        const items = await Promise.all(page.items.map((item) => {
          assertScopedRecord(item, scope, operation, scope.brief_id);
          return loadDesign(scope, brief, item.design_version_id, operation, { allowHistorical: true });
        }));
        const sorted = [...items].sort(compareOrder);
        if (canonicalSerialize(sorted) !== canonicalSerialize(items) ||
          (after && items.some((item) => !isAfterCursor(item, after)))) throw new CreativeApiError("failed", operation, "page_order");
        const visible = items.slice(0, limit);
        const hasMore = page.has_more || items.length > limit;
        return projectPublicIdentifiers(Object.freeze({ ok: true, contract: "CreativeApiResponse", schema_version: CREATIVE_API_VERSION,
          result: Object.freeze({ items: visible, next_cursor: hasMore && visible.length ? encodeCursor(scope, scope.brief_id, visible.at(-1)) : null }) }), operation);
      }
      if (operation === "compare") {
        const scope = scopeFor(principal, boundedString(request.payload.brief_id, "brief_id"));
        const brief = await loadBrief(scope, scope.brief_id, operation);
        const [left, right] = await Promise.all([
          loadDesign(scope, brief, request.payload.left_design_version_id, operation, { allowHistorical: true }),
          loadDesign(scope, brief, request.payload.right_design_version_id, operation, { allowHistorical: true }),
        ]);
        return projectPublicIdentifiers(Object.freeze({ ok: true, contract: "CreativeApiResponse", schema_version: CREATIVE_API_VERSION,
          result: Object.freeze({ left, right, changed_fields: Object.freeze([
            ...(left.artifact.content_hash !== right.artifact.content_hash ? ["artifact.content_hash"] : []),
            ...(left.parent_version_id !== right.parent_version_id ? ["parent_version_id"] : []),
            ...(left.brief_hash !== right.brief_hash ? ["brief_hash"] : []),
          ]) }) }), operation);
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
        return projectPublicIdentifiers(Object.freeze({ ok: true, contract: "CreativeApiResponse", schema_version: CREATIVE_API_VERSION,
          job: publicJob(job, job.job_id) }), operation);
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
        return projectPublicIdentifiers(Object.freeze({ ok: true, contract: "CreativeApiResponse", schema_version: CREATIVE_API_VERSION,
          job: publicJob(record.job, record.job.job_id) }), operation);
      }
      const started = await beginMutation(principal, request);
      if (started.replayed) {
        if (started.job.status === "completed") {
          const replayedResult = await validateReplay(principal, request, started);
          return projectPublicIdentifiers(Object.freeze({ ok: true, contract: "CreativeApiResponse", schema_version: CREATIVE_API_VERSION,
            operation_id: started.job.job_id, replayed: true, job: publicJob(started.job, started.job.job_id),
            result: replayedResult }), operation);
        }
        return projectPublicIdentifiers(Object.freeze({ ok: true, contract: "CreativeApiResponse", schema_version: CREATIVE_API_VERSION,
          operation_id: started.job.job_id, replayed: true, job: publicJob(started.job, started.job.job_id),
        }), operation);
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
