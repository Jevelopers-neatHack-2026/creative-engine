export type Environment = "development" | "test" | "production";
export type BillingMode = "live" | "sandbox" | "simulated";
export type SectionPresence = "absent" | "unknown" | "present";
export type FactStatus = "verified" | "conflicting" | "unknown";
export type PermissionStatus = "granted" | "denied" | "unknown";

export interface TrustedScope {
  tenant_id: string;
  project_id: string;
  job_id?: string;
  artifact_id?: string;
  design_version_id?: string;
  brief_id?: string;
}

export interface CommonEnvelope {
  contract: string;
  schema_version: string;
  event_id: string;
  tenant_id: string;
  project_id: string;
  correlation_id: string;
  producer: string;
  occurred_at: string;
  ingested_at: string;
  environment: Environment;
  billing_mode: BillingMode;
  source_refs: string[];
  workflow_id?: string;
  run_id?: string;
  order_id?: string;
  job_id?: string;
  design_version_id?: string;
  artifact_id?: string;
  logical_operation_id?: string;
  billable_attempt_id?: string;
  transport_attempt_id?: string;
  provider_request_id?: string;
}

export interface PresenceSection<T> {
  presence: SectionPresence;
  items: T[];
}

export interface SourceIdentity {
  source_id: string;
  uri: string;
  retrieved_at?: string;
  retrieved_at_status?: "unknown";
  content_hash?: string;
  [futureField: string]: unknown;
}

export interface FactProvenance {
  source_id: string;
  retrieved_at?: string;
  retrieved_at_status?: "unknown";
  evidence_ref?: string;
  [futureField: string]: unknown;
}

export interface ResearchFact {
  fact_id: string;
  key: string;
  status: FactStatus;
  value?: unknown;
  candidate_values?: unknown[];
  provenance: FactProvenance[];
  [futureField: string]: unknown;
}

export interface ResearchAsset {
  asset_id: string;
  source_id: string;
  content_hash: string;
  media_type: string;
  [futureField: string]: unknown;
}

export interface ResearchPermission {
  asset_id: string;
  action: "reproduce" | "modify" | "publish" | "display";
  status: PermissionStatus;
  evidence_refs: string[];
  [futureField: string]: unknown;
}

export interface EventIntelligencePackage extends CommonEnvelope {
  contract: "EventIntelligencePackage";
  schema_version: "1.1";
  package_id: string;
  source_identity: SourceIdentity[];
  facts: ResearchFact[];
  assets: PresenceSection<ResearchAsset>;
  preferences: PresenceSection<Record<string, unknown>>;
  interpretations: PresenceSection<Record<string, unknown>>;
  permissions: PresenceSection<ResearchPermission>;
  locks: PresenceSection<Record<string, unknown>>;
  security_redactions?: Array<{
    field_path: string;
    reason: "credential_material_omitted";
  }>;
  migration?: Record<string, unknown>;
  [futureField: string]: unknown;
}

/** ResearchPackage is a local consumer type alias for EventIntelligencePackage. */
export type ResearchPackage = EventIntelligencePackage;

export type LegacyEventIntelligencePackage = Omit<EventIntelligencePackage, "schema_version" | "source_identity" | "facts" | "permissions"> & {
  schema_version: "1.0";
  source_identity?: SourceIdentity[];
  sources?: SourceIdentity[];
  facts: Array<Omit<ResearchFact, "status"> & { value?: unknown; status?: string }>;
  permissions?: unknown;
};

export type ResearchPackageAlias = Omit<EventIntelligencePackage, "contract"> & { contract: "ResearchPackage" };
export type LegacyResearchPackageAlias = Omit<LegacyEventIntelligencePackage, "contract"> & { contract: "ResearchPackage" };

export interface CreativeBrief extends CommonEnvelope {
  contract: "CreativeBrief";
  schema_version: "1.0";
  brief_id: string;
  research_package_ref: {
    contract: "EventIntelligencePackage";
    schema_version: string;
    package_id: string;
    content_hash: string;
  };
  source_identity: Array<Pick<SourceIdentity, "source_id" | "uri">>;
  facts: {
    verified: Array<{
      fact_id: string;
      key: string;
      value: unknown;
      provenance_refs: string[];
    }>;
    unresolved: Array<{
      fact_id: string;
      key: string;
      status: "conflicting" | "unknown";
      candidate_values?: unknown[];
      provenance_refs: string[];
    }>;
  };
  preferences: PresenceSection<Record<string, unknown>>;
  interpretations: PresenceSection<Record<string, unknown>>;
  permissions: PresenceSection<ResearchPermission>;
  locks: PresenceSection<Record<string, unknown>>;
  [futureField: string]: unknown;
}

export interface DesignControlSchema extends CommonEnvelope {
  contract: "DesignControlSchema";
  schema_version: "1.0";
  control_contract: "creative-controls";
  control_schema_version: "1.0" | "1.1";
  expected_versions: {
    brief: string;
    design: string;
    composition: string;
  };
  control_schema_hash: string;
  [futureField: string]: unknown;
}

export type EditAction =
  | "concept.generate"
  | "image.edit"
  | "composition.update"
  | "correction.apply";

export type EditStep = {
  step_id: string;
  action: EditAction;
  source_refs: string[];
  parameters:
    | { brief_id: string; variant_count: number; style_ref?: string }
    | { design_version_id: string; artifact_id: string; instruction: string; mask_source_ref?: string }
    | { design_version_id: string; changes: Array<{ field: string; value: unknown; asset_id?: string }> }
    | { design_version_id: string; fact_id: string; replacement_value: unknown; evidence_refs: string[] };
};

export interface EditPlan extends CommonEnvelope {
  contract: "EditPlan";
  schema_version: "1.0";
  plan_id: string;
  base: {
    brief_hash: string;
    design_hash: string;
    design_version_id?: string;
  };
  operation: EditAction;
  source_refs: string[];
  steps: EditStep[];
  expected_result: {
    contract: "DesignVersion";
    schema_version: "1.0";
    parent_version_id: string;
    artifact_kind: "image";
  };
  invalidates: string[];
  [futureField: string]: unknown;
}

export interface DesignVersion extends CommonEnvelope {
  contract: "DesignVersion";
  schema_version: "1.0";
  design_version_id: string;
  parent_version_id: string | null;
  brief_hash: string;
  source_refs: string[];
  artifact: {
    artifact_id: string;
    content_hash: string;
    media_type: string;
  };
  design_hash: string;
  [futureField: string]: unknown;
}

export interface ContractErrorShape {
  code: string;
  contract: string;
  field: string;
}

export declare class ContractError extends Error implements ContractErrorShape {
  constructor(code: string, contract: string, field: string, message: string);
  code: string;
  contract: string;
  field: string;
}

export declare const CREATIVE_CONTRACT_VERSIONS: Readonly<{
  EventIntelligencePackage: "1.1";
  CreativeBrief: "1.0";
  DesignControlSchema: "1.0";
  EditPlan: "1.0";
  DesignVersion: "1.0";
}>;

export declare const SUPPORTED_RESEARCH_PACKAGE_VERSIONS: readonly ["1.0", "1.1"];

export declare function normalizeResearchPackage(
  value: LegacyEventIntelligencePackage | EventIntelligencePackage | ResearchPackageAlias | LegacyResearchPackageAlias | Record<string, unknown>,
  trustedScope: TrustedScope,
): EventIntelligencePackage;
export declare function validateResearchPackage(
  value: LegacyEventIntelligencePackage | EventIntelligencePackage | ResearchPackageAlias | LegacyResearchPackageAlias | Record<string, unknown>,
  trustedScope: TrustedScope,
): EventIntelligencePackage;
export declare function assessResearchReadiness(value: EventIntelligencePackage): {
  state: "ready" | "incomplete";
  reasons: string[];
};
export declare function validateCreativeBrief(
  value: CreativeBrief | Record<string, unknown>,
  options: { trustedScope: TrustedScope; researchPackage?: EventIntelligencePackage | LegacyEventIntelligencePackage },
): CreativeBrief;
export declare function validateDesignControlSchema(
  value: DesignControlSchema | Record<string, unknown>,
  options: { trustedScope: TrustedScope; controlSchemaPayload?: Record<string, unknown> },
): DesignControlSchema;
export declare function validateEditPlan(
  value: EditPlan | Record<string, unknown>,
  options: {
    trustedScope: TrustedScope;
    brief_hash?: string;
    design_hash?: string;
    known_source_refs?: string[];
    design_version_ids?: string[];
    known_artifact_ids?: string[];
    known_asset_ids?: string[];
    known_fact_ids?: string[];
  },
): EditPlan;
export declare function computeDesignVersionHash(value: Omit<DesignVersion, "design_hash"> | DesignVersion): string;
export declare function validateDesignVersion(
  value: DesignVersion | Record<string, unknown>,
  options: { trustedScope: TrustedScope; brief_hash?: string; known_source_refs?: string[]; design_version_ids?: string[] },
): DesignVersion;
export declare function validateCreativeScope<T extends Record<string, unknown>>(
  value: T,
  trustedScope: TrustedScope,
  contract?: string,
): T;
