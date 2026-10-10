import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  canonicalSha256,
  digestCalibrationContent,
  digestCorpusContent,
  digestSampleRecords,
  evaluatePaidEvaluationReadiness,
  evaluatePolicyAcceptance,
  evaluationRequirements,
  validateCorpusManifest,
  validateEvaluationReport,
  validateFrozenHeldOutRun,
  validatePolicy,
  validatePublicEvidence,
  validateQuestionRegister,
  validateTelemetrySchema,
} from '../../evals/creative/validator.mjs';
import { makeSyntheticEvaluationPackage } from '../../fixtures/evaluation/synthetic-package.mjs';

const policy = JSON.parse(readFileSync(new URL('../../evals/creative/policy.json', import.meta.url), 'utf8'));
const corpusManifest = JSON.parse(readFileSync(new URL('../../evals/creative/corpus-manifest.json', import.meta.url), 'utf8'));
const questionRegister = JSON.parse(readFileSync(new URL('../../evals/creative/question-register.json', import.meta.url), 'utf8'));
const telemetrySchema = JSON.parse(readFileSync(new URL('../../evals/creative/telemetry-schema.json', import.meta.url), 'utf8'));
const clone = (value) => structuredClone(value);
const hasKey = (findings, key) => findings.some((finding) => finding.key === key);

function questionOptions(fixture) {
  return {
    requiredQuestionIds: fixture.requiredQuestionIds,
    expectedQuestionDefinitions: fixture.expectedQuestionDefinitions,
    corpusManifest: fixture.corpusManifest,
    telemetrySchema: fixture.telemetrySchema,
    questionFixtures: fixture.questionFixtures,
    allowSyntheticFixture: true,
  };
}

function refreezeCorpus(manifest, targetPolicy = policy) {
  for (const split of manifest.splits) split.content_sha256 = digestSampleRecords(split.samples);
  manifest.freeze.policy_sha256 = canonicalSha256(targetPolicy);
  manifest.freeze.calibration_sha256 = digestCalibrationContent(manifest);
  manifest.freeze.corpus_sha256 = digestCorpusContent(manifest);
}

function makeInjectedAcceptanceScenario() {
  const fixture = makeSyntheticEvaluationPackage(policy);
  const acceptedPolicy = clone(policy);
  acceptedPolicy.status = 'accepted';
  acceptedPolicy.version = 'test-double-only';
  for (const entry of acceptedPolicy.authoritative_acceptance) {
    entry.status = 'accepted';
    entry.evidence_sha256 = 'a'.repeat(64);
  }
  acceptedPolicy.visual_workload.budget_authorization = {
    status: 'accepted',
    evidence_sha256: 'b'.repeat(64),
  };
  acceptedPolicy.decision_thresholds.score = {
    threshold_source: 'owner-published actual-level rubric required',
    rubric_path: 'docs/evaluation/creative-rubric.md',
    status: 'accepted',
    accepted_cutoffs: { 'test-level-1': 1, 'test-level-5': 5 },
    rubric_sha256: 'c'.repeat(64),
  };

  const acceptedCorpus = clone(fixture.corpusManifest);
  acceptedCorpus.status = 'accepted';
  acceptedCorpus.source_kind = 'owner-accepted-corpus';
  for (const split of acceptedCorpus.splits) {
    split.status = 'accepted';
    for (const sample of split.samples) {
      delete sample.fixture_label;
      sample.origin = 'injected-evidence-test-double';
      sample.gold_label_ref = 'd'.repeat(64);
      sample.label_status = 'adjudicated';
    }
    split.license = { status: 'licensed', provenance_sha256: 'e'.repeat(64) };
    split.labeling.status = 'adjudicated';
    split.labeling.adjudication_status = 'adjudicated';
    split.labeling.adjudication_sha256 = 'f'.repeat(64);
    split.labeling.reviewers = split.labeling.reviewers.map((reviewer, index) => ({
      reviewer_id: `injected-reviewer-${split.id}-${index}`,
      status: 'approved',
      approval_sha256: '1'.repeat(64),
      independence_evidence_sha256: '2'.repeat(64),
    }));
    split.owner_acceptance = { status: 'accepted', evidence_sha256: '3'.repeat(64) };
  }
  refreezeCorpus(acceptedCorpus, acceptedPolicy);

  const acceptedQuestions = clone(fixture.questionRegister);
  acceptedQuestions.status = 'owner-published';
  acceptedQuestions.version = 'test-double-only';
  acceptedQuestions.owner_acceptance = { status: 'accepted', evidence_sha256: '4'.repeat(64) };
  acceptedQuestions.inventory_pin.sha256 = canonicalSha256(
    [...acceptedQuestions.questions].sort((left, right) => left.question_id.localeCompare(right.question_id)),
  );
  const acceptedTelemetry = clone(fixture.telemetrySchema);
  acceptedTelemetry.provenance.agreement_status = 'accepted';
  acceptedTelemetry.provenance.agreement_sha256 = '5'.repeat(64);
  const verifiedQuestionInventory = {
    question_ids: fixture.requiredQuestionIds,
    definitions: fixture.expectedQuestionDefinitions,
  };
  const questionFixtures = fixture.questionFixtures.map((row) => ({ ...row, synthetic: false }));

  return {
    policy: acceptedPolicy,
    corpusManifest: acceptedCorpus,
    questionRegister: acceptedQuestions,
    telemetrySchema: acceptedTelemetry,
    questionFixtures,
    verifiedQuestionInventory,
  };
}

test('the checked-in policy preserves every proposed issue #8 target and global owner', () => {
  assert.deepEqual(validatePolicy(policy), []);
  assert.equal(policy.status, 'proposed');
  assert.equal(policy.decision_thresholds.score.accepted_cutoffs, null);
  assert.equal(policy.question_owners.find((owner) => owner.issue_key === 'CE-06').issue_number, 18);
  assert.equal(policy.question_owners.find((owner) => owner.issue_key === 'CE-09').issue_number, 16);

  const acceptedRubric = clone(policy);
  acceptedRubric.decision_thresholds.score = {
    threshold_source: 'owner-published actual-level rubric required',
    rubric_path: 'docs/evaluation/creative-rubric.md',
    status: 'accepted',
    accepted_cutoffs: { synthetic_fixture_example: 'test-only' },
    rubric_sha256: 'a'.repeat(64),
  };
  assert.deepEqual(validatePolicy(acceptedRubric), []);
});

test('the checked-in pending artifacts fail acceptance until external evidence is supplied', () => {
  const gate = evaluatePolicyAcceptance({ policy, corpusManifest, questionRegister, telemetrySchema });
  assert.equal(gate.accepted, false);
  for (const key of [
    'acceptance.trusted_evidence_verifier',
    'acceptance.policy.status',
    'acceptance.EVAL-02',
    'acceptance.EVAL-03',
    'acceptance.EVAL-04',
    'corpusManifest.source_kind',
    'acceptance.question_register',
    'acceptance.score_rubric',
    'acceptance.telemetry_schema',
    'acceptance.visual_workload.budget_authorization',
  ]) assert.ok(hasKey(gate.findings, key), `pending acceptance must report ${key}`);
});

test('the eval-policy acceptance command emits machine-readable findings and exits 2 while pending', () => {
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  const result = spawnSync('make', ['acceptance', 'TARGET=eval-policy'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.ok(!result.stdout.includes('scripts/acceptance-gate.mjs'));
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.schema_version, 'creative-eval-acceptance-result/v1');
  assert.equal(evidence.target, 'CE-Q01');
  assert.equal(evidence.accepted, false);
  assert.ok(evidence.finding_count > 0);
  assert.ok(evidence.findings.some((finding) => finding.key === 'acceptance.EVAL-02'));
  assert.ok(evidence.findings.some((finding) => finding.key === 'acceptance.question_register'));

  const all = spawnSync(process.execPath, ['scripts/acceptance-gate.mjs', 'all'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(all.status, 2);
  assert.match(all.stderr, /finance_metering_budget_protocol/);
  assert.match(all.stderr, /CE-Q01 policy and corpus evidence remain pending/);
  assert.match(all.stderr, /CE-Q01 acceptance\.trusted_evidence_verifier/);
});

test('shrinking counts, strata, thresholds, or checklist ownership fails on the exact key', () => {
  const changedCount = clone(policy);
  changedCount.workloads.routing.held_out.by_intent.new_concept = 49;
  assert.ok(hasKey(validatePolicy(changedCount), 'policy.workloads.routing.held_out.by_intent.new_concept'));

  const removedCoverage = clone(policy);
  delete removedCoverage.required_coverage.minimum_cases_per_stratum.injection;
  assert.ok(hasKey(validatePolicy(removedCoverage), 'policy.required_coverage.minimum_cases_per_stratum.injection'));

  const weakenedThreshold = clone(policy);
  weakenedThreshold.quality_targets.routing.automatic_route_precision_min = 0.97;
  assert.ok(hasKey(validatePolicy(weakenedThreshold), 'policy.quality_targets.routing.automatic_route_precision_min'));

  const changedOwner = clone(policy);
  changedOwner.authoritative_acceptance.find((entry) => entry.id === 'EVAL-03').owner_role = 'Creative and fulfillment';
  assert.ok(hasKey(validatePolicy(changedOwner), 'policy.authoritative_acceptance.EVAL-03.owner_role'));
});

test('synthetic-only full-shape fixture exercises corpus, question, primitive, and telemetry validation', () => {
  const fixture = makeSyntheticEvaluationPackage(policy);
  assert.deepEqual(validateCorpusManifest(fixture.corpusManifest, { allowSyntheticFixture: true, policy }), []);
  assert.deepEqual(validateTelemetrySchema(fixture.telemetrySchema), []);
  assert.deepEqual(validateQuestionRegister(fixture.questionRegister, questionOptions(fixture)), []);
  assert.equal(fixture.corpusManifest.splits.reduce((sum, split) => sum + split.samples.length, 0), 916);
  assert.equal(fixture.corpusManifest.status, 'synthetic-fixture-only');
  assert.ok(fixture.corpusManifest.splits.every((split) => split.samples.every((sample) => sample.origin === 'synthetic-test-fixture')));
});

test('an empty owner register and a removed question cannot pass vacuously or shrink a pinned inventory', () => {
  const empty = clone(questionRegister);
  const emptyFindings = validateQuestionRegister(empty, {
    requiredQuestionIds: empty.inventory_pin.required_question_ids,
    expectedQuestionDefinitions: {},
    corpusManifest,
    telemetrySchema,
  });
  assert.ok(hasKey(emptyFindings, 'questionRegister.status'));
  assert.ok(hasKey(emptyFindings, 'questionRegister.questions'));
  assert.ok(hasKey(emptyFindings, 'questionRegister.inventory_pin.required_question_ids'));
  assert.ok(hasKey(emptyFindings, 'questionRegister.inventory_pin.question_definitions'));

  const fixture = makeSyntheticEvaluationPackage(policy);
  fixture.questionRegister.questions = fixture.questionRegister.questions.filter((question) => question.question_id !== fixture.requiredQuestionIds[0]);
  const findings = validateQuestionRegister(fixture.questionRegister, questionOptions(fixture));
  assert.ok(hasKey(findings, `questionRegister.questions.${fixture.requiredQuestionIds[0]}`));

  const shrunkInventory = makeSyntheticEvaluationPackage(policy);
  shrunkInventory.questionRegister.questions = shrunkInventory.questionRegister.questions.slice(1);
  shrunkInventory.questionRegister.inventory_pin.required_question_ids = shrunkInventory.questionRegister.inventory_pin.required_question_ids.slice(1);
  const shrinkFindings = validateQuestionRegister(shrunkInventory.questionRegister, questionOptions(shrunkInventory));
  assert.ok(hasKey(shrinkFindings, 'questionRegister.inventory_pin.required_question_ids'));
  assert.ok(hasKey(shrinkFindings, `questionRegister.questions.${shrunkInventory.requiredQuestionIds[0]}`));

  const missingDefinition = makeSyntheticEvaluationPackage(policy);
  missingDefinition.expectedQuestionDefinitions = {
    [missingDefinition.requiredQuestionIds[0]]: missingDefinition.expectedQuestionDefinitions[missingDefinition.requiredQuestionIds[0]],
  };
  const definitionFindings = validateQuestionRegister(missingDefinition.questionRegister, questionOptions(missingDefinition));
  assert.ok(hasKey(definitionFindings, 'questionRegister.inventory_pin.question_definitions'));

  const mismatchedDefinitionId = makeSyntheticEvaluationPackage(policy);
  mismatchedDefinitionId.expectedQuestionDefinitions[mismatchedDefinitionId.requiredQuestionIds[0]].question_id = 'other.question';
  const idFindings = validateQuestionRegister(mismatchedDefinitionId.questionRegister, questionOptions(mismatchedDefinitionId));
  assert.ok(hasKey(idFindings, `questionRegister.inventory_pin.question_definitions.${mismatchedDefinitionId.requiredQuestionIds[0]}`));
});

test('removing a question stratum, primitive fixture, model pin, or threshold is rejected', () => {
  const fixture = makeSyntheticEvaluationPackage(policy);
  fixture.questionRegister.questions[0].required_strata.pop();
  let findings = validateQuestionRegister(fixture.questionRegister, questionOptions(fixture));
  assert.ok(hasKey(findings, `questionRegister.questions.${fixture.requiredQuestionIds[0]}.required_strata`));

  const noFixture = makeSyntheticEvaluationPackage(policy);
  noFixture.questionFixtures.find((row) => row.question_id === noFixture.requiredQuestionIds[2]).cases = [];
  findings = validateQuestionRegister(noFixture.questionRegister, questionOptions(noFixture));
  assert.ok(hasKey(findings, `questionFixtures.${noFixture.requiredQuestionIds[2]}.invented_confidence`));

  const noModelPin = makeSyntheticEvaluationPackage(policy);
  delete noModelPin.questionRegister.questions[0].model_pin.configuration_sha256;
  findings = validateQuestionRegister(noModelPin.questionRegister, questionOptions(noModelPin));
  assert.ok(hasKey(findings, `questionRegister.questions.${noModelPin.requiredQuestionIds[0]}.model_pin.configuration_sha256`));

  const noThreshold = makeSyntheticEvaluationPackage(policy);
  noThreshold.questionRegister.questions[1].thresholds = {};
  findings = validateQuestionRegister(noThreshold.questionRegister, questionOptions(noThreshold));
  assert.ok(hasKey(findings, `questionRegister.questions.${noThreshold.requiredQuestionIds[1]}.thresholds`));
});

test('removing telemetry fields or question bindings reports precise missing keys', () => {
  const fixture = makeSyntheticEvaluationPackage(policy);
  const event = fixture.telemetrySchema.events[0];
  event.fields = event.fields.filter((field) => field !== 'false_negative');
  let findings = validateQuestionRegister(fixture.questionRegister, questionOptions(fixture));
  assert.ok(hasKey(findings, `telemetrySchema.events.${event.id}.fields.false_negative`));

  const noQuestion = makeSyntheticEvaluationPackage(policy);
  noQuestion.telemetrySchema.events[0].question_ids = [];
  findings = validateQuestionRegister(noQuestion.questionRegister, questionOptions(noQuestion));
  assert.ok(hasKey(findings, `telemetrySchema.events.${noQuestion.telemetrySchema.events[0].id}.question_ids.${noQuestion.requiredQuestionIds[0]}`));
});

test('corpus hashes are disjoint, content-bound, and cover required held-out classes and tags', () => {
  const fixture = makeSyntheticEvaluationPackage(policy);
  const valid = fixture.corpusManifest;
  assert.deepEqual(validateCorpusManifest(valid, { allowSyntheticFixture: true, policy }), []);

  const omittedClass = clone(valid);
  omittedClass.splits.find((split) => split.id === 'routing_held_out').samples[0].strata = [];
  refreezeCorpus(omittedClass);
  let findings = validateCorpusManifest(omittedClass, { allowSyntheticFixture: true, policy });
  assert.ok(hasKey(findings, 'corpusManifest.splits.routing_held_out.strata.artwork_style_change'));

  const repeatedHash = clone(valid);
  repeatedHash.splits[1].samples[0].sha256 = repeatedHash.splits[0].samples[0].sha256;
  refreezeCorpus(repeatedHash);
  findings = validateCorpusManifest(repeatedHash, { allowSyntheticFixture: true, policy });
  assert.ok(findings.some((finding) => finding.key.includes(repeatedHash.splits[1].samples[0].sha256) && finding.reason.startsWith('hash_reused_from_')));

  const missingReviewer = clone(valid);
  missingReviewer.splits[0].labeling.reviewers.pop();
  findings = validateCorpusManifest(missingReviewer, { allowSyntheticFixture: true, policy });
  assert.ok(hasKey(findings, 'corpusManifest.splits.routing_calibration.labeling.reviewers'));

  const unlicensed = clone(valid);
  unlicensed.splits[0].license.status = 'pending';
  findings = validateCorpusManifest(unlicensed, { allowSyntheticFixture: true, policy });
  assert.ok(hasKey(findings, 'corpusManifest.splits.routing_calibration.license.status'));
});

test('held-out runs bind exact freeze hashes, reject post-freeze tuning, and retain failures', () => {
  const hashes = {
    policy_sha256: 'a'.repeat(64),
    calibration_sha256: 'b'.repeat(64),
    corpus_sha256: 'c'.repeat(64),
  };
  const valid = {
    ...hashes,
    frozen_before_held_out: true,
    tuning_events_after_freeze: [],
    failures_in_denominator: true,
  };
  assert.deepEqual(validateFrozenHeldOutRun(valid, hashes), []);
  const tuned = { ...valid, tuning_events_after_freeze: [{ at: 'synthetic', reason: 'fixture mutation' }] };
  assert.ok(hasKey(validateFrozenHeldOutRun(tuned, hashes), 'heldOutRun.tuning_events_after_freeze'));
  const changedCorpus = { ...valid, corpus_sha256: 'd'.repeat(64) };
  assert.ok(hasKey(validateFrozenHeldOutRun(changedCorpus, hashes), 'heldOutRun.corpus_sha256'));
  assert.ok(hasKey(validateFrozenHeldOutRun({ ...valid, failures_in_denominator: false }, hashes), 'heldOutRun.failures_in_denominator'));
});

test('report validation requires question-by-stratum negatives, uncertainty, latency, and cost state', () => {
  const cell = { question_id: 'fixture.q.v1', stratum_id: 'fixture.stratum' };
  const report = {
    policy_sha256: 'a'.repeat(64),
    corpus_sha256: 'b'.repeat(64),
    economy_claim: false,
    question_strata: [{
      ...cell,
      false_negatives: 1,
      abstention_count: 2,
      latency_ms: { p95: 1200 },
      downstream_cost: { status: 'unknown', amount: null },
      uncertainty: { value: 0.2 },
      failure_count: 1,
      denominator: 10,
      attempted_count: 10,
      bootstrap_interval: { level: 0.95, method: 'family-bootstrap' },
      negative_findings: ['fixture failure retained'],
    }],
  };
  assert.deepEqual(validateEvaluationReport(report, { requiredCells: [cell] }), []);
  report.economy_claim = true;
  let findings = validateEvaluationReport(report, { requiredCells: [cell] });
  assert.ok(hasKey(findings, 'evaluationReport.economy_claim'));
  report.economy_claim = false;
  report.question_strata[0].attempted_count = 9;
  findings = validateEvaluationReport(report, { requiredCells: [cell] });
  assert.ok(hasKey(findings, `evaluationReport.question_strata.${cell.question_id}::${cell.stratum_id}.attempted_count`));
  assert.ok(hasKey(validateEvaluationReport({ ...report, question_strata: [] }, { requiredCells: [cell] }), `evaluationReport.question_strata.${cell.question_id}::${cell.stratum_id}`));
});

test('public evidence scanner rejects credentials and personal identifiers', () => {
  const evidence = {
    policy_sha256: 'a'.repeat(64),
    authorization: 'Bearer synthetic-secret-token',
    owner_contact: 'person@example.invalid',
  };
  const findings = validatePublicEvidence(evidence);
  assert.ok(hasKey(findings, 'evidence.authorization'));
  assert.ok(findings.some((finding) => finding.reason === 'possible_secret_or_personal_data'));
});

test('local status strings and hashes cannot authenticate missing owner or corpus acceptance', () => {
  const claimedPolicy = clone(policy);
  for (const entry of claimedPolicy.authoritative_acceptance) {
    entry.status = 'accepted';
    entry.evidence_sha256 = 'a'.repeat(64);
    entry.evidence_url = 'https://example.invalid/local-claim';
  }
  const claimedCorpus = clone(corpusManifest);
  for (const split of claimedCorpus.splits) {
    split.license = { status: 'licensed', provenance_sha256: 'b'.repeat(64) };
    split.owner_acceptance = { status: 'accepted', evidence_sha256: 'c'.repeat(64) };
  }
  const claimedQuestions = clone(questionRegister);
  claimedQuestions.status = 'owner-published';
  claimedQuestions.inventory_pin = {
    required_question_ids: ['fake.local.question'],
    sha256: 'd'.repeat(64),
    independent_owner_verification: 'self-asserted',
  };
  claimedQuestions.owner_acceptance = { status: 'accepted', evidence_sha256: 'e'.repeat(64) };
  const claimedTelemetry = clone(telemetrySchema);
  claimedTelemetry.provenance.agreement_status = 'accepted';
  claimedTelemetry.provenance.agreement_sha256 = 'f'.repeat(64);
  claimedPolicy.visual_workload.budget_authorization = { status: 'accepted', evidence_sha256: '1'.repeat(64) };
  claimedPolicy.decision_thresholds.score = { status: 'accepted', accepted_cutoffs: { synthetic_only: true } };

  const gate = evaluatePolicyAcceptance({
    policy: claimedPolicy,
    corpusManifest: claimedCorpus,
    questionRegister: claimedQuestions,
    telemetrySchema: claimedTelemetry,
  });
  assert.equal(gate.accepted, false);
  assert.ok(hasKey(gate.findings, 'acceptance.trusted_evidence_verifier'));
  assert.ok(hasKey(gate.findings, 'acceptance.question_register.inventory_pin'));
  assert.ok(hasKey(gate.findings, 'corpusManifest.splits.routing_held_out.samples'));

  let verifiedEvidenceCalls = 0;
  const verifiedClaimGate = evaluatePolicyAcceptance({
    policy: claimedPolicy,
    corpusManifest: claimedCorpus,
    questionRegister: claimedQuestions,
    telemetrySchema: claimedTelemetry,
    trustedEvidenceVerifier: () => { verifiedEvidenceCalls += 1; return true; },
  });
  assert.ok(verifiedEvidenceCalls >= 3);
  assert.equal(verifiedClaimGate.accepted, false);
  assert.ok(!hasKey(verifiedClaimGate.findings, 'acceptance.EVAL-02'));
  assert.ok(!hasKey(verifiedClaimGate.findings, 'acceptance.EVAL-03'));
  assert.ok(!hasKey(verifiedClaimGate.findings, 'acceptance.EVAL-04'));
});

test('the integrated acceptance gate can pass only through an injected independent-evidence test double', () => {
  const scenario = makeInjectedAcceptanceScenario();
  const calls = [];
  const gate = evaluatePolicyAcceptance({
    ...scenario,
    trustedEvidenceVerifier: (evidence, context) => {
      calls.push(context.id);
      return Boolean(evidence && (context.role || context.roles) && context.subject_sha256);
    },
  });

  assert.deepEqual(gate.findings, []);
  assert.equal(gate.accepted, true);
  for (const requiredId of [
    'EVAL-02', 'EVAL-03', 'EVAL-04', 'question-inventory',
    'question-register-acceptance', 'score-rubric', 'telemetry-schema', 'visual-budget',
    'license:routing_calibration', 'adjudication:routing_held_out',
  ]) assert.ok(calls.includes(requiredId), `independent evidence must be checked for ${requiredId}`);

  // This is an isolated gate-path test. Checked-in policy, corpus and owners remain pending.
  assert.equal(policy.status, 'proposed');
  assert.equal(corpusManifest.status, 'pending-owner-corpus');
  assert.equal(questionRegister.status, 'missing-owner-publication');
});

test('synthetic labels never satisfy actual acceptance and unresolved model pins block paid evaluation', () => {
  const fixture = makeSyntheticEvaluationPackage(policy);
  const syntheticGate = evaluatePolicyAcceptance({
    ...fixture,
    verifiedQuestionInventory: {
      question_ids: fixture.requiredQuestionIds,
      definitions: fixture.expectedQuestionDefinitions,
    },
    trustedEvidenceVerifier: () => true,
  });
  assert.equal(syntheticGate.accepted, false);
  assert.ok(hasKey(syntheticGate.findings, 'corpusManifest.source_kind'));
  assert.ok(syntheticGate.findings.some((finding) => finding.reason === 'synthetic_labels_cannot_satisfy_corpus_acceptance'));

  const paid = evaluatePaidEvaluationReadiness({ policy, trustedEvidenceVerifier: () => true });
  assert.equal(paid.ready, false);
  assert.ok(hasKey(paid.findings, 'paidEvaluation.model_pins.vision_observation.status'));
  assert.ok(hasKey(paid.findings, 'paidEvaluation.model_pins.generative_classification_baseline.model_id'));
  assert.ok(hasKey(paid.findings, 'paidEvaluation.policy_acceptance'));
});

test('held-out samples must carry exactly one task class; malformed iterables return findings safely', () => {
  const fixture = makeSyntheticEvaluationPackage(policy);
  const malformedClass = clone(fixture.corpusManifest);
  const sample = malformedClass.splits.find((split) => split.id === 'routing_held_out').samples[0];
  sample.strata.push('new_concept');
  refreezeCorpus(malformedClass);
  const findings = validateCorpusManifest(malformedClass, { allowSyntheticFixture: true, policy });
  assert.ok(hasKey(findings, 'corpusManifest.splits.routing_held_out.samples.0.strata'));

  const malformedRegister = clone(fixture.questionRegister);
  malformedRegister.questions = { question_id: 'bad-shape' };
  const registerFindings = validateQuestionRegister(malformedRegister, questionOptions(fixture));
  assert.ok(hasKey(registerFindings, 'questionRegister.questions'));

  const malformedQuestion = clone(fixture.questionRegister);
  malformedQuestion.questions[0].required_strata = { id: 'injection' };
  const questionFindings = validateQuestionRegister(malformedQuestion, questionOptions(fixture));
  assert.ok(hasKey(questionFindings, `questionRegister.questions.${fixture.requiredQuestionIds[0]}.required_strata`));

  const malformedTelemetry = clone(fixture.telemetrySchema);
  malformedTelemetry.events[0].fields = { false_negative: true };
  const telemetryBindingFindings = validateQuestionRegister(fixture.questionRegister, {
    ...questionOptions(fixture),
    telemetrySchema: malformedTelemetry,
  });
  assert.ok(hasKey(telemetryBindingFindings, `telemetrySchema.events.${malformedTelemetry.events[0].id}.fields.question_id`));
  assert.ok(hasKey(validateTelemetrySchema(malformedTelemetry), `telemetrySchema.events.${malformedTelemetry.events[0].id}.fields`));
  assert.ok(hasKey(validateTelemetrySchema({ required_fields: {}, events: { id: 'bad' } }), 'telemetrySchema.required_fields'));
  assert.ok(hasKey(validateEvaluationReport({ question_strata: 'bad' }, { requiredCells: {} }), 'evaluationReport.required_cells'));
  const cycle = {};
  cycle.self = cycle;
  assert.doesNotThrow(() => validatePublicEvidence(cycle));
});

test('the fixed proposal strata stay aligned with the eight coverage tags and seven inspection outcomes', () => {
  assert.equal(evaluationRequirements.coverageStrata.length, 8);
  assert.equal(evaluationRequirements.inspectionOutcomes.length, 7);
  assert.equal(policy.workloads.routing.held_out.count, policy.workloads.routing.held_out.by_intent && Object.values(policy.workloads.routing.held_out.by_intent).reduce((sum, count) => sum + count, 0));
  assert.equal(policy.workloads.inspection.held_out.count, Object.values(policy.workloads.inspection.held_out.by_outcome).reduce((sum, count) => sum + count, 0));
});
