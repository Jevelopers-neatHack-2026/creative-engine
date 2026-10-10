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
      assert.match(specifier, /^(?:\.\.\/contracts\/|\.\/|node:crypto$)/,
        `${entry.name} imports only contract, telemetry, or required built-in hashing helpers`);
    }
    assert.doesNotMatch(source, /from\s+["'][^"']*(?:runtime|\/api\/|openai|typesafe\.ai|neatlogs)[^"']*["']/i);
    assert.doesNotMatch(source, /\bfetch\s*\(|https?\.request\s*\(/i);
  }
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
