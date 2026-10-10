import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ApprovalHandoffContractError,
  createArtworkHandoff,
  createCompositionEditPlan,
  evaluateApprovalHandoffAgreementGate,
  hashCompositionLayerManifest,
  validateApprovalBinding,
  validateArtworkHandoff,
  validateConsumptionReceipt,
  verifyHandoffApproval,
  verifyHandoffArtifacts,
} from '../../../src/contracts/approval-handoff.mjs';
import {
  FakeArtifactAccess,
  FakeCompositionConsumer,
  FakeImagePort,
  applyCompositionPlanTestDouble,
  consumeHandoffTestDouble,
} from '../../../fixtures/contracts/approval/fake-boundaries.mjs';
import { createHandoff, now, scenario, trustedScope } from './helpers.mjs';

function codeIs(code) {
  return (error) => error instanceof ApprovalHandoffContractError && error.code === code;
}

function handoffArgs(setup, overrides = {}) {
  return {
    approvalVerifier: setup.verifier,
    approval_reference: 'test:approval-ref',
    expected_audience: 'test:print-consumer',
    binding: setup.binding,
    artifact: setup.artifact,
    layer_manifest: setup.layer_manifest,
    handoff_id: 'test:handoff-1',
    trustedScope: setup.trustedScope,
    trace_refs: ['test:trace-1'],
    usage_refs: ['test:usage-1'],
    now,
    ...overrides,
  };
}

function accessFor(setup, overrides = {}) {
  return new FakeArtifactAccess({
    artifacts: {
      [setup.artifact.artifact_id]: setup.artworkBytes,
      'test:logo-binary-1': setup.logoBytes,
    },
    ...overrides,
  });
}

test('handoff binds the external approval to trusted scope, exact composition, and consumer audience', async () => {
  const { handoff, verifier } = await createHandoff();
  assert.equal(handoff.binding.tenant_id, trustedScope.tenant_id);
  assert.equal(handoff.artifact.sha256, handoff.binding.design_version.artwork_sha256);
  assert.equal(handoff.artifact_access.bearer_url_included, false);
  assert.equal(handoff.approval.audience, 'test:print-consumer');
  assert.equal(handoff.binding.composition.sha256, hashCompositionLayerManifest({
    binding: handoff.binding,
    artifact: handoff.artifact,
    layer_manifest: handoff.layer_manifest,
    trustedScope,
  }));
  assert.equal(verifier.calls.length, 1);
  assert.equal(verifier.calls[0].expected_audience, 'test:print-consumer');
  assert.equal(verifier.calls[0].trusted_scope.tenant_id, trustedScope.tenant_id);
});

test('artwork, facts, approved assets, and composition edits make the earlier approval stale', async () => {
  const original = scenario();
  const newArtwork = scenario({ artworkBytes: Buffer.from('regenerated artwork bytes'), verifier: original.verifier });
  await assert.rejects(createArtworkHandoff(handoffArgs(newArtwork)), codeIs('approval_stale'));

  const factsChanged = scenario({ verifier: original.verifier });
  factsChanged.binding.facts.sha256 = 'e'.repeat(64);
  await assert.rejects(createArtworkHandoff(handoffArgs(factsChanged)), codeIs('approval_stale'));

  const assetChanged = scenario({ logoBytes: Buffer.from('new approved asset bytes'), verifier: original.verifier });
  await assert.rejects(createArtworkHandoff(handoffArgs(assetChanged)), codeIs('approval_stale'));

  const compositionChanged = scenario({ verifier: original.verifier });
  compositionChanged.binding.composition.revision_id = 'test:composition-rev-2';
  compositionChanged.layer_manifest.find((layer) => layer.kind === 'text').value = 'Jordan Avery';
  compositionChanged.binding.composition.sha256 = hashCompositionLayerManifest({
    binding: compositionChanged.binding,
    artifact: compositionChanged.artifact,
    layer_manifest: compositionChanged.layer_manifest,
    trustedScope,
  });
  await assert.rejects(createArtworkHandoff(handoffArgs(compositionChanged)), codeIs('approval_stale'));
});

test('forged, cross-tenant, wrong-audience, expired, revoked, and unavailable approvals fail closed', async () => {
  const base = scenario();
  const forged = {
    ...base,
    verifier: {
      async verifyApproval() {
        return { status: 'valid', approval: {}, verified_binding: { ...base.binding, actor_id: 'test:forged-actor' } };
      },
    },
  };
  await assert.rejects(createArtworkHandoff(handoffArgs(forged)), codeIs('approval_stale'));

  assert.throws(
    () => validateApprovalBinding(base.binding, { tenant_id: 'test:tenant-b', project_id: trustedScope.project_id }),
    codeIs('trusted_scope_mismatch'),
  );
  await assert.rejects(createArtworkHandoff(handoffArgs(base, { expected_audience: 'test:other-consumer' })), codeIs('approval_rejected'));

  const expired = scenario({ verifier: undefined });
  expired.verifier.expires_at = '2026-10-10T14:59:59Z';
  await assert.rejects(createArtworkHandoff(handoffArgs(expired)), codeIs('approval_expired'));

  const revoked = scenario();
  revoked.verifier.revocation_status = 'revoked';
  await assert.rejects(createArtworkHandoff(handoffArgs(revoked)), codeIs('approval_revoked'));

  const unavailable = scenario();
  unavailable.verifier.status = 'unavailable';
  await assert.rejects(createArtworkHandoff(handoffArgs(unavailable)), codeIs('verifier_unavailable'));

  const throwing = scenario();
  throwing.verifier.throwOnVerify = true;
  await assert.rejects(createArtworkHandoff(handoffArgs(throwing)), codeIs('verifier_unavailable'));
});

test('consumption rechecks current revocation and accepts a verifier-managed key rotation', async () => {
  const { handoff, verifier } = await createHandoff();
  verifier.key_id = 'test:key-v2';
  verifier.key_set_version = 'test:key-set-v2';
  const rotated = await verifyHandoffApproval({
    approvalVerifier: verifier,
    handoff,
    expected_audience: 'test:print-consumer',
    trustedScope,
    now,
  });
  assert.equal(rotated.key_set_version, 'test:key-set-v2');

  verifier.revocation_status = 'revoked';
  await assert.rejects(verifyHandoffApproval({
    approvalVerifier: verifier,
    handoff,
    expected_audience: 'test:print-consumer',
    trustedScope,
    now,
  }), codeIs('approval_revoked'));

  verifier.revocation_status = 'unavailable';
  await assert.rejects(verifyHandoffApproval({
    approvalVerifier: verifier,
    handoff,
    expected_audience: 'test:print-consumer',
    trustedScope,
    now,
  }), codeIs('revocation_unavailable'));
});

test('consumer receipt proves hashes of the exact bytes for every required binary artifact', async () => {
  const setup = await createHandoff();
  const receipt = await consumeHandoffTestDouble({
    approvalVerifier: setup.verifier,
    handoff: setup.handoff,
    trustedScope,
    accessPort: accessFor(setup),
    now,
  });
  assert.equal(receipt.status, 'consumed_exact_bytes');
  assert.equal(receipt.consumed_artifacts.length, 2);
  assert.deepEqual(receipt.verified_layer_ids, ['test:art-layer', 'test:logo-layer', 'test:name-layer']);
  assert.equal(receipt.access_grants.length, 2);
  for (const field of ['binding_sha256', 'composition_sha256', 'layer_manifest_sha256', 'approval_proof_sha256']) {
    assert.match(receipt[field], /^[a-f0-9]{64}$/);
  }
  assert.equal(receipt.consumed_artifacts.find((item) => item.artifact_id === 'test:artwork-1').sha256, setup.handoff.artifact.sha256);
  assert.deepEqual(validateConsumptionReceipt(receipt, setup.handoff, { trustedScope, now }), receipt);

  for (const field of ['binding_sha256', 'composition_sha256', 'layer_manifest_sha256', 'approval_proof_sha256']) {
    const tamperedContext = structuredClone(receipt);
    tamperedContext[field] = '0'.repeat(64);
    assert.throws(
      () => validateConsumptionReceipt(tamperedContext, setup.handoff, { trustedScope, now }),
      codeIs('receipt_context_mismatch'),
      `${field} must bind the receipt to the approved handoff context`,
    );
  }

  const wrongBytes = accessFor(setup);
  wrongBytes.artifacts.set('test:artwork-1', Buffer.from('different artwork bytes'));
  await assert.rejects(consumeHandoffTestDouble({
    approvalVerifier: setup.verifier,
    handoff: setup.handoff,
    trustedScope,
    accessPort: wrongBytes,
    now,
  }), codeIs('artifact_hash_mismatch'));

  const missingAsset = accessFor(setup);
  missingAsset.artifacts.delete('test:logo-binary-1');
  await assert.rejects(consumeHandoffTestDouble({
    approvalVerifier: setup.verifier,
    handoff: setup.handoff,
    trustedScope,
    accessPort: missingAsset,
    now,
  }), codeIs('artifact_access_denied'));

  const tamperedReceipt = structuredClone(receipt);
  tamperedReceipt.consumed_artifacts[0].sha256 = '0'.repeat(64);
  assert.throws(
    () => validateConsumptionReceipt(tamperedReceipt, setup.handoff, { trustedScope, now }),
    codeIs('receipt_artifact_mismatch'),
  );
});

test('binary artifact IDs are unique across artwork and approved asset layers', async () => {
  const setup = await createHandoff();
  const collision = structuredClone(setup.handoff);
  const logoLayer = collision.layer_manifest.find((layer) => layer.kind === 'approved_asset');
  logoLayer.artifact.artifact_id = collision.artifact.artifact_id;

  assert.throws(() => validateArtworkHandoff(collision, trustedScope, { now }), codeIs('duplicate_artifact_id'));
  await assert.rejects(consumeHandoffTestDouble({
    approvalVerifier: setup.verifier,
    handoff: collision,
    trustedScope,
    accessPort: accessFor(setup),
    now,
  }), codeIs('duplicate_artifact_id'));
});

test('receipt from an earlier manifest is stale after text changes and composition is rehashed', async () => {
  const setup = await createHandoff();
  const receipt = await consumeHandoffTestDouble({
    approvalVerifier: setup.verifier,
    handoff: setup.handoff,
    trustedScope,
    accessPort: accessFor(setup),
    now,
  });
  const changed = structuredClone(setup.handoff);
  changed.layer_manifest.find((layer) => layer.kind === 'text').value = 'Taylor Avery';
  changed.binding.composition.sha256 = hashCompositionLayerManifest({
    binding: changed.binding,
    artifact: changed.artifact,
    layer_manifest: changed.layer_manifest,
    trustedScope,
  });

  assert.throws(
    () => validateConsumptionReceipt(receipt, changed, { trustedScope, now }),
    codeIs('receipt_context_mismatch'),
  );
});

test('missing layers and denied artifact access are explicit failures', async () => {
  const setup = await createHandoff();
  const missingAssetLayer = structuredClone(setup.handoff);
  missingAssetLayer.layer_manifest = missingAssetLayer.layer_manifest.filter((layer) => layer.kind !== 'approved_asset');
  assert.throws(() => validateArtworkHandoff(missingAssetLayer, trustedScope, { now }), codeIs('missing_asset_layer'));

  const missingArtworkLayer = structuredClone(setup.handoff);
  missingArtworkLayer.layer_manifest = missingArtworkLayer.layer_manifest.filter((layer) => layer.kind !== 'artwork');
  assert.throws(() => validateArtworkHandoff(missingArtworkLayer, trustedScope, { now }), codeIs('artwork_layer_count'));

  const deniedAccess = accessFor(setup, { denied: ['test:artwork-1'] });
  await assert.rejects(consumeHandoffTestDouble({
    approvalVerifier: setup.verifier,
    handoff: setup.handoff,
    trustedScope,
    accessPort: deniedAccess,
    now,
  }), codeIs('artifact_access_denied'));

  const bearerUrlAttempt = structuredClone(setup.handoff);
  bearerUrlAttempt.artifact_access.signed_url = 'https://private.invalid/file?signature=secret';
  assert.throws(() => validateArtworkHandoff(bearerUrlAttempt, trustedScope, { now }), codeIs('unknown_field'));

  const unsupported = structuredClone(setup.handoff);
  unsupported.schema_version = 'creative.approval-handoff.proposal/v999';
  assert.throws(() => validateArtworkHandoff(unsupported, trustedScope, { now }), codeIs('unsupported_version'));
});

test('typed composition edits preserve exact text, layout, and logo permission without image generation', async () => {
  const setup = await createHandoff();
  const plan = createCompositionEditPlan({
    plan_id: 'test:plan-1',
    binding: setup.handoff.binding,
    layer_manifest: setup.handoff.layer_manifest,
    target_composition_revision_id: 'test:composition-rev-2',
    trustedScope,
    operations: [
      { operation_id: 'test:op-name', kind: 'set_text', layer_id: 'test:name-layer', value: 'Jordan Avery' },
      { operation_id: 'test:op-size', kind: 'set_text_size', layer_id: 'test:name-layer', size: { value: '18', unit: 'pt' } },
      { operation_id: 'test:op-layout', kind: 'set_layer_layout', layer_id: 'test:art-layer', layout: { x_milli: 10, y_milli: 20, width_milli: 980, height_milli: 960 } },
      { operation_id: 'test:op-logo', kind: 'position_approved_logo', layer_id: 'test:logo-layer', asset_id: 'test:logo-1', layout: { x_milli: 750, y_milli: 50, width_milli: 200, height_milli: 100 } },
    ],
  });
  const compositionConsumer = new FakeCompositionConsumer();
  const imagePort = new FakeImagePort();
  const accepted = await applyCompositionPlanTestDouble(plan, { compositionConsumer, imagePort });
  assert.equal(accepted.status, 'accepted_for_external_rendering');
  assert.equal(plan.approval_required_after_application, true);
  assert.equal(plan.target_composition_revision_id, 'test:composition-rev-2');
  assert.equal(plan.operations[0].value, 'Jordan Avery');
  assert.equal(plan.operations[1].size.value, '18');
  assert.equal(plan.operations[2].layout.width_milli, 980);
  assert.equal(plan.operations[3].asset_id, 'test:logo-1');
  assert.equal(plan.operations[3].layout.width_milli, 200);
  assert.equal(imagePort.calls, 0);
  assert.equal('production_bundle' in plan, false);

  assert.throws(() => createCompositionEditPlan({
    plan_id: 'test:bad-plan',
    binding: setup.handoff.binding,
    layer_manifest: setup.handoff.layer_manifest,
    target_composition_revision_id: 'test:composition-rev-3',
    trustedScope,
    operations: [{ operation_id: 'test:bad-logo', kind: 'position_approved_logo', layer_id: 'test:logo-layer', asset_id: 'test:unapproved-logo', layout: { x_milli: 0, y_milli: 0 } }],
  }), codeIs('logo_permission_mismatch'));
});

test('agreement gate never accepts owner status strings or local fixtures', () => {
  const absent = evaluateApprovalHandoffAgreementGate(undefined);
  assert.equal(absent.status, 'blocked');
  assert.equal(absent.acceptance_allowed, false);
  assert.deepEqual(absent.missing_owner_roles, ['Product and frontend', 'Creative and fulfillment', 'Agent and research']);

  const statusOnly = evaluateApprovalHandoffAgreementGate({
    acceptances: [
      { owner_role: 'Product and frontend', status: 'accepted', artifact_ref: 'issue:comment' },
      { owner_role: 'Creative and fulfillment', status: 'accepted', artifact_ref: 'issue:comment' },
      { owner_role: 'Agent and research', status: 'accepted', artifact_ref: 'issue:comment' },
    ],
    external_protocol_pin: true,
  });
  assert.equal(statusOnly.status, 'blocked');
  assert.equal(statusOnly.acceptance_allowed, false);
  assert.ok(statusOnly.missing_evidence.includes('external_protocol_pin'));
  assert.ok(statusOnly.missing_evidence.includes('Creative and fulfillment:pinned_artifact'));

  const pinnedButUnverified = evaluateApprovalHandoffAgreementGate({
    acceptances: ['Product and frontend', 'Creative and fulfillment', 'Agent and research'].map((owner_role) => ({
      owner_role,
      status: 'accepted',
      artifact_ref: 'test:evidence-ref',
      artifact_sha256: 'a'.repeat(64),
      pinned_revision: 'test:revision',
      independent_review_ref: 'test:review-ref',
    })),
    external_protocol_pin: { artifact_ref: 'test:protocol-ref', revision: 'test:protocol-revision', sha256: 'b'.repeat(64) },
  });
  assert.equal(pinnedButUnverified.status, 'owner_review_required');
  assert.equal(pinnedButUnverified.acceptance_allowed, false);
  assert.equal(pinnedButUnverified.independent_owner_verification_required, true);
});
