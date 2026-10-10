import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testFiles = ["tests/api/creative-api.test.mjs", "tests/api/public-entrypoint.test.mjs"];
const fixtureDirectory = path.join(repoRoot, "fixtures/api");
const outputFlag = process.argv.indexOf("--out");
const outputPath = path.resolve(repoRoot, outputFlag < 0 ? "build/api-check-evidence.json" : process.argv[outputFlag + 1] ?? "");
const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...testFiles], {
  cwd: repoRoot,
  encoding: "utf8",
  maxBuffer: 8 * 1024 * 1024,
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

function summaryValue(name) {
  const match = result.stdout?.match(new RegExp(`^# ${name} (\\d+)$`, "m"));
  return match ? Number(match[1]) : null;
}

const fixtures = {};
for (const name of (await readdir(fixtureDirectory)).filter((item) => item.endsWith(".json")).sort()) {
  const bytes = await readFile(path.join(fixtureDirectory, name));
  fixtures[`fixtures/api/${name}`] = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
const status = spawnSync("git", ["status", "--porcelain=v1"], { cwd: repoRoot, encoding: "utf8" });
const counts = {
  tests: summaryValue("tests"),
  passed: summaryValue("pass"),
  failed: summaryValue("fail"),
  cancelled: summaryValue("cancelled"),
  skipped: summaryValue("skipped"),
};
const passed = result.status === 0 && counts.tests !== null && counts.passed === counts.tests &&
  counts.failed === 0 && counts.cancelled === 0 && counts.skipped === 0;
const evidence = {
  evidence_schema: "creative-engine-api-check/1.0",
  status: passed ? "passed" : "failed",
  generated_at: new Date().toISOString(),
  dependency_mode: "mock",
  external_acceptance: "pending_external_owner_agreement",
  runtime: {
    node: process.versions.node,
    supported_minimum: "22.23.3",
    development_compatibility: "24.15.0",
  },
  implementation: {
    commit_sha: head.status === 0 ? head.stdout.trim() : null,
    working_tree_clean: status.status === 0 && status.stdout.trim() === "",
  },
  schemas: {
    creative_api: "1.0",
    creative_brief: "1.0",
    edit_plan: "1.0",
    design_version: "1.0",
    decision_port: "1.0",
    metering: "creative.metering.proposal/v1",
    approval_handoff: "creative.approval-handoff.proposal/v1",
  },
  test_fixture_only: {
    image_provider: { provider: "fixture-provider", model: "fixture-model", sdk: "fixture-sdk/1.0" },
    decision_port: { provider: "fixture-jev", model: "jev-1.13.0", policy: "creative-engine-decision/1" },
    paid_provider_calls: false,
  },
  counts,
  fixture_sha256: fixtures,
  sanitized_references: {
    decision: "synthetic offline DecisionPort request and result assertions",
    artifacts: "synthetic design/version fixture bindings; payload bytes omitted",
    usage: "synthetic C03 observations; unknown or incomplete usage stays explicit",
    trace: "synthetic event references; no provider headers, credentials, or raw artifacts",
  },
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
process.stdout.write(`API evidence written: ${path.relative(repoRoot, outputPath)} (${evidence.status}).\n`);
if (!passed) process.exitCode = result.status || 1;
