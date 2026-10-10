import { executeMeteredAttempt, MeteringContractError, validateMeteredAttempt } from "../contracts/metering.mjs";
import { assertSafePublicIdentifier, isSensitivePublicField, projectPublicTelemetry, TelemetryPrivacyError } from "./privacy.mjs";

export const CREATIVE_TELEMETRY_SCHEMA = "creative.telemetry.evidence/v1";
export const TELEMETRY_PROVIDER_MODES = Object.freeze(["mock", "recorded", "sandbox", "live", "unknown"]);
export const TELEMETRY_COMMERCE_MODES = Object.freeze(["simulated", "live", "unknown"]);

const OPERATION_KINDS = new Set([
  "image_generation", "image_edit", "responses_orchestration", "planning",
  "vision_observation", "jev_decision", "baseline_evaluation",
]);
const EVENT_TYPES = new Set(["attempt_intent", "transport_intent", "attempt_outcome"]);
const EVIDENCE_ACKS = new Set(["recorded", "duplicate"]);
const METERING_STATUSES = new Set([
  "cancelled_before_reservation", "reservation_unavailable", "reservation_denied",
  "cancelled_before_dispatch", "pre_dispatch_release_unknown", "dispatch_authorization_unknown",
  "cancelled_after_dispatch", "dispatch_outcome_unknown", "transport_attempt_unreported",
  "dispatch_result_invalid", "usage_observation_invalid", "usage_unknown",
  "usage_observation_unconfirmed", "usage_incomplete", "settlement_unknown",
  "settlement_pending", "settled",
]);
const SAFE_METERING_ERROR_CODES = new Set([
  "invalid_object", "unknown_field", "invalid_identifier", "invalid_exact_amount", "invalid_currency",
  "trusted_scope_mismatch", "unsupported_version", "identity_collision", "invalid_environment",
  "invalid_billing_mode", "unsupported_operation_kind", "budget_scope_mismatch",
  "attempt_identity_mismatch", "invalid_usage_source", "provider_identity_mismatch",
  "billing_context_mismatch", "invalid_usage_completeness", "invalid_valuation_basis",
  "unknown_valuation_has_amount", "incomplete_valuation", "invalid_missing_fields",
  "unknown_usage_has_units", "unknown_usage_without_reason", "usage_units_required",
  "complete_usage_has_missing_fields", "partial_usage_without_gaps", "duplicate_usage_unit",
  "invalid_usage_relation", "unexpected_usage_parent", "invalid_provider_outcome",
]);

export class TelemetryBoundaryError extends Error {
  constructor(code = "telemetry_unavailable") {
    super("Creative telemetry boundary could not complete safely.");
    this.name = "TelemetryBoundaryError";
    this.code = code;
    this.field = "telemetry";
  }
}

function validTimestamp(value) {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

function validateModes(modes) {
  if (modes === null || typeof modes !== "object" || Array.isArray(modes) ||
    !TELEMETRY_PROVIDER_MODES.includes(modes.provider_execution_mode) ||
    !TELEMETRY_COMMERCE_MODES.includes(modes.commerce_mode)) {
    throw new TelemetryBoundaryError("invalid_mode_context");
  }
  return Object.freeze({
    provider_execution_mode: modes.provider_execution_mode,
    commerce_mode: modes.commerce_mode,
  });
}

function safeMeteringCode(error, fallback) {
  return error instanceof MeteringContractError && SAFE_METERING_ERROR_CODES.has(error.code)
    ? error.code
    : fallback;
}

function validateAttemptSafely(request, trustedScope) {
  try {
    return validateMeteredAttempt(request, trustedScope);
  } catch (error) {
    throw new TelemetryBoundaryError(safeMeteringCode(error, "invalid_attempt"));
  }
}

function assertTransportActive(signal) {
  if (signal?.aborted) throw new TelemetryBoundaryError("cancelled_before_transport");
}

function safeAttempt(attempt) {
  const fields = [
    attempt.tenant_id, attempt.project_id, attempt.budget_scope_id,
    attempt.logical_operation_id, attempt.billable_attempt_id,
    attempt.provider?.name, attempt.provider?.model,
  ];
  try {
    fields.forEach((value) => assertSafePublicIdentifier(value, { maxLength: 256 }));
  } catch {
    throw new TelemetryBoundaryError("unsafe_attempt_identity");
  }
  if (!OPERATION_KINDS.has(attempt.operation_kind)) throw new TelemetryBoundaryError("unsupported_operation_kind");
}

function safeOptionalId(value, field) {
  if (value === undefined) return undefined;
  try {
    return assertSafePublicIdentifier(value, { maxLength: 256 });
  } catch {
    throw new TelemetryBoundaryError(`unsafe_${field}`);
  }
}

/** Build the strictly versioned, privacy-projected event envelope used by adapters. */
export function createTelemetryEvidence({
  eventId,
  type,
  attempt: rawAttempt,
  trustedScope,
  modes,
  occurredAt,
  reservationRef,
  transportAttemptId,
  providerRequestId,
  sourceObservationId,
  providerOutcome,
  meteringStatus,
  usageCompleteness,
  missingFields = [],
}) {
  const attempt = validateAttemptSafely(rawAttempt, trustedScope);
  safeAttempt(attempt);
  const safeModes = validateModes(modes);
  const safeEventId = safeOptionalId(eventId, "event_id");
  if (!safeEventId || !EVENT_TYPES.has(type) || !validTimestamp(occurredAt)) {
    throw new TelemetryBoundaryError("invalid_evidence_envelope");
  }
  const event = {
    schema_version: CREATIVE_TELEMETRY_SCHEMA,
    event_id: safeEventId,
    tenant_id: attempt.tenant_id,
    project_id: attempt.project_id,
    budget_scope_id: attempt.budget_scope_id,
    producer: "creative-engine.telemetry",
    occurred_at: occurredAt,
    environment: attempt.environment,
    billing_mode: attempt.billing_mode,
    provider_execution_mode: safeModes.provider_execution_mode,
    commerce_mode: safeModes.commerce_mode,
    logical_operation_id: attempt.logical_operation_id,
    billable_attempt_id: attempt.billable_attempt_id,
    operation_kind: attempt.operation_kind,
    event_type: type,
    provider: { name: attempt.provider.name, model: attempt.provider.model },
  };
  const optionalIds = {
    reservation_ref: reservationRef,
    transport_attempt_id: transportAttemptId,
    provider_request_id: providerRequestId,
    source_observation_id: sourceObservationId,
  };
  for (const [field, value] of Object.entries(optionalIds)) {
    const safe = safeOptionalId(value, field);
    if (safe !== undefined) event[field] = safe;
  }
  if (providerOutcome !== undefined) {
    if (!new Set(["succeeded", "failed", "partial", "unknown"]).has(providerOutcome)) {
      throw new TelemetryBoundaryError("invalid_provider_outcome");
    }
    event.provider_outcome = providerOutcome;
  }
  if (usageCompleteness !== undefined) {
    if (!new Set(["complete", "partial", "unknown"]).has(usageCompleteness)) {
      throw new TelemetryBoundaryError("invalid_usage_completeness");
    }
    event.usage_completeness = usageCompleteness;
  }
  if (meteringStatus !== undefined) {
    if (!METERING_STATUSES.has(meteringStatus)) {
      throw new TelemetryBoundaryError("invalid_metering_status");
    }
    event.metering_status = meteringStatus;
  }
  if (!Array.isArray(missingFields) || missingFields.length > 32 ||
    missingFields.some((value) => typeof value !== "string" || !/^[A-Za-z0-9_.-]{1,120}$/.test(value) || isSensitivePublicField(value))) {
    throw new TelemetryBoundaryError("invalid_missing_fields");
  }
  if (missingFields.length > 0) event.missing_fields = [...new Set(missingFields)];
  try {
    return projectPublicTelemetry(event, { maxDepth: 8, maxNodes: 256, maxBytes: 16 * 1024 }).value;
  } catch (error) {
    if (error instanceof TelemetryPrivacyError) throw new TelemetryBoundaryError("unsafe_evidence");
    throw new TelemetryBoundaryError("unsafe_evidence");
  }
}

function evidencePort(port) {
  if (port === null || typeof port !== "object" || Array.isArray(port) || typeof port.append !== "function") {
    throw new TelemetryBoundaryError("evidence_port_unavailable");
  }
  return port;
}

async function appendEvidence(port, event) {
  let acknowledgement;
  try {
    acknowledgement = await port.append(event);
  } catch {
    throw new TelemetryBoundaryError("evidence_append_unavailable");
  }
  if (acknowledgement === null || typeof acknowledgement !== "object" ||
    !EVIDENCE_ACKS.has(acknowledgement.status) || acknowledgement.event_id !== event.event_id) {
    throw new TelemetryBoundaryError("invalid_evidence_acknowledgement");
  }
  return acknowledgement.status;
}

function bindMeteringPort(port, capture, { observationOutbox, attempt, trustedScope }) {
  const methods = [
    "reserveAttempt", "releaseBeforeDispatch", "markAttemptInFlight", "recordTransportAttempt",
    "recordUsageObservation", "settleReservation", "markOutcomeUnknown",
  ];
  if (port === null || typeof port !== "object" || Array.isArray(port)) {
    throw new TelemetryBoundaryError("metering_port_unavailable");
  }
  const proxy = Object.create(null);
  for (const method of methods) {
    if (typeof port[method] !== "function") throw new TelemetryBoundaryError("metering_port_unavailable");
    Object.defineProperty(proxy, method, {
      enumerable: true,
      value: async (...args) => {
        let enqueuedObservation;
        if (method === "recordUsageObservation") {
          const input = args[0];
          if (!input || input.observation === undefined || typeof observationOutbox?.enqueueUsageObservation !== "function") {
            throw new TelemetryBoundaryError("usage_observation_outbox_unavailable");
          }
          try {
            enqueuedObservation = await observationOutbox.enqueueUsageObservation({
              attempt,
              trustedScope,
              observation: input.observation,
            });
          } catch {
            throw new TelemetryBoundaryError("usage_observation_persist_failed");
          }
          if (enqueuedObservation === null || typeof enqueuedObservation !== "object" ||
            !["recorded", "duplicate"].includes(enqueuedObservation.status) ||
            typeof enqueuedObservation.record_ref !== "string" ||
            enqueuedObservation.source_observation_id !== input.observation.source_observation_id) {
            throw new TelemetryBoundaryError("invalid_usage_observation_persist_ack");
          }
          capture.observationRef = enqueuedObservation.record_ref;
        }
        let result;
        try {
          result = await port[method].apply(port, args);
        } catch (error) {
          throw error;
        }
        if (method === "reserveAttempt" && result?.status === "reserved") {
          capture.reservationRef = result.reservation_id;
        } else if (method === "recordUsageObservation") {
          capture.observation = args[0]?.observation;
          if (typeof observationOutbox.acknowledgeEnqueuedObservation === "function") {
            try {
              await observationOutbox.acknowledgeEnqueuedObservation({
                record_ref: enqueuedObservation.record_ref,
                source_observation_id: result?.source_observation_id,
                effective_billable_attempt_id: result?.effective_billable_attempt_id,
                authority_status: result?.status,
              });
            } catch {
              // The external metering outcome is authoritative. A failed local
              // acknowledgement leaves the exact durable observation pending
              // for an idempotent retry; it cannot rewrite the Finance result.
            }
          }
        } else if (method === "markOutcomeUnknown" && result && typeof result === "object") {
          capture.lastHoldStatus = typeof result.status === "string" ? result.status : undefined;
        }
        return result;
      },
    });
  }
  return proxy;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function publicMeteringOutcome(outcome) {
  try {
    return projectPublicTelemetry(outcome, { maxDepth: 12, maxNodes: 512, maxBytes: 16 * 1024 }).value;
  } catch {
    // C03 has already completed its authoritative transition. Preserve its
    // outcome state while returning only fixed, bounded fields if projection of
    // an unexpected adapter response fails; never turn a committed settlement
    // into a caller-visible execution failure.
    const statuses = new Set([
      "cancelled_before_reservation", "reservation_unavailable", "reservation_denied",
      "cancelled_before_dispatch", "pre_dispatch_release_unknown", "dispatch_authorization_unknown",
      "cancelled_after_dispatch", "dispatch_outcome_unknown", "transport_attempt_unreported",
      "dispatch_result_invalid", "usage_observation_invalid", "usage_unknown",
      "usage_observation_unconfirmed", "usage_incomplete", "settlement_unknown",
      "settlement_pending", "settled",
    ]);
    const status = statuses.has(outcome?.status) ? outcome.status : "dispatch_outcome_unknown";
    const safe = { status, published: false };
    const providerOutcome = ["succeeded", "failed", "partial", "unknown"].includes(outcome?.provider_outcome)
      ? outcome.provider_outcome
      : "unknown";
    const safeReference = (value) => {
      try { return assertSafePublicIdentifier(value, { maxLength: 256 }); }
      catch { return "[REDACTED]"; }
    };
    const safeAck = () => ({
      status: outcome?.observation_ack?.status === "duplicate" ? "duplicate" : "accepted",
      source_observation_id: safeReference(outcome?.observation_ack?.source_observation_id),
      effective_billable_attempt_id: safeReference(outcome?.observation_ack?.effective_billable_attempt_id),
    });
    if (["usage_observation_invalid", "usage_unknown", "usage_observation_unconfirmed", "usage_incomplete", "settlement_unknown", "settlement_pending", "settled"].includes(status)) {
      safe.provider_outcome = providerOutcome;
    }
    if (outcome?.hold === "retained_for_reconciliation") safe.hold = outcome.hold;
    if (["pre_dispatch_release_unknown", "cancelled_after_dispatch", "dispatch_outcome_unknown",
      "transport_attempt_unreported", "dispatch_result_invalid", "usage_observation_invalid",
      "usage_unknown", "usage_observation_unconfirmed", "usage_incomplete", "settlement_unknown"].includes(status)) {
      safe.hold = "retained_for_reconciliation";
    }
    if (status === "reservation_unavailable") safe.error_code = "metering_authority_unavailable";
    else if (status === "reservation_denied") safe.error_code = "budget_unavailable";
    else if (status === "dispatch_authorization_unknown") safe.error_code = "in_flight_transition_unknown";
    else if (status === "dispatch_outcome_unknown") safe.error_code = "provider_outcome_unknown";
    else if (status === "dispatch_result_invalid") safe.error_code = "invalid_provider_response";
    else if (status === "usage_observation_invalid") safe.error_code = "invalid_usage_observation";
    else if (status === "settlement_unknown") safe.error_code = "settlement_response_unknown";
    if (status === "usage_incomplete" || status === "settled") safe.observation_ack = safeAck();
    if (status === "settled" && outcome?.settlement?.status === "settled") {
      safe.settlement = {
        reservation_id: safeReference(outcome.settlement.reservation_id),
        status: "settled",
        consumed_amount: outcome.settlement.consumed_amount,
        released_unused_amount: outcome.settlement.released_unused_amount,
      };
    } else if (status === "settlement_pending") {
      safe.settlement = {
        reservation_id: safeReference(outcome?.settlement?.reservation_id),
        status: "held_for_reconciliation",
      };
    }
    return projectPublicTelemetry(safe, { maxDepth: 8, maxNodes: 128, maxBytes: 8 * 1024 }).value;
  }
}

/**
 * Run C03's single authoritative metering executor with a required sanitized
 * preflight event and per-transport evidence. It does not publish provider data.
 * Final evidence failures are returned for durable host persistence and never
 * turn a settled/committed metering outcome into a misleading API failure.
 */
export async function executeCreativeMeteredAttempt({
  meteringPort,
  evidencePort: rawEvidencePort,
  observationOutbox,
  request,
  trustedScope,
  modes,
  authorizeTransport,
  dispatch,
  idFactory = () => globalThis.crypto.randomUUID(),
  clock = () => new Date(),
  signal,
}) {
  const attempt = validateAttemptSafely(request, trustedScope);
  safeAttempt(attempt);
  const evidence = evidencePort(rawEvidencePort);
  const safeModes = validateModes(modes);
  if (typeof dispatch !== "function" || typeof authorizeTransport !== "function" ||
    typeof observationOutbox?.enqueueUsageObservation !== "function" ||
    typeof idFactory !== "function" || typeof clock !== "function") {
    throw new TelemetryBoundaryError("invalid_execution_input");
  }
  const allocatedEventIds = new Set();
  const nextId = (kind) => {
    let value;
    try { value = assertSafePublicIdentifier(idFactory(kind), { maxLength: 256 }); }
    catch { throw new TelemetryBoundaryError("unsafe_generated_identity"); }
    if (allocatedEventIds.has(value)) throw new TelemetryBoundaryError("duplicate_generated_identity");
    allocatedEventIds.add(value);
    return value;
  };
  const timestamp = () => {
    let value;
    try { value = clock(); } catch { throw new TelemetryBoundaryError("clock_unavailable"); }
    let iso;
    try { iso = value instanceof Date ? value.toISOString() : value; }
    catch { throw new TelemetryBoundaryError("invalid_clock_value"); }
    if (!validTimestamp(iso)) throw new TelemetryBoundaryError("invalid_clock_value");
    return iso;
  };
  const createEvent = (args) => createTelemetryEvidence({
    eventId: nextId("event"), attempt, trustedScope, modes: safeModes,
    occurredAt: timestamp(), ...args,
  });

  const persistedEvidenceRefs = [];
  const intent = createEvent({ type: "attempt_intent" });
  await appendEvidence(evidence, intent);
  persistedEvidenceRefs.push(intent.event_id);

  const captured = { reservationRef: undefined, observation: undefined, observationRef: undefined, lastHoldStatus: undefined };
  const meter = bindMeteringPort(meteringPort, captured, { observationOutbox, attempt, trustedScope });
  const transportIds = new Set();
  const authorizedTransports = new Map();
  let nextTransportId;
  const recordTransport = async (context, transportAttemptId) => {
    const safeTransportId = safeOptionalId(transportAttemptId, "transport_attempt_id");
    if (safeTransportId && authorizedTransports.has(safeTransportId)) {
      return Object.freeze({ transport_attempt_id: safeTransportId,
        dispatch_intent_ref: authorizedTransports.get(safeTransportId) });
    }
    if (!safeTransportId || transportIds.has(safeTransportId) ||
      safeTransportId === attempt.logical_operation_id || safeTransportId === attempt.billable_attempt_id) {
      throw new TelemetryBoundaryError("invalid_transport_attempt_identity");
    }
    transportIds.add(safeTransportId);
    const transportEvent = createEvent({
      type: "transport_intent",
      reservationRef: context.reservation_ref,
      transportAttemptId: safeTransportId,
    });
    await appendEvidence(evidence, transportEvent);
    persistedEvidenceRefs.push(transportEvent.event_id);
    assertTransportActive(context.signal ?? signal);
    assertTransportActive(signal);
    let dispatchIntentRef;
    try {
      dispatchIntentRef = await authorizeTransport(Object.freeze({
        attempt: deepFreeze(structuredClone(attempt)),
        billable_attempt_id: attempt.billable_attempt_id,
        logical_operation_id: attempt.logical_operation_id,
        reservation_ref: context.reservation_ref,
        transport_attempt_id: safeTransportId,
        signal: context.signal ?? signal,
      }));
    } catch {
      throw new TelemetryBoundaryError("dispatch_intent_unavailable");
    }
    try { assertSafePublicIdentifier(dispatchIntentRef, { maxLength: 256 }); }
    catch { throw new TelemetryBoundaryError("dispatch_intent_invalid"); }
    assertTransportActive(context.signal ?? signal);
    assertTransportActive(signal);
    await context.recordTransportAttempt(safeTransportId);
    assertTransportActive(context.signal ?? signal);
    assertTransportActive(signal);
    authorizedTransports.set(safeTransportId, dispatchIntentRef);
    return Object.freeze({ transport_attempt_id: safeTransportId, dispatch_intent_ref: dispatchIntentRef });
  };
  const dispatchWithEvidence = async (context) => {
    nextTransportId = nextId("transport");
    const initial = await recordTransport(context, nextTransportId);
    assertTransportActive(context.signal ?? signal);
    assertTransportActive(signal);
    const wrapped = Object.freeze({
      ...context,
      attempt: deepFreeze(structuredClone(context.attempt)),
      transport_attempt_id: initial.transport_attempt_id,
      dispatch_intent_ref: initial.dispatch_intent_ref,
      async recordTransportAttempt(id) {
        const result = await recordTransport(context, id);
        return result.transport_attempt_id;
      },
    });
    assertTransportActive(context.signal ?? signal);
    assertTransportActive(signal);
    return dispatch(wrapped);
  };

  let outcome;
  try {
    outcome = await executeMeteredAttempt({
      port: meter,
      request: attempt,
      trustedScope,
      dispatch: dispatchWithEvidence,
      signal,
    });
  } catch {
    throw new TelemetryBoundaryError("metering_execution_failed");
  }

  let providerRequestId;
  let sourceObservationId;
  let observedTransportId;
  let usageCompleteness;
  let missingFields = [];
  if (captured.observation && typeof captured.observation === "object") {
    try { providerRequestId = safeOptionalId(captured.observation.provider_request_id, "provider_request_id"); }
    catch { providerRequestId = undefined; }
    try { sourceObservationId = safeOptionalId(captured.observation.source_observation_id, "source_observation_id"); }
    catch { sourceObservationId = undefined; }
    try { observedTransportId = safeOptionalId(captured.observation.transport_attempt_id, "transport_attempt_id"); }
    catch { observedTransportId = undefined; }
    if (["complete", "partial", "unknown"].includes(captured.observation.completeness)) {
      usageCompleteness = captured.observation.completeness;
    }
    if (Array.isArray(captured.observation.missing_fields)) {
      missingFields = captured.observation.missing_fields.filter((item) => typeof item === "string");
    }
  }
  let finalEvidenceStatus = "pending";
  let outcomeEvent;
  try {
    outcomeEvent = createEvent({
      type: "attempt_outcome",
      reservationRef: captured.reservationRef,
      transportAttemptId: observedTransportId ?? nextTransportId,
      providerRequestId,
      sourceObservationId,
      providerOutcome: outcome?.provider_outcome,
      meteringStatus: outcome?.status ?? "unknown",
      usageCompleteness,
      missingFields,
    });
    finalEvidenceStatus = await appendEvidence(evidence, outcomeEvent);
    persistedEvidenceRefs.push(outcomeEvent.event_id);
  } catch {
    // The caller may persist this sanitized event for replay after a telemetry outage.
  }
  return Object.freeze({
    outcome: publicMeteringOutcome(outcome),
    evidence_delivery: finalEvidenceStatus,
    evidence_refs: Object.freeze([...persistedEvidenceRefs]),
    ...(captured.observationRef ? { observation_ref: captured.observationRef } : {}),
    ...(finalEvidenceStatus === "pending" && outcomeEvent ? { pending_evidence: outcomeEvent } : {}),
  });
}
