import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const IMAGE_ADAPTER_MISSING_EVIDENCE = Object.freeze([
  "owner_selected_image_model_and_exact_operation_profile",
  "verified_openai_generation_account_permission_quota_and_scope",
  "verified_openai_edit_account_permission_quota_and_scope",
  "trusted_live_capability_grant_and_finance_reservation_authority",
  "accepted_provider_usage_to_rate_mapping_for_selected_model",
  "accepted_external_provider_contract_and_actual_generate_edit_evidence",
]);

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function gitEvidence() {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  const status = spawnSync("git", ["status", "--porcelain=v1"], { cwd: repoRoot, encoding: "utf8" });
  return {
    commit_sha: head.status === 0 ? head.stdout.trim() : null,
    working_tree_clean: status.status === 0 && status.stdout.trim() === "",
  };
}

export function createImageAdapterGateReport() {
  return Object.freeze({
    evidence_schema: "creative-image-adapter-gate/1.0",
    target: "CE-03",
    mode: "live",
    status: "blocked",
    acceptance_allowed: false,
    provider_dispatches: 0,
    paid_provider_calls: 0,
    provider_credentials_read: false,
    model_selection: "owner_selection_pending",
    external_owner_evidence: "pending",
    missing_owner_evidence: IMAGE_ADAPTER_MISSING_EVIDENCE,
    gate_boundary: "This gate does not read credentials, contact a provider, or authorize a reservation. Only trusted host authority and accepted owner evidence can enable a live adapter.",
  });
}

async function mockEvidence() {
  const paths = [
    "package.json",
    "Makefile",
    ".github/workflows/api.yml",
    "scripts/image-adapter-check.mjs",
    "src/models/openai-images.mjs",
    "src/models/index.mjs",
    "src/models/index.d.mts",
    "src/models/codec-runtime/package.json",
    "src/models/codec-runtime/package-lock.json",
    "src/versions/store.mjs",
    "src/telemetry/index.d.mts",
    "src/runtime/creative-runtime.mjs",
    "src/api/v1.d.mts",
    "docs/providers/openai-images.md",
    "tests/models/openai-images.test.mjs",
    "tests/models/creative-api-integration.test.mjs",
    "tests/models/public-consumer.mts",
  ];
  const inputs = {};
  for (const relative of paths) inputs[relative] = sha256(await readFile(path.join(repoRoot, relative)));
  const codec = JSON.parse(await readFile(path.join(repoRoot, "src/models/codec-runtime/package.json"), "utf8"));
  return {
    evidence_schema: "creative-image-adapter-evidence/1.0",
    target: "CE-03",
    status: "inventory_only",
    evidence_type: "implementation_input_inventory",
    dependency_mode: "mock",
    local_acceptance_only: true,
    actual_provider_calls: 0,
    actual_network_requests: 0,
    provider_credentials_read: false,
    live_acceptance: "pending_external_owner_capability_finance_and_usage_profile_evidence",
    runtime: { node: process.versions.node, minimum: "22.23.3", tested_compatibility: "24.15.0" },
    decoder: { package: codec.name, version: codec.version, package_root: "src/models/codec-runtime" },
    public_subpath: "creative-engine/models",
    implementation: gitEvidence(),
    input_sha256: inputs,
    runner_contract: "This file inventories bounded implementation inputs. Passing tests are determined by the exit status of make check TARGET=image-adapter MODE=mock; direct invocation does not claim test success.",
    transport_boundary: "Provider behavior is exercised only by intercepted offline fixtures.",
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
    await writeEvidence(createImageAdapterGateReport(), options.output ?? "build/image-adapter-live-gate.json");
    process.exitCode = 2;
    return;
  }
  await writeEvidence(await mockEvidence(), options.output ?? "build/image-adapter-evidence.json", { stdout: false });
  process.stdout.write("Image adapter mock evidence written; intercepted fixtures only, live acceptance remains pending.\n");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
