import {
  ContractError,
  validateEditPlan,
  type EditPlan,
  type TrustedScope,
} from "creative-engine/contracts/creative/v1";
import {
  planQuestionBatches,
  validateDecisionResult,
  type DecisionPortRequest,
  type DecisionPortResult,
} from "creative-engine/contracts/decision-port/v1";

declare const trustedScope: TrustedScope;
declare const untrustedEditPlan: Record<string, unknown>;
declare const request: DecisionPortRequest;
declare const result: DecisionPortResult;

const plan: EditPlan = validateEditPlan(untrustedEditPlan, {
  trustedScope,
  brief_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  design_hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
});
const baseDesignHash: string = plan.base.design_hash;
const errorClass: typeof ContractError = ContractError;
const decisionResult: DecisionPortResult = validateDecisionResult(request, result, { trustedScope });
const batches: string[][] = planQuestionBatches(request, { trustedScope });

void baseDesignHash;
void errorClass;
void decisionResult;
void batches;
