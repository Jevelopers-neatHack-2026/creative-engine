import {
  MeteringContractError,
  METERING_PROPOSAL_VERSION,
  validateMeteredAttempt,
  validateUsageObservation,
} from "../contracts/metering.mjs";
import { canonicalSerialize } from "../contracts/validation.mjs";
import { assertSafePublicIdentifier, containsSensitivePublicText } from "./privacy.mjs";

export const USAGE_PROFILE = Object.freeze({
  NORMALIZED: "creative.normalized-token-usage/1",
  OPENAI_RESPONSES: "openai.responses-usage/2026-10-10",
  OPENAI_GPT_IMAGE_1: "openai.gpt-image-1-usage/2026-10-10",
  TYPESAFE_DECISION: "typesafe.systemone-usage/2026-10-10",
});

const PROFILE_FIELDS = Object.freeze({
  [USAGE_PROFILE.NORMALIZED]: Object.freeze({
    root: ["input_tokens", "output_tokens", "total_tokens"],
    inputDetails: [],
    outputDetails: [],
    required: ["input_tokens", "output_tokens"],
  }),
  [USAGE_PROFILE.OPENAI_RESPONSES]: Object.freeze({
    root: ["input_tokens", "output_tokens", "total_tokens"],
    inputDetails: ["cached_tokens", "cache_write_tokens"],
    outputDetails: ["reasoning_tokens"],
    required: ["input_tokens", "output_tokens", "total_tokens"],
  }),
  [USAGE_PROFILE.OPENAI_GPT_IMAGE_1]: Object.freeze({
    root: ["input_tokens", "output_tokens", "total_tokens"],
    inputDetails: ["image_tokens", "text_tokens"],
    outputDetails: ["image_tokens", "text_tokens"],
    required: ["input_tokens", "output_tokens", "total_tokens"],
  }),
  [USAGE_PROFILE.TYPESAFE_DECISION]: Object.freeze({
    root: ["input_tokens", "output_tokens"],
    inputDetails: [],
    outputDetails: [],
    required: ["input_tokens", "output_tokens"],
  }),
});

const OBSERVATION_SOURCES = new Set(["provider_response", "provider_usage_api", "trace", "billing_export", "other"]);
const SAFE_METERING_ERROR_CODES = new Set([
  "invalid_object", "unknown_field", "invalid_identifier", "invalid_exact_amount", "invalid_currency",
  "trusted_scope_mismatch", "unsupported_version", "identity_collision", "invalid_environment",
  "invalid_billing_mode", "unsupported_operation_kind", "budget_scope_mismatch",
  "attempt_identity_mismatch", "invalid_usage_source", "provider_identity_mismatch",
  "billing_context_mismatch", "invalid_usage_completeness", "invalid_valuation_basis",
  "unknown_valuation_has_amount", "incomplete_valuation", "invalid_missing_fields",
  "unknown_usage_has_units", "unknown_usage_without_reason", "usage_units_required",
  "complete_usage_has_missing_fields", "partial_usage_without_gaps", "duplicate_usage_unit",
  "invalid_usage_relation", "unexpected_usage_parent",
]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactCount(value) {
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value)) return value;
  return undefined;
}

function getSafeProviderId(value) {
  if (typeof value !== "string" || !SAFE_ID.test(value) || containsSensitivePublicText(value)) return undefined;
  return value;
}

function canonicalObservationId(value) {
  try {
    return assertSafePublicIdentifier(value, { maxLength: 256 });
  } catch {
    throw new TypeError("source_observation_id must be a safe, stable public identifier");
  }
}

function safeMeteringError(error, fallback, field) {
  const safe = new TypeError("Usage evidence could not be validated safely.");
  safe.name = "TelemetryUsageError";
  let code = fallback;
  try {
    if (error instanceof MeteringContractError && SAFE_METERING_ERROR_CODES.has(error.code)) code = error.code;
  } catch {
    // Never inspect or expose arbitrary thrown values.
  }
  safe.code = code;
  safe.field = field;
  return safe;
}

function validateAttemptSafely(rawAttempt, trustedScope) {
  try {
    return validateMeteredAttempt(rawAttempt, trustedScope);
  } catch (error) {
    throw safeMeteringError(error, "invalid_attempt", "attempt");
  }
}

function unsupportedProfileReason(profile, attempt) {
  if (!PROFILE_FIELDS[profile]) return "usage_profile_unsupported";
  if (profile === USAGE_PROFILE.OPENAI_GPT_IMAGE_1 &&
    (attempt.provider.name.toLowerCase() !== "openai" || attempt.provider.model !== "gpt-image-1")) {
    return "usage_profile_model_unverified";
  }
  if (profile === USAGE_PROFILE.TYPESAFE_DECISION && attempt.provider.model !== "jev-1.13.0") {
    return "usage_profile_model_unverified";
  }
  return undefined;
}

function buildUnits(raw, profile, fields) {
  if (!isRecord(raw)) return { units: [], missing: ["provider_usage"], contradictory: false };
  const keys = Object.keys(raw);
  const allowedRoot = new Set([...fields.root, "input_tokens_details", "output_tokens_details", "provider_request_id", "transport_attempt_id"]);
  const unexpected = keys.filter((key) => !allowedRoot.has(key));
  const missing = [];
  const values = Object.create(null);
  for (const field of fields.root) {
    if (!Object.hasOwn(raw, field)) {
      if (fields.required.includes(field)) missing.push(`usage.${field}`);
      continue;
    }
    values[field] = exactCount(raw[field]);
    if (values[field] === undefined) missing.push(`usage.${field}.invalid`);
  }

  for (const [section, allowed] of [["input_tokens_details", fields.inputDetails], ["output_tokens_details", fields.outputDetails]]) {
    if (!Object.hasOwn(raw, section)) continue;
    if (!isRecord(raw[section])) {
      missing.push(`usage.${section}.invalid`);
      continue;
    }
    for (const key of Object.keys(raw[section])) {
      if (!allowed.includes(key)) {
        missing.push(`usage.${section}.unmapped_extension`);
        continue;
      }
      const quantity = exactCount(raw[section][key]);
      if (quantity === undefined) {
        missing.push(`usage.${section}.${key}.invalid`);
      } else {
        values[`${section}.${key}`] = quantity;
      }
    }
  }
  if (unexpected.length > 0) missing.push("usage.unmapped_extension");

  const units = [];
  const hasTotal = values.total_tokens !== undefined;
  for (const field of fields.root) {
    if (values[field] === undefined) continue;
    units.push({
      name: field,
      quantity: values[field],
      relation: field === "total_tokens" || !hasTotal ? "standalone" : "included_subset",
      ...(field !== "total_tokens" && hasTotal ? { included_in: "total_tokens" } : {}),
    });
  }
  for (const [section, parent] of [["input_tokens_details", "input_tokens"], ["output_tokens_details", "output_tokens"]]) {
    for (const name of Object.keys(values).filter((field) => field.startsWith(`${section}.`))) {
      const quantity = values[name];
      const parentQuantity = values[parent];
      units.push({
        name,
        quantity,
        relation: parentQuantity === undefined ? "unknown_relation" : "included_subset",
        ...(parentQuantity === undefined ? {} : { included_in: parent }),
      });
      if (parentQuantity === undefined) missing.push(`usage.${parent}`);
    }
  }

  let contradictory = false;
  if (values.input_tokens !== undefined && values.output_tokens !== undefined && values.total_tokens !== undefined) {
    try {
      contradictory = BigInt(values.input_tokens) + BigInt(values.output_tokens) !== BigInt(values.total_tokens);
    } catch {
      contradictory = true;
    }
  }
  for (const [section, parent] of [["input_tokens_details", "input_tokens"], ["output_tokens_details", "output_tokens"]]) {
    const details = Object.entries(values).filter(([name]) => name.startsWith(`${section}.`));
    if (details.length === 0 || values[parent] === undefined) continue;
    try {
      const detailsTotal = details.reduce((sum, [, quantity]) => sum + BigInt(quantity), 0n);
      if (detailsTotal > BigInt(values[parent])) contradictory = true;
    } catch {
      contradictory = true;
    }
  }

  return { units, missing: [...new Set(missing)], contradictory };
}

/**
 * Normalize one provider usage payload to the existing C03 observation contract.
 * The profile is explicit so new provider fields never silently acquire billing semantics.
 */
export function createUsageObservation({
  attempt: rawAttempt,
  trustedScope,
  usage,
  profile,
  sourceObservationId,
  source = "provider_response",
  providerRequestId,
  transportAttemptId,
}) {
  const attempt = validateAttemptSafely(rawAttempt, trustedScope);
  try {
    for (const value of [attempt.tenant_id, attempt.project_id, attempt.budget_scope_id,
      attempt.logical_operation_id, attempt.billable_attempt_id, attempt.provider.name, attempt.provider.model]) {
      assertSafePublicIdentifier(value, { maxLength: 256 });
    }
  } catch {
    throw new TypeError("attempt identity is not safe for public usage evidence");
  }
  const sourceObservationIdSafe = canonicalObservationId(sourceObservationId);
  if (!OBSERVATION_SOURCES.has(source)) throw new TypeError("source must identify an allowed observation source");
  let transportId;
  if (transportAttemptId !== undefined) {
    transportId = assertSafePublicIdentifier(transportAttemptId, { maxLength: 256 });
  }
  const nestedUsage = isRecord(usage) && isRecord(usage.usage) ? usage.usage : undefined;
  const observedProviderId = isRecord(usage)
    ? (usage.provider_request_id ?? nestedUsage?.provider_request_id)
    : undefined;
  const observedTransportId = isRecord(usage)
    ? (usage.transport_attempt_id ?? nestedUsage?.transport_attempt_id)
    : undefined;
  const providerIdentityConflict = providerRequestId !== undefined && observedProviderId !== undefined &&
    providerRequestId !== observedProviderId;
  const transportIdentityConflict = transportAttemptId !== undefined && observedTransportId !== undefined &&
    transportAttemptId !== observedTransportId;
  const rawProviderId = providerRequestId ?? observedProviderId;
  const providerId = getSafeProviderId(rawProviderId);
  const identityMissing = rawProviderId !== undefined && providerId === undefined ? ["provider_request_id_unavailable"] : [];
  if (providerIdentityConflict) identityMissing.push("provider_request_id_conflict");
  if (transportIdentityConflict) identityMissing.push("transport_attempt_id_conflict");
  if (observedTransportId !== undefined && transportAttemptId === undefined) {
    identityMissing.push("transport_attempt_id_not_authorized");
  }
  const unsupported = unsupportedProfileReason(profile, attempt);
  const rawCounters = isRecord(usage) && Object.hasOwn(usage, "usage") ? usage.usage : usage;
  const built = unsupported
    ? { units: [], missing: [unsupported], contradictory: false }
    : buildUnits(rawCounters, profile, PROFILE_FIELDS[profile]);
  const missing = [...new Set([...built.missing, ...identityMissing])];
  let completeness;
  let usageUnits = built.units;
  if (built.contradictory || providerIdentityConflict || transportIdentityConflict) {
    completeness = "unknown";
    usageUnits = [];
    if (built.contradictory) missing.push("usage.inconsistent_counts");
  } else if (usageUnits.length === 0) {
    completeness = "unknown";
    if (missing.length === 0) missing.push("provider_usage");
  } else if (missing.length > 0) {
    completeness = "partial";
  } else {
    completeness = "complete";
  }

  const observation = {
    schema_version: METERING_PROPOSAL_VERSION,
    tenant_id: attempt.tenant_id,
    project_id: attempt.project_id,
    budget_scope_id: attempt.budget_scope_id,
    logical_operation_id: attempt.logical_operation_id,
    billable_attempt_id: attempt.billable_attempt_id,
    source_observation_id: sourceObservationIdSafe,
    source,
    provider_name: attempt.provider.name,
    model: attempt.provider.model,
    environment: attempt.environment,
    billing_mode: attempt.billing_mode,
    completeness,
    missing_fields: [...new Set(missing)],
  };
  if (providerId !== undefined) observation.provider_request_id = providerId;
  if (transportId !== undefined) observation.transport_attempt_id = transportId;
  if (usageUnits.length > 0) observation.usage_units = usageUnits;
  try {
    return validateUsageObservation(observation, attempt);
  } catch (error) {
    throw safeMeteringError(error, "invalid_usage_observation", "usage_observation");
  }
}

/** Same source ID and same normalized payload collapses; conflicts fail closed. */
export function deduplicateUsageObservations(observations) {
  if (!Array.isArray(observations) || observations.length > 1024) {
    throw new TypeError("observations must be a bounded array");
  }
  const byId = new Map();
  for (const observation of observations) {
    if (!isRecord(observation) || typeof observation.source_observation_id !== "string") {
      throw new TypeError("every observation needs a source identity");
    }
    const id = canonicalObservationId(observation.source_observation_id);
    const existing = byId.get(id);
    let serialized;
    try { serialized = canonicalSerialize(observation); }
    catch { throw new TypeError("observation must be canonical JSON"); }
    if (existing && existing.serialized !== serialized) {
      throw new TypeError("conflicting payloads share one source observation identity");
    }
    if (!existing) byId.set(id, { serialized, value: structuredClone(observation) });
  }
  return Object.freeze([...byId.values()].map(({ value }) => Object.freeze(value)));
}
