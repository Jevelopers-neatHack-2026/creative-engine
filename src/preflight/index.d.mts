import type { MeteredAttemptRequest, MeteredDispatchContext, MeteringPort, TrustedMeteringScope } from '../contracts/metering.mjs';

export type AccessMode = 'mock' | 'live';
export type AccessStatus = 'verified' | 'simulated' | 'blocked' | 'denied' | 'failed' | 'unknown';

export interface AccessCellDefinition {
  readonly cell_id: string;
  readonly owner_role: string;
  readonly acceptance_ids: readonly string[];
  readonly operation_kind: MeteredAttemptRequest['operation_kind'] | null;
  readonly billable: boolean | null;
}

export interface AccessEvidenceReference {
  readonly ref: string;
  readonly sha256: `sha256:${string}`;
}

export interface PinnedAccessEvidence extends AccessEvidenceReference {
  readonly pinned_revision: string;
  readonly independent_review: AccessEvidenceReference;
}

export interface TrustedAccessScope extends TrustedMeteringScope {
  readonly account_ref: string;
  readonly project_ref: string;
}

export interface AccessTarget {
  readonly service: string;
  readonly endpoint: string;
  readonly model: string | null;
  readonly sdk: Readonly<{ name: string; version: string }> | null;
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly configuration_sha256: `sha256:${string}`;
}

export interface AccessPlanCell {
  readonly cell_id: string;
  readonly owner_role: string;
  readonly selection: Readonly<{
    state: 'unresolved' | 'documented_candidate' | 'owner_selected';
    candidate_ref?: string;
    candidate_sha256?: `sha256:${string}`;
  }>;
  readonly scope: TrustedAccessScope;
  readonly target: AccessTarget | null;
  readonly spend: AccessSpend | null;
}

export interface AccessSpend {
  readonly maximum_amount: string;
  readonly currency: string;
  readonly deadline_at: string;
  readonly stop_conditions: readonly string[];
}

export interface NormalizedAccessPlanCell {
  readonly cell_id: string;
  readonly owner_role: string;
  readonly operation_kind: MeteredAttemptRequest['operation_kind'] | null;
  readonly billable: boolean | null;
  readonly selection: AccessPlanCell['selection'];
  readonly scope: TrustedAccessScope | null;
  readonly target: AccessTarget | null;
  readonly spend: AccessSpend | null;
  readonly input_status: 'valid' | 'missing' | 'invalid';
  readonly input_error_code?: string;
}

export interface AccessPlan {
  readonly schema_version: typeof ACCESS_PREFLIGHT_VERSION;
  readonly run_id: string;
  readonly created_at: string;
  readonly cells: readonly AccessPlanCell[];
}

export interface AccessTargetBinding {
  readonly service: string;
  readonly endpoint: string;
  readonly model: string;
  readonly sdk_name: string;
  readonly sdk_version: string;
  readonly configuration_sha256: `sha256:${string}`;
  readonly account_ref: string;
  readonly project_ref: string;
}

export interface PinVerificationDecision {
  readonly decision: 'accepted' | 'denied' | 'pending';
  readonly evidence_mode: AccessMode;
  readonly cell_id: string;
  readonly owner_role: string;
  readonly configuration_sha256: string;
  readonly target_binding: AccessTargetBinding;
  readonly evidence: PinnedAccessEvidence;
  readonly owner_evidence: PinnedAccessEvidence & Readonly<{ owner_role: string }>;
  readonly protocol: PinnedAccessEvidence;
  readonly checked_at: string;
}

export interface AccessObservation {
  readonly evidence_mode: AccessMode;
  readonly target: AccessTargetBinding;
  readonly authentication: 'confirmed' | 'denied' | 'unknown' | 'not_applicable';
  readonly model_listing: 'listed' | 'not_listed' | 'not_applicable' | 'unknown';
  readonly operation_permission: 'confirmed' | 'denied' | 'unknown' | 'not_tested';
  readonly quota: 'available' | 'denied' | 'unknown' | 'not_checked';
  readonly checked_at: string;
  readonly evidence: AccessEvidenceReference;
  readonly capability_verification?: AccessCapabilityDecision;
}

export interface AccessCapabilityDecision {
  readonly decision: 'confirmed' | 'denied' | 'unknown';
  readonly operation_permission: 'confirmed' | 'denied' | 'unknown' | 'not_tested';
  readonly quota: 'available' | 'denied' | 'unknown' | 'not_checked';
  readonly checked_at: string;
  readonly expires_at: string;
  readonly evidence: PinnedAccessEvidence;
  readonly owner_evidence: PinnedAccessEvidence & Readonly<{ owner_role: string }>;
  readonly protocol: PinnedAccessEvidence;
}

export interface AccessCapabilityVerifierPort {
  readonly evidence_mode: AccessMode;
  verifyCapability(input: Readonly<{
    run_id: string;
    cell_id: string;
    owner_role: string;
    operation_kind: MeteredAttemptRequest['operation_kind'];
    target_binding: AccessTargetBinding;
    deadline_at: string;
    scope: TrustedAccessScope;
    at: string;
  }>): Promise<unknown>;
  revalidateCapability(input: Readonly<{
    run_id: string;
    cell_id: string;
    owner_role: string;
    operation_kind: MeteredAttemptRequest['operation_kind'];
    target_binding: AccessTargetBinding;
    deadline_at: string;
    scope: TrustedAccessScope;
    previous_evidence: PinnedAccessEvidence;
    at: string;
  }>): Promise<unknown>;
}

export interface AccessProviderAdapter {
  readonly evidence_mode: AccessMode;
  inspect(input: Readonly<{ run_id: string; cell_id: string; target: AccessTarget; scope: TrustedAccessScope }>): Promise<unknown>;
  prepare?(input: Readonly<{
    run_id: string;
    cell_id: string;
    target: AccessTarget;
    configuration: Readonly<Record<string, unknown>>;
    scope: TrustedAccessScope;
    grant_ref: string;
    deadline_at: string;
    authorization_evidence: PinnedAccessEvidence;
  }>): Promise<unknown>;
  dispatch(input: Readonly<{
    run_id: string;
    cell_id: string;
    target: AccessTarget;
    configuration: Readonly<Record<string, unknown>>;
    scope: TrustedAccessScope;
    prepared: unknown;
    deadline_at: string;
    grant_ref: string;
    authorization_evidence: PinnedAccessEvidence;
    metering: Readonly<AccessProviderMeteringContext>;
  }>): Promise<unknown>;
}

export interface AccessProviderMeteringContext extends MeteredDispatchContext {
  /** Revalidate the current grant, provider capability, and Finance lease after transport acknowledgement. */
  authorizeTransport(): Promise<void>;
  /** Perform the final synchronous deadline, cancellation, expiry, and freshness fence before network I/O. */
  assertTransportReady(): void;
}

export interface PinVerifierPort {
  readonly evidence_mode: AccessMode;
  verifyPin(input: Readonly<{ cell_id: string; owner_role: string; target: AccessTarget }>): Promise<unknown>;
}

export interface AuthorizationPort {
  readonly evidence_mode: AccessMode;
  verifyGrant(input: Readonly<{ grant_ref: string; expected: Readonly<Record<string, unknown>>; at: string }>): Promise<unknown>;
  revalidateGrant(input: Readonly<{
    grant_ref: string;
    expected: Readonly<Record<string, unknown>>;
    authorization_evidence: PinnedAccessEvidence;
    at: string;
  }>): Promise<unknown>;
}

export interface ReservationVerifierPort {
  readonly evidence_mode: AccessMode;
  verifyReservation(input: Readonly<{
    reservation: unknown;
    attempt: MeteredAttemptRequest;
    expected: Readonly<Record<string, unknown>>;
    grant_ref: string;
    authorization_evidence: PinnedAccessEvidence;
    at: string;
  }>): Promise<unknown>;
}

export interface AccessCellResult {
  readonly cell_id: string;
  readonly owner_role: string;
  readonly acceptance_ids: readonly string[];
  readonly mode: AccessMode;
  readonly status: AccessStatus;
  readonly verified: boolean;
  readonly reason_code: string;
  readonly owner_action: string;
  readonly selection_state: 'unresolved' | 'documented_candidate' | 'owner_selected';
  readonly configuration_sha256: string | null;
  readonly target_binding_sha256: string | null;
  readonly pin_evidence: unknown;
  readonly capability_observation: unknown;
  readonly authorization_evidence: unknown;
  readonly reservation_evidence: unknown;
  readonly metering_status: string;
  readonly provider_outcome: string | null;
  readonly operation_evidence: unknown;
  readonly financial_hold: string;
}

export interface AccessPreflightReport {
  readonly schema_version: typeof ACCESS_PREFLIGHT_VERSION;
  readonly run_id: string;
  readonly generated_at: string;
  readonly mode: AccessMode;
  readonly status: 'verified' | 'simulated_or_pending' | 'pending_or_failed';
  readonly required_cell_count: number;
  readonly verified_cell_count: number;
  readonly acceptance_allowed: false;
  readonly acceptance_ids: readonly string[];
  readonly cells: readonly AccessCellResult[];
}

export interface AccessExecutionPorts {
  readonly adapter: AccessProviderAdapter;
  readonly pinVerifier: PinVerifierPort;
  readonly capabilityVerifier: AccessCapabilityVerifierPort;
  readonly authorizationPort: AuthorizationPort;
  readonly reservationVerifier: ReservationVerifierPort;
  readonly meteringPort: MeteringPort & Readonly<{ evidence_mode: AccessMode }>;
  readonly meteringRequest: MeteredAttemptRequest;
  readonly grantRef: string;
  readonly trustedScope: TrustedAccessScope;
  readonly mode: AccessMode;
  readonly now?: string | (() => string);
  readonly signal?: AbortSignal;
}

export class AccessPreflightError extends Error {
  constructor(code: string, message: string, field?: string);
  readonly code: string;
  readonly field?: string;
}

export const ACCESS_PREFLIGHT_VERSION: 'creative.access-preflight.proposal/v1';
export const ACCESS_CELL_DEFINITIONS: readonly AccessCellDefinition[];

export function validateAccessPlan(value: unknown, trustedScope: TrustedAccessScope): Readonly<{
  schema_version: typeof ACCESS_PREFLIGHT_VERSION;
  run_id: string;
  created_at: string;
  cells: readonly NormalizedAccessPlanCell[];
}>;

export function executeAuthorizedAccessCell(args: AccessExecutionPorts & Readonly<{ runId: string; cell: AccessPlanCell }>): Promise<AccessCellResult>;
export function createAccessPreflightReport(input: Readonly<{
  run_id: string;
  generated_at: string;
  mode: AccessMode;
  results: readonly AccessCellResult[];
}>): AccessPreflightReport;
export function runAccessPreflight(args: AccessExecutionPorts & Readonly<{ plan: AccessPlan }>): Promise<AccessPreflightReport>;
export function safePreflightErrorCode(error: unknown, fallback?: string): string;
export function createObservationId(): string;

export interface ResolvedOpenAICredential {
  readonly decision: 'resolved';
  readonly evidence_mode: 'live';
  readonly binding: Readonly<{
    service: 'openai';
    account_ref: string;
    project_ref: string;
    target_binding_sha256: string;
    grant_ref?: string;
  }>;
  readonly provider_scope: Readonly<{ organization_id: string; project_id: string }>;
  readonly token: string;
  readonly expires_at: string;
  readonly evidence: PinnedAccessEvidence;
}

export interface OpenAICredentialPort {
  readonly evidence_mode: 'live';
  resolveCredential(input: Readonly<{
    service: 'openai';
    purpose: 'read_only_model_listing' | 'authorized_billable_operation';
    account_ref: string;
    project_ref: string;
    target_binding: AccessTargetBinding;
    grant_ref?: string;
  }>): Promise<ResolvedOpenAICredential>;
}

export interface OpenAIImagesAdapterOptions {
  readonly credentialPort: OpenAICredentialPort;
  readonly promptPort: Readonly<{ resolve(input: Readonly<{ ref: string }>): Promise<string> }>;
  readonly assetPort?: Readonly<{ read(input: Readonly<{ ref: string; sha256: string }>): Promise<Uint8Array> }>;
}

export function createOpenAIImagesAdapter(options: OpenAIImagesAdapterOptions): AccessProviderAdapter;
