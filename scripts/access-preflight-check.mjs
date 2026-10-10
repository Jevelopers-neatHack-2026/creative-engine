import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ACCESS_CELL_DEFINITIONS,
  createAccessPreflightReport,
  runAccessPreflight,
} from "creative-engine/preflight";
import { createMockAccessFixture } from "../fixtures/preflight/access-ports.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const missingEvidence = Object.freeze({
  image_generation: [
    "openai_generation_account_permission_and_quota",
    "external_grant_and_finance_reservation",
  ],
  image_edit: [
    "openai_edit_account_permission_and_quota",
    "external_grant_and_finance_reservation",
  ],
  harness_jev: [
    "accepted_harness_jev_adapter_and_trace",
    "external_grant_and_finance_reservation",
  ],
  vision_observer: [
    "owner_selected_vision_target_and_capability",
    "external_grant_and_finance_reservation",
  ],
  generative_classifier_baseline: [
    "owner_selected_baseline_target_and_capability",
    "external_grant_and_finance_reservation",
  ],
  planning: [
    "owner_selected_planning_target_and_capability",
    "external_grant_and_finance_reservation",
  ],
  neatlogs_ingestion: ["accepted_neatlogs_ingestion_protocol_and_receipt"],
  neatlogs_readback: ["accepted_neatlogs_readback_protocol_and_receipt"],
});

const reasonForCell = Object.freeze({
  image_generation: "live_adapter_unavailable",
  image_edit: "live_adapter_unavailable",
  harness_jev: "adapter_unavailable",
  vision_observer: "pin_unresolved",
  generative_classifier_baseline: "pin_unresolved",
  planning: "pin_unresolved",
  neatlogs_ingestion: "metering_operation_unpublished",
  neatlogs_readback: "metering_operation_unpublished",
});

const actionForCell = Object.freeze({
  image_generation: "Creative and fulfillment must provide independently verified account permission, quota, exact target, and an authorized Finance reservation.",
  image_edit: "Creative and fulfillment must provide independent edit permission, quota, exact target, and an authorized Finance reservation.",
  harness_jev: "Agent and research must publish the accepted harness DecisionPort adapter and prove authorized trace delivery.",
  vision_observer: "Product and frontend must select the observer target and provide independently verified operation permission, quota, and budget authority.",
  generative_classifier_baseline: "Product and frontend must select the baseline target and provide independently verified operation permission, quota, and budget authority.",
  planning: "Creative and fulfillment must select the planning target and provide independently verified operation permission, quota, and budget authority.",
  neatlogs_ingestion: "Finance and reliability must publish and accept the sanitized ingestion operation and its receipt semantics.",
  neatlogs_readback: "Finance and reliability must publish and accept separate sanitized readback semantics bound to the ingested event.",
});

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function safeGitState() {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  const status = spawnSync("git", ["status", "--porcelain=v1"], { cwd: repoRoot, encoding: "utf8" });
  return {
    commit_sha: head.status === 0 ? head.stdout.trim() : null,
    working_tree_clean: status.status === 0 && status.stdout.trim() === "",
  };
}

export function createAccessPreflightGateReport() {
  const cells = ACCESS_CELL_DEFINITIONS.map((definition) => ({
    cell_id: definition.cell_id,
    owner_role: definition.owner_role,
    acceptance_ids: [...definition.acceptance_ids],
    status: "blocked",
    verified: false,
    reason_code: reasonForCell[definition.cell_id],
    owner_action: actionForCell[definition.cell_id],
    missing_evidence: [...missingEvidence[definition.cell_id]],
    financial_hold: "none",
  }));
  const required = [...new Set(cells.flatMap((cell) => cell.missing_evidence))].sort();
  return {
    evidence_schema: "creative-access-preflight-gate/1.0",
    target: "CE-A01",
    mode: "live",
    status: "blocked",
    acceptance_allowed: false,
    required_cell_count: ACCESS_CELL_DEFINITIONS.length,
    verified_cell_count: 0,
    provider_dispatches: 0,
    paid_provider_calls: 0,
    provider_credentials_read: false,
    external_owner_evidence: "pending",
    cells,
    missing_owner_evidence: required,
    gate_boundary: "No trusted live host composition is installed. User-supplied JSON cannot authenticate provider access, capability, authorization, or Finance reservation.",
  };
}

async function createMockEvidence() {
  const runId = "test:access-preflight-ci";
  const scenarios = [];
  for (const cellId of ["image_generation", "image_edit"]) {
    const fixture = createMockAccessFixture({ cellId, runId });
    const report = await runAccessPreflight(fixture.args);
    if (report.acceptance_allowed !== false || report.mode !== "mock" || report.required_cell_count !== ACCESS_CELL_DEFINITIONS.length) {
      throw new Error("mock access report failed its fixed-denominator assertions");
    }
    const result = report.cells.find((cell) => cell.cell_id === cellId);
    if (result?.status !== "simulated" || result.verified !== false || fixture.calls.dispatch !== 1) {
      throw new Error("the synthetic Images fixture did not produce its expected simulated result");
    }
    scenarios.push({ report, fixture });
  }

  const results = ACCESS_CELL_DEFINITIONS.map((definition) => {
    const candidates = scenarios.map(({ report }) => report.cells.find((cell) => cell.cell_id === definition.cell_id)).filter(Boolean);
    return candidates.find((cell) => cell.status === "simulated") ?? candidates[0];
  });
  const report = createAccessPreflightReport({
    run_id: runId,
    generated_at: new Date().toISOString(),
    mode: "mock",
    results,
  });
  if (report.cells.length !== ACCESS_CELL_DEFINITIONS.length || report.acceptance_allowed !== false) {
    throw new Error("mock access evidence did not preserve every required cell");
  }

  const [accessSource, imagesSource, fixtureSource] = await Promise.all([
    readFile(path.join(repoRoot, "src/preflight/access.mjs")),
    readFile(path.join(repoRoot, "src/preflight/openai-images.mjs")),
    readFile(path.join(repoRoot, "fixtures/preflight/access-ports.mjs")),
  ]);
  return {
    evidence_schema: "creative-access-preflight-evidence/1.0",
    target: "CE-A01",
    status: report.status,
    mode: "mock",
    acceptance_allowed: report.acceptance_allowed,
    required_cell_count: report.required_cell_count,
    verified_cell_count: report.verified_cell_count,
    paid_provider_calls: 0,
    provider_credentials_read: false,
    test_fixture_only: {
      synthetic_authorities: true,
      mock_adapter_dispatches: scenarios.reduce((total, { fixture }) => total + fixture.calls.dispatch, 0),
      actual_network_requests: 0,
    },
    runtime: {
      node: process.versions.node,
      supported_minimum: "22.23.3",
      development_compatibility: "24.15.0",
    },
    public_subpath: "creative-engine/preflight",
    implementation: safeGitState(),
    input_sha256: {
      "src/preflight/access.mjs": digest(accessSource),
      "src/preflight/openai-images.mjs": digest(imagesSource),
      "fixtures/preflight/access-ports.mjs": digest(fixtureSource),
    },
    report,
    external_acceptance: "pending_owner_access_finance_harness_and_trace_evidence",
  };
}

function parseArgs(argv) {
  const options = { mode: "mock", output: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--mode") options.mode = argv[++index];
    else if (argv[index] === "--out") options.output = argv[++index];
    else throw new TypeError("Use --mode mock|live and optional --out <repo-relative-path>.");
  }
  if (!new Set(["mock", "live"]).has(options.mode)) throw new TypeError("Mode must be mock or live.");
  return options;
}

async function writeEvidence(value, output, { stdout = true } = {}) {
  const serialized = JSON.stringify(value, null, 2) + "\n";
  if (output) {
    if (path.isAbsolute(output)) throw new TypeError("Evidence output must be repository-relative.");
    const resolved = path.resolve(repoRoot, output);
    if (!resolved.startsWith(repoRoot + path.sep)) throw new TypeError("Evidence output must stay inside the repository.");
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, serialized, { mode: 0o600 });
  }
  if (stdout) process.stdout.write(serialized);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === "live") {
    await writeEvidence(createAccessPreflightGateReport(), options.output ?? "build/access-preflight-live-gate.json");
    process.exitCode = 2;
    return;
  }

  const evidence = await createMockEvidence();
  const output = options.output ?? "build/access-preflight-evidence.json";
  await writeEvidence(evidence, output, { stdout: false });
  process.stdout.write(`Access preflight evidence written: ${path.relative(repoRoot, path.resolve(repoRoot, output))} (8 cells, 2 synthetic adapter dispatches, acceptance pending).\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
