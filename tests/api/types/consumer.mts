import {
  CreativeApiError,
  createCreativeApi,
  type CreativeApiRequest,
  type CreativeApiResponse,
  type CreativeRuntimePorts,
  type InspectionPortOutput,
  type TrustedCreativeActor,
} from "../../../src/api/v1.mjs";
import type { EditPlan } from "../../../src/contracts/creative/v1.mjs";

declare const ports: CreativeRuntimePorts;
declare const principal: TrustedCreativeActor;
declare const request: CreativeApiRequest;
declare const plan: EditPlan;

const client = createCreativeApi({ ports, now: () => Date.now(), idFactory: () => "consumer-id" });
const response: Promise<CreativeApiResponse> = client.invoke(principal, request);
const rawInspection: InspectionPortOutput = {
  tenant_id: "tenant-typecheck",
  project_id: "project-typecheck",
  brief_id: "brief-typecheck",
  design_version_id: "design-typecheck",
  artifact_id: "artifact-typecheck",
  artifact_hash: `sha256:${"0".repeat(64)}`,
  design_hash: `sha256:${"1".repeat(64)}`,
  inspection_id: "inspection-typecheck",
  observations: [],
  usage: { completeness: "complete", input_tokens: 2, output_tokens: 4 },
};
const rawInspect: NonNullable<CreativeRuntimePorts["inspection"]>["inspect"] = async () => rawInspection;
const error = new CreativeApiError("unavailable", "generate", "provider", { retryable: true });
const code: string = error.code;
const stepCount: number = plan.steps.length;

void response;
void code;
void stepCount;
void rawInspect;
