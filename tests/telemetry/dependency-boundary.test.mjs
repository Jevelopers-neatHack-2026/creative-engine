import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const telemetryRoot = new URL("../../src/telemetry/", import.meta.url);

test("telemetry depends on C03 contracts and local helpers only, never on API/runtime/provider transport", async () => {
  const entries = await readdir(telemetryRoot, { withFileTypes: true });
  const sources = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"));
  assert.ok(sources.length >= 4);
  for (const entry of sources) {
    const source = await readFile(new URL(entry.name, telemetryRoot), "utf8");
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
    for (const specifier of imports) {
      const neutralAdmissionImport = entry.name === "sqlite-outbox.mjs" && specifier === "../sqlite/admission.mjs";
      // The replay worker uses only the intrinsic proxy guard before reading
      // host-provided descriptors; it gains no transport or provider capability.
      const proxyInspectionImport = entry.name === "retry.mjs" && specifier === "node:util";
      if (proxyInspectionImport) {
        const utilityImports = [...source.matchAll(/import\s+([^;]+?)\s+from\s+["']node:util["']/g)];
        assert.deepEqual(utilityImports.map((match) => match[1].replace(/\s+/g, " ").trim()), ["{ types as utilTypes }"]);
        assert.match(source, /\butilTypes\.isProxy\(/);
        assert.doesNotMatch(source, /\butilTypes\.(?!isProxy\b)/);
      }
      assert.ok(neutralAdmissionImport || proxyInspectionImport || /^(?:\.\.\/contracts\/|\.\/|node:crypto$)/.test(specifier),
        `${entry.name} imports only contract, telemetry, or required built-in hashing/proxy inspection helpers`);
    }
    assert.doesNotMatch(source, /from\s+["'][^"']*(?:runtime|\/api\/|openai|typesafe\.ai|neatlogs)[^"']*["']/i);
    assert.doesNotMatch(source, /\bfetch\s*\(|https?\.request\s*\(/i);
  }
  const admission = await readFile(new URL("../../src/sqlite/admission.mjs", import.meta.url), "utf8");
  const admissionImports = [...admission.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
  assert.deepEqual(new Set(admissionImports), new Set(["node:async_hooks", "node:fs"]),
    "neutral SQLite admission may depend only on the built-in async context and filesystem identity APIs");
  assert.equal(admissionImports.length, 2);
  assert.doesNotMatch(admission, /\bimport\s*\(|\brequire\s*\(/,
    "neutral SQLite admission must not load dynamic or external modules");
  assert.doesNotMatch(admission, /\bfetch\s*\(|https?\.request\s*\(/i,
    "neutral SQLite admission must not make network requests");
  const evidence = await readFile(new URL("../../src/telemetry/evidence.mjs", import.meta.url), "utf8");
  assert.match(evidence, /executeMeteredAttempt/);
  assert.doesNotMatch(evidence, /reserve.*Amount|calculate.*Cost|rateCard|pricingTable/i);
  const retry = await readFile(new URL("../../src/telemetry/retry.mjs", import.meta.url), "utf8");
  assert.match(retry, /recordUsageObservation/);
  assert.doesNotMatch(retry, /executeMeteredAttempt|provider\.dispatch|image_generation/);
  const runtime = await readFile(new URL("../../src/runtime/creative-runtime.mjs", import.meta.url), "utf8");
  assert.match(runtime, /executeCreativeMeteredAttempt/);
  assert.match(runtime, /usage_profiles/);
  assert.doesNotMatch(runtime, /\bexecuteMeteredAttempt\s*\(/,
    "API provider work must pass through the CE-11 wrapper and existing C03 executor");
});
