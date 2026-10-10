import { isDeepStrictEqual } from 'node:util';

export const METERING_PROPOSAL_VERSION = 'creative.metering.proposal/v1';

const ENVIRONMENTS = new Set(['development', 'test', 'production']);
const BILLING_MODES = new Set(['live', 'sandbox', 'simulated']);
const OPERATION_KINDS = new Set([
  'image_generation',
  'image_edit',
  'responses_orchestration',
  'planning',
  'vision_observation',
  'jev_decision',
  'baseline_evaluation',
]);
const USAGE_SOURCES = new Set([
  'provider_response',
  'provider_usage_api',
  'trace',
  'billing_export',
  'other',
]);
const USAGE_COMPLETENESS = new Set(['complete', 'partial', 'unknown']);
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/;
const ISO_CURRENCY = /^[A-Z]{3}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;

export class MeteringContractError extends Error {
  constructor(code, message, field = undefined) {
    super(message);
    this.name = 'MeteringContractError';
    this.code = code;
    if (field !== undefined) this.field = field;
  }
}

function fail(code, message, field) {
  throw new MeteringContractError(code, message, field);
}

function record(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_object', `${field} must be an object`, field);
  }
  return value;
}

function assertAllowedKeys(value, allowed, field) {
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected !== undefined) fail('unknown_field', `${field} contains an unsupported field`, `${field}.${unexpected}`);
}

function id(value, field) {
  if (typeof value !== 'string' || !ID.test(value)) {
    fail('invalid_identifier', `${field} must be a non-empty opaque identifier`, field);
  }
  return value;
}

function exactDecimal(value, field, { positive = false } = {}) {
  if (typeof value !== 'string' || !DECIMAL.test(value)) {
    fail('invalid_exact_amount', `${field} must be a non-negative exact decimal string`, field);
  }
  if (positive && /^0(?:\.0{1,9})?$/.test(value)) {
    fail('invalid_exact_amount', `${field} must be greater than zero`, field);
  }
  return value;
}

function currency(value, field) {
  if (typeof value !== 'string' || !ISO_CURRENCY.test(value)) {
    fail('invalid_currency', `${field} must be a three-letter uppercase currency code`, field);
  }
  return value;
}

function assertTrustedScope(value, trustedScope) {
  const scope = record(trustedScope, 'trustedScope');
  for (const field of ['tenant_id', 'project_id', 'budget_scope_id']) {
    id(scope[field], `trustedScope.${field}`);
    if (value[field] !== scope[field]) {
      fail('trusted_scope_mismatch', `${field} does not match authenticated scope`, field);
    }
  }
}

/**
 * Validate the proposed command before it reaches the external budget authority.
 * `trustedScope` must come from authenticated server context, never from a request body.
 */
export function validateMeteredAttempt(value, trustedScope) {
  const request = record(value, 'attempt');
  assertAllowedKeys(request, new Set([
    'schema_version', 'tenant_id', 'project_id', 'budget_scope_id', 'logical_operation_id',
    'billable_attempt_id', 'retry_mapping_ref', 'operation_kind', 'environment', 'billing_mode',
    'budget', 'provider', 'correlation_id', 'workflow_id', 'run_id',
  ]), 'attempt');
  if (request.schema_version !== METERING_PROPOSAL_VERSION) {
    fail('unsupported_version', 'Unsupported metering proposal version', 'schema_version');
  }
  assertTrustedScope(request, trustedScope);
  id(request.logical_operation_id, 'logical_operation_id');
  id(request.billable_attempt_id, 'billable_attempt_id');
  if (request.logical_operation_id === request.billable_attempt_id) {
    fail('identity_collision', 'logical operation and billable attempt need distinct identities', 'billable_attempt_id');
  }
  id(request.retry_mapping_ref, 'retry_mapping_ref');

  if (!ENVIRONMENTS.has(request.environment)) {
    fail('invalid_environment', 'environment must identify the execution environment', 'environment');
  }
  if (!BILLING_MODES.has(request.billing_mode)) {
    fail('invalid_billing_mode', 'billing_mode must identify economic behavior', 'billing_mode');
  }
  if (!OPERATION_KINDS.has(request.operation_kind)) {
    fail('unsupported_operation_kind', 'Unsupported billable operation kind', 'operation_kind');
  }

  const budget = record(request.budget, 'budget');
  assertAllowedKeys(budget, new Set(['scope_id', 'policy_version']), 'budget');
  if (budget.scope_id !== request.budget_scope_id) {
    fail('budget_scope_mismatch', 'budget scope must match trusted budget scope', 'budget.scope_id');
  }
  id(budget.policy_version, 'budget.policy_version');

  const provider = record(request.provider, 'provider');
  assertAllowedKeys(provider, new Set(['name', 'model', 'endpoint', 'sdk']), 'provider');
  id(provider.name, 'provider.name');
  id(provider.model, 'provider.model');
  id(provider.endpoint, 'provider.endpoint');
  const sdk = record(provider.sdk, 'provider.sdk');
  assertAllowedKeys(sdk, new Set(['name', 'version']), 'provider.sdk');
  id(sdk.name, 'provider.sdk.name');
  id(sdk.version, 'provider.sdk.version');

  for (const optionalField of ['correlation_id', 'workflow_id', 'run_id']) {
    if (request[optionalField] !== undefined) id(request[optionalField], optionalField);
  }

  return structuredClone(request);
}

/**
 * Validate one provider/trace/billing observation without turning omissions into zero.
 * Exact monetary valuation belongs to the external metering authority.
 */
export function validateUsageObservation(value, attempt) {
  const observation = record(value, 'usage_observation');
  assertAllowedKeys(observation, new Set([
    'schema_version', 'tenant_id', 'project_id', 'logical_operation_id', 'billable_attempt_id',
    'source_observation_id', 'source', 'provider_name', 'model', 'provider_request_id',
    'transport_attempt_id', 'environment', 'billing_mode', 'completeness', 'usage_units',
    'missing_fields', 'rate_card_ref', 'valuation',
  ]), 'usage_observation');
  const validatedAttempt = record(attempt, 'attempt');
  if (observation.schema_version !== METERING_PROPOSAL_VERSION) {
    fail('unsupported_version', 'Unsupported metering observation version', 'schema_version');
  }
  for (const field of ['tenant_id', 'project_id', 'logical_operation_id', 'billable_attempt_id']) {
    id(observation[field], field);
    if (observation[field] !== validatedAttempt[field]) {
      fail('attempt_identity_mismatch', `${field} does not match the authorized attempt`, field);
    }
  }
  id(observation.source_observation_id, 'source_observation_id');
  if (!USAGE_SOURCES.has(observation.source)) {
    fail('invalid_usage_source', 'Unsupported usage observation source', 'source');
  }
  id(observation.provider_name, 'provider_name');
  id(observation.model, 'model');
  if (observation.provider_name !== validatedAttempt.provider.name || observation.model !== validatedAttempt.provider.model) {
    fail('provider_identity_mismatch', 'Usage provider/model must match the authorized attempt', 'provider_name');
  }
  if (observation.provider_request_id !== undefined) id(observation.provider_request_id, 'provider_request_id');
  if (observation.transport_attempt_id !== undefined) id(observation.transport_attempt_id, 'transport_attempt_id');
  const identityValues = [
    ['logical_operation_id', validatedAttempt.logical_operation_id],
    ['billable_attempt_id', validatedAttempt.billable_attempt_id],
    ['source_observation_id', observation.source_observation_id],
    ...(observation.provider_request_id === undefined ? [] : [['provider_request_id', observation.provider_request_id]]),
    ...(observation.transport_attempt_id === undefined ? [] : [['transport_attempt_id', observation.transport_attempt_id]]),
  ];
  const seenIdentities = new Set();
  for (const [field, value] of identityValues) {
    if (seenIdentities.has(value)) fail('identity_collision', 'Operation, attempt, transport, provider, and observation identities must remain distinct', field);
    seenIdentities.add(value);
  }
  if (observation.environment !== validatedAttempt.environment || observation.billing_mode !== validatedAttempt.billing_mode) {
    fail('billing_context_mismatch', 'Environment and billing mode must match the authorized attempt', 'billing_mode');
  }
  if (!USAGE_COMPLETENESS.has(observation.completeness)) {
    fail('invalid_usage_completeness', 'completeness must be complete, partial, or unknown', 'completeness');
  }
  if (observation.rate_card_ref !== undefined) id(observation.rate_card_ref, 'rate_card_ref');
  if (observation.valuation !== undefined) {
    const valuation = record(observation.valuation, 'valuation');
    assertAllowedKeys(valuation, new Set(['basis', 'amount', 'currency', 'rate_card_ref']), 'valuation');
    if (!['unknown', 'estimated', 'provider_confirmed'].includes(valuation.basis)) {
      fail('invalid_valuation_basis', 'Unsupported valuation basis', 'valuation.basis');
    }
    if (valuation.amount !== undefined) exactDecimal(valuation.amount, 'valuation.amount');
    if (valuation.currency !== undefined) currency(valuation.currency, 'valuation.currency');
    if (valuation.rate_card_ref !== undefined) id(valuation.rate_card_ref, 'valuation.rate_card_ref');
    if (valuation.basis === 'unknown' && (valuation.amount !== undefined || valuation.currency !== undefined)) {
      fail('unknown_valuation_has_amount', 'Unknown valuation must not carry an amount or currency', 'valuation');
    }
    if (valuation.amount !== undefined && (!valuation.currency || !valuation.rate_card_ref)) {
      fail('incomplete_valuation', 'A known amount requires currency and rate-card reference', 'valuation');
    }
  }

  const units = observation.usage_units;
  const missing = observation.missing_fields;
  if (!Array.isArray(missing) || missing.some((item) => typeof item !== 'string' || item.length === 0)) {
    fail('invalid_missing_fields', 'missing_fields must be an array of field names', 'missing_fields');
  }
  if (observation.completeness === 'unknown') {
    if (units !== undefined && (!Array.isArray(units) || units.length !== 0)) {
      fail('unknown_usage_has_units', 'Unknown usage cannot claim numeric units', 'usage_units');
    }
    if (missing.length === 0) {
      fail('unknown_usage_without_reason', 'Unknown usage must name what is unavailable', 'missing_fields');
    }
  } else {
    if (!Array.isArray(units) || units.length === 0) {
      fail('usage_units_required', 'Known or partial usage requires at least one reported unit', 'usage_units');
    }
    if (observation.completeness === 'complete' && missing.length !== 0) {
      fail('complete_usage_has_missing_fields', 'Complete usage cannot list missing fields', 'missing_fields');
    }
    if (observation.completeness === 'partial' && missing.length === 0) {
      fail('partial_usage_without_gaps', 'Partial usage must identify missing fields', 'missing_fields');
    }
    const names = new Set();
    for (const [index, rawUnit] of units.entries()) {
      const unit = record(rawUnit, `usage_units[${index}]`);
      assertAllowedKeys(unit, new Set(['name', 'quantity', 'relation', 'included_in']), `usage_units[${index}]`);
      id(unit.name, `usage_units[${index}].name`);
      if (names.has(unit.name)) fail('duplicate_usage_unit', 'Usage unit names must be unique', `usage_units[${index}].name`);
      names.add(unit.name);
      exactDecimal(unit.quantity, `usage_units[${index}].quantity`);
      if (!['standalone', 'included_subset', 'unknown_relation'].includes(unit.relation)) {
        fail('invalid_usage_relation', 'Usage unit relation must preserve subset semantics', `usage_units[${index}].relation`);
      }
      if (unit.relation === 'included_subset') id(unit.included_in, `usage_units[${index}].included_in`);
      if (unit.relation !== 'included_subset' && unit.included_in !== undefined) {
        fail('unexpected_usage_parent', 'included_in is valid only for an included subset', `usage_units[${index}].included_in`);
      }
    }
  }
  return structuredClone(observation);
}

function validateDispatchResult(value) {
  const result = record(value, 'dispatch_result');
  assertAllowedKeys(result, new Set(['provider_outcome', 'usage_observation']), 'dispatch_result');
  const providerOutcome = result.provider_outcome ?? 'unknown';
  if (!['succeeded', 'failed', 'partial', 'unknown'].includes(providerOutcome)) {
    fail('invalid_provider_outcome', 'provider_outcome must use a supported outcome value', 'dispatch_result.provider_outcome');
  }
  return { provider_outcome: providerOutcome, usage_observation: result.usage_observation };
}

function validateExactAmount(value, field) {
  record(value, field);
  return {
    amount: exactDecimal(value.amount, `${field}.amount`),
    currency: currency(value.currency, `${field}.currency`),
  };
}

function assertPort(port, methods) {
  record(port, 'port');
  for (const method of methods) {
    if (typeof port[method] !== 'function') fail('invalid_metering_port', `Metering port must provide ${method}()`, method);
  }
}

async function ignoreFailure(operation) {
  try {
    await operation();
  } catch {
    // Failure details can contain credentials, signed URLs, or provider headers.
  }
}

function abortPromise(signal) {
  if (!signal) return new Promise(() => {});
  if (signal.aborted) return Promise.resolve({ kind: 'aborted' });
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve({ kind: 'aborted' }), { once: true });
  });
}

/**
 * Reserve with the external authority before dispatch. A dispatched attempt that
 * times out, is cancelled, or lacks complete usage remains held for reconciliation.
 * This function never publishes a provider result.
 */
export async function executeMeteredAttempt({ port, request, trustedScope, dispatch, signal }) {
  assertPort(port, [
    'reserveAttempt',
    'releaseBeforeDispatch',
    'markAttemptInFlight',
    'recordTransportAttempt',
    'recordUsageObservation',
    'settleReservation',
    'markOutcomeUnknown',
  ]);
  if (typeof dispatch !== 'function') fail('invalid_dispatch', 'dispatch must be a function', 'dispatch');
  const attempt = validateMeteredAttempt(request, trustedScope);
  if (signal?.aborted) return { status: 'cancelled_before_reservation', published: false };

  let reservation;
  try {
    reservation = await port.reserveAttempt(attempt);
  } catch {
    return { status: 'reservation_unavailable', published: false, error_code: 'metering_authority_unavailable' };
  }
  record(reservation, 'reservation');
  if (reservation.status === 'denied') {
    return { status: 'reservation_denied', published: false, error_code: 'budget_unavailable' };
  }
  if (reservation.status !== 'reserved') {
    fail('invalid_reservation_decision', 'Reservation authority returned an unsupported decision', 'reservation.status');
  }
  id(reservation.reservation_id, 'reservation.reservation_id');
  id(reservation.billable_attempt_id, 'reservation.billable_attempt_id');
  if (reservation.billable_attempt_id !== attempt.billable_attempt_id) {
    fail('reservation_attempt_mismatch', 'Reservation is bound to a different billable attempt', 'reservation.billable_attempt_id');
  }
  validateExactAmount(reservation.held_amount, 'reservation.held_amount');
  id(reservation.lease_id, 'reservation.lease_id');

  const reservationRef = {
    reservation_id: reservation.reservation_id,
    billable_attempt_id: attempt.billable_attempt_id,
    logical_operation_id: attempt.logical_operation_id,
    lease_id: reservation.lease_id,
  };

  if (signal?.aborted) {
    try {
      await port.releaseBeforeDispatch({ ...reservationRef, reason: 'cancelled_before_dispatch' });
      return { status: 'cancelled_before_dispatch', published: false };
    } catch {
      await ignoreFailure(() => port.markOutcomeUnknown({ ...reservationRef, reason: 'pre_dispatch_release_unknown' }));
      return { status: 'pre_dispatch_release_unknown', published: false, hold: 'retained_for_reconciliation' };
    }
  }

  try {
    const started = await port.markAttemptInFlight(reservationRef);
    record(started, 'in_flight_ack');
    if (started.status !== 'in_flight' || started.reservation_id !== reservation.reservation_id) {
      fail('invalid_in_flight_ack', 'Metering authority did not confirm the held attempt as in flight', 'in_flight_ack');
    }
  } catch {
    // The authority may have received the transition even if its response was lost.
    await ignoreFailure(() => port.markOutcomeUnknown({ ...reservationRef, reason: 'in_flight_transition_unknown' }));
    return { status: 'dispatch_authorization_unknown', published: false, error_code: 'in_flight_transition_unknown' };
  }

  if (signal?.aborted) {
    try {
      await port.releaseBeforeDispatch({ ...reservationRef, reason: 'cancelled_before_transport' });
      return { status: 'cancelled_before_dispatch', published: false };
    } catch {
      await ignoreFailure(() => port.markOutcomeUnknown({ ...reservationRef, reason: 'pre_transport_release_unknown' }));
      return { status: 'pre_dispatch_release_unknown', published: false, hold: 'retained_for_reconciliation' };
    }
  }

  const transportIds = new Set();
  const recordTransport = async (transportAttemptId) => {
    id(transportAttemptId, 'transport_attempt_id');
    if (transportIds.has(transportAttemptId)) {
      fail('duplicate_transport_attempt', 'Each transport attempt needs a distinct identity', 'transport_attempt_id');
    }
    transportIds.add(transportAttemptId);
    await port.recordTransportAttempt({ ...reservationRef, transport_attempt_id: transportAttemptId });
  };

  let dispatchPromise;
  try {
    dispatchPromise = Promise.resolve(dispatch({
      attempt,
      signal,
      recordTransportAttempt: recordTransport,
    }));
  } catch (error) {
    dispatchPromise = Promise.reject(error);
  }

  const raced = await Promise.race([
    dispatchPromise.then((value) => ({ kind: 'result', value }), (error) => ({ kind: 'error', error })),
    abortPromise(signal),
  ]);
  if (raced.kind === 'aborted' || signal?.aborted) {
    await ignoreFailure(() => port.markOutcomeUnknown({ ...reservationRef, reason: 'cancelled_after_dispatch' }));
    return { status: 'cancelled_after_dispatch', published: false, hold: 'retained_for_reconciliation' };
  }
  if (raced.kind === 'error') {
    await ignoreFailure(() => port.markOutcomeUnknown({ ...reservationRef, reason: 'dispatch_outcome_unknown' }));
    return { status: 'dispatch_outcome_unknown', published: false, hold: 'retained_for_reconciliation', error_code: 'provider_outcome_unknown' };
  }
  if (transportIds.size === 0) {
    await ignoreFailure(() => port.markOutcomeUnknown({ ...reservationRef, reason: 'transport_attempt_unreported' }));
    return { status: 'transport_attempt_unreported', published: false, hold: 'retained_for_reconciliation' };
  }

  let result;
  try {
    result = validateDispatchResult(raced.value);
  } catch {
    await ignoreFailure(() => port.markOutcomeUnknown({ ...reservationRef, reason: 'dispatch_result_invalid' }));
    return { status: 'dispatch_result_invalid', published: false, error_code: 'invalid_provider_response', hold: 'retained_for_reconciliation' };
  }
  const safeOutcome = { provider_outcome: result.provider_outcome };
  if (result.usage_observation === undefined) {
    await ignoreFailure(() => port.markOutcomeUnknown({ ...reservationRef, reason: 'usage_missing' }));
    return { status: 'usage_unknown', published: false, ...safeOutcome, hold: 'retained_for_reconciliation' };
  }
  let observation;
  try {
    observation = validateUsageObservation(result.usage_observation, attempt);
    if (observation.transport_attempt_id !== undefined && !transportIds.has(observation.transport_attempt_id)) {
      fail('unreported_transport_attempt', 'Usage observation refers to a transport attempt not recorded for this billable attempt', 'transport_attempt_id');
    }
  } catch {
    await ignoreFailure(() => port.markOutcomeUnknown({ ...reservationRef, reason: 'usage_observation_invalid' }));
    return { status: 'usage_observation_invalid', published: false, ...safeOutcome, error_code: 'invalid_usage_observation', hold: 'retained_for_reconciliation' };
  }
  let rawObservationAck;
  try {
    rawObservationAck = await port.recordUsageObservation({ ...reservationRef, observation });
  } catch {
    await ignoreFailure(() => port.markOutcomeUnknown({ ...reservationRef, reason: 'usage_observation_unconfirmed' }));
    return { status: 'usage_observation_unconfirmed', published: false, ...safeOutcome, hold: 'retained_for_reconciliation' };
  }
  record(rawObservationAck, 'usage_observation_ack');
  if (rawObservationAck.status !== 'accepted' && rawObservationAck.status !== 'duplicate') {
    await ignoreFailure(() => port.markOutcomeUnknown({ ...reservationRef, reason: 'usage_observation_unconfirmed' }));
    return { status: 'usage_observation_unconfirmed', published: false, ...safeOutcome, hold: 'retained_for_reconciliation' };
  }
  const observationAck = {
    status: rawObservationAck.status,
    source_observation_id: observation.source_observation_id,
    effective_billable_attempt_id: attempt.billable_attempt_id,
  };
  if (observation.completeness !== 'complete') {
    await ignoreFailure(() => port.markOutcomeUnknown({ ...reservationRef, reason: 'usage_incomplete' }));
    return { status: 'usage_incomplete', published: false, ...safeOutcome, observation_ack: observationAck, hold: 'retained_for_reconciliation' };
  }

  let settlement;
  try {
    settlement = await port.settleReservation({
      ...reservationRef,
      source_observation_id: observation.source_observation_id,
    });
  } catch {
    await ignoreFailure(() => port.markOutcomeUnknown({ ...reservationRef, reason: 'settlement_response_unknown' }));
    return { status: 'settlement_unknown', published: false, ...safeOutcome, error_code: 'settlement_response_unknown', hold: 'retained_for_reconciliation' };
  }
  record(settlement, 'settlement');
  if (settlement.reservation_id !== reservation.reservation_id) {
    fail('settlement_reservation_mismatch', 'Settlement belongs to a different reservation', 'settlement.reservation_id');
  }
  if (settlement.status === 'held_for_reconciliation') {
    return {
      status: 'settlement_pending',
      published: false,
      ...safeOutcome,
      settlement: { reservation_id: reservation.reservation_id, status: 'held_for_reconciliation' },
    };
  }
  if (settlement.status !== 'settled') {
    fail('invalid_settlement', 'Metering authority returned an unsupported settlement state', 'settlement.status');
  }
  validateExactAmount(settlement.consumed_amount, 'settlement.consumed_amount');
  validateExactAmount(settlement.released_unused_amount, 'settlement.released_unused_amount');
  const safeSettlement = {
    reservation_id: reservation.reservation_id,
    status: 'settled',
    consumed_amount: { amount: settlement.consumed_amount.amount, currency: settlement.consumed_amount.currency },
    released_unused_amount: { amount: settlement.released_unused_amount.amount, currency: settlement.released_unused_amount.currency },
  };
  if (settlement.posting_refs !== undefined) {
    if (!Array.isArray(settlement.posting_refs)) fail('invalid_posting_refs', 'posting_refs must be an array', 'settlement.posting_refs');
    safeSettlement.posting_refs = settlement.posting_refs.map((ref, index) => id(ref, `settlement.posting_refs[${index}]`));
  }
  return { status: 'settled', published: false, ...safeOutcome, observation_ack: observationAck, settlement: safeSettlement };
}

/** Forward one validated observation; de-duplication and financial posting stay external. */
export async function recordUsageObservation({ port, attempt, trustedScope, observation }) {
  assertPort(port, ['recordUsageObservation']);
  const validatedAttempt = validateMeteredAttempt(attempt, trustedScope);
  const validatedObservation = validateUsageObservation(observation, validatedAttempt);
  let acknowledgement;
  try {
    acknowledgement = await port.recordUsageObservation({
      tenant_id: validatedAttempt.tenant_id,
      project_id: validatedAttempt.project_id,
      logical_operation_id: validatedAttempt.logical_operation_id,
      billable_attempt_id: validatedAttempt.billable_attempt_id,
      observation: validatedObservation,
    });
  } catch {
    fail('usage_observation_unavailable', 'Metering authority did not confirm the usage observation', 'port.recordUsageObservation');
  }
  record(acknowledgement, 'usage_observation_ack');
  if (acknowledgement.status !== 'accepted' && acknowledgement.status !== 'duplicate') {
    fail('invalid_usage_ack', 'Metering authority did not acknowledge the observation', 'acknowledgement.status');
  }
  return {
    status: acknowledgement.status,
    source_observation_id: validatedObservation.source_observation_id,
    effective_billable_attempt_id: validatedAttempt.billable_attempt_id,
  };
}

/** Acceptance evidence gate. This checks references only; it cannot establish owner agreement. */
export function evaluateMeteringAgreementGate(evidence) {
  const requiredRoles = ['Finance and reliability', 'Agent and research'];
  const byRole = evidence && typeof evidence === 'object' && !Array.isArray(evidence)
    ? evidence.acceptances
    : undefined;
  const missingEvidence = [];
  const missingRoles = requiredRoles.filter((role) => {
    const entry = Array.isArray(byRole) ? byRole.find((item) => item?.owner_role === role) : undefined;
    if (!entry || entry.status !== 'accepted') {
      missingEvidence.push(`${role}:owner_acceptance`);
      return true;
    }
    if (typeof entry.artifact_ref !== 'string' || entry.artifact_ref.length === 0
      || typeof entry.artifact_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.artifact_sha256)
      || typeof entry.pinned_revision !== 'string' || entry.pinned_revision.length === 0) {
      missingEvidence.push(`${role}:pinned_artifact`);
    }
    if (typeof entry.independent_review_ref !== 'string' || entry.independent_review_ref.length === 0) {
      missingEvidence.push(`${role}:independent_review`);
    }
    return false;
  });
  const protocolPin = evidence && typeof evidence === 'object' ? evidence.external_protocol_pin : undefined;
  if (!protocolPin || typeof protocolPin !== 'object' || Array.isArray(protocolPin)
    || typeof protocolPin.revision !== 'string' || protocolPin.revision.length === 0
    || typeof protocolPin.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(protocolPin.sha256)
    || typeof protocolPin.artifact_ref !== 'string' || protocolPin.artifact_ref.length === 0) {
    missingEvidence.push('external_protocol_pin');
  }
  return {
    status: missingEvidence.length === 0 && missingRoles.length === 0 ? 'owner_review_required' : 'blocked',
    acceptance_allowed: false,
    independent_owner_verification_required: true,
    missing_owner_roles: missingRoles,
    missing_evidence: missingEvidence,
    note: 'This proposal cannot validate external agreement; pinned owner evidence still requires independent verification.',
  };
}

export function sameMeteringIdentity(left, right) {
  return isDeepStrictEqual(
    ['tenant_id', 'project_id', 'logical_operation_id', 'billable_attempt_id'].map((key) => left?.[key]),
    ['tenant_id', 'project_id', 'logical_operation_id', 'billable_attempt_id'].map((key) => right?.[key]),
  );
}
