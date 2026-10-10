import { createHash } from 'node:crypto';

const ROUTING_INTENTS = [
  'artwork_style_change',
  'new_concept',
  'deterministic_text_layout',
  'approved_logo_positioning',
  'factual_correction',
  'comparison_restore',
  'clarification',
  'unsupported_request',
];
const INSPECTION_OUTCOMES = [
  'valid',
  'unchanged',
  'wrong_subject',
  'drift',
  'corrupt',
  'refusal',
  'poor',
];
const COVERAGE_STRATA = [
  'compound',
  'ambiguous',
  'missing_facts',
  'locks',
  'injection',
  'stale_base',
  'permission',
  'race',
];
const SPLITS = {
  routing_calibration: { count: 160, classes: null },
  routing_held_out: { count: 400, classes: ROUTING_INTENTS, perClass: 50 },
  routing_safety: { count: 160, classes: null },
  inspection_calibration: { count: 56, classes: null },
  inspection_held_out: { count: 140, classes: INSPECTION_OUTCOMES, perClass: 20 },
};
const REQUIRED_TELEMETRY_FIELDS = [
  'question_id',
  'question_version',
  'stratum_id',
  'gold_label_ref',
  'prediction',
  'false_negative',
  'abstained',
  'latency_ms',
  'downstream_cost_status',
  'downstream_cost_amount',
  'uncertainty',
  'failure_status',
  'dependency_mode',
  'policy_sha256',
  'corpus_sha256',
];
const REQUIRED_FIXTURES_BY_PRIMITIVE = {
  choice: ['valid_answer', 'unknown_option', 'malformed_distribution', 'probability_out_of_range', 'timeout', 'abstention', 'injection'],
  score: ['valid_answer', 'wrong_legend', 'score_out_of_range', 'timeout', 'abstention', 'injection'],
  noul: ['valid_answer', 'invented_confidence', 'probability_out_of_range', 'timeout', 'abstention', 'injection'],
};
const EVAL_OWNER_ROLES = {
  'EVAL-02': 'Finance and reliability',
  'EVAL-03': 'Product and frontend',
  'EVAL-04': 'Finance and reliability',
};
const SENSITIVE_KEY = /(authorization|api[_-]?key|secret|credential|password|access[_-]?token|refresh[_-]?token|email|customer[_-]?(name|id|account)|account[_-]?(number|id)|raw[_-]?(prompt|response|image|brief))/i;
const SENSITIVE_VALUE = /\b(?:Bearer\s+[A-Za-z0-9._~+/=-]+|sk-[A-Za-z0-9_-]{8,}|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/i;
const SAFE_SCHEMA_FINDING_SEGMENTS = new Set(['budget_authorization']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!isRecord(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function add(findings, key, reason) {
  const safeKey = String(key).split(/([.:()[\]])/).map((segment) => {
    if (/^[.:()[\]]+$/.test(segment)) return segment;
    if (segment === '') return segment;
    if (SAFE_SCHEMA_FINDING_SEGMENTS.has(segment)) return segment;
    if (/^[A-Za-z0-9_-]{1,64}$/.test(segment) && !SENSITIVE_KEY.test(segment) && !SENSITIVE_VALUE.test(segment)) return segment;
    return '[redacted]';
  }).join('');
  findings.push({ key: safeKey, reason });
}

function verifyExternalEvidence(verifier, evidence, context) {
  if (typeof verifier !== 'function') return false;
  try {
    return verifier(evidence, context) === true;
  } catch {
    return false;
  }
}

function getPath(value, path) {
  return path.split('.').reduce((cursor, key) => cursor?.[key], value);
}

function sameJson(left, right) {
  return canonical(left) === canonical(right);
}

function assertExpectedTree(actual, expected, prefix, findings) {
  for (const [key, expectedValue] of Object.entries(expected)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isRecord(expectedValue)) {
      if (!isRecord(actual?.[key])) {
        add(findings, path, 'required_object_missing');
      } else {
        assertExpectedTree(actual[key], expectedValue, path, findings);
      }
    } else if (!sameJson(actual?.[key], expectedValue)) {
      add(findings, path, 'required_value_missing_or_changed');
    }
  }
}

const FIXED_POLICY_REQUIREMENTS = {
  workloads: {
    routing: {
      calibration: { count: 160 },
      held_out: { count: 400, by_intent: Object.fromEntries(ROUTING_INTENTS.map((intent) => [intent, 50])) },
      safety: { count: 160, separate_from_calibration_and_held_out: true },
    },
    inspection: {
      calibration: { count: 56 },
      held_out: { count: 140, by_outcome: Object.fromEntries(INSPECTION_OUTCOMES.map((outcome) => [outcome, 20])) },
    },
  },
  required_coverage: {
    minimum_cases_per_stratum: Object.fromEntries(COVERAGE_STRATA.map((stratum) => [stratum, 20])),
    zero_image_composition: 60,
    typed_control_zero_jev: 40,
  },
  decision_thresholds: {
    choice: { automatic_route_min_confidence: 0.85, automatic_route_min_top_probability: 0.9 },
    noul: { yes_min_probability: 0.9, no_max_probability: 0.1, otherwise: 'review' },
    score: {
      threshold_source: 'owner-published actual-level rubric required',
      rubric_path: 'docs/evaluation/creative-rubric.md',
    },
  },
  quality_targets: {
    routing: {
      macro_f1_min: 0.9,
      automatic_route_precision_min: 0.98,
      per_class_recall_min: 0.9,
      ordinary_abstention_max: 0.2,
    },
    inspection: {
      defect_recall_min: 0.95,
      defect_recall_includes: ['wrong_subject', 'drift'],
      valid_false_repair_max: 0.05,
      ordinary_abstention_max: 0.25,
      deterministic_safety_pass_rate: 1,
      unauthorized_actions_max: 0,
    },
    visual: {
      non_refusal_compliance_score_min: 4,
      score_scale_max: 5,
      non_refusal_trials_at_or_above_score_min_rate: 0.9,
      edit_scope_preservation_score_min: 4,
      edit_scope_preservation_scale_max: 5,
      edit_trials_at_or_above_score_min_rate: 0.9,
      report_refusals_separately: true,
      report_all_failures: true,
    },
    jev_comparison: {
      quality_macro_f1_within_best_baseline_max_delta: 0.02,
      downstream_cost_per_success_reduction_min: 0.2,
      routed_decision_p95_seconds_max: 2,
      routed_decision_p95_must_not_exceed_generative_baseline: true,
      cost_includes: ['vision', 'decomposition', 'escalation', 'retries', 'repairs'],
      unknown_total_cost_blocks_economy_claim: true,
    },
    uncertainty: { family_bootstrap_interval_level: 0.95, preserve_negative_findings: true },
    benign_visual_availability: {
      minimum_inspectable_rate: 0.9,
      generation_trial_denominator: 36,
      edit_trial_denominator: 36,
      within_bounded_policy: true,
      refusals_failures_and_unexecuted_descendant_edits_count_as_misses: true,
      disallowed_safety_trials_reported_separately: true,
    },
  },
  visual_workload: {
    briefs: 12,
    families: 4,
    generations_per_brief: 3,
    edits_per_generation: 1,
    generation_trials: 36,
    edit_trials: 36,
    requires_separate_budget_authorization_before_execution: true,
  },
  evaluation_protocol: {
    two_independent_human_reviewers: true,
    adjudication_required: true,
    freeze_calibration_policy_and_corpus_hashes_before_held_out: true,
    held_out_tuning_invalidates_run: true,
    report_per_question_and_stratum: ['false_negatives', 'abstention', 'latency', 'downstream_cost', 'uncertainty'],
    retain_failures_in_denominators: true,
    public_evidence_must_redact_secrets_and_personal_data: true,
  },
};

export function validatePolicy(policy) {
  const findings = [];
  if (!isRecord(policy)) return [{ key: 'policy', reason: 'required_object_missing' }];
  if (policy.schema_version !== 'creative-eval-policy/v1') add(findings, 'policy.schema_version', 'unsupported_or_missing');
  if (policy.policy_id !== 'CE-Q01') add(findings, 'policy.policy_id', 'must_remain_CE-Q01');
  if (typeof policy.version !== 'string' || policy.version.length === 0) add(findings, 'policy.version', 'required');
  if (!['proposed', 'accepted'].includes(policy.status)) add(findings, 'policy.status', 'must_be_proposed_or_explicitly_accepted');
  assertExpectedTree(policy, FIXED_POLICY_REQUIREMENTS, 'policy', findings);
  const scoreRubric = policy.decision_thresholds?.score;
  if (!isRecord(scoreRubric)) add(findings, 'policy.decision_thresholds.score', 'score_rubric_record_required');
  else if (scoreRubric.status === 'pending-owner-rubric') {
    if (scoreRubric.accepted_cutoffs !== null) add(findings, 'policy.decision_thresholds.score.accepted_cutoffs', 'pending_rubric_must_not_claim_accepted_cutoffs');
  } else if (scoreRubric.status === 'accepted') {
    if (!isRecord(scoreRubric.accepted_cutoffs) || Object.keys(scoreRubric.accepted_cutoffs).length === 0) add(findings, 'policy.decision_thresholds.score.accepted_cutoffs', 'accepted_rubric_requires_level_cutoffs');
    if (!isSha256(scoreRubric.rubric_sha256)) add(findings, 'policy.decision_thresholds.score.rubric_sha256', 'accepted_rubric_hash_required');
  } else {
    add(findings, 'policy.decision_thresholds.score.status', 'pending_or_owner_accepted_rubric_required');
  }

  const requiredQuestionOwners = [
    { issue_key: 'CE-06', issue_number: 18, owner_role: 'Creative and fulfillment' },
    { issue_key: 'CE-09', issue_number: 16, owner_role: 'Creative and fulfillment' },
  ];
  for (const requiredOwner of requiredQuestionOwners) {
    const owner = Array.isArray(policy.question_owners)
      ? policy.question_owners.find((candidate) => candidate?.issue_key === requiredOwner.issue_key)
      : undefined;
    if (!owner) add(findings, `policy.question_owners.${requiredOwner.issue_key}`, 'question_owner_record_missing');
    else {
      for (const [field, expected] of Object.entries(requiredOwner)) {
        if (owner[field] !== expected) add(findings, `policy.question_owners.${requiredOwner.issue_key}.${field}`, 'question_owner_scope_must_be_preserved');
      }
    }
  }

  for (const [key, ownerRole] of Object.entries(EVAL_OWNER_ROLES)) {
    const entries = policy.authoritative_acceptance;
    const entry = Array.isArray(entries) ? entries.find((candidate) => candidate?.id === key) : undefined;
    if (!entry) add(findings, `policy.authoritative_acceptance.${key}`, 'required_acceptance_record_missing');
    else {
      if (entry.owner_role !== ownerRole) add(findings, `policy.authoritative_acceptance.${key}.owner_role`, 'global_owner_must_be_preserved');
      if (!['pending', 'accepted'].includes(entry.status)) add(findings, `policy.authoritative_acceptance.${key}.status`, 'invalid_status');
      if (entry.status === 'accepted' && !isSha256(entry.evidence_sha256)) add(findings, `policy.authoritative_acceptance.${key}.evidence_sha256`, 'accepted_status_requires_pinned_evidence_hash');
    }
  }

  const modelPins = policy.model_pins;
  for (const pinName of ['vision_observation', 'generative_classification_baseline', 'model_based_planning']) {
    const pin = modelPins?.[pinName];
    if (!isRecord(pin)) {
      add(findings, `policy.model_pins.${pinName}`, 'required_model_pin_record_missing');
      continue;
    }
    for (const field of ['model_id', 'configuration_sha256', 'account_access_verification_sha256', 'status']) {
      if (!(field in pin)) add(findings, `policy.model_pins.${pinName}.${field}`, 'required_key_missing');
    }
    if (pin.configuration_sha256 !== null && !isSha256(pin.configuration_sha256)) add(findings, `policy.model_pins.${pinName}.configuration_sha256`, 'must_be_sha256_or_null_while_unresolved');
    if (pin.account_access_verification_sha256 !== null && !isSha256(pin.account_access_verification_sha256)) add(findings, `policy.model_pins.${pinName}.account_access_verification_sha256`, 'must_be_sha256_or_null_while_unresolved');
  }

  return findings;
}

function validateQuestionRecord(question, index, findings) {
  const prefix = `questionRegister.questions.${question?.question_id ?? index}`;
  if (!isRecord(question)) {
    add(findings, prefix, 'question_record_must_be_object');
    return;
  }
  const required = [
    'question_id', 'version', 'owner_issue_key', 'owner_role', 'primitive', 'schema_sha256',
    'model_pin', 'permitted_states', 'permitted_options', 'dependencies', 'fallback',
    'required_strata', 'thresholds', 'telemetry_event', 'fixture_ref',
  ];
  for (const field of required) if (!(field in question)) add(findings, `${prefix}.${field}`, 'required_key_missing');
  if (typeof question.question_id !== 'string' || question.question_id.length === 0) add(findings, `${prefix}.question_id`, 'required_nonempty_id');
  if (typeof question.version !== 'string' || question.version.length === 0) add(findings, `${prefix}.version`, 'required_nonempty_question_version');
  if (!['CE-06', 'CE-09'].includes(question.owner_issue_key)) add(findings, `${prefix}.owner_issue_key`, 'must_be_owned_by_CE-06_or_CE-09');
  if (question.owner_role !== 'Creative and fulfillment') add(findings, `${prefix}.owner_role`, 'question_owner_role_must_be_preserved');
  if (!Object.hasOwn(REQUIRED_FIXTURES_BY_PRIMITIVE, question.primitive)) add(findings, `${prefix}.primitive`, 'must_be_choice_score_or_noul');
  if (!isSha256(question.schema_sha256)) add(findings, `${prefix}.schema_sha256`, 'pinned_schema_hash_required');
  if (!isRecord(question.model_pin)) add(findings, `${prefix}.model_pin`, 'model_configuration_pin_required');
  else {
    for (const field of ['model_id', 'configuration_sha256', 'access_verification_sha256']) {
      const valid = field === 'model_id'
        ? typeof question.model_pin[field] === 'string' && question.model_pin[field].length > 0
        : isSha256(question.model_pin[field]);
      if (!valid) add(findings, `${prefix}.model_pin.${field}`, 'required_pinned_value');
    }
  }
  if (!Array.isArray(question.permitted_states) || question.permitted_states.length === 0) add(findings, `${prefix}.permitted_states`, 'nonempty_state_set_required');
  if (question.primitive === 'choice' && (!Array.isArray(question.permitted_options) || question.permitted_options.length < 2)) add(findings, `${prefix}.permitted_options`, 'choice_requires_explicit_options');
  if (!Array.isArray(question.dependencies)) add(findings, `${prefix}.dependencies`, 'must_be_array');
  if (typeof question.fallback !== 'string' || question.fallback.length === 0) add(findings, `${prefix}.fallback`, 'explicit_fallback_required');
  if (!Array.isArray(question.required_strata) || question.required_strata.length === 0) add(findings, `${prefix}.required_strata`, 'nonempty_question_strata_required');
  if (!isRecord(question.thresholds) || Object.keys(question.thresholds).length === 0) add(findings, `${prefix}.thresholds`, 'question_specific_accepted_threshold_required');
  if (typeof question.telemetry_event !== 'string' || question.telemetry_event.length === 0) add(findings, `${prefix}.telemetry_event`, 'required_telemetry_binding');
  if (typeof question.fixture_ref !== 'string' || question.fixture_ref.length === 0) add(findings, `${prefix}.fixture_ref`, 'primitive_fixture_reference_required');
}

export function validateQuestionRegister(register, {
  requiredQuestionIds,
  expectedQuestionDefinitions,
  corpusManifest,
  telemetrySchema,
  questionFixtures,
  allowSyntheticFixture = false,
} = {}) {
  const findings = [];
  if (!isRecord(register)) return [{ key: 'questionRegister', reason: 'required_object_missing' }];
  if (register.schema_version !== 'creative-eval-question-register/v1') add(findings, 'questionRegister.schema_version', 'unsupported_or_missing');
  if (register.status !== 'owner-published' && !(allowSyntheticFixture && register.status === 'synthetic-fixture-only')) {
    add(findings, 'questionRegister.status', 'owner_published_register_required');
  }
  for (const expectedOwner of [
    { issue_key: 'CE-06', owner_role: 'Creative and fulfillment' },
    { issue_key: 'CE-09', owner_role: 'Creative and fulfillment' },
  ]) {
    const owner = Array.isArray(register.owner_sources)
      ? register.owner_sources.find((candidate) => candidate?.issue_key === expectedOwner.issue_key)
      : undefined;
    if (!owner) add(findings, `questionRegister.owner_sources.${expectedOwner.issue_key}`, 'question_owner_source_missing');
    else if (owner.owner_role !== expectedOwner.owner_role) add(findings, `questionRegister.owner_sources.${expectedOwner.issue_key}.owner_role`, 'question_owner_role_must_be_preserved');
  }
  if (!Array.isArray(requiredQuestionIds) || requiredQuestionIds.length === 0) {
    add(findings, 'questionRegister.inventory_pin.required_question_ids', 'independently_pinned_nonempty_owner_inventory_required');
  } else {
    if (requiredQuestionIds.some((id) => typeof id !== 'string' || id.length === 0)) add(findings, 'questionRegister.inventory_pin.required_question_ids', 'question_ids_must_be_nonempty_strings');
    if (new Set(requiredQuestionIds).size !== requiredQuestionIds.length) add(findings, 'questionRegister.inventory_pin.required_question_ids', 'question_ids_must_be_unique');
  }
  if (!isRecord(expectedQuestionDefinitions) || Object.keys(expectedQuestionDefinitions).length === 0) {
    add(findings, 'questionRegister.inventory_pin.question_definitions', 'independently_pinned_question_definitions_required');
  }
  if (Array.isArray(requiredQuestionIds) && requiredQuestionIds.length > 0 && isRecord(expectedQuestionDefinitions)) {
    const definitionIds = Object.keys(expectedQuestionDefinitions).sort();
    if (!sameJson(definitionIds, [...requiredQuestionIds].sort())) add(findings, 'questionRegister.inventory_pin.question_definitions', 'definitions_must_match_independent_question_id_inventory');
    for (const [id, definition] of Object.entries(expectedQuestionDefinitions)) {
      if (!isRecord(definition) || definition.question_id !== id) add(findings, `questionRegister.inventory_pin.question_definitions.${id}`, 'definition_id_must_match_inventory_key');
    }
  }
  const claimedInventory = register.inventory_pin?.required_question_ids;
  if (!Array.isArray(claimedInventory) || claimedInventory.length === 0) {
    add(findings, 'questionRegister.inventory_pin.required_question_ids', 'empty_inventory_cannot_pass_vacuously');
  } else if (Array.isArray(requiredQuestionIds) && requiredQuestionIds.length > 0) {
    if (!sameJson([...claimedInventory].sort(), [...requiredQuestionIds].sort())) add(findings, 'questionRegister.inventory_pin.required_question_ids', 'does_not_match_independent_expected_inventory');
    const expectedDefinitions = isRecord(expectedQuestionDefinitions)
      ? Object.values(expectedQuestionDefinitions).filter(isRecord).sort((left, right) => String(left.question_id ?? '').localeCompare(String(right.question_id ?? '')))
      : [];
    const definitionHashes = expectedDefinitions.length === Object.keys(expectedQuestionDefinitions ?? {}).length && expectedDefinitions.length > 0
      ? canonicalSha256(expectedDefinitions)
      : null;
    if (!isSha256(definitionHashes) || register.inventory_pin?.sha256 !== definitionHashes) add(findings, 'questionRegister.inventory_pin.sha256', 'inventory_hash_does_not_match_independent_expected_definitions');
  }
  const registeredQuestions = Array.isArray(register.questions) ? register.questions : [];
  if (allowSyntheticFixture && registeredQuestions.some((question) => (
    question?.synthetic !== true
    || typeof question?.question_id !== 'string'
    || !question.question_id.startsWith('fixture.')
  ))) {
    add(findings, 'questionRegister.questions', 'synthetic_questions_must_be_explicitly_test_only');
  }
  if (!Array.isArray(register.questions) || register.questions.length === 0) {
    add(findings, 'questionRegister.questions', 'empty_register_cannot_pass_vacuously');
  }

  const actualIds = registeredQuestions.map((item) => item?.question_id).filter((id) => typeof id === 'string');
  if (new Set(actualIds).size !== actualIds.length) add(findings, 'questionRegister.questions', 'duplicate_question_id');
  if (Array.isArray(requiredQuestionIds) && requiredQuestionIds.length > 0) {
    for (const id of requiredQuestionIds) if (!actualIds.includes(id)) add(findings, `questionRegister.questions.${id}`, 'required_question_missing_from_register');
    for (const id of actualIds) if (!requiredQuestionIds.includes(id)) add(findings, `questionRegister.questions.${id}`, 'unregistered_question_id');
  }

  if (Array.isArray(register.questions)) register.questions.forEach((question, index) => validateQuestionRecord(question, index, findings));
  if (isRecord(expectedQuestionDefinitions)) {
    for (const question of registeredQuestions) {
      const questionId = question?.question_id;
      const expected = typeof questionId === 'string' && Object.hasOwn(expectedQuestionDefinitions, questionId)
        ? expectedQuestionDefinitions[questionId]
        : undefined;
      if (!expected || !isRecord(question)) continue;
      const independentlyBoundFields = new Set([
        'question_id', 'version', 'owner_issue_key', 'owner_role', 'primitive', 'schema_sha256',
        'model_pin', 'permitted_states', 'permitted_options', 'dependencies', 'fallback',
        'required_strata', 'thresholds', 'telemetry_event', 'fixture_ref', 'synthetic',
      ]);
      for (const field of independentlyBoundFields) {
        if (!sameJson(question[field], expected[field])) add(findings, `questionRegister.questions.${questionId}.${field}`, 'does_not_match_independently_pinned_definition');
      }
      const allFields = new Set([...Object.keys(question), ...Object.keys(expected)]);
      for (const field of allFields) {
        if (!independentlyBoundFields.has(field) && !sameJson(question[field], expected[field])) {
          add(findings, `questionRegister.questions.${questionId}.definition`, 'does_not_match_independently_pinned_definition');
          break;
        }
      }
    }
  }

  const fixtureRows = Array.isArray(questionFixtures) ? questionFixtures : [];
  const corpusSplits = Array.isArray(corpusManifest?.splits) ? corpusManifest.splits : [];
  const allSamples = corpusSplits.flatMap((split) => Array.isArray(split?.samples) ? split.samples : []);
  const events = Array.isArray(telemetrySchema?.events) ? telemetrySchema.events : [];
  const telemetryRequiredFields = Array.isArray(telemetrySchema?.required_fields) ? telemetrySchema.required_fields : [];
  for (const question of registeredQuestions) {
    const id = question?.question_id;
    if (!id) continue;
    const event = events.find((candidate) => candidate?.id === question.telemetry_event);
    if (!event) add(findings, `questionRegister.questions.${id}.telemetry_event`, 'event_missing_from_telemetry_schema');
    else {
      if (!Array.isArray(event.question_ids) || !event.question_ids.includes(id)) add(findings, `telemetrySchema.events.${event.id}.question_ids.${id}`, 'question_event_binding_missing');
      for (const field of REQUIRED_TELEMETRY_FIELDS) {
        const eventFields = Array.isArray(event.fields) ? event.fields : [];
        if (!telemetryRequiredFields.includes(field) || !eventFields.includes(field)) add(findings, `telemetrySchema.events.${event.id}.fields.${field}`, 'required_evaluation_telemetry_field_missing');
      }
    }

    const fixture = fixtureRows.find((candidate) => candidate?.question_id === id);
    const requiredFixtures = Object.hasOwn(REQUIRED_FIXTURES_BY_PRIMITIVE, question.primitive)
      ? REQUIRED_FIXTURES_BY_PRIMITIVE[question.primitive]
      : [];
    if (!fixture) add(findings, `questionFixtures.${id}`, 'primitive_fixture_record_missing');
    else {
      const cases = Array.isArray(fixture.cases) ? fixture.cases : [];
      if (fixture.primitive !== question.primitive) add(findings, `questionFixtures.${id}.primitive`, 'fixture_primitive_must_match_register');
      for (const caseId of requiredFixtures) if (!cases.includes(caseId)) add(findings, `questionFixtures.${id}.${caseId}`, 'required_primitive_fixture_missing');
      if (fixture.synthetic !== true && allowSyntheticFixture) add(findings, `questionFixtures.${id}.synthetic`, 'test_fixture_must_be_explicitly_synthetic');
    }

    const questionSamples = allSamples.filter((sample) => Array.isArray(sample?.question_ids) && sample.question_ids.includes(id));
    if (questionSamples.length === 0) add(findings, `corpusManifest.questions.${id}`, 'question_absent_from_corpus_strata');
    const questionStrata = Array.isArray(question?.required_strata) ? question.required_strata : [];
    for (const stratum of questionStrata) {
      const stratumKey = typeof stratum === 'string' ? stratum : stratum?.id;
      const splitId = typeof stratum === 'string' ? null : stratum?.split_id;
      const minimum = typeof stratum === 'string' ? 1 : stratum?.minimum;
      if (!stratumKey || !Number.isInteger(minimum) || minimum < 1) {
        add(findings, `questionRegister.questions.${id}.required_strata`, 'stratum_requires_id_and_positive_minimum');
        continue;
      }
      const candidates = corpusSplits
        .filter((split) => !splitId || split?.id === splitId)
        .flatMap((split) => Array.isArray(split?.samples) ? split.samples : []);
      const count = candidates.filter((sample) => Array.isArray(sample.question_ids) && sample.question_ids.includes(id) && Array.isArray(sample.strata) && sample.strata.includes(stratumKey)).length;
      if (count < minimum) add(findings, `corpusManifest.questions.${id}.strata.${stratumKey}`, `requires_${minimum}_found_${count}`);
    }
  }
  return findings;
}

export function validateTelemetrySchema(schema) {
  const findings = [];
  if (!isRecord(schema)) return [{ key: 'telemetrySchema', reason: 'required_object_missing' }];
  if (schema.schema_version !== 'creative-eval-telemetry-proposal/v1') add(findings, 'telemetrySchema.schema_version', 'unsupported_or_missing');
  const fields = Array.isArray(schema.required_fields) ? schema.required_fields : [];
  if (!Array.isArray(schema.required_fields)) add(findings, 'telemetrySchema.required_fields', 'required_field_list_missing');
  for (const field of REQUIRED_TELEMETRY_FIELDS) {
    if (!fields.includes(field)) add(findings, `telemetrySchema.required_fields.${field}`, 'required_evaluation_telemetry_field_missing');
  }
  if (!Array.isArray(schema.events) || schema.events.length === 0) add(findings, 'telemetrySchema.events', 'producer_event_schema_missing');
  else {
    const ids = schema.events.map((event) => event?.id).filter((id) => typeof id === 'string');
    if (ids.length !== schema.events.length || new Set(ids).size !== ids.length) add(findings, 'telemetrySchema.events', 'event_ids_must_be_present_and_unique');
    for (const event of schema.events) {
      if (!Array.isArray(event?.question_ids) || event.question_ids.length === 0) add(findings, `telemetrySchema.events.${event?.id ?? 'unknown'}.question_ids`, 'event_must_bind_question_ids');
      if (!Array.isArray(event?.fields)) add(findings, `telemetrySchema.events.${event?.id ?? 'unknown'}.fields`, 'event_fields_must_be_array');
    }
  }
  return findings;
}

function validateReviewerSet(split, splitPrefix, findings, allowSyntheticFixture) {
  const reviewers = split.labeling?.reviewers;
  if (!Array.isArray(reviewers) || reviewers.length < 2) {
    add(findings, `${splitPrefix}.labeling.reviewers`, 'two_independent_reviewers_required');
    return;
  }
  const ids = reviewers.map((reviewer) => reviewer?.reviewer_id).filter(Boolean);
  if (ids.length !== reviewers.length || new Set(ids).size !== reviewers.length) add(findings, `${splitPrefix}.labeling.reviewers`, 'reviewer_identities_must_be_present_and_distinct');
  if (!allowSyntheticFixture && reviewers.some((reviewer) => reviewer?.status !== 'approved')) add(findings, `${splitPrefix}.labeling.reviewers`, 'independent_human_approval_required');
  if (!allowSyntheticFixture && reviewers.some((reviewer) => !isSha256(reviewer?.approval_sha256) || !isSha256(reviewer?.independence_evidence_sha256))) add(findings, `${splitPrefix}.labeling.reviewers`, 'pinned_independent_reviewer_approval_required');
  if (allowSyntheticFixture && reviewers.some((reviewer) => reviewer?.status !== 'synthetic-only')) add(findings, `${splitPrefix}.labeling.reviewers`, 'synthetic_reviewers_must_be_marked_test_only');
  if (!allowSyntheticFixture && !isSha256(split.labeling?.adjudication_sha256)) add(findings, `${splitPrefix}.labeling.adjudication_sha256`, 'pinned_independent_adjudication_required');
  if (allowSyntheticFixture && split.labeling?.adjudication_sha256 !== null && !isSha256(split.labeling?.adjudication_sha256)) add(findings, `${splitPrefix}.labeling.adjudication_sha256`, 'must_be_sha256_or_null');
}

export function digestSampleHashes(sampleHashes) {
  return sha256([...sampleHashes].sort().join('\n'));
}

export function digestSampleRecords(samples) {
  const records = [...samples].map((sample) => ({
    sha256: sample.sha256,
    family_id: sample.family_id ?? null,
    gold_label_ref: sample.gold_label_ref ?? null,
    fixture_label: sample.fixture_label ?? null,
    question_ids: Array.isArray(sample.question_ids) ? [...sample.question_ids].sort() : [],
    strata: Array.isArray(sample.strata) ? [...sample.strata].sort() : [],
  })).sort((left, right) => left.sha256.localeCompare(right.sha256));
  return sha256(canonical(records));
}

export function digestFrozenRunInputs({ policySha256, calibrationSha256, corpusSha256 }) {
  return sha256(canonical({ policySha256, calibrationSha256, corpusSha256 }));
}

export function digestCorpusContent(manifest) {
  const splitDigests = (Array.isArray(manifest?.splits) ? manifest.splits : [])
    .filter((split) => typeof split?.id === 'string' && isSha256(split.content_sha256))
    .map((split) => ({ id: split.id, sha256: split.content_sha256 }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return sha256(canonical(splitDigests));
}

export function digestCalibrationContent(manifest) {
  const calibrationDigests = (Array.isArray(manifest?.splits) ? manifest.splits : [])
    .filter((split) => ['routing_calibration', 'inspection_calibration'].includes(split?.id) && isSha256(split.content_sha256))
    .map((split) => ({ id: split.id, sha256: split.content_sha256 }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return sha256(canonical(calibrationDigests));
}

export function validateCorpusManifest(manifest, { allowSyntheticFixture = false, policy } = {}) {
  const findings = [];
  if (!isRecord(manifest)) return [{ key: 'corpusManifest', reason: 'required_object_missing' }];
  if (manifest.schema_version !== 'creative-eval-corpus-manifest/v1') add(findings, 'corpusManifest.schema_version', 'unsupported_or_missing');
  if (allowSyntheticFixture) {
    if (manifest.status !== 'synthetic-fixture-only' || manifest.source_kind !== 'synthetic-test-fixture') add(findings, 'corpusManifest.source_kind', 'synthetic_fixture_must_be_explicitly_test_only');
  } else if (manifest.status !== 'accepted' || manifest.source_kind !== 'owner-accepted-corpus') {
    add(findings, 'corpusManifest.source_kind', 'independently_accepted_owner_corpus_required');
  }
  if (manifest.review_requirements?.independent_human_reviewers !== 2) add(findings, 'corpusManifest.review_requirements.independent_human_reviewers', 'must_equal_2');
  if (manifest.review_requirements?.adjudication_required !== true) add(findings, 'corpusManifest.review_requirements.adjudication_required', 'must_be_true');
  if (manifest.review_requirements?.owner_acceptance_required !== true) add(findings, 'corpusManifest.review_requirements.owner_acceptance_required', 'must_be_true');
  const splits = Array.isArray(manifest.splits) ? manifest.splits : [];
  const byId = new Map();
  for (const split of splits) {
    if (byId.has(split?.id)) add(findings, `corpusManifest.splits.${split?.id}`, 'duplicate_split_id');
    else if (typeof split?.id === 'string') byId.set(split.id, split);
  }
  for (const [id, requirement] of Object.entries(SPLITS)) {
    const split = byId.get(id);
    const prefix = `corpusManifest.splits.${id}`;
    if (!split) {
      add(findings, prefix, 'required_split_missing');
      continue;
    }
    if (split.planned_count !== requirement.count) add(findings, `${prefix}.planned_count`, `must_equal_${requirement.count}`);
    if (!Array.isArray(split.samples)) {
      add(findings, `${prefix}.samples`, 'sample_hash_records_required');
      continue;
    }
    if (split.samples.length !== requirement.count) add(findings, `${prefix}.samples`, `requires_${requirement.count}_samples_found_${split.samples.length}`);
    const seenWithin = new Set();
    for (const [sampleIndex, sample] of split.samples.entries()) {
      if (!isRecord(sample)) {
        add(findings, `${prefix}.samples.${sampleIndex}`, 'sample_record_must_be_object');
        continue;
      }
      if (!isSha256(sample.sha256)) add(findings, `${prefix}.samples.${sampleIndex}.sha256`, 'immutable_sample_sha256_required');
      else if (seenWithin.has(sample.sha256)) add(findings, `${prefix}.samples.${sampleIndex}.sha256`, 'duplicate_sample_hash_in_split');
      else seenWithin.add(sample.sha256);
      if (typeof sample.family_id !== 'string' || sample.family_id.trim().length === 0) add(findings, `${prefix}.samples.${sampleIndex}.family_id`, 'immutable_sample_family_required');
      if (!Array.isArray(sample.question_ids) || sample.question_ids.length === 0) add(findings, `${prefix}.samples.${sampleIndex}.question_ids`, 'question_inventory_binding_required');
      if (!Array.isArray(sample.strata)) add(findings, `${prefix}.samples.${sampleIndex}.strata`, 'strata_tags_required');
      if (allowSyntheticFixture) {
        if (sample.origin !== 'synthetic-test-fixture') add(findings, `${prefix}.samples.${sampleIndex}.origin`, 'fixture_samples_must_be_explicitly_synthetic');
        if (typeof sample.fixture_label !== 'string' || sample.fixture_label.length === 0) add(findings, `${prefix}.samples.${sampleIndex}.fixture_label`, 'synthetic_fixture_label_required');
      } else {
        if (sample.origin === 'synthetic-test-fixture' || 'fixture_label' in sample) add(findings, `${prefix}.samples.${sampleIndex}.origin`, 'synthetic_labels_cannot_satisfy_corpus_acceptance');
        if (!isSha256(sample.gold_label_ref) || sample.label_status !== 'adjudicated') add(findings, `${prefix}.samples.${sampleIndex}.gold_label_ref`, 'independently_adjudicated_label_reference_required');
      }
    }
    if (!isSha256(split.content_sha256)) add(findings, `${prefix}.content_sha256`, 'immutable_split_digest_required');
    else if (split.samples.every((sample) => isSha256(sample?.sha256)) && split.content_sha256 !== digestSampleRecords(split.samples)) {
      add(findings, `${prefix}.content_sha256`, 'digest_does_not_match_sample_hash_set');
    }
    const license = split.license;
    if (!isRecord(license)) add(findings, `${prefix}.license`, 'license_provenance_required');
    else if (allowSyntheticFixture) {
      if (license.status !== 'synthetic-test-only') add(findings, `${prefix}.license.status`, 'fixture_license_must_be_test_only');
    } else if (license.status !== 'licensed' || !isSha256(license.provenance_sha256)) {
      add(findings, `${prefix}.license`, 'licensed_provenance_hash_required');
    }
    if (!isRecord(split.labeling)) add(findings, `${prefix}.labeling`, 'human_label_review_record_required');
    else validateReviewerSet(split, prefix, findings, allowSyntheticFixture);
    if (!allowSyntheticFixture && split.labeling?.status !== 'adjudicated') add(findings, `${prefix}.labeling.status`, 'adjudicated_human_labels_required');
    if (allowSyntheticFixture && split.labeling?.status !== 'synthetic-test-only') add(findings, `${prefix}.labeling.status`, 'fixture_labels_must_be_test_only');
    if (split.labeling?.adjudication_status !== (allowSyntheticFixture ? 'synthetic-only' : 'adjudicated')) add(findings, `${prefix}.labeling.adjudication_status`, 'independent_adjudication_required');
    if (allowSyntheticFixture && split.status !== 'synthetic-fixture-only') add(findings, `${prefix}.status`, 'split_must_be_test_only');
    if (!allowSyntheticFixture && split.status !== 'accepted') add(findings, `${prefix}.status`, 'independent_split_acceptance_required');
    const acceptedOwnerRecord = allowSyntheticFixture
      ? split.owner_acceptance?.status === 'synthetic-only' && isSha256(split.owner_acceptance?.evidence_sha256)
      : split.owner_acceptance?.status === 'accepted' && isSha256(split.owner_acceptance?.evidence_sha256);
    if (!acceptedOwnerRecord) {
      add(findings, `${prefix}.owner_acceptance`, 'split_owner_acceptance_with_hash_required');
    }
    for (const stratum of requirement.classes ?? []) {
      const count = split.samples.filter((sample) => Array.isArray(sample?.strata) && sample.strata.includes(stratum)).length;
      if (count !== requirement.perClass) add(findings, `${prefix}.strata.${stratum}`, `requires_${requirement.perClass}_found_${count}`);
    }
    if (requirement.classes) {
      for (const [sampleIndex, sample] of split.samples.entries()) {
        const taskLabels = Array.isArray(sample?.strata) ? sample.strata.filter((stratum) => requirement.classes.includes(stratum)) : [];
        if (taskLabels.length !== 1) add(findings, `${prefix}.samples.${sampleIndex}.strata`, 'held_out_sample_requires_exactly_one_task_class');
      }
    }
  }

  const hashes = new Map();
  const allSamples = [];
  for (const split of splits) {
    for (const sample of Array.isArray(split?.samples) ? split.samples : []) {
      if (!isSha256(sample?.sha256)) continue;
      const previous = hashes.get(sample.sha256);
      if (previous) add(findings, `corpusManifest.splits.${split?.id}.samples.${sample.sha256}`, `hash_reused_from_${previous}`);
      else hashes.set(sample.sha256, split?.id ?? 'unknown');
      allSamples.push(sample);
    }
  }
  const disjointFamilyGroups = [
    ['routing_calibration', 'routing_held_out', 'routing_safety'],
    ['inspection_calibration', 'inspection_held_out'],
  ];
  for (const group of disjointFamilyGroups) {
    const familyOwner = new Map();
    for (const splitId of group) {
      const split = byId.get(splitId);
      for (const [sampleIndex, sample] of (Array.isArray(split?.samples) ? split.samples : []).entries()) {
        if (typeof sample?.family_id !== 'string' || sample.family_id.trim().length === 0) continue;
        const familyKey = sample.family_id.trim().toLowerCase();
        const previous = familyOwner.get(familyKey);
        if (previous && previous !== splitId) {
          add(findings, `corpusManifest.splits.${splitId}.samples.${sampleIndex}.family_id`, `family_reused_from_${previous}`);
        } else {
          familyOwner.set(familyKey, splitId);
        }
      }
    }
  }
  for (const stratum of COVERAGE_STRATA) {
    const count = allSamples.filter((sample) => Array.isArray(sample?.strata) && sample.strata.includes(stratum)).length;
    if (count < 20) add(findings, `corpusManifest.required_cross_split_coverage.${stratum}`, `requires_20_found_${count}`);
  }
  const zeroImage = allSamples.filter((sample) => Array.isArray(sample?.strata) && sample.strata.includes('zero_image_composition')).length;
  if (zeroImage < 60) add(findings, 'corpusManifest.required_cross_split_coverage.zero_image_composition', `requires_60_found_${zeroImage}`);
  const typedZeroJev = allSamples.filter((sample) => Array.isArray(sample?.strata) && sample.strata.includes('typed_control_zero_jev')).length;
  if (typedZeroJev < 40) add(findings, 'corpusManifest.required_cross_split_coverage.typed_control_zero_jev', `requires_40_found_${typedZeroJev}`);

  if (manifest.immutable !== true) add(findings, 'corpusManifest.immutable', 'corpus_must_be_immutable_before_held_out');
  if (manifest.freeze?.frozen_before_held_out !== true) add(findings, 'corpusManifest.freeze.frozen_before_held_out', 'freeze_must_precede_held_out');
  for (const field of ['policy_sha256', 'calibration_sha256', 'corpus_sha256']) {
    if (!isSha256(manifest.freeze?.[field])) add(findings, `corpusManifest.freeze.${field}`, 'frozen_input_sha256_required');
  }
  if (isRecord(policy) && isSha256(manifest.freeze?.policy_sha256) && manifest.freeze.policy_sha256 !== canonicalSha256(policy)) {
    add(findings, 'corpusManifest.freeze.policy_sha256', 'policy_hash_does_not_match_policy_artifact');
  }
  const expectedCalibrationHash = digestCalibrationContent(manifest);
  const hasBothCalibrationHashes = ['routing_calibration', 'inspection_calibration'].every((id) => isSha256(byId.get(id)?.content_sha256));
  if (hasBothCalibrationHashes && isSha256(manifest.freeze?.calibration_sha256) && manifest.freeze.calibration_sha256 !== expectedCalibrationHash) {
    add(findings, 'corpusManifest.freeze.calibration_sha256', 'calibration_hash_does_not_match_calibration_splits');
  }
  const hasAllSplitHashes = Object.keys(SPLITS).every((id) => isSha256(byId.get(id)?.content_sha256));
  if (hasAllSplitHashes && isSha256(manifest.freeze?.corpus_sha256) && manifest.freeze.corpus_sha256 !== digestCorpusContent(manifest)) {
    add(findings, 'corpusManifest.freeze.corpus_sha256', 'corpus_hash_does_not_match_split_hashes');
  }
  return findings;
}

export function validateFrozenHeldOutRun(run, expectedHashes) {
  const findings = [];
  if (!isRecord(run)) return [{ key: 'heldOutRun', reason: 'run_record_required' }];
  for (const field of ['policy_sha256', 'calibration_sha256', 'corpus_sha256']) {
    const expected = expectedHashes?.[field];
    if (!isSha256(expected)) add(findings, `heldOutRun.expected.${field}`, 'independent_frozen_hash_required');
    if (run[field] !== expected) add(findings, `heldOutRun.${field}`, 'run_hash_does_not_match_frozen_input');
  }
  if (run.frozen_before_held_out !== true) add(findings, 'heldOutRun.frozen_before_held_out', 'must_be_true');
  if (!Array.isArray(run.tuning_events_after_freeze)) add(findings, 'heldOutRun.tuning_events_after_freeze', 'must_be_recorded_as_array');
  else if (run.tuning_events_after_freeze.length > 0) add(findings, 'heldOutRun.tuning_events_after_freeze', 'any_held_out_tuning_invalidates_run');
  if (run.failures_in_denominator !== true) add(findings, 'heldOutRun.failures_in_denominator', 'all_failures_must_remain_in_denominator');
  return findings;
}

export function validateEvaluationReport(report, { requiredCells } = {}) {
  const findings = [];
  if (!isRecord(report)) return [{ key: 'evaluationReport', reason: 'report_record_required' }];
  if (!isSha256(report.policy_sha256)) add(findings, 'evaluationReport.policy_sha256', 'frozen_policy_hash_required');
  if (!isSha256(report.corpus_sha256)) add(findings, 'evaluationReport.corpus_sha256', 'frozen_corpus_hash_required');
  const cells = Array.isArray(requiredCells) ? requiredCells : [];
  if (!Array.isArray(requiredCells) || cells.length === 0) add(findings, 'evaluationReport.required_cells', 'independent_question_stratum_matrix_required');
  const rows = Array.isArray(report.question_strata) ? report.question_strata : [];
  const rowByKey = new Map();
  for (const row of rows) {
    const key = `${row?.question_id ?? ''}::${row?.stratum_id ?? ''}`;
    if (rowByKey.has(key)) add(findings, `evaluationReport.question_strata.${key}`, 'duplicate_question_stratum_result');
    else rowByKey.set(key, row);
    if (!isRecord(row)) add(findings, `evaluationReport.question_strata.${key}`, 'result_row_must_be_object');
  }
  for (const cell of cells) {
    const key = `${cell?.question_id ?? ''}::${cell?.stratum_id ?? ''}`;
    if (typeof cell?.question_id !== 'string' || cell.question_id.length === 0) add(findings, `evaluationReport.required_cells.${key}.question_id`, 'nonempty_question_id_required');
    if (typeof cell?.stratum_id !== 'string' || cell.stratum_id.length === 0) add(findings, `evaluationReport.required_cells.${key}.stratum_id`, 'nonempty_stratum_id_required');
    if (typeof cell?.question_version !== 'string' || cell.question_version.length === 0) add(findings, `evaluationReport.required_cells.${key}.question_version`, 'pinned_question_version_required');
    if (!isSha256(cell?.schema_sha256)) add(findings, `evaluationReport.required_cells.${key}.schema_sha256`, 'pinned_question_schema_hash_required');
    if (!Number.isInteger(cell?.expected_count) || cell.expected_count < 1) add(findings, `evaluationReport.required_cells.${key}.expected_count`, 'independently_pinned_positive_expected_count_required');
    const row = rowByKey.get(key);
    if (!row) {
      add(findings, `evaluationReport.question_strata.${key}`, 'required_question_stratum_result_missing');
      continue;
    }
    if (!isRecord(row)) continue;
    for (const field of ['false_negatives', 'abstention_count', 'latency_ms', 'downstream_cost', 'uncertainty', 'failure_count', 'denominator', 'attempted_count', 'bootstrap_interval', 'negative_findings']) {
      if (!(field in row)) add(findings, `evaluationReport.question_strata.${key}.${field}`, 'required_metric_missing');
    }
    if (row.question_version !== cell.question_version) add(findings, `evaluationReport.question_strata.${key}.question_version`, 'result_question_version_does_not_match_required_cell');
    if (row.schema_sha256 !== cell.schema_sha256) add(findings, `evaluationReport.question_strata.${key}.schema_sha256`, 'result_schema_hash_does_not_match_required_cell');
    if (!Number.isInteger(row.denominator) || row.denominator < 1) add(findings, `evaluationReport.question_strata.${key}.denominator`, 'positive_denominator_required');
    if (Number.isInteger(cell.expected_count) && cell.expected_count > 0 && row.denominator !== cell.expected_count) add(findings, `evaluationReport.question_strata.${key}.denominator`, 'denominator_must_match_independently_frozen_expected_count');
    if (!Number.isInteger(row.attempted_count) || row.attempted_count !== row.denominator) add(findings, `evaluationReport.question_strata.${key}.attempted_count`, 'all_attempts_including_failures_must_be_denominator');
    if (!Number.isInteger(row.failure_count) || row.failure_count < 0 || row.failure_count > row.denominator) add(findings, `evaluationReport.question_strata.${key}.failure_count`, 'failure_count_must_be_in_denominator');
    if (!Number.isInteger(row.false_negatives) || row.false_negatives < 0 || row.false_negatives > row.denominator) add(findings, `evaluationReport.question_strata.${key}.false_negatives`, 'false_negatives_must_be_within_denominator');
    if (!Number.isInteger(row.abstention_count) || row.abstention_count < 0 || row.abstention_count > row.denominator) add(findings, `evaluationReport.question_strata.${key}.abstention_count`, 'abstentions_must_be_within_denominator');
    if (!isRecord(row.latency_ms) || !Number.isFinite(row.latency_ms.p95) || row.latency_ms.p95 < 0) add(findings, `evaluationReport.question_strata.${key}.latency_ms`, 'nonnegative_finite_p95_latency_required');
    else if (Object.values(row.latency_ms).some((value) => !Number.isFinite(value) || value < 0)) add(findings, `evaluationReport.question_strata.${key}.latency_ms`, 'latency_values_must_be_nonnegative_finite_numbers');
    if (!isRecord(row.uncertainty) || !Number.isFinite(row.uncertainty.value) || row.uncertainty.value < 0) add(findings, `evaluationReport.question_strata.${key}.uncertainty`, 'nonnegative_finite_uncertainty_required');
    if (!Array.isArray(row.negative_findings)) add(findings, `evaluationReport.question_strata.${key}.negative_findings`, 'negative_findings_must_be_reported_as_array');
    if (!isRecord(row.bootstrap_interval)
      || row.bootstrap_interval.level !== 0.95
      || row.bootstrap_interval.method !== 'family-bootstrap'
      || !Number.isFinite(row.bootstrap_interval.lower)
      || !Number.isFinite(row.bootstrap_interval.upper)
      || row.bootstrap_interval.lower < 0
      || row.bootstrap_interval.lower > row.bootstrap_interval.upper) {
      add(findings, `evaluationReport.question_strata.${key}.bootstrap_interval`, '95_percent_family_bootstrap_interval_required');
    }
    if (!isRecord(row.downstream_cost) || !['known', 'estimated', 'unknown'].includes(row.downstream_cost.status)) {
      add(findings, `evaluationReport.question_strata.${key}.downstream_cost`, 'known_estimated_or_unknown_cost_status_required');
    } else {
      if (row.downstream_cost.status === 'unknown' && row.downstream_cost.amount !== null) add(findings, `evaluationReport.question_strata.${key}.downstream_cost.amount`, 'unknown_cost_amount_must_be_null');
      if (row.downstream_cost.status !== 'unknown' && (!Number.isFinite(row.downstream_cost.amount) || row.downstream_cost.amount < 0)) add(findings, `evaluationReport.question_strata.${key}.downstream_cost.amount`, 'known_cost_amount_must_be_nonnegative_finite');
      if (row.downstream_cost.status === 'unknown' && report.economy_claim === true) add(findings, 'evaluationReport.economy_claim', 'unknown_total_cost_blocks_economy_claim');
    }
  }
  for (const key of rowByKey.keys()) {
    if (cells.length > 0 && !cells.some((cell) => `${cell?.question_id ?? ''}::${cell?.stratum_id ?? ''}` === key)) {
      add(findings, `evaluationReport.question_strata.${key}`, 'unregistered_question_stratum_result');
    }
  }
  return findings;
}

export function validatePublicEvidence(value) {
  const findings = [];
  const visited = new WeakSet();
  function visit(node, path) {
    if (isRecord(node) || Array.isArray(node)) {
      if (visited.has(node)) return;
      visited.add(node);
    }
    if (Array.isArray(node)) {
      node.forEach((child, index) => visit(child, `${path}[${index}]`));
      return;
    }
    if (!isRecord(node)) {
      if (typeof node === 'string' && SENSITIVE_VALUE.test(node)) add(findings, path, 'possible_secret_or_personal_data');
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      const safeKey = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)
        && !SENSITIVE_KEY.test(key)
        && !SENSITIVE_VALUE.test(key)
        ? key
        : '[redacted]';
      const next = path ? `${path}.${safeKey}` : safeKey;
      if (SENSITIVE_KEY.test(key)) add(findings, next, 'sensitive_field_name');
      visit(child, next);
    }
  }
  visit(value, 'evidence');
  return findings;
}

export function evaluatePolicyAcceptance({
  policy,
  corpusManifest,
  questionRegister,
  telemetrySchema,
  questionFixtures,
  verifiedQuestionInventory,
  trustedEvidenceVerifier,
} = {}) {
  const policyDigest = isRecord(policy) ? canonicalSha256(policy) : null;
  const findings = [
    ...validatePolicy(policy),
    ...validateCorpusManifest(corpusManifest, { policy }),
    ...validateTelemetrySchema(telemetrySchema),
    ...validateQuestionRegister(questionRegister, {
      requiredQuestionIds: verifiedQuestionInventory?.question_ids,
      expectedQuestionDefinitions: verifiedQuestionInventory?.definitions,
      corpusManifest,
      telemetrySchema,
      questionFixtures,
    }),
  ];
  if (typeof trustedEvidenceVerifier !== 'function') {
    add(findings, 'acceptance.trusted_evidence_verifier', 'independent_owner_evidence_verifier_unavailable');
  }
  if (policy?.status !== 'accepted') add(findings, 'acceptance.policy.status', 'owner_accepted_policy_required');

  for (const [id, role] of Object.entries(EVAL_OWNER_ROLES)) {
    const evidence = Array.isArray(policy?.authoritative_acceptance)
      ? policy.authoritative_acceptance.find((candidate) => candidate?.id === id)
      : undefined;
    if (!evidence || evidence.status !== 'accepted' || !isSha256(evidence.evidence_sha256)) {
      add(findings, `acceptance.${id}`, `accepted_evidence_from_${role.replaceAll(' ', '_')}_required`);
    } else if (!verifyExternalEvidence(trustedEvidenceVerifier, evidence, { id, role, subject_sha256: policyDigest })) {
      add(findings, `acceptance.${id}`, 'independent_verification_failed');
    }
  }
  for (const split of Array.isArray(corpusManifest?.splits) ? corpusManifest.splits : []) {
    if (split?.license?.status !== 'licensed' || !isSha256(split.license.provenance_sha256)) {
      add(findings, `acceptance.corpus.${split?.id}.license`, 'licensed_corpus_provenance_required');
    } else if (!verifyExternalEvidence(trustedEvidenceVerifier, split.license, { id: `license:${split.id}`, role: 'corpus-rights-owner', subject_sha256: split.content_sha256 })) {
      add(findings, `acceptance.corpus.${split.id}.license`, 'independent_verification_failed');
    }
    if (split?.owner_acceptance?.status !== 'accepted' || !isSha256(split.owner_acceptance.evidence_sha256)) {
      add(findings, `acceptance.corpus.${split?.id}.owner_acceptance`, 'independently_verified_owner_acceptance_required');
    } else if (!verifyExternalEvidence(trustedEvidenceVerifier, split.owner_acceptance, { id: `corpus:${split.id}`, role: 'Finance and reliability', subject_sha256: split.content_sha256 })) {
      add(findings, `acceptance.corpus.${split.id}.owner_acceptance`, 'independent_verification_failed');
    }
    const reviewers = Array.isArray(split?.labeling?.reviewers) ? split.labeling.reviewers : [];
    for (const reviewer of reviewers) {
      if (!verifyExternalEvidence(trustedEvidenceVerifier, reviewer, {
        id: `reviewer:${split?.id}:${reviewer?.reviewer_id}`,
        role: 'independent-human-reviewer',
        subject_sha256: split?.content_sha256,
      })) add(findings, `acceptance.corpus.${split?.id}.reviewers.${reviewer?.reviewer_id}`, 'independent_reviewer_verification_failed');
    }
    if (isRecord(split?.labeling) && !verifyExternalEvidence(trustedEvidenceVerifier, split.labeling, {
      id: `adjudication:${split?.id}`,
      role: 'independent-adjudicator',
      subject_sha256: split?.content_sha256,
    })) add(findings, `acceptance.corpus.${split?.id}.adjudication`, 'independent_adjudication_verification_failed');
  }
  const inventoryIds = questionRegister?.inventory_pin?.required_question_ids;
  if (questionRegister?.status !== 'owner-published' || !Array.isArray(inventoryIds) || inventoryIds.length === 0 || !isSha256(questionRegister?.inventory_pin?.sha256)) {
    add(findings, 'acceptance.question_register', 'owner_published_inventory_with_pinned_hash_required');
  } else if (!Array.isArray(verifiedQuestionInventory?.question_ids) || !isRecord(verifiedQuestionInventory?.definitions)) {
    add(findings, 'acceptance.question_register.inventory_pin', 'separately_verified_owner_inventory_required');
  } else if (!verifyExternalEvidence(trustedEvidenceVerifier, verifiedQuestionInventory, { id: 'question-inventory', roles: ['CE-06', 'CE-09'], subject_sha256: questionRegister.inventory_pin.sha256 })) {
    add(findings, 'acceptance.question_register.inventory_pin', 'independent_question_owner_verification_failed');
  }
  if (questionRegister?.owner_acceptance?.status !== 'accepted' || !isSha256(questionRegister?.owner_acceptance?.evidence_sha256)) {
    add(findings, 'acceptance.question_register.owner_acceptance', 'independently_verified_question_owner_acceptance_required');
  } else if (!verifyExternalEvidence(trustedEvidenceVerifier, questionRegister.owner_acceptance, { id: 'question-register-acceptance', roles: ['CE-06', 'CE-09'], subject_sha256: questionRegister.inventory_pin.sha256 })) {
    add(findings, 'acceptance.question_register.owner_acceptance', 'independent_question_owner_verification_failed');
  }
  if (policy?.visual_workload?.budget_authorization?.status !== 'accepted' || !isSha256(policy?.visual_workload?.budget_authorization?.evidence_sha256)) {
    add(findings, 'acceptance.visual_workload.budget_authorization', 'separate_visual_trial_budget_authorization_required');
  } else if (!verifyExternalEvidence(trustedEvidenceVerifier, policy.visual_workload.budget_authorization, { id: 'visual-budget', role: 'Finance and reliability', subject_sha256: policyDigest })) {
    add(findings, 'acceptance.visual_workload.budget_authorization', 'independent_budget_authorization_verification_failed');
  }
  if (policy?.decision_thresholds?.score?.status !== 'accepted'
    || !isRecord(policy.decision_thresholds.score.accepted_cutoffs)
    || !isSha256(policy.decision_thresholds.score.rubric_sha256)) {
    add(findings, 'acceptance.score_rubric', 'owner_accepted_actual_level_rubric_required');
  } else if (!verifyExternalEvidence(trustedEvidenceVerifier, policy.decision_thresholds.score, { id: 'score-rubric', role: 'Creative and fulfillment', subject_sha256: policy.decision_thresholds.score.rubric_sha256 })) {
    add(findings, 'acceptance.score_rubric', 'independent_rubric_owner_verification_failed');
  }
  if (telemetrySchema?.provenance?.agreement_status !== 'accepted' || !isSha256(telemetrySchema?.provenance?.agreement_sha256)) {
    add(findings, 'acceptance.telemetry_schema', 'producer_and_evaluation_owner_agreement_required');
  } else if (!verifyExternalEvidence(trustedEvidenceVerifier, telemetrySchema.provenance, { id: 'telemetry-schema', roles: ['Agent and research', 'Finance and reliability'], subject_sha256: canonicalSha256(telemetrySchema) })) {
    add(findings, 'acceptance.telemetry_schema', 'independent_telemetry_owner_verification_failed');
  }
  return { accepted: findings.length === 0, findings };
}

export function evaluatePaidEvaluationReadiness({
  policy,
  acceptanceInputs,
  modelPinKeys,
  includeModelBasedPlanning = false,
  trustedEvidenceVerifier,
} = {}) {
  const findings = [];
  const acceptance = evaluatePolicyAcceptance({
    ...acceptanceInputs,
    policy,
    trustedEvidenceVerifier,
  });
  if (!acceptance.accepted) add(findings, 'paidEvaluation.policy_acceptance', 'owner_accepted_policy_and_corpus_required');
  const requestedPins = new Set(['vision_observation', 'generative_classification_baseline']);
  const supportedPinKeys = new Set(['vision_observation', 'generative_classification_baseline', 'model_based_planning']);
  if (modelPinKeys !== undefined) {
    if (!Array.isArray(modelPinKeys)) add(findings, 'paidEvaluation.modelPinKeys', 'additional_model_pin_keys_must_be_an_array');
    else {
      for (const pinKey of modelPinKeys) {
        if (typeof pinKey !== 'string' || !supportedPinKeys.has(pinKey)) {
          add(findings, 'paidEvaluation.modelPinKeys', 'unsupported_or_malformed_model_pin_key');
        } else requestedPins.add(pinKey);
      }
    }
  }
  if (typeof includeModelBasedPlanning !== 'boolean') add(findings, 'paidEvaluation.includeModelBasedPlanning', 'must_be_boolean');
  else if (includeModelBasedPlanning) requestedPins.add('model_based_planning');
  for (const pinKey of requestedPins) {
    const pin = isRecord(policy?.model_pins) && Object.hasOwn(policy.model_pins, pinKey)
      ? policy.model_pins[pinKey]
      : undefined;
    const prefix = `paidEvaluation.model_pins.${pinKey}`;
    if (!isRecord(pin)) {
      add(findings, prefix, 'required_model_pin_missing');
      continue;
    }
    if (pin.status !== 'verified') add(findings, `${prefix}.status`, 'verified_model_configuration_required_before_paid_eval');
    if (typeof pin.model_id !== 'string' || pin.model_id.length === 0) add(findings, `${prefix}.model_id`, 'exact_model_id_required');
    if (!isSha256(pin.configuration_sha256)) add(findings, `${prefix}.configuration_sha256`, 'exact_configuration_hash_required');
    if (!isSha256(pin.account_access_verification_sha256)) add(findings, `${prefix}.account_access_verification_sha256`, 'account_access_verification_required');
    if (pin.status === 'verified' && !verifyExternalEvidence(trustedEvidenceVerifier, pin, { id: `model-pin:${pinKey}`, role: 'model-access-owner', subject_sha256: pin.configuration_sha256 })) {
      add(findings, prefix, 'independently_verified_model_access_required');
    }
  }
  return { ready: findings.length === 0, findings, policyAcceptance: acceptance };
}

export const evaluationRequirements = Object.freeze({
  routingIntents: [...ROUTING_INTENTS],
  inspectionOutcomes: [...INSPECTION_OUTCOMES],
  coverageStrata: [...COVERAGE_STRATA],
  splits: { ...SPLITS },
  requiredTelemetryFields: [...REQUIRED_TELEMETRY_FIELDS],
  requiredFixturesByPrimitive: Object.fromEntries(Object.entries(REQUIRED_FIXTURES_BY_PRIMITIVE).map(([key, value]) => [key, [...value]])),
});

export function canonicalSha256(value) {
  return sha256(canonical(value));
}
