import test from 'node:test';
import assert from 'node:assert/strict';
import {
  METERING_PROPOSAL_VERSION,
  MeteringContractError,
  evaluateMeteringAgreementGate,
  executeMeteredAttempt,
  recordUsageObservation,
  sameMeteringIdentity,
  validateMeteredAttempt,
  validateUsageObservation,
} from 'creative-engine/contracts/metering';
import { FakeMeteringAuthority } from '../../../fixtures/contracts/metering/fake-authority.mjs';

const trustedScope = {
  tenant_id: 'test:tenant-a',
  project_id: 'test:project-a',
  budget_scope_id: 'test:budget-a',
};

function attempt(overrides = {}) {
  const base = {
    schema_version: METERING_PROPOSAL_VERSION,
    tenant_id: trustedScope.tenant_id,
    project_id: trustedScope.project_id,
    budget_scope_id: trustedScope.budget_scope_id,
    logical_operation_id: 'test:operation-1',
    billable_attempt_id: 'test:billable-1',
    retry_mapping_ref: 'test:retry-map-images-v1',
    operation_kind: 'image_generation',
    environment: 'test',
    billing_mode: 'simulated',
    budget: { scope_id: trustedScope.budget_scope_id, policy_version: 'test:budget-policy-v1' },
    provider: {
      name: 'test:image-provider',
      model: 'test:image-model-v1',
      endpoint: 'test:/images/generations',
      sdk: { name: 'test:image-sdk', version: '0.0.1' },
    },
  };
  const merged = { ...base, ...overrides };
  merged.budget = { ...base.budget, ...(overrides.budget ?? {}) };
  merged.provider = { ...base.provider, ...(overrides.provider ?? {}) };
  merged.provider.sdk = { ...base.provider.sdk, ...(overrides.provider?.sdk ?? {}) };
  return merged;
}

function observation(attemptRequest, overrides = {}) {
  return {
    schema_version: METERING_PROPOSAL_VERSION,
    tenant_id: attemptRequest.tenant_id,
    project_id: attemptRequest.project_id,
    budget_scope_id: attemptRequest.budget_scope_id,
    logical_operation_id: attemptRequest.logical_operation_id,
    billable_attempt_id: attemptRequest.billable_attempt_id,
    source_observation_id: 'test:observation-direct-1',
    source: 'provider_response',
    provider_name: attemptRequest.provider.name,
    model: attemptRequest.provider.model,
    provider_request_id: 'test:provider-request-1',
    transport_attempt_id: 'test:transport-1',
    environment: attemptRequest.environment,
    billing_mode: attemptRequest.billing_mode,
    completeness: 'complete',
    usage_units: [
      { name: 'input_tokens', quantity: '10', relation: 'standalone' },
      { name: 'cached_input_tokens', quantity: '2', relation: 'included_subset', included_in: 'input_tokens' },
    ],
    missing_fields: [],
    ...overrides,
  };
}

function secretError() {
  const error = new Error('private provider error');
  error.authorization = 'Bearer fixture-secret-do-not-return';
  error.headers = { authorization: 'fixture-header-secret' };
  error.signedURL = 'https://private.invalid/object?signature=fixture-secret';
  return error;
}

test('trusted scope is server-bound, and unknown usage cannot be encoded as zero', () => {
  assert.throws(
    () => validateMeteredAttempt(attempt({ tenant_id: 'test:tenant-forged' }), trustedScope),
    (error) => error instanceof MeteringContractError && error.code === 'trusted_scope_mismatch',
  );
  assert.throws(
    () => validateMeteredAttempt(attempt({ billable_attempt_id: 'test:operation-1' }), trustedScope),
    (error) => error instanceof MeteringContractError && error.code === 'identity_collision',
  );
  const request = validateMeteredAttempt(attempt(), trustedScope);
  const unknown = observation(request, {
    completeness: 'unknown',
    usage_units: [],
    missing_fields: ['provider_usage'],
    provider_request_id: undefined,
  });
  assert.equal(validateUsageObservation(unknown, request).completeness, 'unknown');
  assert.throws(
    () => validateUsageObservation({ ...unknown, usage_units: [{ name: 'input_tokens', quantity: '0', relation: 'standalone' }] }, request),
    (error) => error instanceof MeteringContractError && error.code === 'unknown_usage_has_units',
  );
  assert.throws(
    () => validateUsageObservation({ ...unknown, source_observation_id: request.billable_attempt_id }, request),
    (error) => error instanceof MeteringContractError && error.code === 'identity_collision',
  );
  assert.throws(
    () => validateUsageObservation({ ...unknown, budget_scope_id: 'test:wrong-budget' }, request),
    (error) => error instanceof MeteringContractError && error.code === 'attempt_identity_mismatch',
  );
  assert.equal(sameMeteringIdentity(request, { ...request, transport_attempt_id: 'test:transport-2' }), true);
  assert.equal(sameMeteringIdentity(request, { ...request, billable_attempt_id: 'test:billable-2' }), false);
});

test('two workers contend atomically and a denied reservation never reaches the provider', async () => {
  const authority = new FakeMeteringAuthority({
    budget: '0.10',
    defaultHold: '0.08',
    defaultConsumed: '0.03',
  });
  let providerCalls = 0;
  const requests = [
    attempt({ billable_attempt_id: 'test:worker-a', logical_operation_id: 'test:operation-a' }),
    attempt({ billable_attempt_id: 'test:worker-b', logical_operation_id: 'test:operation-b' }),
  ];
  const outcomes = await Promise.all(requests.map((request) => executeMeteredAttempt({
    port: authority,
    request,
    trustedScope,
    dispatch: async ({ recordTransportAttempt }) => {
      providerCalls += 1;
      await recordTransportAttempt(`test:transport-${request.billable_attempt_id}`);
      return { usage_observation: observation(request, {
        billable_attempt_id: request.billable_attempt_id,
        logical_operation_id: request.logical_operation_id,
        source_observation_id: `test:usage-${request.billable_attempt_id}`,
        provider_request_id: `test:request-${request.billable_attempt_id}`,
        transport_attempt_id: `test:transport-${request.billable_attempt_id}`,
      }) };
    },
  })));

  assert.equal(outcomes.filter((outcome) => outcome.status === 'settled').length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'reservation_denied').length, 1);
  assert.equal(providerCalls, 1);
  assert.equal(authority.availableAmount().amount, '0.07');
});

test('direct and trace observations keep separate observation IDs but one effective attempt charge', async () => {
  const authority = new FakeMeteringAuthority();
  const request = attempt();
  await authority.reserveAttempt(request);
  const direct = observation(request, { source_observation_id: 'test:observation-direct', source: 'provider_response' });
  const trace = observation(request, { source_observation_id: 'test:observation-trace', source: 'trace' });

  const first = await recordUsageObservation({ port: authority, attempt: request, trustedScope, observation: direct });
  const second = await recordUsageObservation({ port: authority, attempt: request, trustedScope, observation: trace });
  assert.equal(first.status, 'accepted');
  assert.equal(second.status, 'duplicate');
  assert.notEqual(first.source_observation_id, second.source_observation_id);
  assert.equal(first.effective_billable_attempt_id, second.effective_billable_attempt_id);
  assert.equal(authority.effectiveChargeCount, 1);
});

test('foreign usage acknowledgement identities keep the hold and never settle', async () => {
  const authority = new FakeMeteringAuthority();
  const request = attempt();
  let settlementCalls = 0;
  authority.recordUsageObservation = async () => ({
    status: 'accepted',
    source_observation_id: 'test:foreign-observation',
    effective_billable_attempt_id: 'test:foreign-billable',
  });
  authority.settleReservation = async () => { settlementCalls += 1; throw new Error('must not settle foreign acknowledgement'); };
  const outcome = await executeMeteredAttempt({
    port: authority,
    request,
    trustedScope,
    dispatch: async ({ recordTransportAttempt }) => {
      await recordTransportAttempt('test:transport-foreign-ack');
      return { usage_observation: observation(request, {
        source_observation_id: 'test:observation-foreign-ack',
        transport_attempt_id: 'test:transport-foreign-ack',
      }) };
    },
  });
  assert.equal(outcome.status, 'usage_observation_unconfirmed');
  assert.equal(outcome.hold, 'retained_for_reconciliation');
  assert.equal(settlementCalls, 0);
  assert.equal(authority.reservationFor(request.billable_attempt_id).state, 'held_for_reconciliation');
});

test('standalone observation forwarding rejects mismatched acknowledgement identities', async () => {
  const request = attempt();
  for (const acknowledgement of [
    { status: 'accepted', source_observation_id: 'test:foreign-observation', effective_billable_attempt_id: request.billable_attempt_id },
    { status: 'duplicate', source_observation_id: 'test:observation-direct-1', effective_billable_attempt_id: 'test:foreign-billable' },
  ]) {
    await assert.rejects(recordUsageObservation({
      port: { recordUsageObservation: async () => acknowledgement },
      attempt: request,
      trustedScope,
      observation: observation(request),
    }), (error) => error instanceof MeteringContractError && error.code === 'usage_ack_identity_mismatch');
  }
});

test('a genuinely billed retry uses a new billable attempt and retains both charges', async () => {
  const authority = new FakeMeteringAuthority({ budget: '0.20', defaultHold: '0.08', defaultConsumed: '0.03' });
  const firstRequest = attempt({ billable_attempt_id: 'test:billable-first' });
  const retryRequest = attempt({ billable_attempt_id: 'test:billable-second' });
  assert.equal(firstRequest.logical_operation_id, retryRequest.logical_operation_id);
  assert.notEqual(firstRequest.billable_attempt_id, retryRequest.billable_attempt_id);

  const run = (request, suffix) => executeMeteredAttempt({
    port: authority,
    request,
    trustedScope,
    dispatch: async ({ recordTransportAttempt }) => {
      await recordTransportAttempt(`test:transport-${suffix}`);
      return { usage_observation: observation(request, {
        source_observation_id: `test:observation-${suffix}`,
        provider_request_id: `test:provider-request-${suffix}`,
        transport_attempt_id: `test:transport-${suffix}`,
      }) };
    },
  });
  assert.equal((await run(firstRequest, 'first')).status, 'settled');
  assert.equal((await run(retryRequest, 'second')).status, 'settled');
  assert.equal(authority.effectiveChargeCount, 2);
  assert.equal(authority.reservationFor('test:billable-first').consumed_cents, 3n);
  assert.equal(authority.reservationFor('test:billable-second').consumed_cents, 3n);
});

test('absent usage remains unknown and keeps the reservation held', async () => {
  const authority = new FakeMeteringAuthority();
  const request = attempt();
  const outcome = await executeMeteredAttempt({
    port: authority,
    request,
    trustedScope,
    dispatch: async ({ recordTransportAttempt }) => {
      await recordTransportAttempt('test:transport-unknown');
      return { provider_outcome: 'succeeded' };
    },
  });
  assert.equal(outcome.status, 'usage_unknown');
  assert.equal(outcome.provider_outcome, 'succeeded');
  assert.equal('result' in outcome, false);
  assert.doesNotMatch(JSON.stringify(outcome), /fixture-secret|authorization|signedURL|private\.invalid/);
  assert.equal(outcome.hold, 'retained_for_reconciliation');
  assert.equal(authority.reservationFor(request.billable_attempt_id).state, 'held_for_reconciliation');
  assert.equal(authority.reservationFor(request.billable_attempt_id).held_cents, 8n);
});

test('unrecognized dispatch fields cannot escape and keep the hold for reconciliation', async () => {
  const authority = new FakeMeteringAuthority();
  const request = attempt();
  const outcome = await executeMeteredAttempt({
    port: authority,
    request,
    trustedScope,
    dispatch: async ({ recordTransportAttempt }) => {
      await recordTransportAttempt('test:transport-invalid-result');
      return {
        provider_outcome: 'succeeded',
        authorization: 'Bearer fixture-secret-do-not-return',
        headers: { authorization: 'fixture-header-secret' },
        signedURL: 'https://private.invalid/object?signature=fixture-secret',
      };
    },
  });
  assert.equal(outcome.status, 'dispatch_result_invalid');
  assert.equal(outcome.error_code, 'invalid_provider_response');
  assert.equal(outcome.hold, 'retained_for_reconciliation');
  assert.doesNotMatch(JSON.stringify(outcome), /fixture-secret|authorization|headers|signedURL|private\.invalid/);
  assert.equal(authority.reservationFor(request.billable_attempt_id).state, 'held_for_reconciliation');
});

test('timeout and lease expiry retain the in-flight hold without exposing provider errors', async () => {
  const authority = new FakeMeteringAuthority();
  const request = attempt();
  const outcome = await executeMeteredAttempt({
    port: authority,
    request,
    trustedScope,
    dispatch: async ({ recordTransportAttempt }) => {
      await recordTransportAttempt('test:transport-timeout');
      throw secretError();
    },
  });
  assert.equal(outcome.status, 'dispatch_outcome_unknown');
  assert.equal(outcome.hold, 'retained_for_reconciliation');
  assert.equal(outcome.error_code, 'provider_outcome_unknown');
  assert.doesNotMatch(JSON.stringify(outcome), /fixture-secret|authorization|headers|signedURL|private\.invalid/);
  assert.equal(authority.reservationFor(request.billable_attempt_id).state, 'held_for_reconciliation');
  assert.equal(authority.reservationFor(request.billable_attempt_id).held_cents, 8n);

  const leaseRequest = attempt({ billable_attempt_id: 'test:lease-expiry' });
  const controller = new AbortController();
  let announceStarted;
  let resolveLate;
  const started = new Promise((resolve) => { announceStarted = resolve; });
  const pending = new Promise((resolve) => { resolveLate = resolve; });
  const running = executeMeteredAttempt({
    port: authority,
    request: leaseRequest,
    trustedScope,
    signal: controller.signal,
    dispatch: async ({ recordTransportAttempt }) => {
      await recordTransportAttempt('test:transport-lease-expiry');
      announceStarted();
      return pending;
    },
  });
  await started;
  const expired = authority.expireWorkerLease(leaseRequest.billable_attempt_id);
  assert.equal(expired.hold_state, 'retained');
  assert.equal(authority.availableAmount().amount, '0.84');
  controller.abort();
  const cancelled = await running;
  assert.equal(cancelled.status, 'cancelled_after_dispatch');
  assert.equal(cancelled.published, false);
  assert.equal(authority.reservationFor(leaseRequest.billable_attempt_id).state, 'held_for_reconciliation');
  resolveLate({ usage_observation: observation(leaseRequest) });
  await Promise.resolve();
});

test('cancellation prevents publication and does not release an in-flight reservation', async () => {
  const authority = new FakeMeteringAuthority();
  const request = attempt();
  const controller = new AbortController();
  let announceStarted;
  let resolveLate;
  const started = new Promise((resolve) => { announceStarted = resolve; });
  const pending = new Promise((resolve) => { resolveLate = resolve; });
  const running = executeMeteredAttempt({
    port: authority,
    request,
    trustedScope,
    signal: controller.signal,
    dispatch: async ({ recordTransportAttempt }) => {
      await recordTransportAttempt('test:transport-cancel');
      announceStarted();
      return pending;
    },
  });
  await started;
  controller.abort();
  const outcome = await running;
  assert.equal(outcome.status, 'cancelled_after_dispatch');
  assert.equal(outcome.published, false);
  assert.equal(authority.reservationFor(request.billable_attempt_id).state, 'held_for_reconciliation');
  assert.equal(authority.reservationFor(request.billable_attempt_id).held_cents, 8n);
  resolveLate({ usage_observation: observation(request) });
  await Promise.resolve();
});

test('authoritative settlement releases only its exact unused amount', async () => {
  const authority = new FakeMeteringAuthority({ budget: '0.10', defaultHold: '0.08', defaultConsumed: '0.03' });
  const request = attempt();
  const outcome = await executeMeteredAttempt({
    port: authority,
    request,
    trustedScope,
    dispatch: async ({ recordTransportAttempt }) => {
      await recordTransportAttempt('test:transport-settle');
      return { usage_observation: observation(request, {
        source_observation_id: 'test:observation-settle',
        provider_request_id: 'test:provider-request-settle',
        transport_attempt_id: 'test:transport-settle',
      }) };
    },
  });
  assert.equal(outcome.status, 'settled');
  assert.deepEqual(outcome.settlement.consumed_amount, { amount: '0.03', currency: 'USD' });
  assert.deepEqual(outcome.settlement.released_unused_amount, { amount: '0.05', currency: 'USD' });
  assert.equal(authority.availableAmount().amount, '0.07');
});

test('a failed authority response cannot leak headers, authorization, or signed URLs', async () => {
  const authority = new FakeMeteringAuthority();
  authority.reserveAttempt = async () => { throw secretError(); };
  const outcome = await executeMeteredAttempt({
    port: authority,
    request: attempt(),
    trustedScope,
    dispatch: async () => {
      assert.fail('provider dispatch must not happen when reservation authority fails');
    },
  });
  assert.deepEqual(outcome, { status: 'reservation_unavailable', published: false, error_code: 'metering_authority_unavailable' });
  assert.doesNotMatch(JSON.stringify(outcome), /fixture-secret|authorization|headers|signedURL|private\.invalid/);
});

test('a denied reservation hides the authority reason and never dispatches', async () => {
  const authority = new FakeMeteringAuthority();
  authority.reserveAttempt = async () => ({ status: 'denied', reason: 'Bearer fixture-secret authorization headers signedURL private.invalid' });
  let providerCalls = 0;
  const outcome = await executeMeteredAttempt({
    port: authority,
    request: attempt(),
    trustedScope,
    dispatch: async () => { providerCalls += 1; return {}; },
  });
  assert.deepEqual(outcome, { status: 'reservation_denied', published: false, error_code: 'budget_unavailable' });
  assert.equal(providerCalls, 0);
  assert.doesNotMatch(JSON.stringify(outcome), /fixture-secret|authorization|headers|signedURL|private\.invalid/);
});

test('an operation failure with complete usage is still sent for authoritative settlement', async () => {
  const authority = new FakeMeteringAuthority();
  const request = attempt();
  const outcome = await executeMeteredAttempt({
    port: authority,
    request,
    trustedScope,
    dispatch: async ({ recordTransportAttempt }) => {
      await recordTransportAttempt('test:transport-failed-operation');
      return {
        provider_outcome: 'failed',
        usage_observation: observation(request, {
          source_observation_id: 'test:observation-failed-operation',
          transport_attempt_id: 'test:transport-failed-operation',
        }),
      };
    },
  });
  assert.equal(outcome.status, 'settled');
  assert.equal(outcome.provider_outcome, 'failed');
  assert.equal(authority.reservationFor(request.billable_attempt_id).consumed_cents, 3n);
});

test('missing owner agreement and unpinned references cannot pass the metering gate', () => {
  const absent = evaluateMeteringAgreementGate(undefined);
  assert.equal(absent.status, 'blocked');
  assert.equal(absent.acceptance_allowed, false);
  assert.deepEqual(absent.missing_owner_roles, ['Finance and reliability', 'Agent and research']);

  const statusOnly = evaluateMeteringAgreementGate({
    acceptances: [
      { owner_role: 'Finance and reliability', status: 'accepted', artifact_ref: 'issue:comment' },
      { owner_role: 'Agent and research', status: 'accepted', artifact_ref: 'issue:comment' },
    ],
    external_protocol_pin: true,
  });
  assert.equal(statusOnly.status, 'blocked');
  assert.equal(statusOnly.acceptance_allowed, false);
  assert.ok(statusOnly.missing_evidence.includes('external_protocol_pin'));
  assert.ok(statusOnly.missing_evidence.includes('Finance and reliability:pinned_artifact'));
});
