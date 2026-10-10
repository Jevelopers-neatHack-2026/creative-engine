import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { createOpenAIImagesAdapter } from '../../src/preflight/index.mjs';
import { accessPlan, createMockAccessFixture, fixtureScope } from '../../fixtures/preflight/access-ports.mjs';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(name, data) {
  const type = Buffer.from(name, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, checksum]);
}

function makePng(width, height, { trailingCompressedBytes = Buffer.alloc(0) } = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0;
  const scanlines = Buffer.alloc((width + 1) * height);
  const compressed = Buffer.concat([deflateSync(scanlines), trailingCompressedBytes]);
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function scopedCredentialPort({ wrongAccount = false, wrongOrganization = false, wrongProject = false, wrongTarget = false, wrongGrant = false } = {}) {
  const calls = [];
  return {
    calls,
    port: {
      evidence_mode: 'live',
      async resolveCredential(input) {
        calls.push(input);
        return {
          decision: 'resolved',
          evidence_mode: 'live',
          binding: {
            service: input.service,
            account_ref: wrongAccount ? 'org_foreign_fixture' : input.account_ref,
            project_ref: input.project_ref,
            target_binding_sha256: wrongTarget ? digest('foreign target') : digest(JSON.stringify(input.target_binding)),
            ...(input.grant_ref ? { grant_ref: wrongGrant ? 'test:foreign-grant' : input.grant_ref } : {}),
          },
          provider_scope: {
            organization_id: wrongOrganization ? 'org_foreign_fixture' : input.account_ref,
            project_id: wrongProject ? 'proj_wrong_fixture' : input.project_ref,
          },
          token: 'sk-live-fixture-only-never-a-real-credential',
          expires_at: '2099-01-01T00:00:00.000Z',
          evidence: {
            ref: 'test:credential-resolver-evidence',
            sha256: digest('credential resolver evidence'),
            pinned_revision: 'test:credential-resolver-v1',
            independent_review: {
              ref: 'test:credential-resolver-review',
              sha256: digest('credential resolver review'),
            },
          },
        };
      },
    },
  };
}

function imageTarget(cellId = 'image_generation') {
  const plan = accessPlan({ cellId });
  const cell = plan.cells.find((row) => row.cell_id === cellId);
  return { target: cell.target, deadline_at: cell.spend.deadline_at };
}

async function withInterceptedFetch(handler, action) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await action();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function completeUsage() {
  return { input_tokens: 1, output_tokens: 2, total_tokens: 3 };
}

test('scoped credential resolution routes both GET and billable POST to the exact account/project', async () => {
  const { target, deadline_at } = imageTarget();
  const credential = scopedCredentialPort();
  const prompt = 'test prompt for image_generation';
  const adapter = createOpenAIImagesAdapter({
    credentialPort: credential.port,
    promptPort: { async resolve() { return prompt; } },
  });
  const fixture = createMockAccessFixture();
  const png = makePng(1024, 1024);
  const requests = [];
  await withInterceptedFetch(async (url, options) => {
    requests.push({ url: String(url), options });
    if (options.method === 'GET') {
      return new Response(JSON.stringify({ data: [{ id: target.model }] }), { status: 200 });
    }
    return new Response(JSON.stringify({
      model: target.model,
      data: [{ b64_json: png.toString('base64') }],
      usage: completeUsage(),
    }), { status: 200, headers: { 'x-request-id': 'person@example.invalid' } });
  }, async () => {
    const observation = await adapter.inspect({
      run_id: 'test:image-run', cell_id: 'image_generation', target, scope: fixtureScope,
    });
    assert.equal(observation.authentication, 'confirmed');
    assert.equal(observation.model_listing, 'listed');
    assert.equal(observation.operation_permission, 'unknown');
    const prepared = await adapter.prepare({
      run_id: 'test:image-run',
      cell_id: 'image_generation',
      target,
      configuration: target.configuration,
      scope: fixtureScope,
      grant_ref: 'test:grant-1',
      deadline_at,
      authorization_evidence: {},
    });
    assert.deepEqual(Object.keys(prepared), ['prompt']);
    const result = await adapter.dispatch({
      run_id: 'test:image-run',
      cell_id: 'image_generation',
      target,
      configuration: target.configuration,
      scope: fixtureScope,
      prepared,
      metering: {
        attempt: fixture.meteringRequest,
        signal: new AbortController().signal,
        async recordTransportAttempt(value) { assert.equal(value.startsWith('transport:'), true); },
      },
      deadline_at,
    });
    assert.equal(result.provider_outcome, 'succeeded');
    assert.equal(result.evidence.artifact_sha256, digest(png));
    assert.match(result.evidence.provider_request_ref, /^provider-request:[a-f0-9]{64}$/);
    assert.equal(result.usage_observation.completeness, 'complete');
    assert.doesNotMatch(JSON.stringify(result), /person@example\.invalid|sk-live-fixture|b64_json/);
  });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((request) => request.url), [
    'https://api.openai.com/v1/models',
    target.endpoint,
  ]);
  for (const request of requests) {
    const headers = new Headers(request.options.headers);
    assert.equal(headers.get('OpenAI-Organization'), fixtureScope.account_ref);
    assert.equal(headers.get('OpenAI-Project'), fixtureScope.project_ref);
    assert.equal(headers.get('authorization'), 'Bearer sk-live-fixture-only-never-a-real-credential');
    assert.equal(request.options.redirect, 'error');
  }
  assert.equal(credential.calls.length, 2);
  assert.equal(credential.calls[1].grant_ref, 'test:grant-1');
});

test('base64 text that is not a PNG cannot report operation success or an artifact hash', async () => {
  const { target, deadline_at } = imageTarget();
  const credential = scopedCredentialPort();
  const adapter = createOpenAIImagesAdapter({
    credentialPort: credential.port,
    promptPort: { async resolve() { return 'test prompt for image_generation'; } },
  });
  const fixture = createMockAccessFixture();
  const prepared = await adapter.prepare({
    run_id: 'test:bad-image-run', cell_id: 'image_generation', target,
    configuration: target.configuration, scope: fixtureScope,
    grant_ref: 'test:grant-1', deadline_at, authorization_evidence: {},
  });
  await withInterceptedFetch(async () => new Response(JSON.stringify({
    model: target.model, data: [{ b64_json: Buffer.from('hello').toString('base64') }],
  }), { status: 200, headers: { 'x-request-id': 'request-opaque-1' } }), async () => {
    const result = await adapter.dispatch({
      run_id: 'test:bad-image-run', cell_id: 'image_generation', target,
      configuration: target.configuration, scope: fixtureScope, prepared,
      metering: { attempt: fixture.meteringRequest, async recordTransportAttempt() {} }, deadline_at,
    });
    assert.equal(result.provider_outcome, 'failed');
    assert.equal(result.evidence.artifact_sha256, undefined);
  });
});

test('PNG structure with a bad CRC cannot report operation success or an artifact hash', async () => {
  const { target, deadline_at } = imageTarget();
  const credential = scopedCredentialPort();
  const adapter = createOpenAIImagesAdapter({
    credentialPort: credential.port,
    promptPort: { async resolve() { return 'test prompt for image_generation'; } },
  });
  const fixture = createMockAccessFixture();
  const prepared = await adapter.prepare({
    run_id: 'test:bad-crc-run', cell_id: 'image_generation', target,
    configuration: target.configuration, scope: fixtureScope,
    grant_ref: 'test:grant-1', deadline_at, authorization_evidence: {},
  });
  const badPng = makePng(1024, 1024);
  badPng[29] ^= 0xff;
  await withInterceptedFetch(async () => new Response(JSON.stringify({
    model: target.model, data: [{ b64_json: badPng.toString('base64') }],
  }), { status: 200 }), async () => {
    const result = await adapter.dispatch({
      run_id: 'test:bad-crc-run', cell_id: 'image_generation', target,
      configuration: target.configuration, scope: fixtureScope, prepared,
      metering: { attempt: fixture.meteringRequest, async recordTransportAttempt() {} }, deadline_at,
    });
    assert.equal(result.provider_outcome, 'failed');
    assert.equal(result.evidence.artifact_sha256, undefined);
  });
});

test('only an intact PNG at the pinned output dimensions can succeed', async () => {
  const { target, deadline_at } = imageTarget();
  const credential = scopedCredentialPort();
  const adapter = createOpenAIImagesAdapter({
    credentialPort: credential.port,
    promptPort: { async resolve() { return 'test prompt for image_generation'; } },
  });
  const fixture = createMockAccessFixture();
  const prepared = await adapter.prepare({
    run_id: 'test:format-dimensions-run', cell_id: 'image_generation', target,
    configuration: target.configuration, scope: fixtureScope,
    grant_ref: 'test:grant-1', deadline_at, authorization_evidence: {},
  });
  const malformedDeflate = makePng(1024, 1024);
  const idatOffset = malformedDeflate.indexOf(Buffer.from('IDAT'));
  const idatLength = malformedDeflate.readUInt32BE(idatOffset - 4);
  const idatDataOffset = idatOffset + 4;
  malformedDeflate[idatDataOffset] ^= 0xff;
  malformedDeflate.writeUInt32BE(
    crc32(malformedDeflate.subarray(idatOffset, idatDataOffset + idatLength)),
    idatDataOffset + idatLength,
  );
  const images = [
    { name: 'JPEG bytes under the PNG pin', bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), accepted: false },
    { name: 'PNG with a corrupt compressed stream and recomputed chunk CRC', bytes: malformedDeflate, accepted: false },
    { name: 'PNG with trailing bytes after its zlib stream', bytes: makePng(1024, 1024, { trailingCompressedBytes: Buffer.from('tail') }), accepted: false },
    { name: 'valid PNG with a non-pinned size', bytes: makePng(512, 512), accepted: false },
    { name: 'valid PNG at the pinned size', bytes: makePng(1024, 1024), accepted: true },
  ];
  for (const [index, image] of images.entries()) {
    await withInterceptedFetch(async () => new Response(JSON.stringify({
      model: target.model,
      data: [{ b64_json: image.bytes.toString('base64') }],
      usage: completeUsage(),
    }), { status: 200 }), async () => {
      const result = await adapter.dispatch({
        run_id: `test:format-dimensions-${index}`, cell_id: 'image_generation', target,
        configuration: target.configuration, scope: fixtureScope, prepared,
        metering: { attempt: fixture.meteringRequest, async recordTransportAttempt() {} }, deadline_at,
      });
      assert.equal(result.provider_outcome, image.accepted ? 'succeeded' : 'failed', image.name);
      if (image.accepted) {
        assert.equal(result.evidence.artifact_sha256, digest(image.bytes));
        assert.equal(result.evidence.artifact_width, 1024);
        assert.equal(result.evidence.artifact_height, 1024);
      } else if (image.name !== 'valid PNG with a non-pinned size') {
        assert.equal(result.evidence.artifact_sha256, undefined, image.name);
      } else {
        assert.equal(result.evidence.artifact_sha256, digest(image.bytes));
        assert.equal(result.evidence.artifact_width, 512);
        assert.equal(result.evidence.artifact_height, 512);
      }
    });
  }
});

test('oversized provider JSON response is rejected from its declared length', async () => {
  const { target } = imageTarget();
  const credential = scopedCredentialPort();
  const adapter = createOpenAIImagesAdapter({ credentialPort: credential.port, promptPort: { async resolve() { return 'unused'; } } });
  await withInterceptedFetch(async () => new Response('{}', {
    status: 200,
    headers: { 'content-length': String(1024 * 1024 * 1024) },
  }), async () => {
    await assert.rejects(() => adapter.inspect({
      run_id: 'test:oversized-response', cell_id: 'image_generation', target, scope: fixtureScope,
    }), (error) => error.code === 'provider_response_invalid');
  });
});

test('wrong runtime pin or wrong credential project blocks before a request is sent', async () => {
  for (const wrongProject of [false, true]) {
    const { target, deadline_at } = imageTarget();
    const credential = scopedCredentialPort({ wrongProject });
    const adapter = createOpenAIImagesAdapter({ credentialPort: credential.port, promptPort: { async resolve() { return 'unused'; } } });
    const invalidTarget = { ...target, sdk: { ...target.sdk, version: 'not-actually-validated' } };
    let requests = 0;
    await withInterceptedFetch(async () => { requests += 1; return new Response('{}', { status: 200 }); }, async () => {
      if (wrongProject) {
        await assert.rejects(() => adapter.inspect({
          run_id: 'test:scope-fail', cell_id: 'image_generation', target, scope: fixtureScope,
        }), (error) => error.code === 'credential_unavailable');
      } else {
        await assert.rejects(() => adapter.inspect({
          run_id: 'test:runtime-fail', cell_id: 'image_generation', target: invalidTarget, scope: fixtureScope,
        }), (error) => error.code === 'unsupported_image_configuration');
      }
    });
    assert.equal(requests, 0);
    assert.equal(credential.calls.length, wrongProject ? 1 : 0);
    assert.ok(deadline_at);
  }
});

test('credential resolver must bind the exact account, target, and billable grant', async () => {
  for (const mismatch of ['wrongAccount', 'wrongOrganization', 'wrongTarget', 'wrongGrant']) {
    const { target, deadline_at } = imageTarget();
    const credential = scopedCredentialPort({ [mismatch]: true });
    const adapter = createOpenAIImagesAdapter({
      credentialPort: credential.port,
      promptPort: { async resolve() { return 'test prompt for image_generation'; } },
    });
    let requests = 0;
    await withInterceptedFetch(async () => { requests += 1; return new Response('{}', { status: 200 }); }, async () => {
      if (mismatch === 'wrongGrant') {
        await assert.rejects(() => adapter.prepare({
          run_id: `test:credential-${mismatch}`, cell_id: 'image_generation', target,
          configuration: target.configuration, scope: fixtureScope,
          grant_ref: 'test:grant-1', deadline_at, authorization_evidence: {},
        }), (error) => error.code === 'credential_unavailable');
      } else {
        await assert.rejects(() => adapter.inspect({
          run_id: `test:credential-${mismatch}`, cell_id: 'image_generation', target, scope: fixtureScope,
        }), (error) => error.code === 'credential_unavailable');
      }
    });
    assert.equal(requests, 0);
    assert.equal(credential.calls.length, 1);
  }
});

test('image edit source bytes must be a pinned decodable PNG before scoped credentials resolve', async () => {
  const { target, deadline_at } = imageTarget('image_edit');
  const credential = scopedCredentialPort();
  const adapter = createOpenAIImagesAdapter({
    credentialPort: credential.port,
    promptPort: { async resolve() { return 'test prompt for image_edit'; } },
    assetPort: { async read() { return Buffer.from('test source image bytes'); } },
  });
  await assert.rejects(() => adapter.prepare({
    run_id: 'test:edit-source-run', cell_id: 'image_edit', target,
    configuration: target.configuration, scope: fixtureScope,
    grant_ref: 'test:grant-1', deadline_at, authorization_evidence: {},
  }), (error) => error.code === 'asset_hash_mismatch');
  assert.equal(credential.calls.length, 0);
});
