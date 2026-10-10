import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  assertSafePublicIdentifier,
  containsSensitivePublicText,
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
      safe_note: "the bearer of the note has no credential",
    },
  });
  const admissionJson = JSON.stringify(admission.value);
  for (const value of ["admission_token", "qr_payload", "Bearer x", "SYNTHETIC-ADMISSION-TOKEN", "SYNTHETIC-QR-PAYLOAD"]) {
    assert.equal(admissionJson.includes(value), false, value);
  }
  assert.equal(admissionJson.includes("[REDACTED]"), true);
  assert.equal(admissionJson.includes("the bearer of the note has no credential"), true);
});

test("Basic credentials, signed URLs, email and phone canaries are detected; ordinary prose survives", () => {
  const unsafeStrings = [
    "Authorization: Bearer synthetic-not-real",
    "Bearer x",
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
  const fixtureCases = fixture.cases;
  for (const value of fixtureCases) {
    const projection = projectPublicTelemetry(value);
    assert.equal(JSON.stringify(projection.value).includes("SYNTHETIC-NOT-A-REAL"), false);
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
