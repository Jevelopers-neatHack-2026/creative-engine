import { createHash } from 'node:crypto';
import { canonicalHash } from '../../src/contracts/validation.mjs';
import { METERING_PROPOSAL_VERSION } from '../../src/contracts/metering.mjs';
import { FakeMeteringAuthority } from '../contracts/metering/fake-authority.mjs';
import { ACCESS_CELL_DEFINITIONS, ACCESS_PREFLIGHT_VERSION } from '../../src/preflight/access.mjs';

const hex = (value) => createHash('sha256').update(value).digest('hex');
const digest = (value) => `sha256:${hex(value)}`;

export function fixtureTime() {
  return new Date().toISOString();
}

function futureIso(milliseconds) {
  return new Date(Date.now() + milliseconds).toISOString();
}

export const fixtureScope = Object.freeze({
  tenant_id: 'test:tenant-a',
  project_id: 'test:project-a',
  budget_scope_id: 'test:budget-a',
  account_ref: 'org_test_fixture',
  project_ref: 'proj_test_fixture',
});

function configurationFor(cellId) {
  return {
    prompt_template_ref: `test:${cellId}:prompt-v1`,
    prompt_template_sha256: digest(`test prompt for ${cellId}`),
    n: 1,
    size: '1024x1024',
    quality: 'medium',
    output_format: 'png',
    background: 'opaque',
    moderation: 'auto',
    ...(cellId === 'image_edit' ? {
      asset_ref: 'test:asset-source-v1',
      asset_sha256: digest('test source image bytes'),
      asset_mime: 'image/png',
    } : {}),
  };
}

function accessTarget(cellId) {
  const configuration = configurationFor(cellId);
  return {
    service: 'openai',
    endpoint: cellId === 'image_edit' ? 'https://api.openai.com/v1/images/edits' : 'https://api.openai.com/v1/images/generations',
    model: 'gpt-image-2.5-sunburst-2026-09-08',
    sdk: { name: 'native-fetch', version: process.versions.node },
    configuration,
    configuration_sha256: canonicalHash(configuration),
  };
}

export function accessPlan({ cellId = 'image_generation', runId = 'test:access-run-1' } = {}) {
  if (!['image_generation', 'image_edit'].includes(cellId)) {
    throw new TypeError('The preflight fixture defines only the two Images cells; other provider targets remain external.');
  }
  const deadlineAt = futureIso(15 * 60_000);
  return {
    schema_version: ACCESS_PREFLIGHT_VERSION,
    run_id: runId,
    created_at: fixtureTime(),
    cells: ACCESS_CELL_DEFINITIONS.map((definition) => {
      const selected = definition.cell_id === cellId;
      return {
        cell_id: definition.cell_id,
        owner_role: definition.owner_role,
        selection: { state: selected ? 'owner_selected' : 'unresolved' },
        scope: fixtureScope,
        target: selected ? accessTarget(cellId) : null,
        spend: definition.billable === true ? {
          maximum_amount: '0.08',
          currency: 'USD',
          deadline_at: deadlineAt,
          stop_conditions: [
            'one_billable_attempt',
            'one_transport_attempt',
            'stop_on_quota_or_rate_limit',
            'stop_on_authentication_or_permission_error',
            'stop_on_deadline',
            'stop_on_unknown_outcome',
          ],
        } : null,
      };
    }),
  };
}

function pinnedEvidence(name) {
  return {
    ref: `test:evidence:${name}`,
    sha256: digest(`evidence:${name}`),
    pinned_revision: `test:revision:${name}`,
    independent_review: {
      ref: `test:review:${name}`,
      sha256: digest(`review:${name}`),
    },
  };
}

function usageObservation(attempt) {
  return {
    schema_version: METERING_PROPOSAL_VERSION,
    tenant_id: attempt.tenant_id,
    project_id: attempt.project_id,
    budget_scope_id: attempt.budget_scope_id,
    logical_operation_id: attempt.logical_operation_id,
    billable_attempt_id: attempt.billable_attempt_id,
    source_observation_id: 'test:source-observation-1',
    source: 'provider_response',
    provider_name: attempt.provider.name,
    model: attempt.provider.model,
    provider_request_id: 'test:provider-request-1',
    transport_attempt_id: 'test:transport-1',
    environment: attempt.environment,
    billing_mode: attempt.billing_mode,
    completeness: 'complete',
    usage_units: [{ name: 'total_tokens', quantity: '1', relation: 'standalone' }],
    missing_fields: [],
  };
}

function reservationBinding(reservation, attempt, expected, grantRef) {
  return {
    reservation_id: reservation.reservation_id,
    lease_id: reservation.lease_id,
    grant_ref: grantRef,
    authorization_evidence_sha256: pinnedEvidence('exact-grant').sha256,
    billable_attempt_id: attempt.billable_attempt_id,
    logical_operation_id: attempt.logical_operation_id,
    tenant_id: attempt.tenant_id,
    project_id: attempt.project_id,
    budget_scope_id: attempt.budget_scope_id,
    account_ref: expected.account_ref,
    project_ref: expected.project_ref,
    service: expected.service,
    endpoint: expected.endpoint,
    model: expected.model,
    sdk_name: expected.sdk_name,
    sdk_version: expected.sdk_version,
    operation_kind: expected.operation_kind,
    configuration_sha256: expected.configuration_sha256,
    maximum_amount: expected.maximum_amount,
    currency: expected.currency,
  };
}

export function createMockAccessFixture({
  cellId = 'image_generation',
  runId = 'test:access-run-1',
  now = fixtureTime(),
  pinDecision,
  capabilityDecision,
  capabilityRevalidation,
  accessObservation,
  grantDecision,
  revalidation,
  reservationDecision,
  adapterDispatch,
  releaseFailure = false,
  holdAmount = '0.08',
} = {}) {
  const plan = accessPlan({ cellId, runId });
  const cell = plan.cells.find((candidate) => candidate.cell_id === cellId);
  const target = cell.target;
  const definition = ACCESS_CELL_DEFINITIONS.find((row) => row.cell_id === cellId);
  const calls = { inspect: 0, prepare: 0, dispatch: 0, verifyCapability: 0, revalidateCapability: 0, verifyGrant: 0, revalidateGrant: 0, reserve: 0, release: 0, settle: 0 };
  const capabilityInputs = [];
  const meteringRequest = {
    schema_version: METERING_PROPOSAL_VERSION,
    tenant_id: fixtureScope.tenant_id,
    project_id: fixtureScope.project_id,
    budget_scope_id: fixtureScope.budget_scope_id,
    logical_operation_id: 'test:logical-operation-1',
    billable_attempt_id: 'test:billable-attempt-1',
    retry_mapping_ref: 'test:retry-map-v1',
    environment: 'test',
    billing_mode: 'live',
    operation_kind: definition.operation_kind,
    budget: { scope_id: fixtureScope.budget_scope_id, policy_version: 'test:policy-v1' },
    provider: {
      name: target.service,
      endpoint: target.endpoint,
      model: target.model,
      sdk: { ...target.sdk },
    },
  };
  const authority = new FakeMeteringAuthority({
    budget: '1.00',
    defaultHold: holdAmount,
    defaultConsumed: '0.03',
  });
  authority.evidence_mode = 'mock';
  const rawReserve = authority.reserveAttempt.bind(authority);
  authority.reserveAttempt = async (...values) => { calls.reserve += 1; return rawReserve(...values); };
  const rawRelease = authority.releaseBeforeDispatch.bind(authority);
  authority.releaseBeforeDispatch = async (...values) => {
    calls.release += 1;
    if (releaseFailure) throw new Error('fixture release did not confirm');
    return rawRelease(...values);
  };
  const rawSettle = authority.settleReservation.bind(authority);
  authority.settleReservation = async (...values) => { calls.settle += 1; return rawSettle(...values); };

  const pinVerifier = {
    evidence_mode: 'mock',
    async verifyPin(input) {
      return pinDecision ?? {
        decision: 'accepted',
        evidence_mode: 'mock',
        cell_id: input.cell_id,
        owner_role: input.owner_role,
        configuration_sha256: target.configuration_sha256,
        target_binding: {
          service: target.service,
          endpoint: target.endpoint,
          model: target.model,
          sdk_name: target.sdk.name,
          sdk_version: target.sdk.version,
          configuration_sha256: target.configuration_sha256,
          account_ref: fixtureScope.account_ref,
          project_ref: fixtureScope.project_ref,
        },
        evidence: pinnedEvidence('configuration-pin'),
        owner_evidence: { ...pinnedEvidence('cell-owner'), owner_role: definition.owner_role },
        protocol: pinnedEvidence('pin-verifier-protocol'),
        checked_at: now,
      };
    },
  };
  const defaultAccessObservation = {
    evidence_mode: 'mock',
    target: {
      service: target.service,
      endpoint: target.endpoint,
      model: target.model,
      sdk_name: target.sdk.name,
      sdk_version: target.sdk.version,
      configuration_sha256: target.configuration_sha256,
      account_ref: fixtureScope.account_ref,
      project_ref: fixtureScope.project_ref,
    },
    authentication: 'confirmed',
    model_listing: 'listed',
    operation_permission: 'confirmed',
    quota: 'available',
    checked_at: now,
    evidence: { ref: 'test:evidence:access-observation', sha256: digest('access-observation') },
  };
  const adapter = {
    evidence_mode: 'mock',
    async inspect() { calls.inspect += 1; return accessObservation ?? defaultAccessObservation; },
    async prepare() { calls.prepare += 1; return { prepared: true }; },
    async dispatch(input) {
      calls.dispatch += 1;
      if (adapterDispatch) return adapterDispatch(input, { calls, authority });
      await input.metering.recordTransportAttempt('test:transport-1');
      await input.metering.authorizeTransport();
      input.metering.assertTransportReady();
      const attempt = input.metering.attempt;
      return {
        evidence_mode: 'mock',
        provider_outcome: 'succeeded',
        usage_observation: usageObservation(attempt),
        evidence: {
          completed_at: now,
          service: target.service,
          endpoint: target.endpoint,
          model: target.model,
          sdk_name: target.sdk.name,
          sdk_version: target.sdk.version,
          configuration_sha256: target.configuration_sha256,
        },
      };
    },
  };
  const capabilityVerifier = {
    evidence_mode: 'mock',
    async verifyCapability(input) {
      calls.verifyCapability += 1;
      capabilityInputs.push(input);
      if (capabilityDecision) return capabilityDecision(input);
      return buildCapabilityDecision(input);
    },
    async revalidateCapability(input) {
      calls.revalidateCapability += 1;
      capabilityInputs.push(input);
      if (capabilityRevalidation) return capabilityRevalidation(input);
      return buildCapabilityDecision(input);
    },
  };
  const grantRef = 'test:grant-1';
  const authorizationPort = {
    evidence_mode: 'mock',
    async verifyGrant({ expected }) {
      calls.verifyGrant += 1;
      if (grantDecision) return grantDecision(expected);
      return buildGrantDecision(expected, grantRef, now);
    },
    async revalidateGrant({ expected, at }) {
      calls.revalidateGrant += 1;
      if (revalidation) return revalidation({ expected, at, grantRef });
      return buildGrantDecision(expected, grantRef, at);
    },
  };
  const reservationVerifier = {
    evidence_mode: 'mock',
    async verifyReservation({ reservation, attempt, expected, grant_ref, at }) {
      const decision = {
        decision: 'confirmed',
        evidence_mode: 'mock',
        binding: reservationBinding(reservation, attempt, expected, grant_ref),
        evidence: pinnedEvidence('finance-reservation-verification'),
        protocol: pinnedEvidence('finance-reservation-protocol'),
        checked_at: at,
        lease_active: true,
        lease_expires_at: futureIso(30 * 60_000),
        finance_owner: {
          owner_role: 'Finance and reliability',
          evidence: pinnedEvidence('finance-reservation-owner'),
        },
        enforcement: {
          atomic_one_use: true,
          aggregate_cap_enforced: true,
          lease_bound: true,
          full_target_bound: true,
        },
      };
      return reservationDecision ? reservationDecision({ decision, reservation, attempt, expected, grant_ref }) : decision;
    },
  };
  const args = {
    plan,
    mode: 'mock',
    now,
    runId,
    cell,
    trustedScope: fixtureScope,
    adapter,
    pinVerifier,
    capabilityVerifier,
    authorizationPort,
    reservationVerifier,
    meteringPort: authority,
    meteringRequest,
    grantRef,
  };
  return { args, plan, cell, target, meteringRequest, authority, calls, capabilityInputs, adapter, pinVerifier, capabilityVerifier, authorizationPort, reservationVerifier };
}

function buildCapabilityDecision(input) {
  return {
    decision: 'confirmed',
    evidence_mode: 'mock',
    cell_id: input.cell_id,
    owner_role: input.owner_role,
    operation_kind: input.operation_kind,
    target_binding: input.target_binding,
    scope: input.scope,
    deadline_at: input.deadline_at,
    operation_permission: 'confirmed',
    quota: 'available',
    checked_at: input.at,
    expires_at: new Date(Date.parse(input.deadline_at) + 1_000).toISOString(),
    evidence: pinnedEvidence('exact-provider-capability'),
    owner_evidence: { ...pinnedEvidence('provider-operation-owner'), owner_role: input.owner_role },
    protocol: pinnedEvidence('provider-capability-protocol'),
  };
}

function buildGrantDecision(expected, grantRef, checkedAt) {
  const grant = { ...expected };
  delete grant.now;
  grant.expires_at = new Date(Date.parse(expected.deadline_at) - 1_000).toISOString();
  grant.revoked = false;
  grant.max_billable_attempts = 1;
  grant.max_transport_attempts = 1;
  return {
    decision: 'authorized',
    evidence_mode: 'mock',
    grant_ref: grantRef,
    grant,
    evidence: pinnedEvidence('exact-grant'),
    protocol: pinnedEvidence('authorization-protocol'),
    owner_evidence: {
      account_owner_role: 'Creative and fulfillment',
      account_owner: pinnedEvidence('provider-account-owner'),
      finance_owner_role: 'Finance and reliability',
      finance_owner: pinnedEvidence('finance-owner'),
    },
    checked_at: checkedAt,
  };
}
