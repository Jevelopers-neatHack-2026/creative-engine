import {
  assertHash,
  assertIsoDateTime,
  assertOnlyKeys,
  expectArray,
  expectEnum,
  expectFiniteNumber,
  expectInteger,
  expectObject,
  expectString,
  fail,
  rejectCredentialMaterial,
} from "../validation.mjs";
import { assertTrustedScope } from "../scope.mjs";

export const DECISION_PORT_SCHEMA_VERSION = "1.0";
export const PINNED_JEV_MODEL_ID = "jev-1.13.0";
export const DECISION_DISTRIBUTION_TOLERANCE = 0.000001;
export const DECISION_LIMITS = Object.freeze({
  stateBytes: 16_384,
  questions: 24,
  observations: 16,
  choiceOptions: 255,
  scoreLevels: 10,
  attemptLimit: 3,
});

const ENVIRONMENTS = ["development", "test", "production"];
const BILLING_MODES = ["live", "sandbox", "simulated"];
const QUESTION_TYPES = ["choice", "score", "noul"];
const QUESTION_SCHEMA_VERSION = "1.0";

const REQUEST_KEYS = [
  "contract", "schema_version", "event_id", "tenant_id", "project_id", "correlation_id", "producer",
  "occurred_at", "ingested_at", "environment", "billing_mode", "source_refs", "request_id",
  "logical_operation_id", "billable_attempt_id", "attempt_number", "attempt_limit", "budget_ref",
  "deadline_at", "cancellation_ref", "model_policy", "execution_mode", "state", "questions",
  "workflow_id", "run_id", "order_id", "job_id", "design_version_id", "artifact_id",
  "transport_attempt_id", "provider_request_id",
];

const RESULT_KEYS = [
  "contract", "schema_version", "event_id", "tenant_id", "project_id", "correlation_id", "producer",
  "occurred_at", "ingested_at", "environment", "billing_mode", "source_refs", "request_id",
  "logical_operation_id", "billable_attempt_id", "model_id", "model_policy_version", "status",
  "answers", "usage", "provider_request_ref", "error",
  "workflow_id", "run_id", "order_id", "job_id", "design_version_id", "artifact_id",
  "transport_attempt_id", "provider_request_id",
];

function requireTrustedScope(trustedScope, contract) {
  if (!trustedScope) {
    fail("missing_trusted_context", contract, "trusted_scope", "A separately supplied trusted scope is required.");
  }
}

function validateCommonEnvelope(value, contract) {
  expectString(value.event_id, contract, "event_id", { maxLength: 200 });
  expectString(value.tenant_id, contract, "tenant_id", { maxLength: 200 });
  expectString(value.project_id, contract, "project_id", { maxLength: 200 });
  expectString(value.correlation_id, contract, "correlation_id", { maxLength: 200 });
  expectString(value.producer, contract, "producer", { maxLength: 200 });
  assertIsoDateTime(value.occurred_at, contract, "occurred_at");
  assertIsoDateTime(value.ingested_at, contract, "ingested_at");
  expectEnum(value.environment, ENVIRONMENTS, contract, "environment");
  expectEnum(value.billing_mode, BILLING_MODES, contract, "billing_mode");
  expectArray(value.source_refs, contract, "source_refs").forEach((ref, index) =>
    expectString(ref, contract, "source_refs[" + index + "]", { maxLength: 300 }));
  for (const field of [
    "workflow_id", "run_id", "order_id", "job_id", "design_version_id", "artifact_id",
    "logical_operation_id", "billable_attempt_id", "transport_attempt_id", "provider_request_id",
  ]) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      expectString(value[field], contract, field, { maxLength: 200 });
    }
  }
}

function validateQuestion(id, question, contract) {
  expectString(id, contract, "questions key", { maxLength: 64 });
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(id)) {
    fail("invalid_question_id", contract, "questions." + id, "Question IDs must use lowercase letters, digits, and underscores.");
  }
  expectObject(question, contract, "questions." + id);
  const commonKeys = ["type", "question_schema_version", "policy_version", "instructions", "depends_on"];
  expectEnum(question.type, QUESTION_TYPES, contract, "questions." + id + ".type");
  if (question.question_schema_version !== QUESTION_SCHEMA_VERSION) {
    fail("unsupported_version", contract, "questions." + id + ".question_schema_version", "Unsupported question schema version.");
  }
  expectString(question.policy_version, contract, "questions." + id + ".policy_version", { maxLength: 100 });
  expectString(question.instructions, contract, "questions." + id + ".instructions", { maxLength: 2048 });
  const dependencies = question.depends_on === undefined ? [] : expectArray(question.depends_on, contract, "questions." + id + ".depends_on");
  if (dependencies.length > DECISION_LIMITS.questions - 1) {
    fail("out_of_bounds", contract, "questions." + id + ".depends_on", "A question may depend on at most 23 other questions.");
  }
  dependencies.forEach((dependency, index) =>
    expectString(dependency, contract, "questions." + id + ".depends_on[" + index + "]", { maxLength: 64 }));
  if (new Set(dependencies).size !== dependencies.length) {
    fail("invalid_dependency", contract, "questions." + id + ".depends_on", "Question dependencies must be unique.");
  }

  if (question.type === "choice") {
    assertOnlyKeys(question, [...commonKeys, "criteria", "eligible_candidate_ids", "policy"], contract, "questions." + id);
    validateQuestionPolicy(question, contract, id);
    const criteria = expectObject(question.criteria, contract, "questions." + id + ".criteria");
    const candidates = Object.keys(criteria);
    if (candidates.length < 2 || candidates.length > DECISION_LIMITS.choiceOptions) {
      fail("out_of_bounds", contract, "questions." + id + ".criteria", "Choice questions require 2 to 255 options.");
    }
    for (const candidate of candidates) {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(candidate)) {
        fail("invalid_choice_id", contract, "questions." + id + ".criteria." + candidate, "Choice IDs must be stable lowercase identifiers.");
      }
      if (criteria[candidate] !== null) {
        expectString(criteria[candidate], contract, "questions." + id + ".criteria." + candidate, { maxLength: 1000 });
      }
    }
    const eligible = expectArray(question.eligible_candidate_ids, contract, "questions." + id + ".eligible_candidate_ids");
    if (eligible.length !== candidates.length || new Set(eligible).size !== candidates.length || candidates.some((candidate) => !eligible.includes(candidate))) {
      fail("invalid_candidates", contract, "questions." + id + ".eligible_candidate_ids", "Eligible candidates must exactly match the Choice criteria keys.");
    }
  } else if (question.type === "score") {
    assertOnlyKeys(question, [...commonKeys, "criteria", "policy"], contract, "questions." + id);
    validateQuestionPolicy(question, contract, id);
    const criteria = expectArray(question.criteria, contract, "questions." + id + ".criteria");
    if (criteria.length < 2 || criteria.length > DECISION_LIMITS.scoreLevels) {
      fail("out_of_bounds", contract, "questions." + id + ".criteria", "Score questions require 2 to 10 ordered levels.");
    }
    criteria.forEach((level, index) =>
      expectString(level, contract, "questions." + id + ".criteria[" + index + "]", { maxLength: 1000 }));
  } else {
    assertOnlyKeys(question, [...commonKeys, "criteria", "policy"], contract, "questions." + id);
    validateQuestionPolicy(question, contract, id);
    const criteria = expectObject(question.criteria, contract, "questions." + id + ".criteria");
    assertOnlyKeys(criteria, ["true", "false"], contract, "questions." + id + ".criteria");
    expectString(criteria.true, contract, "questions." + id + ".criteria.true", { maxLength: 1000 });
    expectString(criteria.false, contract, "questions." + id + ".criteria.false", { maxLength: 1000 });
  }
  return dependencies;
}

function validateQuestionPolicy(question, contract, id) {
  const field = "questions." + id + ".policy";
  expectObject(question.policy, contract, field);
  if (question.type === "noul") {
    assertOnlyKeys(question.policy, ["uncertain_probability_band"], contract, field);
    const band = expectObject(question.policy.uncertain_probability_band, contract, field + ".uncertain_probability_band");
    assertOnlyKeys(band, ["lower", "upper"], contract, field + ".uncertain_probability_band");
    const lower = expectFiniteNumber(band.lower, contract, field + ".uncertain_probability_band.lower", { min: 0, max: 1 });
    const upper = expectFiniteNumber(band.upper, contract, field + ".uncertain_probability_band.upper", { min: 0, max: 1 });
    if (lower >= upper) fail("invalid_policy", contract, field + ".uncertain_probability_band", "Noul uncertainty band lower must be below upper.");
    return;
  }
  assertOnlyKeys(question.policy, ["minimum_confidence", "low_confidence_action"], contract, field);
  expectFiniteNumber(question.policy.minimum_confidence, contract, field + ".minimum_confidence", { min: 0, max: 1 });
  expectEnum(question.policy.low_confidence_action, ["review"], contract, field + ".low_confidence_action");
}

function questionIds(value) {
  return Object.keys(expectObject(value.questions, "DecisionPortRequest", "questions"));
}

function validateQuestionDependencies(value) {
  const ids = questionIds(value);
  const all = new Set(ids);
  for (const id of ids) {
    const question = value.questions[id];
    const dependencies = question.depends_on ?? [];
    for (const dependency of dependencies) {
      if (!all.has(dependency) || dependency === id) {
        fail("invalid_dependency", "DecisionPortRequest", "questions." + id + ".depends_on", "Question dependencies must refer to a different question in the request.");
      }
    }
  }
  if (value.execution_mode === "independent_batch" && ids.some((id) => (value.questions[id].depends_on ?? []).length > 0)) {
    fail("invalid_dependency", "DecisionPortRequest", "execution_mode", "Dependent questions cannot share an independent batch.");
  }
  if (value.execution_mode === "sequential") planQuestionBatchesUnchecked(value);
}

function planQuestionBatchesUnchecked(value) {
  const pending = new Set(questionIds(value));
  const completed = new Set();
  const batches = [];
  while (pending.size > 0) {
    const ready = [...pending].filter((id) => (value.questions[id].depends_on ?? []).every((dependency) => completed.has(dependency)));
    if (ready.length === 0) {
      fail("invalid_dependency", "DecisionPortRequest", "questions", "Question dependencies must form an acyclic graph.");
    }
    batches.push(ready);
    ready.forEach((id) => {
      pending.delete(id);
      completed.add(id);
    });
  }
  return batches;
}

function validateObservation(observation, index, contract) {
  const field = "state.observations[" + index + "]";
  expectObject(observation, contract, field);
  assertOnlyKeys(observation, ["observer", "content_hash", "uncertainty", "summary", "source_ref"], contract, field);
  expectObject(observation.observer, contract, field + ".observer");
  assertOnlyKeys(observation.observer, ["type", "id"], contract, field + ".observer");
  expectEnum(observation.observer.type, ["human", "model", "system"], contract, field + ".observer.type");
  expectString(observation.observer.id, contract, field + ".observer.id", { maxLength: 200 });
  assertHash(observation.content_hash, contract, field + ".content_hash");
  expectObject(observation.uncertainty, contract, field + ".uncertainty");
  assertOnlyKeys(observation.uncertainty, ["status", "note"], contract, field + ".uncertainty");
  expectEnum(observation.uncertainty.status, ["measured", "not_measured", "unknown"], contract, field + ".uncertainty.status");
  if (Object.prototype.hasOwnProperty.call(observation.uncertainty, "note")) {
    expectString(observation.uncertainty.note, contract, field + ".uncertainty.note", { maxLength: 500 });
  }
  expectString(observation.summary, contract, field + ".summary", { maxLength: 1500 });
  if (Object.prototype.hasOwnProperty.call(observation, "source_ref")) {
    expectString(observation.source_ref, contract, field + ".source_ref", { maxLength: 300 });
  }
}

export function validateDecisionRequest(value, options = {}) {
  const contract = "DecisionPortRequest";
  expectObject(value, contract, contract);
  assertOnlyKeys(value, REQUEST_KEYS, contract);
  if (value.contract !== contract || value.schema_version !== DECISION_PORT_SCHEMA_VERSION) {
    fail("unsupported_version", contract, "schema_version", "Expected DecisionPortRequest schema version 1.0.");
  }
  validateCommonEnvelope(value, contract);
  expectString(value.request_id, contract, "request_id", { maxLength: 200 });
  expectString(value.logical_operation_id, contract, "logical_operation_id", { maxLength: 200 });
  expectString(value.billable_attempt_id, contract, "billable_attempt_id", { maxLength: 200 });
  const attemptLimit = expectInteger(value.attempt_limit, contract, "attempt_limit", { min: 1, max: DECISION_LIMITS.attemptLimit });
  expectInteger(value.attempt_number, contract, "attempt_number", { min: 1, max: attemptLimit });
  expectObject(value.budget_ref, contract, "budget_ref");
  assertOnlyKeys(value.budget_ref, ["budget_scope_ref", "reservation_ref", "policy_version"], contract, "budget_ref");
  expectString(value.budget_ref.budget_scope_ref, contract, "budget_ref.budget_scope_ref", { maxLength: 200 });
  expectString(value.budget_ref.reservation_ref, contract, "budget_ref.reservation_ref", { maxLength: 200 });
  expectString(value.budget_ref.policy_version, contract, "budget_ref.policy_version", { maxLength: 100 });
  assertIsoDateTime(value.deadline_at, contract, "deadline_at");
  expectString(value.cancellation_ref, contract, "cancellation_ref", { maxLength: 200 });
  expectObject(value.model_policy, contract, "model_policy");
  assertOnlyKeys(value.model_policy, ["model_id", "policy_version"], contract, "model_policy");
  if (value.model_policy.model_id !== PINNED_JEV_MODEL_ID) {
    fail("unsupported_model", contract, "model_policy.model_id", "The local proposal pins the versioned model ID " + PINNED_JEV_MODEL_ID + ".");
  }
  expectString(value.model_policy.policy_version, contract, "model_policy.policy_version", { maxLength: 100 });
  expectEnum(value.execution_mode, ["independent_batch", "sequential"], contract, "execution_mode");
  expectObject(value.state, contract, "state");
  assertOnlyKeys(value.state, ["text", "observations"], contract, "state");
  const hasText = Object.prototype.hasOwnProperty.call(value.state, "text");
  const observations = value.state.observations === undefined ? [] : expectArray(value.state.observations, contract, "state.observations");
  if (!hasText && observations.length === 0) {
    fail("missing_field", contract, "state", "Decision state requires bounded text or structured observations.");
  }
  if (hasText) {
    expectString(value.state.text, contract, "state.text", { maxLength: DECISION_LIMITS.stateBytes });
    if (Buffer.byteLength(value.state.text, "utf8") > DECISION_LIMITS.stateBytes) {
      fail("out_of_bounds", contract, "state.text", "State exceeds the 16 KiB UTF-8 byte limit.");
    }
  }
  if (observations.length > DECISION_LIMITS.observations) {
    fail("out_of_bounds", contract, "state.observations", "State exceeds the observation limit.");
  }
  observations.forEach((observation, index) => validateObservation(observation, index, contract));
  if (Buffer.byteLength(JSON.stringify(value.state), "utf8") > DECISION_LIMITS.stateBytes) {
    fail("out_of_bounds", contract, "state", "JSON-serialized state exceeds the 16 KiB UTF-8 byte limit.");
  }
  const questions = expectObject(value.questions, contract, "questions");
  const ids = Object.keys(questions);
  if (ids.length === 0 || ids.length > DECISION_LIMITS.questions) {
    fail("out_of_bounds", contract, "questions", "A decision request requires 1 to 24 questions.");
  }
  for (const id of ids) validateQuestion(id, questions[id], contract);
  validateQuestionDependencies(value);
  requireTrustedScope(options.trustedScope, contract);
  assertTrustedScope(value, options.trustedScope, contract);
  rejectCredentialMaterial(value, contract);
  return value;
}

export function planQuestionBatches(value, options = {}) {
  validateDecisionRequest(value, options);
  if (value.execution_mode === "independent_batch") return [questionIds(value)];
  return planQuestionBatchesUnchecked(value);
}

function validateProbabilityMap(probabilities, expectedKeys, contract, field) {
  expectObject(probabilities, contract, field);
  const keys = Object.keys(probabilities).sort();
  const expected = [...expectedKeys].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail("invalid_distribution", contract, field, "Probability keys must match the declared candidates or levels exactly.");
  }
  let total = 0;
  for (const key of keys) {
    total += expectFiniteNumber(probabilities[key], contract, field + "." + key, { min: 0, max: 1 });
  }
  if (Math.abs(total - 1) > DECISION_DISTRIBUTION_TOLERANCE) {
    fail("invalid_distribution", contract, field, "Probabilities must sum to 1 within 1e-6.");
  }
}

function validateAnswer(question, record, field, contract) {
  expectObject(record, contract, field);
  const status = expectEnum(record.status, ["answered", "abstain", "unavailable"], contract, field + ".status");
  if (record.question_schema_version !== question.question_schema_version) {
    fail("version_mismatch", contract, field + ".question_schema_version", "Answer question schema version does not match the request.");
  }
  if (record.policy_version !== question.policy_version) {
    fail("version_mismatch", contract, field + ".policy_version", "Answer policy version does not match the request.");
  }
  if (status !== "answered") {
    assertOnlyKeys(record, ["status", "question_schema_version", "policy_version", "reason"], contract, field);
    expectString(record.reason, contract, field + ".reason", { maxLength: 500 });
    return status;
  }
  assertOnlyKeys(record, ["status", "question_schema_version", "policy_version", "answer"], contract, field);
  const answer = expectObject(record.answer, contract, field + ".answer");
  if (answer.type !== question.type) {
    fail("answer_type_mismatch", contract, field + ".answer.type", "Answer type does not match its question.");
  }
  if (question.type === "choice") {
    assertOnlyKeys(answer, ["type", "choice", "probabilities", "confidence"], contract, field + ".answer");
    expectString(answer.choice, contract, field + ".answer.choice", { maxLength: 64 });
    if (!question.eligible_candidate_ids.includes(answer.choice)) {
      fail("unknown_choice", contract, field + ".answer.choice", "Choice result is not an eligible candidate.");
    }
    validateProbabilityMap(answer.probabilities, question.eligible_candidate_ids, contract, field + ".answer.probabilities");
    const highest = Math.max(...Object.values(answer.probabilities));
    if (answer.probabilities[answer.choice] + DECISION_DISTRIBUTION_TOLERANCE < highest) {
      fail("invalid_choice", contract, field + ".answer.choice", "Choice result is not a highest-probability option.");
    }
    expectFiniteNumber(answer.confidence, contract, field + ".answer.confidence", { min: 0, max: 1 });
  } else if (question.type === "score") {
    assertOnlyKeys(answer, ["type", "score", "legend", "probabilities", "confidence"], contract, field + ".answer");
    const max = question.criteria.length - 1;
    expectFiniteNumber(answer.score, contract, field + ".answer.score", { min: 0, max });
    const expectedKeys = question.criteria.map((_, index) => String(index));
    expectObject(answer.legend, contract, field + ".answer.legend");
    const legendKeys = Object.keys(answer.legend).sort();
    if (legendKeys.length !== expectedKeys.length || legendKeys.some((key, index) => key !== expectedKeys[index])) {
      fail("invalid_legend", contract, field + ".answer.legend", "Score legend keys must be the ordered level indexes.");
    }
    for (let index = 0; index < question.criteria.length; index += 1) {
      if (answer.legend[String(index)] !== question.criteria[index]) {
        fail("invalid_legend", contract, field + ".answer.legend." + index, "Score legend text must match the request's ordered criteria.");
      }
    }
    validateProbabilityMap(answer.probabilities, expectedKeys, contract, field + ".answer.probabilities");
    const weighted = expectedKeys.reduce((total, key) => total + Number(key) * answer.probabilities[key], 0);
    if (Math.abs(answer.score - weighted) > DECISION_DISTRIBUTION_TOLERANCE) {
      fail("invalid_score", contract, field + ".answer.score", "Score must equal the probability-weighted level value.");
    }
    expectFiniteNumber(answer.confidence, contract, field + ".answer.confidence", { min: 0, max: 1 });
  } else {
    assertOnlyKeys(answer, ["type", "noul"], contract, field + ".answer");
    expectFiniteNumber(answer.noul, contract, field + ".answer.noul", { min: 0, max: 1 });
  }
  return status;
}

function validateUsage(usage, contract) {
  expectObject(usage, contract, "usage");
  assertOnlyKeys(usage, ["completeness", "input_tokens", "output_tokens", "provider_request_id", "reason"], contract, "usage");
  expectEnum(usage.completeness, ["complete", "incomplete", "unknown"], contract, "usage.completeness");
  const hasInput = Object.prototype.hasOwnProperty.call(usage, "input_tokens");
  const hasOutput = Object.prototype.hasOwnProperty.call(usage, "output_tokens");
  if (usage.completeness === "complete" && (!hasInput || !hasOutput)) {
    fail("invalid_usage", contract, "usage", "Complete usage requires input_tokens and output_tokens.");
  }
  if (usage.completeness === "unknown" && (hasInput || hasOutput)) {
    fail("invalid_usage", contract, "usage", "Unknown usage must not contain token counts.");
  }
  if (hasInput) expectInteger(usage.input_tokens, contract, "usage.input_tokens", { min: 0 });
  if (hasOutput) expectInteger(usage.output_tokens, contract, "usage.output_tokens", { min: 0 });
  if (usage.completeness !== "complete") {
    expectString(usage.reason, contract, "usage.reason", { maxLength: 500 });
  } else if (Object.prototype.hasOwnProperty.call(usage, "reason")) {
    fail("invalid_usage", contract, "usage.reason", "Complete usage cannot carry a missing-data reason.");
  }
  if (Object.prototype.hasOwnProperty.call(usage, "provider_request_id")) {
    expectString(usage.provider_request_id, contract, "usage.provider_request_id", { maxLength: 200 });
  }
  return usage;
}

function validateDecisionError(error, status, contract) {
  expectObject(error, contract, "error");
  assertOnlyKeys(error, ["code", "retryable", "fallback", "user_message", "diagnostic_ref", "retry_after_ms"], contract, "error");
  expectEnum(error.code, ["timeout", "cancelled", "provider_unavailable", "malformed_response", "unsupported_model", "scope_mismatch", "deadline_exceeded"], contract, "error.code");
  if (typeof error.retryable !== "boolean") fail("invalid_type", contract, "error.retryable", "Error retryable must be boolean.");
  expectEnum(error.fallback, ["review", "unavailable"], contract, "error.fallback");
  expectString(error.user_message, contract, "error.user_message", { maxLength: 500 });
  if (Object.prototype.hasOwnProperty.call(error, "diagnostic_ref")) {
    expectString(error.diagnostic_ref, contract, "error.diagnostic_ref", { maxLength: 300 });
  }
  if (Object.prototype.hasOwnProperty.call(error, "retry_after_ms")) {
    expectInteger(error.retry_after_ms, contract, "error.retry_after_ms", { min: 0, max: 3_600_000 });
  }
  if (status === "timeout" && error.code !== "timeout" && error.code !== "deadline_exceeded") {
    fail("invalid_error_status", contract, "error.code", "Timeout status requires a timeout or deadline error.");
  }
  if (status === "cancelled" && error.code !== "cancelled") {
    fail("invalid_error_status", contract, "error.code", "Cancelled status requires a cancelled error.");
  }
}

export function validateDecisionResult(request, result, options = {}) {
  const contract = "DecisionPortResult";
  validateDecisionRequest(request, options);
  expectObject(result, contract, contract);
  assertOnlyKeys(result, RESULT_KEYS, contract);
  if (result.contract !== contract || result.schema_version !== DECISION_PORT_SCHEMA_VERSION) {
    fail("unsupported_version", contract, "schema_version", "Expected DecisionPortResult schema version 1.0.");
  }
  validateCommonEnvelope(result, contract);
  for (const field of ["request_id", "logical_operation_id", "billable_attempt_id"]) {
    if (result[field] !== request[field]) {
      fail("reference_mismatch", contract, field, "Result " + field + " does not match the request.");
    }
  }
  if (result.correlation_id !== request.correlation_id) {
    fail("reference_mismatch", contract, "correlation_id", "Result correlation does not match the request.");
  }
  if (result.model_id !== request.model_policy.model_id) {
    fail("unsupported_model", contract, "model_id", "Result model does not match the pinned request model.");
  }
  if (result.model_policy_version !== request.model_policy.policy_version) {
    fail("version_mismatch", contract, "model_policy_version", "Result model policy does not match the request.");
  }
  const status = expectEnum(result.status, ["complete", "review", "unavailable", "timeout", "cancelled"], contract, "status");
  const usage = validateUsage(result.usage, contract);
  const resultAnswers = expectObject(result.answers, contract, "answers");
  const requestQuestions = expectObject(request.questions, "DecisionPortRequest", "request.questions");
  const requestIds = Object.keys(requestQuestions).sort();
  const resultIds = Object.keys(resultAnswers).sort();
  if (requestIds.length !== resultIds.length || requestIds.some((id, index) => id !== resultIds[index])) {
    fail("question_keys_mismatch", contract, "answers", "Result question IDs must exactly match the request.");
  }
  const answerStatuses = requestIds.map((id) =>
    validateAnswer(requestQuestions[id], resultAnswers[id], "answers." + id, contract));
  const reviewRequired = requestIds.some((id) => {
    const question = requestQuestions[id];
    const record = resultAnswers[id];
    if (record.status !== "answered") return true;
    if (question.type === "noul") {
      const { lower, upper } = question.policy.uncertain_probability_band;
      return record.answer.noul >= lower && record.answer.noul <= upper;
    }
    return record.answer.confidence < question.policy.minimum_confidence;
  });
  if (status === "complete" && answerStatuses.some((answerStatus) => answerStatus !== "answered")) {
    fail("invalid_result_status", contract, "status", "Complete results require answered responses for every question.");
  }
  if (status === "complete" && reviewRequired) {
    fail("invalid_result_status", contract, "status", "Low confidence, uncertain Noul results, and abstentions require review status.");
  }
  if (status === "review" && !reviewRequired) {
    fail("invalid_result_status", contract, "status", "Review status requires an abstention or a policy-defined uncertainty trigger.");
  }
  if (["unavailable", "timeout", "cancelled"].includes(status)) {
    if (answerStatuses.some((answerStatus) => answerStatus !== "unavailable")) {
      fail("invalid_result_status", contract, "status", "Unavailable results cannot contain answered questions.");
    }
    validateDecisionError(result.error, status, contract);
  } else if (Object.prototype.hasOwnProperty.call(result, "error")) {
    fail("invalid_result_status", contract, "error", "Complete and review results must use per-question abstention status.");
  }
  if (Object.prototype.hasOwnProperty.call(result, "provider_request_ref")) {
    expectString(result.provider_request_ref, contract, "provider_request_ref", { maxLength: 300 });
  }
  requireTrustedScope(options.trustedScope, contract);
  assertTrustedScope(result, options.trustedScope, contract);
  assertTrustedScope(request, options.trustedScope, "DecisionPortRequest");
  if (result.tenant_id !== request.tenant_id || result.project_id !== request.project_id) {
    fail("scope_mismatch", contract, "tenant_id", "Result scope does not match the request.");
  }
  rejectCredentialMaterial(result, contract);
  return result;
}

export function safeFallback(result) {
  if (result.status === "complete") {
    return Object.freeze({ outcome: "review_required", reason: "decision_results_do_not_grant_authority" });
  }
  if (result.status === "review") {
    return Object.freeze({ outcome: "review_required", reason: "question_abstained" });
  }
  return Object.freeze({ outcome: "unavailable", reason: result.status });
}
