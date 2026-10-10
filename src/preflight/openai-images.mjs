import { createHash, randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { AccessPreflightError, createObservationId } from './access.mjs';

const GENERATION_ENDPOINT = 'https://api.openai.com/v1/images/generations';
const EDIT_ENDPOINT = 'https://api.openai.com/v1/images/edits';
const MODEL_LIST_ENDPOINT = 'https://api.openai.com/v1/models';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_DECODED_PNG_BYTES = 64 * 1024 * 1024;
const MAX_RESPONSE_BYTES = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 1024 * 1024;
const IMAGE_TOKEN = Symbol('preflight-image-token');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});

function error(code, message) {
  return new AccessPreflightError(code, message);
}

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function nonSecretEvidenceRef(runId, cellId, name) {
  return `${runId}:${cellId}:${name}`;
}

function targetBinding(target, scope) {
  return {
    service: target.service,
    endpoint: target.endpoint,
    model: target.model,
    sdk_name: target.sdk.name,
    sdk_version: target.sdk.version,
    configuration_sha256: target.configuration_sha256,
    account_ref: scope.account_ref,
    project_ref: scope.project_ref,
  };
}

function safeProviderRequestRef(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return `provider-request:${digest(Buffer.from(value, 'utf8')).slice(7)}`;
}

function safeCredentialEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.ref !== 'string' || !SAFE_REF.test(value.ref)
    || typeof value.sha256 !== 'string' || !HASH.test(value.sha256)
    || typeof value.pinned_revision !== 'string' || !SAFE_REF.test(value.pinned_revision)
    || !value.independent_review || typeof value.independent_review.ref !== 'string'
    || !SAFE_REF.test(value.independent_review.ref) || typeof value.independent_review.sha256 !== 'string'
    || !HASH.test(value.independent_review.sha256)) {
    throw error('credential_unavailable', 'Credential identity evidence is not independently pinned.');
  }
  return value;
}

async function resolveCredential(credentialPort, { purpose, scope, target, grantRef, deadlineAt }) {
  try {
    if (!SAFE_REF.test(scope.account_ref) || !SAFE_REF.test(scope.project_ref)) {
      throw error('credential_unavailable', 'Provider account and project references must be safe opaque IDs.');
    }
    const resolved = await credentialPort.resolveCredential({
      service: 'openai',
      purpose,
      account_ref: scope.account_ref,
      project_ref: scope.project_ref,
      target_binding: targetBinding(target, scope),
      ...(grantRef ? { grant_ref: grantRef } : {}),
    });
    const expectedBinding = targetBinding(target, scope);
    const expectedBindingHash = digest(Buffer.from(JSON.stringify(expectedBinding), 'utf8'));
    const allowedBindingFields = ['service', 'account_ref', 'project_ref', 'target_binding_sha256', ...(grantRef ? ['grant_ref'] : [])];
    if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)
      || resolved.decision !== 'resolved' || resolved.evidence_mode !== 'live') {
      throw error('credential_unavailable', 'Trusted credential resolver did not confirm this provider scope.');
    }
    if (!resolved.binding || Object.keys(resolved.binding).some((key) => !allowedBindingFields.includes(key))
      || resolved.binding.service !== 'openai'
      || resolved.binding.account_ref !== scope.account_ref || resolved.binding.project_ref !== scope.project_ref
      || resolved.binding.target_binding_sha256 !== expectedBindingHash
      || (grantRef && resolved.binding.grant_ref !== grantRef)) {
      throw error('credential_unavailable', 'Credential identity does not match the requested provider account and project.');
    }
    if (!resolved.provider_scope || Object.keys(resolved.provider_scope).some((key) => !['organization_id', 'project_id'].includes(key))
      || resolved.provider_scope.organization_id !== scope.account_ref
      || resolved.provider_scope.project_id !== scope.project_ref) {
      throw error('credential_unavailable', 'Provider request routing does not bind the exact account and project.');
    }
    if (typeof resolved.token !== 'string' || resolved.token.trim().length === 0 || /[\r\n]/.test(resolved.token)) {
      throw error('credential_unavailable', 'Trusted credential resolver did not return a usable bearer token.');
    }
    safeCredentialEvidence(resolved.evidence);
    if (typeof resolved.expires_at !== 'string' || !Number.isFinite(Date.parse(resolved.expires_at))
      || Date.parse(resolved.expires_at) <= Date.now()
      || (deadlineAt && Date.parse(resolved.expires_at) < Date.parse(deadlineAt))) {
      throw error('credential_unavailable', 'Scoped credential will not remain valid through the approved operation deadline.');
    }
    return {
      token: resolved.token,
      headers: {
        'OpenAI-Organization': resolved.provider_scope.organization_id,
        'OpenAI-Project': resolved.provider_scope.project_id,
      },
    };
  } catch {
    throw error('credential_unavailable', 'Credential provider did not return a usable access token.');
  }
}

function mapProbeFailure(status) {
  if (status === 401) return { authentication: 'denied', model_listing: 'unknown' };
  if (status === 403) return { authentication: 'confirmed', model_listing: 'unknown', operation_permission: 'denied' };
  if (status === 429) return { authentication: 'unknown', model_listing: 'unknown', quota: 'unknown' };
  return { authentication: 'unknown', model_listing: 'unknown' };
}

function makeUsageObservation(attempt, transportId, requestId, rawUsage) {
  const base = {
    schema_version: 'creative.metering.proposal/v1',
    tenant_id: attempt.tenant_id,
    project_id: attempt.project_id,
    budget_scope_id: attempt.budget_scope_id,
    logical_operation_id: attempt.logical_operation_id,
    billable_attempt_id: attempt.billable_attempt_id,
    source_observation_id: createObservationId(),
    source: 'provider_response',
    provider_name: attempt.provider.name,
    model: attempt.provider.model,
    ...(requestId ? { provider_request_id: requestId } : {}),
    transport_attempt_id: transportId,
    environment: attempt.environment,
    billing_mode: attempt.billing_mode,
  };
  const names = ['input_tokens', 'output_tokens', 'total_tokens'];
  const values = Object.fromEntries(names.map((name) => [name, rawUsage?.[name]]));
  const present = names.filter((name) => Number.isSafeInteger(values[name]) && values[name] >= 0);
  if (present.length === 0) {
    return {
      ...base,
      completeness: 'unknown',
      missing_fields: names.map((name) => `usage.${name}`),
    };
  }
  const missing = names.filter((name) => !present.includes(name)).map((name) => `usage.${name}`);
  const hasTotal = present.includes('total_tokens');
  const usageUnits = present.map((name) => ({
    name,
    quantity: String(values[name]),
    relation: name === 'total_tokens' || !hasTotal ? 'standalone' : 'included_subset',
    ...(name === 'total_tokens' || !hasTotal ? {} : { included_in: 'total_tokens' }),
  }));
  return {
    ...base,
    completeness: missing.length === 0 ? 'complete' : 'partial',
    usage_units: usageUnits,
    missing_fields: missing,
  };
}

function validateImageConfiguration(cellId, target) {
  if (target.service !== 'openai' || target.sdk?.name !== 'native-fetch' || target.sdk?.version !== process.versions.node) {
    throw error('unsupported_image_configuration', 'Image preflight requires the actual pinned Node native-fetch runtime version.');
  }
  const expectedEndpoint = cellId === 'image_generation' ? GENERATION_ENDPOINT : cellId === 'image_edit' ? EDIT_ENDPOINT : null;
  if (!expectedEndpoint || target.endpoint !== expectedEndpoint || target.model !== 'gpt-image-2.5-sunburst-2026-09-08') {
    throw error('unsupported_image_configuration', 'Image endpoint and model must match this explicit candidate pin.');
  }
  const config = target.configuration;
  const allowed = new Set(['prompt_template_ref', 'prompt_template_sha256', 'n', 'size', 'quality', 'output_format', 'background', 'moderation',
    ...(cellId === 'image_edit' ? ['asset_ref', 'asset_sha256', 'asset_mime'] : [])]);
  const required = ['prompt_template_ref', 'prompt_template_sha256', 'n', 'size', 'quality', 'output_format', 'background', 'moderation'];
  if (!config || Object.keys(config).some((key) => !allowed.has(key))
    || required.some((key) => !Object.hasOwn(config, key)) || config.n !== 1
    || config.size !== '1024x1024' || config.quality !== 'medium' || config.output_format !== 'png'
    || config.background !== 'opaque' || config.moderation !== 'auto'
    || !HASH.test(config.prompt_template_sha256) || typeof config.prompt_template_ref !== 'string' || !ID.test(config.prompt_template_ref)) {
    throw error('unsupported_image_configuration', 'Image configuration does not match the approved single-attempt smoke shape.');
  }
  if (cellId === 'image_edit') {
    if (typeof config.asset_ref !== 'string' || !ID.test(config.asset_ref) || !HASH.test(config.asset_sha256)
      || config.asset_mime !== 'image/png') {
      throw error('unsupported_image_configuration', 'Edit requires a pinned PNG asset reference and digest.');
    }
  }
}

async function responseJson(response) {
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    try { await response.body?.cancel(); } catch { /* no provider details leave the adapter */ }
    throw error('provider_response_invalid', 'Provider response exceeded the bounded JSON size.');
  }
  const reader = response.body?.getReader?.();
  if (!reader) throw error('provider_response_invalid', 'Provider response body was unavailable.');
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw error('provider_response_invalid', 'Provider response exceeded the bounded JSON size.');
      }
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } catch {
    throw error('provider_response_invalid', 'Provider returned an unreadable JSON response.');
  }
}

function validImageBytes(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 8
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return null;
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== value) return null;
  return bytes;
}

function pngCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function decodePng(bytes, failureCode) {
  const reject = () => { throw error(failureCode, 'Image bytes are not a bounded, decodable PNG.'); };
  if (!Buffer.isBuffer(bytes) || bytes.length < 45 || bytes.length > MAX_IMAGE_BYTES || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) reject();
  let offset = 8;
  let width;
  let height;
  let bitDepth;
  let colorType;
  let interlace;
  let sawHeader = false;
  let sawPalette = false;
  let sawData = false;
  let dataFinished = false;
  let sawEnd = false;
  let idatSize = 0;
  const idat = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (length > MAX_IMAGE_BYTES || chunkEnd > bytes.length) reject();
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    const type = typeBytes.toString('ascii');
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const recordedCrc = bytes.readUInt32BE(offset + 8 + length);
    if (pngCrc32(bytes.subarray(offset + 4, offset + 8 + length)) !== recordedCrc) reject();
    if (!/^[A-Za-z]{4}$/.test(type)) reject();
    if (!sawHeader && type !== 'IHDR') reject();
    if (sawEnd) reject();
    if (type === 'IHDR') {
      if (sawHeader || length !== 13) reject();
      sawHeader = true;
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (width < 1 || height < 1 || width > 4096 || height > 4096 || width * height > 16_777_216
        || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) reject();
      const legalDepths = colorType === 0 ? [1, 2, 4, 8, 16]
        : colorType === 2 ? [8, 16]
          : colorType === 3 ? [1, 2, 4, 8]
            : colorType === 4 ? [8, 16]
              : colorType === 6 ? [8, 16] : [];
      if (!legalDepths.includes(bitDepth)) reject();
      interlace = data[12];
    } else if (type === 'PLTE') {
      if (sawData || sawPalette || colorType === 0 || colorType === 4
        || length < 3 || length > 768 || length % 3 !== 0
        || (colorType === 3 && length / 3 > 2 ** bitDepth)) reject();
      sawPalette = true;
    } else if (type === 'IDAT') {
      if (dataFinished || (colorType === 3 && !sawPalette)) reject();
      sawData = true;
      idatSize += length;
      if (idatSize > MAX_IMAGE_BYTES) reject();
      idat.push(data);
    } else if (type === 'IEND') {
      if (!sawData || length !== 0) reject();
      sawEnd = true;
    } else {
      if (sawData) dataFinished = true;
      if (type.charCodeAt(0) >= 65 && type.charCodeAt(0) <= 90) reject();
    }
    if (sawData && type !== 'IDAT' && type !== 'IEND') dataFinished = true;
    offset = chunkEnd;
    if (sawEnd) break;
  }
  if (!sawHeader || !sawData || !sawEnd || offset !== bytes.length || (colorType === 3 && !sawPalette)) reject();
  const channels = colorType === 0 || colorType === 3 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : 4;
  const rowBytes = Math.ceil(width * channels * bitDepth / 8);
  const decodedSize = (rowBytes + 1) * height;
  if (interlace !== 0 || decodedSize > MAX_DECODED_PNG_BYTES) reject();
  const compressed = Buffer.concat(idat);
  let decoded;
  try {
    const inflated = inflateSync(compressed, { maxOutputLength: decodedSize, info: true });
    if (inflated.engine.bytesWritten !== compressed.length) reject();
    decoded = inflated.buffer;
  } catch {
    reject();
  }
  if (decoded.length !== decodedSize) reject();
  for (let row = 0; row < height; row += 1) if (decoded[row * (rowBytes + 1)] > 4) reject();
  return { width, height };
}

function deadlineSignal(deadlineAt, callerSignal) {
  const remaining = Date.parse(deadlineAt) - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) throw error('preflight_deadline_passed', 'The approved operation deadline has passed.');
  const timeout = AbortSignal.timeout(Math.min(remaining, 120_000));
  return callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
}

/**
 * Actual direct Images adapter. It does not choose a model, read process.env,
 * retry, or run unless called by the access runner after authority and metering
 * gates. Construction is safe; all provider access happens only when a method
 * is explicitly invoked.
 */
export function createOpenAIImagesAdapter({ credentialPort, promptPort, assetPort }) {
  if (!credentialPort || credentialPort.evidence_mode !== 'live' || typeof credentialPort.resolveCredential !== 'function') {
    throw error('credential_unavailable', 'A trusted account/project-bound credential resolver is required.');
  }
  return Object.freeze({
    evidence_mode: 'live',

    async inspect({ run_id, cell_id, target, scope }) {
      validateImageConfiguration(cell_id, target);
      const checkedAt = new Date().toISOString();
      let credential;
      try {
        credential = await resolveCredential(credentialPort, { purpose: 'read_only_model_listing', scope, target });
      } catch {
        throw error('credential_unavailable', 'Read-only account authentication could not be checked.');
      }
      let response;
      try {
        response = await fetch(MODEL_LIST_ENDPOINT, {
          method: 'GET',
          headers: { authorization: `Bearer ${credential.token}`, accept: 'application/json', ...credential.headers },
          redirect: 'error',
          cache: 'no-store',
        });
      } catch {
        throw error('access_probe_unavailable', 'Read-only provider access check failed.');
      }
      const base = {
        evidence_mode: 'live',
        target: targetBinding(target, scope),
        authentication: 'unknown',
        model_listing: 'unknown',
        operation_permission: 'unknown',
        quota: 'unknown',
        checked_at: checkedAt,
      };
      if (!response.ok) {
        const mapped = mapProbeFailure(response.status);
        const report = { ...base, ...mapped };
        return {
          ...report,
          evidence: {
            ref: nonSecretEvidenceRef(run_id, cell_id, 'openai-model-list'),
            sha256: digest(Buffer.from(JSON.stringify({ status: response.status, cell_id, target: targetBinding(target, scope) }), 'utf8')),
          },
        };
      }
      const payload = await responseJson(response);
      const modelListed = Array.isArray(payload?.data) && payload.data.some((entry) => entry?.id === target.model);
      const report = {
        ...base,
        authentication: 'confirmed',
        model_listing: modelListed ? 'listed' : 'not_listed',
        operation_permission: 'unknown',
        quota: 'unknown',
      };
      const evidenceDigest = digest(Buffer.from(JSON.stringify({
        status: response.status,
        model_listed: modelListed,
        checked_at: checkedAt,
        target: targetBinding(target, scope),
      }), 'utf8'));
      return {
        ...report,
        evidence: { ref: nonSecretEvidenceRef(run_id, cell_id, 'openai-model-list'), sha256: evidenceDigest },
      };
    },

    async prepare({ cell_id, target, configuration, scope, grant_ref, deadline_at }) {
      validateImageConfiguration(cell_id, target);
      if (!promptPort || typeof promptPort.resolve !== 'function') throw error('prompt_unavailable', 'Pinned smoke prompt provider is unavailable.');
      let prompt;
      try {
        prompt = await promptPort.resolve({ ref: configuration.prompt_template_ref });
      } catch {
        throw error('prompt_unavailable', 'Pinned smoke prompt could not be loaded.');
      }
      if (typeof prompt !== 'string' || prompt.length === 0 || prompt.length > 4000
        || digest(Buffer.from(prompt, 'utf8')) !== configuration.prompt_template_sha256) {
        throw error('prompt_hash_mismatch', 'Prompt template does not match its pinned digest.');
      }
      const prepared = { prompt };
      if (cell_id === 'image_edit') {
        if (!assetPort || typeof assetPort.read !== 'function') throw error('asset_unavailable', 'Pinned edit asset provider is unavailable.');
        let bytes;
        try {
          bytes = await assetPort.read({ ref: configuration.asset_ref, sha256: configuration.asset_sha256 });
        } catch {
          throw error('asset_unavailable', 'Pinned edit asset could not be loaded.');
        }
        if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES || digest(bytes) !== configuration.asset_sha256) {
          throw error('asset_hash_mismatch', 'Edit asset bytes do not match the pinned digest or size bound.');
        }
        const imageBytes = Buffer.from(bytes);
        decodePng(imageBytes, 'asset_hash_mismatch');
        prepared.imageBytes = imageBytes;
      }
      const credential = await resolveCredential(credentialPort, {
        purpose: 'authorized_billable_operation', scope, target, grantRef: grant_ref, deadlineAt: deadline_at,
      });
      Object.defineProperty(prepared, IMAGE_TOKEN, { value: credential.token, enumerable: false });
      Object.defineProperty(prepared, 'provider_scope_headers', { value: credential.headers, enumerable: false });
      return prepared;
    },

    async dispatch({ run_id, cell_id, target, configuration, scope, prepared, metering, deadline_at }) {
      validateImageConfiguration(cell_id, target);
      if (!prepared || typeof prepared.prompt !== 'string' || (cell_id === 'image_edit' && !(prepared.imageBytes instanceof Uint8Array))) {
        throw error('prompt_unavailable', 'Prevalidated image request content is unavailable.');
      }
      if (typeof prepared[IMAGE_TOKEN] !== 'string' || !prepared.provider_scope_headers
        || prepared.provider_scope_headers['OpenAI-Project'] !== scope.project_ref
        || prepared.provider_scope_headers['OpenAI-Organization'] !== scope.account_ref) {
        throw error('credential_unavailable', 'Prepared credentials are not bound to the approved account and project.');
      }
      const transportId = `transport:${randomUUID()}`;
      try {
        await metering.recordTransportAttempt(transportId);
      } catch {
        throw error('metering_or_dispatch_unknown', 'Finance did not acknowledge the transport identity.');
      }
      let body;
      const headers = {
        authorization: `Bearer ${prepared[IMAGE_TOKEN]}`,
        accept: 'application/json',
        ...prepared.provider_scope_headers,
      };
      if (cell_id === 'image_generation') {
        headers['content-type'] = 'application/json';
        body = JSON.stringify({
          model: target.model,
          prompt: prepared.prompt,
          n: configuration.n,
          size: configuration.size,
          quality: configuration.quality,
          output_format: configuration.output_format,
          background: configuration.background,
          moderation: configuration.moderation,
        });
      } else {
        const form = new FormData();
        form.set('model', target.model);
        form.set('prompt', prepared.prompt);
        form.set('n', String(configuration.n));
        form.set('size', configuration.size);
        form.set('quality', configuration.quality);
        form.set('output_format', configuration.output_format);
        form.set('background', configuration.background);
        form.set('moderation', configuration.moderation);
        form.append('image', new Blob([prepared.imageBytes], { type: configuration.asset_mime }), 'preflight-source.png');
        body = form;
      }
      let response;
      try {
        response = await fetch(target.endpoint, {
          method: 'POST',
          headers,
          body,
          signal: deadlineSignal(deadline_at, metering.signal),
          redirect: 'error',
          cache: 'no-store',
        });
      } catch {
        return {
          evidence_mode: 'live',
          provider_outcome: 'unknown',
          usage_observation: makeUsageObservation(metering.attempt, transportId, undefined, undefined),
          evidence: {
            completed_at: new Date().toISOString(),
            service: target.service,
            endpoint: target.endpoint,
            model: target.model,
            sdk_name: target.sdk.name,
            sdk_version: target.sdk.version,
            configuration_sha256: target.configuration_sha256,
          },
        };
      }
      const requestId = safeProviderRequestRef(response.headers?.get?.('x-request-id'));
      if (!response.ok) {
        return {
          evidence_mode: 'live',
          provider_outcome: 'failed',
          usage_observation: makeUsageObservation(metering.attempt, transportId, requestId, undefined),
          evidence: {
            ...(requestId ? { provider_request_ref: requestId } : {}),
            completed_at: new Date().toISOString(),
            service: target.service,
            endpoint: target.endpoint,
            model: target.model,
            sdk_name: target.sdk.name,
            sdk_version: target.sdk.version,
            configuration_sha256: target.configuration_sha256,
          },
        };
      }
      let payload;
      try {
        payload = await responseJson(response);
      } catch {
        return {
          evidence_mode: 'live',
          provider_outcome: 'unknown',
          usage_observation: makeUsageObservation(metering.attempt, transportId, requestId, undefined),
          evidence: {
            ...(requestId ? { provider_request_ref: requestId } : {}),
            completed_at: new Date().toISOString(),
            service: target.service,
            endpoint: target.endpoint,
            model: target.model,
            sdk_name: target.sdk.name,
            sdk_version: target.sdk.version,
            configuration_sha256: target.configuration_sha256,
          },
        };
      }
      const bytes = validImageBytes(payload?.data?.[0]?.b64_json);
      let decodedImage;
      if (bytes) {
        try {
          decodedImage = decodePng(bytes, 'provider_response_invalid');
        } catch {
          decodedImage = null;
        }
      }
      const returnedModel = payload?.model;
      const modelMatches = returnedModel === undefined || returnedModel === target.model;
      const imageSizeMatches = decodedImage?.width === 1024 && decodedImage?.height === 1024;
      const providerOutcome = bytes && decodedImage && modelMatches && imageSizeMatches ? 'succeeded' : 'failed';
      return {
        evidence_mode: 'live',
        provider_outcome: providerOutcome,
        usage_observation: makeUsageObservation(metering.attempt, transportId, requestId, payload?.usage),
        evidence: {
          ...(requestId ? { provider_request_ref: requestId } : {}),
          ...(bytes && decodedImage ? { artifact_sha256: digest(bytes) } : {}),
          ...(decodedImage ? { artifact_width: decodedImage.width, artifact_height: decodedImage.height } : {}),
          completed_at: new Date().toISOString(),
          service: target.service,
          endpoint: target.endpoint,
          model: target.model,
          sdk_name: target.sdk.name,
          sdk_version: target.sdk.version,
          configuration_sha256: target.configuration_sha256,
        },
      };
    },
  });
}
