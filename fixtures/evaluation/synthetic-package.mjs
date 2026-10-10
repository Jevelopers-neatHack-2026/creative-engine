import { createHash } from 'node:crypto';
import {
  digestCalibrationContent,
  digestCorpusContent,
  digestSampleRecords,
  evaluationRequirements,
  canonicalSha256,
} from '../../evals/creative/validator.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');

function question({ id, ownerIssueKey, primitive, strata }) {
  return {
    question_id: id,
    version: 'synthetic-fixture-v1',
    owner_issue_key: ownerIssueKey,
    owner_role: 'Creative and fulfillment',
    primitive,
    schema_sha256: sha(`${id}:schema`),
    model_pin: {
      model_id: 'synthetic-fixture-model',
      configuration_sha256: sha(`${id}:configuration`),
      access_verification_sha256: sha(`${id}:access-fixture`),
    },
    permitted_states: ['synthetic-review', 'synthetic-route'],
    permitted_options: primitive === 'choice' ? ['fixture.option-a', 'fixture.option-b'] : [],
    dependencies: [],
    fallback: 'synthetic-review-only',
    required_strata: strata,
    thresholds: { synthetic_only: true },
    telemetry_event: `fixture.${id}`,
    fixture_ref: `fixtures/evaluation/${id}.json`,
    synthetic: true,
  };
}

function makeSamples(splitId, count, questionIds, classByIndex = () => null) {
  return Array.from({ length: count }, (_, index) => {
    const strata = [];
    const label = classByIndex(index);
    if (label) strata.push(label);
    if (splitId === 'routing_held_out' && index < 20) strata.push(...evaluationRequirements.coverageStrata);
    if (splitId === 'routing_held_out' && index < 60) strata.push('zero_image_composition');
    if (splitId === 'routing_held_out' && index < 40) strata.push('typed_control_zero_jev');
    if (splitId === 'routing_safety' && index < 20) strata.push('injection', 'permission', 'race');
    return {
      sha256: sha(`synthetic-test-fixture:${splitId}:${index}`),
      question_ids: [...questionIds],
      strata: [...new Set(strata)],
      fixture_label: label ?? 'synthetic-only',
      origin: 'synthetic-test-fixture',
    };
  });
}

function makeSplit(id, count, samples) {
  return {
    id,
    planned_count: count,
    status: 'synthetic-fixture-only',
    samples,
    content_sha256: digestSampleRecords(samples),
    license: {
      status: 'synthetic-test-only',
      provenance_sha256: null,
    },
    labeling: {
      status: 'synthetic-test-only',
      reviewers: [
        { reviewer_id: `synthetic-reviewer-${id}-a`, status: 'synthetic-only' },
        { reviewer_id: `synthetic-reviewer-${id}-b`, status: 'synthetic-only' },
      ],
      adjudication_status: 'synthetic-only',
      adjudication_sha256: sha(`${id}:synthetic-adjudication`),
    },
    owner_acceptance: {
      status: 'synthetic-only',
      evidence_sha256: sha(`${id}:synthetic-owner-acceptance`),
    },
  };
}

export function makeSyntheticEvaluationPackage(policy) {
  const routeId = 'fixture.ce06.route.v1';
  const complianceId = 'fixture.ce09.compliance.v1';
  const repairId = 'fixture.ce09.repair.v1';
  const requiredQuestionIds = [routeId, complianceId, repairId];
  const routingClasses = evaluationRequirements.routingIntents;
  const inspectionClasses = evaluationRequirements.inspectionOutcomes;
  const questions = [
    question({
      id: routeId,
      ownerIssueKey: 'CE-06',
      primitive: 'choice',
      strata: routingClasses.map((id) => ({ id, split_id: 'routing_held_out', minimum: 50 })),
    }),
    question({
      id: complianceId,
      ownerIssueKey: 'CE-09',
      primitive: 'score',
      strata: inspectionClasses.map((id) => ({ id, split_id: 'inspection_held_out', minimum: 20 })),
    }),
    question({
      id: repairId,
      ownerIssueKey: 'CE-09',
      primitive: 'noul',
      strata: ['wrong_subject', 'drift', 'poor'].map((id) => ({ id, split_id: 'inspection_held_out', minimum: 20 })),
    }),
  ];
  const routeSamples = [routeId];
  const inspectionSamples = [complianceId, repairId];
  const splits = [
    makeSplit('routing_calibration', 160, makeSamples('routing_calibration', 160, routeSamples)),
    makeSplit('routing_held_out', 400, makeSamples('routing_held_out', 400, routeSamples, (i) => routingClasses[Math.floor(i / 50)])),
    makeSplit('routing_safety', 160, makeSamples('routing_safety', 160, routeSamples)),
    makeSplit('inspection_calibration', 56, makeSamples('inspection_calibration', 56, inspectionSamples)),
    makeSplit('inspection_held_out', 140, makeSamples('inspection_held_out', 140, inspectionSamples, (i) => inspectionClasses[Math.floor(i / 20)])),
  ];
  const corpusManifest = {
    schema_version: 'creative-eval-corpus-manifest/v1',
    policy_id: 'CE-Q01',
    version: 'synthetic-fixture-v1',
    status: 'synthetic-fixture-only',
    source_kind: 'synthetic-test-fixture',
    immutable: true,
    freeze: {
      policy_sha256: canonicalSha256(policy),
      calibration_sha256: null,
      corpus_sha256: null,
      frozen_before_held_out: true,
    },
    review_requirements: {
      independent_human_reviewers: 2,
      adjudication_required: true,
      owner_acceptance_required: true,
    },
    splits,
  };
  corpusManifest.freeze.calibration_sha256 = digestCalibrationContent(corpusManifest);
  corpusManifest.freeze.corpus_sha256 = digestCorpusContent(corpusManifest);

  const questionRegister = {
    schema_version: 'creative-eval-question-register/v1',
    policy_id: 'CE-Q01',
    version: 'synthetic-fixture-v1',
    status: 'synthetic-fixture-only',
    questions,
    owner_sources: [
      { issue_key: 'CE-06', issue_number: 18, owner_role: 'Creative and fulfillment', source_status: 'synthetic-only' },
      { issue_key: 'CE-09', issue_number: 16, owner_role: 'Creative and fulfillment', source_status: 'synthetic-only' },
    ],
    inventory_pin: {
      required_question_ids: [...requiredQuestionIds],
      sha256: canonicalSha256([...questions].sort((left, right) => left.question_id.localeCompare(right.question_id))),
      independent_owner_verification: 'synthetic-fixture-only',
    },
    owner_acceptance: {
      status: 'synthetic-only',
      evidence_sha256: sha('synthetic-question-register-acceptance'),
    },
  };
  const telemetrySchema = {
    schema_version: 'creative-eval-telemetry-proposal/v1',
    policy_id: 'CE-Q01',
    version: 'synthetic-fixture-v1',
    status: 'synthetic-fixture-only',
    required_fields: [...evaluationRequirements.requiredTelemetryFields],
    events: questions.map((item) => ({
      id: item.telemetry_event,
      question_ids: [item.question_id],
      fields: [...evaluationRequirements.requiredTelemetryFields],
    })),
    provenance: {
      producer_owner: 'Agent and research',
      evaluation_owner: 'Finance and reliability',
      agreement_status: 'synthetic-only',
      agreement_sha256: null,
    },
  };
  const questionFixtures = questions.map((item) => ({
    question_id: item.question_id,
    primitive: item.primitive,
    synthetic: true,
    cases: [...evaluationRequirements.requiredFixturesByPrimitive[item.primitive]],
  }));

  return {
    policy,
    corpusManifest,
    questionRegister,
    telemetrySchema,
    questionFixtures,
    requiredQuestionIds,
    expectedQuestionDefinitions: Object.fromEntries(questions.map((item) => [item.question_id, structuredClone(item)])),
  };
}
