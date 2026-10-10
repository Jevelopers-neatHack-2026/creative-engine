import {
  CreativeApiError,
  createCreativeApi,
  type CreativeApiRequest,
  type CreativeApiResponse,
  type CreativeRuntimePorts,
  type TrustedCreativeActor,
} from "../../../src/api/v1.mjs";
import type { EditPlan } from "../../../src/contracts/creative/v1.mjs";

declare const ports: CreativeRuntimePorts;
declare const principal: TrustedCreativeActor;
declare const request: CreativeApiRequest;
declare const plan: EditPlan;

const client = createCreativeApi({ ports, now: () => Date.now(), idFactory: () => "consumer-id" });
const response: Promise<CreativeApiResponse> = client.invoke(principal, request);
const error = new CreativeApiError("unavailable", "generate", "provider", { retryable: true });
const code: string = error.code;
const stepCount: number = plan.steps.length;

void response;
void code;
void stepCount;
