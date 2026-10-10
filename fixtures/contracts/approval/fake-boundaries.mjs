import { isDeepStrictEqual } from 'node:util';
import {
  ApprovalHandoffContractError,
  createConsumptionReceipt,
  verifyHandoffApproval,
} from '../../../src/contracts/approval-handoff.mjs';

/** TEST ONLY: no signing keys, customer approval system, renderer, or real access service. */
export class FakeApprovalVerifier {
  constructor({
    binding,
    approval_reference = 'test:approval-ref',
    approval_id = 'test:approval-1',
    audience = 'test:print-consumer',
    issued_at = '2026-10-10T14:00:00Z',
    expires_at = '2026-10-10T18:00:00Z',
    status = 'valid',
    revocation_status = 'active',
    key_id = 'test:key-v1',
    key_set_version = 'test:key-set-v1',
    throwOnVerify = false,
  }) {
    this.binding = structuredClone(binding);
    this.approval_reference = approval_reference;
    this.approval_id = approval_id;
    this.audience = audience;
    this.issued_at = issued_at;
    this.expires_at = expires_at;
    this.status = status;
    this.revocation_status = revocation_status;
    this.key_id = key_id;
    this.key_set_version = key_set_version;
    this.throwOnVerify = throwOnVerify;
    this.calls = [];
  }

  async verifyApproval(request) {
    this.calls.push(structuredClone(request));
    if (this.throwOnVerify) throw new Error('fixture verifier unavailable');
    if (this.status !== 'valid') return { status: this.status };
    if (request.approval_reference !== this.approval_reference) return { status: 'rejected' };
    if (request.expected_audience !== this.audience) return { status: 'rejected' };
    if (!isDeepStrictEqual(request.expected_binding, normalizeBinding(this.binding))) return { status: 'stale' };
    return {
      status: 'valid',
      verified_binding: structuredClone(this.binding),
      approval: {
        approval_reference: this.approval_reference,
        approval_id: this.approval_id,
        issuer_id: 'test:external-issuer',
        audience: this.audience,
        issued_at: this.issued_at,
        expires_at: this.expires_at,
        key_id: this.key_id,
        key_set_version: this.key_set_version,
        revocation: {
          status: this.revocation_status,
          checked_at: '2026-10-10T14:59:00Z',
          record_ref: 'test:revocation-check-1',
        },
      },
    };
  }
}

export class FakeArtifactAccess {
  constructor({ artifacts, denied = [] }) {
    this.artifacts = new Map(Object.entries(artifacts));
    this.denied = new Set(denied);
    this.grants = new Map();
    this.authorizeCalls = [];
  }

  async authorize({ tenant_id, project_id, artifact_id, sha256, access_policy_ref }) {
    const request = { tenant_id, project_id, artifact_id, sha256, access_policy_ref };
    this.authorizeCalls.push(request);
    if (this.denied.has(artifact_id)) return { status: 'denied', reason: 'fixture_access_denied' };
    const bytes = this.artifacts.get(artifact_id);
    if (!(bytes instanceof Uint8Array)) return { status: 'denied', reason: 'fixture_artifact_missing' };
    const grant_ref = `test:access-grant:${artifact_id}`;
    this.grants.set(grant_ref, { artifact_id, tenant_id, project_id, bytes });
    return { status: 'authorized', grant_ref };
  }

  async readAuthorized(grant_ref) {
    const grant = this.grants.get(grant_ref);
    if (!grant) return { status: 'denied', reason: 'fixture_unknown_grant' };
    return { status: 'bytes', artifact_id: grant.artifact_id, bytes: Uint8Array.from(grant.bytes) };
  }
}

export class FakeImagePort {
  constructor() {
    this.calls = 0;
  }

  async generate() {
    this.calls += 1;
    throw new Error('deterministic composition fixture must not call image generation');
  }
}

export class FakeCompositionConsumer {
  constructor() {
    this.acceptedPlans = [];
  }

  async acceptPlan(plan) {
    this.acceptedPlans.push(structuredClone(plan));
    return {
      status: 'accepted_for_external_rendering',
      plan_id: plan.plan_id,
      target_composition_revision_id: plan.target_composition_revision_id,
      approval_required_after_application: true,
    };
  }
}

/** TEST ONLY: forwards a typed plan to a fixture consumer and deliberately has no image call. */
export async function applyCompositionPlanTestDouble(plan, { compositionConsumer, imagePort }) {
  if (!compositionConsumer || typeof compositionConsumer.acceptPlan !== 'function') {
    throw new TypeError('compositionConsumer test double is required');
  }
  // Keep the spy in the test boundary so tests can detect any accidental invocation.
  if (imagePort && typeof imagePort.generate !== 'function') throw new TypeError('imagePort spy is malformed');
  return compositionConsumer.acceptPlan(plan);
}

/** TEST ONLY: models the external consumer's authorization, fetch, hash check, and receipt. */
export async function consumeHandoffTestDouble({
  approvalVerifier,
  handoff,
  trustedScope,
  accessPort,
  expected_audience = 'test:print-consumer',
  consumer_id = 'test:production-consumer',
  receipt_id = 'test:receipt-1',
  consumed_at = '2026-10-10T15:00:00Z',
  now = new Date('2026-10-10T15:00:00Z'),
}) {
  await verifyHandoffApproval({ approvalVerifier, handoff, expected_audience, trustedScope, now });
  const artifactRefs = new Map([[handoff.artifact.artifact_id, handoff.artifact]]);
  for (const layer of handoff.layer_manifest) {
    if (layer.kind === 'approved_asset') artifactRefs.set(layer.artifact.artifact_id, layer.artifact);
  }

  const bytesById = {};
  const accessGrants = [];
  for (const artifact of artifactRefs.values()) {
    const grant = await accessPort.authorize({
      tenant_id: trustedScope.tenant_id,
      project_id: trustedScope.project_id,
      artifact_id: artifact.artifact_id,
      sha256: artifact.sha256,
      access_policy_ref: artifact.access_policy_ref,
    });
    if (grant.status !== 'authorized') {
      throw new ApprovalHandoffContractError('artifact_access_denied', 'Consumer could not obtain authorized artifact access', {
        field: 'artifact_access',
      });
    }
    const received = await accessPort.readAuthorized(grant.grant_ref);
    if (received.status !== 'bytes' || received.artifact_id !== artifact.artifact_id) {
      throw new ApprovalHandoffContractError('artifact_access_denied', 'Consumer could not read the authorized artifact', {
        field: 'artifact_access',
      });
    }
    bytesById[artifact.artifact_id] = received.bytes;
    accessGrants.push({ artifact_id: artifact.artifact_id, grant_ref: grant.grant_ref });
  }

  return createConsumptionReceipt({
    handoff,
    artifactBytesById: bytesById,
    trustedScope,
    consumer_id,
    receipt_id,
    access_grants: accessGrants,
    consumed_at,
    now,
  });
}

function normalizeBinding(binding) {
  const assets = [...binding.assets].sort((left, right) => left.asset_id.localeCompare(right.asset_id));
  return { ...structuredClone(binding), assets };
}
