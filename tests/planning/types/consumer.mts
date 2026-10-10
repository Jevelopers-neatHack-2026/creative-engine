import {
  CREATIVE_BRIEF_PLANNER_VERSION,
  applyResearchInvalidation,
  buildCreativeBrief,
  createResearchInvalidationRequest,
  openCreativeBriefStore,
  persistCreativeBrief,
  resolveAssetUse,
  type AssetPermissionEvidence,
  type PlanningScope,
  type ResearchInvalidationEventInput,
  type TrustedInvalidationEvidence,
} from "../../../src/planning/index.mjs";

const trustedScope: PlanningScope = { tenant_id: "tenant-typecheck", project_id: "project-typecheck" };
const packageInput: Record<string, unknown> = {};
const plan = buildCreativeBrief({
  trusted_scope: trustedScope,
  research_package: packageInput,
  context: { created_at: "2026-10-10T12:00:00Z", environment: "test", billing_mode: "simulated" },
  customer_preferences: [{ preference_id: "preference-1", value: "warm colors" }],
  artistic_intent: [{ interpretation_id: "idea-1", text: "quiet and celebratory" }],
  fact_corrections: [{ fact_id: "fact-1", proposed_value: "2027-05-20" }],
});
const store = openCreativeBriefStore(":memory:", trustedScope);
const versionReceipt = persistCreativeBrief(store, plan, trustedScope);
const versionNumber: number = versionReceipt.version_no;

const invalidation: ResearchInvalidationEventInput = {
  event_id: "invalidation-1",
  tenant_id: trustedScope.tenant_id,
  project_id: trustedScope.project_id,
  source_package_id: "package-1",
  source_package_hash: `sha256:${"a".repeat(64)}`,
  source_revision: 2,
  occurred_at: "2026-10-10T12:00:00Z",
  kind: "fact",
  reason: "fact_corrected",
  fact_ids: ["fact-1"],
};
const normalized = createResearchInvalidationRequest({ trusted_scope: trustedScope, event: invalidation });
const evidence: TrustedInvalidationEvidence = {
  status: "verified",
  classification: "synthetic_test",
  evidence_ref: "synthetic-owner-evidence",
  event_hash: normalized.content_hash,
  event_id: normalized.event_id,
  tenant_id: trustedScope.tenant_id,
  project_id: trustedScope.project_id,
  verified_at: "2026-10-10T12:00:00Z",
  valid_until: "2026-10-10T13:00:00Z",
};
const permissionEvidence: AssetPermissionEvidence = {
  status: "granted",
  tenant_id: trustedScope.tenant_id,
  project_id: trustedScope.project_id,
  asset_id: "asset-1",
  content_hash: `sha256:${"b".repeat(64)}`,
  action: "reproduce",
  package_id: "package-1",
  package_hash: `sha256:${"c".repeat(64)}`,
  owner_evidence_status: "verified",
  evidence_ref: "synthetic-permission-evidence",
  checked_at: "2026-10-10T12:00:00Z",
  expires_at: "2026-10-10T13:00:00Z",
};
const resolution = resolveAssetUse({
  trusted_scope: trustedScope,
  plan,
  research_package: packageInput,
  clock: { now: () => "2026-10-10T12:00:00Z" },
  permission_verifier: { async verifyAssetUse() { return permissionEvidence; } },
  invalidation_store: store,
});
const invalidationRun = applyResearchInvalidation({
  trusted_scope: trustedScope,
  event: invalidation,
  ports: {
    clock: { now: () => "2026-10-10T12:00:00Z" },
    store,
    verifier: { async verifyInvalidation() { return evidence; } },
  },
});

void CREATIVE_BRIEF_PLANNER_VERSION;
void versionNumber;
void resolution;
void invalidationRun;
store.close();
