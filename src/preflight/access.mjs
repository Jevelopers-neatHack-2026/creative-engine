import { randomUUID } from 'node:crypto';
import {
  executeMeteredAttempt,
  validateMeteredAttempt,
} from '../contracts/metering.mjs';
import { canonicalHash } from '../contracts/validation.mjs';

export const ACCESS_PREFLIGHT_VERSION = 'creative.access-preflight.proposal/v1';

export const ACCESS_CELL_DEFINITIONS = Object.freeze([
  Object.freeze({ cell_id: 'image_generation', owner_role: 'Creative and fulfillment', acceptance_ids: ['EVAL-03', 'FIN-10'], operation_kind: 'image_generation', billable: true }),
  Object.freeze({ cell_id: 'image_edit', owner_role: 'Creative and fulfillment', acceptance_ids: ['EVAL-03', 'FIN-10'], operation_kind: 'image_edit', billable: true }),
  Object.freeze({ cell_id: 'harness_jev', owner_role: 'Agent and research', acceptance_ids: ['FIN-10'], operation_kind: 'jev_decision', billable: true }),
  Object.freeze({ cell_id: 'vision_observer', owner_role: 'Product and frontend', acceptance_ids: ['EVAL-03', 'FIN-10'], operation_kind: 'vision_observation', billable: true }),
  Object.freeze({ cell_id: 'generative_classifier_baseline', owner_role: 'Product and frontend', acceptance_ids: ['EVAL-03', 'FIN-10'], operation_kind: 'baseline_evaluation', billable: true }),
  Object.freeze({ cell_id: 'planning', owner_role: 'Creative and fulfillment', acceptance_ids: ['EVAL-03', 'FIN-10'], operation_kind: 'planning', billable: true }),
  Object.freeze({ cell_id: 'neatlogs_ingestion', owner_role: 'Finance and reliability', acceptance_ids: ['SPN-01', 'FIN-10'], operation_kind: null, billable: null }),
  Object.freeze({ cell_id: 'neatlogs_readback', owner_role: 'Finance and reliability', acceptance_ids: ['SPN-01', 'FIN-10'], operation_kind: null, billable: null }),
]);

const CELL_BY_ID = new Map(ACCESS_CELL_DEFINITIONS.map((entry) => [entry.cell_id, entry]));
const CELL_IDS = new Set(CELL_BY_ID.keys());
const REPORT_MODES = new Set(['mock', 'live']);
const STATUSES = new Set(['verified', 'simulated', 'blocked', 'denied', 'failed', 'unknown']);
const HASH = /^sha256:[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/;
const CURRENCY = /^[A-Z]{3}$/;
const MAX_CAPABILITY_AGE_MS = 5 * 60_000;
const SENSITIVE_KEY = /(?:(?:^|[_-])(?:credential|secret|password|authorization|bearer|cookie|api[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|token)(?:$|[_-])|(?<!s)token$|(?:credentials?|secrets?|password|authorization|bearer|cookie|apiKey|privateKey))$/i;
const RAW_CONTENT_KEY = /^(?:prompt|prompt_text|raw_text|image_bytes|authorization_header|headers?)$/i;
const SENSITIVE_VALUE = /(?:\bbearer\s+[A-Za-z0-9._~+\/-]{1,}={0,2}(?![A-Za-z0-9._~+\/-])|\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\b(?:rk|pk)-[A-Za-z0-9_-]{12,}\b|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|https?:\/\/[^\s"'<>]+)/i;
const OPAQUE_REF = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/;
const SAFE_STOP_CONDITIONS = new Set([
  'one_billable_attempt',
  'one_transport_attempt',
  'stop_on_quota_or_rate_limit',
  'stop_on_authentication_or_permission_error',
  'stop_on_deadline',
  'stop_on_unknown_outcome',
]);
const RESULT_BRAND = Symbol('access-preflight-result');
const RESULT_PROVENANCE = new WeakMap();
const SAFE_ERROR_CODES = new Set([
  'invalid_object', 'unknown_field', 'invalid_text', 'invalid_identifier', 'invalid_hash', 'invalid_datetime', 'invalid_amount',
  'configuration_too_deep', 'configuration_too_large', 'sensitive_configuration_field', 'sensitive_configuration_value', 'invalid_configuration', 'invalid_endpoint',
  'jev_model_alias_rejected', 'cell_identity_mismatch', 'owner_role_mismatch', 'invalid_selection_state', 'incomplete_candidate_evidence',
  'trusted_scope_mismatch', 'invalid_stop_conditions', 'invalid_currency', 'missing_spend_cap', 'unexpected_spend_cap',
  'missing_selected_target', 'unsupported_version', 'invalid_cells', 'invalid_cell_identity', 'duplicate_cell', 'invalid_cell',
  'pin_not_accepted', 'pin_scope_mismatch', 'pin_hash_mismatch', 'pin_target_mismatch', 'mock_pin_cannot_authorize_live', 'live_evidence_in_mock_run',
  'invalid_access_observation', 'evidence_mode_mismatch', 'access_observation_target_mismatch', 'model_observation_missing',
  'unexpected_model_observation', 'authorization_denied', 'authorization_unavailable', 'authorization_evidence_mode_mismatch',
  'authorization_incomplete', 'authorization_scope_mismatch', 'authorization_attempt_limit_mismatch', 'authorization_expired_or_revoked',
  'authorization_owner_missing', 'authorization_check_from_future', 'reservation_scope_denied', 'reservation_scope_unknown',
  'authorization_reference_mismatch', 'pin_owner_evidence_missing', 'pin_check_from_future', 'access_check_from_future', 'access_check_stale',
  'reservation_evidence_mode_mismatch', 'reservation_binding_mismatch', 'reservation_attempt_mismatch', 'reservation_cap_mismatch',
  'adapter_evidence_mode_mismatch', 'adapter_result_target_mismatch', 'provider_outcome_invalid', 'invalid_result_status',
  'unknown_cell', 'invalid_mode', 'mock_requires_fixture_ports', 'live_adapter_unavailable', 'required_adapter_method_missing',
  'access_probe_unavailable', 'metering_request_invalid', 'metering_target_mismatch', 'authorization_reference_missing',
  'preflight_deadline_passed', 'authorization_revoked_before_dispatch', 'metering_or_dispatch_unknown', 'invalid_results',
  'pin_verification_unavailable', 'cell_preflight_failed', 'authorization_verification_failed', 'provider_http_error', 'provider_response_invalid', 'credential_unavailable',
  'prompt_unavailable', 'prompt_hash_mismatch', 'asset_unavailable', 'asset_hash_mismatch', 'unsupported_image_configuration',
  'transport_attempt_limit_exceeded', 'trusted_account_scope_missing', 'operation_permission_denied', 'adapter_unavailable',
  'invalid_evidence_reference', 'invalid_abort_signal', 'invalid_access_capability', 'capability_scope_mismatch',
  'capability_protocol_changed', 'capability_revoked_before_dispatch', 'capability_expired', 'capability_verification_unavailable',
  'transport_authorization_fence_missing',
]);
const SAFE_REASON_CODES = new Set([
  ...SAFE_ERROR_CODES,
  'cell_not_supplied', 'cell_not_run', 'pin_unresolved', 'authentication_unknown', 'authentication_denied',
  'authentication_not_applicable', 'model_unknown', 'model_not_listed', 'quota_denied', 'quota_unknown',
  'metering_operation_unpublished', 'fixture_boundary_only', 'live_operation_and_reconciliation_confirmed',
  'provider_operation_failed', 'budget_reservation_denied', 'reservation_denied', 'cancelled_before_reservation',
  'reservation_unavailable', 'dispatch_authorization_unknown', 'cancelled_before_dispatch',
  'pre_dispatch_release_unknown', 'cancelled_after_dispatch', 'dispatch_outcome_unknown',
  'transport_attempt_unreported', 'dispatch_result_invalid', 'usage_unknown', 'usage_observation_invalid',
  'usage_observation_unconfirmed', 'usage_incomplete', 'settlement_unknown', 'settlement_pending', 'settled',
  'reservation_scope_unknown', 'reservation_scope_denied', 'budget_unavailable', 'metering_authority_unavailable',
  'operation_permission_unknown',
  'provider_outcome_unknown', 'invalid_provider_response', 'invalid_usage_observation', 'in_flight_transition_unknown',
  'settlement_response_unknown', 'authentication_not_applicable',
]);

function hasBasicCredential(value) {
  const candidates = value.matchAll(/\bbasic[ \t]+([A-Za-z0-9+/]+={0,2})(?![A-Za-z0-9+/=])/ig);
  for (const match of candidates) {
    const encoded = match[1];
    const unpadded = encoded.replace(/=+$/, '');
    const padding = encoded.length - unpadded.length;
    if (padding > 2 || (padding > 0 && encoded.length % 4 !== 0) || unpadded.length % 4 === 1) continue;
    const padded = unpadded + '='.repeat((4 - (unpadded.length % 4)) % 4);
    try {
      const decoded = Buffer.from(padded, 'base64');
      if (decoded.toString('base64') === padded && decoded.includes(0x3a)) return true;
    } catch {
      // Non-canonical base64 is ordinary configuration text, not a credential.
    }
  }
  return false;
}

function hasSensitiveValue(value) {
  return SENSITIVE_VALUE.test(value) || hasBasicCredential(value);
}

function hasSensitiveUrlComponent(value) {
  let decoded = value;
  for (let depth = 0; depth < 8; depth += 1) {
    if (hasSensitiveValue(decoded)) return true;
    let next;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return true;
    }
    if (next === decoded) return false;
    decoded = next;
  }
  return true;
}

export class AccessPreflightError extends Error {
  constructor(code, message, field = undefined) {
    super(message);
    this.name = 'AccessPreflightError';
    this.code = code;
    if (field !== undefined) this.field = field;
  }
}

function fail(code, message, field) {
  throw new AccessPreflightError(code, message, field);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function record(value, field) {
  if (!isRecord(value)) fail('invalid_object', 'Expected a plain object.', field);
  return value;
}

function dependencyObject(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('invalid_object', 'Expected an adapter object.', field);
  return value;
}

function exactKeys(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('unknown_field', 'Unsupported field in access preflight input.', field);
  }
}

function text(value, field, { max = 300 } = {}) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max || /[\r\n\0]/.test(value)) {
    fail('invalid_text', 'Expected a bounded non-empty string.', field);
  }
  return value;
}

function id(value, field) {
  if (typeof value !== 'string' || !ID.test(value) || hasSensitiveValue(value)) {
    fail('invalid_identifier', 'Expected an opaque identifier without credential or personal data.', field);
  }
  return value;
}

function sha256(value, field) {
  if (typeof value !== 'string' || !HASH.test(value)) fail('invalid_hash', 'Expected a lowercase SHA-256 reference.', field);
  return value;
}

function datetime(value, field) {
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value))) {
    fail('invalid_datetime', 'Expected an ISO date-time.', field);
  }
  return value;
}

function amount(value, field) {
  if (typeof value !== 'string' || !DECIMAL.test(value)) fail('invalid_amount', 'Expected a non-negative exact decimal string.', field);
  return value;
}

function rejectSensitiveConfiguration(value, depth = 0) {
  if (depth > 12) fail('configuration_too_deep', 'Configuration exceeds the supported nesting depth.', 'target.configuration');
  if (typeof value === 'string') {
    if (hasSensitiveValue(value)) fail('sensitive_configuration_value', 'Configuration values cannot contain credentials, personal addresses, or URLs.', 'target.configuration');
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) fail('configuration_too_large', 'Configuration contains too many values.', 'target.configuration');
    for (const item of value) rejectSensitiveConfiguration(item, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key) || RAW_CONTENT_KEY.test(key) || hasSensitiveValue(key)) {
      fail('sensitive_configuration_field', 'Credentials and raw customer content cannot be stored in the preflight plan.', 'target.configuration');
    }
    rejectSensitiveConfiguration(item, depth + 1);
  }
}

function cloneConfiguration(value) {
  record(value, 'target.configuration');
  rejectSensitiveConfiguration(value);
  try {
    return structuredClone(value);
  } catch {
    fail('invalid_configuration', 'Configuration must contain JSON-compatible values.', 'target.configuration');
  }
}

function definition(cellId) {
  return CELL_BY_ID.get(cellId);
}

function validateTarget(target, expectedCell) {
  if (target === null) return null;
  record(target, 'target');
  exactKeys(target, new Set(['service', 'endpoint', 'model', 'sdk', 'configuration', 'configuration_sha256']), 'target');
  const service = id(target.service, 'target.service');
  const endpoint = text(target.endpoint, 'target.endpoint', { max: 500 });
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    fail('invalid_endpoint', 'Endpoint must be an absolute HTTPS URL.', 'target.endpoint');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    fail('invalid_endpoint', 'Endpoint must be an HTTPS URL without embedded credentials or query data.', 'target.endpoint');
  }
  if ([parsed.hostname, ...parsed.pathname.split('/')].some(hasSensitiveUrlComponent)) {
    fail('invalid_endpoint', 'Endpoint host and path cannot contain credentials or personal data.', 'target.endpoint');
  }
  const model = target.model === null ? null : id(target.model, 'target.model');
  const sdk = target.sdk === null ? null : record(target.sdk, 'target.sdk');
  if (sdk) {
    exactKeys(sdk, new Set(['name', 'version']), 'target.sdk');
    id(sdk.name, 'target.sdk.name');
    id(sdk.version, 'target.sdk.version');
  }
  const configuration = cloneConfiguration(target.configuration);
  const expectedHash = canonicalHash(configuration);
  if (target.configuration_sha256 !== expectedHash) fail('configuration_hash_mismatch', 'Configuration hash does not match its canonical content.', 'target.configuration_sha256');
  if (expectedCell.cell_id === 'harness_jev' && model !== null && model !== 'jev-1.13.0') {
    fail('jev_model_alias_rejected', 'JEV pin must use the documented dated model version.', 'target.model');
  }
  return {
    service,
    endpoint: parsed.toString().replace(/\/$/, ''),
    model,
    sdk: sdk ? { name: sdk.name, version: sdk.version } : null,
    configuration,
    configuration_sha256: expectedHash,
  };
}

function validateCell(value, expectedCell) {
  record(value, 'cell');
  exactKeys(value, new Set(['cell_id', 'owner_role', 'selection', 'scope', 'target', 'spend']), 'cell');
  if (value.cell_id !== expectedCell.cell_id) fail('cell_identity_mismatch', 'Cell identity does not match its required row.', 'cell.cell_id');
  if (value.owner_role !== expectedCell.owner_role) fail('owner_role_mismatch', 'Cell owner role does not match the maintained ownership map.', 'cell.owner_role');
  const selection = record(value.selection, 'cell.selection');
  exactKeys(selection, new Set(['state', 'candidate_ref', 'candidate_sha256']), 'cell.selection');
  const selectionState = ['unresolved', 'documented_candidate', 'owner_selected'].includes(selection.state)
    ? selection.state
    : fail('invalid_selection_state', 'Selection state is unsupported.', 'cell.selection.state');
  const candidateRef = selection.candidate_ref === undefined ? undefined : id(selection.candidate_ref, 'cell.selection.candidate_ref');
  const candidateHash = selection.candidate_sha256 === undefined ? undefined : sha256(selection.candidate_sha256, 'cell.selection.candidate_sha256');
  if ((candidateRef === undefined) !== (candidateHash === undefined)) fail('incomplete_candidate_evidence', 'Candidate reference and hash must appear together.', 'cell.selection');
  const scope = record(value.scope, 'cell.scope');
  exactKeys(scope, new Set(['tenant_id', 'project_id', 'budget_scope_id', 'account_ref', 'project_ref']), 'cell.scope');
  const cleanScope = {
    tenant_id: id(scope.tenant_id, 'cell.scope.tenant_id'),
    project_id: id(scope.project_id, 'cell.scope.project_id'),
    budget_scope_id: id(scope.budget_scope_id, 'cell.scope.budget_scope_id'),
    account_ref: id(scope.account_ref, 'cell.scope.account_ref'),
    project_ref: id(scope.project_ref, 'cell.scope.project_ref'),
  };
  const target = validateTarget(value.target, expectedCell);
  if (expectedCell.billable === true && target !== null && (target.model === null || target.sdk === null)) {
    fail('missing_selected_target', 'Billable cells require an exact model and SDK or runtime pin.', 'cell.target');
  }
  let spend = null;
  if (value.spend !== null) {
    const rawSpend = record(value.spend, 'cell.spend');
    exactKeys(rawSpend, new Set(['maximum_amount', 'currency', 'deadline_at', 'stop_conditions']), 'cell.spend');
    const conditions = rawSpend.stop_conditions;
    if (!Array.isArray(conditions) || conditions.length !== SAFE_STOP_CONDITIONS.size) {
      fail('invalid_stop_conditions', 'All fixed stop conditions must be present.', 'cell.spend.stop_conditions');
    }
    const uniqueConditions = new Set(conditions.map((entry) => text(entry, 'cell.spend.stop_conditions')));
    if (uniqueConditions.size !== SAFE_STOP_CONDITIONS.size || [...SAFE_STOP_CONDITIONS].some((entry) => !uniqueConditions.has(entry))) {
      fail('invalid_stop_conditions', 'Stop conditions must match the fixed single-attempt preflight policy.', 'cell.spend.stop_conditions');
    }
    if (rawSpend.currency !== 'USD' && (typeof rawSpend.currency !== 'string' || !CURRENCY.test(rawSpend.currency))) {
      fail('invalid_currency', 'Currency must be a three-letter uppercase code.', 'cell.spend.currency');
    }
    spend = {
      maximum_amount: amount(rawSpend.maximum_amount, 'cell.spend.maximum_amount'),
      currency: rawSpend.currency,
      deadline_at: datetime(rawSpend.deadline_at, 'cell.spend.deadline_at'),
      stop_conditions: [...uniqueConditions].sort(),
    };
  }
  if (expectedCell.billable === true && spend === null) fail('missing_spend_cap', 'Billable cells need a per-attempt cap and stop conditions.', 'cell.spend');
  if (expectedCell.billable === null && spend !== null) fail('unexpected_spend_cap', 'Neatlogs access cells have no accepted metering operation; live side effects remain blocked.', 'cell.spend');
  if (expectedCell.billable === true && (!target || !target.model || !target.sdk)) {
    // Unresolved model selection is a valid pending row; it is blocked by the runner below.
    if (selectionState === 'owner_selected') fail('missing_selected_target', 'Owner-selected billable cells need a complete exact endpoint, model, and SDK pin.', 'cell.target');
  }
  return {
    cell_id: expectedCell.cell_id,
    owner_role: expectedCell.owner_role,
    acceptance_ids: [...expectedCell.acceptance_ids],
    operation_kind: expectedCell.operation_kind,
    billable: expectedCell.billable,
    selection: { state: selectionState, ...(candidateRef ? { candidate_ref: candidateRef, candidate_sha256: candidateHash } : {}) },
    scope: cleanScope,
    target,
    spend,
  };
}

/** Validate a complete, fixed-denominator matrix. Missing/unresolved capabilities are rows, not removals. */
export function validateAccessPlan(value, trustedScope) {
  record(value, 'plan');
  exactKeys(value, new Set(['schema_version', 'run_id', 'created_at', 'cells']), 'plan');
  if (value.schema_version !== ACCESS_PREFLIGHT_VERSION) fail('unsupported_version', 'Unsupported access preflight plan version.', 'plan.schema_version');
  const runId = opaqueRef(value.run_id, 'plan.run_id');
  const createdAt = datetime(value.created_at, 'plan.created_at');
  const trusted = record(trustedScope, 'trustedScope');
  for (const field of ['tenant_id', 'project_id', 'budget_scope_id']) {
    if (typeof trusted[field] !== 'string' || !ID.test(trusted[field])) fail('invalid_trusted_scope', 'Trusted authenticated scope is incomplete.', 'trustedScope');
  }
  if (!Array.isArray(value.cells)) fail('invalid_cells', 'Plan cells must be an array.', 'plan.cells');
  const inputById = new Map();
  for (const raw of value.cells) {
    if (!isRecord(raw) || typeof raw.cell_id !== 'string' || !CELL_IDS.has(raw.cell_id)) {
      fail('invalid_cell_identity', 'Plan contains an unknown or malformed cell identity.', 'plan.cells');
    }
    if (inputById.has(raw.cell_id)) fail('duplicate_cell', 'Each required access cell must occur exactly once.', 'plan.cells');
    inputById.set(raw.cell_id, raw);
  }
  const cells = ACCESS_CELL_DEFINITIONS.map((expected) => {
    const raw = inputById.get(expected.cell_id);
    if (!raw) return {
      cell_id: expected.cell_id,
      owner_role: expected.owner_role,
      acceptance_ids: [...expected.acceptance_ids],
      operation_kind: expected.operation_kind,
      billable: expected.billable,
      selection: { state: 'unresolved' },
      scope: null,
      target: null,
      spend: null,
      input_status: 'missing',
    };
    try {
      const cell = validateCell(raw, expected);
      if (cell.scope.tenant_id !== trusted.tenant_id || cell.scope.project_id !== trusted.project_id || cell.scope.budget_scope_id !== trusted.budget_scope_id) {
        fail('trusted_scope_mismatch', 'Cell scope does not match authenticated context.', 'cell.scope');
      }
      return { ...cell, input_status: 'valid' };
    } catch (error) {
      const code = safeFailureCode(error, 'invalid_cell');
      return {
        cell_id: expected.cell_id,
        owner_role: expected.owner_role,
        acceptance_ids: [...expected.acceptance_ids],
        operation_kind: expected.operation_kind,
        billable: expected.billable,
        selection: { state: 'unresolved' },
        scope: null,
        target: null,
        spend: null,
        input_status: 'invalid',
        input_error_code: code,
      };
    }
  });
  return { schema_version: ACCESS_PREFLIGHT_VERSION, run_id: runId, created_at: createdAt, cells };
}

function refEvidence(value, field) {
  record(value, field);
  const ref = opaqueRef(value.ref, field + '.ref');
  const digest = sha256(value.sha256, field + '.sha256');
  return { ref, sha256: digest };
}

function opaqueRef(value, field) {
  if (typeof value !== 'string' || !OPAQUE_REF.test(value) || /^(?:Bearer|Basic|sk-|https?:\/\/)/i.test(value) || hasSensitiveValue(value)) {
    fail('invalid_evidence_reference', 'Expected a safe opaque reference without personal or credential data.', field);
  }
  return value;
}

function pinnedEvidence(value, field) {
  record(value, field);
  const base = refEvidence(value, field);
  const pinnedRevision = opaqueRef(value.pinned_revision, field + '.pinned_revision');
  const independentReview = refEvidence(value.independent_review, field + '.independent_review');
  return { ...base, pinned_revision: pinnedRevision, independent_review: independentReview };
}

function sameText(left, right) {
  return typeof left === 'string' && left === right;
}

function expectedTargetBinding(cell) {
  return {
    service: cell.target.service,
    endpoint: cell.target.endpoint,
    model: cell.target.model,
    sdk_name: cell.target.sdk.name,
    sdk_version: cell.target.sdk.version,
    configuration_sha256: cell.target.configuration_sha256,
    account_ref: cell.scope.account_ref,
    project_ref: cell.scope.project_ref,
  };
}

function validateTargetBinding(value, cell, field) {
  const binding = record(value, field);
  const expected = expectedTargetBinding(cell);
  exactKeys(binding, new Set(Object.keys(expected)), field);
  if (Object.entries(expected).some(([key, expectedValue]) => binding[key] !== expectedValue)) {
    fail('pin_target_mismatch', 'Evidence does not bind the exact provider target, SDK, and account/project.', field);
  }
}

function validatePinDecision(value, cell, mode, now) {
  record(value, 'pin_decision');
  if (value.decision !== 'accepted') fail('pin_not_accepted', 'Owner has not accepted this exact provider configuration.', 'pin_decision.decision');
  if (value.cell_id !== cell.cell_id || value.owner_role !== cell.owner_role) fail('pin_scope_mismatch', 'Pin decision is bound to a different cell or owner.', 'pin_decision');
  if (value.configuration_sha256 !== cell.target.configuration_sha256) fail('pin_hash_mismatch', 'Pin decision does not bind the current configuration hash.', 'pin_decision.configuration_sha256');
  validateTargetBinding(value.target_binding, cell, 'pin_decision.target_binding');
  if (mode === 'live' && value.evidence_mode !== 'live') fail('mock_pin_cannot_authorize_live', 'Mock pin evidence cannot authorize live preflight.', 'pin_decision.evidence_mode');
  if (mode === 'mock' && value.evidence_mode !== 'mock') fail('live_evidence_in_mock_run', 'Live pin evidence cannot be represented as a mock result.', 'pin_decision.evidence_mode');
  const evidence = pinnedEvidence(value.evidence, 'pin_decision.evidence');
  if (!isRecord(value.owner_evidence) || value.owner_evidence.owner_role !== cell.owner_role) fail('pin_owner_evidence_missing', 'Exact configuration acceptance must be independently verified for its accountable owner.', 'pin_decision.owner_evidence');
  const ownerEvidence = pinnedEvidence(value.owner_evidence, 'pin_decision.owner_evidence');
  const protocol = pinnedEvidence(value.protocol, 'pin_decision.protocol');
  const checkedAt = datetime(value.checked_at, 'pin_decision.checked_at');
  if (Date.parse(checkedAt) > Date.parse(now)) fail('pin_check_from_future', 'Pin verification timestamp cannot be in the future.', 'pin_decision.checked_at');
  return { evidence, owner_evidence: ownerEvidence, protocol, checked_at: checkedAt };
}

function validateAccessObservation(value, cell, mode, now) {
  record(value, 'access_observation');
  const allowed = new Set(['evidence_mode', 'target', 'authentication', 'model_listing', 'operation_permission', 'quota', 'checked_at', 'evidence']);
  exactKeys(value, allowed, 'access_observation');
  const expectedEvidenceMode = mode;
  if (value.evidence_mode !== expectedEvidenceMode) fail('evidence_mode_mismatch', 'Adapter evidence mode does not match the requested run mode.', 'access_observation.evidence_mode');
  const observedTarget = record(value.target, 'access_observation.target');
  exactKeys(observedTarget, new Set(['service', 'endpoint', 'model', 'sdk_name', 'sdk_version', 'configuration_sha256', 'account_ref', 'project_ref']), 'access_observation.target');
  if (observedTarget.service !== cell.target?.service || observedTarget.endpoint !== cell.target?.endpoint
    || observedTarget.model !== cell.target?.model || observedTarget.configuration_sha256 !== cell.target?.configuration_sha256
    || observedTarget.sdk_name !== cell.target?.sdk?.name || observedTarget.sdk_version !== cell.target?.sdk?.version
    || observedTarget.account_ref !== cell.scope?.account_ref || observedTarget.project_ref !== cell.scope?.project_ref) {
    fail('access_observation_target_mismatch', 'Read-only access observation is bound to a different target or account.', 'access_observation.target');
  }
  const authentication = ['confirmed', 'denied', 'unknown', 'not_applicable'].includes(value.authentication)
    ? value.authentication
    : fail('invalid_access_observation', 'Authentication observation is invalid.', 'access_observation.authentication');
  const modelListing = ['listed', 'not_listed', 'not_applicable', 'unknown'].includes(value.model_listing)
    ? value.model_listing
    : fail('invalid_access_observation', 'Model listing observation is invalid.', 'access_observation.model_listing');
  const operationPermission = ['confirmed', 'denied', 'unknown', 'not_tested'].includes(value.operation_permission)
    ? value.operation_permission
    : fail('invalid_access_observation', 'Operation permission observation is invalid.', 'access_observation.operation_permission');
  const quota = ['available', 'denied', 'unknown', 'not_checked'].includes(value.quota)
    ? value.quota
    : fail('invalid_access_observation', 'Quota observation is invalid.', 'access_observation.quota');
  const checkedAt = datetime(value.checked_at, 'access_observation.checked_at');
  if (Date.parse(checkedAt) > Date.parse(now)) fail('access_check_from_future', 'Access observation timestamp cannot be in the future.', 'access_observation.checked_at');
  if (Date.parse(now) - Date.parse(checkedAt) > MAX_CAPABILITY_AGE_MS) fail('access_check_stale', 'Read-only provider access observation is stale.', 'access_observation.checked_at');
  const evidence = refEvidence(value.evidence, 'access_observation.evidence');
  if (cell.target?.model && modelListing === 'not_applicable') fail('model_observation_missing', 'Model cell must record model-listing evidence.', 'access_observation.model_listing');
  if (!cell.target?.model && modelListing === 'listed') fail('unexpected_model_observation', 'A model-free cell cannot claim model-listing evidence.', 'access_observation.model_listing');
  // The provider adapter's model/configuration metadata is not authority for
  // operation permission or quota. Those fields are replaced by the separately
  // injected trusted capability verifier before any grant or reservation.
  void operationPermission;
  void quota;
  return { authentication, model_listing: modelListing, operation_permission: 'unknown', quota: 'unknown', checked_at: checkedAt, evidence };
}

function capabilityBinding(cell) {
  return {
    cell_id: cell.cell_id,
    owner_role: cell.owner_role,
    operation_kind: cell.operation_kind,
    target_binding: expectedTargetBinding(cell),
    scope: cell.scope,
    deadline_at: cell.spend.deadline_at,
  };
}

function validateCapabilityDecision(value, cell, mode, now, deadlineAt) {
  record(value, 'capability_decision');
  if (!['confirmed', 'denied', 'unknown'].includes(value.decision)) {
    fail('invalid_access_capability', 'Capability verifier returned an unsupported decision.', 'capability_decision.decision');
  }
  if (value.evidence_mode !== mode) fail('evidence_mode_mismatch', 'Capability evidence mode does not match the requested run mode.', 'capability_decision.evidence_mode');
  const expected = capabilityBinding(cell);
  if (value.cell_id !== expected.cell_id || value.owner_role !== expected.owner_role || value.operation_kind !== expected.operation_kind) {
    fail('capability_scope_mismatch', 'Capability evidence is bound to a different cell, owner, or operation.', 'capability_decision');
  }
  if (value.deadline_at !== expected.deadline_at) fail('capability_scope_mismatch', 'Capability evidence is bound to a different operation deadline.', 'capability_decision.deadline_at');
  const scope = record(value.scope, 'capability_decision.scope');
  exactKeys(scope, new Set(['tenant_id', 'project_id', 'budget_scope_id', 'account_ref', 'project_ref']), 'capability_decision.scope');
  if (Object.keys(expected.scope).some((field) => scope[field] !== expected.scope[field])) {
    fail('capability_scope_mismatch', 'Capability evidence is bound to a different tenant, project, budget, or provider account.', 'capability_decision.scope');
  }
  validateTargetBinding(value.target_binding, cell, 'capability_decision.target_binding');
  const operationPermission = ['confirmed', 'denied', 'unknown', 'not_tested'].includes(value.operation_permission)
    ? value.operation_permission
    : fail('invalid_access_capability', 'Capability permission status is invalid.', 'capability_decision.operation_permission');
  const quota = ['available', 'denied', 'unknown', 'not_checked'].includes(value.quota)
    ? value.quota
    : fail('invalid_access_capability', 'Capability quota status is invalid.', 'capability_decision.quota');
  if (value.decision === 'confirmed' && (operationPermission !== 'confirmed' || quota !== 'available')) {
    fail('invalid_access_capability', 'A confirmed capability must include exact operation permission and available quota.', 'capability_decision');
  }
  if (value.decision === 'denied' && operationPermission !== 'denied' && quota !== 'denied') {
    fail('invalid_access_capability', 'A denied capability must identify denied operation permission or quota.', 'capability_decision');
  }
  if (value.decision === 'unknown' && operationPermission === 'confirmed' && quota === 'available') {
    fail('invalid_access_capability', 'Capability status cannot be unknown when permission and quota are both confirmed.', 'capability_decision');
  }
  const checkedAt = datetime(value.checked_at, 'capability_decision.checked_at');
  const expiresAt = datetime(value.expires_at, 'capability_decision.expires_at');
  if (Date.parse(checkedAt) > Date.parse(now) || Date.parse(now) - Date.parse(checkedAt) > MAX_CAPABILITY_AGE_MS
    || Date.parse(expiresAt) <= Date.parse(now)
    || Date.parse(expiresAt) < Date.parse(deadlineAt)) {
    fail('capability_expired', 'Capability evidence must be current and remain valid through the authorized deadline.', 'capability_decision.expires_at');
  }
  const evidence = pinnedEvidence(value.evidence, 'capability_decision.evidence');
  const protocol = pinnedEvidence(value.protocol, 'capability_decision.protocol');
  if (!isRecord(value.owner_evidence) || value.owner_evidence.owner_role !== cell.owner_role) {
    fail('pin_owner_evidence_missing', 'Exact access and quota eligibility requires independently verified evidence from its accountable owner.', 'capability_decision.owner_evidence');
  }
  const ownerEvidence = pinnedEvidence(value.owner_evidence, 'capability_decision.owner_evidence');
  return {
    decision: value.decision,
    operation_permission: operationPermission,
    quota,
    checked_at: checkedAt,
    expires_at: expiresAt,
    evidence,
    owner_evidence: { ...ownerEvidence, owner_role: cell.owner_role },
    protocol,
  };
}

function buildExpectedGrant(cell, meteringRequest, now) {
  return {
    tenant_id: cell.scope.tenant_id,
    project_id: cell.scope.project_id,
    budget_scope_id: cell.scope.budget_scope_id,
    account_ref: cell.scope.account_ref,
    project_ref: cell.scope.project_ref,
    service: cell.target.service,
    endpoint: cell.target.endpoint,
    model: cell.target.model,
    sdk_name: cell.target.sdk.name,
    sdk_version: cell.target.sdk.version,
    operation_kind: cell.operation_kind,
    configuration_sha256: cell.target.configuration_sha256,
    logical_operation_id: meteringRequest.logical_operation_id,
    billable_attempt_id: meteringRequest.billable_attempt_id,
    maximum_amount: cell.spend.maximum_amount,
    currency: cell.spend.currency,
    deadline_at: cell.spend.deadline_at,
    stop_conditions: [...cell.spend.stop_conditions],
    max_billable_attempts: 1,
    max_transport_attempts: 1,
    now,
  };
}

function validateGrant(value, expected, mode, now) {
  record(value, 'authorization_decision');
  if (value.decision !== 'authorized') fail(value.decision === 'denied' ? 'authorization_denied' : 'authorization_unavailable', 'Trusted authorization did not grant this exact attempt.', 'authorization_decision.decision');
  if (value.evidence_mode !== mode) fail('authorization_evidence_mode_mismatch', 'Authorization evidence mode does not match the run.', 'authorization_decision.evidence_mode');
  const grant = record(value.grant, 'authorization_decision.grant');
  const required = [
    'tenant_id', 'project_id', 'budget_scope_id', 'account_ref', 'project_ref', 'service', 'endpoint', 'model', 'sdk_name', 'sdk_version',
    'operation_kind', 'configuration_sha256', 'logical_operation_id', 'billable_attempt_id', 'maximum_amount',
    'currency', 'deadline_at', 'stop_conditions', 'max_billable_attempts', 'max_transport_attempts', 'expires_at', 'revoked',
  ];
  if (required.some((field) => !Object.hasOwn(grant, field))) fail('authorization_incomplete', 'Authorization omits a required binding.', 'authorization_decision.grant');
  if (!Object.hasOwn(value, 'checked_at')) fail('authorization_incomplete', 'Authorization must record a current trusted verification time.', 'authorization_decision.checked_at');
  for (const field of required) {
    if (field === 'stop_conditions' || field === 'expires_at' || field === 'revoked' || field === 'max_billable_attempts' || field === 'max_transport_attempts') continue;
    if (grant[field] !== expected[field]) {
      fail('authorization_scope_mismatch', 'Authorization does not match the exact scope, target, operation, or cap.', 'authorization_decision.grant');
    }
  }
  if (!Array.isArray(grant.stop_conditions)
    || canonicalHash([...grant.stop_conditions].sort()) !== canonicalHash(expected.stop_conditions)) {
    fail('authorization_scope_mismatch', 'Authorization stop conditions do not exactly match the request.', 'authorization_decision.grant.stop_conditions');
  }
  if (grant.max_billable_attempts !== 1 || grant.max_transport_attempts !== 1) fail('authorization_attempt_limit_mismatch', 'Authorization must allow at most one billable and transport attempt.', 'authorization_decision.grant');
  const expiresAt = datetime(grant.expires_at, 'authorization_decision.grant.expires_at');
  const deadlineAt = datetime(grant.deadline_at, 'authorization_decision.grant.deadline_at');
  if (grant.revoked !== false || Date.parse(expiresAt) <= Date.parse(now) || Date.parse(expiresAt) > Date.parse(deadlineAt)) {
    fail('authorization_expired_or_revoked', 'Authorization is expired, revoked, or exceeds its stop deadline.', 'authorization_decision.grant');
  }
  const grantEvidence = pinnedEvidence(value.evidence, 'authorization_decision.evidence');
  const protocolEvidence = pinnedEvidence(value.protocol, 'authorization_decision.protocol');
  const ownerEvidence = record(value.owner_evidence, 'authorization_decision.owner_evidence');
  const accountOwner = pinnedEvidence(ownerEvidence.account_owner, 'authorization_decision.owner_evidence.account_owner');
  const financeOwner = pinnedEvidence(ownerEvidence.finance_owner, 'authorization_decision.owner_evidence.finance_owner');
  if (ownerEvidence.account_owner_role !== 'Creative and fulfillment' || ownerEvidence.finance_owner_role !== 'Finance and reliability') {
    fail('authorization_owner_missing', 'Authorization must include the correct account and Finance owner evidence.', 'authorization_decision.owner_evidence');
  }
  const checkedAt = datetime(value.checked_at, 'authorization_decision.checked_at');
  if (Date.parse(checkedAt) > Date.parse(now)) fail('authorization_check_from_future', 'Authorization verification timestamp cannot be in the future.', 'authorization_decision.checked_at');
  if (Date.parse(now) - Date.parse(checkedAt) > MAX_CAPABILITY_AGE_MS) {
    fail('authorization_expired_or_revoked', 'Authorization verification is stale and must be refreshed.', 'authorization_decision.checked_at');
  }
  return {
    evidence: grantEvidence,
    protocol: protocolEvidence,
    account_owner: accountOwner,
    finance_owner: financeOwner,
    checked_at: checkedAt,
    expires_at: expiresAt,
  };
}

function validateReservationDecision(value, reservation, expected, mode, grantRef, authorizationEvidence, now) {
  record(value, 'reservation_verification');
  if (value.decision !== 'confirmed') fail(value.decision === 'denied' ? 'reservation_scope_denied' : 'reservation_scope_unknown', 'Finance did not confirm an exact bounded reservation.', 'reservation_verification.decision');
  if (value.evidence_mode !== mode) fail('reservation_evidence_mode_mismatch', 'Reservation evidence mode does not match the run.', 'reservation_verification.evidence_mode');
  const actual = record(value.binding, 'reservation_verification.binding');
  const fields = [
    'reservation_id', 'lease_id', 'grant_ref', 'authorization_evidence_sha256', 'billable_attempt_id', 'logical_operation_id', 'tenant_id', 'project_id', 'budget_scope_id',
    'account_ref', 'project_ref', 'service', 'endpoint', 'model', 'sdk_name', 'sdk_version', 'operation_kind', 'configuration_sha256',
    'maximum_amount', 'currency',
  ];
  const should = {
    reservation_id: reservation.reservation_id,
    lease_id: reservation.lease_id,
    grant_ref: grantRef,
    authorization_evidence_sha256: authorizationEvidence.sha256,
    billable_attempt_id: expected.billable_attempt_id,
    logical_operation_id: expected.logical_operation_id,
    tenant_id: expected.tenant_id,
    project_id: expected.project_id,
    budget_scope_id: expected.budget_scope_id,
    account_ref: expected.account_ref,
    project_ref: expected.project_ref,
    service: expected.service,
    endpoint: expected.endpoint,
    model: expected.model,
    sdk_name: expected.sdk_name,
    sdk_version: expected.sdk_version,
    operation_kind: expected.operation_kind,
    configuration_sha256: expected.configuration_sha256,
    maximum_amount: expected.maximum_amount,
    currency: expected.currency,
  };
  for (const field of fields) {
    if (actual[field] !== should[field]) fail('reservation_binding_mismatch', 'Finance reservation does not bind the exact authorization and attempt.', 'reservation_verification.binding');
  }
  id(reservation.reservation_id, 'reservation.reservation_id');
  if (reservation.billable_attempt_id !== expected.billable_attempt_id) fail('reservation_attempt_mismatch', 'Reservation belongs to a different billable attempt.', 'reservation.billable_attempt_id');
  if (!reservation.held_amount || reservation.held_amount.amount !== expected.maximum_amount || reservation.held_amount.currency !== expected.currency) {
    fail('reservation_cap_mismatch', 'Reserved hold does not equal the approved per-attempt cap.', 'reservation.held_amount');
  }
  id(reservation.lease_id, 'reservation.lease_id');
  const evidence = pinnedEvidence(value.evidence, 'reservation_verification.evidence');
  const protocol = pinnedEvidence(value.protocol, 'reservation_verification.protocol');
  const financeOwner = record(value.finance_owner, 'reservation_verification.finance_owner');
  if (financeOwner.owner_role !== 'Finance and reliability') {
    fail('reservation_scope_unknown', 'A separately verified Finance owner must accept the exact reservation protocol.', 'reservation_verification.finance_owner.owner_role');
  }
  const financeOwnerEvidence = pinnedEvidence(financeOwner.evidence, 'reservation_verification.finance_owner.evidence');
  if (!Object.hasOwn(value, 'checked_at') || !Object.hasOwn(value, 'lease_expires_at') || value.lease_active !== true) {
    fail('reservation_scope_unknown', 'Finance must verify a current reservation and active hold lease.', 'reservation_verification');
  }
  const checkedAt = datetime(value.checked_at, 'reservation_verification.checked_at');
  const leaseExpiresAt = datetime(value.lease_expires_at, 'reservation_verification.lease_expires_at');
  if (Date.parse(checkedAt) > Date.parse(now)
    || Date.parse(now) - Date.parse(checkedAt) > MAX_CAPABILITY_AGE_MS
    || Date.parse(leaseExpiresAt) <= Date.parse(now)) {
    fail('reservation_scope_unknown', 'Finance reservation or lease is not current.', 'reservation_verification');
  }
  const enforcement = record(value.enforcement, 'reservation_verification.enforcement');
  if (enforcement.atomic_one_use !== true || enforcement.aggregate_cap_enforced !== true
    || enforcement.lease_bound !== true || enforcement.full_target_bound !== true) {
    fail('reservation_scope_unknown', 'Finance verification must enforce one use, aggregate cap, exact target, and lease.', 'reservation_verification.enforcement');
  }
  return { evidence, protocol, finance_owner: financeOwnerEvidence, checked_at: checkedAt, lease_expires_at: leaseExpiresAt };
}

function validateAdapterDispatch(value, cell, mode) {
  record(value, 'adapter_dispatch');
  if (value.evidence_mode !== mode) fail('adapter_evidence_mode_mismatch', 'Provider adapter evidence mode does not match the run.', 'adapter_dispatch.evidence_mode');
  const evidence = record(value.evidence, 'adapter_dispatch.evidence');
  const allowed = new Set(['provider_request_ref', 'artifact_sha256', 'artifact_width', 'artifact_height', 'receipt_ref', 'completed_at', 'service', 'endpoint', 'model', 'sdk_name', 'sdk_version', 'configuration_sha256']);
  exactKeys(evidence, allowed, 'adapter_dispatch.evidence');
  const clean = {
    ...(evidence.provider_request_ref === undefined ? {} : { provider_request_ref: opaqueRef(evidence.provider_request_ref, 'adapter_dispatch.evidence.provider_request_ref') }),
    ...(evidence.artifact_sha256 === undefined ? {} : { artifact_sha256: sha256(evidence.artifact_sha256, 'adapter_dispatch.evidence.artifact_sha256') }),
    ...(evidence.artifact_width === undefined ? {} : { artifact_width: evidence.artifact_width }),
    ...(evidence.artifact_height === undefined ? {} : { artifact_height: evidence.artifact_height }),
    ...(evidence.receipt_ref === undefined ? {} : { receipt_ref: opaqueRef(evidence.receipt_ref, 'adapter_dispatch.evidence.receipt_ref') }),
    completed_at: datetime(evidence.completed_at, 'adapter_dispatch.evidence.completed_at'),
  };
  if (!sameText(evidence.service, cell.target.service) || !sameText(evidence.endpoint, cell.target.endpoint)
    || !sameText(evidence.model, cell.target.model) || !sameText(evidence.sdk_name, cell.target.sdk.name)
    || !sameText(evidence.sdk_version, cell.target.sdk.version) || !sameText(evidence.configuration_sha256, cell.target.configuration_sha256)) {
    fail('adapter_result_target_mismatch', 'Provider result does not match the pinned target.', 'adapter_dispatch.evidence');
  }
  if ((clean.artifact_width !== undefined && (!Number.isSafeInteger(clean.artifact_width) || clean.artifact_width < 1 || clean.artifact_width > 4096))
    || (clean.artifact_height !== undefined && (!Number.isSafeInteger(clean.artifact_height) || clean.artifact_height < 1 || clean.artifact_height > 4096))) {
    fail('provider_response_invalid', 'Artifact dimensions are invalid or outside the bounded preflight size.', 'adapter_dispatch.evidence');
  }
  if (mode === 'live' && ['image_generation', 'image_edit'].includes(cell.cell_id) && value.provider_outcome === 'succeeded'
    && (!clean.artifact_sha256 || clean.artifact_width !== 1024 || clean.artifact_height !== 1024)) {
    fail('provider_response_invalid', 'A successful live image result must include a decoded PNG digest and exact pinned dimensions.', 'adapter_dispatch.evidence');
  }
  return clean;
}

function freezeTree(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeTree(child);
  return Object.freeze(value);
}

function resultRow(cell, mode, status, reasonCode, ownerAction, fields = {}) {
  if (!STATUSES.has(status)) fail('invalid_result_status', 'Preflight result status is unsupported.', 'result.status');
  const runId = opaqueRef(fields.run_id ?? cell.run_id, 'result.run_id');
  const safeCode = SAFE_REASON_CODES.has(reasonCode) ? reasonCode : 'cell_preflight_failed';
  const targetBindingHash = cell.target?.sdk ? canonicalHash(expectedTargetBinding(cell)) : null;
  const row = {
    cell_id: cell.cell_id,
    owner_role: cell.owner_role,
    acceptance_ids: [...cell.acceptance_ids],
    mode,
    status,
    verified: status === 'verified',
    reason_code: safeCode,
    owner_action: ownerAction,
    selection_state: cell.selection?.state ?? 'unresolved',
    configuration_sha256: cell.target?.configuration_sha256 ?? null,
    target_binding_sha256: targetBindingHash,
    pin_evidence: fields.pin_evidence ?? null,
    capability_observation: fields.capability_observation ?? null,
    authorization_evidence: fields.authorization_evidence ?? null,
    reservation_evidence: fields.reservation_evidence ?? null,
    metering_status: fields.metering_status ?? 'not_started',
    provider_outcome: fields.provider_outcome ?? null,
    operation_evidence: fields.operation_evidence ?? null,
    financial_hold: fields.financial_hold ?? 'none',
  };
  Object.defineProperty(row, RESULT_BRAND, { value: true, enumerable: false });
  const frozen = freezeTree(row);
  RESULT_PROVENANCE.set(frozen, Object.freeze({
    run_id: runId,
    mode,
    cell_id: cell.cell_id,
    status,
    verified: status === 'verified',
    reason_code: safeCode,
    configuration_sha256: cell.target?.configuration_sha256 ?? null,
    target_binding_sha256: targetBindingHash,
  }));
  return frozen;
}

function safeFailureCode(error, fallback) {
  return error instanceof AccessPreflightError && SAFE_ERROR_CODES.has(error.code) ? error.code : fallback;
}

function sameAmount(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a === b;
}

async function releaseRejectedReservation(port, reservation, request) {
  const ref = {
    reservation_id: reservation.reservation_id,
    billable_attempt_id: request.billable_attempt_id,
    logical_operation_id: request.logical_operation_id,
    lease_id: reservation.lease_id,
  };
  try {
    const released = await port.releaseBeforeDispatch({ ...ref, reason: 'reservation_verification_rejected' });
    if (isRecord(released) && released.status === 'released_before_dispatch'
      && released.reservation_id === reservation.reservation_id
      && isRecord(released.released_amount)
      && sameAmount(released.released_amount.amount, reservation.held_amount?.amount)
      && released.released_amount.currency === reservation.held_amount?.currency) {
      return 'released';
    }
  } catch {
    // Safe result intentionally omits authority/provider error material.
  }
  try {
    await port.markOutcomeUnknown({ ...ref, reason: 'reservation_release_unconfirmed' });
  } catch {
    // The existing C03 contract keeps the uncertain hold external; diagnostics are omitted.
  }
  return 'retained_for_reconciliation';
}

/**
 * Execute one independently authorized cell. A fixture run follows the same
 * state transitions but its result can only be `simulated`; fake ports cannot
 * produce a live verification row.
 */
export async function executeAuthorizedAccessCell(args) {
  record(args, 'args');
  const mode = args.mode;
  if (!REPORT_MODES.has(mode)) fail('invalid_mode', 'Mode must be mock or live.', 'args.mode');
  const runId = opaqueRef(args.runId, 'args.runId');
  const trustedScope = record(args.trustedScope, 'trustedScope');
  const now = mode === 'live'
    ? new Date().toISOString()
    : typeof args.now === 'function' ? args.now() : args.now;
  const nowIso = datetime(now, 'args.now');
  const rawCell = record(args.cell, 'cell');
  const expected = definition(rawCell.cell_id);
  if (!expected) fail('unknown_cell', 'Unknown access cell.', 'args.cell.cell_id');
  let cell;
  try {
    cell = validateCell(rawCell, expected);
  } catch (error) {
    return resultRow({
      cell_id: expected.cell_id,
      owner_role: expected.owner_role,
      acceptance_ids: [...expected.acceptance_ids],
      selection: { state: 'unresolved' },
      target: null,
      run_id: runId,
    }, mode, 'blocked', safeFailureCode(error, 'invalid_cell'), 'Correct the invalid preflight cell.');
  }
  cell = freezeTree({ ...cell, run_id: runId });
  for (const field of ['tenant_id', 'project_id', 'budget_scope_id']) {
    if (cell.scope[field] !== trustedScope[field]) {
      return resultRow(cell, mode, 'denied', 'trusted_scope_mismatch', 'Use authenticated tenant, project, and budget context.');
    }
  }
  if (typeof trustedScope.account_ref !== 'string' || typeof trustedScope.project_ref !== 'string'
    || cell.scope.account_ref !== trustedScope.account_ref || cell.scope.project_ref !== trustedScope.project_ref) {
    return resultRow(cell, mode, 'denied', 'trusted_account_scope_missing', 'Use the account and project references supplied by authenticated server context.');
  }
  if (cell.input_status === 'invalid') return resultRow(cell, mode, 'blocked', cell.input_error_code ?? 'invalid_cell', 'Correct the invalid preflight cell.');
  if (cell.selection.state !== 'owner_selected' || !cell.target) {
    return resultRow(cell, mode, 'blocked', 'pin_unresolved', 'Owner must select and pin the exact dependency and configuration.');
  }
  if (expected.billable === null) {
    return resultRow(cell, mode, 'blocked', 'metering_operation_unpublished', 'Finance must publish an accepted metering operation and access adapter for this trace action.');
  }
  const adapter = dependencyObject(args.adapter, 'args.adapter');
  const pinVerifier = dependencyObject(args.pinVerifier, 'args.pinVerifier');
  const capabilityVerifier = args.capabilityVerifier === undefined ? {} : dependencyObject(args.capabilityVerifier, 'args.capabilityVerifier');
  const authorizationPort = dependencyObject(args.authorizationPort, 'args.authorizationPort');
  const reservationVerifier = dependencyObject(args.reservationVerifier, 'args.reservationVerifier');
  const meteringPort = dependencyObject(args.meteringPort, 'args.meteringPort');
  const meterRequest = record(args.meteringRequest, 'args.meteringRequest');
  if (mode === 'mock') {
    const mockPorts = [adapter, pinVerifier, capabilityVerifier, authorizationPort, reservationVerifier, meteringPort];
    if (mockPorts.some((port) => port.evidence_mode !== 'mock')) {
      return resultRow(cell, mode, 'blocked', 'mock_requires_fixture_ports', 'Use only explicitly labeled fixture ports for a mock run.');
    }
  } else {
    const livePorts = [adapter, pinVerifier, capabilityVerifier, authorizationPort, reservationVerifier, meteringPort];
    if (livePorts.some((port) => port.evidence_mode !== 'live')) {
      return resultRow(cell, mode, 'blocked', 'live_adapter_unavailable', 'Integrate trusted live adapters and external owner protocols before a live check.');
    }
  }
  if (typeof pinVerifier.verifyPin !== 'function' || typeof adapter.inspect !== 'function' || typeof adapter.dispatch !== 'function'
    || typeof capabilityVerifier.verifyCapability !== 'function' || typeof capabilityVerifier.revalidateCapability !== 'function'
    || typeof authorizationPort.verifyGrant !== 'function' || typeof authorizationPort.revalidateGrant !== 'function'
    || typeof reservationVerifier.verifyReservation !== 'function') {
    return resultRow(cell, mode, 'blocked', 'required_adapter_method_missing', 'Provide the declared owner, access, Finance, and provider adapter methods.');
  }
  let pinEvidence;
  try {
    const decision = await pinVerifier.verifyPin({ cell_id: cell.cell_id, owner_role: cell.owner_role, target: cell.target });
    pinEvidence = validatePinDecision(decision, cell, mode, mode === 'live' ? new Date().toISOString() : nowIso);
  } catch (error) {
    return resultRow(cell, mode, 'blocked', safeFailureCode(error, 'pin_verification_unavailable'), 'Obtain independently verified owner acceptance for the exact pinned configuration.');
  }
  let accessObservation;
  try {
    const observation = await adapter.inspect({ run_id: args.runId, cell_id: cell.cell_id, target: cell.target, scope: cell.scope });
    accessObservation = validateAccessObservation(observation, cell, mode, mode === 'live' ? new Date().toISOString() : nowIso);
  } catch (error) {
    return resultRow(cell, mode, 'unknown', safeFailureCode(error, 'access_probe_unavailable'), 'Resolve the non-secret access or quota observation with the provider owner.', { pin_evidence: pinEvidence.evidence });
  }
  let capabilityProof;
  try {
    const checkedAt = mode === 'live' ? new Date().toISOString() : nowIso;
    const decision = await capabilityVerifier.verifyCapability({
      run_id: runId,
      ...capabilityBinding(cell),
      scope: cell.scope,
      at: checkedAt,
    });
    const receivedAt = mode === 'live' ? new Date().toISOString() : nowIso;
    capabilityProof = validateCapabilityDecision(decision, cell, mode, receivedAt, cell.spend.deadline_at);
    accessObservation = {
      ...accessObservation,
      operation_permission: capabilityProof.operation_permission,
      quota: capabilityProof.quota,
      capability_verification: capabilityProof,
    };
  } catch (error) {
    return resultRow(cell, mode, 'unknown', safeFailureCode(error, 'capability_verification_unavailable'), 'The accountable provider owner must supply independently verified permission and quota evidence for this exact target.', { pin_evidence: pinEvidence.evidence, capability_observation: accessObservation });
  }
  if (accessObservation.authentication !== 'confirmed') {
    const status = accessObservation.authentication === 'denied' ? 'denied' : 'unknown';
    return resultRow(cell, mode, status, `authentication_${accessObservation.authentication}`, 'Provider owner must resolve account authentication; do not retry automatically.', { pin_evidence: pinEvidence.evidence, capability_observation: accessObservation });
  }
  if (accessObservation.operation_permission === 'denied') {
    return resultRow(cell, mode, 'denied', 'operation_permission_denied', 'Provider owner must grant the exact operation; do not substitute another endpoint or model.', { pin_evidence: pinEvidence.evidence, capability_observation: accessObservation });
  }
  if (accessObservation.operation_permission !== 'confirmed') {
    return resultRow(cell, mode, 'unknown', 'operation_permission_unknown', 'Provider owner must independently confirm permission for the exact operation before any authorization or reservation.', { pin_evidence: pinEvidence.evidence, capability_observation: accessObservation });
  }
  if (cell.target.model && accessObservation.model_listing !== 'listed') {
    const status = accessObservation.model_listing === 'not_listed' ? 'denied' : 'unknown';
    return resultRow(cell, mode, status, `model_${accessObservation.model_listing}`, 'Provider owner must verify the exact pinned model; a model list alone is not operation evidence.', { pin_evidence: pinEvidence.evidence, capability_observation: accessObservation });
  }
  if (accessObservation.quota === 'denied') {
    return resultRow(cell, mode, 'denied', 'quota_denied', 'Finance/provider owner must resolve quota without substituting a model.', { pin_evidence: pinEvidence.evidence, capability_observation: accessObservation });
  }
  if (accessObservation.quota !== 'available') {
    return resultRow(cell, mode, 'unknown', 'quota_unknown', 'Provider and Finance owners must confirm current quota for this exact target before authorization or reservation.', { pin_evidence: pinEvidence.evidence, capability_observation: accessObservation });
  }

  let validatedMeterRequest;
  try {
    validatedMeterRequest = validateMeteredAttempt(meterRequest, trustedScope);
  } catch {
    return resultRow(cell, mode, 'blocked', 'metering_request_invalid', 'Supply a valid C03 request under authenticated scope.', { pin_evidence: pinEvidence.evidence, capability_observation: accessObservation });
  }
  const providerPin = cell.target;
  if (validatedMeterRequest.operation_kind !== cell.operation_kind
    || validatedMeterRequest.provider.name !== providerPin.service
    || validatedMeterRequest.provider.endpoint !== providerPin.endpoint
    || validatedMeterRequest.provider.model !== providerPin.model
    || validatedMeterRequest.provider.sdk.name !== providerPin.sdk.name
    || validatedMeterRequest.provider.sdk.version !== providerPin.sdk.version
    || validatedMeterRequest.environment !== 'test'
    || validatedMeterRequest.billing_mode !== 'live') {
    return resultRow(cell, mode, 'blocked', 'metering_target_mismatch', 'Bind the C03 request to this exact pinned test operation and live billing mode.', { pin_evidence: pinEvidence.evidence, capability_observation: accessObservation });
  }
  try {
    opaqueRef(args.grantRef, 'args.grantRef');
  } catch {
    return resultRow(cell, mode, 'denied', 'authorization_reference_missing', 'Obtain an externally issued authorization reference for this exact operation.', { pin_evidence: pinEvidence.evidence, capability_observation: accessObservation });
  }
  const grantRequestAt = mode === 'live' ? new Date().toISOString() : nowIso;
  const expectedGrant = freezeTree(buildExpectedGrant(cell, validatedMeterRequest, grantRequestAt));
  let grantEvidence;
  let grant;
  try {
    const decision = await authorizationPort.verifyGrant({ grant_ref: args.grantRef, expected: expectedGrant, at: grantRequestAt });
    if (!isRecord(decision) || decision.grant_ref !== args.grantRef) fail('authorization_reference_mismatch', 'Authorization verifier returned evidence for a different grant reference.', 'authorization_decision.grant_ref');
    const receivedAt = mode === 'live' ? new Date().toISOString() : nowIso;
    grantEvidence = validateGrant(decision, expectedGrant, mode, receivedAt);
    grant = decision.grant;
  } catch (error) {
    return resultRow(cell, mode, 'denied', safeFailureCode(error, 'authorization_verification_failed'), 'Obtain a trusted, current grant for this exact account, project, operation, model, cap, deadline, and stop policy.', { pin_evidence: pinEvidence.evidence, capability_observation: accessObservation });
  }
  const grantAcceptedAt = mode === 'live' ? new Date().toISOString() : nowIso;
  if (Date.parse(grantAcceptedAt) >= Date.parse(cell.spend.deadline_at)
    || Date.parse(grant.expires_at) <= Date.parse(grantAcceptedAt)) {
    return resultRow(cell, mode, 'denied', 'preflight_deadline_passed', 'Request a new owner-approved deadline before another attempt.', { pin_evidence: pinEvidence.evidence, capability_observation: accessObservation, authorization_evidence: grantEvidence.evidence });
  }

  let preparedInput;
  if (adapter.prepare !== undefined) {
    if (typeof adapter.prepare !== 'function') {
      return resultRow(cell, mode, 'blocked', 'required_adapter_method_missing', 'Provide a valid local payload preparation method.', { pin_evidence: pinEvidence.evidence, capability_observation: accessObservation, authorization_evidence: grantEvidence.evidence });
    }
    try {
      preparedInput = await adapter.prepare({
        run_id: runId,
        cell_id: cell.cell_id,
        target: cell.target,
        configuration: cell.target.configuration,
        scope: cell.scope,
        grant_ref: args.grantRef,
        deadline_at: cell.spend.deadline_at,
        authorization_evidence: grantEvidence.evidence,
      });
    } catch (error) {
      return resultRow(cell, mode, 'failed', safeFailureCode(error, 'adapter_unavailable'), 'Resolve the local prompt, asset, and exact scoped credential before requesting a reservation.', { pin_evidence: pinEvidence.evidence, capability_observation: accessObservation, authorization_evidence: grantEvidence.evidence });
    }
  }

  let reservationVerification;
  let reservationForDispatch;
  let reservationHold = 'none';
  let reservationRejectCode = null;
  let dispatchRejectCode = null;
  let dispatchEvidence = null;
  let providerOutcome = null;
  const checkedMeteringPort = {
    reserveAttempt: async (attempt) => {
      const reservation = await meteringPort.reserveAttempt(attempt);
      if (!isRecord(reservation) || reservation.status !== 'reserved') return reservation;
      try {
        const verificationAt = new Date().toISOString();
        const verified = await reservationVerifier.verifyReservation({
          reservation: structuredClone(reservation),
          attempt: structuredClone(attempt),
          expected: expectedGrant,
          grant_ref: args.grantRef,
          authorization_evidence: grantEvidence.evidence,
          at: verificationAt,
        });
        const verificationReceivedAt = new Date().toISOString();
        reservationVerification = validateReservationDecision(verified, reservation, expectedGrant, mode, args.grantRef, grantEvidence.evidence, verificationReceivedAt);
        reservationForDispatch = structuredClone(reservation);
        return reservation;
      } catch (error) {
        reservationRejectCode = safeFailureCode(error, 'reservation_scope_unknown');
        reservationHold = await releaseRejectedReservation(meteringPort, reservation, attempt);
        return { status: 'denied' };
      }
    },
    releaseBeforeDispatch: (...values) => meteringPort.releaseBeforeDispatch(...values),
    markAttemptInFlight: (...values) => meteringPort.markAttemptInFlight(...values),
    recordTransportAttempt: (...values) => meteringPort.recordTransportAttempt(...values),
    recordUsageObservation: (...values) => meteringPort.recordUsageObservation(...values),
    settleReservation: (...values) => meteringPort.settleReservation(...values),
    markOutcomeUnknown: (...values) => meteringPort.markOutcomeUnknown(...values),
  };

  let meterOutcome;
  try {
    const deadlineAt = Date.parse(cell.spend.deadline_at);
    const remaining = deadlineAt - Date.now();
    if (args.signal !== undefined && !(args.signal instanceof AbortSignal)) {
      fail('invalid_abort_signal', 'An operation signal must be a native AbortSignal.', 'args.signal');
    }
    const deadlineSignal = remaining <= 0
      ? AbortSignal.abort()
      : AbortSignal.timeout(Math.min(Math.ceil(remaining), 2_147_483_647));
    const operationSignal = args.signal ? AbortSignal.any([args.signal, deadlineSignal]) : deadlineSignal;
    meterOutcome = await executeMeteredAttempt({
      port: checkedMeteringPort,
      request: validatedMeterRequest,
      trustedScope,
      signal: operationSignal,
      dispatch: async (context) => {
        const reservationCheckAt = new Date().toISOString();
        try {
          if (!reservationForDispatch || !reservationVerification) {
            fail('reservation_scope_unknown', 'Finance reservation is unavailable at dispatch.', 'reservation_verification');
          }
          const latestReservation = await reservationVerifier.verifyReservation({
            reservation: structuredClone(reservationForDispatch),
            attempt: structuredClone(validatedMeterRequest),
            expected: expectedGrant,
            grant_ref: args.grantRef,
            authorization_evidence: grantEvidence.evidence,
            at: reservationCheckAt,
          });
          const reservationReceivedAt = new Date().toISOString();
          const latestProof = validateReservationDecision(
            latestReservation,
            reservationForDispatch,
            expectedGrant,
            mode,
            args.grantRef,
            grantEvidence.evidence,
            reservationReceivedAt,
          );
          if (latestProof.protocol.sha256 !== reservationVerification.protocol.sha256
            || latestProof.finance_owner.sha256 !== reservationVerification.finance_owner.sha256) {
            fail('reservation_scope_unknown', 'Finance reservation protocol or owner changed before transport.', 'reservation_verification');
          }
          reservationVerification = latestProof;
        } catch {
          dispatchRejectCode = 'reservation_scope_unknown';
          throw new AccessPreflightError('reservation_scope_unknown', 'Finance reservation lease was not current at dispatch.');
        }
        const afterReservationAt = new Date().toISOString();
        if (context.signal?.aborted || Date.parse(cell.spend.deadline_at) <= Date.parse(afterReservationAt)) {
          dispatchRejectCode = 'preflight_deadline_passed';
          throw new AccessPreflightError('preflight_deadline_passed', 'Cancellation or the approved deadline stopped dispatch.');
        }

        const capabilityCheckAt = new Date().toISOString();
        let capabilityCurrent;
        try {
          const decision = await capabilityVerifier.revalidateCapability({
            run_id: runId,
            ...capabilityBinding(cell),
            scope: cell.scope,
            previous_evidence: capabilityProof.evidence,
            at: capabilityCheckAt,
          });
          const capabilityReceivedAt = new Date().toISOString();
          capabilityCurrent = validateCapabilityDecision(decision, cell, mode, capabilityReceivedAt, cell.spend.deadline_at);
        } catch {
          dispatchRejectCode = 'capability_revoked_before_dispatch';
          throw new AccessPreflightError('capability_revoked_before_dispatch', 'Capability was not current at dispatch.');
        }
        const afterCapabilityAt = new Date().toISOString();
        if (context.signal?.aborted || Date.parse(cell.spend.deadline_at) <= Date.parse(afterCapabilityAt)) {
          dispatchRejectCode = 'preflight_deadline_passed';
          throw new AccessPreflightError('preflight_deadline_passed', 'Cancellation or the approved deadline stopped dispatch.');
        }
        if (capabilityCurrent.decision !== 'confirmed' || capabilityCurrent.operation_permission !== 'confirmed'
          || capabilityCurrent.quota !== 'available' || capabilityCurrent.protocol.sha256 !== capabilityProof.protocol.sha256) {
          dispatchRejectCode = 'capability_revoked_before_dispatch';
          throw new AccessPreflightError('capability_revoked_before_dispatch', 'Capability was not current at dispatch.');
        }
        capabilityProof = capabilityCurrent;
        accessObservation = {
          ...accessObservation,
          operation_permission: capabilityProof.operation_permission,
          quota: capabilityProof.quota,
          capability_verification: capabilityProof,
        };
        let authorizationCurrent;
        const recheckAt = new Date().toISOString();
        try {
          authorizationCurrent = await authorizationPort.revalidateGrant({
            grant_ref: args.grantRef,
            expected: expectedGrant,
            authorization_evidence: grantEvidence.evidence,
            at: recheckAt,
          });
        } catch {
          authorizationCurrent = null;
        }
        const authorizationReceivedAt = new Date().toISOString();
        let currentProof;
        try {
          if (!isRecord(authorizationCurrent) || authorizationCurrent.grant_ref !== args.grantRef) {
            fail('authorization_reference_mismatch', 'Current authorization evidence does not match the grant reference.', 'authorization_decision.grant_ref');
          }
          currentProof = validateGrant(authorizationCurrent, freezeTree({ ...expectedGrant, now: recheckAt }), mode, authorizationReceivedAt);
        } catch {
          currentProof = null;
        }
        if (!currentProof || currentProof.expires_at !== grant.expires_at
          || currentProof.evidence.sha256 !== grantEvidence.evidence.sha256
          || currentProof.protocol.sha256 !== grantEvidence.protocol.sha256
          || currentProof.account_owner.sha256 !== grantEvidence.account_owner.sha256
          || currentProof.finance_owner.sha256 !== grantEvidence.finance_owner.sha256
          || Date.parse(cell.spend.deadline_at) <= Date.parse(authorizationReceivedAt)) {
          dispatchRejectCode = 'authorization_revoked_before_dispatch';
          throw new AccessPreflightError('authorization_revoked_before_dispatch', 'Authorization was not current at dispatch.');
        }
        const transportBoundaryAt = new Date().toISOString();
        if (context.signal?.aborted || Date.parse(cell.spend.deadline_at) <= Date.parse(transportBoundaryAt)) {
          dispatchRejectCode = 'preflight_deadline_passed';
          throw new AccessPreflightError('preflight_deadline_passed', 'Cancellation or the approved deadline stopped dispatch.');
        }
        if (Date.parse(capabilityProof.expires_at) <= Date.parse(transportBoundaryAt)
          || Date.parse(transportBoundaryAt) - Date.parse(capabilityProof.checked_at) > MAX_CAPABILITY_AGE_MS) {
          dispatchRejectCode = 'capability_revoked_before_dispatch';
          throw new AccessPreflightError('capability_revoked_before_dispatch', 'Capability evidence expired before transport.');
        }
        if (Date.parse(currentProof.expires_at) <= Date.parse(transportBoundaryAt)
          || Date.parse(transportBoundaryAt) - Date.parse(currentProof.checked_at) > MAX_CAPABILITY_AGE_MS) {
          dispatchRejectCode = 'authorization_revoked_before_dispatch';
          throw new AccessPreflightError('authorization_revoked_before_dispatch', 'Authorization expired before transport.');
        }
        if (Date.parse(reservationVerification.lease_expires_at) <= Date.parse(transportBoundaryAt)
          || Date.parse(transportBoundaryAt) - Date.parse(reservationVerification.checked_at) > MAX_CAPABILITY_AGE_MS) {
          dispatchRejectCode = 'reservation_scope_unknown';
          throw new AccessPreflightError('reservation_scope_unknown', 'Finance reservation lease expired before transport.');
        }
        let transportCount = 0;
        let transportAckState = 'not_started';
        let transportFenceCount = 0;
        let transportAssertionCount = 0;
        let transportFenceState = 'not_started';
        const boundedContext = {
          ...context,
          recordTransportAttempt: (transportAttemptId) => {
            transportCount += 1;
            if (transportCount !== 1 || transportAckState !== 'not_started' || transportFenceState !== 'not_started') {
              transportAckState = 'failed';
              transportFenceState = 'failed';
              dispatchRejectCode = 'transport_attempt_limit_exceeded';
              fail('transport_attempt_limit_exceeded', 'The approved preflight allows one transport attempt.', 'metering.recordTransportAttempt');
            }
            transportAckState = 'pending';
            let acknowledgement;
            try {
              acknowledgement = context.recordTransportAttempt(transportAttemptId);
            } catch {
              acknowledgement = Promise.reject(new Error('Finance transport acknowledgement failed.'));
            }
            const trackedAcknowledgement = Promise.resolve(acknowledgement).then(
              (result) => {
                if (transportAckState !== 'pending' || transportFenceState !== 'not_started') {
                  transportAckState = 'failed';
                  transportFenceState = 'failed';
                  dispatchRejectCode = 'transport_authorization_fence_missing';
                  throw new AccessPreflightError('transport_authorization_fence_missing', 'Finance transport acknowledgement completed after the dispatch fence was already poisoned.');
                }
                transportAckState = 'completed';
                return result;
              },
              () => {
                transportAckState = 'failed';
                transportFenceState = 'failed';
                dispatchRejectCode = 'metering_or_dispatch_unknown';
                throw new AccessPreflightError('metering_or_dispatch_unknown', 'Finance did not acknowledge the transport identity.');
              },
            );
            // The tracked promise is also observed here so an adapter that starts
            // the acknowledgement without awaiting it cannot leak an unhandled
            // rejection or turn its eventual outcome into a successful fence.
            trackedAcknowledgement.catch(() => {});
            return trackedAcknowledgement;
          },
          authorizeTransport: async () => {
            transportFenceCount += 1;
            if (transportFenceCount !== 1 || transportCount !== 1 || transportAckState !== 'completed' || transportFenceState !== 'not_started') {
              transportAckState = 'failed';
              transportFenceState = 'failed';
              dispatchRejectCode = 'transport_authorization_fence_missing';
              throw new AccessPreflightError('transport_authorization_fence_missing', 'Transport authorization must follow the completed Finance acknowledgement for its one transport identity.');
            }
            transportFenceState = 'pending';
            try {
              const fenceReservationAt = new Date().toISOString();
              try {
                const currentReservation = await reservationVerifier.verifyReservation({
                  reservation: structuredClone(reservationForDispatch),
                  attempt: structuredClone(validatedMeterRequest),
                  expected: expectedGrant,
                  grant_ref: args.grantRef,
                  authorization_evidence: grantEvidence.evidence,
                  at: fenceReservationAt,
                });
                const receivedAt = new Date().toISOString();
                const proof = validateReservationDecision(
                  currentReservation,
                  reservationForDispatch,
                  expectedGrant,
                  mode,
                  args.grantRef,
                  grantEvidence.evidence,
                  receivedAt,
                );
                if (proof.protocol.sha256 !== reservationVerification.protocol.sha256
                  || proof.finance_owner.sha256 !== reservationVerification.finance_owner.sha256) {
                  fail('reservation_scope_unknown', 'Finance reservation protocol or owner changed at transport authorization.', 'reservation_verification');
                }
                reservationVerification = proof;
              } catch {
                dispatchRejectCode = 'reservation_scope_unknown';
                throw new AccessPreflightError('reservation_scope_unknown', 'Finance reservation lease was not current after the transport identity was acknowledged.');
              }

              const fenceCapabilityAt = new Date().toISOString();
              try {
                const currentCapability = await capabilityVerifier.revalidateCapability({
                  run_id: runId,
                  ...capabilityBinding(cell),
                  scope: cell.scope,
                  previous_evidence: capabilityProof.evidence,
                  at: fenceCapabilityAt,
                });
                const receivedAt = new Date().toISOString();
                const proof = validateCapabilityDecision(currentCapability, cell, mode, receivedAt, cell.spend.deadline_at);
                if (proof.decision !== 'confirmed' || proof.operation_permission !== 'confirmed' || proof.quota !== 'available'
                  || proof.protocol.sha256 !== capabilityProof.protocol.sha256
                  || proof.owner_evidence.sha256 !== capabilityProof.owner_evidence.sha256) {
                  fail('capability_revoked_before_dispatch', 'Provider capability changed at transport authorization.', 'capability_decision');
                }
                capabilityProof = proof;
                accessObservation = {
                  ...accessObservation,
                  operation_permission: proof.operation_permission,
                  quota: proof.quota,
                  capability_verification: proof,
                };
              } catch {
                dispatchRejectCode = 'capability_revoked_before_dispatch';
                throw new AccessPreflightError('capability_revoked_before_dispatch', 'Provider capability was not current after the transport identity was acknowledged.');
              }

              const fenceGrantAt = new Date().toISOString();
              let grantDecision;
              try {
                grantDecision = await authorizationPort.revalidateGrant({
                  grant_ref: args.grantRef,
                  expected: expectedGrant,
                  authorization_evidence: grantEvidence.evidence,
                  at: fenceGrantAt,
                });
              } catch {
                grantDecision = null;
              }
              const grantReceivedAt = new Date().toISOString();
              let latestGrantProof;
              try {
                if (!isRecord(grantDecision) || grantDecision.grant_ref !== args.grantRef) {
                  fail('authorization_reference_mismatch', 'Current authorization evidence does not match the grant reference.', 'authorization_decision.grant_ref');
                }
                latestGrantProof = validateGrant(grantDecision, freezeTree({ ...expectedGrant, now: fenceGrantAt }), mode, grantReceivedAt);
              } catch {
                latestGrantProof = null;
              }
              if (!latestGrantProof || latestGrantProof.expires_at !== currentProof.expires_at
                || latestGrantProof.evidence.sha256 !== currentProof.evidence.sha256
                || latestGrantProof.protocol.sha256 !== currentProof.protocol.sha256
                || latestGrantProof.account_owner.sha256 !== currentProof.account_owner.sha256
                || latestGrantProof.finance_owner.sha256 !== currentProof.finance_owner.sha256) {
                dispatchRejectCode = 'authorization_revoked_before_dispatch';
                throw new AccessPreflightError('authorization_revoked_before_dispatch', 'Authorization was not current after the transport identity was acknowledged.');
              }
              currentProof = latestGrantProof;
              if (transportFenceState !== 'pending') {
                dispatchRejectCode = 'transport_authorization_fence_missing';
                fail('transport_authorization_fence_missing', 'Transport authorization did not remain pending through validation.', 'metering.authorizeTransport');
              }
              transportFenceState = 'authorized';
            } catch (error) {
              transportFenceState = 'failed';
              throw error;
            }
          },
          assertTransportReady: () => {
            transportAssertionCount += 1;
            if (transportAssertionCount !== 1 || transportFenceCount !== 1 || transportCount !== 1
              || transportAckState !== 'completed' || transportFenceState !== 'authorized') {
              transportAckState = 'failed';
              transportFenceState = 'failed';
              dispatchRejectCode = 'transport_authorization_fence_missing';
              throw new AccessPreflightError('transport_authorization_fence_missing', 'A single final transport authorization fence is required.');
            }
            transportFenceState = 'asserted';
            const at = new Date().toISOString();
            if (context.signal?.aborted || Date.parse(cell.spend.deadline_at) <= Date.parse(at)) {
              transportFenceState = 'failed';
              dispatchRejectCode = 'preflight_deadline_passed';
              throw new AccessPreflightError('preflight_deadline_passed', 'Cancellation or the approved deadline stopped transport.');
            }
            if (Date.parse(capabilityProof.expires_at) <= Date.parse(at)
              || Date.parse(at) < Date.parse(capabilityProof.checked_at)
              || Date.parse(at) - Date.parse(capabilityProof.checked_at) > MAX_CAPABILITY_AGE_MS) {
              transportFenceState = 'failed';
              dispatchRejectCode = 'capability_revoked_before_dispatch';
              throw new AccessPreflightError('capability_revoked_before_dispatch', 'Capability evidence is no longer current at transport.');
            }
            if (Date.parse(currentProof.expires_at) <= Date.parse(at)
              || Date.parse(at) < Date.parse(currentProof.checked_at)
              || Date.parse(at) - Date.parse(currentProof.checked_at) > MAX_CAPABILITY_AGE_MS) {
              transportFenceState = 'failed';
              dispatchRejectCode = 'authorization_revoked_before_dispatch';
              throw new AccessPreflightError('authorization_revoked_before_dispatch', 'Authorization is no longer current at transport.');
            }
            if (Date.parse(reservationVerification.lease_expires_at) <= Date.parse(at)
              || Date.parse(at) < Date.parse(reservationVerification.checked_at)
              || Date.parse(at) - Date.parse(reservationVerification.checked_at) > MAX_CAPABILITY_AGE_MS) {
              transportFenceState = 'failed';
              dispatchRejectCode = 'reservation_scope_unknown';
              throw new AccessPreflightError('reservation_scope_unknown', 'Finance reservation lease is no longer current at transport.');
            }
          },
        };
        const providerResult = await adapter.dispatch({
          run_id: runId,
          cell_id: cell.cell_id,
          target: cell.target,
          configuration: cell.target.configuration,
          scope: cell.scope,
          grant_ref: args.grantRef,
          prepared: preparedInput,
          deadline_at: cell.spend.deadline_at,
          authorization_evidence: grantEvidence.evidence,
          metering: boundedContext,
        });
        if (transportCount !== 1) fail('transport_attempt_limit_exceeded', 'The approved adapter must report exactly one transport attempt.', 'metering.recordTransportAttempt');
        if (transportAckState !== 'completed' || transportFenceCount !== 1 || transportAssertionCount !== 1 || transportFenceState !== 'asserted') {
          dispatchRejectCode ??= 'transport_authorization_fence_missing';
          fail('transport_authorization_fence_missing', 'The approved adapter must complete and assert authority immediately before transport.', 'metering.authorizeTransport');
        }
        const cleanEvidence = validateAdapterDispatch(providerResult, cell, mode);
        if (!['succeeded', 'failed', 'partial', 'unknown'].includes(providerResult.provider_outcome)) {
          fail('provider_outcome_invalid', 'Provider adapter returned an unsupported outcome.', 'adapter_dispatch.provider_outcome');
        }
        dispatchEvidence = cleanEvidence;
        providerOutcome = providerResult.provider_outcome;
        return {
          provider_outcome: providerResult.provider_outcome,
          ...(providerResult.usage_observation === undefined ? {} : { usage_observation: providerResult.usage_observation }),
        };
      },
    });
  } catch (error) {
    return resultRow(cell, mode, 'unknown', safeFailureCode(error, 'metering_or_dispatch_unknown'), 'Finance must reconcile the attempt before another action.', {
      capability_observation: accessObservation,
      pin_evidence: pinEvidence.evidence,
      authorization_evidence: grantEvidence.evidence,
      reservation_evidence: reservationVerification ?? null,
      metering_status: 'authority_error',
      financial_hold: 'retained_for_reconciliation',
    });
  }

  const meteringStatus = meterOutcome.status;
  if (meterOutcome.status === 'reservation_denied') {
    const reasonCode = reservationRejectCode ?? 'budget_reservation_denied';
    const hold = reservationHold === 'retained_for_reconciliation'
      ? reservationHold
      : reservationHold === 'released' ? 'released_before_dispatch' : 'none';
    return resultRow(cell, mode, 'denied', reasonCode, 'Finance must confirm a reservation matching the trusted grant before dispatch.', {
      capability_observation: accessObservation,
      pin_evidence: pinEvidence.evidence,
      authorization_evidence: grantEvidence.evidence,
      reservation_evidence: reservationVerification,
      metering_status: meteringStatus,
      financial_hold: hold,
    });
  }
  if (meterOutcome.status !== 'settled') {
    const notStarted = meterOutcome.status === 'cancelled_before_reservation';
    const status = notStarted ? 'failed' : 'unknown';
    return resultRow(cell, mode, status, reservationRejectCode ?? dispatchRejectCode ?? meterOutcome.error_code ?? meterOutcome.status, 'Resolve the provider result and financial hold before retrying.', {
      capability_observation: accessObservation,
      pin_evidence: pinEvidence.evidence,
      authorization_evidence: grantEvidence.evidence,
      reservation_evidence: reservationVerification,
      metering_status: meteringStatus,
      provider_outcome: providerOutcome,
      operation_evidence: dispatchEvidence,
      financial_hold: meterOutcome.hold === 'retained_for_reconciliation' || reservationHold === 'retained_for_reconciliation'
        ? 'retained_for_reconciliation'
        : reservationHold === 'released' ? 'released_before_dispatch'
          : meterOutcome.status === 'reservation_unavailable' ? 'reservation_outcome_unknown'
            : notStarted ? 'none' : 'retained_for_reconciliation',
    });
  }
  if (meterOutcome.provider_outcome !== 'succeeded') {
    return resultRow(cell, mode, 'failed', 'provider_operation_failed', 'Provider owner must review the safe failure evidence; no automatic retry is permitted.', {
      capability_observation: accessObservation,
      pin_evidence: pinEvidence.evidence,
      authorization_evidence: grantEvidence.evidence,
      reservation_evidence: reservationVerification,
      metering_status: meteringStatus,
      provider_outcome: meterOutcome.provider_outcome,
      operation_evidence: dispatchEvidence,
      financial_hold: 'settled',
    });
  }
  if (mode === 'mock') {
    return resultRow(cell, mode, 'simulated', 'fixture_boundary_only', 'Run a separately authorized live check with real owner and provider adapters.', {
      capability_observation: accessObservation,
      pin_evidence: pinEvidence.evidence,
      authorization_evidence: grantEvidence.evidence,
      reservation_evidence: reservationVerification,
      metering_status: meteringStatus,
      provider_outcome: meterOutcome.provider_outcome,
      operation_evidence: dispatchEvidence,
      financial_hold: 'fixture_settled',
    });
  }
  return resultRow(cell, mode, 'verified', 'live_operation_and_reconciliation_confirmed', 'Retain the sanitized evidence with the pinned revisions and owner approvals.', {
    capability_observation: accessObservation,
      pin_evidence: pinEvidence.evidence,
    authorization_evidence: grantEvidence.evidence,
    reservation_evidence: reservationVerification,
    metering_status: meteringStatus,
    provider_outcome: meterOutcome.provider_outcome,
    operation_evidence: dispatchEvidence,
    financial_hold: 'settled',
  });
}

/** Create an aggregate report with a fixed cell denominator and no dropped failures. */
export function createAccessPreflightReport({ run_id, generated_at, mode, results }) {
  opaqueRef(run_id, 'report.run_id');
  datetime(generated_at, 'report.generated_at');
  if (!REPORT_MODES.has(mode)) fail('invalid_mode', 'Mode must be mock or live.', 'report.mode');
  if (!Array.isArray(results)) fail('invalid_results', 'Results must be an array.', 'report.results');
  const byCell = new Map();
  for (const result of results) {
    if (!isRecord(result) || result[RESULT_BRAND] !== true || typeof result.cell_id !== 'string' || !CELL_IDS.has(result.cell_id)) continue;
    const provenance = RESULT_PROVENANCE.get(result);
    const expected = CELL_BY_ID.get(result.cell_id);
    if (!provenance || provenance.run_id !== run_id || provenance.mode !== mode
      || result.mode !== mode || result.status !== provenance.status || result.verified !== provenance.verified
      || result.reason_code !== provenance.reason_code || result.configuration_sha256 !== provenance.configuration_sha256
      || result.target_binding_sha256 !== provenance.target_binding_sha256
      || result.owner_role !== expected.owner_role || canonicalHash(result.acceptance_ids) !== canonicalHash(expected.acceptance_ids)) continue;
    if (!Object.isFrozen(result) || !Object.isFrozen(result.acceptance_ids)) continue;
    if (!byCell.has(result.cell_id)) byCell.set(result.cell_id, result);
  }
  const cells = ACCESS_CELL_DEFINITIONS.map((cell) => {
    const found = byCell.get(cell.cell_id);
    if (!found) {
      return {
        cell_id: cell.cell_id,
        owner_role: cell.owner_role,
        acceptance_ids: [...cell.acceptance_ids],
        mode,
        status: 'blocked',
        verified: false,
        reason_code: 'cell_not_run',
        owner_action: 'Run this required access cell and preserve its result.',
        selection_state: 'unresolved',
        configuration_sha256: null,
        target_binding_sha256: null,
        pin_evidence: null,
        capability_observation: null,
        authorization_evidence: null,
        reservation_evidence: null,
        metering_status: 'not_started',
        provider_outcome: null,
        operation_evidence: null,
        financial_hold: 'none',
      };
    }
    return found;
  });
  const status = cells.every((row) => row.status === 'verified') ? 'verified' : mode === 'mock' ? 'simulated_or_pending' : 'pending_or_failed';
  return freezeTree({
    schema_version: ACCESS_PREFLIGHT_VERSION,
    run_id,
    generated_at,
    mode,
    status,
    required_cell_count: ACCESS_CELL_DEFINITIONS.length,
    verified_cell_count: cells.filter((row) => row.status === 'verified').length,
    acceptance_allowed: false,
    acceptance_ids: ['EVAL-03', 'FIN-10', 'SPN-01'],
    cells,
  });
}

/** Execute the fixed required matrix. Missing cells remain explicit blocked rows. */
export async function runAccessPreflight(args) {
  record(args, 'args');
  const mode = args.mode;
  if (!REPORT_MODES.has(mode)) fail('invalid_mode', 'Mode must be mock or live.', 'args.mode');
  const rawPlan = record(args.plan, 'args.plan');
  const runId = opaqueRef(rawPlan.run_id, 'args.plan.run_id');
  const rawCells = Array.isArray(rawPlan.cells) ? rawPlan.cells : [];
  const rawByCell = new Map();
  for (const raw of rawCells) {
    if (isRecord(raw) && typeof raw.cell_id === 'string' && CELL_IDS.has(raw.cell_id) && !rawByCell.has(raw.cell_id)) rawByCell.set(raw.cell_id, raw);
  }
  const checkedPlan = validateAccessPlan(rawPlan, args.trustedScope);
  const results = [];
  for (const expected of ACCESS_CELL_DEFINITIONS) {
    const rawCell = rawByCell.get(expected.cell_id);
    if (!rawCell) {
      results.push(resultRow({
        cell_id: expected.cell_id,
        owner_role: expected.owner_role,
        acceptance_ids: [...expected.acceptance_ids],
        selection: { state: 'unresolved' },
        target: null,
        run_id: runId,
      }, mode, 'blocked', 'cell_not_supplied', 'Retain and run this required cell; the denominator is fixed.'));
      continue;
    }
    const normalizedEntry = checkedPlan.cells.find((entry) => entry.cell_id === expected.cell_id);
    const normalized = normalizedEntry ? { ...normalizedEntry, run_id: runId } : null;
    if (normalized?.input_status === 'invalid') {
      results.push(resultRow(normalized, mode, 'blocked', normalized.input_error_code ?? 'invalid_cell', 'Correct the invalid preflight cell.'));
      continue;
    }
    if (expected.billable === null) {
      results.push(resultRow(normalized, mode, 'blocked', 'metering_operation_unpublished', 'Finance must publish the trace operation’s authorization, metering, ingestion, and readback boundary.'));
      continue;
    }
    try {
      results.push(await executeAuthorizedAccessCell({
        ...args,
        runId,
        cell: rawCell,
      }));
    } catch (error) {
      results.push(resultRow(normalized, mode, 'blocked', safeFailureCode(error, 'cell_preflight_failed'), 'Resolve the cell failure with its owner and retain the row.'));
    }
  }
  return createAccessPreflightReport({ run_id: runId, generated_at: new Date().toISOString(), mode, results });
}

/** Normalize untrusted thrown errors to a fixed, non-secret diagnostic code. */
export function safePreflightErrorCode(error, fallback = 'adapter_unavailable') {
  if (error instanceof AccessPreflightError && SAFE_ERROR_CODES.has(error.code)) return error.code;
  return SAFE_ERROR_CODES.has(fallback) ? fallback : 'adapter_unavailable';
}

export function createObservationId() {
  return `preflight-observation:${randomUUID()}`;
}
