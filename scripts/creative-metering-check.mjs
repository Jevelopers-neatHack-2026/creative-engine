import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = "fixtures/metering/issue-20-coverage.json";
const manifest = JSON.parse(await readFile(path.join(repoRoot, manifestPath), "utf8"));
if (manifest.schema_version !== "creative-metering-coverage/v1" || manifest.dependency_mode !== "mock" ||
  !Array.isArray(manifest.cases) || manifest.cases.length !== 5 || !Array.isArray(manifest.fixture_hash_inputs) ||
  !Array.isArray(manifest.local_integration) || manifest.local_integration.length !== 2) {
  throw new TypeError("invalid local creative-metering coverage manifest");
}

const telemetryFiles = readdirSync(path.join(repoRoot, "tests/telemetry"))
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => `tests/telemetry/${name}`);
const testFiles = [
  "tests/api/creative-api.test.mjs",
  ...telemetryFiles,
  "tests/versions/api-integration.test.mjs",
];
const run = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=tap", ...testFiles], {
  cwd: repoRoot,
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
});
const output = typeof run.stdout === "string" ? run.stdout : "";
const summary = (name) => {
  const match = output.match(new RegExp(`^# ${name} (\\d+)$`, "m"));
  return match ? Number(match[1]) : null;
};
const allTestNames = new Set([...output.matchAll(/^# Subtest: (.+)$/gm)].map((match) => match[1]));
const failedTestNames = new Set([...output.matchAll(/^not ok \d+ - (.+)$/gm)].map((match) => match[1]));
const caseCoverage = manifest.cases.map((item) => {
  const required = Array.isArray(item.tests) ? item.tests : [];
  const passed = required.filter((test) => allTestNames.has(test.name) && !failedTestNames.has(test.name));
  return {
    case_id: item.case_id,
    status: required.length > 0 && passed.length === required.length ? "passed" : "failed",
    required_test_count: required.length,
    passed_test_count: passed.length,
    tests: required.map((test) => ({ file: test.file, name: test.name,
      status: allTestNames.has(test.name) && !failedTestNames.has(test.name) ? "passed" : "failed" })),
  };
});
const localIntegration = manifest.local_integration.map((item) => {
  const required = Array.isArray(item.tests) ? item.tests : [];
  const tests = required.map((test) => ({
    file: test.file,
    name: test.name,
    status: testFiles.includes(test.file) && allTestNames.has(test.name) && !failedTestNames.has(test.name) ? "passed" : "failed",
  }));
  const status = item.local_status === "implemented_and_offline_tested" && required.length > 0 &&
    tests.every((test) => test.status === "passed") ? "implemented_and_offline_tested" : "incomplete";
  return {
    requirement_id: item.requirement_id,
    status,
    full_acceptance_status: item.full_acceptance_status,
    required_test_count: required.length,
    passed_test_count: tests.filter((test) => test.status === "passed").length,
    tests,
  };
});
const fixtureHashes = {};
for (const relativePath of manifest.fixture_hash_inputs) {
  const bytes = await readFile(path.join(repoRoot, relativePath));
  fixtureHashes[relativePath] = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
const gitHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
const gitStatus = spawnSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" });
const sourceRevision = {
  git_head: gitHead.status === 0 ? gitHead.stdout.trim() : null,
  worktree_clean: gitStatus.status === 0 && gitStatus.stdout.trim() === "",
};
const evidence = {
  schema_version: "creative-metering-check-evidence/v1",
  target: "CE-11",
  dependency_mode: "mock",
  runtime: process.version,
  source_revision: sourceRevision,
  status: run.status === 0 && !run.error && caseCoverage.every((item) => item.status === "passed") &&
    localIntegration.every((item) => item.status === "implemented_and_offline_tested" &&
      item.full_acceptance_status === "pending_external_owner_and_live_evidence") ? "passed" : "failed",
  test_summary: {
    files: testFiles,
    tests: summary("tests"),
    pass: summary("pass"),
    fail: summary("fail"),
    cancelled: summary("cancelled"),
    skipped: summary("skipped"),
  },
  case_coverage: caseCoverage,
  local_integration: localIntegration,
  fixture_sha256: fixtureHashes,
  live_provider_dispatch: "not_attempted",
  external_gates: manifest.external_gates,
};
const outDir = path.join(repoRoot, "build");
await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, "creative-metering-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(evidence)}\n`);
if (evidence.status !== "passed") {
  process.stderr.write("Creative-metering offline tests failed or did not cover every declared issue case; rerun the listed Node test files directly for diagnostics.\n");
  process.exitCode = 1;
}
