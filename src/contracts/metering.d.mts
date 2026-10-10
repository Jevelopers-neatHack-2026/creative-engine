export declare const METERING_PROPOSAL_VERSION: 'creative.metering.proposal/v1';

export type ExecutionEnvironment = 'development' | 'test' | 'production';
export type BillingMode = 'live' | 'sandbox' | 'simulated';
export type MeteredOperationKind =
  | 'image_generation'
  | 'image_edit'
  | 'responses_orchestration'
  | 'planning'
  | 'vision_observation'
  | 'jev_decision'
  | 'baseline_evaluation';

export interface TrustedMeteringScope {
  tenant_id: string;
  project_id: string;
  budget_scope_id: string;
}

export interface MeteredAttemptRequest extends TrustedMeteringScope {
  schema_version: typeof METERING_PROPOSAL_VERSION;
  logical_operation_id: string;
  billable_attempt_id: string;
  retry_mapping_ref: string;
  environment: ExecutionEnvironment;
  billing_mode: BillingMode;
  operation_kind: MeteredOperationKind;
  budget: { scope_id: string; policy_version: string };
  provider: {
    name: string;
    model: string;
    endpoint: string;
    sdk: { name: string; version: string };
  };
  correlation_id?: string;
  workflow_id?: string;
  run_id?: string;
}

export interface UsageUnit {
  name: string;
  /** Exact provider-reported quantity, represented as a decimal string. */
  quantity: string;
  relation: 'standalone' | 'included_subset' | 'unknown_relation';
  included_in?: string;
}

export interface UsageObservation extends TrustedMeteringScope {
  schema_version: typeof METERING_PROPOSAL_VERSION;
  logical_operation_id: string;
  billable_attempt_id: string;
  source_observation_id: string;
  source: 'provider_response' | 'provider_usage_api' | 'trace' | 'billing_export' | 'other';
  provider_name: string;
  model: string;
  provider_request_id?: string;
  transport_attempt_id?: string;
  environment: ExecutionEnvironment;
  billing_mode: BillingMode;
  completeness: 'complete' | 'partial' | 'unknown';
  usage_units?: UsageUnit[];
  missing_fields: string[];
  rate_card_ref?: string;
  valuation?: {
    basis: 'unknown' | 'estimated' | 'provider_confirmed';
    amount?: string;
    currency?: string;
    rate_card_ref?: string;
  };
}

export interface ExactAmount {
  amount: string;
  currency: string;
}

export interface ReservedAttempt {
  status: 'reserved';
  reservation_id: string;
  billable_attempt_id: string;
  held_amount: ExactAmount;
  lease_id: string;
}

export interface DeniedAttempt {
  status: 'denied';
  reason?: string;
}

export interface ObservationAcknowledgement {
  status: 'accepted' | 'duplicate';
  source_observation_id: string;
  effective_billable_attempt_id: string;
}

export interface ReservationSettlement {
  reservation_id: string;
  status: 'settled';
  consumed_amount: ExactAmount;
  released_unused_amount: ExactAmount;
  posting_refs?: string[];
}

export interface HeldSettlement {
  reservation_id: string;
  status: 'held_for_reconciliation';
}

export interface MeteringPort {
  reserveAttempt(attempt: MeteredAttemptRequest): Promise<ReservedAttempt | DeniedAttempt>;
  releaseBeforeDispatch(command: Record<string, unknown>): Promise<unknown>;
  markAttemptInFlight(command: Record<string, unknown>): Promise<{ status: 'in_flight'; reservation_id: string }>;
  recordTransportAttempt(command: Record<string, unknown>): Promise<unknown>;
  recordUsageObservation(command: Record<string, unknown>): Promise<ObservationAcknowledgement>;
  settleReservation(command: Record<string, unknown>): Promise<ReservationSettlement | HeldSettlement>;
  markOutcomeUnknown(command: Record<string, unknown>): Promise<unknown>;
}

export type ProviderOutcome = 'succeeded' | 'failed' | 'partial' | 'unknown';

export interface MeteredDispatchResult {
  provider_outcome?: ProviderOutcome;
  usage_observation?: UsageObservation;
}

export interface MeteredDispatchContext {
  attempt: MeteredAttemptRequest;
  signal?: AbortSignal;
  recordTransportAttempt(transportAttemptId: string): Promise<void>;
}

export type MeteredAttemptOutcome =
  | { status: 'cancelled_before_reservation'; published: false }
  | { status: 'reservation_unavailable'; published: false; error_code: 'metering_authority_unavailable' }
  | { status: 'reservation_denied'; published: false; error_code: 'budget_unavailable' }
  | { status: 'cancelled_before_dispatch'; published: false }
  | { status: 'pre_dispatch_release_unknown'; published: false; hold: 'retained_for_reconciliation' }
  | { status: 'dispatch_authorization_unknown'; published: false; error_code: 'in_flight_transition_unknown' }
  | { status: 'cancelled_after_dispatch'; published: false; hold: 'retained_for_reconciliation' }
  | { status: 'dispatch_outcome_unknown'; published: false; hold: 'retained_for_reconciliation'; error_code: 'provider_outcome_unknown' }
  | { status: 'transport_attempt_unreported'; published: false; hold: 'retained_for_reconciliation' }
  | { status: 'dispatch_result_invalid'; published: false; error_code: 'invalid_provider_response'; hold: 'retained_for_reconciliation' }
  | { status: 'usage_observation_invalid'; published: false; provider_outcome: MeteredDispatchResult['provider_outcome']; error_code: 'invalid_usage_observation'; hold: 'retained_for_reconciliation' }
  | { status: 'usage_unknown'; published: false; provider_outcome: ProviderOutcome; hold: 'retained_for_reconciliation' }
  | { status: 'usage_observation_unconfirmed'; published: false; provider_outcome: ProviderOutcome; hold: 'retained_for_reconciliation' }
  | { status: 'usage_incomplete'; published: false; provider_outcome: ProviderOutcome; observation_ack: ObservationAcknowledgement; hold: 'retained_for_reconciliation' }
  | { status: 'settlement_unknown'; published: false; provider_outcome: ProviderOutcome; error_code: 'settlement_response_unknown'; hold: 'retained_for_reconciliation' }
  | { status: 'settlement_pending'; published: false; provider_outcome: ProviderOutcome; settlement: HeldSettlement }
  | { status: 'settled'; published: false; provider_outcome: ProviderOutcome; observation_ack: ObservationAcknowledgement; settlement: ReservationSettlement };

export declare class MeteringContractError extends Error {
  constructor(code: string, message: string, field?: string);
  readonly code: string;
  readonly field?: string;
}

export declare function validateMeteredAttempt(
  value: unknown,
  trustedScope: TrustedMeteringScope,
): MeteredAttemptRequest;

export declare function validateUsageObservation(
  value: unknown,
  attempt: MeteredAttemptRequest,
): UsageObservation;

export declare function executeMeteredAttempt(args: {
  port: MeteringPort;
  request: MeteredAttemptRequest;
  trustedScope: TrustedMeteringScope;
  dispatch(context: MeteredDispatchContext): Promise<MeteredDispatchResult> | MeteredDispatchResult;
  signal?: AbortSignal;
}): Promise<MeteredAttemptOutcome>;

export declare function recordUsageObservation(args: {
  port: Pick<MeteringPort, 'recordUsageObservation'>;
  attempt: MeteredAttemptRequest;
  trustedScope: TrustedMeteringScope;
  observation: UsageObservation;
}): Promise<ObservationAcknowledgement>;

export declare function evaluateMeteringAgreementGate(evidence?: unknown): {
  status: 'blocked' | 'owner_review_required';
  acceptance_allowed: false;
  independent_owner_verification_required: true;
  missing_owner_roles: string[];
  missing_evidence: string[];
  note: string;
};

export declare function sameMeteringIdentity(left: unknown, right: unknown): boolean;
