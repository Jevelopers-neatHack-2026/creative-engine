import {
  canonicalHash,
  validateCreativeBrief,
  validateResearchPackage,
  type EventIntelligencePackage,
  type ResearchPackageAlias,
  type TrustedScope,
} from "creative-engine/contracts";
import { validateEditPlan } from "creative-engine/contracts/creative/v1";
import {
  planQuestionBatches,
  validateDecisionRequest,
  validateDecisionResult,
  type DecisionPortRequest,
  type DecisionPortResult,
} from "creative-engine/contracts/decision-port/v1";

declare const scope: TrustedScope;
declare const packageInput: EventIntelligencePackage | ResearchPackageAlias;
declare const brief: Parameters<typeof validateCreativeBrief>[0];
declare const request: DecisionPortRequest;
declare const result: DecisionPortResult;

const normalized = validateResearchPackage(packageInput, scope);
const digest = canonicalHash(normalized);
validateCreativeBrief(brief, { trustedScope: scope, researchPackage: normalized });
validateEditPlan({} as Parameters<typeof validateEditPlan>[0], {
  trustedScope: scope,
  brief_hash: digest,
});
validateDecisionRequest(request, { trustedScope: scope });
validateDecisionResult(request, result, { trustedScope: scope });
planQuestionBatches(request, { trustedScope: scope });
