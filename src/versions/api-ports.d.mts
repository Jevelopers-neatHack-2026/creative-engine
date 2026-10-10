import type {
  CreativeContextFence,
  CreativeInvalidationResult,
  CreativeOperation,
  CreativePublicationTransaction,
  CreativeRuntimePorts,
  CreativeVersionCreationEvidence,
  DesignSelection,
  PreparedDesignVersion,
  TrustedCreativeActor,
} from "../api/v1.mjs";
import type { TrustedScope } from "../contracts/creative/v1.mjs";
import type { CreativeVersionStore, VersionScope } from "./store.mjs";

type BaseStorage = NonNullable<CreativeRuntimePorts["storage"]>;
type BaseJobs = NonNullable<CreativeRuntimePorts["jobs"]>;
type BasePlanning = NonNullable<CreativeRuntimePorts["planning"]>;

export interface CreativeVersionRuntimeStorage extends BaseStorage {
  getBriefVersionByHash(input: { scope: TrustedScope; brief_id: string; brief_hash: string }):
    Promise<import("../contracts/creative/v1.mjs").CreativeBrief | null> |
    import("../contracts/creative/v1.mjs").CreativeBrief | null;
  isBriefUsable(input: { scope: TrustedScope; brief_id: string; brief_hash: string }): Promise<boolean> | boolean;
  isAssetFenced(input: { scope: TrustedScope; asset_id: string; content_hash: string }): Promise<boolean> | boolean;
  prepareDesignVersion(input: {
    scope: TrustedScope;
    brief_id: string;
    design_version: Parameters<NonNullable<BaseStorage["saveDesignVersion"]>>[0]["design_version"];
    artifact_bytes: Uint8Array;
    selection_mode: "advance" | "branch";
    creation: CreativeVersionCreationEvidence;
    lease_token: string;
    job_result: unknown;
    expected_brief_hash: string;
    expected_current_design_version_id: string | null;
    expected_current_design_hash: string | null;
    expected_parent_design_version_id: string | null;
    expected_parent_design_hash: string | null;
  }): Promise<PreparedDesignVersion>;
  commitPreparedDesignVersion(input: { scope: TrustedScope; brief_id: string; action_id: string;
    job_id: string; payload_hash: string }, transaction: CreativePublicationTransaction): Promise<{ status: "saved" | "stale" }>;
  selectDesignVersion(input: { scope: TrustedScope; brief_id: string; design_version_id: string;
    expected_brief_hash: string; expected_target_design_hash: string;
    expected_selected_design_version_id: string; expected_selected_design_hash: string;
    expected_selection_revision: number }, transaction?: CreativePublicationTransaction):
    Promise<{ status: "selected"; selection: DesignSelection } | { status: "stale" }>;
}

export interface CreativeVersionRuntimeJobs extends BaseJobs {
  assertOperationAvailable(input: { operation: CreativeOperation }): Promise<{ status: "available" }> | { status: "available" };
  recordAttemptEvidence(input: { scope: TrustedScope; actor_id: string; job_id: string; lease_token: string;
    action_id: string; request_hash: string; creation: CreativeVersionCreationEvidence }):
    Promise<{ status: "recorded" | "replayed" }>;
  authorizeDispatch(input: { scope: TrustedScope; actor_id: string; job_id: string; lease_token: string;
    action_id: string; operation: CreativeOperation; billable_attempt_id?: string; transport_attempt_id: string;
    context_fence: CreativeContextFence }): Promise<{ status: "authorized"; dispatch_intent_ref: string } |
      { status: "cancelled" | "lease_lost" | "stale_context" }>;
  completeIfActive(input: { scope: TrustedScope; actor_id: string; job_id: string; lease_token: string;
    action_id: string; operation: CreativeOperation; result: unknown; publication_fence: CreativeContextFence },
    publish: (transaction?: CreativePublicationTransaction) => Promise<unknown> | unknown):
    Promise<{ status: "completed"; job: NonNullable<Awaited<ReturnType<BaseJobs["get"]>>>; result?: unknown } |
      { status: "cancelled" | "stale_context"; job?: NonNullable<Awaited<ReturnType<BaseJobs["get"]>>> }>;
}

export type CreativeVersionRuntimePorts = Omit<CreativeRuntimePorts, "storage" | "jobs"> & {
  storage: CreativeVersionRuntimeStorage;
  jobs: CreativeVersionRuntimeJobs;
  planning: CreativeVersionRuntimePlanning;
};

export interface CreativeVersionRuntimePlanning extends Omit<BasePlanning, "applyInvalidation"> {
  getBriefAction(input: { scope: import("../planning/index.mjs").PlanningScope; actor_id: string; action_id: string;
    request_hash: string }): Promise<Readonly<{ status: "conflict" }> |
      Readonly<{ status: "replayed"; brief_hash: string; plan: import("../planning/index.mjs").CreativeBriefPlan }> | null>;
  saveBriefAction(input: { scope: import("../planning/index.mjs").PlanningScope; actor_id: string; action_id: string;
    request_hash: string; plan: import("../planning/index.mjs").CreativeBriefPlan; expected_brief_hash: string | null }):
    ReturnType<NonNullable<BasePlanning["saveBriefAction"]>>;
  getBriefVersionByHash(input: { scope: import("../planning/index.mjs").PlanningScope; brief_id: string; brief_hash: string }):
    Promise<import("../contracts/creative/v1.mjs").CreativeBrief | null> |
    import("../contracts/creative/v1.mjs").CreativeBrief | null;
  isBriefUsable(input: { scope: import("../planning/index.mjs").PlanningScope; brief_id: string; brief_hash: string }):
    Promise<boolean> | boolean;
  applyInvalidation(input: { trusted_scope: import("../planning/index.mjs").PlanningScope; actor_id: string;
    action_id: string; operation: "brief.invalidate"; request_hash: string; event_id: string }):
    Promise<Readonly<{ public_action_status: "conflict" }> |
      Readonly<{ public_action_status: "completed" | "pending" | "replayed"; invalidation: CreativeInvalidationResult }>>;
}

export interface CreateCreativeVersionApiPortsOptions {
  store: CreativeVersionStore;
  otherPorts?: CreativeRuntimePorts;
  idFactory?: () => string;
  leaseDurationMs?: number;
  faultInjector?: (point: string) => void;
}

export interface CreativeVersionApiPorts {
  readonly ports: CreativeVersionRuntimePorts;
  readonly storage: CreativeVersionRuntimeStorage;
  readonly jobs: CreativeVersionRuntimeJobs;
}

/** Pair the durable version store and CE-01 jobs/storage ports on one SQLite connection. */
export function createCreativeVersionApiPorts(options: CreateCreativeVersionApiPortsOptions): CreativeVersionApiPorts;
