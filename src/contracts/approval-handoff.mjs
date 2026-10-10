import { createHash } from 'node:crypto';

export const APPROVAL_HANDOFF_PROPOSAL_VERSION = 'creative.approval-handoff.proposal/v1';
export const COMPOSITION_EDIT_PROPOSAL_VERSION = 'creative.composition-edit.proposal/v1';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/;
const MIME = /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/;

export class ApprovalHandoffContractError extends Error {
  constructor(code, message, { field, retryable = false } = {}) {
    super(message);
    this.name = 'ApprovalHandoffContractError';
    this.code = code;
    this.retryable = retryable;
    if (field !== undefined) this.field = field;
  }
}

function fail(code, message, field, retryable = false) {
  throw new ApprovalHandoffContractError(code, message, { field, retryable });
}

function record(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_object', `${field} must be an object`, field);
  }
  return value;
}

function assertAllowedKeys(value, allowed, field) {
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected !== undefined) fail('unknown_field', `${field} contains an unsupported field`, `${field}.${unexpected}`);
}

function id(value, field) {
  if (typeof value !== 'string' || !ID.test(value)) {
    fail('invalid_identifier', `${field} must be a non-empty opaque identifier`, field);
  }
  return value;
}

function hash(value, field) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    fail('invalid_sha256', `${field} must be a lowercase SHA-256 digest`, field);
  }
  return value;
}

function assertScope(value, trustedScope) {
  const scope = record(trustedScope, 'trustedScope');
  for (const field of ['tenant_id', 'project_id']) {
    id(scope[field], `trustedScope.${field}`);
    if (value[field] !== scope[field]) {
      fail('trusted_scope_mismatch', `${field} does not match authenticated scope`, field);
    }
  }
}

function nonemptyText(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 4096) {
    fail('invalid_text', `${field} must be non-empty bounded text`, field);
  }
  return value;
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) fail('invalid_dimension', `${field} must be a positive integer`, field);
  return value;
}

function normalizedAssets(assets) {
  if (!Array.isArray(assets)) fail('invalid_assets', 'assets must be an array', 'assets');
  const seen = new Set();
  const normalized = assets.map((raw, index) => {
    const asset = record(raw, `assets[${index}]`);
    assertAllowedKeys(asset, new Set(['asset_id', 'sha256', 'permission_ref', 'intended_use']), `assets[${index}]`);
    const assetId = id(asset.asset_id, `assets[${index}].asset_id`);
    if (seen.has(assetId)) fail('duplicate_asset', 'asset_id values must be unique', `assets[${index}].asset_id`);
    seen.add(assetId);
    return {
      asset_id: assetId,
      sha256: hash(asset.sha256, `assets[${index}].sha256`),
      permission_ref: id(asset.permission_ref, `assets[${index}].permission_ref`),
      intended_use: id(asset.intended_use, `assets[${index}].intended_use`),
    };
  });
  return normalized.sort((left, right) => left.asset_id.localeCompare(right.asset_id));
}

/** Normalize and validate an approval binding against trusted server scope. */
export function validateApprovalBinding(value, trustedScope) {
  const binding = record(value, 'binding');
  assertAllowedKeys(binding, new Set(['tenant_id', 'project_id', 'design_version', 'brief', 'facts', 'assets', 'composition', 'preview_sha256', 'action_id', 'actor_id']), 'binding');
  assertScope(binding, trustedScope);
  const design = record(binding.design_version, 'design_version');
  const brief = record(binding.brief, 'brief');
  const facts = record(binding.facts, 'facts');
  const composition = record(binding.composition, 'composition');
  assertAllowedKeys(design, new Set(['design_version_id', 'artwork_sha256']), 'design_version');
  assertAllowedKeys(brief, new Set(['brief_id', 'sha256']), 'brief');
  assertAllowedKeys(facts, new Set(['revision_id', 'sha256']), 'facts');
  assertAllowedKeys(composition, new Set(['composition_id', 'revision_id', 'sha256']), 'composition');
  const normalized = {
    tenant_id: id(binding.tenant_id, 'tenant_id'),
    project_id: id(binding.project_id, 'project_id'),
    design_version: {
      design_version_id: id(design.design_version_id, 'design_version.design_version_id'),
      artwork_sha256: hash(design.artwork_sha256, 'design_version.artwork_sha256'),
    },
    brief: {
      brief_id: id(brief.brief_id, 'brief.brief_id'),
      sha256: hash(brief.sha256, 'brief.sha256'),
    },
    facts: {
      revision_id: id(facts.revision_id, 'facts.revision_id'),
      sha256: hash(facts.sha256, 'facts.sha256'),
    },
    assets: normalizedAssets(binding.assets),
    composition: {
      composition_id: id(composition.composition_id, 'composition.composition_id'),
      revision_id: id(composition.revision_id, 'composition.revision_id'),
      sha256: hash(composition.sha256, 'composition.sha256'),
    },
    preview_sha256: hash(binding.preview_sha256, 'preview_sha256'),
  };
  if (binding.action_id !== undefined) normalized.action_id = id(binding.action_id, 'action_id');
  if (binding.actor_id !== undefined) normalized.actor_id = id(binding.actor_id, 'actor_id');
  return normalized;
}

function canonicalBinding(binding) {
  return JSON.stringify(binding);
}

function validateApprovalProof(value, { expectedAudience, binding, now }) {
  const verification = record(value, 'approval_verification');
  switch (verification.status) {
    case 'valid':
      break;
    case 'expired':
      fail('approval_expired', 'External approval has expired', 'approval.status');
      break;
    case 'revoked':
      fail('approval_revoked', 'External approval has been revoked', 'approval.status');
      break;
    case 'stale':
      fail('approval_stale', 'External approval is bound to a different design or composition', 'approval.status');
      break;
    case 'unavailable':
      fail('verifier_unavailable', 'Approval verifier or revocation service is unavailable; handoff is blocked', 'approval.status', true);
      break;
    case 'rejected':
    default:
      fail('approval_rejected', 'External approval was rejected; handoff is blocked', 'approval.status');
  }

  const proof = record(verification.approval, 'approval');
  if (verification.verified_binding === undefined || canonicalBinding(
    validateApprovalBinding(verification.verified_binding, { tenant_id: binding.tenant_id, project_id: binding.project_id }),
  ) !== canonicalBinding(binding)) {
    fail('approval_stale', 'Verified approval binding does not match current design context', 'verified_binding');
  }
  const audience = id(proof.audience, 'approval.audience');
  if (audience !== expectedAudience) fail('approval_audience_mismatch', 'Approval is addressed to a different consumer', 'approval.audience');
  const issuedAt = validTimestamp(proof.issued_at, 'approval.issued_at');
  const expiresAt = validTimestamp(proof.expires_at, 'approval.expires_at');
  if (Date.parse(expiresAt) <= now.getTime()) fail('approval_expired', 'External approval has expired', 'approval.expires_at');
  if (Date.parse(issuedAt) > now.getTime()) fail('approval_not_yet_valid', 'External approval is not yet valid', 'approval.issued_at');
  const revocation = record(proof.revocation, 'approval.revocation');
  if (revocation.status !== 'active') {
    if (revocation.status === 'unavailable') fail('revocation_unavailable', 'Revocation status is unavailable; handoff is blocked', 'approval.revocation', true);
    fail('approval_revoked', 'External approval is not active', 'approval.revocation.status');
  }
  return {
    approval_reference: id(proof.approval_reference, 'approval.approval_reference'),
    approval_id: id(proof.approval_id, 'approval.approval_id'),
    issuer_id: id(proof.issuer_id, 'approval.issuer_id'),
    audience,
    issued_at: issuedAt,
    expires_at: expiresAt,
    key_id: id(proof.key_id, 'approval.key_id'),
    key_set_version: id(proof.key_set_version, 'approval.key_set_version'),
    revocation: {
      status: 'active',
      checked_at: validTimestamp(revocation.checked_at, 'approval.revocation.checked_at'),
      record_ref: id(revocation.record_ref, 'approval.revocation.record_ref'),
    },
  };
}

function validTimestamp(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    fail('invalid_timestamp', `${field} must be an ISO UTC timestamp`, field);
  }
  return value;
}

function validateArtifact(value, field, expectedHash = undefined) {
  const artifact = record(value, field);
  assertAllowedKeys(artifact, new Set(['artifact_id', 'locator_ref', 'sha256', 'mime_type', 'width_px', 'height_px', 'access_policy_ref']), field);
  const checked = {
    artifact_id: id(artifact.artifact_id, `${field}.artifact_id`),
    locator_ref: id(artifact.locator_ref, `${field}.locator_ref`),
    sha256: hash(artifact.sha256, `${field}.sha256`),
    mime_type: nonemptyText(artifact.mime_type, `${field}.mime_type`),
    width_px: positiveInteger(artifact.width_px, `${field}.width_px`),
    height_px: positiveInteger(artifact.height_px, `${field}.height_px`),
    access_policy_ref: id(artifact.access_policy_ref, `${field}.access_policy_ref`),
  };
  if (!MIME.test(checked.mime_type)) fail('invalid_mime_type', `${field}.mime_type must be a MIME type`, `${field}.mime_type`);
  if (expectedHash !== undefined && checked.sha256 !== expectedHash) {
    fail('artifact_hash_mismatch', `${field} hash does not match approval binding`, `${field}.sha256`);
  }
  return checked;
}

function validateLayers(value, binding, artworkArtifact, { requireArtwork = true } = {}) {
  if (!Array.isArray(value) || value.length === 0) fail('missing_layers', 'layer_manifest must contain the exact handoff layers', 'layer_manifest');
  const ids = new Set();
  const binaryArtifactIds = new Set([artworkArtifact.artifact_id]);
  let artworkCount = 0;
  const usedAssetIds = new Set();
  const assets = new Map(binding.assets.map((asset) => [asset.asset_id, asset]));
  const layers = value.map((raw, index) => {
    const layer = record(raw, `layer_manifest[${index}]`);
    const layerId = id(layer.layer_id, `layer_manifest[${index}].layer_id`);
    if (ids.has(layerId)) fail('duplicate_layer', 'layer_id values must be unique', `layer_manifest[${index}].layer_id`);
    ids.add(layerId);
    if (layer.kind === 'artwork') {
      assertAllowedKeys(layer, new Set(['layer_id', 'kind', 'artifact_id', 'sha256']), `layer_manifest[${index}]`);
      artworkCount += 1;
      if (layer.artifact_id !== artworkArtifact.artifact_id || layer.sha256 !== artworkArtifact.sha256) {
        fail('artwork_layer_mismatch', 'Artwork layer must identify the exact approved artifact', `layer_manifest[${index}]`);
      }
      return { layer_id: layerId, kind: 'artwork', artifact_id: artworkArtifact.artifact_id, sha256: artworkArtifact.sha256 };
    }
    if (layer.kind === 'text') {
      assertAllowedKeys(layer, new Set(['layer_id', 'kind', 'role', 'value']), `layer_manifest[${index}]`);
      return {
        layer_id: layerId,
        kind: 'text',
        role: id(layer.role, `layer_manifest[${index}].role`),
        value: nonemptyText(layer.value, `layer_manifest[${index}].value`),
      };
    }
    if (layer.kind === 'approved_asset') {
      assertAllowedKeys(layer, new Set(['layer_id', 'kind', 'asset_id', 'asset_sha256', 'permission_ref', 'artifact']), `layer_manifest[${index}]`);
      const assetId = id(layer.asset_id, `layer_manifest[${index}].asset_id`);
      if (usedAssetIds.has(assetId)) fail('duplicate_layer_asset', 'An approved asset may appear in only one binary layer', `layer_manifest[${index}].asset_id`);
      usedAssetIds.add(assetId);
      const bound = assets.get(assetId);
      if (!bound || bound.sha256 !== layer.asset_sha256 || bound.permission_ref !== layer.permission_ref) {
        fail('unapproved_layer_asset', 'Layer asset must match an approved asset in the binding', `layer_manifest[${index}].asset_id`);
      }
      const assetArtifact = validateArtifact(layer.artifact, `layer_manifest[${index}].artifact`, bound.sha256);
      if (binaryArtifactIds.has(assetArtifact.artifact_id)) {
        fail('duplicate_artifact_id', 'Each binary handoff artifact must have a distinct artifact ID', `layer_manifest[${index}].artifact.artifact_id`);
      }
      binaryArtifactIds.add(assetArtifact.artifact_id);
      return {
        layer_id: layerId,
        kind: 'approved_asset',
        asset_id: assetId,
        asset_sha256: hash(layer.asset_sha256, `layer_manifest[${index}].asset_sha256`),
        permission_ref: id(layer.permission_ref, `layer_manifest[${index}].permission_ref`),
        artifact: assetArtifact,
      };
    }
    fail('unsupported_layer_kind', 'Unsupported handoff layer kind', `layer_manifest[${index}].kind`);
  });
  if (requireArtwork && artworkCount !== 1) fail('artwork_layer_count', 'A handoff must contain exactly one selected artwork layer', 'layer_manifest');
  const missingBoundAsset = binding.assets.find((asset) => !usedAssetIds.has(asset.asset_id));
  if (missingBoundAsset) fail('missing_asset_layer', 'Every bound asset must have a corresponding handoff layer', 'layer_manifest');
  return layers;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashLayers(layers) {
  return createHash('sha256').update(stableJson(layers)).digest('hex');
}

function hashCanonical(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

/** Compute the proposed composition digest over the normalized ordered manifest. */
export function hashCompositionLayerManifest({ binding, artifact, layer_manifest, trustedScope }) {
  const checkedBinding = validateApprovalBinding(binding, trustedScope);
  const checkedArtifact = validateArtifact(artifact, 'artifact', checkedBinding.design_version.artwork_sha256);
  const checkedLayers = validateLayers(layer_manifest, checkedBinding, checkedArtifact);
  return hashLayers(checkedLayers);
}

/** Build an immutable handoff only after the injected external verifier accepts its exact binding. */
export async function createArtworkHandoff({
  approvalVerifier,
  approval_reference,
  expected_audience,
  binding,
  artifact,
  layer_manifest,
  handoff_id,
  trustedScope,
  trace_refs = [],
  usage_refs = [],
  now = new Date(),
}) {
  if (typeof approvalVerifier?.verifyApproval !== 'function') {
    fail('verifier_unavailable', 'An external approval verifier is required; handoff is blocked', 'approvalVerifier', true);
  }
  const validatedBinding = validateApprovalBinding(binding, trustedScope);
  id(approval_reference, 'approval_reference');
  id(expected_audience, 'expected_audience');
  id(handoff_id, 'handoff_id');
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail('invalid_clock', 'now must be a valid Date', 'now');
  const exactArtifact = validateArtifact(artifact, 'artifact', validatedBinding.design_version.artwork_sha256);
  const exactLayers = validateLayers(layer_manifest, validatedBinding, exactArtifact);
  if (hashLayers(exactLayers) !== validatedBinding.composition.sha256) {
    fail('composition_hash_mismatch', 'Composition digest does not match its exact ordered layer manifest', 'binding.composition.sha256');
  }
  const checkedRefs = (refs, field) => {
    if (!Array.isArray(refs)) fail('invalid_references', `${field} must be an array`, field);
    return refs.map((ref, index) => id(ref, `${field}[${index}]`));
  };

  let verification;
  try {
    verification = await approvalVerifier.verifyApproval({
      approval_reference,
      expected_audience,
      expected_binding: validatedBinding,
      trusted_scope: { tenant_id: validatedBinding.tenant_id, project_id: validatedBinding.project_id },
    });
  } catch {
    fail('verifier_unavailable', 'Approval verifier is unavailable; handoff is blocked', 'approvalVerifier', true);
  }
  const approval = validateApprovalProof(verification, { expectedAudience: expected_audience, binding: validatedBinding, now });
  if (approval.approval_reference !== approval_reference) {
    fail('approval_reference_mismatch', 'Verifier response is for a different approval reference', 'approval.approval_reference');
  }

  const handoff = {
    schema_version: APPROVAL_HANDOFF_PROPOSAL_VERSION,
    handoff_id,
    binding: validatedBinding,
    artifact: exactArtifact,
    artifact_access: {
      policy_ref: exactArtifact.access_policy_ref,
      renewal_policy: 'reauthorize_each_fetch',
      bearer_url_included: false,
    },
    layer_manifest: exactLayers,
    approval,
    trace_refs: checkedRefs(trace_refs, 'trace_refs'),
    usage_refs: checkedRefs(usage_refs, 'usage_refs'),
  };
  return validateArtworkHandoff(handoff, trustedScope, { now });
}

/** Validate a stored or received handoff without trusting its embedded scope. */
export function validateArtworkHandoff(value, trustedScope, { now = new Date() } = {}) {
  const handoff = record(value, 'handoff');
  assertAllowedKeys(handoff, new Set(['schema_version', 'handoff_id', 'binding', 'artifact', 'artifact_access', 'layer_manifest', 'approval', 'trace_refs', 'usage_refs']), 'handoff');
  if (handoff.schema_version !== APPROVAL_HANDOFF_PROPOSAL_VERSION) {
    fail('unsupported_version', 'Unsupported artwork handoff version', 'schema_version');
  }
  const binding = validateApprovalBinding(handoff.binding, trustedScope);
  id(handoff.handoff_id, 'handoff_id');
  const artifact = validateArtifact(handoff.artifact, 'artifact', binding.design_version.artwork_sha256);
  const access = record(handoff.artifact_access, 'artifact_access');
  assertAllowedKeys(access, new Set(['policy_ref', 'renewal_policy', 'bearer_url_included']), 'artifact_access');
  if (access.policy_ref !== artifact.access_policy_ref || access.renewal_policy !== 'reauthorize_each_fetch' || access.bearer_url_included !== false) {
    fail('invalid_access_policy', 'Handoff must use renewable authorized retrieval and contain no bearer URL', 'artifact_access');
  }
  const layers = validateLayers(handoff.layer_manifest, binding, artifact);
  if (hashLayers(layers) !== binding.composition.sha256) {
    fail('composition_hash_mismatch', 'Composition digest does not match its exact ordered layer manifest', 'binding.composition.sha256');
  }
  const approval = record(handoff.approval, 'approval');
  assertAllowedKeys(approval, new Set(['approval_reference', 'approval_id', 'issuer_id', 'audience', 'issued_at', 'expires_at', 'key_id', 'key_set_version', 'revocation']), 'approval');
  id(approval.approval_reference, 'approval.approval_reference');
  id(approval.approval_id, 'approval.approval_id');
  id(approval.issuer_id, 'approval.issuer_id');
  id(approval.audience, 'approval.audience');
  id(approval.key_id, 'approval.key_id');
  id(approval.key_set_version, 'approval.key_set_version');
  const issuedAt = validTimestamp(approval.issued_at, 'approval.issued_at');
  const expiresAt = validTimestamp(approval.expires_at, 'approval.expires_at');
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail('invalid_clock', 'now must be a valid Date', 'now');
  if (Date.parse(expiresAt) <= now.getTime()) fail('approval_expired', 'External approval has expired', 'approval.expires_at');
  const revocation = record(approval.revocation, 'approval.revocation');
  if (revocation.status !== 'active') fail('approval_revoked', 'External approval is not active', 'approval.revocation.status');
  validTimestamp(revocation.checked_at, 'approval.revocation.checked_at');
  id(revocation.record_ref, 'approval.revocation.record_ref');
  const references = (items, field) => {
    if (!Array.isArray(items)) fail('invalid_references', `${field} must be an array`, field);
    return items.map((item, index) => id(item, `${field}[${index}]`));
  };
  return {
    schema_version: APPROVAL_HANDOFF_PROPOSAL_VERSION,
    handoff_id: handoff.handoff_id,
    binding,
    artifact,
    artifact_access: { policy_ref: access.policy_ref, renewal_policy: access.renewal_policy, bearer_url_included: false },
    layer_manifest: layers,
    approval: {
      approval_reference: approval.approval_reference,
      approval_id: approval.approval_id,
      issuer_id: approval.issuer_id,
      audience: approval.audience,
      issued_at: issuedAt,
      expires_at: expiresAt,
      key_id: approval.key_id,
      key_set_version: approval.key_set_version,
      revocation: { status: 'active', checked_at: revocation.checked_at, record_ref: revocation.record_ref },
    },
    trace_refs: references(handoff.trace_refs, 'trace_refs'),
    usage_refs: references(handoff.usage_refs, 'usage_refs'),
  };
}

/** Recheck the current issuer/revocation authority at consumption time. */
export async function verifyHandoffApproval({ approvalVerifier, handoff, expected_audience, trustedScope, now = new Date() }) {
  const checkedHandoff = validateArtworkHandoff(handoff, trustedScope, { now });
  if (typeof approvalVerifier?.verifyApproval !== 'function') {
    fail('verifier_unavailable', 'An external approval verifier is required; consumption is blocked', 'approvalVerifier', true);
  }
  if (expected_audience !== checkedHandoff.approval.audience) {
    fail('approval_audience_mismatch', 'Handoff approval is addressed to a different consumer', 'expected_audience');
  }
  let verification;
  try {
    verification = await approvalVerifier.verifyApproval({
      approval_reference: checkedHandoff.approval.approval_reference,
      expected_audience,
      expected_binding: checkedHandoff.binding,
      trusted_scope: { tenant_id: checkedHandoff.binding.tenant_id, project_id: checkedHandoff.binding.project_id },
    });
  } catch {
    fail('verifier_unavailable', 'Approval verifier or revocation service is unavailable; consumption is blocked', 'approvalVerifier', true);
  }
  const proof = validateApprovalProof(verification, { expectedAudience: expected_audience, binding: checkedHandoff.binding, now });
  if (proof.approval_id !== checkedHandoff.approval.approval_id || proof.issuer_id !== checkedHandoff.approval.issuer_id) {
    fail('approval_stale', 'Current verifier evidence no longer matches the handoff approval record', 'approval');
  }
  return proof;
}

/** Return verified hashes for every binary object required by the handoff. */
export function verifyHandoffArtifacts({ handoff, artifactBytesById, trustedScope, now = new Date() }) {
  const checked = validateArtworkHandoff(handoff, trustedScope, { now });
  record(artifactBytesById, 'artifactBytesById');
  const required = new Map([[checked.artifact.artifact_id, checked.artifact]]);
  for (const layer of checked.layer_manifest) {
    if (layer.kind === 'approved_asset') required.set(layer.artifact.artifact_id, layer.artifact);
  }
  const artifacts = [];
  for (const [artifactId, expected] of required) {
    const bytes = artifactBytesById[artifactId];
    if (!(bytes instanceof Uint8Array)) fail('artifact_bytes_missing', `Bytes for required artifact ${artifactId} are unavailable`, 'artifactBytesById');
    const actualHash = createHash('sha256').update(bytes).digest('hex');
    if (actualHash !== expected.sha256) fail('artifact_hash_mismatch', `Bytes for artifact ${artifactId} do not match the approved hash`, 'artifactBytesById');
    artifacts.push({
      artifact_id: artifactId,
      sha256: actualHash,
      mime_type: expected.mime_type,
      width_px: expected.width_px,
      height_px: expected.height_px,
    });
  }
  artifacts.sort((left, right) => left.artifact_id.localeCompare(right.artifact_id));
  return {
    handoff_id: checked.handoff_id,
    verified_layer_ids: checked.layer_manifest.map((layer) => layer.layer_id),
    artifacts,
  };
}

export function createConsumptionReceipt({
  handoff,
  artifactBytesById,
  trustedScope,
  consumer_id,
  receipt_id,
  access_grants,
  consumed_at,
  now = new Date(),
}) {
  const verified = verifyHandoffArtifacts({ handoff, artifactBytesById, trustedScope, now });
  id(consumer_id, 'consumer_id');
  id(receipt_id, 'receipt_id');
  const checked = validateArtworkHandoff(handoff, trustedScope, { now });
  if (!Array.isArray(access_grants) || access_grants.length !== verified.artifacts.length) {
    fail('access_grant_incomplete', 'Each binary artifact requires an authorized access receipt', 'access_grants');
  }
  const grants = access_grants.map((entry, index) => {
    const grant = record(entry, `access_grants[${index}]`);
    return {
      artifact_id: id(grant.artifact_id, `access_grants[${index}].artifact_id`),
      grant_ref: id(grant.grant_ref, `access_grants[${index}].grant_ref`),
    };
  });
  const receipt = {
    schema_version: APPROVAL_HANDOFF_PROPOSAL_VERSION,
    receipt_id,
    consumer_id,
    tenant_id: checked.binding.tenant_id,
    project_id: checked.binding.project_id,
    handoff_id: checked.handoff_id,
    approval_id: checked.approval.approval_id,
    design_version_id: checked.binding.design_version.design_version_id,
    binding_sha256: hashCanonical(checked.binding),
    composition_sha256: checked.binding.composition.sha256,
    layer_manifest_sha256: hashLayers(checked.layer_manifest),
    approval_proof_sha256: hashCanonical(checked.approval),
    consumed_artifacts: verified.artifacts,
    verified_layer_ids: verified.verified_layer_ids,
    access_grants: grants,
    consumed_at: validTimestamp(consumed_at, 'consumed_at'),
    status: 'consumed_exact_bytes',
  };
  return validateConsumptionReceipt(receipt, checked, { trustedScope, now });
}

export function validateConsumptionReceipt(value, handoff, { trustedScope, now = new Date() } = {}) {
  const receipt = record(value, 'receipt');
  const checkedHandoff = validateArtworkHandoff(handoff, trustedScope, { now });
  if (receipt.schema_version !== APPROVAL_HANDOFF_PROPOSAL_VERSION || receipt.status !== 'consumed_exact_bytes') {
    fail('invalid_receipt_status', 'Receipt must attest exact-byte consumption under this proposal version', 'receipt.status');
  }
  for (const [field, expected] of Object.entries({
    handoff_id: checkedHandoff.handoff_id,
    approval_id: checkedHandoff.approval.approval_id,
    tenant_id: checkedHandoff.binding.tenant_id,
    project_id: checkedHandoff.binding.project_id,
    design_version_id: checkedHandoff.binding.design_version.design_version_id,
  })) {
    if (receipt[field] !== expected) fail('receipt_binding_mismatch', `${field} does not match the handoff`, field);
  }
  const contextHashes = {
    binding_sha256: hashCanonical(checkedHandoff.binding),
    composition_sha256: checkedHandoff.binding.composition.sha256,
    layer_manifest_sha256: hashLayers(checkedHandoff.layer_manifest),
    approval_proof_sha256: hashCanonical(checkedHandoff.approval),
  };
  for (const [field, expected] of Object.entries(contextHashes)) {
    if (hash(receipt[field], `receipt.${field}`) !== expected) {
      fail('receipt_context_mismatch', `${field} does not match the exact approved handoff context`, `receipt.${field}`);
    }
  }
  id(receipt.receipt_id, 'receipt_id');
  id(receipt.consumer_id, 'consumer_id');
  validTimestamp(receipt.consumed_at, 'consumed_at');
  if (!Array.isArray(receipt.consumed_artifacts) || !Array.isArray(receipt.verified_layer_ids) || !Array.isArray(receipt.access_grants)) {
    fail('invalid_receipt', 'Receipt must include artifact, layer, and access evidence', 'receipt');
  }
  const requiredArtifacts = new Map([[checkedHandoff.artifact.artifact_id, checkedHandoff.artifact]]);
  for (const layer of checkedHandoff.layer_manifest) {
    if (layer.kind === 'approved_asset') requiredArtifacts.set(layer.artifact.artifact_id, layer.artifact);
  }
  const receivedArtifacts = new Map();
  for (const [index, item] of receipt.consumed_artifacts.entries()) {
    const artifact = record(item, `consumed_artifacts[${index}]`);
    const artifactId = id(artifact.artifact_id, `consumed_artifacts[${index}].artifact_id`);
    const artifactHash = hash(artifact.sha256, `consumed_artifacts[${index}].sha256`);
    const expected = requiredArtifacts.get(artifactId);
    if (receivedArtifacts.has(artifactId) || !expected || expected.sha256 !== artifactHash
      || expected.mime_type !== artifact.mime_type || expected.width_px !== artifact.width_px || expected.height_px !== artifact.height_px) {
      fail('receipt_artifact_mismatch', 'Receipt artifact identity/hash does not match the handoff', `consumed_artifacts[${index}]`);
    }
    receivedArtifacts.set(artifactId, {
      sha256: artifactHash,
      mime_type: nonemptyText(artifact.mime_type, `consumed_artifacts[${index}].mime_type`),
      width_px: positiveInteger(artifact.width_px, `consumed_artifacts[${index}].width_px`),
      height_px: positiveInteger(artifact.height_px, `consumed_artifacts[${index}].height_px`),
    });
  }
  if (receivedArtifacts.size !== requiredArtifacts.size) fail('receipt_artifact_missing', 'Receipt must include every required binary artifact', 'consumed_artifacts');
  const requiredLayers = checkedHandoff.layer_manifest.map((layer) => layer.layer_id).sort();
  const receivedLayers = receipt.verified_layer_ids.map((layerId, index) => id(layerId, `verified_layer_ids[${index}]`)).sort();
  if (JSON.stringify(requiredLayers) !== JSON.stringify(receivedLayers)) {
    fail('receipt_layer_mismatch', 'Receipt must confirm every required handoff layer', 'verified_layer_ids');
  }
  if (receipt.access_grants.length !== requiredArtifacts.size) {
    fail('access_grant_incomplete', 'Receipt needs one access grant reference per binary artifact', 'access_grants');
  }
  const seenGrantArtifacts = new Set();
  const grants = receipt.access_grants.map((entry, index) => {
    const grant = record(entry, `access_grants[${index}]`);
    const artifactId = id(grant.artifact_id, `access_grants[${index}].artifact_id`);
    if (!requiredArtifacts.has(artifactId) || seenGrantArtifacts.has(artifactId)) {
      fail('access_grant_mismatch', 'Access grant must bind to one required artifact', `access_grants[${index}].artifact_id`);
    }
    seenGrantArtifacts.add(artifactId);
    return { artifact_id: artifactId, grant_ref: id(grant.grant_ref, `access_grants[${index}].grant_ref`) };
  }).sort((a, b) => a.artifact_id.localeCompare(b.artifact_id));
  return {
    schema_version: APPROVAL_HANDOFF_PROPOSAL_VERSION,
    receipt_id: receipt.receipt_id,
    consumer_id: receipt.consumer_id,
    tenant_id: checkedHandoff.binding.tenant_id,
    project_id: checkedHandoff.binding.project_id,
    handoff_id: checkedHandoff.handoff_id,
    approval_id: checkedHandoff.approval.approval_id,
    design_version_id: checkedHandoff.binding.design_version.design_version_id,
    ...contextHashes,
    consumed_artifacts: [...receivedArtifacts].map(([artifact_id, artifact]) => ({ artifact_id, ...artifact })).sort((a, b) => a.artifact_id.localeCompare(b.artifact_id)),
    verified_layer_ids: [...receivedLayers].sort(),
    access_grants: grants,
    consumed_at: receipt.consumed_at,
    status: 'consumed_exact_bytes',
  };
}

/** Build typed composition instructions only; this API has no renderer or image-provider port. */
export function createCompositionEditPlan({
  plan_id,
  binding,
  layer_manifest,
  target_composition_revision_id,
  operations,
  trustedScope,
}) {
  const checkedBinding = validateApprovalBinding(binding, trustedScope);
  id(plan_id, 'plan_id');
  id(target_composition_revision_id, 'target_composition_revision_id');
  if (target_composition_revision_id === checkedBinding.composition.revision_id) {
    fail('composition_revision_not_advanced', 'A composition edit must create a new revision', 'target_composition_revision_id');
  }
  const declaredArtwork = Array.isArray(layer_manifest)
    ? layer_manifest.find((layer) => layer?.kind === 'artwork')
    : undefined;
  if (!declaredArtwork) fail('missing_layers', 'Composition plan requires a declared artwork layer', 'layer_manifest');
  const checkedLayers = validateLayers(layer_manifest, checkedBinding, {
    artifact_id: id(declaredArtwork.artifact_id, 'layer_manifest.artifact_id'),
    sha256: checkedBinding.design_version.artwork_sha256,
  });
  if (hashLayers(checkedLayers) !== checkedBinding.composition.sha256) {
    fail('composition_hash_mismatch', 'Base composition digest does not match its exact ordered layer manifest', 'binding.composition.sha256');
  }
  const layerMap = new Map(checkedLayers.map((layer) => [layer.layer_id, layer]));
  if (!Array.isArray(operations) || operations.length === 0) fail('empty_composition_plan', 'At least one typed operation is required', 'operations');
  const seen = new Set();
  const checkedOperations = operations.map((raw, index) => {
    const operation = record(raw, `operations[${index}]`);
    const operationId = id(operation.operation_id, `operations[${index}].operation_id`);
    if (seen.has(operationId)) fail('duplicate_operation', 'operation_id values must be unique', `operations[${index}].operation_id`);
    seen.add(operationId);
    const layerId = id(operation.layer_id, `operations[${index}].layer_id`);
    const targetLayer = layerMap.get(layerId);
    if (!targetLayer) fail('unknown_composition_layer', 'Operation must target a declared layer', `operations[${index}].layer_id`);

    if (operation.kind === 'set_text') {
      if (targetLayer.kind !== 'text') fail('layer_kind_mismatch', 'set_text requires a text layer', `operations[${index}].kind`);
      return { operation_id: operationId, kind: 'set_text', layer_id: layerId, value: nonemptyText(operation.value, `operations[${index}].value`) };
    }
    if (operation.kind === 'set_text_size') {
      if (targetLayer.kind !== 'text') fail('layer_kind_mismatch', 'set_text_size requires a text layer', `operations[${index}].kind`);
      const size = record(operation.size, `operations[${index}].size`);
      if (typeof size.value !== 'string' || !DECIMAL.test(size.value) || Number(size.value) <= 0) {
        fail('invalid_text_size', 'Text size must be an exact positive decimal string', `operations[${index}].size.value`);
      }
      if (!['pt', 'px'].includes(size.unit)) fail('invalid_text_size_unit', 'Text size unit must be pt or px', `operations[${index}].size.unit`);
      return { operation_id: operationId, kind: 'set_text_size', layer_id: layerId, size: { value: size.value, unit: size.unit } };
    }
    if (operation.kind === 'set_layer_layout') {
      return { operation_id: operationId, kind: 'set_layer_layout', layer_id: layerId, layout: layout(operation.layout, `operations[${index}].layout`) };
    }
    if (operation.kind === 'position_approved_logo') {
      if (targetLayer.kind !== 'approved_asset') fail('layer_kind_mismatch', 'Logo positioning requires an approved asset layer', `operations[${index}].kind`);
      const assetId = id(operation.asset_id, `operations[${index}].asset_id`);
      const bound = checkedBinding.assets.find((asset) => asset.asset_id === assetId);
      if (!bound || bound.intended_use !== 'logo' || targetLayer.asset_id !== assetId) {
        fail('logo_permission_mismatch', 'Logo positioning requires the exact approved logo asset', `operations[${index}].asset_id`);
      }
      return {
        operation_id: operationId,
        kind: 'position_approved_logo',
        layer_id: layerId,
        asset_id: assetId,
        layout: layout(operation.layout, `operations[${index}].layout`),
      };
    }
    fail('unsupported_composition_operation', 'Composition edits must use an allowlisted typed operation', `operations[${index}].kind`);
  });
  return {
    schema_version: COMPOSITION_EDIT_PROPOSAL_VERSION,
    plan_id,
    tenant_id: checkedBinding.tenant_id,
    project_id: checkedBinding.project_id,
    base_design_version_id: checkedBinding.design_version.design_version_id,
    base_artwork_sha256: checkedBinding.design_version.artwork_sha256,
    base_brief_id: checkedBinding.brief.brief_id,
    base_brief_sha256: checkedBinding.brief.sha256,
    base_facts_revision_id: checkedBinding.facts.revision_id,
    base_facts_sha256: checkedBinding.facts.sha256,
    base_composition_id: checkedBinding.composition.composition_id,
    base_composition_revision_id: checkedBinding.composition.revision_id,
    base_composition_sha256: checkedBinding.composition.sha256,
    target_composition_revision_id,
    operations: checkedOperations,
    approval_required_after_application: true,
  };
}

function layout(value, field) {
  const geometry = record(value, field);
  const checked = {};
  for (const coordinate of ['x_milli', 'y_milli']) {
    if (!Number.isSafeInteger(geometry[coordinate]) || geometry[coordinate] < 0 || geometry[coordinate] > 1000) {
      fail('invalid_layout_coordinate', `${coordinate} must be an integer from 0 to 1000`, `${field}.${coordinate}`);
    }
    checked[coordinate] = geometry[coordinate];
  }
  for (const dimension of ['width_milli', 'height_milli']) {
    if (geometry[dimension] !== undefined) {
      if (!Number.isSafeInteger(geometry[dimension]) || geometry[dimension] <= 0 || geometry[dimension] > 1000) {
        fail('invalid_layout_dimension', `${dimension} must be an integer from 1 to 1000`, `${field}.${dimension}`);
      }
      checked[dimension] = geometry[dimension];
    }
  }
  if (checked.width_milli !== undefined && checked.x_milli + checked.width_milli > 1000) {
    fail('layout_out_of_bounds', 'Horizontal layout exceeds the normalized canvas', field);
  }
  if (checked.height_milli !== undefined && checked.y_milli + checked.height_milli > 1000) {
    fail('layout_out_of_bounds', 'Vertical layout exceeds the normalized canvas', field);
  }
  return checked;
}

/** Acceptance evidence gate; local fixtures do not establish owner agreement. */
export function evaluateApprovalHandoffAgreementGate(evidence) {
  const requiredRoles = ['Product and frontend', 'Creative and fulfillment', 'Agent and research'];
  const acceptances = evidence && typeof evidence === 'object' && !Array.isArray(evidence)
    ? evidence.acceptances
    : undefined;
  const missingEvidence = [];
  const missingRoles = requiredRoles.filter((role) => {
    const entry = Array.isArray(acceptances) ? acceptances.find((item) => item?.owner_role === role) : undefined;
    if (!entry || entry.status !== 'accepted') {
      missingEvidence.push(`${role}:owner_acceptance`);
      return true;
    }
    if (typeof entry.artifact_ref !== 'string' || entry.artifact_ref.length === 0
      || typeof entry.artifact_sha256 !== 'string' || !SHA256.test(entry.artifact_sha256)
      || typeof entry.pinned_revision !== 'string' || entry.pinned_revision.length === 0) {
      missingEvidence.push(`${role}:pinned_artifact`);
    }
    if (typeof entry.independent_review_ref !== 'string' || entry.independent_review_ref.length === 0) {
      missingEvidence.push(`${role}:independent_review`);
    }
    return false;
  });
  const protocolPin = evidence && typeof evidence === 'object' ? evidence.external_protocol_pin : undefined;
  if (!protocolPin || typeof protocolPin !== 'object' || Array.isArray(protocolPin)
    || typeof protocolPin.revision !== 'string' || protocolPin.revision.length === 0
    || typeof protocolPin.sha256 !== 'string' || !SHA256.test(protocolPin.sha256)
    || typeof protocolPin.artifact_ref !== 'string' || protocolPin.artifact_ref.length === 0) {
    missingEvidence.push('external_protocol_pin');
  }
  return {
    status: missingEvidence.length === 0 && missingRoles.length === 0 ? 'owner_review_required' : 'blocked',
    acceptance_allowed: false,
    independent_owner_verification_required: true,
    missing_owner_roles: missingRoles,
    missing_evidence: missingEvidence,
    note: 'This proposal cannot validate external agreement; pinned owner evidence still requires independent verification.',
  };
}
