import type { CreativeBrief, EventIntelligencePackage, TrustedScope } from "../contracts/creative/v1.mjs";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type PlanningScope = Pick<TrustedScope, "tenant_id" | "project_id">;

export declare const CREATIVE_BRIEF_PLANNER_VERSION: "creative-engine.planning/1.0";
export declare const CREATIVE_BRIEF_REQUIRED_FACT_KEYS: readonly ["event_name", "event_date"];

export declare class CreativePlanningError extends Error {
  constructor(code: string, message: string, field?: string);
  readonly code: string;
  readonly field?: string;
}

export interface BriefPlanningContext {
  readonly created_at: string;
  readonly environment: "development" | "test" | "production";
  readonly billing_mode: "live" | "sandbox" | "simulated";
  readonly correlation_id?: string;
}

export interface CustomerPreference {
  readonly preference_id: string;
  readonly value: string;
}

export interface CustomerInterpretation {
  readonly interpretation_id: string;
  readonly text: string;
}

export interface CustomerFactCorrection {
  readonly fact_id: string;
  readonly proposed_value: JsonValue;
}

export interface CustomerLock {
  readonly field: string;
  readonly reason: string;
}

export interface BuildCreativeBriefInput {
  readonly trusted_scope: PlanningScope;
  readonly research_package: EventIntelligencePackage | Record<string, unknown>;
  readonly context: BriefPlanningContext;
  readonly customer_preferences?: readonly CustomerPreference[];
  readonly artistic_intent?: readonly CustomerInterpretation[];
  readonly additional_required_fact_keys?: readonly string[];
  readonly fact_corrections?: readonly CustomerFactCorrection[];
  readonly locked_fields?: readonly CustomerLock[];
}

export interface RequiredFactResult {
  readonly fact_key: string;
  readonly status: "ready" | "missing" | "unknown" | "conflicting";
  readonly clarification_id?: string;
  readonly question?: string;
  readonly source_fact_ids?: readonly string[];
}

export interface CreativeBriefPlan {
  readonly contract: "CreativeBriefPlan";
  readonly schema_version: "1.0";
  readonly brief: CreativeBrief;
  readonly brief_hash: string;
  readonly plan_hash: string;
  readonly research_provenance: {
    readonly package_id: string;
    readonly package_hash: string;
    readonly package_schema_version: string;
    readonly facts: readonly Record<string, unknown>[];
  };
  readonly required_facts: readonly RequiredFactResult[];
  readonly clarification_requests: readonly RequiredFactResult[];
  readonly correction_requests: readonly Record<string, unknown>[];
  readonly asset_readiness: readonly Record<string, unknown>[];
  readonly original_artwork_alternative: Readonly<{
    available_when_assets_blocked: true;
    uses_research_assets: false;
    preserves_verified_fact_ids: readonly string[];
  }>;
  readonly execution_policy: Readonly<{
    deterministic_only: true;
    provider_calls: 0;
    provider_dispatch_allowed: false;
    budget_mutation_allowed: false;
    asset_permission_mutation_allowed: false;
    external_acceptance: "pending";
  }>;
}

export interface ResearchInvalidationEventInput {
  readonly event_id: string;
  readonly tenant_id: string;
  readonly project_id: string;
  readonly source_package_id: string;
  readonly source_package_hash: string;
  readonly source_revision: number;
  readonly occurred_at: string;
  readonly kind: "fact" | "asset";
  readonly reason:
    | "fact_corrected"
    | "fact_source_changed"
    | "asset_permission_revoked"
    | "asset_permission_expired"
    | "source_freshness_expired";
  readonly fact_ids?: readonly string[];
  readonly assets?: readonly { readonly asset_id: string; readonly content_hash: string }[];
  readonly affected_briefs?: readonly { readonly brief_id: string; readonly brief_hash: string }[];
}

export interface NormalizedResearchInvalidation {
  readonly schema: "creative-research-invalidation/1.0";
  readonly event_id: string;
  readonly tenant_id: string;
  readonly project_id: string;
  readonly source_package_id: string;
  readonly source_package_hash: string;
  readonly source_revision: number;
  readonly occurred_at: string;
  readonly kind: "fact" | "asset";
  readonly reason: ResearchInvalidationEventInput["reason"];
  readonly affected: readonly (
    | { readonly kind: "fact"; readonly fact_id: string }
    | { readonly kind: "asset"; readonly asset_id: string; readonly content_hash: string; readonly action: "reproduce" }
  )[];
  readonly affected_briefs: readonly { readonly brief_id: string; readonly brief_hash: string }[];
  readonly content_hash: string;
  readonly idempotency_key: string;
}

export interface TrustedInvalidationEvidence {
  readonly status: "verified";
  readonly classification: "owner_verified" | "synthetic_test";
  readonly evidence_ref: string;
  readonly event_hash: string;
  readonly event_id: string;
  readonly tenant_id: string;
  readonly project_id: string;
  readonly verified_at: string;
  readonly valid_until: string;
}

export interface BriefVersionReceipt {
  readonly tenant_id: string;
  readonly project_id: string;
  readonly brief_id: string;
  readonly version_no: number;
  readonly brief_hash: string;
  readonly source_package_id: string;
  readonly source_package_hash: string;
  readonly created_at: string;
  readonly brief: CreativeBrief;
}

export interface ApprovalStalenessRequest {
  readonly request_id: string;
  readonly event_id: string;
  readonly brief_id: string;
  readonly brief_hash: string;
  readonly tenant_id: string;
  readonly project_id: string;
}

export interface InvalidationReceipt {
  readonly receipt_id: string;
  readonly event_id: string;
  readonly event_hash: string;
  readonly idempotency_key: string;
  readonly tenant_id: string;
  readonly project_id: string;
  readonly source_package_id: string;
  readonly source_revision: number;
  readonly approval_requests: readonly (ApprovalStalenessRequest & { readonly status: "pending" | "acknowledged" })[];
  readonly verification_classification: "owner_verified" | "synthetic_test";
}

export interface ProducerAcknowledgment {
  readonly status: "acknowledged";
  readonly event_id: string;
  readonly event_hash: string;
  readonly idempotency_key: string;
  readonly tenant_id: string;
  readonly project_id: string;
}

export interface CreativeBriefStore {
  /** Fails closed if this connection is in, or cannot identify, a caller-owned transaction. */
  assertInvalidationBoundary(): void;
  appendBriefVersion(input: { readonly brief: CreativeBrief; readonly brief_hash: string; readonly created_at: string }): BriefVersionReceipt;
  getBriefHistory(briefId: string): readonly BriefVersionReceipt[];
  getBriefVersion(briefId: string, versionNo: number): BriefVersionReceipt | null;
  getInvalidationReceipt(tenantId: string, projectId: string, eventId: string): InvalidationReceipt | null;
  persistInvalidationAndFences(event: NormalizedResearchInvalidation, evidence: TrustedInvalidationEvidence): InvalidationReceipt;
  listPendingApprovalStaleness(tenantId: string, projectId: string, eventId: string): readonly ApprovalStalenessRequest[];
  recordApprovalStalenessAcknowledgment(response: ApprovalStalenessRequest & { readonly status: "acknowledged" }): ApprovalStalenessRequest & { readonly status: "acknowledged" };
  getProducerAcknowledgment(tenantId: string, projectId: string, eventId: string): ProducerAcknowledgment | null;
  recordProducerAcknowledgment(response: ProducerAcknowledgment): ProducerAcknowledgment;
  isAssetFenced(tenantId: string, projectId: string, assetId: string, contentHash: string): boolean;
  isFactFenced(tenantId: string, projectId: string, packageId: string, packageHash: string, factId: string): boolean;
  isPackageFenced(tenantId: string, projectId: string, packageId: string, packageHash: string): boolean;
  getInvalidationHistory(): readonly Readonly<Record<string, string | number>>[];
  close(): void;
}

export interface SqliteStatement {
  get(...parameters: unknown[]): Record<string, unknown> | undefined;
  all(...parameters: unknown[]): Record<string, unknown>[];
  run(...parameters: unknown[]): unknown;
}

export interface SqliteDatabase {
  readonly isTransaction?: boolean;
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close?(): void;
}

export declare function buildCreativeBrief(input: BuildCreativeBriefInput): CreativeBriefPlan;
export declare function createResearchInvalidationRequest(input: {
  readonly trusted_scope: PlanningScope;
  readonly event: ResearchInvalidationEventInput;
}): NormalizedResearchInvalidation;

export declare function applyResearchInvalidation(input: {
  readonly trusted_scope: PlanningScope;
  readonly event: ResearchInvalidationEventInput;
  readonly ports: {
    readonly clock: { now(): string };
    readonly store: CreativeBriefStore;
    readonly verifier: { verifyInvalidation(input: {
      event: NormalizedResearchInvalidation;
      trusted_scope: PlanningScope;
      now: string;
    }): Promise<TrustedInvalidationEvidence> };
    readonly approvalStaleness?: {
      markBriefStale(request: ApprovalStalenessRequest): Promise<ApprovalStalenessRequest & { readonly status: "acknowledged" }>;
    };
    readonly producerAcknowledgment?: {
      acknowledgeInvalidation(input: {
        event_id: string;
        idempotency_key: string;
        event_hash: string;
        durable_receipt_id: string;
        tenant_id: string;
        project_id: string;
      }): Promise<ProducerAcknowledgment>;
    };
  };
}): Promise<Readonly<{
  event_id: string;
  event_hash: string;
  durable_receipt: InvalidationReceipt;
  approval_staleness: {
    requested: number;
    acknowledged: number;
    status: "acknowledged" | "pending";
    receipts: readonly (ApprovalStalenessRequest & { readonly status: "acknowledged" })[];
  };
  producer_acknowledgment: ProducerAcknowledgment | null;
  verification_classification: "owner_verified" | "synthetic_test";
}>>;

export interface AssetPermissionEvidence {
  readonly status: "granted" | "denied" | "unknown";
  readonly tenant_id: string;
  readonly project_id: string;
  readonly asset_id: string;
  readonly content_hash: string;
  readonly action: "reproduce" | "modify";
  readonly package_id: string;
  readonly package_hash: string;
  readonly owner_evidence_status: "verified" | "unknown";
  readonly evidence_ref: string;
  readonly checked_at: string;
  readonly expires_at: string;
}

export declare function resolveAssetUse(input: {
  readonly trusted_scope: PlanningScope;
  readonly plan: CreativeBriefPlan;
  readonly research_package: EventIntelligencePackage | Record<string, unknown>;
  readonly clock?: { now(): string };
  readonly permission_verifier?: {
    verifyAssetUse(input: {
      tenant_id: string;
      project_id: string;
      asset_id: string;
      content_hash: string;
      action: "reproduce";
      package_id: string;
      package_hash: string;
      now: string;
    }): Promise<AssetPermissionEvidence>;
  };
  readonly invalidation_store?: Pick<CreativeBriefStore, "isAssetFenced">;
}): Promise<Readonly<{
  decisions: readonly Readonly<Record<string, unknown>>[];
  eligible_asset_refs: readonly { readonly asset_id: string; readonly content_hash: string }[];
  original_artwork_alternative: { readonly available: boolean; readonly uses_research_assets: false };
  dispatch_authorized: false;
  downstream_must_revalidate_at_use: true;
}>>;

export declare function persistCreativeBrief(
  store: Pick<CreativeBriefStore, "appendBriefVersion">,
  plan: CreativeBriefPlan,
  trustedScope: PlanningScope,
): BriefVersionReceipt;

export declare function createCreativeBriefStore(input: {
  readonly database: SqliteDatabase;
  readonly trustedScope: PlanningScope;
}): CreativeBriefStore;
export declare function initializeCreativeBriefDatabase(database: SqliteDatabase): void;
export declare function openCreativeBriefStore(path: string, trustedScope: PlanningScope): CreativeBriefStore;
