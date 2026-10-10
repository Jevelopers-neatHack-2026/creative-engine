import {
  CREATIVE_API_OPERATIONS,
  CREATIVE_API_VERSION,
  CreativeApiError,
  createCreativeApi,
  createCreativeRuntime,
} from "creative-engine/api/v1";
import type {
  CreativeApiRequest,
  CreativeApiRequestEnvelope,
  CreativeApiResponse,
  CreativeContextFence,
  DecisionDispatchInput,
  DispatchAuthorizationInput,
  DispatchAuthorizationResult,
  InspectionInput,
  TrustedCreativeActor,
  UsageRecord,
} from "creative-engine/api/v1";
import type { EditPlan } from "creative-engine/contracts/creative/v1";
import type { MeteredDispatchContext } from "creative-engine/contracts/metering";

const base = (event_id: string): CreativeApiRequestEnvelope => ({
  contract: "CreativeApiRequest",
  schema_version: CREATIVE_API_VERSION,
  event_id,
  request_id: `request:${event_id}`,
  tenant_id: "tenant-fixture",
  project_id: "project-fixture",
  correlation_id: `correlation:${event_id}`,
  producer: "api-type-consumer-fixture",
  occurred_at: "2026-10-10T12:00:00.000Z",
  ingested_at: "2026-10-10T12:00:00.000Z",
  environment: "test",
  billing_mode: "simulated",
  source_refs: ["source-fixture"],
});

const generatePlan: EditPlan = {
  contract: "EditPlan",
  schema_version: "1.0",
  event_id: "plan-event-generate",
  tenant_id: "tenant-fixture",
  project_id: "project-fixture",
  correlation_id: "plan-correlation-generate",
  producer: "api-type-consumer-fixture",
  occurred_at: "2026-10-10T12:00:00.000Z",
  ingested_at: "2026-10-10T12:00:00.000Z",
  environment: "test",
  billing_mode: "simulated",
  source_refs: ["source-fixture"],
  plan_id: "plan-generate",
  base: { brief_hash: `sha256:${"a".repeat(64)}`, design_hash: `sha256:${"b".repeat(64)}` },
  operation: "concept.generate",
  steps: [{ step_id: "generate-step", action: "concept.generate", source_refs: ["source-fixture"],
    parameters: { brief_id: "brief-fixture", variant_count: 1 } }],
  expected_result: { contract: "DesignVersion", schema_version: "1.0", parent_version_id: "root:brief-fixture", artifact_kind: "image" },
  invalidates: [],
};

const editPlan: EditPlan = {
  ...generatePlan,
  plan_id: "plan-edit",
  base: { ...generatePlan.base, design_version_id: "design-fixture" },
  operation: "image.edit",
  steps: [{ step_id: "edit-step", action: "image.edit", source_refs: ["source-fixture"],
    parameters: { design_version_id: "design-fixture", artifact_id: "artifact-fixture", instruction: "Adjust contrast." } }],
  expected_result: { ...generatePlan.expected_result, parent_version_id: "design-fixture" },
};

const requests: CreativeApiRequest[] = [
  { ...base("generate"), operation: "generate", action_id: "action-generate", payload: { brief_id: "brief-fixture", plan: generatePlan } },
  { ...base("edit"), operation: "edit", action_id: "action-edit", payload: { brief_id: "brief-fixture", design_version_id: "design-fixture", plan: editPlan } },
  { ...base("inspect"), operation: "inspect", action_id: "action-inspect", payload: { brief_id: "brief-fixture", design_version_id: "design-fixture" } },
  { ...base("list"), operation: "list", payload: { brief_id: "brief-fixture", limit: 20 } },
  { ...base("compare"), operation: "compare", payload: { brief_id: "brief-fixture", left_design_version_id: "design-a", right_design_version_id: "design-b" } },
  { ...base("restore"), operation: "restore", action_id: "action-restore", payload: {
    brief_id: "brief-fixture", target_design_version_id: "design-a", expected_selection_revision: 4 } },
  { ...base("cancel"), operation: "cancel", action_id: "action-cancel", payload: { job_id: "job-fixture" } },
  { ...base("handoff"), operation: "handoff", action_id: "action-handoff", payload: {
    brief_id: "brief-fixture", design_version_id: "design-fixture", approval_ref: "approval-fixture", destination_ref: "destination-fixture" } },
  { ...base("job-status"), operation: "job.status", payload: { job_id: "job-fixture" } },
];

const trustedActor: TrustedCreativeActor = {
  actor_id: "actor-fixture",
  tenant_id: "tenant-fixture",
  project_id: "project-fixture",
  expires_at: "2026-10-11T00:00:00.000Z",
  permissions: ["creative.read", "creative.generate", "creative.edit", "creative.restore", "creative.cancel", "creative.handoff"],
  budget_scope_id: "budget-fixture",
  budget_policy_version: "budget-policy/1",
};
const api = createCreativeApi();
const apiAlias = createCreativeRuntime();
const response: Promise<CreativeApiResponse> = api.invoke(trustedActor, requests[0]);
const aliasResponse: Promise<CreativeApiResponse> = apiAlias.invoke(trustedActor, requests[8]);
const publicError = new CreativeApiError("unavailable", "job.status", "jobs.get", { retryable: true });

const authorizationInput: DispatchAuthorizationInput = {
  scope: { tenant_id: "tenant-fixture", project_id: "project-fixture", job_id: "job-fixture" },
  actor_id: trustedActor.actor_id,
  job_id: "job-fixture",
  lease_token: "lease-fixture",
  action_id: "action-fixture",
  operation: "generate",
  billable_attempt_id: "attempt-fixture",
  transport_attempt_id: "transport-fixture",
  context_fence: { brief_id: "brief-fixture", brief_hash: `sha256:${"a".repeat(64)}`,
    expected_current_design_version_id: null, expected_current_design_hash: null },
};
const authorizationResult: DispatchAuthorizationResult = { status: "authorized", dispatch_intent_ref: "intent-fixture" };
declare const meteredDispatch: MeteredDispatchContext;
const immutableReservationReference: string = meteredDispatch.reservation_ref;
// @ts-expect-error reservation_ref is a read-only authority value.
meteredDispatch.reservation_ref = "caller-forged-reservation";

declare const decisionDispatch: DecisionDispatchInput;
const initialDecisionTransportId: string = decisionDispatch.transport_attempt_id;
const decisionRetryIntent: Promise<string> = decisionDispatch.recordTransportAttempt("transport:jev-retry");
declare const inspectionDispatch: InspectionInput;
const initialInspectionTransportId: string = inspectionDispatch.transport_attempt_id;
const inspectionTransportIntent: Promise<string> = inspectionDispatch.recordTransportAttempt(initialInspectionTransportId);
const privacyFilteredUsage: UsageRecord = { completeness: "complete", input_tokens: 1, output_tokens: 2,
  provider_request_id: "provider-request-fixture", transport_attempt_id: initialInspectionTransportId };
const publicationFence: CreativeContextFence = { brief_id: "brief-fixture", brief_hash: `sha256:${"a".repeat(64)}`,
  design_version_id: "design-fixture", design_hash: `sha256:${"b".repeat(64)}`,
  expected_current_design_version_id: "design-fixture", expected_current_design_hash: `sha256:${"b".repeat(64)}` };

void [CREATIVE_API_OPERATIONS, requests, response, aliasResponse, publicError, authorizationInput,
  authorizationResult, immutableReservationReference, initialDecisionTransportId, decisionRetryIntent,
  initialInspectionTransportId, inspectionTransportIntent, privacyFilteredUsage, publicationFence];
