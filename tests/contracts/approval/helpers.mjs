import { createHash } from 'node:crypto';
import { createArtworkHandoff, hashCompositionLayerManifest } from '../../../src/contracts/approval-handoff.mjs';
import { FakeApprovalVerifier } from '../../../fixtures/contracts/approval/fake-boundaries.mjs';

export const trustedScope = {
  tenant_id: 'test:tenant-a',
  project_id: 'test:project-a',
};

export const now = new Date('2026-10-10T15:00:00Z');
export const artworkBytes = Buffer.from('test-only artwork bytes v1');
export const logoBytes = Buffer.from('test-only approved logo bytes');
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function scenario(overrides = {}) {
  const artBytes = overrides.artworkBytes ?? artworkBytes;
  const brandBytes = overrides.logoBytes ?? logoBytes;
  const binding = {
    tenant_id: trustedScope.tenant_id,
    project_id: trustedScope.project_id,
    design_version: {
      design_version_id: 'test:design-v1',
      artwork_sha256: sha256(artBytes),
    },
    brief: { brief_id: 'test:brief-v1', sha256: 'a'.repeat(64) },
    facts: { revision_id: 'test:facts-v1', sha256: 'b'.repeat(64) },
    assets: [{
      asset_id: 'test:logo-1',
      sha256: sha256(brandBytes),
      permission_ref: 'test:permission-logo-1',
      intended_use: 'logo',
    }],
    composition: { composition_id: 'test:composition-1', revision_id: 'test:composition-rev-1', sha256: 'c'.repeat(64) },
    preview_sha256: 'd'.repeat(64),
  };
  const artifact = {
    artifact_id: overrides.artifact_id ?? 'test:artwork-1',
    locator_ref: 'test:object-locator:artwork-1',
    sha256: sha256(artBytes),
    mime_type: 'image/png',
    width_px: 1024,
    height_px: 1024,
    access_policy_ref: 'test:access-policy-artwork',
  };
  const logoArtifact = {
    artifact_id: 'test:logo-binary-1',
    locator_ref: 'test:object-locator:logo-1',
    sha256: sha256(brandBytes),
    mime_type: 'image/png',
    width_px: 256,
    height_px: 64,
    access_policy_ref: 'test:access-policy-logo',
  };
  const layer_manifest = [
    { layer_id: 'test:art-layer', kind: 'artwork', artifact_id: artifact.artifact_id, sha256: artifact.sha256 },
    { layer_id: 'test:name-layer', kind: 'text', role: 'name', value: 'Jordan' },
    {
      layer_id: 'test:logo-layer',
      kind: 'approved_asset',
      asset_id: 'test:logo-1',
      asset_sha256: binding.assets[0].sha256,
      permission_ref: binding.assets[0].permission_ref,
      artifact: logoArtifact,
    },
  ];
  binding.composition.sha256 = hashCompositionLayerManifest({ binding, artifact, layer_manifest, trustedScope });
  const verifier = overrides.verifier ?? new FakeApprovalVerifier({ binding });
  return {
    trustedScope,
    binding,
    artifact,
    layer_manifest,
    verifier,
    artworkBytes: artBytes,
    logoBytes: brandBytes,
  };
}

export async function createHandoff(options = {}) {
  const setup = scenario(options);
  const handoff = await createArtworkHandoff({
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
    now: options.now ?? now,
  });
  return { ...setup, handoff };
}
