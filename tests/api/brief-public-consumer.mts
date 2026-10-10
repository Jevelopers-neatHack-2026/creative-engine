import { createCreativeApi, CREATIVE_API_OPERATIONS } from "creative-engine/api/v1";
import type {
  CreativeApiRequest,
  CreativeInvalidationResult,
  CreativeOperation,
  CreativeRuntimePorts,
  TrustedCreativeActor,
} from "creative-engine/api/v1";
import { CreativePlanningError, buildCreativeBrief } from "creative-engine/planning";
import type {
  AssetPermissionEvidence,
  CreativeBriefPlan,
  PlanningScope,
  ProducerAcknowledgment,
  ResearchInvalidationEventInput,
  TrustedInvalidationEvidence,
} from "creative-engine/planning";
import { createCreativeVersionApiPorts, CreativeVersionStore } from "creative-engine/versions";
import type { CreativeVersionRuntimePlanning } from "creative-engine/versions";
import type { EventIntelligencePackage } from "creative-engine/contracts/creative/v1";

const at = "2026-10-10T12:00:00.000Z";
const base = (event_id: string) => ({
  contract: "CreativeApiRequest" as const,
  schema_version: "1.0" as const,
  event_id,
  request_id: `request:${event_id}`,
  tenant_id: "tenant-brief-public",
  project_id: "project-brief-public",
  correlation_id: `correlation:${event_id}`,
  producer: "brief-public-consumer",
  occurred_at: at,
  ingested_at: at,
  environment: "test" as const,
  billing_mode: "simulated" as const,
  source_refs: [] as string[],
});

const requests: CreativeApiRequest[] = [
  { ...base("brief-create"), operation: "brief.create", action_id: "brief-create-action", payload: {
    customer_preferences: [{ preference_id: "preference-1", value: "Simple, readable composition." }],
    artistic_intent: [{ interpretation_id: "intent-1", text: "Prefer a quiet background." }],
    additional_required_fact_keys: ["event_venue"],
    fact_corrections: [{ fact_id: "fact-date", proposed_value: "2027-05-12" }],
    locked_fields: [{ field: "event_name", reason: "Keep the verified event title." }],
  } },
  { ...base("brief-invalidate"), operation: "brief.invalidate", action_id: "brief-invalidate-action",
    payload: { event_id: "research-invalidation-event" } },
];

const actor: TrustedCreativeActor = {
  actor_id: "actor-brief-public",
  tenant_id: "tenant-brief-public",
  project_id: "project-brief-public",
  expires_at: "2026-10-11T00:00:00.000Z",
  permissions: ["creative.brief.create", "creative.brief.invalidate", "creative.read"],
  budget_scope_id: "budget-brief-public",
  budget_policy_version: "budget-policy/1",
};

declare const researchPackage: EventIntelligencePackage;
declare const invalidationEvent: ResearchInvalidationEventInput;
declare const trustedInvalidationEvidence: TrustedInvalidationEvidence;
declare const permissionEvidence: AssetPermissionEvidence;
declare const producerAck: ProducerAcknowledgment;
declare const invalidationResult: CreativeInvalidationResult;

const planning: NonNullable<CreativeRuntimePorts["planning"]> = {
  async getBriefAction({ scope, actor_id, action_id, request_hash }) {
    const tenant: string = scope.tenant_id;
    void [tenant, actor_id, action_id, request_hash];
    return null;
  },
  async applyInvalidation(input) {
    const scope: PlanningScope = input.trusted_scope;
    const actorId: string = input.actor_id;
    const actionId: string = input.action_id;
    const operation: "brief.invalidate" = input.operation;
    const requestHash: string = input.request_hash;
    const eventId: string = input.event_id;
    void [scope, actorId, actionId, operation, requestHash, eventId];
    return { public_action_status: "completed" as const, invalidation: invalidationResult };
  },
  async getCurrentResearchPackage({ scope }): Promise<EventIntelligencePackage> {
    const tenant: string = scope.tenant_id;
    void tenant;
    return researchPackage;
  },
  getInvalidationEvent({ scope }): ResearchInvalidationEventInput {
    const project: string = scope.project_id;
    void project;
    return invalidationEvent;
  },
  invalidationVerifier: {
    async verifyInvalidation({ event, trusted_scope, now }): Promise<TrustedInvalidationEvidence> {
      const eventId: string = event.event_id;
      const tenant: string = trusted_scope.tenant_id;
      const checkedAt: string = now;
      void [eventId, tenant, checkedAt];
      return trustedInvalidationEvidence;
    },
  },
  approvalStaleness: {
    async markBriefStale(request) {
      return { ...request, status: "acknowledged" };
    },
  },
  producerAcknowledgment: {
    async acknowledgeInvalidation(input): Promise<ProducerAcknowledgment> {
      const eventId: string = input.event_id;
      void eventId;
      return producerAck;
    },
  },
  assetPermissionVerifier: {
    async verifyAssetUse(input): Promise<AssetPermissionEvidence> {
      const action: "reproduce" | "modify" = input.action;
      const packageHash: string = input.package_hash;
      void [action, packageHash];
      return permissionEvidence;
    },
  },
};

const ports: CreativeRuntimePorts = { planning };
const api = createCreativeApi({ ports });
const response = api.invoke(actor, requests[0]);
const invalidationResponse = api.invoke(actor, requests[1]);

const versionStore = new CreativeVersionStore({ databasePath: "/tmp/brief-public.sqlite", objectRoot: "/tmp/brief-public-objects" });
const paired = createCreativeVersionApiPorts({ store: versionStore, otherPorts: ports });
const pairedApi = createCreativeApi({ ports: paired.ports });
const pairedPortsAsRuntimePorts: CreativeRuntimePorts = paired.ports;
const versionPlanning: CreativeVersionRuntimePlanning = paired.ports.planning;
const historicalBrief = versionPlanning.getBriefVersionByHash({
  scope: { tenant_id: actor.tenant_id, project_id: actor.project_id },
  brief_id: "brief-public",
  brief_hash: `sha256:${"a".repeat(64)}`,
});
const usable: boolean | Promise<boolean> = versionPlanning.isBriefUsable({
  scope: { tenant_id: actor.tenant_id, project_id: actor.project_id },
  brief_id: "brief-public",
  brief_hash: `sha256:${"a".repeat(64)}`,
});

const scope: PlanningScope = { tenant_id: actor.tenant_id, project_id: actor.project_id };
const plan: CreativeBriefPlan = buildCreativeBrief({
  trusted_scope: scope,
  research_package: researchPackage,
  context: { created_at: at, environment: "test", billing_mode: "simulated" },
});
const safePlanningError = new CreativePlanningError("invalid_input", "Safe public message.", "payload");
const publicOperations: readonly CreativeOperation[] = CREATIVE_API_OPERATIONS;

// Asset eligibility is a trusted use-time port, not a public operation.
// @ts-expect-error the public request union exposes only brief.create and brief.invalidate for planning
const unsupportedPublicOperation: CreativeOperation = "asset.eligibility";

void [response, invalidationResponse, pairedApi, historicalBrief, usable, plan, safePlanningError, publicOperations,
  unsupportedPublicOperation, pairedPortsAsRuntimePorts];
