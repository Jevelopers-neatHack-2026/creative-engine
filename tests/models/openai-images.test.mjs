import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  OPENAI_IMAGE_CANDIDATE_PROFILES,
  OpenAIImagesProviderError,
  createOpenAIImagesProvider,
  evaluateOpenAIImageRetry,
  inspectOpenAIImageBytes,
  normalizeOpenAIImageUsage,
} from "../../src/models/openai-images.mjs";
import { readPrivateOpenAIImageRequestId } from "../../src/models/openai-images.mjs";
import { corruptPngCrc, makeInvalidIndexedPng, makePng, makePng16Rgba } from "../../fixtures/models/png.mjs";

const MODEL = "gpt-image-2.5-sunburst-2026-09-08";
const NOW = Date.parse("2026-10-10T18:00:00.000Z");
const HASH = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const TEST_HASH = `sha256:${"a".repeat(64)}`;
const JPEG = readFileSync(new URL("../../fixtures/models/valid-16x16.jpg", import.meta.url));
const WEBP = readFileSync(new URL("../../fixtures/models/valid-16x16.webp", import.meta.url));

function config(overrides = {}) {
  return { quality: "low", size: "16x16", output_format: "png", background: "opaque", moderation: "auto", ...overrides };
}

function input(operation = "generate", overrides = {}) {
  const controller = new AbortController();
  const attempt = {
    schema_version: "creative.metering.proposal/v1",
    logical_operation_id: "logical-image-001",
    billable_attempt_id: "billable-image-001",
    retry_mapping_ref: "openai-images-direct/retry-policy-v1",
    environment: "test",
    billing_mode: "simulated",
    operation_kind: operation === "generate" ? "image_generation" : "image_edit",
    tenant_id: "tenant-test",
    project_id: "creative-project-test",
    budget_scope_id: "budget-test",
    budget: { scope_id: "budget-test", policy_version: "offline-fixture-v1" },
    provider: {
      name: "openai",
      model: MODEL,
      endpoint: operation === "generate" ? "https://api.openai.com/v1/images/generations" : "https://api.openai.com/v1/images/edits",
      sdk: { name: "native-fetch", version: process.versions.node },
    },
  };
  const plan = operation === "generate"
    ? { operation: "concept.generate", steps: [{ action: "image.generate", parameters: {} }] }
    : { operation: "image.edit", steps: [{ action: "image.edit", parameters: {
      design_version_id: "design-version-01", artifact_id: "parent-artifact-01", instruction: "Make the sky blue.", mask_source_ref: "mask-ref-01",
    } }] };
  return {
    scope: { tenant_id: attempt.tenant_id, project_id: attempt.project_id },
    actor_id: "actor-test",
    job_id: "job-test",
    attempt,
    brief: { brief_id: "brief-test", preferences: { items: [] } },
    base_design: operation === "edit" ? { design_version_id: "design-version-01", artifact: {
      artifact_id: "parent-artifact-01", content_hash: HASH(makePng()), media_type: "image/png",
    } } : null,
    plan,
    transport_attempt_id: "transport-image-001",
    dispatch_intent_ref: "dispatch-image-001",
    reservation_ref: "reservation-image-001",
    deadline_at: new Date(NOW + 60_000).toISOString(),
    signal: controller.signal,
    controller,
    recordTransportAttempt: async (id) => {
      assert.equal(id, "transport-image-001");
      return "dispatch-image-001";
    },
    ...overrides,
  };
}

function makeAuthorityPorts({ now = () => NOW, mutateCapability, mutateAuthority, events = [] } = {}) {
  const capabilityFor = (args) => {
    const value = {
      status: "verified",
      eligible: true,
      operation_permission: "allowed",
      quota_status: "available",
      service: "openai",
      account_ref: "org-fixture-01",
      project_ref: "proj-fixture-01",
      tenant_id: args.scope.tenant_id,
      project_id: args.scope.project_id,
      budget_scope_id: args.attempt.budget_scope_id,
      operation: args.operation,
      model: args.model,
      target_binding_sha256: args.target_binding_sha256,
      expires_at: new Date(NOW + 600_000).toISOString(),
      evidence_ref: "capability-proof-01",
      evidence_sha256: TEST_HASH,
      revoked: false,
    };
    return mutateCapability ? mutateCapability(value, args) : value;
  };
  const authorityFor = (args) => {
    const grant = {
      service: "openai",
      grant_ref: "grant-fixture-01",
      account_ref: "org-fixture-01",
      project_ref: "proj-fixture-01",
      tenant_id: args.scope.tenant_id,
      project_id: args.scope.project_id,
      target_binding_sha256: args.target_binding_sha256,
      operation: args.operation,
      model: MODEL,
      permission: "allowed",
      revoked: false,
      expires_at: new Date(NOW + 600_000).toISOString(),
      evidence_ref: "grant-evidence-01",
      evidence_sha256: TEST_HASH,
    };
    const finance = {
      status: "held",
      revoked: false,
      reservation_ref: args.reservation_ref,
      billable_attempt_id: args.billable_attempt_id,
      budget_scope_id: args.budget_scope_id,
      lease_ref: "finance-lease-01",
      grant_ref: grant.grant_ref,
      account_ref: grant.account_ref,
      project_ref: grant.project_ref,
      tenant_id: args.scope.tenant_id,
      project_id: args.scope.project_id,
      provider: "openai",
      model: MODEL,
      operation: args.operation,
      target_binding_sha256: args.target_binding_sha256,
      held_amount: { amount: "0.75", currency: "USD" },
      authorized_cap: { amount: "1.00", currency: "USD" },
      expires_at: new Date(NOW + 600_000).toISOString(),
      evidence_ref: "finance-evidence-01",
      evidence_sha256: TEST_HASH,
    };
    const value = { status: "authorized", revoked: false, grant, finance };
    return mutateAuthority ? mutateAuthority(value, args) : value;
  };
  return {
    capabilityPort: {
      async verify(args) { events.push("capability.verify"); return capabilityFor(args); },
      async revalidate(args) { events.push("capability.revalidate"); return capabilityFor(args); },
    },
    authorizationPort: {
      async revalidate(args) { events.push(`authority.${args.phase}`); return authorityFor(args); },
    },
  };
}

function responseImage(bytes = makePng(), usage = {
  input_tokens: 50,
  input_tokens_details: { text_tokens: 10, image_tokens: 40 },
  output_tokens: 50,
  output_tokens_details: { text_tokens: 10, image_tokens: 40 },
  total_tokens: 100,
}) {
  return new Response(JSON.stringify({ data: [{ b64_json: bytes.toString("base64") }], usage }), {
    status: 200, headers: { "content-type": "application/json", "x-request-id": "req-private-fixture-id" },
  });
}

function corruptJpegEntropy(bytes) {
  const copy = Buffer.from(bytes);
  const marker = copy.indexOf(Buffer.from([0xff, 0xda]));
  assert.notEqual(marker, -1, "fixture must contain a JPEG scan");
  const segmentLength = copy.readUInt16BE(marker + 2);
  const scanStart = marker + 2 + segmentLength;
  // An unstuffed 0xff followed by a marker inside the coded scan is invalid.
  copy[scanStart] = 0xff;
  copy[scanStart + 1] = 0xd9;
  return copy;
}

function shortStructurallyValidWebp() {
  const bytes = Buffer.alloc(26);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WEBPVP8L", 8);
  bytes.writeUInt32LE(6, 16);
  bytes[20] = 0x2f;
  bytes.writeUInt32LE(15 | (15 << 14), 21);
  bytes[25] = 0;
  return bytes;
}

function truncatedButConsistentWebp(bytes) {
  const copy = Buffer.from(bytes.subarray(0, bytes.length - 2));
  copy.writeUInt32LE(copy.length - 8, 4);
  copy.writeUInt32LE(bytes.readUInt32LE(16) - 1, 16);
  return copy;
}

function providerHarness({ operation = "generate", outputBytes = makePng(), usage, configOverride = {}, configuration, fetchImpl, ports = {}, now = () => NOW, inputOverride = {}, assetPort, promptPort } = {}) {
  const events = ports.events ?? [];
  const authority = makeAuthorityPorts({ now, events, ...ports });
  let fetchCount = 0;
  const interceptedFetch = fetchImpl ?? (async () => responseImage(outputBytes, usage));
  const provider = createOpenAIImagesProvider({
    model_id: MODEL,
    configuration: configuration ?? config(configOverride),
    ...authority,
    credentialPort: {
      async resolveCredential(args) {
        events.push("credential.resolve");
        return {
          status: "resolved",
          token: "synthetic-offline-token",
          binding: { service: "openai", account_ref: args.account_ref, project_ref: args.project_ref,
            grant_ref: args.grant_ref, target_binding_sha256: args.target_binding_sha256 },
          provider_scope: { organization_id: args.account_ref, project_id: args.project_ref },
          expires_at: new Date(NOW + 300_000).toISOString(),
          evidence: { ref: "credential-evidence-01", sha256: TEST_HASH },
        };
      },
    },
    promptPort: promptPort ?? { render: async () => "A synthetic offline test image." },
    assetPort,
    fetchImpl: async (url, init) => {
      events.push("fetch.called");
      fetchCount += 1;
      return interceptedFetch(url, init);
    },
    now,
    idFactory: () => "generated-artifact-01",
  });
  const ctx = input(operation, inputOverride);
  return { provider, ctx, events, get fetchCount() { return fetchCount; } };
}

test("explicit candidate pins remain unevaluated and prototype model names are rejected", () => {
  assert.equal(OPENAI_IMAGE_CANDIDATE_PROFILES[MODEL].documentation_status, "candidate_unselected");
  assert.throws(() => createOpenAIImagesProvider({ model_id: "toString", configuration: config() }), (error) =>
    error instanceof OpenAIImagesProviderError && error.code === "unsupported_model_profile");
  assert.throws(() => createOpenAIImagesProvider({ model_id: "constructor", configuration: config() }), OpenAIImagesProviderError);
});

test("generation posts the documented direct JSON request once after C03 acknowledgement", async () => {
  const harness = providerHarness();
  const output = await harness.provider.generate(harness.ctx);
  assert.equal(harness.fetchCount, 1);
  assert.equal(harness.events.filter((event) => event.startsWith("authority.")).length, 2);
  assert.ok(harness.events.indexOf("authority.post_transport_ack") < harness.events.indexOf("capability.revalidate"));
  assert.ok(harness.events.indexOf("capability.revalidate") < harness.events.indexOf("fetch.called"));
  assert.equal(output.provider, "openai");
  assert.equal(output.model, MODEL);
  assert.equal(output.artifact.content_hash, HASH(makePng()));
  assert.equal(output.artifact.media_type, "image/png");
  assert.deepEqual(Buffer.from(output.artifact_bytes), makePng());
  assert.equal(output.usage.completeness, "unknown");
  assert.deepEqual(output.usage.input_tokens_details, { text_tokens: 10, image_tokens: 40 });
  assert.equal(output.usage.input_tokens, 50);
  assert.equal(output.usage.total_tokens, 100);
  assert.equal(output.usage.transport_attempt_id, "transport-image-001");
  assert.match(output.usage.provider_request_id, /^provider-request-[a-f0-9]{64}$/);
  assert.equal(readPrivateOpenAIImageRequestId(output.usage), "req-private-fixture-id");
  assert.doesNotMatch(JSON.stringify(output), /req-private-fixture-id|synthetic-offline-token/);
});

test("authorization binding stores hashes of the exact immutable plan and rendered prompt", async () => {
  let binding;
  const harness = providerHarness({ ports: { mutateCapability: (value, args) => {
    binding = args.target_binding;
    return value;
  } } });
  await harness.provider.generate(harness.ctx);
  assert.equal(binding.prompt_sha256, HASH("A synthetic offline test image."));
  assert.equal(binding.plan_sha256, HASH(JSON.stringify(harness.ctx.plan)));
  assert.match(binding.input_sha256, /^sha256:[a-f0-9]{64}$/);
});

test("caller mutation after invocation cannot alter the snapshotted edit plan", async () => {
  let renderedInstruction;
  let posted;
  const harness = providerHarness({ operation: "edit",
    promptPort: { async render({ plan }) {
      renderedInstruction = plan.steps[0].parameters.instruction;
      return `Prompt for: ${renderedInstruction}`;
    } },
    assetPort: { async readArtifact() { return makePng(); }, async readReference() { return makePng({ transparent: true }); } },
    fetchImpl: async (url, init) => { posted = { url, init }; return responseImage(); },
  });
  const result = harness.provider.edit(harness.ctx);
  harness.ctx.plan.steps[0].parameters.instruction = "Changed by caller after dispatch began.";
  await result;
  assert.equal(renderedInstruction, "Make the sky blue.");
  assert.equal(posted.init.body.get("prompt"), "Prompt for: Make the sky blue.");
});

test("generation request has exact model, one output, explicit size/quality/format and no SDK client", async () => {
  let posted;
  const harness = providerHarness({ fetchImpl: async (url, init) => {
    posted = { url, init };
    return responseImage();
  } });
  await harness.provider.generate(harness.ctx);
  assert.equal(posted.url, "https://api.openai.com/v1/images/generations");
  assert.equal(posted.init.method, "POST");
  assert.equal(posted.init.redirect, "error");
  assert.equal(posted.init.cache, "no-store");
  assert.equal(posted.init.signal, harness.ctx.signal);
  const body = JSON.parse(posted.init.body);
  assert.deepEqual(body, { model: MODEL, prompt: "A synthetic offline test image.", n: 1,
    size: "16x16", quality: "low", output_format: "png", background: "opaque", moderation: "auto" });
  assert.equal(posted.init.headers["OpenAI-Organization"], "org-fixture-01");
  assert.equal(posted.init.headers["OpenAI-Project"], "proj-fixture-01");
});

test("configuration is pinned when the provider is constructed", async () => {
  const mutableConfiguration = config();
  let postedBody;
  const harness = providerHarness({ configuration: mutableConfiguration, fetchImpl: async (_url, init) => {
    postedBody = JSON.parse(init.body);
    return responseImage();
  } });
  mutableConfiguration.size = "32x32";
  await harness.provider.generate(harness.ctx);
  assert.equal(postedBody.size, "16x16");
});

test("edit sends scoped immutable parent and matching alpha mask as multipart bytes", async () => {
  const parent = makePng();
  const mask = makePng({ transparent: true });
  const assetReads = [];
  let binding;
  let posted;
  const harness = providerHarness({
    operation: "edit",
    outputBytes: makePng({ transparent: true }),
    configOverride: { background: "transparent" },
    ports: { mutateCapability: (value, args) => { binding = args.target_binding; return value; } },
    assetPort: {
      async readArtifact(args) { assetReads.push(args); return parent; },
      async readReference(args) { assetReads.push(args); return mask; },
    },
    fetchImpl: async (url, init) => { posted = { url, init }; return responseImage(makePng({ transparent: true })); },
  });
  const output = await harness.provider.edit(harness.ctx);
  assert.equal(output.artifact.media_type, "image/png");
  assert.equal(posted.url, "https://api.openai.com/v1/images/edits");
  assert.equal(posted.init.method, "POST");
  assert.equal(posted.init.headers["content-type"], undefined);
  assert.equal(posted.init.body.get("model"), MODEL);
  assert.equal(posted.init.body.get("prompt"), "A synthetic offline test image.");
  assert.equal(posted.init.body.get("n"), "1");
  assert.deepEqual(Buffer.from(await posted.init.body.get("image[]").arrayBuffer()), parent);
  assert.deepEqual(Buffer.from(await posted.init.body.get("mask").arrayBuffer()), mask);
  assert.deepEqual(assetReads.map((entry) => entry.artifact_id ?? entry.source_ref), ["parent-artifact-01", "mask-ref-01"]);
  assert.equal(binding.parent_artifact_sha256, HASH(parent));
  assert.equal(binding.mask_content_sha256, HASH(mask));
  assert.match(binding.input_sha256, /^sha256:[a-f0-9]{64}$/);
});

test("unsupported extra edit references and additional edit steps fail before asset access or transport", async (t) => {
  await t.test("extra reference image parameter", async () => {
    const ctx = input("edit");
    ctx.plan.steps[0].parameters.reference_image_refs = ["image-reference-02"];
    let assetReads = 0;
    const harness = providerHarness({ operation: "edit", inputOverride: ctx,
      assetPort: { async readArtifact() { assetReads += 1; return makePng(); } } });
    await assert.rejects(harness.provider.edit(harness.ctx), (error) => error.code === "unsupported_plan");
    assert.equal(assetReads, 0);
    assert.equal(harness.fetchCount, 0);
  });
  await t.test("multiple edit steps", async () => {
    const ctx = input("edit");
    ctx.plan.steps.push({ ...ctx.plan.steps[0], step_id: "step-image-002" });
    let assetReads = 0;
    const harness = providerHarness({ operation: "edit", inputOverride: ctx,
      assetPort: { async readArtifact() { assetReads += 1; return makePng(); } } });
    await assert.rejects(harness.provider.edit(harness.ctx), (error) => error.code === "unsupported_plan");
    assert.equal(assetReads, 0);
    assert.equal(harness.fetchCount, 0);
  });
});

test("denied, cross-scope, substituted, or malformed edit assets never reach provider transport", async (t) => {
  const cases = [
    ["denied mask source", { assetPort: { async readArtifact() { return makePng(); },
      async readReference() { throw new Error("Bearer private-mask-denial"); } }, expected: "mask_unavailable" }],
    ["wrong mask dimensions", { assetPort: { async readArtifact() { return makePng(); },
      async readReference() { return makePng({ width: 32, transparent: true }); } }, expected: "mask_invalid" }],
    ["mask lacks transparent pixels", { assetPort: { async readArtifact() { return makePng(); },
      async readReference() { return makePng(); } }, expected: "mask_invalid" }],
    ["parent byte substitution", { assetPort: { async readArtifact() { return makePng({ width: 32 }); },
      async readReference() { return makePng({ transparent: true }); } }, expected: "asset_integrity_error" }],
    ["cross-scope runtime context", { inputOverride: { scope: { tenant_id: "tenant-foreign", project_id: "project-foreign" } },
      assetPort: { async readArtifact() { return makePng(); }, async readReference() { return makePng({ transparent: true }); } }, expected: "provider_attempt_mismatch" }],
  ];
  for (const [name, options] of cases) await t.test(name, async () => {
    const harness = providerHarness({ operation: "edit", ...options });
    await assert.rejects(harness.provider.edit(harness.ctx), (error) => {
      assert.equal(error.code, options.expected);
      if (name === "denied mask source") assert.doesNotMatch(JSON.stringify(error), /private-mask-denial|Bearer/);
      return true;
    });
    assert.equal(harness.fetchCount, 0);
  });
});

test("decoded image fixtures validate dimensions and reject CRC, truncated, indexed, or corrupt payloads", async () => {
  const png = makePng();
  assert.deepEqual(await inspectOpenAIImageBytes(png), {
    format: "png", width: 16, height: 16, has_alpha: true, has_transparency: false,
  });
  assert.equal((await inspectOpenAIImageBytes(makePng({ transparent: true }))).has_transparency, true);
  assert.deepEqual(await inspectOpenAIImageBytes(JPEG), {
    format: "jpeg", width: 16, height: 16, has_alpha: false, has_transparency: false,
  });
  assert.deepEqual(await inspectOpenAIImageBytes(WEBP), {
    format: "webp", width: 16, height: 16, has_alpha: false, has_transparency: false,
  });
  for (const bytes of [corruptPngCrc(png), makeInvalidIndexedPng(), png.subarray(0, png.length - 4),
    corruptJpegEntropy(JPEG), Buffer.from("hello")]) {
    await assert.rejects(inspectOpenAIImageBytes(bytes), (error) => error.code === "image_bytes_invalid");
  }
});

test("image byte inspection rejects invalid views before copying and uses intrinsic byte length", async () => {
  // This impostor passes instanceof without backing storage, so it can exercise the
  // pre-copy boundary without allocating a 50 MiB fixture.
  const oversized = Object.create(Uint8Array.prototype);
  Object.defineProperty(oversized, "byteLength", { value: 50 * 1024 * 1024 + 1 });
  const originalFrom = Buffer.from;
  const originalAllocUnsafe = Buffer.allocUnsafe;
  let copyAttempts = 0;
  Buffer.from = function (value, ...args) {
    if (value === oversized) copyAttempts += 1;
    return originalFrom.call(Buffer, value, ...args);
  };
  Buffer.allocUnsafe = function (size, ...args) {
    if (size > 50 * 1024 * 1024) copyAttempts += 1;
    return originalAllocUnsafe.call(Buffer, size, ...args);
  };
  try {
    await assert.rejects(inspectOpenAIImageBytes(oversized), (error) => error.code === "image_bytes_invalid");
  } finally {
    Buffer.from = originalFrom;
    Buffer.allocUnsafe = originalAllocUnsafe;
  }
  assert.equal(copyAttempts, 0, "invalid or oversized inputs must fail before any proportional copy");

  const valid = makePng();
  Object.defineProperty(valid, "byteLength", { value: 50 * 1024 * 1024 + 1 });
  assert.equal((await inspectOpenAIImageBytes(valid)).width, 16,
    "a shadowed byteLength property must not override the actual bounded view length");
});

test("16-bit PNG alpha transparency is checked before 8-bit quantization", async () => {
  for (const [alpha, hasTransparency] of [[0xffff, false], [0xfffe, true], [0xffdc, true], [0xfde8, true], [0, true]]) {
    const bytes = makePng16Rgba({ alpha });
    assert.deepEqual(await inspectOpenAIImageBytes(bytes), {
      format: "png", width: 16, height: 16, has_alpha: true, has_transparency: hasTransparency,
    }, `unexpected decoded transparency for 16-bit alpha ${alpha}`);
  }
  const partiallyTransparent = makePng16Rgba({ alpha: 0xfffe });
  const harness = providerHarness({ outputBytes: partiallyTransparent });
  const output = await harness.provider.generate(harness.ctx);
  assert.equal(harness.fetchCount, 1);
  assert.equal(output.artifact.content_hash, HASH(partiallyTransparent));
  assert.deepEqual(Buffer.from(output.artifact_bytes), partiallyTransparent);
});

test("WebP artifacts require bounded pixel decoding, not a RIFF/frame header", async (t) => {
  const corruptPayload = Buffer.from(WEBP);
  corruptPayload[25] = 0;
  const malformedCases = [
    ["header-only VP8L frame", shortStructurallyValidWebp()],
    ["truncated coded payload with consistent chunk lengths", truncatedButConsistentWebp(WEBP)],
    ["corrupt coded payload with intact container", corruptPayload],
  ];
  for (const [name, bytes] of malformedCases) await t.test(name, async () => {
    await assert.rejects(inspectOpenAIImageBytes(bytes), (error) => error.code === "image_bytes_invalid");
  });
  await t.test("valid WebP output passes the real decoder before publication", async () => {
    const harness = providerHarness({ configOverride: { output_format: "webp" }, outputBytes: WEBP });
    const output = await harness.provider.generate(harness.ctx);
    assert.equal(harness.fetchCount, 1);
    assert.equal(output.artifact.media_type, "image/webp");
    assert.deepEqual(Buffer.from(output.artifact_bytes), WEBP);
  });
  await t.test("invalid WebP output preserves known usage but publishes no artifact", async () => {
    const harness = providerHarness({ configOverride: { output_format: "webp" }, outputBytes: shortStructurallyValidWebp() });
    await assert.rejects(harness.provider.generate(harness.ctx), (error) => {
      assert.equal(error.code, "image_bytes_invalid");
      assert.equal(error.usage.input_tokens, 50);
      assert.equal(error.usage.completeness, "unknown");
      assert.equal(error.provider_outcome, "unknown");
      return true;
    });
    assert.equal(harness.fetchCount, 1);
  });
  await t.test("invalid WebP edit parent is rejected before provider dispatch", async () => {
    const bytes = shortStructurallyValidWebp();
    const ctx = input("edit");
    ctx.base_design.artifact.content_hash = HASH(bytes);
    ctx.base_design.artifact.media_type = "image/webp";
    const harness = providerHarness({ operation: "edit", inputOverride: ctx,
      assetPort: { async readArtifact() { return bytes; } } });
    await assert.rejects(harness.provider.edit(harness.ctx), (error) => error.code === "image_bytes_invalid");
    assert.equal(harness.fetchCount, 0);
  });
});

test("all advertised output formats pass the full bounded decoder before publication", async (t) => {
  for (const [format, bytes] of [["png", makePng()], ["jpeg", JPEG], ["webp", WEBP]]) {
    await t.test(format, async () => {
      const harness = providerHarness({ configOverride: { output_format: format }, outputBytes: bytes });
      const result = await harness.provider.generate(harness.ctx);
      assert.equal(result.artifact.media_type, `image/${format}`);
      assert.deepEqual(Buffer.from(result.artifact_bytes), bytes);
      assert.equal(harness.fetchCount, 1);
    });
  }
});

test("output outside pinned dimensions, ratio, edge, alpha, or format is not published", async (t) => {
  const cases = [
    { name: "wrong width", outputBytes: makePng({ width: 32 }) },
    { name: "wrong format", outputBytes: JPEG },
    { name: "no alpha channel for transparent output", configOverride: { background: "transparent", output_format: "webp" }, outputBytes: WEBP },
    { name: "outside dimensions", configOverride: { size: "4096x16" } },
  ];
  for (const item of cases) await t.test(item.name, async () => {
    if (item.name === "outside dimensions") {
      assert.throws(() => createOpenAIImagesProvider({ model_id: MODEL, configuration: config(item.configOverride ?? { size: "4096x16" }) }), OpenAIImagesProviderError);
      return;
    }
    const harness = providerHarness(item);
    await assert.rejects(harness.provider.generate(harness.ctx), OpenAIImagesProviderError);
    assert.equal(harness.fetchCount, 1);
  });
});

test("operation permissions and all trusted grant, capability, and Finance bindings fail closed", async (t) => {
  const scenarios = [
    ["unknown capability", { mutateCapability: (value) => ({ ...value, status: "unknown" }) }],
    ["operation denied", { mutateCapability: (value) => ({ ...value, operation_permission: "denied" }) }],
    ["quota unknown", { mutateCapability: (value) => ({ ...value, quota_status: "unknown" }) }],
    ["cross account", { mutateCapability: (value) => ({ ...value, account_ref: "org-foreign" }) }],
    ["grant mismatch", { mutateAuthority: (value) => ({ ...value, grant: { ...value.grant, target_binding_sha256: TEST_HASH } }) }],
    ["revoked grant", { mutateAuthority: (value) => ({ ...value, revoked: true }) }],
    ["wrong reservation", { mutateAuthority: (value) => ({ ...value, finance: { ...value.finance, reservation_ref: "reservation-foreign" } }) }],
    ["wrong account", { mutateAuthority: (value) => ({ ...value, finance: { ...value.finance, account_ref: "org-foreign" } }) }],
    ["over-cap hold", { mutateAuthority: (value) => ({ ...value, finance: { ...value.finance, held_amount: { amount: "1.01", currency: "USD" } } }) }],
    ["currency mismatch", { mutateAuthority: (value) => ({ ...value, finance: { ...value.finance, authorized_cap: { amount: "1.00", currency: "EUR" } } }) }],
    ["missing exact cap", { mutateAuthority: (value) => ({ ...value, finance: { ...value.finance, authorized_cap: undefined } }) }],
    ["expired Finance lease", { mutateAuthority: (value) => ({ ...value, finance: { ...value.finance, expires_at: new Date(NOW - 1).toISOString() } }) }],
  ];
  for (const [name, ports] of scenarios) await t.test(name, async () => {
    const harness = providerHarness({ ports });
    await assert.rejects(harness.provider.generate(harness.ctx), OpenAIImagesProviderError);
    assert.equal(harness.fetchCount, 0);
  });
});

test("reservation, operation identity, and distinct attempt identities are required", async (t) => {
  const scenarios = [
    ["no reservation", { reservation_ref: undefined }],
    ["transport aliases billable", { transport_attempt_id: "billable-image-001" }],
    ["reservation aliases dispatch", { reservation_ref: "dispatch-image-001" }],
  ];
  for (const [name, override] of scenarios) await t.test(name, async () => {
    const harness = providerHarness({ inputOverride: override });
    await assert.rejects(harness.provider.generate(harness.ctx), OpenAIImagesProviderError);
    assert.equal(harness.fetchCount, 0);
  });
});

test("credential scope mismatch or credential resolver exception is sanitized before transport", async (t) => {
  for (const mode of ["scope", "throw"]) await t.test(mode, async () => {
    const authority = makeAuthorityPorts();
    let fetchCount = 0;
    const provider = createOpenAIImagesProvider({
      model_id: MODEL, configuration: config(), ...authority,
      credentialPort: { async resolveCredential(args) {
        if (mode === "throw") throw Object.assign(new Error("Bearer credential-private-value"), { authorization: "Bearer private" });
        return { status: "resolved", token: "synthetic-token", binding: {
          service: "openai", account_ref: args.account_ref, project_ref: "proj-foreign",
          grant_ref: args.grant_ref, target_binding_sha256: args.target_binding_sha256,
        }, provider_scope: { organization_id: args.account_ref, project_id: "proj-foreign" },
        expires_at: new Date(NOW + 300_000).toISOString(), evidence: { ref: "cred-ref", sha256: TEST_HASH } };
      } },
      promptPort: { render: () => "test" }, fetchImpl: async () => { fetchCount += 1; return responseImage(); }, now: () => NOW,
    });
    const ctx = input();
    await assert.rejects(provider.generate(ctx), (error) => {
      assert.equal(error instanceof OpenAIImagesProviderError, true);
      assert.doesNotMatch(JSON.stringify(error), /credential-private-value|Bearer private/);
      return true;
    });
    assert.equal(fetchCount, 0);
  });
});

test("transport acknowledgement is awaited and must confirm the exact dispatch intent", async (t) => {
  for (const mode of ["reject", "mismatch"]) await t.test(mode, async () => {
    let fetchCount = 0;
    const harness = providerHarness({ fetchImpl: async () => { fetchCount += 1; return responseImage(); } });
    harness.ctx.recordTransportAttempt = async () => {
      if (mode === "reject") throw Object.assign(new Error("secret evidence"), { headers: { authorization: "secret" } });
      return "dispatch-foreign";
    };
    await assert.rejects(harness.provider.generate(harness.ctx), (error) => {
      assert.equal(error instanceof OpenAIImagesProviderError, true);
      assert.doesNotMatch(JSON.stringify(error), /secret evidence|authorization/);
      return true;
    });
    assert.equal(fetchCount, 0);
  });
});

test("grant revocation or expiry during C03 acknowledgement prevents POST and publication", async (t) => {
  for (const mode of ["revoked", "expired", "finance-lease-expired", "capability-revoked", "capability-expired", "credential-expired"]) await t.test(mode, async () => {
    let fetchCount = 0;
    let acknowledged = false;
    let clock = NOW;
    const harness = providerHarness({
      now: () => clock,
      ports: {
        mutateAuthority: (value, args) => {
          if (args.phase !== "post_transport_ack" || !acknowledged) return value;
          if (mode === "revoked") return { ...value, revoked: true };
          if (mode === "expired") return { ...value, grant: { ...value.grant, expires_at: new Date(NOW - 1).toISOString() } };
          if (mode === "finance-lease-expired") return { ...value, finance: { ...value.finance, expires_at: new Date(NOW - 1).toISOString() } };
          return value;
        },
        mutateCapability: (value, args) => mode === "capability-revoked" && args.phase === "post_transport_ack"
          ? { ...value, eligible: false, revoked: true }
          : mode === "capability-expired" && args.phase === "post_transport_ack"
            ? { ...value, expires_at: new Date(NOW - 1).toISOString() } : value,
      },
      fetchImpl: async () => { fetchCount += 1; return responseImage(); },
      inputOverride: { deadline_at: new Date(NOW + 600_000).toISOString(), recordTransportAttempt: async () => {
        acknowledged = true;
        if (mode === "credential-expired") clock = NOW + 300_001;
        return "dispatch-image-001";
      } },
    });
    await assert.rejects(harness.provider.generate(harness.ctx), (error) => ["authorization_unavailable", "model_capability_unverified", "dispatch_fence_closed"].includes(error.code));
    assert.equal(fetchCount, 0);
  });
});

test("abort at the final acknowledgement fence and abort after transport both prevent publication", async (t) => {
  await t.test("cancelled before final POST", async () => {
    let fetchCount = 0;
    const ctx = input();
    ctx.recordTransportAttempt = async () => { ctx.controller.abort(); return "dispatch-image-001"; };
    const harness = providerHarness({ fetchImpl: async () => { fetchCount += 1; return responseImage(); }, inputOverride: ctx });
    await assert.rejects(harness.provider.generate(harness.ctx), OpenAIImagesProviderError);
    assert.equal(fetchCount, 0);
  });
  await t.test("cancelled while response returns", async () => {
    const ctx = input();
    const harness = providerHarness({
      inputOverride: ctx,
      fetchImpl: async () => { ctx.controller.abort(); return responseImage(); },
    });
    await assert.rejects(harness.provider.generate(harness.ctx), (error) => error.code === "provider_outcome_unknown");
    assert.equal(harness.fetchCount, 1);
  });
});

test("HTTP refusals are typed, Retry-After is advisory, and automatic retry never redispatches", async (t) => {
  const scenarios = [[401, "authentication_denied"], [403, "operation_permission_denied"], [429, "provider_rate_limited"], [503, "provider_request_failed"]];
  for (const [status, code] of scenarios) await t.test(String(status), async () => {
    let fetchCount = 0;
    const harness = providerHarness({ fetchImpl: async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ error: { code: status === 429 ? "rate_limit_exceeded" : "fixture_error" } }), {
        status, headers: { "content-type": "application/json", "retry-after": "1" },
      });
    } });
    await assert.rejects(harness.provider.generate(harness.ctx), (error) => {
      assert.equal(error.code, code, `${error.name}: ${error.message}`);
      assert.equal(error.provider_outcome, status === 429 || status === 503 ? "unknown" : "failed");
      if (status === 429 || status === 503) assert.equal(error.retry.automatic_retry, false);
      return true;
    });
    assert.equal(fetchCount, 1);
  });
  await t.test("quota exhaustion is a hard stop without retry advice", async () => {
    let fetchCount = 0;
    const harness = providerHarness({ fetchImpl: async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ error: { code: "insufficient_quota" } }), {
        status: 429, headers: { "content-type": "application/json", "retry-after": "1" },
      });
    } });
    await assert.rejects(harness.provider.generate(harness.ctx), (error) => {
      assert.equal(error.code, "provider_quota_exhausted");
      assert.equal(error.provider_outcome, "failed");
      assert.equal(error.retry, undefined);
      return true;
    });
    assert.equal(fetchCount, 1);
  });
});

test("Retry-After policy honors attempts, delay, elapsed time, deadline, and fresh authorization", () => {
  const common = { attempt_number: 1, started_at: new Date(NOW).toISOString(), now_at: new Date(NOW).toISOString(),
    deadline_at: new Date(NOW + 30_000).toISOString(), next_attempt_authorized: true };
  assert.deepEqual(evaluateOpenAIImageRetry({ ...common, retry_after: "2" }), {
    decision: "eligible_for_separately_authorized_attempt", delay_ms: 2000,
    automatic_retry: false, new_billable_identity_required: true,
  });
  assert.equal(evaluateOpenAIImageRetry({ ...common, retry_after: "2", attempt_number: 3 }).stop_reason, "attempt_limit");
  assert.equal(evaluateOpenAIImageRetry({ ...common, retry_after: "11", max_delay_ms: 10 }).stop_reason, "delay_limit");
  assert.equal(evaluateOpenAIImageRetry({ ...common, retry_after: "20", max_delay_ms: 30_000, max_elapsed_ms: 10_000 }).stop_reason, "time_limit");
  assert.equal(evaluateOpenAIImageRetry({ ...common, retry_after: "unknown" }).stop_reason, "retry_after_invalid");
  assert.equal(evaluateOpenAIImageRetry({ ...common, retry_after: "2", next_attempt_authorized: false }).stop_reason, "fresh_authorization_required");
  assert.equal(evaluateOpenAIImageRetry({ ...common, retry_after: "2", max_attempts: 0 }).stop_reason, "invalid_retry_policy");
});

test("partial and missing provider usage remains raw, identity-bound, and unknown", () => {
  const raw = normalizeOpenAIImageUsage({ input_tokens: 50, input_tokens_details: { text_tokens: 10, image_tokens: 40 }, custom_field: 4 }, {
    transport_attempt_id: "transport-image-001", provider_request_id: "provider-request-safe-hash",
  });
  assert.equal(raw.completeness, "unknown");
  assert.equal(raw.input_tokens, 50);
  assert.deepEqual(raw.input_tokens_details, { text_tokens: 10, image_tokens: 40 });
  assert.deepEqual(raw.missing_fields, ["usage.profile_mapping_pending", "usage.output_tokens", "usage.total_tokens",
    "usage.output_tokens_details", "usage.unmapped_fields"]);
  assert.equal(raw.usage_units, undefined);
  assert.deepEqual(normalizeOpenAIImageUsage(null).missing_fields, ["usage"]);
  const missingUsage = normalizeOpenAIImageUsage(null, {
    transport_attempt_id: "transport-image-001", provider_request_id: "req-private-fixture-id",
  });
  assert.deepEqual(missingUsage.missing_fields, ["usage"]);
  assert.equal(readPrivateOpenAIImageRequestId(missingUsage), "req-private-fixture-id");
});

test("public usage references preserve safe transport identity and screen sensitive identity values", async (t) => {
  const safeProviderRef = normalizeOpenAIImageUsage({}, {
    transport_attempt_id: "transport-image-001", provider_request_id: "provider-request-safe-hash",
  });
  assert.equal(safeProviderRef.transport_attempt_id, "transport-image-001");
  assert.match(safeProviderRef.provider_request_id, /^provider-request-[a-f0-9]{64}$/);
  for (const value of ["person@example.invalid", "ghp_SyntheticCredentialValueSyntheticCredentialValue", "https://example.invalid/private"]) {
    await t.test(`normalizer rejects sensitive transport identity: ${value.startsWith("https:") ? "url" : value.includes("@") ? "email" : "credential"}`, () => {
      assert.throws(() => normalizeOpenAIImageUsage({}, { transport_attempt_id: value }), (error) => {
        assert.ok(error instanceof OpenAIImagesProviderError);
        assert.equal(error.code, "invalid_configuration");
        assert.doesNotMatch(JSON.stringify(error), /person@example|ghp_Synthetic|example\.invalid/);
        return true;
      });
      const sanitizedProviderRef = normalizeOpenAIImageUsage({}, { provider_request_id: value });
      assert.doesNotMatch(JSON.stringify(sanitizedProviderRef), /person@example|ghp_Synthetic|example\.invalid/);
      assert.match(sanitizedProviderRef.provider_request_id, /^provider-request-[a-f0-9]{64}$/);
    });
    const ctx = input();
    ctx.transport_attempt_id = value;
    const harness = providerHarness({ inputOverride: ctx });
    await assert.rejects(harness.provider.generate(harness.ctx), (error) => {
      assert.equal(error.code, "provider_attempt_mismatch");
      assert.doesNotMatch(JSON.stringify(error), /person@example|ghp_Synthetic|example\.invalid/);
      return true;
    });
    assert.equal(harness.fetchCount, 0);
  }
  const sensitiveRequestId = "person@example.invalid";
  const responseHarness = providerHarness({ fetchImpl: async () => new Response(JSON.stringify({
    data: [{ b64_json: makePng().toString("base64") }],
    usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
  }), { status: 200, headers: { "content-type": "application/json", "x-request-id": sensitiveRequestId } }) });
  const response = await responseHarness.provider.generate(responseHarness.ctx);
  assert.doesNotMatch(JSON.stringify(response), /person@example\.invalid/);
  assert.match(response.usage.provider_request_id, /^provider-request-[a-f0-9]{64}$/);
  assert.equal(readPrivateOpenAIImageRequestId(response.usage), sensitiveRequestId);

  const missingUsageId = "req-private-missing-usage-fixture";
  const missingUsageHarness = providerHarness({ fetchImpl: async () => new Response(JSON.stringify({
    data: [{ b64_json: makePng().toString("base64") }],
  }), { status: 200, headers: { "content-type": "application/json", "x-request-id": missingUsageId } }) });
  const missingUsageResponse = await missingUsageHarness.provider.generate(missingUsageHarness.ctx);
  assert.deepEqual(missingUsageResponse.usage.missing_fields, ["usage"]);
  assert.match(missingUsageResponse.usage.provider_request_id, /^provider-request-[a-f0-9]{64}$/);
  assert.equal(readPrivateOpenAIImageRequestId(missingUsageResponse.usage), missingUsageId);
  assert.doesNotMatch(JSON.stringify(missingUsageResponse), /req-private-missing-usage-fixture/);
});

test("observed raw usage accompanies failed outcomes without publishing artifacts or implying settlement", async (t) => {
  const usage = {
    input_tokens: 50,
    input_tokens_details: { text_tokens: 10, image_tokens: 40 },
    output_tokens: 50,
    output_tokens_details: { text_tokens: 10, image_tokens: 40 },
    total_tokens: 100,
  };
  const cases = [
    ["cancellation after response", async (harness) => {
      harness.ctx.controller.abort();
      return responseImage(makePng(), usage);
    }, "provider_outcome_unknown"],
    ["refusal response", async () => new Response(JSON.stringify({ error: { code: "content_policy_violation" }, usage }), { status: 200 }), "moderation_blocked"],
    ["malformed image bytes", async () => responseImage(Buffer.from("not an image"), usage), "image_bytes_invalid"],
    ["HTTP refusal", async () => new Response(JSON.stringify({ error: { code: "invalid_api_key" }, usage }), { status: 401 }), "authentication_denied"],
  ];
  for (const [name, makeResponse, code] of cases) await t.test(name, async () => {
    const harness = providerHarness({ fetchImpl: async () => makeResponse(harness) });
    let failure;
    try { await harness.provider.generate(harness.ctx); } catch (error) { failure = error; }
    assert.ok(failure instanceof OpenAIImagesProviderError);
    assert.equal(failure.code, code);
    assert.equal(harness.fetchCount, 1);
    assert.equal(Object.hasOwn(failure, "artifact"), false);
    assert.equal(failure.usage.completeness, "unknown");
    assert.equal(failure.usage.input_tokens, 50);
    assert.deepEqual(failure.usage.input_tokens_details, { text_tokens: 10, image_tokens: 40 });
    assert.equal(failure.usage.total_tokens, 100);
    assert.equal(failure.usage.transport_attempt_id, "transport-image-001");
    if (["cancellation after response", "malformed image bytes"].includes(name)) {
      assert.equal(readPrivateOpenAIImageRequestId(failure.usage), "req-private-fixture-id");
    }
    if (["refusal response", "HTTP refusal"].includes(name)) assert.equal(failure.usage.provider_request_id, undefined);
    else assert.match(failure.usage.provider_request_id, /^provider-request-[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(failure), /req-private-fixture-id|synthetic-offline-token/);
  });
  const absent = providerHarness({ fetchImpl: async () => new Response(JSON.stringify({
    data: [{ b64_json: Buffer.from("not an image").toString("base64") }],
  }), { status: 200, headers: { "content-type": "application/json" } }) });
  await assert.rejects(absent.provider.generate(absent.ctx), (error) => {
    assert.equal(error.code, "image_bytes_invalid");
    assert.equal(Object.hasOwn(error, "usage"), false);
    return true;
  });
});

test("provider output refusal, malformed base64, timeout, and post-response deadline never publish an artifact", async (t) => {
  const cases = [
    ["moderation response", async () => new Response(JSON.stringify({ error: { code: "content_policy_violation" } }), { status: 200 }), "moderation_blocked"],
    ["malformed base64", async () => new Response(JSON.stringify({ data: [{ b64_json: "not base64!" }] }), { status: 200 }), "provider_response_invalid"],
    ["transport timeout", async () => { throw new Error("Bearer transport-private"); }, "provider_transport_unknown"],
  ];
  for (const [name, makeResponse, code] of cases) await t.test(name, async () => {
    const harness = providerHarness({ fetchImpl: makeResponse });
    await assert.rejects(harness.provider.generate(harness.ctx), (error) => error.code === code);
    assert.equal(harness.fetchCount, 1);
  });
  await t.test("deadline after response", async () => {
    let clock = NOW;
    const harness = providerHarness({ now: () => clock, fetchImpl: async () => { clock = NOW + 60_000; return responseImage(); } });
    await assert.rejects(harness.provider.generate(harness.ctx), (error) => error.code === "provider_outcome_unknown");
    assert.equal(harness.fetchCount, 1);
  });
});

test("authority and provider error payloads are never copied into public failures", async () => {
  const authority = makeAuthorityPorts({
    mutateAuthority: (value) => ({ ...value, finance: { ...value.finance, status: "denied", message: "Bearer hidden-finance-secret" } }),
  });
  const provider = createOpenAIImagesProvider({ model_id: MODEL, configuration: config(), ...authority,
    credentialPort: { resolveCredential() { throw new Error("must not reach credential resolver"); } },
    promptPort: { render: () => "test" }, fetchImpl: async () => responseImage(), now: () => NOW });
  await assert.rejects(provider.generate(input()), (error) => {
    assert.equal(error.code, "authorization_unavailable");
    assert.doesNotMatch(JSON.stringify(error), /hidden-finance-secret|Bearer/);
    return true;
  });
});
