export declare const APPROVAL_HANDOFF_PROPOSAL_VERSION: 'creative.approval-handoff.proposal/v1';
export declare const COMPOSITION_EDIT_PROPOSAL_VERSION: 'creative.composition-edit.proposal/v1';

export interface TrustedApprovalScope {
  tenant_id: string;
  project_id: string;
}

export interface ApprovedAssetBinding {
  asset_id: string;
  sha256: string;
  permission_ref: string;
  intended_use: string;
}

export interface ApprovalBinding extends TrustedApprovalScope {
  design_version: { design_version_id: string; artwork_sha256: string };
  brief: { brief_id: string; sha256: string };
  facts: { revision_id: string; sha256: string };
  assets: ApprovedAssetBinding[];
  composition: { composition_id: string; revision_id: string; sha256: string };
  preview_sha256: string;
  action_id?: string;
  actor_id?: string;
}

export interface HandoffArtifact {
  artifact_id: string;
  locator_ref: string;
  sha256: string;
  mime_type: string;
  width_px: number;
  height_px: number;
  access_policy_ref: string;
}

export type ArtworkLayer = { layer_id: string; kind: 'artwork'; artifact_id: string; sha256: string };
export type TextLayer = { layer_id: string; kind: 'text'; role: string; value: string };
export type ApprovedAssetLayer = {
  layer_id: string;
  kind: 'approved_asset';
  asset_id: string;
  asset_sha256: string;
  permission_ref: string;
  artifact: HandoffArtifact;
};
export type HandoffLayer = ArtworkLayer | TextLayer | ApprovedAssetLayer;

export interface ApprovalProof {
  approval_reference: string;
  approval_id: string;
  issuer_id: string;
  audience: string;
  issued_at: string;
  expires_at: string;
  key_id: string;
  key_set_version: string;
  revocation: { status: 'active'; checked_at: string; record_ref: string };
}

export interface ArtworkHandoff {
  schema_version: typeof APPROVAL_HANDOFF_PROPOSAL_VERSION;
  handoff_id: string;
  binding: ApprovalBinding;
  artifact: HandoffArtifact;
  artifact_access: {
    policy_ref: string;
    renewal_policy: 'reauthorize_each_fetch';
    bearer_url_included: false;
  };
  layer_manifest: HandoffLayer[];
  approval: ApprovalProof;
  trace_refs: string[];
  usage_refs: string[];
}

export interface ApprovalVerificationRequest {
  approval_reference: string;
  expected_audience: string;
  expected_binding: ApprovalBinding;
  trusted_scope: TrustedApprovalScope;
}

export type ApprovalVerification =
  | { status: 'valid'; approval: ApprovalProof; verified_binding: ApprovalBinding }
  | { status: 'rejected' | 'stale' | 'expired' | 'revoked' | 'unavailable'; approval?: ApprovalProof; verified_binding?: ApprovalBinding };

export interface ApprovalVerifier {
  verifyApproval(request: ApprovalVerificationRequest): Promise<ApprovalVerification> | ApprovalVerification;
}

export interface ConsumptionReceipt {
  schema_version: typeof APPROVAL_HANDOFF_PROPOSAL_VERSION;
  receipt_id: string;
  consumer_id: string;
  tenant_id: string;
  project_id: string;
  handoff_id: string;
  approval_id: string;
  design_version_id: string;
  binding_sha256: string;
  composition_sha256: string;
  layer_manifest_sha256: string;
  approval_proof_sha256: string;
  consumed_artifacts: Array<{
    artifact_id: string;
    sha256: string;
    mime_type: string;
    width_px: number;
    height_px: number;
  }>;
  verified_layer_ids: string[];
  access_grants: Array<{ artifact_id: string; grant_ref: string }>;
  consumed_at: string;
  status: 'consumed_exact_bytes';
}

export interface CompositionLayout {
  x_milli: number;
  y_milli: number;
  width_milli?: number;
  height_milli?: number;
}

export type CompositionOperation =
  | { operation_id: string; kind: 'set_text'; layer_id: string; value: string }
  | { operation_id: string; kind: 'set_text_size'; layer_id: string; size: { value: string; unit: 'pt' | 'px' } }
  | { operation_id: string; kind: 'set_layer_layout'; layer_id: string; layout: CompositionLayout }
  | { operation_id: string; kind: 'position_approved_logo'; layer_id: string; asset_id: string; layout: CompositionLayout };

export interface CompositionEditPlan {
  schema_version: typeof COMPOSITION_EDIT_PROPOSAL_VERSION;
  plan_id: string;
  tenant_id: string;
  project_id: string;
  base_design_version_id: string;
  base_artwork_sha256: string;
  base_brief_id: string;
  base_brief_sha256: string;
  base_facts_revision_id: string;
  base_facts_sha256: string;
  base_composition_id: string;
  base_composition_revision_id: string;
  base_composition_sha256: string;
  target_composition_revision_id: string;
  operations: CompositionOperation[];
  approval_required_after_application: true;
}

export declare class ApprovalHandoffContractError extends Error {
  constructor(code: string, message: string, options?: { field?: string; retryable?: boolean });
  readonly code: string;
  readonly field?: string;
  readonly retryable: boolean;
}

export declare function validateApprovalBinding(value: unknown, trustedScope: TrustedApprovalScope): ApprovalBinding;

export declare function hashCompositionLayerManifest(args: {
  binding: ApprovalBinding;
  artifact: HandoffArtifact;
  layer_manifest: HandoffLayer[];
  trustedScope: TrustedApprovalScope;
}): string;

export declare function createArtworkHandoff(args: {
  approvalVerifier: ApprovalVerifier;
  approval_reference: string;
  expected_audience: string;
  binding: ApprovalBinding;
  artifact: HandoffArtifact;
  layer_manifest: HandoffLayer[];
  handoff_id: string;
  trustedScope: TrustedApprovalScope;
  trace_refs?: string[];
  usage_refs?: string[];
  now?: Date;
}): Promise<ArtworkHandoff>;

export declare function validateArtworkHandoff(
  value: unknown,
  trustedScope: TrustedApprovalScope,
  options?: { now?: Date },
): ArtworkHandoff;

export declare function verifyHandoffApproval(args: {
  approvalVerifier: ApprovalVerifier;
  handoff: ArtworkHandoff;
  expected_audience: string;
  trustedScope: TrustedApprovalScope;
  now?: Date;
}): Promise<ApprovalProof>;

export declare function verifyHandoffArtifacts(args: {
  handoff: ArtworkHandoff;
  artifactBytesById: Record<string, Uint8Array>;
  trustedScope: TrustedApprovalScope;
  now?: Date;
}): {
  handoff_id: string;
  verified_layer_ids: string[];
  artifacts: ConsumptionReceipt['consumed_artifacts'];
};

export declare function createConsumptionReceipt(args: {
  handoff: ArtworkHandoff;
  artifactBytesById: Record<string, Uint8Array>;
  trustedScope: TrustedApprovalScope;
  consumer_id: string;
  receipt_id: string;
  access_grants: Array<{ artifact_id: string; grant_ref: string }>;
  consumed_at: string;
  now?: Date;
}): ConsumptionReceipt;

export declare function validateConsumptionReceipt(
  value: unknown,
  handoff: ArtworkHandoff,
  options: { trustedScope: TrustedApprovalScope; now?: Date },
): ConsumptionReceipt;

export declare function createCompositionEditPlan(args: {
  plan_id: string;
  binding: ApprovalBinding;
  layer_manifest: HandoffLayer[];
  target_composition_revision_id: string;
  operations: CompositionOperation[];
  trustedScope: TrustedApprovalScope;
}): CompositionEditPlan;

export declare function evaluateApprovalHandoffAgreementGate(evidence?: unknown): {
  status: 'blocked' | 'owner_review_required';
  acceptance_allowed: false;
  independent_owner_verification_required: true;
  missing_owner_roles: string[];
  missing_evidence: string[];
  note: string;
};
