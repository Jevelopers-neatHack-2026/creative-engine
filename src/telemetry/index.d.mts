import type {
  MeteredAttemptOutcome,
  MeteredAttemptRequest,
  MeteringPort,
  TrustedMeteringScope,
  UsageObservation,
} from "../contracts/metering.mjs";

export declare const CREATIVE_TELEMETRY_SCHEMA: "creative.telemetry.evidence/v1";
export declare const USAGE_PROFILE: Readonly<{
  NORMALIZED: "creative.normalized-token-usage/1";
  OPENAI_RESPONSES: "openai.responses-usage/2026-10-10";
  OPENAI_GPT_IMAGE_1: "openai.gpt-image-1-usage/2026-10-10";
  TYPESAFE_DECISION: "typesafe.systemone-usage/2026-10-10";
}>;
export declare const TELEMETRY_PROVIDER_MODES: readonly ["mock", "recorded", "sandbox", "live", "unknown"];
export declare const TELEMETRY_COMMERCE_MODES: readonly ["simulated", "live", "unknown"];

export interface TelemetryModeContext {
  provider_execution_mode: typeof TELEMETRY_PROVIDER_MODES[number];
  commerce_mode: typeof TELEMETRY_COMMERCE_MODES[number];
}

export interface CreativeTelemetryEvidence {
  readonly schema_version: typeof CREATIVE_TELEMETRY_SCHEMA;
  readonly event_id: string;
  readonly tenant_id: string;
  readonly project_id: string;
  readonly budget_scope_id: string;
  readonly producer: "creative-engine.telemetry";
  readonly occurred_at: string;
  readonly environment: MeteredAttemptRequest["environment"];
  readonly billing_mode: MeteredAttemptRequest["billing_mode"];
  readonly provider_execution_mode: TelemetryModeContext["provider_execution_mode"];
  readonly commerce_mode: TelemetryModeContext["commerce_mode"];
  readonly logical_operation_id: string;
  readonly billable_attempt_id: string;
  readonly operation_kind: MeteredAttemptRequest["operation_kind"];
  readonly event_type: "attempt_intent" | "transport_intent" | "attempt_outcome";
  readonly provider: Readonly<{ name: string; model: string }>;
  readonly reservation_ref?: string;
  readonly transport_attempt_id?: string;
  readonly provider_request_id?: string;
  readonly source_observation_id?: string;
  readonly provider_outcome?: "succeeded" | "failed" | "partial" | "unknown";
  readonly metering_status?: string;
  readonly usage_completeness?: "complete" | "partial" | "unknown";
  readonly missing_fields?: readonly string[];
}

export declare class TelemetryPrivacyError extends Error {
  constructor(code?: string);
  readonly code: string;
  readonly field: "evidence";
}
export declare class TelemetryBoundaryError extends Error {
  constructor(code?: string);
  readonly code: string;
  readonly field: "telemetry";
}

export declare function containsSensitivePublicText(value: unknown): value is string;
export declare function isSensitivePublicField(value: unknown): value is string;
export declare function assertSafePublicIdentifier(value: unknown, options?: { maxLength?: number }): string;
export declare function projectPublicTelemetry(
  value: unknown,
  limits?: { maxDepth?: number; maxNodes?: number; maxBytes?: number },
): Readonly<{ value: unknown; redactions: readonly Readonly<{ path: string; reason: "sensitive_value_redacted" | "sensitive_field_omitted" }>[] }>;

export declare function createUsageObservation(args: {
  attempt: MeteredAttemptRequest;
  trustedScope: TrustedMeteringScope;
  usage: unknown;
  profile: typeof USAGE_PROFILE[keyof typeof USAGE_PROFILE];
  sourceObservationId: string;
  source?: UsageObservation["source"];
  providerRequestId?: string;
  transportAttemptId?: string;
}): UsageObservation;
export declare function deduplicateUsageObservations(observations: readonly UsageObservation[]): readonly UsageObservation[];

export declare function createTelemetryEvidence(args: {
  eventId: string;
  type: CreativeTelemetryEvidence["event_type"];
  attempt: MeteredAttemptRequest;
  trustedScope: TrustedMeteringScope;
  modes: TelemetryModeContext;
  occurredAt: string;
  reservationRef?: string;
  transportAttemptId?: string;
  providerRequestId?: string;
  sourceObservationId?: string;
  providerOutcome?: CreativeTelemetryEvidence["provider_outcome"];
  meteringStatus?: string;
  usageCompleteness?: CreativeTelemetryEvidence["usage_completeness"];
  missingFields?: readonly string[];
}): CreativeTelemetryEvidence;

export interface TelemetryEvidencePort {
  append(event: CreativeTelemetryEvidence): Promise<{
    status: "recorded" | "duplicate";
    event_id: string;
  }>;
  /** Durable local retry path for an outcome event whose first append failed. */
  stagePendingEvidence?(event: CreativeTelemetryEvidence): Promise<{
    status: "recorded" | "duplicate";
    event_id: string;
  }>;
}
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;
export interface MeteredDispatchWithEvidenceContext {
  readonly attempt: DeepReadonly<MeteredAttemptRequest>;
  readonly reservation_ref: string;
  readonly transport_attempt_id: string;
  readonly dispatch_intent_ref: string;
  readonly signal?: AbortSignal;
  recordTransportAttempt(transportAttemptId: string): Promise<string>;
}
export interface UsageObservationPersistencePort {
  enqueueUsageObservation(args: {
    attempt: MeteredAttemptRequest;
    trustedScope: TrustedMeteringScope;
    observation: UsageObservation;
  }): Promise<{ status: "recorded" | "duplicate"; record_ref: string; source_observation_id: string; payload_hash: string }>;
  acknowledgeEnqueuedObservation?(args: {
    record_ref: string;
    source_observation_id: string;
    effective_billable_attempt_id: string;
    authority_status: "accepted" | "duplicate";
  }): Promise<{ status: "acknowledged" | "mismatch"; source_observation_id: string }>;
}

export interface TrustedProviderUsageProfileInput {
  readonly attempt: MeteredAttemptRequest;
  readonly trustedScope: TrustedMeteringScope;
  readonly rawUsage: unknown;
  readonly rawUsageSha256: `sha256:${string}`;
  readonly targetBindingSha256: `sha256:${string}`;
  readonly attemptBindingSha256: `sha256:${string}`;
  readonly sourceObservationId: string;
  readonly transportAttemptId: string;
  readonly reservationRef: string;
  readonly dispatchIntentRef: string;
  readonly providerOutcome: "succeeded" | "failed" | "partial" | "unknown";
}

export type TrustedProviderUsageProfileResult =
  | Readonly<{ status: "unknown" }>
  | Readonly<{
      status: "mapped";
      profile_ref: string;
      profile_sha256: `sha256:${string}`;
      raw_usage_sha256: `sha256:${string}`;
      target_binding_sha256: `sha256:${string}`;
      attempt_binding_sha256: `sha256:${string}`;
      observation: UsageObservation;
    }>;

/** Trusted host owner mapping only; caller request data cannot install or select this port. */
export interface TrustedProviderUsageProfileAuthority {
  mapProviderUsage(input: TrustedProviderUsageProfileInput):
    Promise<TrustedProviderUsageProfileResult> | TrustedProviderUsageProfileResult;
}
export declare function executeCreativeMeteredAttempt(args: {
  meteringPort: MeteringPort;
  evidencePort: TelemetryEvidencePort;
  observationOutbox: UsageObservationPersistencePort;
  request: MeteredAttemptRequest;
  trustedScope: TrustedMeteringScope;
  modes: TelemetryModeContext;
  authorizeTransport(input: Readonly<{
    attempt: DeepReadonly<MeteredAttemptRequest>;
    logical_operation_id: string;
    billable_attempt_id: string;
    reservation_ref: string;
    transport_attempt_id: string;
    signal?: AbortSignal;
  }>): Promise<string> | string;
  revalidateTransport(input: Readonly<{
    attempt: DeepReadonly<MeteredAttemptRequest>;
    logical_operation_id: string;
    billable_attempt_id: string;
    reservation_ref: string;
    transport_attempt_id: string;
    dispatch_intent_ref: string;
    signal?: AbortSignal;
  }>): Promise<void> | void;
  dispatch(context: MeteredDispatchWithEvidenceContext): Promise<{
    provider_outcome?: "succeeded" | "failed" | "partial" | "unknown";
    usage_observation?: UsageObservation;
  }> | {
    provider_outcome?: "succeeded" | "failed" | "partial" | "unknown";
    usage_observation?: UsageObservation;
  };
  idFactory?: (kind: string) => string;
  clock?: () => Date | string;
  signal?: AbortSignal;
}): Promise<Readonly<{
  outcome: MeteredAttemptOutcome;
  evidence_delivery: "recorded" | "duplicate" | "pending";
  evidence_refs: readonly string[];
  observation_ref?: string;
  pending_evidence?: CreativeTelemetryEvidence;
}>>;

export interface PendingUsageObservationRecord {
  readonly record_ref: string;
  readonly claim_token: string;
  readonly attempt: MeteredAttemptRequest;
  readonly observation: UsageObservation;
}
export interface UsageObservationOutboxPort {
  claimPending(args: { limit: number }): Promise<{ status: "claimed"; records: readonly PendingUsageObservationRecord[] }>;
  acknowledge(args: {
    record_ref: string;
    claim_token: string;
    source_observation_id: string;
    effective_billable_attempt_id: string;
    authority_status: "accepted" | "duplicate";
  }): Promise<{ status: "acknowledged" | "mismatch"; source_observation_id: string }>;
  defer(args: {
    record_ref: string;
    claim_token: string;
    reason: "trusted_scope_or_record_unavailable" | "metering_observation_unconfirmed" | "metering_acknowledgement_mismatch" | "outbox_acknowledgement_unconfirmed";
  }): Promise<{ status: "retained" | "lease_lost" }>;
}
export declare function deliverPendingUsageObservations(args: {
  meteringPort: Pick<MeteringPort, "recordUsageObservation">;
  outbox: UsageObservationOutboxPort;
  trustedScopeForRecord(input: Readonly<{ record_ref: string }>): Promise<TrustedMeteringScope> | TrustedMeteringScope;
  limit?: number;
}): Promise<Readonly<{
  status: "complete" | "pending" | "outbox_unavailable";
  attempted: number;
  acknowledged: number;
  retained: number;
}>>;

export interface TelemetryEvidenceSinkPort {
  /** Explicit event-level acknowledgement; transport success or flush is not sufficient. */
  record(event: CreativeTelemetryEvidence): Promise<{
    status: "accepted" | "duplicate";
    event_id: string;
  }>;
}
export declare function deliverPendingTelemetryEvidence(args: {
  outbox: Pick<SqliteTelemetryOutbox, "claimPendingEvidence" | "acknowledgeEvidence" | "deferEvidence">;
  sink: TelemetryEvidenceSinkPort;
  limit?: number;
}): Promise<Readonly<{
  status: "complete" | "pending" | "outbox_unavailable";
  attempted: number;
  acknowledged: number;
  retained: number;
}>>;

export interface SqliteTelemetryEvidenceClaim {
  readonly event: CreativeTelemetryEvidence;
  readonly record_ref: string;
  readonly claim_token: string;
}

export interface SqliteTelemetryOutbox {
  append(event: CreativeTelemetryEvidence): Promise<{
    readonly status: "recorded" | "duplicate";
    readonly event_id: string;
  }>;
  /** Local presence check for distinguishing legacy job results from corrupted new results. */
  hasAttemptEvidence(input: Readonly<{
    tenant_id: string;
    project_id: string;
    budget_scope_id: string;
    logical_operation_id: string;
    billable_attempt_id: string;
  }>): Promise<"found" | "not_found">;
  stagePendingEvidence(event: CreativeTelemetryEvidence): Promise<{
    readonly status: "recorded" | "duplicate";
    readonly event_id: string;
  }>;
  enqueueUsageObservation(args: {
    attempt: MeteredAttemptRequest;
    trustedScope: TrustedMeteringScope;
    observation: UsageObservation;
  }): Promise<{
    readonly status: "recorded" | "duplicate";
    readonly record_ref: string;
    readonly source_observation_id: string;
    readonly payload_hash: string;
  }>;
  acknowledgeEnqueuedObservation(args: {
    record_ref: string;
    source_observation_id: string;
    effective_billable_attempt_id: string;
    authority_status: "accepted" | "duplicate";
  }): Promise<{ readonly status: "acknowledged" | "mismatch"; readonly source_observation_id: string;
    readonly authority_status?: "accepted" | "duplicate" }>;
  claimPending(args: { limit: number }): Promise<{
    readonly status: "claimed";
    readonly records: readonly PendingUsageObservationRecord[];
  }>;
  acknowledge(args: {
    record_ref: string;
    claim_token: string;
    source_observation_id: string;
    effective_billable_attempt_id: string;
    authority_status: "accepted" | "duplicate";
  }): Promise<{ readonly status: "acknowledged" | "mismatch"; readonly source_observation_id: string }>;
  defer(args: {
    record_ref: string;
    claim_token: string;
    reason: "trusted_scope_or_record_unavailable" | "metering_observation_unconfirmed" | "metering_acknowledgement_mismatch" | "outbox_acknowledgement_unconfirmed";
  }): Promise<{ readonly status: "retained" | "lease_lost" }>;
  claimPendingEvidence(args: { limit: number; leaseMs?: number }): Promise<{
    readonly status: "claimed";
    readonly records: readonly SqliteTelemetryEvidenceClaim[];
  }>;
  acknowledgeEvidence(args: { event_id: string; claim_token: string }): Promise<{
    readonly status: "acknowledged" | "lease_lost";
    readonly event_id: string;
  }>;
  deferEvidence(args: {
    event_id: string;
    claim_token: string;
    reason: "sink_unavailable" | "acknowledgement_unknown" | "sink_acknowledgement_invalid";
  }): Promise<{ readonly status: "retained" | "lease_lost" }>;
  status(kind: "evidence" | "observation", reference: string): Promise<Readonly<{
    status: "pending" | "claimed" | "delivered";
    claim_count: number;
    created_at: number;
    delivered_at?: number;
  }> | undefined>;
}

/**
 * Create the CE-11-only durable queue on a caller-owned SQLite DatabaseSync
 * connection. This adapter stores evidence and observations, not Finance state.
 */
export declare function createSqliteTelemetryOutbox(args: {
  database: object;
  idFactory?: (kind: string) => string;
  clock?: () => number | Date;
  claimLeaseMs?: number;
}): SqliteTelemetryOutbox;

/** Trusted host configuration. The outbox must share the durable API's SQLite connection. */
export interface CreativeTelemetryConfiguration {
  readonly outbox: SqliteTelemetryOutbox;
  readonly modes: TelemetryModeContext;
  readonly usage_profiles: Readonly<Partial<Record<MeteredAttemptRequest["operation_kind"],
    typeof USAGE_PROFILE[keyof typeof USAGE_PROFILE]>>>;
  /** Optional exact target/attempt-bound owner mapping. Without it, unmapped provider usage stays unknown. */
  readonly usage_profile_authority?: TrustedProviderUsageProfileAuthority;
}
