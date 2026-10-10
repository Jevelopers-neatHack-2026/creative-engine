import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import {
  ACCESS_CELL_DEFINITIONS,
  ACCESS_PREFLIGHT_VERSION,
  AccessPreflightError,
  createAccessPreflightReport,
  executeAuthorizedAccessCell,
  runAccessPreflight,
  validateAccessPlan,
} from '../../src/preflight/index.mjs';
import { canonicalHash } from '../../src/contracts/validation.mjs';
import { accessPlan, createMockAccessFixture, fixtureScope } from '../../fixtures/preflight/access-ports.mjs';

const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

function updateCellConfiguration(plan, mutate) {
  const cell = plan.cells.find((entry) => entry.cell_id === 'image_generation');
  const configuration = structuredClone(cell.target.configuration);
  mutate(configuration);
  cell.target.configuration = configuration;
  cell.target.configuration_sha256 = canonicalHash(configuration);
}

async function withClockAdvance(action) {
  const NativeDate = globalThis.Date;
  let offset = 0;
  class ShiftedDate extends NativeDate {
    constructor(...args) {
      if (args.length === 0) super(NativeDate.now() + offset);
      else super(...args);
    }

    static now() { return NativeDate.now() + offset; }
    static parse(value) { return NativeDate.parse(value); }
  }
  globalThis.Date = ShiftedDate;
  try {
    return await action((milliseconds) => { offset += milliseconds; });
  } finally {
    globalThis.Date = NativeDate;
  }
}

test('fixed required matrix retains all cells and mock evidence can never count as live acceptance', async () => {
  const fixture = createMockAccessFixture();
  const report = await runAccessPreflight(fixture.args);
  assert.equal(ACCESS_CELL_DEFINITIONS.length, 8);
  assert.equal(report.required_cell_count, 8);
  assert.equal(report.cells.length, 8);
  assert.equal(report.acceptance_allowed, false);
  assert.equal(report.verified_cell_count, 0);
  assert.equal(report.cells[0].status, 'simulated');
  assert.equal(report.cells[0].verified, false);
  assert.ok(report.cells.slice(1).every((cell) => cell.status === 'blocked'));
  assert.equal(fixture.calls.reserve, 1);
  assert.equal(fixture.calls.dispatch, 1);
  assert.equal(fixture.calls.settle, 1);
});

test('fixture refuses to invent JEV, observer, baseline, planning, or Neatlogs targets', () => {
  for (const cellId of ['harness_jev', 'vision_observer', 'generative_classifier_baseline', 'planning', 'neatlogs_ingestion', 'neatlogs_readback']) {
    assert.throws(() => accessPlan({ cellId }), /only the two Images cells/);
  }
});

test('mock ports cannot run in live mode or fabricate a live result', async () => {
  const fixture = createMockAccessFixture();
  const report = await runAccessPreflight({ ...fixture.args, mode: 'live' });
  assert.equal(report.status, 'pending_or_failed');
  assert.equal(report.verified_cell_count, 0);
  assert.equal(report.cells[0].status, 'blocked');
  assert.equal(report.cells[0].reason_code, 'live_adapter_unavailable');
  assert.equal(fixture.calls.reserve, 0);
  assert.equal(fixture.calls.dispatch, 0);
});

test('denied operation permission stops before authorization, reservation, or dispatch', async () => {
  const fixture = createMockAccessFixture();
  const verifyCapability = fixture.capabilityVerifier.verifyCapability.bind(fixture.capabilityVerifier);
  fixture.capabilityVerifier.verifyCapability = async (input) => ({
    ...(await verifyCapability(input)),
    decision: 'denied',
    operation_permission: 'denied',
  });
  const result = await executeAuthorizedAccessCell(fixture.args);
  assert.equal(result.status, 'denied');
  assert.equal(result.reason_code, 'operation_permission_denied');
  assert.equal(fixture.calls.verifyGrant, 0);
  assert.equal(fixture.calls.reserve, 0);
  assert.equal(fixture.calls.dispatch, 0);
});

test('exact permission plus model listing still require authorization and reservation', async () => {
  const fixture = createMockAccessFixture();
  const result = await executeAuthorizedAccessCell(fixture.args);
  assert.equal(result.capability_observation.model_listing, 'listed');
  assert.equal(result.capability_observation.operation_permission, 'confirmed');
  assert.equal(result.status, 'simulated');
  assert.equal(result.verified, false);
  assert.equal(fixture.calls.verifyGrant, 1);
  assert.equal(fixture.calls.reserve, 1);
  assert.equal(fixture.calls.dispatch, 1);
  assert.equal(fixture.calls.verifyCapability, 1);
  assert.equal(fixture.calls.revalidateCapability, 2);
  assert.equal(fixture.capabilityInputs.length, 3);
  assert.equal(fixture.capabilityInputs[0].cell_id, 'image_generation');
  assert.equal(fixture.capabilityInputs[0].operation_kind, 'image_generation');
  assert.equal(fixture.capabilityInputs[0].target_binding.account_ref, fixtureScope.account_ref);
  assert.equal(fixture.capabilityInputs[0].target_binding.project_ref, fixtureScope.project_ref);
  assert.deepEqual(fixture.capabilityInputs[0].scope, fixtureScope);
  assert.equal(fixture.capabilityInputs[0].deadline_at, fixture.cell.spend.deadline_at);
  assert.equal(fixture.capabilityInputs[2].previous_evidence.sha256, fixture.capabilityInputs[1].previous_evidence.sha256);
  assert.match(fixture.capabilityInputs[2].at, /^\d{4}-\d\d-\d\dT/);
});

test('generation evidence never substitutes for the separately authorized edit cell', async () => {
  const generation = createMockAccessFixture({ cellId: 'image_generation' });
  const generationResult = await executeAuthorizedAccessCell(generation.args);
  assert.equal(generationResult.status, 'simulated');
  assert.equal(generationResult.cell_id, 'image_generation');

  const edit = createMockAccessFixture({ cellId: 'image_edit' });
  const verifyCapability = edit.capabilityVerifier.verifyCapability.bind(edit.capabilityVerifier);
  edit.capabilityVerifier.verifyCapability = async (input) => ({
    ...(await verifyCapability(input)),
    decision: 'denied',
    operation_permission: 'denied',
  });
  const editResult = await executeAuthorizedAccessCell(edit.args);
  assert.equal(editResult.cell_id, 'image_edit');
  assert.equal(editResult.status, 'denied');
  assert.equal(edit.calls.verifyGrant, 0);
  assert.equal(edit.calls.reserve, 0);
  assert.equal(edit.calls.dispatch, 0);
});

test('unknown operation permission blocks before grant verification or reservation', async () => {
  const fixture = createMockAccessFixture({
    capabilityDecision: async (input) => ({
      decision: 'unknown',
      evidence_mode: 'mock',
      cell_id: input.cell_id,
      owner_role: input.owner_role,
      operation_kind: input.operation_kind,
      target_binding: input.target_binding,
      scope: input.scope,
      deadline_at: input.deadline_at,
      operation_permission: 'unknown',
      quota: 'unknown',
      checked_at: input.at,
      expires_at: new Date(Date.parse(input.deadline_at) + 1_000).toISOString(),
      evidence: { ref: 'test:capability-pending', sha256: digest('capability-pending'), pinned_revision: 'test:capability-v1', independent_review: { ref: 'test:capability-review', sha256: digest('capability-review') } },
      owner_evidence: { owner_role: input.owner_role, ref: 'test:capability-owner', sha256: digest('capability-owner'), pinned_revision: 'test:capability-owner-v1', independent_review: { ref: 'test:capability-owner-review', sha256: digest('capability-owner-review') } },
      protocol: { ref: 'test:capability-protocol', sha256: digest('capability-protocol'), pinned_revision: 'test:capability-protocol-v1', independent_review: { ref: 'test:capability-protocol-review', sha256: digest('capability-protocol-review') } },
    }),
  });
  // A provider adapter may return a permissive metadata claim; the independent
  // capability verifier remains authoritative for operation permission.
  const inspect = fixture.adapter.inspect.bind(fixture.adapter);
  fixture.adapter.inspect = async (input) => ({ ...(await inspect(input)), operation_permission: 'confirmed', quota: 'available' });
  const result = await executeAuthorizedAccessCell(fixture.args);
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason_code, 'operation_permission_unknown');
  assert.equal(fixture.calls.verifyGrant, 0);
  assert.equal(fixture.calls.reserve, 0);
  assert.equal(fixture.calls.dispatch, 0);
});

test('unknown or denied quota blocks before grant verification or reservation', async () => {
  for (const quota of ['unknown', 'denied']) {
    const fixture = createMockAccessFixture();
    // Return an explicit capability result rather than changing metadata.
    const verify = fixture.capabilityVerifier.verifyCapability.bind(fixture.capabilityVerifier);
    fixture.capabilityVerifier.verifyCapability = async (input) => {
      const original = await verify(input);
      return { ...original, decision: quota === 'denied' ? 'denied' : 'unknown', quota };
    };
    const result = await executeAuthorizedAccessCell(fixture.args);
    assert.equal(result.status, quota === 'denied' ? 'denied' : 'unknown');
    assert.equal(result.reason_code, quota === 'denied' ? 'quota_denied' : 'quota_unknown');
    assert.equal(fixture.calls.verifyGrant, 0);
    assert.equal(fixture.calls.reserve, 0);
    assert.equal(fixture.calls.dispatch, 0);
  }
});

test('capability permission revoked after reservation blocks dispatch and keeps the hold', async () => {
  const fixture = createMockAccessFixture();
  const revalidate = fixture.capabilityVerifier.revalidateCapability.bind(fixture.capabilityVerifier);
  fixture.capabilityVerifier.revalidateCapability = async (input) => ({
    ...(await revalidate(input)),
    decision: 'denied',
    operation_permission: 'denied',
  });
  const result = await executeAuthorizedAccessCell(fixture.args);
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason_code, 'capability_revoked_before_dispatch');
  assert.equal(result.financial_hold, 'retained_for_reconciliation');
  assert.equal(fixture.calls.reserve, 1);
  assert.equal(fixture.calls.dispatch, 0);
});

test('capability verifier must bind the authenticated application and provider scopes', async () => {
  const fixture = createMockAccessFixture();
  const verify = fixture.capabilityVerifier.verifyCapability.bind(fixture.capabilityVerifier);
  fixture.capabilityVerifier.verifyCapability = async (input) => ({
    ...(await verify(input)),
    scope: { ...input.scope, project_id: 'test:foreign-project' },
  });
  const result = await executeAuthorizedAccessCell(fixture.args);
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason_code, 'capability_scope_mismatch');
  assert.equal(fixture.calls.verifyGrant, 0);
  assert.equal(fixture.calls.reserve, 0);
  assert.equal(fixture.calls.dispatch, 0);
});

test('stale capability evidence and a capability that expires before the deadline cannot authorize work', async () => {
  for (const kind of ['stale', 'early_expiry']) {
    const fixture = createMockAccessFixture();
    const verify = fixture.capabilityVerifier.verifyCapability.bind(fixture.capabilityVerifier);
    fixture.capabilityVerifier.verifyCapability = async (input) => {
      const decision = await verify(input);
      return kind === 'stale'
        ? { ...decision, checked_at: new Date(Date.parse(input.at) - 6 * 60_000).toISOString() }
        : { ...decision, expires_at: new Date(Date.parse(input.deadline_at) - 1).toISOString() };
    };
    const result = await executeAuthorizedAccessCell(fixture.args);
    assert.equal(result.status, 'unknown');
    assert.equal(result.reason_code, 'capability_expired');
    assert.equal(fixture.calls.verifyGrant, 0);
    assert.equal(fixture.calls.reserve, 0);
    assert.equal(fixture.calls.dispatch, 0);
  }
});

test('missing capability verifier cannot fall back to model-list metadata', async () => {
  const fixture = createMockAccessFixture();
  const result = await executeAuthorizedAccessCell({ ...fixture.args, capabilityVerifier: undefined });
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason_code, 'mock_requires_fixture_ports');
  assert.equal(fixture.calls.verifyGrant, 0);
  assert.equal(fixture.calls.reserve, 0);
  assert.equal(fixture.calls.dispatch, 0);
});

test('foreign grant reference cannot reach a reservation', async () => {
  const fixture = createMockAccessFixture();
  const verify = fixture.authorizationPort.verifyGrant.bind(fixture.authorizationPort);
  fixture.authorizationPort.verifyGrant = async (input) => ({ ...(await verify(input)), grant_ref: 'test:foreign-grant' });
  const result = await executeAuthorizedAccessCell(fixture.args);
  assert.equal(result.status, 'denied');
  assert.equal(result.reason_code, 'authorization_reference_mismatch');
  assert.equal(fixture.calls.reserve, 0);
  assert.equal(fixture.calls.dispatch, 0);
});

test('mismatched lease or cap is released before dispatch and never represented as spent', async () => {
  for (const mismatch of ['lease_id', 'maximum_amount']) {
    const fixture = createMockAccessFixture({
      reservationDecision({ decision }) {
        decision.binding[mismatch] = mismatch === 'lease_id' ? 'test:foreign-lease' : '0.09';
        return decision;
      },
    });
    const result = await executeAuthorizedAccessCell(fixture.args);
    assert.equal(result.status, 'denied');
    assert.equal(result.financial_hold, 'released_before_dispatch');
    assert.equal(fixture.calls.dispatch, 0);
    assert.equal(fixture.calls.release, 1);
    assert.equal(fixture.authority.reservationFor(fixture.meteringRequest.billable_attempt_id).state, 'released_before_dispatch');
  }
});

test('a hold whose release cannot be confirmed remains in reconciliation and blocks dispatch', async () => {
  const fixture = createMockAccessFixture({
    releaseFailure: true,
    reservationDecision({ decision }) {
      decision.binding.lease_id = 'test:wrong-lease';
      return decision;
    },
  });
  const result = await executeAuthorizedAccessCell(fixture.args);
  assert.equal(result.status, 'denied');
  assert.equal(result.financial_hold, 'retained_for_reconciliation');
  assert.equal(fixture.calls.dispatch, 0);
  assert.equal(fixture.authority.reservationFor(fixture.meteringRequest.billable_attempt_id).state, 'held_for_reconciliation');
});

test('an actual reservation above the approved cap is rejected and released before transport', async () => {
  const fixture = createMockAccessFixture({ holdAmount: '0.09' });
  const result = await executeAuthorizedAccessCell(fixture.args);
  assert.equal(result.reason_code, 'reservation_cap_mismatch');
  assert.equal(result.financial_hold, 'released_before_dispatch');
  assert.equal(fixture.calls.dispatch, 0);
});

test('authorization revoked at the dispatch boundary leaves the in-flight hold unknown without provider dispatch', async () => {
  const fixture = createMockAccessFixture();
  const revalidate = fixture.authorizationPort.revalidateGrant.bind(fixture.authorizationPort);
  fixture.authorizationPort.revalidateGrant = async (input) => {
    const decision = await revalidate(input);
    decision.grant.revoked = true;
    return decision;
  };
  const result = await executeAuthorizedAccessCell(fixture.args);
  assert.equal(result.status, 'unknown');
  assert.equal(result.financial_hold, 'retained_for_reconciliation');
  assert.equal(fixture.calls.reserve, 1);
  assert.equal(fixture.calls.dispatch, 0);
  assert.equal(fixture.authority.reservationFor(fixture.meteringRequest.billable_attempt_id).state, 'held_for_reconciliation');
});

test('an already-aborted deadline signal prevents reservation and dispatch', async () => {
  const fixture = createMockAccessFixture();
  const controller = new AbortController();
  controller.abort();
  const result = await executeAuthorizedAccessCell({ ...fixture.args, signal: controller.signal });
  assert.equal(result.status, 'failed');
  assert.equal(result.financial_hold, 'none');
  assert.equal(fixture.calls.reserve, 0);
  assert.equal(fixture.calls.dispatch, 0);
});

test('more than one transport record fails closed and preserves the hold', async () => {
  const fixture = createMockAccessFixture({
    adapterDispatch: async (input) => {
      await input.metering.recordTransportAttempt('test:transport-1');
      await assert.rejects(() => input.metering.recordTransportAttempt('test:transport-2'), AccessPreflightError);
      return {
        evidence_mode: 'mock',
        provider_outcome: 'succeeded',
        usage_observation: {
          schema_version: 'creative.metering.proposal/v1',
          tenant_id: input.metering.attempt.tenant_id,
          project_id: input.metering.attempt.project_id,
          budget_scope_id: input.metering.attempt.budget_scope_id,
          logical_operation_id: input.metering.attempt.logical_operation_id,
          billable_attempt_id: input.metering.attempt.billable_attempt_id,
          source_observation_id: 'test:source-observation-1',
          source: 'provider_response',
          provider_name: input.metering.attempt.provider.name,
          model: input.metering.attempt.provider.model,
          transport_attempt_id: 'test:transport-1',
          environment: input.metering.attempt.environment,
          billing_mode: input.metering.attempt.billing_mode,
          completeness: 'complete',
          usage_units: [{ name: 'total_tokens', quantity: '1', relation: 'standalone' }],
          missing_fields: [],
        },
        evidence: {
          completed_at: new Date().toISOString(),
          service: fixture.target.service,
          endpoint: fixture.target.endpoint,
          model: fixture.target.model,
          sdk_name: fixture.target.sdk.name,
          sdk_version: fixture.target.sdk.version,
          configuration_sha256: fixture.target.configuration_sha256,
        },
      };
    },
  });
  const result = await executeAuthorizedAccessCell(fixture.args);
  assert.equal(result.status, 'unknown');
  assert.equal(result.financial_hold, 'retained_for_reconciliation');
  assert.equal(result.reason_code, 'provider_outcome_unknown');
  assert.equal(fixture.authority.reservationFor(fixture.meteringRequest.billable_attempt_id).transport_attempt_ids.length, 1);
});

test('transport fence must finish successfully before its synchronous assertion can pass', async () => {
  const fixture = createMockAccessFixture({
    adapterDispatch: async (input) => {
      await input.metering.recordTransportAttempt('test:transport-unawaited-fence');
      const pendingAuthorization = input.metering.authorizeTransport();
      assert.throws(() => input.metering.assertTransportReady(), (error) => error.code === 'transport_authorization_fence_missing');
      await assert.rejects(pendingAuthorization, (error) => error.code === 'transport_authorization_fence_missing');
      return { evidence_mode: 'mock' };
    },
  });
  const result = await executeAuthorizedAccessCell(fixture.args);
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason_code, 'transport_authorization_fence_missing');
  assert.equal(result.financial_hold, 'retained_for_reconciliation');
  assert.equal(fixture.calls.settle, 0);
  assert.equal(fixture.authority.reservationFor(fixture.meteringRequest.billable_attempt_id).transport_attempt_ids.length, 1);
});

test('cancellation after awaited post-ack verification fails the final synchronous transport fence', async () => {
  const fixture = createMockAccessFixture({
    adapterDispatch: async (input) => {
      await input.metering.recordTransportAttempt('test:transport-cancel-at-final-fence');
      await input.metering.authorizeTransport();
      controller.abort();
      input.metering.assertTransportReady();
      throw new Error('unreachable transport');
    },
  });
  const controller = new AbortController();
  const result = await executeAuthorizedAccessCell({ ...fixture.args, signal: controller.signal });
  assert.equal(result.status, 'unknown');
  assert.equal(result.financial_hold, 'retained_for_reconciliation');
  assert.equal(result.reason_code, 'preflight_deadline_passed');
  assert.equal(fixture.calls.revalidateCapability, 2);
  assert.equal(fixture.calls.revalidateGrant, 2);
  assert.equal(fixture.calls.settle, 0);
  assert.equal(fixture.authority.reservationFor(fixture.meteringRequest.billable_attempt_id).transport_attempt_ids.length, 1);
});

test('unknown provider usage never settles the hold or becomes a verified result', async () => {
  const fixture = createMockAccessFixture({
    adapterDispatch: async (input) => {
      await input.metering.recordTransportAttempt('test:transport-1');
      const attempt = input.metering.attempt;
      await input.metering.authorizeTransport();
      input.metering.assertTransportReady();
      return {
        evidence_mode: 'mock',
        provider_outcome: 'succeeded',
        usage_observation: {
          schema_version: 'creative.metering.proposal/v1',
          tenant_id: attempt.tenant_id,
          project_id: attempt.project_id,
          budget_scope_id: attempt.budget_scope_id,
          logical_operation_id: attempt.logical_operation_id,
          billable_attempt_id: attempt.billable_attempt_id,
          source_observation_id: 'test:source-observation-1',
          source: 'provider_response',
          provider_name: attempt.provider.name,
          model: attempt.provider.model,
          transport_attempt_id: 'test:transport-1',
          environment: attempt.environment,
          billing_mode: attempt.billing_mode,
          completeness: 'unknown',
          missing_fields: ['provider_usage'],
        },
        evidence: {
          completed_at: new Date().toISOString(),
          service: fixture.target.service,
          endpoint: fixture.target.endpoint,
          model: fixture.target.model,
          sdk_name: fixture.target.sdk.name,
          sdk_version: fixture.target.sdk.version,
          configuration_sha256: fixture.target.configuration_sha256,
        },
      };
    },
  });
  const result = await executeAuthorizedAccessCell(fixture.args);
  assert.equal(result.status, 'unknown');
  assert.equal(result.financial_hold, 'retained_for_reconciliation');
  assert.equal(fixture.calls.settle, 0);
  assert.equal(fixture.authority.reservationFor(fixture.meteringRequest.billable_attempt_id).state, 'held_for_reconciliation');
});

test('public report rejects mutable, foreign-run, foreign-mode, and caller-forged rows', async () => {
  const fixture = createMockAccessFixture();
  const report = await runAccessPreflight(fixture.args);
  assert.ok(Object.isFrozen(report));
  assert.ok(Object.isFrozen(report.cells));
  assert.throws(() => { report.acceptance_allowed = true; }, TypeError);
  assert.throws(() => { report.cells[1].status = 'verified'; }, TypeError);
  const row = report.cells[0];
  assert.ok(Object.isFrozen(row));
  assert.ok(Object.isFrozen(row.pin_evidence));
  assert.throws(() => { row.status = 'verified'; }, TypeError);
  assert.throws(() => Object.defineProperty(row, 'authorization_evidence', { value: 'forged' }), TypeError);
  const foreignRun = createAccessPreflightReport({
    run_id: 'test:other-run', generated_at: new Date().toISOString(), mode: 'mock', results: [row],
  });
  assert.equal(foreignRun.verified_cell_count, 0);
  const foreignMode = createAccessPreflightReport({
    run_id: fixture.plan.run_id, generated_at: new Date().toISOString(), mode: 'live', results: [row],
  });
  assert.equal(foreignMode.verified_cell_count, 0);
  const forged = createAccessPreflightReport({
    run_id: fixture.plan.run_id,
    generated_at: new Date().toISOString(),
    mode: 'live',
    results: [{ ...row, mode: 'live', status: 'verified', verified: true, authorization_evidence: 'Bearer secret' }],
  });
  assert.equal(forged.verified_cell_count, 0);
  assert.doesNotMatch(JSON.stringify(forged), /Bearer secret/);
});

test('unsafe configuration values and public identifiers are rejected while max_output_tokens is allowed', () => {
  for (const value of ['Bearer x', 'Bearer abcdefg', `ghp_${'SyntheticCredentialValue'.repeat(2)}`, 'rk-SyntheticCredentialValue1234', 'Bearer fixture-secret-value', 'person@example.invalid', 'https://files.invalid/a?signature=fixture']) {
    const plan = structuredClone(createMockAccessFixture().plan);
    updateCellConfiguration(plan, (configuration) => { configuration.quality = value; });
    assert.equal(validateAccessPlan(plan, fixtureScope).cells[0].input_error_code, 'sensitive_configuration_value');
  }
  const valid = structuredClone(createMockAccessFixture().plan);
  updateCellConfiguration(valid, (configuration) => { configuration.max_output_tokens = 128; });
  assert.equal(validateAccessPlan(valid, fixtureScope).cells[0].input_status, 'valid');
  const camelCaseCredential = structuredClone(createMockAccessFixture().plan);
  updateCellConfiguration(camelCaseCredential, (configuration) => { configuration.oidcToken = 'eyJ.fixture-only.jwt'; });
  assert.equal(validateAccessPlan(camelCaseCredential, fixtureScope).cells[0].input_error_code, 'sensitive_configuration_field');
  const emailRun = structuredClone(createMockAccessFixture().plan);
  emailRun.run_id = 'person@example.invalid';
  assert.throws(() => validateAccessPlan(emailRun, fixtureScope), (error) => error.code === 'invalid_evidence_reference');
  const nestedSensitive = structuredClone(createMockAccessFixture().plan);
  updateCellConfiguration(nestedSensitive, (configuration) => {
    configuration.labels = { support_contact: 'person@example.invalid' };
  });
  assert.equal(validateAccessPlan(nestedSensitive, fixtureScope).cells[0].input_error_code, 'sensitive_configuration_value');
});

test('configuration screening catches canonical Basic credentials without rejecting ordinary prose and hides them from reports', async () => {
  const basicCredentials = [
    'Basic dTpw',
    'Basic OnBhc3N3b3Jk',
    'Basic dTo=',
    'Basic Og==',
    `Basic ${Buffer.from('usér:päss', 'utf8').toString('base64')}`,
  ];
  for (const credential of basicCredentials) {
    const plan = structuredClone(createMockAccessFixture().plan);
    updateCellConfiguration(plan, (configuration) => { configuration.description = credential; });
    assert.equal(validateAccessPlan(plan, fixtureScope).cells[0].input_error_code, 'sensitive_configuration_value');
  }

  const safeFixture = createMockAccessFixture();
  updateCellConfiguration(safeFixture.plan, (configuration) => {
    configuration.description = 'Basic illustrations support the main headline.';
  });
  const inspect = safeFixture.adapter.inspect.bind(safeFixture.adapter);
  safeFixture.adapter.inspect = async (...args) => {
    const observation = await inspect(...args);
    return {
      ...observation,
      target: { ...observation.target, configuration_sha256: safeFixture.target.configuration_sha256 },
    };
  };
  const safeReport = await runAccessPreflight(safeFixture.args);
  assert.equal(safeReport.cells[0].status, 'simulated');
  assert.equal(safeReport.verified_cell_count, 0);
  assert.equal(validateAccessPlan(safeFixture.plan, fixtureScope).cells[0].input_status, 'valid');

  const sensitiveKeys = [
    'Bearer x',
    `ghp_${'SyntheticCredentialValue'.repeat(2)}`,
    'rk-SyntheticCredentialValue1234',
    'sk-abcdefghijklmnopqrstuvwxyz1234',
    'owner@example.invalid',
    'Basic dTpw',
  ];
  for (const key of sensitiveKeys) {
    const fixture = createMockAccessFixture();
    updateCellConfiguration(fixture.plan, (configuration) => { configuration.labels = { nested: { [key]: 'fixture value' } }; });
    const report = await runAccessPreflight(fixture.args);
    assert.equal(report.cells[0].status, 'blocked');
    assert.equal(report.cells[0].reason_code, 'sensitive_configuration_field');
    assert.equal(fixture.calls.reserve, 0);
    assert.equal(fixture.calls.dispatch, 0);
    assert.equal(JSON.stringify(report).includes(key), false);
  }

  for (const credential of basicCredentials) {
    const fixture = createMockAccessFixture();
    updateCellConfiguration(fixture.plan, (configuration) => { configuration.description = credential; });
    const report = await runAccessPreflight(fixture.args);
    assert.equal(report.cells[0].status, 'blocked');
    assert.equal(report.cells[0].reason_code, 'sensitive_configuration_value');
    assert.equal(fixture.calls.reserve, 0);
    assert.equal(fixture.calls.dispatch, 0);
    assert.equal(JSON.stringify(report).includes(credential), false);
  }

  for (const marker of ['Bearer x', 'Bearer abcdefg', `ghp_${'SyntheticCredentialValue'.repeat(2)}`, 'rk-SyntheticCredentialValue1234']) {
    const fixture = createMockAccessFixture();
    const verify = fixture.pinVerifier.verifyPin.bind(fixture.pinVerifier);
    fixture.pinVerifier.verifyPin = async (input) => {
      const decision = await verify(input);
      decision.evidence.ref = marker;
      return decision;
    };
    const result = await executeAuthorizedAccessCell(fixture.args);
    const report = createAccessPreflightReport({
      run_id: fixture.args.runId,
      generated_at: new Date().toISOString(),
      mode: 'mock',
      results: [result],
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason_code, 'invalid_evidence_reference');
    assert.equal(JSON.stringify(report).includes(marker), false);
  }
});

test('grant references containing personal identifiers are rejected before authority calls', async () => {
  const fixture = createMockAccessFixture();
  const result = await executeAuthorizedAccessCell({ ...fixture.args, grantRef: 'person@example.invalid' });
  assert.equal(result.status, 'denied');
  assert.equal(result.reason_code, 'authorization_reference_missing');
  assert.equal(fixture.calls.verifyGrant, 0);
  assert.equal(fixture.calls.reserve, 0);
  assert.equal(fixture.calls.dispatch, 0);
  assert.doesNotMatch(JSON.stringify(result), /person@example\.invalid/);
});

test('Finance reservation lease and evidence are revalidated immediately before transport', async () => {
  for (const failure of ['inactive_lease', 'expired_lease', 'stale_check']) {
    const fixture = createMockAccessFixture();
    const verifyReservation = fixture.reservationVerifier.verifyReservation.bind(fixture.reservationVerifier);
    let calls = 0;
    fixture.reservationVerifier.verifyReservation = async (input) => {
      calls += 1;
      const decision = await verifyReservation(input);
      if (calls !== 2) return decision;
      if (failure === 'inactive_lease') return { ...decision, lease_active: false };
      if (failure === 'expired_lease') return { ...decision, lease_expires_at: input.at };
      return { ...decision, checked_at: new Date(Date.parse(input.at) - 6 * 60_000).toISOString() };
    };
    const result = await executeAuthorizedAccessCell(fixture.args);
    assert.equal(calls, 2);
    assert.equal(result.status, 'unknown');
    assert.equal(result.reason_code, 'reservation_scope_unknown');
    assert.equal(result.financial_hold, 'retained_for_reconciliation');
    assert.equal(fixture.calls.dispatch, 0);
    assert.equal(fixture.authority.reservationFor(fixture.meteringRequest.billable_attempt_id).state, 'held_for_reconciliation');
  }
});

test('grant expiry that occurs while revalidation awaits blocks before provider dispatch', async () => {
  const fixture = createMockAccessFixture();
  const verifyGrant = fixture.authorizationPort.verifyGrant.bind(fixture.authorizationPort);
  const revalidateGrant = fixture.authorizationPort.revalidateGrant.bind(fixture.authorizationPort);
  let expiresAt;
  fixture.authorizationPort.verifyGrant = async (input) => {
    const decision = await verifyGrant(input);
    expiresAt = new Date(Date.parse(input.expected.deadline_at) - 30_000).toISOString();
    decision.grant.expires_at = expiresAt;
    return decision;
  };
  fixture.authorizationPort.revalidateGrant = async (input) => {
    const decision = await revalidateGrant(input);
    decision.grant.expires_at = expiresAt;
    return decision;
  };
  const result = await withClockAdvance(async (advance) => {
    fixture.authorizationPort.revalidateGrant = async (input) => {
      const decision = await revalidateGrant(input);
      decision.grant.expires_at = expiresAt;
      advance(14 * 60_000 + 45_000);
      return decision;
    };
    return executeAuthorizedAccessCell(fixture.args);
  });
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason_code, 'authorization_revoked_before_dispatch');
  assert.equal(result.financial_hold, 'retained_for_reconciliation');
  assert.equal(fixture.calls.dispatch, 0);
});

test('capability revalidation timestamp is checked after the verifier returns', async () => {
  const fixture = createMockAccessFixture();
  const revalidateCapability = fixture.capabilityVerifier.revalidateCapability.bind(fixture.capabilityVerifier);
  const result = await withClockAdvance(async (advance) => {
    fixture.capabilityVerifier.revalidateCapability = async (input) => {
      const decision = await revalidateCapability(input);
      advance(6 * 60_000);
      return decision;
    };
    return executeAuthorizedAccessCell(fixture.args);
  });
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason_code, 'capability_revoked_before_dispatch');
  assert.equal(result.financial_hold, 'retained_for_reconciliation');
  assert.equal(fixture.calls.dispatch, 0);
});

test('Finance lease expiry during an awaited currentness check blocks transport', async () => {
  const fixture = createMockAccessFixture();
  const verifyReservation = fixture.reservationVerifier.verifyReservation.bind(fixture.reservationVerifier);
  let calls = 0;
  const result = await withClockAdvance(async (advance) => {
    fixture.reservationVerifier.verifyReservation = async (input) => {
      calls += 1;
      const decision = await verifyReservation(input);
      if (calls === 2) {
        decision.lease_expires_at = new Date(Date.parse(input.at) + 30_000).toISOString();
        advance(45_000);
      }
      return decision;
    };
    return executeAuthorizedAccessCell(fixture.args);
  });
  assert.equal(calls, 2);
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason_code, 'reservation_scope_unknown');
  assert.equal(result.financial_hold, 'retained_for_reconciliation');
  assert.equal(fixture.calls.dispatch, 0);
});

test('credential-like pinned revisions cannot enter public reports', async () => {
  const fixture = createMockAccessFixture();
  const verifyPin = fixture.pinVerifier.verifyPin.bind(fixture.pinVerifier);
  fixture.pinVerifier.verifyPin = async (input) => {
    const decision = await verifyPin(input);
    decision.evidence.pinned_revision = 'sk-syntheticRevisionSecret123456789';
    return decision;
  };
  const result = await executeAuthorizedAccessCell(fixture.args);
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason_code, 'invalid_evidence_reference');
  assert.doesNotMatch(JSON.stringify(result), /sk-syntheticRevisionSecret123456789/);
});

test('provider-supplied evidence refs with personal or signed URL data never enter reports', async () => {
  const cases = [
    {
      marker: 'person@example.invalid',
      async mutate(fixture) {
        const inspect = fixture.adapter.inspect.bind(fixture.adapter);
        fixture.adapter.inspect = async (...args) => {
          const observation = await inspect(...args);
          observation.evidence.ref = 'person@example.invalid';
          return observation;
        };
      },
    },
    {
      marker: 'person@example.invalid',
      async mutate(fixture) {
        const verify = fixture.capabilityVerifier.verifyCapability.bind(fixture.capabilityVerifier);
        fixture.capabilityVerifier.verifyCapability = async (input) => {
          const decision = await verify(input);
          decision.evidence.ref = 'person@example.invalid';
          return decision;
        };
      },
    },
    {
      marker: 'https://private.invalid/item?signature=fixture-secret',
      async mutate(fixture) {
        const verify = fixture.authorizationPort.verifyGrant.bind(fixture.authorizationPort);
        fixture.authorizationPort.verifyGrant = async (input) => {
          const decision = await verify(input);
          decision.evidence.ref = 'https://private.invalid/item?signature=fixture-secret';
          return decision;
        };
      },
    },
    {
      marker: 'person@example.invalid',
      async mutate(fixture) {
        const verify = fixture.reservationVerifier.verifyReservation.bind(fixture.reservationVerifier);
        fixture.reservationVerifier.verifyReservation = async (input) => {
          const decision = await verify(input);
          decision.evidence.ref = 'person@example.invalid';
          return decision;
        };
      },
    },
  ];
  for (const [index, current] of cases.entries()) {
    const fixture = createMockAccessFixture({ runId: `test:privacy-evidence-${index}` });
    await current.mutate(fixture);
    const result = await executeAuthorizedAccessCell(fixture.args);
    assert.notEqual(result.status, 'verified');
    assert.doesNotMatch(JSON.stringify(result), new RegExp(current.marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(fixture.calls.dispatch, 0);
  }
});

test('provider failures with credential-bearing enumerable fields never enter public errors or traces', async () => {
  const fixture = createMockAccessFixture();
  fixture.authorizationPort.verifyGrant = async () => {
    const failure = new Error('sensitive upstream error');
    failure.authorization = 'Bearer fixture-secret-do-not-return';
    failure.headers = { authorization: 'fixture-header-secret' };
    failure.signedURL = 'https://private.invalid/object?signature=fixture-secret';
    throw failure;
  };
  const result = await executeAuthorizedAccessCell(fixture.args);
  const serialized = JSON.stringify(result);
  assert.equal(result.status, 'denied');
  assert.match(result.reason_code, /^[a-z0-9_]+$/);
  assert.doesNotMatch(serialized, /fixture-secret-do-not-return|fixture-header-secret|https:\/\/private\.invalid|signedURL/);
});

test('provider-supplied email receipt identifiers are rejected before public projection', async () => {
  const fixture = createMockAccessFixture({
    adapterDispatch: async (input) => {
      await input.metering.recordTransportAttempt('test:transport-email-ref');
      const attempt = input.metering.attempt;
      await input.metering.authorizeTransport();
      input.metering.assertTransportReady();
      return {
        evidence_mode: 'mock',
        provider_outcome: 'succeeded',
        usage_observation: {
          schema_version: 'creative.metering.proposal/v1',
          tenant_id: attempt.tenant_id,
          project_id: attempt.project_id,
          budget_scope_id: attempt.budget_scope_id,
          logical_operation_id: attempt.logical_operation_id,
          billable_attempt_id: attempt.billable_attempt_id,
          source_observation_id: 'test:observation-email-ref',
          source: 'provider_response',
          provider_name: attempt.provider.name,
          model: attempt.provider.model,
          transport_attempt_id: 'test:transport-email-ref',
          environment: attempt.environment,
          billing_mode: attempt.billing_mode,
          completeness: 'unknown',
          missing_fields: ['provider_usage'],
        },
        evidence: {
          provider_request_ref: 'person@example.invalid',
          completed_at: new Date().toISOString(),
          service: fixture.target.service,
          endpoint: fixture.target.endpoint,
          model: fixture.target.model,
          sdk_name: fixture.target.sdk.name,
          sdk_version: fixture.target.sdk.version,
          configuration_sha256: fixture.target.configuration_sha256,
        },
      };
    },
  });
  const result = await executeAuthorizedAccessCell(fixture.args);
  assert.equal(result.status, 'unknown');
  assert.equal(result.financial_hold, 'retained_for_reconciliation');
  assert.doesNotMatch(JSON.stringify(result), /person@example\.invalid/);
});

test('invalid access plan keeps fixed cell denominator and records safe invalid row', async () => {
  const fixture = createMockAccessFixture();
  const invalidPlan = structuredClone(fixture.plan);
  invalidPlan.cells[0].target.configuration.prompt_template_ref = 'person@example.invalid';
  invalidPlan.cells[0].target.configuration_sha256 = canonicalHash(invalidPlan.cells[0].target.configuration);
  const report = await runAccessPreflight({ ...fixture.args, plan: invalidPlan });
  assert.equal(report.required_cell_count, 8);
  assert.equal(report.cells.length, 8);
  assert.equal(report.cells[0].status, 'blocked');
  assert.equal(report.cells[0].reason_code, 'sensitive_configuration_value');
  assert.equal(fixture.calls.dispatch, 0);
  assert.doesNotMatch(JSON.stringify(report), /person@example\.invalid/);
});
