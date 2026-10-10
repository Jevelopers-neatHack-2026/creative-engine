import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  assertSafePublicIdentifier,
  containsSensitivePublicText,
  isSensitivePublicField,
  projectPublicTelemetry,
  TelemetryPrivacyError,
} from "../../src/telemetry/index.mjs";

const fixture = JSON.parse(await readFile(new URL("../../fixtures/privacy/unsafe-public-values.json", import.meta.url), "utf8"));

test("recursive projection omits unsafe keys and redacts unsafe nested values without leaking paths", () => {
  const projected = projectPublicTelemetry({
    trace: {
      provider_request_id: "req:fixture-1",
      api_key: "SYNTHETIC-NOT-A-REAL-CREDENTIAL",
      metadata: {
        header: "Bearer synthetic-token-not-a-secret",
        safe_detail: "ordinary rendering metadata",
        "owner@example.invalid": "harmless label",
      },
    },
  });
  const json = JSON.stringify(projected.value);
  assert.equal(json.includes("SYNTHETIC-NOT-A-REAL-CREDENTIAL"), false);
  assert.equal(json.includes("synthetic-token-not-a-secret"), false);
  assert.equal(json.includes("owner@example.invalid"), false);
  assert.equal(json.includes("provider_request_id"), true);
  assert.equal(json.includes("ordinary rendering metadata"), true);
  assert.ok(projected.redactions.length >= 3);
  assert.equal(JSON.stringify(projected.redactions).includes("owner@example.invalid"), false);

  const admission = projectPublicTelemetry({
    admission_token: "SYNTHETIC-ADMISSION-TOKEN",
    nested: {
      qr_payload: "SYNTHETIC-QR-PAYLOAD",
      "Bearer x": "synthetic value",
      display: "Bearer x",
      bearer: "Bearer a",
      bearer_the: "Bearer the",
      bearer_padding: "Bearer a=",
      embedded_admission: "metadata: admission_token=SYNTHETIC-ADMISSION-CREDENTIAL",
      safe_note: "the bearer of the note has no credential",
    },
  });
  const admissionJson = JSON.stringify(admission.value);
  for (const value of ["admission_token", "qr_payload", "Bearer x", "SYNTHETIC-ADMISSION-TOKEN", "SYNTHETIC-QR-PAYLOAD", "SYNTHETIC-ADMISSION-CREDENTIAL"]) {
    assert.equal(admissionJson.includes(value), false, value);
  }
  assert.equal(admissionJson.includes("[REDACTED]"), true);
  assert.equal(admissionJson.includes("the bearer of the note has no credential"), true);
  assert.equal(admission.value.nested.bearer, "[REDACTED]");
  assert.equal(admission.value.nested.bearer_the, "[REDACTED]");
  assert.equal(admission.value.nested.bearer_padding, "[REDACTED]");
  assert.equal(admission.value.nested.embedded_admission, "[REDACTED]");
  assert.equal(admission.value.nested.safe_note, "the bearer of the note has no credential");
});

test("Basic credentials, signed URLs, email and phone canaries are detected; ordinary prose survives", () => {
  const unsafeStrings = [
    "Authorization: Bearer synthetic-not-real",
    "Bearer x",
    "Bearer a",
    "Bearer the",
    "Bearer a=",
    "metadata: admission_token=SYNTHETIC-ADMISSION-CREDENTIAL",
    "Basic OnBhc3N3b3Jk",
    "Basic dTpw",
    "Basic dTo=",
    "Basic dTpwYXNzd29yZA==",
    "https://example.invalid/path?signature=SYNTHETIC-NOT-A-REAL-SIGNATURE",
    "fixture@example.invalid",
    "+1 (415) 555-0134",
  ];
  for (const value of unsafeStrings) assert.equal(containsSensitivePublicText(value), true, value);
  assert.equal(containsSensitivePublicText("Basic illustrations support the main headline."), false);
  assert.equal(containsSensitivePublicText("Basic shapes and calm colors."), false);
  assert.equal(containsSensitivePublicText("the bearer of the note has no credential"), false);
  const oversizedBasic = `Basic ${Buffer.from(`u:${"p".repeat(7_000)}`).toString("base64")}`;
  assert.ok(oversizedBasic.length > 8_192 && oversizedBasic.length < 64 * 1_024);
  assert.equal(containsSensitivePublicText(oversizedBasic), true);
  assert.equal(projectPublicTelemetry({ value: oversizedBasic }).value.value, "[REDACTED]");
  const fixtureCases = fixture.cases;
  for (const value of fixtureCases) {
    const projection = projectPublicTelemetry(value);
    assert.equal(JSON.stringify(projection.value).includes("SYNTHETIC-NOT-A-REAL"), false);
  }
});

test("plus-bearing Basic credentials stay private across encoded spellings and public record placements", () => {
  const credentialInputs = [];
  for (const credentials of ["~~~:p", "???:p", "~~~???:p"]) {
    for (const unpadded of [false, true]) {
      const token = Buffer.from(credentials).toString("base64").replace(unpadded ? /=+$/g : /$^/g, "");
      for (const [encoding, value] of [
        ["raw", `Basic ${token}`],
        ["scheme", `%42asic ${token}`],
        ["space", `Basic%20${token}`],
        ["both", `%42asic%20${token}`],
        ["scheme-space", `${[...Buffer.from("Basic ")].map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join("")}${token}`],
        ["nested", `%2542asic%2520${token}`],
        ["twice-space", `Basic%2520${token}`],
        ["plus-encoded", `Basic%20${token.replace(/\+/g, "%2B")}`],
        ["form-space", `Basic+${token}`],
        ["full", encodeURIComponent(`Basic ${token}`)],
        ["full-nested", encodeURIComponent(encodeURIComponent(`Basic ${token}`))],
      ]) {
        for (const placement of ["customer", "artistic", "source-uri", "key"]) {
          credentialInputs.push({ alphabet: credentials, unpadded, encoding, placement, value });
        }
      }
    }
  }

  for (const item of credentialInputs) {
    let record;
    if (item.placement === "customer") {
      record = { customer_preferences: [{ preference_id: "pref-1", value: item.value }] };
    } else if (item.placement === "artistic") {
      record = { artistic_intent: [{ interpretation_id: "intent-1", text: item.value }] };
    } else if (item.placement === "source-uri") {
      record = { source_identity: [{ source_id: "source-1", uri: item.value }] };
    } else {
      record = { preferences: { items: [{ [item.value]: "safe" }] } };
    }

    assert.equal(containsSensitivePublicText(item.value), true,
      `${item.alphabet} ${item.unpadded ? "unpadded" : "padded"} ${item.encoding} ${item.placement}`);
    const projected = projectPublicTelemetry(record);
    assert.equal(JSON.stringify(projected.value).includes(item.value), false,
      `${item.alphabet} ${item.unpadded ? "unpadded" : "padded"} ${item.encoding} ${item.placement}`);
    assert.equal(JSON.stringify(projected.redactions).includes(item.value), false);
    assert.throws(() => assertSafePublicIdentifier(item.value), TelemetryPrivacyError);
  }

  const benign = [
    "Warm + cool colors",
    "Basic shapes + circles",
    "Use 20% warm and 80% cool colors",
    "https://example.test/a+b",
    "https://example.test/caf%C3%A9",
    "Basic%20illustrations support the main headline.",
    "%42asic shapes and calm colors.",
  ];
  for (const value of benign) {
    assert.equal(containsSensitivePublicText(value), false, value);
    assert.equal(projectPublicTelemetry({ detail: value }).value.detail, value, value);
  }
});

test("percent-encoded credentials, PII, and signed URLs remain screened beside malformed escapes", () => {
  let deeplyEncodedEmail = "person@example.test";
  for (let layer = 0; layer < 5; layer += 1) deeplyEncodedEmail = encodeURIComponent(deeplyEncodedEmail);
  const unsafe = [
    "%FF%42%61%73%69%63%20dXNlcjpwYXNz",
    "prefix%FF%42asic%20fn5+OnA=",
    "person%40example.test",
    "%FFperson%40example.test",
    deeplyEncodedEmail,
    encodeURIComponent("https://example.test/a?X-Amz-Signature=synthetic-signature"),
    "%FFhttps%3A%2F%2Fexample.test%2Fa%3FX-Amz-Signature%3Dsynthetic-signature",
  ];

  for (const value of unsafe) {
    assert.equal(containsSensitivePublicText(value), true, value);
    assert.equal(projectPublicTelemetry({ detail: value }).value.detail, "[REDACTED]", value);
    const projectedKey = projectPublicTelemetry({ [value]: "safe" });
    assert.deepEqual(Object.keys(projectedKey.value), []);
    assert.equal(JSON.stringify(projectedKey.redactions).includes(value), false);
  }

  for (const key of ["api%5Fkey", "admission%5Ftoken", "qr%5Fpayload"]) {
    assert.equal(isSensitivePublicField(key), true, key);
    const projectedKey = projectPublicTelemetry({ [key]: "synthetic-sensitive-value" });
    assert.deepEqual(Object.keys(projectedKey.value), []);
    assert.equal(JSON.stringify(projectedKey.redactions).includes(key), false);
  }
  assert.equal(isSensitivePublicField("display%5Fname"), false);

  const benign = [
    "Warm%20+%20cool colors",
    "Basic%20illustrations support the main headline.",
    "https://example.test/caf%C3%A9?a+b",
    "ordinary malformed escape %FF remains descriptive",
    "Basic+shapes and calm colors",
    "Bearer+the note has a simple layout",
  ];
  for (const value of benign) {
    assert.equal(containsSensitivePublicText(value), false, value);
    assert.equal(projectPublicTelemetry({ detail: value }).value.detail, value, value);
  }
});

test("safe additive JSON values and own __proto__ metadata remain intact", () => {
  const additional = Object.create(null);
  Object.defineProperty(additional, "__proto__", { value: { source_id: 42 }, enumerable: true });
  Object.defineProperty(additional, "vendor_id", { value: 42, enumerable: true });
  Object.defineProperty(additional, "render_ref", { value: { revision: 2 }, enumerable: true });
  Object.defineProperty(additional, "optional_ref", { value: null, enumerable: true });
  const projected = projectPublicTelemetry(additional).value;
  assert.equal(Object.getPrototypeOf(projected), null);
  assert.equal(Object.getPrototypeOf(projected.__proto__), null);
  assert.equal(projected.__proto__.source_id, 42);
  assert.equal(projected.vendor_id, 42);
  assert.equal(Object.getPrototypeOf(projected.render_ref), null);
  assert.equal(projected.render_ref.revision, 2);
  assert.equal(projected.optional_ref, null);
  assert.equal(JSON.stringify(projected), '{"__proto__":{"source_id":42},"vendor_id":42,"render_ref":{"revision":2},"optional_ref":null}');
});

test("unbounded, cyclic, accessor and non-finite evidence fails with a fixed diagnostic", () => {
  const cycle = {};
  cycle.self = cycle;
  const accessor = {};
  Object.defineProperty(accessor, "hidden", { enumerable: true, get() { throw new Error("do not expose this token"); } });
  for (const value of [cycle, accessor, { amount: Number.NaN }, { many: "x".repeat(20_000) }]) {
    assert.throws(() => projectPublicTelemetry(value, { maxBytes: 1024 }), TelemetryPrivacyError);
  }
  const unsafeKeyProjection = projectPublicTelemetry({ "sk-abcdefghijklmnopqrstuvwxyz1234": "safe" });
  assert.equal(JSON.stringify(unsafeKeyProjection.value).includes("sk-abcdefghijklmnopqrstuvwxyz1234"), false);
  assert.equal(unsafeKeyProjection.redactions.length, 1);
  assert.throws(() => assertSafePublicIdentifier("Bearer synthetic-private-id"), TelemetryPrivacyError);
  assert.equal(assertSafePublicIdentifier("attempt:fixture-1"), "attempt:fixture-1");
});
