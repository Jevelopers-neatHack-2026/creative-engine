import {
  ContractError,
  assertTrustedScope,
  canonicalHash,
  normalizeResearchPackage,
  validateCreativeBrief,
} from "../contracts/index.mjs";
import { acceptVerifiedInvalidation } from "./store.mjs";
export { createCreativeBriefStore, openCreativeBriefStore } from "./store.mjs";

export const CREATIVE_BRIEF_PLANNER_VERSION = "creative-engine.planning/1.0";
export const CREATIVE_BRIEF_REQUIRED_FACT_KEYS = Object.freeze(["event_name", "event_date"]);

const HASH_PREFIX = "sha256:";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const SAFE_ENVIRONMENTS = new Set(["development", "test", "production"]);
const SAFE_BILLING_MODES = new Set(["live", "sandbox", "simulated"]);
const SENSITIVE_KEY = /(?:credential|secret|password|authorization|bearer|cookie|api[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|admission[_-]?(?:code|token|credential)|ticket[_-]?(?:code|token|barcode)|qr[_-]?(?:code|token)|barcode)/i;
const SENSITIVE_VALUE = /(?:\bbearer\s+\S+|\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\b(?:rk|pk)-[A-Za-z0-9_-]{12,}\b|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b(?:ticket|admission|barcode|qr)[ _:-]+(?:code|token|credential|id)[ _:#-]+[A-Za-z0-9_-]{6,})/i;
const BASIC_AUTH_CANDIDATE = /\bBasic[\t ]+([A-Za-z0-9+/]+={0,2})(?![A-Za-z0-9+/=])/gi;
const SIGNED_URL_PARAMETER = /^(?:signature|sig|token|access[_-]?token|auth|authorization|api[_-]?key|credential|secret|x-amz-(?:signature|security-token|credential)|x-goog-(?:signature|credential))$/i;
const FACT_PROMPTS = Object.freeze({
  event_name: "Please confirm the exact event name.",
  event_date: "Please confirm the exact event date.",
});
const SAFE_INVALIDATION_REASONS = new Set([
  "fact_corrected",
  "fact_source_changed",
  "asset_permission_revoked",
  "asset_permission_expired",
  "source_freshness_expired",
]);
const INVALIDATION_KINDS = new Set(["fact", "asset"]);

export class CreativePlanningError extends Error {
  constructor(code, message, field = undefined) {
    super(message);
    this.name = "CreativePlanningError";
    this.code = code;
    if (field !== undefined) this.field = field;
  }
}

function fail(code, message, field) {
  throw new CreativePlanningError(code, message, field);
}

function hasBasicAuthMaterial(value) {
  BASIC_AUTH_CANDIDATE.lastIndex = 0;
  let match;
  while ((match = BASIC_AUTH_CANDIDATE.exec(value)) !== null) {
    const token = match[1];
    const unpadded = token.replace(/=+$/, "");
    if (unpadded.length % 4 === 1) continue;
    const decoded = Buffer.from(token, "base64");
    const canonical = decoded.toString("base64");
    if (canonical !== token && canonical.replace(/=+$/, "") !== token) continue;
    const colon = decoded.indexOf(0x3a);
    if (colon < 0) continue;
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
    } catch {
      // RFC 7617 also permits the default ISO-8859-1 repertoire. Decode that
      // form only when every byte is printable Latin-1, excluding C1 controls.
      if ([...decoded].some((byte) => byte < 0x20 || byte === 0x7f || (byte >= 0x80 && byte < 0xa0))) continue;
      text = decoded.toString("latin1");
    }
    if ([...text].some((character) => /[\p{Cc}\p{Cf}]/u.test(character))) continue;
    return true;
  }
  return false;
}

function decodedVariants(value) {
  const variants = [value];
  let decoded = value;
  let exhausted = false;
  let malformed = false;
  for (let index = 0; index < 8; index += 1) {
    try {
      const next = decodeURIComponent(decoded.replace(/\+/g, "%20"));
      if (next === decoded) break;
      decoded = next;
      variants.push(decoded);
      if (index === 7 && /%[0-9a-f]{2}/i.test(decoded)) exhausted = true;
    } catch {
      // Decode valid escape runs independently. A malformed neighbour must
      // not shield a valid encoded email, credential, or signed URL.
      const next = decoded.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
        const bytes = Buffer.from(run.match(/[0-9a-f]{2}/gi).map((hex) => Number.parseInt(hex, 16)));
        try {
          return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          malformed = true;
          // Replace malformed byte sequences while preserving all independent
          // ASCII/UTF-8 suffixes so invalid bytes cannot conceal sensitive text.
          return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
        }
      });
      if (/%(?![0-9a-f]{2})/i.test(decoded)) malformed = true;
      if (next === decoded) break;
      decoded = next;
      variants.push(decoded);
      if (index === 7 && /%[0-9a-f]{2}/i.test(decoded)) exhausted = true;
    }
  }
  return { variants, exhausted, malformed };
}

function privacyVariants(values) {
  const expanded = [];
  for (const value of values) {
    expanded.push(value);
    if (value.includes("\ufffd")) expanded.push(value.replace(/\ufffd+/g, ""));
  }
  return expanded;
}

function hasSignedUrl(value, variants) {
  for (const variant of privacyVariants(variants)) {
    const candidates = variant.match(/https?:\/\/[^\s"'<>]+/gi) ?? [];
    for (const candidate of candidates) {
      const candidateVariants = decodedVariants(candidate);
      if (candidateVariants.exhausted || candidateVariants.malformed) return true;
      for (const decoded of privacyVariants(candidateVariants.variants)) {
        if (SENSITIVE_VALUE.test(decoded) || hasBasicAuthMaterial(decoded)) return true;
      }
      const decoded = candidateVariants.variants.at(-1);
      try {
        const parsed = new URL(decoded);
        if (parsed.username || parsed.password) return true;
        for (const [key, queryValue] of parsed.searchParams) {
          const keyVariants = decodedVariants(key);
          const valueVariants = decodedVariants(queryValue);
          if (keyVariants.exhausted || valueVariants.exhausted) return true;
          if (keyVariants.variants.some((item) => SIGNED_URL_PARAMETER.test(item))) return true;
          if (valueVariants.variants.some((item) => SENSITIVE_VALUE.test(item) || hasBasicAuthMaterial(item))) return true;
        }
      } catch {
        // Malformed URLs are handled by the normal input contract.
      }
    }
  }
  return false;
}

function hasSensitivePublicText(value, { uri = false } = {}) {
  const screening = decodedVariants(value);
  if (screening.exhausted || (uri && screening.malformed)) return true;
  for (const variant of privacyVariants(screening.variants)) {
    if (SENSITIVE_VALUE.test(variant) || hasBasicAuthMaterial(variant)) return true;
  }
  return hasSignedUrl(value, privacyVariants(screening.variants));
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function expectRecord(value, field) {
  if (!isRecord(value)) fail("invalid_input", "Input must be a plain JSON object.", field);
  return value;
}

function expectString(value, field, { max = 2048, pattern = null } = {}) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max || (pattern && !pattern.test(value))) {
    fail("invalid_input", "A required text field is missing or invalid.", field);
  }
  const isUri = /(?:^|\.)uri$/i.test(field);
  if (hasSensitivePublicText(value, { uri: isUri })) fail("sensitive_input", "Sensitive content cannot be included in a brief output.", field);
  return value;
}

function expectIsoDateTime(value, field) {
  const text = expectString(value, field, { max: 40, pattern: ISO_DATE_TIME });
  const millis = Date.parse(text);
  if (!Number.isFinite(millis)) fail("invalid_input", "A UTC date-time is required.", field);
  return text;
}

function validateTrustedScope(value, field = "trusted_scope") {
  expectRecord(value, field);
  return {
    tenant_id: expectString(value.tenant_id, `${field}.tenant_id`, { max: 200, pattern: SAFE_ID }),
    project_id: expectString(value.project_id, `${field}.project_id`, { max: 200, pattern: SAFE_ID }),
  };
}

function safeJsonValue(value, field, depth = 0) {
  if (depth > 32) fail("invalid_input", "Input exceeds the supported nesting depth.", field);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > 20_000) fail("invalid_input", "Text exceeds the supported size.", field);
    if (hasSensitivePublicText(value)) fail("sensitive_input", "Sensitive content cannot be included in a brief output.", field);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("invalid_input", "Only finite JSON numbers are supported.", field);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => safeJsonValue(entry, `${field}[${index}]`, depth + 1));
  if (!isRecord(value)) fail("invalid_input", "Input must contain only plain JSON values.", field);
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key) || hasSensitivePublicText(key)) fail("sensitive_input", "Sensitive fields cannot be included in a brief output.", field);
    Object.defineProperty(output, key, {
      value: safeJsonValue(entry, field, depth + 1),
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return output;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function hash(value) {
  try {
    return canonicalHash(value);
  } catch {
    fail("invalid_input", "The supplied value is not canonical JSON.");
  }
}

function validateContractCall(callback, code = "research_package_invalid") {
  try {
    return callback();
  } catch (error) {
    if (error instanceof CreativePlanningError) throw error;
    if (error instanceof ContractError) {
      throw new CreativePlanningError(error.code, "The research or creative record does not satisfy the supported local contract.", error.field);
    }
    throw new CreativePlanningError(code, "The research or creative record could not be validated.");
  }
}

function safeFactSource(fact, index) {
  return {
    index,
    fact_id: expectString(fact.fact_id, `research_package.facts[${index}].fact_id`, { max: 200, pattern: SAFE_ID }),
    key: expectString(fact.key, `research_package.facts[${index}].key`, { max: 200, pattern: SAFE_ID }),
    status: fact.status,
    provenance_refs: fact.provenance.map((entry, provenanceIndex) =>
      expectString(entry.source_id, `research_package.facts[${index}].provenance[${provenanceIndex}].source_id`, { max: 200, pattern: SAFE_ID })),
    provenance: fact.provenance.map((entry) => ({
      source_id: expectString(entry.source_id, `research_package.facts[${index}].provenance.source_id`, { max: 200, pattern: SAFE_ID }),
      ...(entry.retrieved_at ? { retrieved_at: entry.retrieved_at } : { retrieved_at_status: "unknown" }),
      ...(entry.evidence_ref ? { evidence_ref_hash: hash(entry.evidence_ref) } : {}),
    })),
  };
}

function requiredFactResults(packageFacts, requiredKeys) {
  return requiredKeys.map((key) => {
    const matches = packageFacts.filter((fact) => fact.key === key);
    const verified = matches.filter((fact) => fact.status === "verified" && isUsableRequiredValue(key, fact.value));
    const distinct = new Set(verified.map((fact) => hash(fact.value)));
    let status = "ready";
    if (matches.length === 0) status = "missing";
    else if (matches.some((fact) => fact.status === "conflicting") || distinct.size > 1) status = "conflicting";
    else if (matches.some((fact) => fact.status === "unknown") || verified.length === 0) status = "unknown";
    if (status === "ready") return { fact_key: key, status, source_fact_ids: verified.map((fact) => fact.fact_id) };
    const digest = hash({ key, status, source_fact_ids: matches.map((fact) => fact.fact_id) });
    return {
      clarification_id: `clarification:${digest.slice(HASH_PREFIX.length)}`,
      fact_key: key,
      status,
      question: Object.hasOwn(FACT_PROMPTS, key)
        ? FACT_PROMPTS[key]
        : "Please confirm the exact value for this required event detail.",
      source_fact_ids: matches.map((fact) => fact.fact_id),
    };
  });
}

function isUsableRequiredValue(key, value) {
  if (key === "event_name") return typeof value === "string" && value.trim().length > 0;
  if (key === "event_date") {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }
  return value !== null && value !== "";
}

function buildCorrectionRequests(corrections, packageFacts, packageRef, scope, briefId) {
  if (corrections === undefined) return [];
  if (!Array.isArray(corrections)) fail("invalid_input", "Fact corrections must be an array.", "fact_corrections");
  return corrections.map((candidate, index) => {
    const field = `fact_corrections[${index}]`;
    expectRecord(candidate, field);
    const factId = expectString(candidate.fact_id, `${field}.fact_id`, { max: 200, pattern: SAFE_ID });
    const fact = packageFacts.find((entry) => entry.fact_id === factId && entry.status === "verified");
    if (!fact) fail("correction_target_unverified", "A correction must target an existing verified fact.", `${field}.fact_id`);
    const proposedValue = safeJsonValue(candidate.proposed_value, `${field}.proposed_value`);
    const currentHash = hash(fact.value);
    const proposedHash = hash(proposedValue);
    if (currentHash === proposedHash) {
      return { status: "no_change", fact_id: fact.fact_id, current_value_hash: currentHash };
    }
    const identity = hash({
      tenant_id: scope.tenant_id,
      project_id: scope.project_id,
      package_id: packageRef.package_id,
      package_hash: packageRef.content_hash,
      fact_id: fact.fact_id,
      current_value_hash: currentHash,
      proposed_value_hash: proposedHash,
    });
    const requestId = `research-correction:${identity.slice(HASH_PREFIX.length)}`;
    return {
      contract: "ResearchCorrectionRequest",
      schema_version: "1.0",
      request_id: requestId,
      idempotency_key: identity,
      status: "pending_research_owner",
      tenant_id: scope.tenant_id,
      project_id: scope.project_id,
      source_package_ref: packageRef,
      fact_id: fact.fact_id,
      key: fact.key,
      current_value_hash: currentHash,
      proposed_value_hash: proposedHash,
      proposed_value: proposedValue,
      approval_staleness_request: {
        request_id: `approval-staleness:${identity.slice(HASH_PREFIX.length)}`,
        status: "pending_application_acknowledgment",
        brief_id: briefId,
        fact_id: fact.fact_id,
        current_brief_hash_pending: true,
      },
    };
  });
}

function assetReadiness(research) {
  const assets = research.assets.items;
  const permissions = research.permissions.items;
  return assets.map((asset) => {
    const permission = permissions.find((entry) => entry.asset_id === asset.asset_id && entry.action === "reproduce");
    const assetId = expectString(asset.asset_id, "research_package.assets.asset_id", { max: 200, pattern: SAFE_ID });
    const contentHash = expectString(asset.content_hash, "research_package.assets.content_hash", { max: 71, pattern: /^sha256:[a-f0-9]{64}$/ });
    if (!permission) return { asset_id: assetId, content_hash: contentHash, state: "blocked", reason: "permission_missing" };
    if (permission.status !== "granted") {
      return { asset_id: assetId, content_hash: contentHash, state: "blocked", reason: `permission_${permission.status}` };
    }
    return { asset_id: assetId, content_hash: contentHash, state: "verification_required", reason: "external_permission_verifier_pending" };
  });
}

function validatePlanningContext(context, research) {
  expectRecord(context, "context");
  const createdAt = expectIsoDateTime(context.created_at, "context.created_at");
  const environment = expectString(context.environment, "context.environment", { max: 20 });
  if (!SAFE_ENVIRONMENTS.has(environment)) fail("invalid_input", "Unsupported environment.", "context.environment");
  const billingMode = expectString(context.billing_mode, "context.billing_mode", { max: 20 });
  if (!SAFE_BILLING_MODES.has(billingMode)) fail("invalid_input", "Unsupported billing mode.", "context.billing_mode");
  const correlationId = context.correlation_id === undefined
    ? expectString(research.correlation_id, "research_package.correlation_id", { max: 200, pattern: SAFE_ID })
    : expectString(context.correlation_id, "context.correlation_id", { max: 200, pattern: SAFE_ID });
  return { createdAt, environment, billingMode, correlationId };
}

/**
 * Deterministically projects a validated research package into a CreativeBrief.
 * This function performs no network, provider, budget, rights, or approval calls.
 */
export function buildCreativeBrief(input) {
  expectRecord(input, "input");
  const trustedScope = validateTrustedScope(input.trusted_scope);
  const research = validateContractCall(() => normalizeResearchPackage(input.research_package, trustedScope));
  validateContractCall(() => assertTrustedScope(research, trustedScope, "EventIntelligencePackage"));
  const context = validatePlanningContext(input.context, research);

  const preferencesInput = input.customer_preferences ?? [];
  if (!Array.isArray(preferencesInput)) fail("invalid_input", "Customer preferences must be an array.", "customer_preferences");
  const customerPreferences = preferencesInput.map((candidate, index) => {
    const field = `customer_preferences[${index}]`;
    expectRecord(candidate, field);
    const preferenceId = expectString(candidate.preference_id, `${field}.preference_id`, { max: 200, pattern: SAFE_ID });
    const value = expectString(candidate.value, `${field}.value`, { max: 1000 });
    return { preference_id: preferenceId, value, origin: "customer" };
  });

  const artisticIntentInput = input.artistic_intent ?? [];
  if (!Array.isArray(artisticIntentInput)) fail("invalid_input", "Artistic intent must be an array.", "artistic_intent");
  const customerInterpretations = artisticIntentInput.map((candidate, index) => {
    const field = `artistic_intent[${index}]`;
    expectRecord(candidate, field);
    return {
      interpretation_id: expectString(candidate.interpretation_id, `${field}.interpretation_id`, { max: 200, pattern: SAFE_ID }),
      text: expectString(candidate.text, `${field}.text`, { max: 2000 }),
      basis: "customer_visual_direction",
      origin: "customer",
    };
  });

  const extraRequired = input.additional_required_fact_keys ?? [];
  if (!Array.isArray(extraRequired)) fail("invalid_input", "Additional required fact keys must be an array.", "additional_required_fact_keys");
  const requiredKeys = [...new Set([
    ...CREATIVE_BRIEF_REQUIRED_FACT_KEYS,
    ...extraRequired.map((key, index) => expectString(key, `additional_required_fact_keys[${index}]`, { max: 200, pattern: SAFE_ID })),
  ])];

  const locksInput = input.locked_fields ?? [];
  if (!Array.isArray(locksInput)) fail("invalid_input", "Locked fields must be an array.", "locked_fields");
  const sourceLocks = research.locks.items.map((lock, index) => ({
    ...safeJsonValue(lock, `research_package.locks.items[${index}]`),
    origin: "research_package",
  }));
  const customerLocks = locksInput.map((candidate, index) => {
    const field = `locked_fields[${index}]`;
    expectRecord(candidate, field);
    const targetField = expectString(candidate.field, `${field}.field`, { max: 200, pattern: SAFE_ID });
    const fact = research.facts.find((entry) => entry.key === targetField && entry.status === "verified");
    if (!fact) fail("lock_target_unverified", "A locked field must match an existing verified fact.", `${field}.field`);
    const reason = expectString(candidate.reason, `${field}.reason`, { max: 500 });
    const lockDigest = hash({ field: targetField, fact_id: fact.fact_id, value_hash: hash(fact.value) });
    return {
      lock_id: `lock:${lockDigest.slice(HASH_PREFIX.length)}`,
      field: targetField,
      value_hash: hash(fact.value),
      reason,
      origin: "customer",
    };
  });

  const sourceFactProjection = research.facts.map(safeFactSource);
  const preferenceItems = [
    ...research.preferences.items.map((item, index) => ({
      ...safeJsonValue(item, `research_package.preferences.items[${index}]`),
      origin: "research_package",
    })),
    ...customerPreferences,
  ];
  const preferencePresence = preferenceItems.length > 0
    ? "present"
    : research.preferences.presence;
  const interpretationItems = [
    ...research.interpretations.items.map((item, index) => ({
      ...safeJsonValue(item, `research_package.interpretations.items[${index}]`),
      origin: "research_untrusted",
    })),
    ...customerInterpretations,
  ];
  const interpretationPresence = interpretationItems.length > 0
    ? "present"
    : research.interpretations.presence;

  const sourcePackageHash = hash(research);
  const packageRef = {
    contract: "EventIntelligencePackage",
    schema_version: research.schema_version,
    package_id: expectString(research.package_id, "research_package.package_id", { max: 200, pattern: SAFE_ID }),
    content_hash: sourcePackageHash,
  };
  const briefId = `brief:${hash({
    tenant_id: trustedScope.tenant_id,
    project_id: trustedScope.project_id,
    source_package_id: packageRef.package_id,
  }).slice(HASH_PREFIX.length)}`;
  const revisionEventId = `brief-build:${hash({
    brief_id: briefId,
    package_ref: packageRef,
    customer_preferences: customerPreferences,
    customer_interpretations: customerInterpretations,
    customer_locks: customerLocks,
    created_at: context.createdAt,
  }).slice(HASH_PREFIX.length)}`;
  const factCorrections = buildCorrectionRequests(input.fact_corrections, research.facts, packageRef, trustedScope, briefId);

  const verifiedFacts = research.facts.filter((fact) => fact.status === "verified").map((fact) => ({
    fact_id: expectString(fact.fact_id, "research_package.facts.fact_id", { max: 200, pattern: SAFE_ID }),
    key: expectString(fact.key, "research_package.facts.key", { max: 200, pattern: SAFE_ID }),
    value: safeJsonValue(fact.value, "research_package.facts.value"),
    provenance_refs: fact.provenance.map((entry, index) => expectString(entry.source_id, `research_package.facts.provenance[${index}].source_id`, { max: 200, pattern: SAFE_ID })),
    field_provenance: sourceFactProjection.find((entry) => entry.fact_id === fact.fact_id).provenance,
  }));
  const unresolvedFacts = research.facts.filter((fact) => fact.status !== "verified").map((fact) => ({
    fact_id: expectString(fact.fact_id, "research_package.facts.fact_id", { max: 200, pattern: SAFE_ID }),
    key: expectString(fact.key, "research_package.facts.key", { max: 200, pattern: SAFE_ID }),
    status: fact.status,
    ...(fact.candidate_values ? { candidate_values: safeJsonValue(fact.candidate_values, "research_package.facts.candidate_values") } : {}),
    provenance_refs: fact.provenance.map((entry, index) => expectString(entry.source_id, `research_package.facts.provenance[${index}].source_id`, { max: 200, pattern: SAFE_ID })),
    field_provenance: sourceFactProjection.find((entry) => entry.fact_id === fact.fact_id).provenance,
  }));

  const brief = {
    contract: "CreativeBrief",
    schema_version: "1.0",
    event_id: revisionEventId,
    tenant_id: trustedScope.tenant_id,
    project_id: trustedScope.project_id,
    correlation_id: context.correlationId,
    producer: CREATIVE_BRIEF_PLANNER_VERSION,
    occurred_at: context.createdAt,
    ingested_at: context.createdAt,
    environment: context.environment,
    billing_mode: context.billingMode,
    source_refs: research.source_refs.map((ref, index) => expectString(ref, `research_package.source_refs[${index}]`, { max: 300 })),
    brief_id: briefId,
    research_package_ref: packageRef,
    source_identity: research.source_identity.map(({ source_id, uri }, index) => ({
      source_id: expectString(source_id, `research_package.source_identity[${index}].source_id`, { max: 200, pattern: SAFE_ID }),
      uri: expectString(uri, `research_package.source_identity[${index}].uri`, { max: 2048 }),
    })),
    facts: { verified: verifiedFacts, unresolved: unresolvedFacts },
    preferences: {
      presence: preferencePresence,
      items: preferenceItems,
      research_presence: research.preferences.presence,
      customer_presence: customerPreferences.length > 0 ? "present" : "absent",
    },
    interpretations: {
      presence: interpretationPresence,
      items: interpretationItems,
      research_presence: research.interpretations.presence,
      customer_presence: customerInterpretations.length > 0 ? "present" : "absent",
    },
    permissions: {
      presence: research.permissions.presence,
      items: research.permissions.items.map((permission, index) => safeJsonValue(permission, `research_package.permissions.items[${index}]`)),
    },
    locks: {
      presence: (sourceLocks.length + customerLocks.length) > 0 ? "present" : research.locks.presence,
      items: [...sourceLocks, ...customerLocks],
    },
    planning_policy: {
      version: CREATIVE_BRIEF_PLANNER_VERSION,
      deterministic: true,
      source_instructions_executable: false,
      source_can_change_budget: false,
      source_can_grant_asset_permission: false,
      provider_dispatch_allowed: false,
    },
  };
  validateContractCall(() => validateCreativeBrief(brief, {
    trustedScope: { ...trustedScope, brief_id: briefId },
    researchPackage: research,
  }), "creative_brief_invalid");

  const requiredResults = requiredFactResults(research.facts, requiredKeys);
  const clarifications = requiredResults.filter((item) => item.status !== "ready");
  const result = {
    contract: "CreativeBriefPlan",
    schema_version: "1.0",
    brief,
    brief_hash: hash(brief),
    research_provenance: {
      package_id: expectString(research.package_id, "research_package.package_id", { max: 200, pattern: SAFE_ID }),
      package_hash: sourcePackageHash,
      package_schema_version: research.schema_version,
      facts: sourceFactProjection,
    },
    required_facts: requiredResults,
    clarification_requests: clarifications,
    correction_requests: factCorrections,
    asset_readiness: assetReadiness(research),
    original_artwork_alternative: {
      available_when_assets_blocked: true,
      uses_research_assets: false,
      preserves_verified_fact_ids: verifiedFacts.map((fact) => fact.fact_id),
    },
    execution_policy: {
      deterministic_only: true,
      provider_calls: 0,
      provider_dispatch_allowed: false,
      budget_mutation_allowed: false,
      asset_permission_mutation_allowed: false,
      external_acceptance: "pending",
    },
  };
  return deepFreeze({ ...result, plan_hash: hash(result) });
}

export function createResearchInvalidationRequest(input) {
  expectRecord(input, "input");
  const trustedScope = validateTrustedScope(input.trusted_scope);
  const event = expectRecord(input.event, "event");
  const eventId = expectString(event.event_id, "event.event_id", { max: 200, pattern: SAFE_ID });
  const kind = expectString(event.kind, "event.kind", { max: 16 });
  if (!INVALIDATION_KINDS.has(kind)) fail("invalid_invalidation", "Unsupported invalidation kind.", "event.kind");
  const reason = expectString(event.reason, "event.reason", { max: 80 });
  if (!SAFE_INVALIDATION_REASONS.has(reason)) fail("invalid_invalidation", "Unsupported invalidation reason.", "event.reason");
  const tenantId = expectString(event.tenant_id, "event.tenant_id", { max: 200, pattern: SAFE_ID });
  const projectId = expectString(event.project_id, "event.project_id", { max: 200, pattern: SAFE_ID });
  if (tenantId !== trustedScope.tenant_id || projectId !== trustedScope.project_id) {
    fail("scope_mismatch", "Invalidation scope does not match trusted application context.", "trusted_scope");
  }
  if ((kind === "fact" && !["fact_corrected", "fact_source_changed", "source_freshness_expired"].includes(reason)) ||
    (kind === "asset" && !["asset_permission_revoked", "asset_permission_expired", "source_freshness_expired"].includes(reason))) {
    fail("invalid_invalidation", "The invalidation reason does not match its target kind.", "event.reason");
  }
  const packageId = expectString(event.source_package_id, "event.source_package_id", { max: 200, pattern: SAFE_ID });
  const packageHash = expectString(event.source_package_hash, "event.source_package_hash", { max: 71, pattern: /^sha256:[a-f0-9]{64}$/ });
  if (!Number.isSafeInteger(event.source_revision) || event.source_revision < 1) {
    fail("invalid_invalidation", "Invalidation source revision must be a positive integer.", "event.source_revision");
  }
  const occurredAt = expectIsoDateTime(event.occurred_at, "event.occurred_at");
  const affected = [];
  if (kind === "fact") {
    if (!Array.isArray(event.fact_ids) || event.fact_ids.length === 0) fail("invalid_invalidation", "Fact invalidation requires fact IDs.", "event.fact_ids");
    for (const [index, factId] of event.fact_ids.entries()) {
      affected.push({ kind: "fact", fact_id: expectString(factId, `event.fact_ids[${index}]`, { max: 200, pattern: SAFE_ID }) });
    }
    if (new Set(affected.map((entry) => entry.fact_id)).size !== affected.length) {
      fail("invalid_invalidation", "Fact invalidation targets must be unique.", "event.fact_ids");
    }
  } else {
    if (!Array.isArray(event.assets) || event.assets.length === 0) fail("invalid_invalidation", "Asset invalidation requires asset references.", "event.assets");
    for (const [index, candidate] of event.assets.entries()) {
      const field = `event.assets[${index}]`;
      expectRecord(candidate, field);
      affected.push({
        kind: "asset",
        asset_id: expectString(candidate.asset_id, `${field}.asset_id`, { max: 200, pattern: SAFE_ID }),
        content_hash: expectString(candidate.content_hash, `${field}.content_hash`, { max: 71, pattern: /^sha256:[a-f0-9]{64}$/ }),
        action: "reproduce",
      });
    }
    if (new Set(affected.map((entry) => `${entry.asset_id}\u0000${entry.content_hash}`)).size !== affected.length) {
      fail("invalid_invalidation", "Asset invalidation targets must be unique.", "event.assets");
    }
  }
  const briefRefs = event.affected_briefs ?? [];
  if (!Array.isArray(briefRefs)) fail("invalid_invalidation", "Affected brief references must be an array.", "event.affected_briefs");
  const affectedBriefs = briefRefs.map((candidate, index) => {
    const field = `event.affected_briefs[${index}]`;
    expectRecord(candidate, field);
    return {
      brief_id: expectString(candidate.brief_id, `${field}.brief_id`, { max: 200, pattern: SAFE_ID }),
      brief_hash: expectString(candidate.brief_hash, `${field}.brief_hash`, { max: 71, pattern: /^sha256:[a-f0-9]{64}$/ }),
    };
  });
  if (new Set(affectedBriefs.map((entry) => `${entry.brief_id}\u0000${entry.brief_hash}`)).size !== affectedBriefs.length) {
    fail("invalid_invalidation", "Affected brief references must be unique.", "event.affected_briefs");
  }
  const normalized = {
    schema: "creative-research-invalidation/1.0",
    event_id: eventId,
    tenant_id: tenantId,
    project_id: projectId,
    source_package_id: packageId,
    source_package_hash: packageHash,
    source_revision: event.source_revision,
    occurred_at: occurredAt,
    kind,
    reason,
    affected,
    affected_briefs: affectedBriefs,
  };
  const contentHash = hash(normalized);
  const idempotencyKey = hash({ tenant_id: tenantId, project_id: projectId, event_id: eventId, content_hash: contentHash });
  return deepFreeze({ ...normalized, content_hash: contentHash, idempotency_key: idempotencyKey });
}

function validateTrustedInvalidationEvidence(event, evidence, now) {
  expectRecord(evidence, "verification_evidence");
  if (evidence.status !== "verified" || evidence.event_hash !== event.content_hash ||
    evidence.event_id !== event.event_id || evidence.tenant_id !== event.tenant_id || evidence.project_id !== event.project_id) {
    fail("invalidation_unverified", "Research owner verification did not bind this exact invalidation.", "verification_evidence");
  }
  if (evidence.classification !== "owner_verified" && evidence.classification !== "synthetic_test") {
    fail("invalidation_unverified", "Invalidation verification classification is not recognized.", "verification_evidence.classification");
  }
  const evidenceRef = expectString(evidence.evidence_ref, "verification_evidence.evidence_ref", { max: 512 });
  const verifiedAt = expectIsoDateTime(evidence.verified_at, "verification_evidence.verified_at");
  const validUntil = expectIsoDateTime(evidence.valid_until, "verification_evidence.valid_until");
  const nowMs = Date.parse(now);
  if (Date.parse(verifiedAt) > nowMs || Date.parse(validUntil) <= nowMs) {
    fail("invalidation_unverified", "Invalidation verification is not current.", "verification_evidence");
  }
  return {
    status: "verified",
    classification: evidence.classification,
    evidence_ref_hash: hash(evidenceRef),
    verified_at: verifiedAt,
    valid_until: validUntil,
    event_hash: event.content_hash,
    event_id: event.event_id,
    tenant_id: event.tenant_id,
    project_id: event.project_id,
  };
}

/**
 * Verifies an external owner invalidation, durably adds local fences, emits approval-staleness
 * requests and only then acknowledges the producer. Fence rows are monotonic and never cleared.
 */
export async function applyResearchInvalidation(input) {
  expectRecord(input, "input");
  const trustedScope = validateTrustedScope(input.trusted_scope);
  const event = createResearchInvalidationRequest({ trusted_scope: trustedScope, event: input.event });
  const ports = expectRecord(input.ports, "ports");
  const clock = ports.clock;
  if (!clock || typeof clock.now !== "function") {
    fail("trusted_clock_unavailable", "A trusted current-time port is required for invalidation verification.", "ports.clock");
  }
  const currentTime = () => {
    try {
      return expectIsoDateTime(clock.now(), "ports.clock.now");
    } catch {
      fail("trusted_clock_unavailable", "The trusted current-time port did not return a valid time.", "ports.clock");
    }
  };
  const startedAt = currentTime();
  const store = ports.store;
  if (!store || typeof store.persistInvalidationAndFences !== "function" ||
    typeof store.getInvalidationReceipt !== "function" ||
    typeof store.listPendingApprovalStaleness !== "function" ||
    typeof store.recordApprovalStalenessAcknowledgment !== "function" ||
    typeof store.getProducerAcknowledgment !== "function" ||
    typeof store.recordProducerAcknowledgment !== "function" ||
    typeof store.assertInvalidationBoundary !== "function") {
    fail("invalidation_store_unavailable", "The durable creative invalidation store is unavailable.", "ports.store");
  }
  const assertCommittedBoundary = () => store.assertInvalidationBoundary();
  assertCommittedBoundary();
  let receipt = store.getInvalidationReceipt(trustedScope.tenant_id, trustedScope.project_id, event.event_id);
  let evidence;
  if (receipt) {
    if (receipt.event_hash !== event.content_hash || receipt.idempotency_key !== event.idempotency_key) {
      fail("invalidation_event_conflict", "A persisted event ID is bound to different invalidation content.", "event.event_id");
    }
    evidence = { classification: receipt.verification_classification };
  }
  const verifier = ports.verifier;
  if (!receipt) {
    if (!verifier || typeof verifier.verifyInvalidation !== "function") {
      fail("invalidation_verifier_unavailable", "The trusted research-owner invalidation verifier is unavailable.", "ports.verifier");
    }
    let verifiedRaw;
    try {
      verifiedRaw = await verifier.verifyInvalidation({ event, trusted_scope: trustedScope, now: startedAt });
    } catch {
      fail("invalidation_verification_unavailable", "The trusted research-owner verifier did not return a decision.", "ports.verifier");
    }
    const verifiedAt = currentTime();
    evidence = validateTrustedInvalidationEvidence(event, verifiedRaw, verifiedAt);
    acceptVerifiedInvalidation(event, evidence);
    assertCommittedBoundary();
    receipt = store.persistInvalidationAndFences(event, evidence);
  }
  assertCommittedBoundary();
  const approvalPort = ports.approvalStaleness;
  const staleReceipts = [];
  if (approvalPort && typeof approvalPort.markBriefStale === "function") {
    for (const request of store.listPendingApprovalStaleness(event.tenant_id, event.project_id, event.event_id)) {
      assertCommittedBoundary();
      let response;
      try {
        response = await approvalPort.markBriefStale(request);
      } catch {
        fail("approval_staleness_unconfirmed", "The application did not confirm the exact approval-staleness request.", "ports.approvalStaleness");
      }
      if (!response || response.status !== "acknowledged" || response.request_id !== request.request_id ||
        response.brief_id !== request.brief_id || response.brief_hash !== request.brief_hash ||
        response.event_id !== event.event_id || response.tenant_id !== event.tenant_id || response.project_id !== event.project_id) {
        fail("approval_staleness_unconfirmed", "The application did not acknowledge the exact approval-staleness request.", "ports.approvalStaleness");
      }
      assertCommittedBoundary();
      const stored = store.recordApprovalStalenessAcknowledgment(response);
      staleReceipts.push(stored);
    }
  }
  const ackPort = ports.producerAcknowledgment;
  let producerAcknowledgment = store.getProducerAcknowledgment(event.tenant_id, event.project_id, event.event_id);
  const pendingStaleness = store.listPendingApprovalStaleness(event.tenant_id, event.project_id, event.event_id);
  if (!producerAcknowledgment && pendingStaleness.length === 0 && ackPort &&
    typeof ackPort.acknowledgeInvalidation === "function" &&
    typeof store.recordProducerAcknowledgment === "function") {
    assertCommittedBoundary();
    let response;
    try {
      response = await ackPort.acknowledgeInvalidation({
        event_id: event.event_id,
        idempotency_key: event.idempotency_key,
        event_hash: event.content_hash,
        durable_receipt_id: receipt.receipt_id,
        tenant_id: event.tenant_id,
        project_id: event.project_id,
      });
    } catch {
      fail("producer_acknowledgment_unconfirmed", "The research producer did not confirm the persisted invalidation.", "ports.producerAcknowledgment");
    }
    if (!response || response.status !== "acknowledged" || response.event_id !== event.event_id ||
      response.idempotency_key !== event.idempotency_key || response.event_hash !== event.content_hash ||
      response.tenant_id !== event.tenant_id || response.project_id !== event.project_id) {
      fail("producer_acknowledgment_unconfirmed", "The research producer did not acknowledge the persisted invalidation.", "ports.producerAcknowledgment");
    }
    assertCommittedBoundary();
    producerAcknowledgment = store.recordProducerAcknowledgment(response);
  }
  const finalReceipt = store.getInvalidationReceipt(trustedScope.tenant_id, trustedScope.project_id, event.event_id);
  const acknowledgedStaleness = finalReceipt.approval_requests.filter((item) => item.status === "acknowledged").length;
  const pendingAfterRun = finalReceipt.approval_requests.filter((item) => item.status === "pending").length;
  return deepFreeze({
    event_id: event.event_id,
    event_hash: event.content_hash,
    durable_receipt: finalReceipt,
    approval_staleness: {
      requested: finalReceipt.approval_requests.length,
      acknowledged: acknowledgedStaleness,
      status: pendingAfterRun === 0 ? "acknowledged" : "pending",
      receipts: staleReceipts,
    },
    producer_acknowledgment: producerAcknowledgment,
    verification_classification: evidence.classification,
  });
}

export async function resolveAssetUse(input) {
  expectRecord(input, "input");
  const trustedScope = validateTrustedScope(input.trusted_scope);
  const plan = expectRecord(input.plan, "plan");
  const research = validateContractCall(() => normalizeResearchPackage(input.research_package, trustedScope));
  validateContractCall(() => validateCreativeBrief(plan.brief, {
    trustedScope: { ...trustedScope, brief_id: plan.brief?.brief_id },
    researchPackage: research,
  }), "creative_brief_invalid");
  if (plan.brief.research_package_ref?.content_hash !== hash(research)) {
    fail("research_package_mismatch", "The brief does not match the current research package.", "research_package_ref.content_hash");
  }
  if (plan.brief_hash !== hash(plan.brief)) fail("brief_hash_mismatch", "The plan's brief hash does not match its record.", "brief_hash");
  if (plan.research_provenance?.package_hash !== hash(research)) {
    fail("research_package_mismatch", "The plan provenance does not bind the current research package.", "research_provenance.package_hash");
  }
  const { plan_hash: planHash, ...planBody } = plan;
  if (planHash !== hash(planBody)) fail("plan_hash_mismatch", "The plan hash does not match its immutable content.", "plan_hash");
  const clock = input.clock;
  const currentTime = () => {
    if (!clock || typeof clock.now !== "function") return null;
    try {
      return expectIsoDateTime(clock.now(), "clock.now");
    } catch {
      return null;
    }
  };
  const clockAvailable = Boolean(clock && typeof clock.now === "function");
  const verifier = input.permission_verifier;
  const store = input.invalidation_store;
  const decisions = [];
  for (const asset of research.assets.items) {
    const assetId = expectString(asset.asset_id, "research_package.assets.asset_id", { max: 200, pattern: SAFE_ID });
    const contentHash = expectString(asset.content_hash, "research_package.assets.content_hash", { max: 71, pattern: /^sha256:[a-f0-9]{64}$/ });
    const permission = research.permissions.items.find((entry) => entry.asset_id === assetId && entry.action === "reproduce");
    if (!permission || permission.status !== "granted") {
      decisions.push({ asset_id: assetId, content_hash: contentHash, state: "blocked", reason: permission ? `permission_${permission.status}` : "permission_missing" });
      continue;
    }
    const requestedAt = currentTime();
    if (!verifier || typeof verifier.verifyAssetUse !== "function" || !store || typeof store.isAssetFenced !== "function" || !clockAvailable || !requestedAt) {
      decisions.push({ asset_id: assetId, content_hash: contentHash, state: "blocked", reason: !clockAvailable ? "trusted_clock_unavailable" : "external_permission_or_invalidation_port_unavailable" });
      continue;
    }
    let proof;
    try {
      proof = await verifier.verifyAssetUse({
        tenant_id: trustedScope.tenant_id,
        project_id: trustedScope.project_id,
        asset_id: assetId,
        content_hash: contentHash,
        action: "reproduce",
        package_id: expectString(research.package_id, "research_package.package_id", { max: 200, pattern: SAFE_ID }),
        package_hash: hash(research),
        now: requestedAt,
      });
    } catch {
      decisions.push({ asset_id: assetId, content_hash: contentHash, state: "blocked", reason: "permission_verifier_unavailable" });
      continue;
    }
    if (!proof || proof.status !== "granted" || proof.tenant_id !== trustedScope.tenant_id || proof.project_id !== trustedScope.project_id ||
      proof.asset_id !== assetId || proof.content_hash !== contentHash || proof.action !== "reproduce" ||
      proof.package_id !== research.package_id || proof.package_hash !== hash(research)) {
      decisions.push({ asset_id: assetId, content_hash: contentHash, state: "blocked", reason: "permission_proof_unavailable_or_mismatched" });
      continue;
    }
    const checkedAt = expectIsoDateTime(proof.checked_at, "permission_proof.checked_at");
    const expiresAt = expectIsoDateTime(proof.expires_at, "permission_proof.expires_at");
    const verifiedAt = currentTime();
    if (!verifiedAt) {
      decisions.push({ asset_id: assetId, content_hash: contentHash, state: "blocked", reason: "trusted_clock_unavailable" });
      continue;
    }
    const validAt = Date.parse(verifiedAt);
    if (Date.parse(checkedAt) > validAt || Date.parse(expiresAt) <= validAt || proof.owner_evidence_status !== "verified") {
      decisions.push({ asset_id: assetId, content_hash: contentHash, state: "blocked", reason: "permission_proof_expired_or_unverified" });
      continue;
    }
    if (store.isAssetFenced(trustedScope.tenant_id, trustedScope.project_id, assetId, contentHash)) {
      decisions.push({ asset_id: assetId, content_hash: contentHash, state: "blocked", reason: "asset_invalidation_fence_active" });
      continue;
    }
    decisions.push({
      asset_id: assetId,
      content_hash: contentHash,
      state: "eligible_for_downstream_revalidation",
      permission_evidence_ref_hash: hash(expectString(proof.evidence_ref, "permission_proof.evidence_ref", { max: 512 })),
      expires_at: expiresAt,
      dispatch_authorized: false,
    });
  }
  const usable = decisions.filter((entry) => entry.state === "eligible_for_downstream_revalidation");
  return deepFreeze({
    decisions,
    eligible_asset_refs: usable.map((entry) => ({ asset_id: entry.asset_id, content_hash: entry.content_hash })),
    original_artwork_alternative: { available: usable.length !== research.assets.items.length, uses_research_assets: false },
    dispatch_authorized: false,
    downstream_must_revalidate_at_use: true,
  });
}

export function persistCreativeBrief(store, plan, trustedScope) {
  if (!store || typeof store.appendBriefVersion !== "function") fail("brief_store_unavailable", "The durable creative brief store is unavailable.", "store");
  expectRecord(plan, "plan");
  const checkedScope = validateTrustedScope(trustedScope);
  if (plan.brief?.tenant_id !== checkedScope.tenant_id || plan.brief?.project_id !== checkedScope.project_id) {
    fail("scope_mismatch", "The brief is outside the separately trusted store scope.", "trusted_scope");
  }
  validateContractCall(() => validateCreativeBrief(plan.brief, {
    trustedScope: { ...checkedScope, brief_id: plan.brief?.brief_id },
  }), "creative_brief_invalid");
  if (hash(plan.brief) !== plan.brief_hash) fail("brief_hash_mismatch", "The brief hash does not match its immutable record.", "brief_hash");
  const { plan_hash: planHash, ...planBody } = plan;
  if (planHash !== hash(planBody)) fail("plan_hash_mismatch", "The plan hash does not match its immutable content.", "plan_hash");
  return store.appendBriefVersion({
    brief: plan.brief,
    brief_hash: plan.brief_hash,
    created_at: plan.brief.occurred_at,
  });
}
