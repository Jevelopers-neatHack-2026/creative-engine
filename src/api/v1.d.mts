import type {
  CreativeBrief,
  DesignVersion,
  EditPlan,
  TrustedScope,
} from "../contracts/creative/v1.mjs";
import type {
  DecisionPortRequest,
  DecisionPortResult,
} from "../contracts/decision-port/v1.mjs";
import type {
  ApprovalBinding,
  ApprovalVerifier,
  ArtworkHandoff,
  ConsumptionReceipt,
  HandoffArtifact,
  HandoffLayer,
} from "../contracts/approval-handoff.mjs";
import type {
  MeteredAttemptRequest,
  MeteredDispatchContext,
  MeteringPort,
} from "../contracts/metering.mjs";
import type { CreativeTelemetryConfiguration, CreativeTelemetryEvidence } from "../telemetry/index.mjs";

export type CreativeOperation =
  | "generate" | "edit" | "inspect" | "list" | "compare" | "restore" | "cancel" | "handoff" | "job.status";
export type CreativeJobStatus = "queued" | "running" | "completed" | "cancelled" | "failed";
export type CreativeErrorCode =
  | "invalid_request" | "unsupported_version" | "unauthorized" | "permission_denied"
  | "scope_denied" | "not_found" | "conflict" | "stale_version" | "unavailable"
  | "cancelled" | "review_required" | "budget_unavailable" | "failed";

export interface DispatchAuthorizationInput {
  scope: TrustedScope;
  actor_id: string;
  job_id: string;
  lease_token: string;
  action_id: string;
  operation: CreativeOperation;
  billable_attempt_id?: string;
  transport_attempt_id: string;
  /** Atomically compared with authoritative creative records when inserting each transport intent. */
  context_fence: CreativeContextFence;
}

export type DispatchAuthorizationResult =
  | { status: "authorized"; dispatch_intent_ref: string }
  | { status: "cancelled" | "lease_lost" | "stale_context" };

export interface CreativeContextFence {
  brief_id: string;
  brief_hash: string;
  design_version_id?: string;
  design_hash?: string;
  expected_current_design_version_id?: string | null;
  expected_current_design_hash?: string | null;
}

/** A transaction capability owned by a durable jobs/storage adapter. Runtime
 * callers may forward it only to the matching version adapter port. */
export interface CreativePublicationTransaction {
  readonly job_id: string;
  readonly lease_token: string;
}

export interface CreativeVersionCreationEvidence {
  job_id: string;
  action_id: string;
  actor_id: string;
  request_hash: string;
  logical_operation_id?: string;
  billable_attempt_id: string;
  parent_design_hash?: string;
  transport_attempt_ids?: string[];
  provider_request_ids?: string[];
  usage_refs?: string[];
  trace_refs?: string[];
}

export interface PreparedDesignVersion {
  status: "prepared";
  action_id: string;
  job_id: string;
  payload_hash: string;
}

export interface CreativeApiRequestEnvelope {
  contract: "CreativeApiRequest";
  schema_version: "1.0";
  event_id: string;
  request_id: string;
  tenant_id: string;
  project_id: string;
  correlation_id: string;
  producer: string;
  occurred_at: string;
  ingested_at: string;
  environment: "development" | "test" | "production";
  billing_mode: "live" | "sandbox" | "simulated";
  source_refs: string[];
}

export type CreativeDecisionInput = Pick<DecisionPortRequest, "execution_mode" | "state" | "questions">;
export type CreativeApiRequest =
  | (CreativeApiRequestEnvelope & { operation: "generate"; action_id: string;
      payload: { brief_id: string; plan: EditPlan; decision_request?: CreativeDecisionInput } })
  | (CreativeApiRequestEnvelope & { operation: "edit"; action_id: string;
      payload: { brief_id: string; design_version_id: string; plan: EditPlan;
        selection_mode?: "advance" | "branch"; decision_request?: CreativeDecisionInput } })
  | (CreativeApiRequestEnvelope & { operation: "inspect"; action_id: string;
      payload: { brief_id: string; design_version_id: string } })
  | (CreativeApiRequestEnvelope & { operation: "list"; action_id?: string;
      payload: { brief_id: string; limit?: number; cursor?: string } })
  | (CreativeApiRequestEnvelope & { operation: "compare"; action_id?: string;
      payload: { brief_id: string; left_design_version_id: string; right_design_version_id: string } })
  | (CreativeApiRequestEnvelope & { operation: "restore"; action_id: string;
      payload: { brief_id: string; target_design_version_id: string; expected_selection_revision: number } })
  | (CreativeApiRequestEnvelope & { operation: "cancel"; action_id: string;
      payload: { job_id: string } })
  | (CreativeApiRequestEnvelope & { operation: "handoff"; action_id: string;
      payload: { brief_id: string; design_version_id: string; approval_ref: string; destination_ref: string } })
  | (CreativeApiRequestEnvelope & { operation: "job.status"; action_id?: string;
      payload: { job_id: string } });

export interface TrustedCreativeActor extends TrustedScope {
  actor_id: string;
  expires_at: string;
  permissions: string[];
  budget_scope_id: string;
  budget_policy_version: string;
}

export interface CreativeApiErrorShape {
  code: CreativeErrorCode;
  operation: CreativeOperation | "unknown";
  module: "creative-engine.api";
  field: string;
  retryable: boolean;
  message: string;
  diagnostic_ref: string;
}

export interface CreativeJob {
  contract: "CreativeJob";
  schema_version: "1.0";
  operation_id: string;
  job_id: string;
  status: CreativeJobStatus;
  result_ref?: string;
  error?: CreativeApiErrorShape;
}

export interface CreativeJobRecord {
  tenant_id: string;
  project_id: string;
  brief_id?: string;
  actor_id: string;
  action_id: string;
  operation: CreativeOperation;
  job_id: string;
  status: CreativeJobStatus;
  request_hash: string;
  result?: unknown;
  result_ref?: string;
  error?: CreativeApiErrorShape;
}

export interface StartedJob { kind: "started"; job_id: string; lease_token: string }
export interface ExistingJob { kind: "existing"; job: CreativeJobRecord }
export interface ConflictingJob { kind: "conflict" }
export interface CompletedJob { status: "completed"; job: CreativeJobRecord; result?: unknown }
export interface CancelledJob { status: "cancelled"; job?: CreativeJobRecord }
export interface StaleContextJob { status: "stale_context"; job?: CreativeJobRecord }
export type CancelJobResult =
  | { kind: "cancelled" | "replayed"; job: CreativeJobRecord }
  | { kind: "not_found" | "conflict" };
export type FailedJobResult =
  | { status: "failed"; job: CreativeJobRecord }
  | { status: "cancelled"; job: CreativeJobRecord };

export interface UsageRecord {
  completeness: "complete" | "partial" | "incomplete" | "unknown";
  input_tokens?: number;
  output_tokens?: number;
  provider_request_id?: string;
  transport_attempt_id?: string;
  reason?: "usage_unavailable" | "usage_malformed";
}

/** Raw provider counters supplied to the runtime before profile-based normalization. */
export interface ProviderUsageRecord {
  completeness?: "complete" | "partial" | "incomplete" | "unknown";
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: Readonly<Record<string, number>>;
  output_tokens_details?: Readonly<Record<string, number>>;
  provider_request_id?: string;
  transport_attempt_id?: string;
  missing_fields?: readonly string[];
  readonly [providerField: string]: unknown;
}

export interface CreativeRuntimePorts {
  storage?: {
    getBrief(input: { scope: TrustedScope; brief_id: string }): Promise<CreativeBrief | null> | CreativeBrief | null;
    getDesignVersion(input: { scope: TrustedScope; brief_id: string; design_version_id: string }): Promise<DesignVersion | null> | DesignVersion | null;
    getCurrentDesignVersion(input: { scope: TrustedScope; brief_id: string }): Promise<DesignVersion | null> | DesignVersion | null;
    getSelection(input: { scope: TrustedScope; brief_id: string }): Promise<DesignSelection | null> | DesignSelection | null;
    listDesignVersions(input: { scope: TrustedScope; brief_id: string; limit: number;
      after?: { occurred_at: string; design_version_id: string } }): Promise<{ items: DesignVersion[]; has_more: boolean }>;
    /** Atomically compare brief hash and current design ID/hash before storing a new immutable version. */
    saveDesignVersion(input: { scope: TrustedScope; brief_id: string; design_version: DesignVersion;
      artifact_bytes: Uint8Array; selection_mode: "advance" | "branch";
      creation: CreativeVersionCreationEvidence; lease_token: string; job_result: unknown;
      expected_brief_hash: string; expected_current_design_version_id: string | null;
      expected_current_design_hash: string | null; expected_parent_design_version_id: string | null;
      expected_parent_design_hash: string | null }, transaction?: CreativePublicationTransaction):
      Promise<{ status: "saved" | "stale" }> | { status: "saved" | "stale" };
    prepareDesignVersion?(input: { scope: TrustedScope; brief_id: string; design_version: DesignVersion;
      artifact_bytes: Uint8Array; selection_mode: "advance" | "branch";
      creation: CreativeVersionCreationEvidence; lease_token: string; job_result: unknown;
      expected_brief_hash: string; expected_current_design_version_id: string | null;
      expected_current_design_hash: string | null; expected_parent_design_version_id: string | null;
      expected_parent_design_hash: string | null }): Promise<PreparedDesignVersion> | PreparedDesignVersion;
    commitPreparedDesignVersion?(input: { scope: TrustedScope; brief_id: string; action_id: string;
      job_id: string; payload_hash: string }, transaction: CreativePublicationTransaction):
      Promise<{ status: "saved" | "stale" }> | { status: "saved" | "stale" };
    /** Atomically compare brief, target, current selection identity/hash, and selection revision. */
    selectDesignVersion(input: { scope: TrustedScope; brief_id: string; design_version_id: string;
      expected_brief_hash: string; expected_target_design_hash: string;
      expected_selected_design_version_id: string; expected_selected_design_hash: string;
      expected_selection_revision: number }, transaction?: CreativePublicationTransaction): Promise<{ status: "selected"; selection: DesignSelection } | { status: "stale" }> |
      { status: "selected"; selection: DesignSelection } | { status: "stale" };
    getHandoffContext(input: { scope: TrustedScope; brief_id: string; design_version_id: string }): Promise<{
      binding: ApprovalBinding;
      artifact: HandoffArtifact;
      layer_manifest: HandoffLayer[];
    } | null> | { binding: ApprovalBinding; artifact: HandoffArtifact; layer_manifest: HandoffLayer[] } | null;
  };
  jobs?: {
    /** Fail closed before job creation or any operation-specific external port calls. */
    assertOperationAvailable?(input: { operation: CreativeOperation }):
      Promise<{ status: "available" }> | { status: "available" };
    begin(input: { scope: TrustedScope; actor_id: string; action_id: string; request_hash: string; operation: CreativeOperation }):
      Promise<StartedJob | ExistingJob | ConflictingJob> | StartedJob | ExistingJob | ConflictingJob;
    /** The adapter must compare this fence in the same transaction that publishes the completed result. */
    completeIfActive(input: { scope: TrustedScope; actor_id: string; job_id: string; lease_token: string;
      action_id: string; operation: CreativeOperation; result: unknown; publication_fence: CreativeContextFence },
      publish: (transaction?: CreativePublicationTransaction) => Promise<unknown> | unknown):
      Promise<CompletedJob | CancelledJob | StaleContextJob> | CompletedJob | CancelledJob | StaleContextJob;
    failIfActive(input: { scope: TrustedScope; actor_id: string; job_id: string; lease_token: string;
      error: CreativeApiErrorShape }): Promise<FailedJobResult> | FailedJobResult;
    get(input: { scope: TrustedScope; job_id: string }): Promise<CreativeJobRecord | null> | CreativeJobRecord | null;
    cancel(input: { scope: TrustedScope; actor_id: string; job_id: string; target_action_id: string; action_id: string; request_hash: string }):
      Promise<CancelJobResult> | CancelJobResult;
    /** Atomically compare context_fence and linearize each dispatch intent with cancellation and lease ownership. */
    authorizeDispatch(input: DispatchAuthorizationInput): Promise<DispatchAuthorizationResult> | DispatchAuthorizationResult;
    /** Persist transport, provider, and usage identity references before artifact bytes are staged. */
    recordAttemptEvidence?(input: { scope: TrustedScope; actor_id: string; job_id: string; lease_token: string;
      action_id: string; request_hash: string; creation: CreativeVersionCreationEvidence }):
      Promise<{ status: "recorded" | "replayed" }> | { status: "recorded" | "replayed" };
  };
  provider?: {
    resolveRoute(input: { scope: TrustedScope; actor_id: string; operation: "generate" | "edit"; plan: EditPlan }):
      Promise<CreativeProviderRoute> | CreativeProviderRoute;
    generate(input: ProviderInput): Promise<ProviderOutput>;
    edit(input: ProviderInput): Promise<ProviderOutput>;
  };
  metering?: MeteringPort;
  /** Required by generate/edit/inspect and JEV-backed operations. The outbox shares durable API SQLite state. */
  telemetry?: CreativeTelemetryConfiguration;
  decisionPort?: {
    resolveRoute(input: { scope: TrustedScope; actor_id: string; decision: Pick<DecisionPortRequest, "execution_mode" | "state" | "questions"> }):
      Promise<CreativeProviderRoute> | CreativeProviderRoute;
    execute(input: DecisionDispatchInput): Promise<DecisionPortResult>;
  };
  inspection?: {
    resolveRoute(input: { scope: TrustedScope; actor_id: string; design_version: DesignVersion }):
      Promise<CreativeProviderRoute> | CreativeProviderRoute;
    inspect(input: InspectionInput): Promise<InspectionOutput>;
  };
  approval?: {
    verifyApproval: ApprovalVerifier["verifyApproval"];
  };
  handoff?: {
    resolveDestination(input: { scope: TrustedScope; actor_id: string; destination_ref: string }):
      Promise<{ expected_audience: string }>;
    submit(input: { scope: TrustedScope; actor_id: string; job_id: string; destination_ref: string;
      handoff: ArtworkHandoff; transport_attempt_id: string; dispatch_intent_ref: string }): Promise<ConsumptionReceipt>;
  };
  trace?: { record(event: Record<string, unknown>): Promise<void> | void };
}

export interface DesignSelection {
  tenant_id: string;
  project_id: string;
  brief_id: string;
  design_version_id: string;
  design_hash: string;
  revision: number;
}

export interface ProviderInput {
  scope: TrustedScope;
  actor_id: string;
  job_id: string;
  attempt: MeteredAttemptRequest;
  brief: CreativeBrief;
  base_design: DesignVersion | null;
  plan: EditPlan;
  decision_result?: DecisionPortResult;
  /** Exact reservation reference validated and returned by the trusted C03 authority. */
  readonly reservation_ref: string;
  transport_attempt_id: string;
  dispatch_intent_ref: string;
  recordTransportAttempt(transport_attempt_id: string): Promise<string>;
  signal: AbortSignal;
  deadline_at: string;
}

export interface CreativeProviderRoute {
  retry_mapping_ref: string;
  provider: MeteredAttemptRequest["provider"];
}

export interface DecisionDispatchInput extends Omit<MeteredDispatchContext, "recordTransportAttempt"> {
  scope: TrustedScope;
  actor_id: string;
  request: DecisionPortRequest;
  transport_attempt_id: string;
  deadline_at: string;
  dispatch_intent_ref: string;
  recordTransportAttempt(transport_attempt_id: string): Promise<string>;
}

export interface ProviderOutput {
  design_version_id?: string;
  artifact: { artifact_id: string; content_hash: string; media_type: string };
  /** Exact bytes for the declared artifact hash; runtime snapshots and verifies them before publication. */
  artifact_bytes: Uint8Array;
  provider: string;
  model: string;
  usage?: ProviderUsageRecord;
}

export interface InspectionInput {
  scope: TrustedScope;
  actor_id: string;
  job_id: string;
  attempt: MeteredAttemptRequest;
  brief: CreativeBrief;
  design_version: DesignVersion;
  /** Exact reservation reference validated and returned by the trusted C03 authority. */
  readonly reservation_ref: string;
  transport_attempt_id: string;
  dispatch_intent_ref: string;
  recordTransportAttempt(transport_attempt_id: string): Promise<string>;
  signal: AbortSignal;
  deadline_at: string;
}

export interface StructuredObservation {
  observer: { type: "human" | "model" | "system"; id: string };
  content_hash: string;
  uncertainty: { status: "measured" | "not_measured" | "unknown"; note?: string };
  summary: string;
  source_ref?: string;
}

export interface CreativeTelemetryEvidenceStatus {
  readonly local_status: "recorded" | "duplicate" | "pending";
  readonly pending_event_id?: string;
  readonly pending_event_staged?: boolean;
  /** Present only when the durable outbox retry path was unavailable. */
  readonly pending_event?: CreativeTelemetryEvidence;
  readonly pending_event_hash?: string;
}

export interface InspectionOutput {
  tenant_id: string;
  project_id: string;
  brief_id: string;
  design_version_id: string;
  artifact_id: string;
  artifact_hash: string;
  design_hash: string;
  inspection_id: string;
  observations: StructuredObservation[];
  usage?: ProviderUsageRecord;
  telemetry_evidence: CreativeTelemetryEvidenceStatus;
}

export type CreativeApiResult =
  | { design_version: DesignVersion; usage: UsageRecord; telemetry_evidence: CreativeTelemetryEvidenceStatus }
  | InspectionOutput
  | { items: DesignVersion[]; next_cursor: string | null }
  | { left: DesignVersion; right: DesignVersion; changed_fields: readonly string[] }
  | { selection: DesignSelection }
  | { handoff: ArtworkHandoff; receipt: ConsumptionReceipt | null };

export interface CreativeApiErrorResponse {
  ok: false;
  contract: "CreativeApiResponse";
  schema_version: "1.0";
  error: CreativeApiErrorShape;
}

export interface CreativeApiSuccessResponse {
  ok: true;
  contract: "CreativeApiResponse";
  schema_version: "1.0";
  operation_id?: string;
  replayed?: boolean;
  job?: CreativeJob;
  result?: CreativeApiResult;
}

export type CreativeApiResponse = CreativeApiSuccessResponse | CreativeApiErrorResponse;

export declare class CreativeApiError extends Error {
  constructor(code: CreativeErrorCode, operation?: CreativeOperation | "unknown", field?: string,
    options?: { retryable?: boolean; diagnostic_ref?: string });
  code: CreativeErrorCode;
  operation: CreativeOperation | "unknown";
  readonly module: "creative-engine.api";
  field: string;
  retryable: boolean;
  diagnostic_ref?: string;
}

export declare const CREATIVE_API_VERSION: "1.0";
export declare const CREATIVE_API_OPERATIONS: readonly CreativeOperation[];
export declare function createCreativeApi(options?: {
  ports?: CreativeRuntimePorts;
  now?: () => number;
  idFactory?: () => string;
}): { invoke(principal: TrustedCreativeActor, request: CreativeApiRequest): Promise<CreativeApiResponse> };
export declare const createCreativeRuntime: typeof createCreativeApi;
