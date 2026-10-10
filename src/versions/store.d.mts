import type { CreativeVersionCreationEvidence } from "../api/v1.mjs";
import type { CreativeBrief, DesignVersion, TrustedScope } from "../contracts/creative/v1.mjs";
import type { CreativePublicationTransaction, DesignSelection, PrivateProviderRequestAttribution,
  PrivateProviderUsageAttribution, PrivateProviderAttributionPending,
  PrivateProviderAttributionPendingResult } from "../api/v1.mjs";

export type VersionStoreErrorCode = "invalid_request" | "unsupported_version" | "scope_denied" | "not_found"
  | "conflict" | "stale_version" | "integrity_error" | "unknown_completion" | "unavailable" | "cancelled";

export class VersionStoreError extends Error {
  readonly code: VersionStoreErrorCode;
  readonly module: "creative-engine.versions";
  readonly field: string;
  readonly retryable: boolean;
  constructor(code: VersionStoreErrorCode, field?: string, retryable?: boolean);
}

export interface VersionScope extends TrustedScope { brief_id: string }
export type VersionSelectionInput =
  | { mode: "advance"; expected_revision: number; expected_selected_design_version_id: string | null;
      expected_selected_design_hash: string | null }
  | { mode: "branch" };

export interface VersionWriteInput {
  scope: VersionScope;
  brief_id: string;
  actor_id?: string;
  brief_snapshot: CreativeBrief;
  design_version: DesignVersion;
  artifact_bytes: Uint8Array;
  selection: VersionSelectionInput;
  creation: CreativeVersionCreationEvidence;
  configuration_snapshot?: Record<string, unknown>;
  job_result?: { design: DesignVersion; [key: string]: unknown };
  lease_token?: string;
}

export interface SavedVersion {
  status: "saved";
  design_version: DesignVersion;
  selection: DesignSelection | null;
  created_at: string;
  replayed: boolean;
}
export type BriefActionResult =
  | Readonly<{ status: "saved" | "replayed"; brief_hash: string; plan: import("../planning/index.mjs").CreativeBriefPlan }>
  | Readonly<{ status: "stale"; brief_hash: string | null }>
  | Readonly<{ status: "conflict" }>;
export interface StaleVersion { status: "stale"; code: "stale_version"; current: unknown; replayed?: boolean }
export interface PreparedVersion { status: "prepared"; action_id: string; job_id: string; payload_hash: string }
export type VersionWriteResult = SavedVersion | StaleVersion | PreparedVersion;

export class CreativeVersionStore {
  constructor(options: { databasePath: string; objectRoot: string; now?: () => number; maxArtifactBytes?: number });
  close(): void;
  getBrief(input: { scope: VersionScope | Omit<VersionScope, "brief_id">; brief_id: string }): CreativeBrief | null;
  getBriefAction(input: { scope: Omit<VersionScope, "brief_id">; actor_id: string; action_id: string; request_hash: string }):
    Readonly<{ status: "conflict" }> | Readonly<{ status: "replayed"; brief_hash: string; plan: import("../planning/index.mjs").CreativeBriefPlan }> | null;
  beginInvalidationAction(input: { scope: Omit<VersionScope, "brief_id">; actor_id: string; action_id: string;
    operation: "brief.invalidate"; request_hash: string; event_id: string }):
    Readonly<{ status: "started" | "pending" }> | Readonly<{ status: "conflict" }> |
    Readonly<{ status: "replayed"; result: import("../api/v1.mjs").CreativeInvalidationResult }>;
  completeInvalidationAction(input: { scope: Omit<VersionScope, "brief_id">; actor_id: string; action_id: string;
    operation: "brief.invalidate"; request_hash: string; event_id: string;
    result: import("../api/v1.mjs").CreativeInvalidationResult }):
    Readonly<{ status: "conflict" }> | Readonly<{ status: "completed" | "pending" | "replayed"; result: import("../api/v1.mjs").CreativeInvalidationResult }>;
  getBriefVersionByHash(input: { scope: VersionScope | Omit<VersionScope, "brief_id">; brief_id: string; brief_hash: string }): CreativeBrief | null;
  isBriefUsable(input: { scope: VersionScope | Omit<VersionScope, "brief_id">; brief_id: string; brief_hash?: string }): boolean;
  isAssetFenced(input: { scope: VersionScope | Omit<VersionScope, "brief_id">; asset_id: string; content_hash: string }): boolean;
  putBrief(input: { scope: TrustedScope; brief: CreativeBrief; expected_brief_hash?: string | null }):
    Readonly<{ status: "saved" | "stale"; brief_hash: string | null }>;
  saveBriefAction(input: { scope: TrustedScope; actor_id: string; action_id: string; request_hash: string;
    plan: import("../planning/index.mjs").CreativeBriefPlan; expected_brief_hash?: string | null }): BriefActionResult;
  recordAttemptEvidence(input: { scope: VersionScope; actor_id: string; job_id: string; lease_token: string;
    action_id: string; request_hash: string; creation: CreativeVersionCreationEvidence }):
    Readonly<{ status: "recorded" | "replayed" }>;
  /** Private backend-only request identity persistence; raw values are never returned by public job/version reads. */
  recordPrivateProviderAttribution(input: PrivateProviderRequestAttribution):
    import("../api/v1.mjs").PrivateProviderRequestAttributionResult;
  /** Retain bounded sanitized provider usage separately from any owner mapping or Finance settlement. */
  recordPrivateProviderUsageAttribution(input: PrivateProviderUsageAttribution):
    import("../api/v1.mjs").PrivateProviderUsageAttributionResult;
  stagePrivateProviderAttribution(input: PrivateProviderAttributionPending): PrivateProviderAttributionPendingResult;
  reconcilePrivateProviderAttributions(input: { scope: VersionScope; limit?: number }):
    Readonly<{ reconciled: number; remaining: number }>;
  saveDesignVersion(input: VersionWriteInput, options?: { faultInjector?: (point: string) => void }): Promise<VersionWriteResult>;
  prepareDesignVersion(input: VersionWriteInput, options?: { faultInjector?: (point: string) => void }): Promise<VersionWriteResult>;
  commitPreparedDesignVersion(input: { scope: VersionScope; brief_id: string; action_id: string; job_id: string;
    payload_hash: string }, transaction: CreativePublicationTransaction): Promise<VersionWriteResult>;
  recover(): Promise<Readonly<{ examined: number; committed: number; conflicts: number; unknown: number }>>;
  getDesignVersion(input: { scope: VersionScope; brief_id: string; design_version_id: string }): DesignVersion | null;
  getArtifactBytes(input: { scope: VersionScope; brief_id: string; design_version_id: string }): Promise<Uint8Array | null>;
  getSelection(input: { scope: VersionScope; brief_id: string }): DesignSelection | null;
  getCurrentDesignVersion(input: { scope: VersionScope; brief_id: string }): DesignVersion | null;
  listDesignVersions(input: { scope: VersionScope; brief_id: string; limit?: number;
    after?: { occurred_at: string; design_version_id: string } | null }): { items: DesignVersion[]; has_more: boolean };
  compareDesignVersions(input: { scope: VersionScope; brief_id: string; left_design_version_id: string;
    right_design_version_id: string }): { left: DesignVersion; right: DesignVersion; changed_fields: string[] };
  selectDesignVersion(input: { scope: VersionScope; brief_id: string; design_version_id: string;
    expected_brief_hash: string; expected_target_design_hash: string; expected_selected_design_version_id: string | null;
    expected_selected_design_hash: string | null; expected_selection_revision: number },
    transaction?: CreativePublicationTransaction): Promise<{ status: "selected"; selection: DesignSelection } | { status: "stale" }>;
}
