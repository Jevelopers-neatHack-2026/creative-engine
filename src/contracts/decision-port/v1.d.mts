import type { BillingMode, Environment, TrustedScope } from "../creative/v1.mjs";

export type DecisionQuestionType = "choice" | "score" | "noul";
export type DecisionStatus = "complete" | "review" | "unavailable" | "timeout" | "cancelled";

export interface DecisionQuestionBase {
  question_schema_version: "1.0";
  policy_version: string;
  instructions: string;
  depends_on?: string[];
}

export interface ConfidencePolicy {
  minimum_confidence: number;
  low_confidence_action: "review";
}

export interface NoulPolicy {
  uncertain_probability_band: {
    lower: number;
    upper: number;
  };
}

export interface ChoiceQuestion extends DecisionQuestionBase {
  type: "choice";
  criteria: Record<string, string | null>;
  eligible_candidate_ids: string[];
  policy: ConfidencePolicy;
}

export interface ScoreQuestion extends DecisionQuestionBase {
  type: "score";
  criteria: string[];
  policy: ConfidencePolicy;
}

export interface NoulQuestion extends DecisionQuestionBase {
  type: "noul";
  criteria: {
    true: string;
    false: string;
  };
  policy: NoulPolicy;
}

export type DecisionQuestion = ChoiceQuestion | ScoreQuestion | NoulQuestion;

export interface DecisionObservation {
  observer: {
    type: "human" | "model" | "system";
    id: string;
  };
  content_hash: string;
  uncertainty: {
    status: "measured" | "not_measured" | "unknown";
    note?: string;
  };
  summary: string;
  source_ref?: string;
}

export interface DecisionPortRequest {
  contract: "DecisionPortRequest";
  schema_version: "1.0";
  event_id: string;
  tenant_id: string;
  project_id: string;
  correlation_id: string;
  producer: string;
  occurred_at: string;
  ingested_at: string;
  workflow_id?: string;
  run_id?: string;
  order_id?: string;
  job_id?: string;
  design_version_id?: string;
  artifact_id?: string;
  transport_attempt_id?: string;
  provider_request_id?: string;
  environment: Environment;
  billing_mode: BillingMode;
  source_refs: string[];
  request_id: string;
  logical_operation_id: string;
  billable_attempt_id: string;
  attempt_number: number;
  attempt_limit: number;
  budget_ref: {
    budget_scope_ref: string;
    reservation_ref: string;
    policy_version: string;
  };
  deadline_at: string;
  cancellation_ref: string;
  model_policy: {
    model_id: "jev-1.13.0";
    policy_version: string;
  };
  execution_mode: "independent_batch" | "sequential";
  state: {
    text?: string;
    observations?: DecisionObservation[];
  };
  questions: Record<string, DecisionQuestion>;
}

export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};

export type ScoreAnswer = {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
};

export type NoulAnswer = {
  type: "noul";
  noul: number;
};

export type DecisionAnswer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export type AnswerRecord =
  | {
      status: "answered";
      question_schema_version: "1.0";
      policy_version: string;
      answer: DecisionAnswer;
    }
  | {
      status: "abstain" | "unavailable";
      question_schema_version: "1.0";
      policy_version: string;
      reason: string;
    };

export interface DecisionUsage {
  completeness: "complete" | "incomplete" | "unknown";
  input_tokens?: number;
  output_tokens?: number;
  provider_request_id?: string;
  reason?: string;
}

export interface DecisionPortError {
  code: "timeout" | "cancelled" | "provider_unavailable" | "malformed_response" | "unsupported_model" | "scope_mismatch" | "deadline_exceeded";
  retryable: boolean;
  fallback: "review" | "unavailable";
  user_message: string;
  diagnostic_ref?: string;
  retry_after_ms?: number;
}

export interface DecisionPortResult {
  contract: "DecisionPortResult";
  schema_version: "1.0";
  event_id: string;
  tenant_id: string;
  project_id: string;
  correlation_id: string;
  producer: string;
  occurred_at: string;
  ingested_at: string;
  workflow_id?: string;
  run_id?: string;
  order_id?: string;
  job_id?: string;
  design_version_id?: string;
  artifact_id?: string;
  transport_attempt_id?: string;
  provider_request_id?: string;
  environment: Environment;
  billing_mode: BillingMode;
  source_refs: string[];
  request_id: string;
  logical_operation_id: string;
  billable_attempt_id: string;
  model_id: "jev-1.13.0";
  model_policy_version: string;
  status: DecisionStatus;
  answers: Record<string, AnswerRecord>;
  usage: DecisionUsage;
  provider_request_ref?: string;
  error?: DecisionPortError;
}

export declare const DECISION_PORT_SCHEMA_VERSION: "1.0";
export declare const PINNED_JEV_MODEL_ID: "jev-1.13.0";
export declare const DECISION_DISTRIBUTION_TOLERANCE: 0.000001;
export declare const DECISION_LIMITS: Readonly<{
  stateBytes: 16384;
  questions: 24;
  observations: 16;
  choiceOptions: 255;
  scoreLevels: 10;
  attemptLimit: 3;
}>;
export declare function validateDecisionRequest(
  value: DecisionPortRequest | Record<string, unknown>,
  options: { trustedScope: TrustedScope },
): DecisionPortRequest;
export declare function validateDecisionResult(
  request: DecisionPortRequest,
  result: DecisionPortResult | Record<string, unknown>,
  options: { trustedScope: TrustedScope },
): DecisionPortResult;
export declare function planQuestionBatches(
  value: DecisionPortRequest,
  options: { trustedScope: TrustedScope },
): string[][];
export declare function safeFallback(result: Pick<DecisionPortResult, "status">): {
  outcome: "review_required" | "unavailable";
  reason: string;
};
