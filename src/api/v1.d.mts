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
}

export type DispatchAuthorizationResult =
  | { status: "authorized"; dispatch_intent_ref: string }
  | { status: "cancelled" | "lease_lost" };

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
      payload: { brief_id: string; design_version_id: string; plan: EditPlan; decision_request?: CreativeDecisionInput } })
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
export type CancelJobResult =
  | { kind: "cancelled" | "replayed"; job: CreativeJobRecord }
  | { kind: "not_found" | "conflict" };
export type FailedJobResult =
  | { status: "failed"; job: CreativeJobRecord }
  | { status: "cancelled"; job: CreativeJobRecord };

export interface UsageRecord {
  completeness: "complete" | "incomplete" | "unknown";
  input_tokens?: number;
  output_tokens?: number;
  reason?: "usage_unavailable" | "usage_malformed";
}

export interface CreativeRuntimePorts {
  storage?: {
    getBrief(input: { scope: TrustedScope; brief_id: string }): Promise<CreativeBrief | null> | CreativeBrief | null;
    getDesignVersion(input: { scope: TrustedScope; brief_id: string; design_version_id: string }): Promise<DesignVersion | null> | DesignVersion | null;
    getCurrentDesignVersion(input: { scope: TrustedScope; brief_id: string }): Promise<DesignVersion | null> | DesignVersion | null;
    getSelection(input: { scope: TrustedScope; brief_id: string }): Promise<DesignSelection | null> | DesignSelection | null;
    listDesignVersions(input: { scope: TrustedScope; brief_id: string; limit: number;
      after?: { occurred_at: string; design_version_id: string } }): Promise<{ items: DesignVersion[]; has_more: boolean }>;
    saveDesignVersion(input: { scope: TrustedScope; brief_id: string; design_version: DesignVersion;
      expected_current_design_version_id: string | null }): Promise<{ status: "saved" | "stale" }> | { status: "saved" | "stale" };
    selectDesignVersion(input: { scope: TrustedScope; brief_id: string; design_version_id: string;
      expected_selection_revision: number }): Promise<{ status: "selected"; selection: DesignSelection } | { status: "stale" }> |
      { status: "selected"; selection: DesignSelection } | { status: "stale" };
    getHandoffContext(input: { scope: TrustedScope; brief_id: string; design_version_id: string }): Promise<{
      binding: ApprovalBinding;
      artifact: HandoffArtifact;
      layer_manifest: HandoffLayer[];
    } | null> | { binding: ApprovalBinding; artifact: HandoffArtifact; layer_manifest: HandoffLayer[] } | null;
  };
  jobs?: {
    begin(input: { scope: TrustedScope; actor_id: string; action_id: string; request_hash: string; operation: CreativeOperation }):
      Promise<StartedJob | ExistingJob | ConflictingJob> | StartedJob | ExistingJob | ConflictingJob;
    completeIfActive(input: { scope: TrustedScope; actor_id: string; job_id: string; lease_token: string; result: unknown },
      publish: () => Promise<unknown>): Promise<CompletedJob | CancelledJob> | CompletedJob | CancelledJob;
    failIfActive(input: { scope: TrustedScope; actor_id: string; job_id: string; lease_token: string;
      error: CreativeApiErrorShape }): Promise<FailedJobResult> | FailedJobResult;
    get(input: { scope: TrustedScope; job_id: string }): Promise<CreativeJobRecord | null> | CreativeJobRecord | null;
    cancel(input: { scope: TrustedScope; actor_id: string; job_id: string; target_action_id: string; action_id: string; request_hash: string }):
      Promise<CancelJobResult> | CancelJobResult;
    /** Atomically linearize a dispatch intent with cancellation and lease ownership. */
    authorizeDispatch(input: DispatchAuthorizationInput): Promise<DispatchAuthorizationResult> | DispatchAuthorizationResult;
  };
  provider?: {
    resolveRoute(input: { scope: TrustedScope; actor_id: string; operation: "generate" | "edit"; plan: EditPlan }):
      Promise<CreativeProviderRoute> | CreativeProviderRoute;
    generate(input: ProviderInput): Promise<ProviderOutput>;
    edit(input: ProviderInput): Promise<ProviderOutput>;
  };
  metering?: MeteringPort;
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
  deadline_at: string;
  dispatch_intent_ref: string;
  recordTransportAttempt(transport_attempt_id: string): Promise<string>;
}

export interface ProviderOutput {
  design_version_id?: string;
  artifact: { artifact_id: string; content_hash: string; media_type: string };
  provider: string;
  model: string;
  usage?: UsageRecord;
}

export interface InspectionInput {
  scope: TrustedScope;
  actor_id: string;
  job_id: string;
  attempt: MeteredAttemptRequest;
  brief: CreativeBrief;
  design_version: DesignVersion;
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
  usage?: UsageRecord;
}

export type CreativeApiResult =
  | { design_version: DesignVersion; usage: UsageRecord }
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
