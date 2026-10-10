import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalHash } from "../src/contracts/validation.mjs";
import { evaluatePolicyAcceptance } from "../evals/creative/validator.mjs";
import { createAccessPreflightGateReport } from "./access-preflight-check.mjs";
import { createImageAdapterGateReport } from "./image-adapter-check.mjs";

const requirements = {
  api: [
    "shared_contracts_creative_schemas",
    "event_intelligence_producer",
    "trusted_project_membership",
    "creative_controls_consumer",
  ],
  contracts: [
    "shared_contracts_creative_schemas",
    "event_intelligence_producer",
    "trusted_project_membership",
    "creative_controls_consumer",
  ],
  brief: [
    "shared_contracts_creative_schemas",
    "event_intelligence_producer",
    "trusted_project_membership",
    "event_intelligence_asset_permission_protocol",
    "event_intelligence_invalidation_delivery",
    "application_approval_staleness_consumer",
  ],
  "decision-contract": [
    "shared_contracts_decision_port",
    "harness_decision_port_consumer",
    "harness_jev_transport_owner",
  ],
  "metering-contract": [
    "finance_metering_budget_protocol",
    "shared_contracts_usage_budget_schemas",
  ],
  "handoff-contract": [
    "product_approval_protocol_and_consumer",
    "production_artwork_handoff",
    "shared_contracts_approval_handoff_schemas",
  ],
  versions: [
    "shared_contracts_creative_schemas",
    "event_intelligence_producer",
    "trusted_project_membership",
    "finance_metering_budget_protocol",
    "shared_contracts_usage_budget_schemas",
  ],
  "creative-metering": [
    "finance_metering_budget_protocol",
    "shared_contracts_usage_budget_schemas",
  ],
};

const creativeMeteringExternalGate =
  "No authoritative Neatlogs evidence-sink agreement reference is available; actual ingestion and readback remain unverified.";

function rawSha256(bytes) {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

function sameJson(left, right) {
  function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
    }
    return value;
  }
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function validNonzeroHash(value) {
  return typeof value === "string" && /^sha256:(?!0{64}$)[a-f0-9]{64}$/.test(value);
}

async function readRepoFile(repoRoot, relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0 || path.isAbsolute(relativePath) || relativePath.includes("\\")) {
    throw new Error("evidence path must be a nonempty repository-relative path");
  }
  const root = await realpath(repoRoot);
  const file = await realpath(path.resolve(root, relativePath));
  if (file !== root && !file.startsWith(root + path.sep)) throw new Error("evidence path escapes repository root");
  return readFile(file);
}

async function verifyAgreement(id, agreement, repoRoot) {
  if (!agreement || agreement.status !== "accepted") return false;
  if (!/^(?!0{40}$)[a-f0-9]{40}$/.test(agreement.accepted_commit ?? "")) return false;
  if (typeof agreement.owner_ref !== "string" || !agreement.owner_ref.startsWith("https://")) return false;
  if (!Array.isArray(agreement.schema_hashes) || agreement.schema_hashes.length === 0 ||
    agreement.schema_hashes.some((hash) => !validNonzeroHash(hash))) return false;
  if (!Array.isArray(agreement.accepted_inputs) || agreement.accepted_inputs.length === 0) return false;
  const derivedSchemaHashes = [];
  try {
    for (const input of agreement.accepted_inputs) {
      if (!input || input.owner_ref !== agreement.owner_ref || input.owner_commit !== agreement.accepted_commit ||
        !validNonzeroHash(input.file_sha256) || !validNonzeroHash(input.schema_hash)) return false;
      const bytes = await readRepoFile(repoRoot, input.path);
      if (rawSha256(bytes) !== input.file_sha256) return false;
      let parsed;
      try { parsed = JSON.parse(bytes.toString("utf8")); } catch { return false; }
      if (canonicalHash(parsed) !== input.schema_hash) return false;
      derivedSchemaHashes.push(input.schema_hash);
    }
    const uniqueDerived = [...new Set(derivedSchemaHashes)].sort();
    if (!sameJson([...agreement.schema_hashes].sort(), uniqueDerived)) return false;

    const review = agreement.review_record;
    if (!review || !validNonzeroHash(review.sha256) || typeof review.path !== "string") return false;
    const reviewBytes = await readRepoFile(repoRoot, review.path);
    if (rawSha256(reviewBytes) !== review.sha256) return false;
    const reviewEvidence = JSON.parse(reviewBytes.toString("utf8"));
    if (reviewEvidence.agreement_id !== id || reviewEvidence.decision !== "accepted" ||
      reviewEvidence.owner_role !== agreement.owner_role ||
      reviewEvidence.owner_ref !== agreement.owner_ref ||
      reviewEvidence.accepted_commit !== agreement.accepted_commit ||
      !sameJson(reviewEvidence.schema_hashes, agreement.schema_hashes) ||
      !sameJson(reviewEvidence.accepted_inputs, agreement.accepted_inputs)) return false;

    // Hash consistency alone cannot authenticate an external owner. Require a
    // distinct independent-review record whose author has checked the owner
    // publication and which explicitly binds the same owner commit and export.
    const independent = agreement.independent_verification;
    if (!independent || independent.status !== "verified" ||
      typeof independent.record?.path !== "string" || !validNonzeroHash(independent.record.sha256)) return false;
    const verificationBytes = await readRepoFile(repoRoot, independent.record.path);
    if (rawSha256(verificationBytes) !== independent.record.sha256) return false;
    const verificationEvidence = JSON.parse(verificationBytes.toString("utf8"));
    if (verificationEvidence.agreement_id !== id || verificationEvidence.verification !== "independent_owner_check" ||
      typeof verificationEvidence.verifier_role !== "string" || verificationEvidence.verifier_role.trim() === "" ||
      typeof verificationEvidence.verifier_id !== "string" || verificationEvidence.verifier_id.trim() === "" ||
      typeof verificationEvidence.checked_at !== "string" || !Number.isFinite(Date.parse(verificationEvidence.checked_at)) ||
      verificationEvidence.owner_ref !== agreement.owner_ref ||
      verificationEvidence.accepted_commit !== agreement.accepted_commit ||
      verificationEvidence.owner_review_sha256 !== review.sha256 ||
      !sameJson(verificationEvidence.accepted_inputs, agreement.accepted_inputs)) return false;
    return true;
  } catch {
    return false;
  }
}

export async function evaluateAcceptanceRecord(record, target, repoRoot) {
  const selected = target === "all"
    ? [...new Set(Object.values(requirements).flat())]
    : requirements[target];
  if (!selected) throw new TypeError("Unknown acceptance target " + target + ".");
  const allOwnersAccepted = record?.proposal_state === "accepted";
  const unmet = [];
  for (const id of selected) {
    const agreement = record?.agreements?.[id];
    if (!allOwnersAccepted || !(await verifyAgreement(id, agreement, repoRoot))) unmet.push(id);
  }
  const unresolved = target === "creative-metering" || target === "all"
    ? [creativeMeteringExternalGate]
    : [];
  return { selected, unmet, unresolved, proposalState: record?.proposal_state ?? "missing" };
}

function evaluateCreativePolicy(repoRoot) {
  try {
    const readJson = (relativePath) => JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8"));
    return evaluatePolicyAcceptance({
      policy: readJson("evals/creative/policy.json"),
      corpusManifest: readJson("evals/creative/corpus-manifest.json"),
      questionRegister: readJson("evals/creative/question-register.json"),
      telemetrySchema: readJson("evals/creative/telemetry-schema.json"),
    });
  } catch {
    return {
      accepted: false,
      findings: [{ key: "acceptance.inputs", reason: "policy_or_evidence_input_unreadable" }],
    };
  }
}

function writeCreativePolicyResult(gate) {
  process.stdout.write(JSON.stringify({
    schema_version: "creative-eval-acceptance-result/v1",
    target: "CE-Q01",
    accepted: gate.accepted,
    finding_count: gate.findings.length,
    findings: gate.findings,
  }) + "\n");
  if (!gate.accepted) process.exitCode = 2;
}

function writeAccessPreflightResult(gate) {
  process.stdout.write(JSON.stringify(gate) + "\n");
  process.exitCode = 2;
}

function writeImageAdapterAcceptanceResult(gate) {
  process.stdout.write(JSON.stringify({
    schema_version: "creative-image-adapter-acceptance-result/v1",
    target: gate.target,
    acceptance_allowed: false,
    provider_dispatches: 0,
    paid_provider_calls: 0,
    provider_credentials_read: false,
    model_selection: gate.model_selection,
    missing_owner_evidence: [...gate.missing_owner_evidence],
  }) + "\n");
  process.exitCode = 2;
}

function writeBriefAcceptanceResult({ unmet, proposalState }) {
  process.stdout.write(JSON.stringify({
    schema_version: "creative-brief-acceptance-result/v1",
    target: "CE-02",
    proposal_state: proposalState,
    acceptance_allowed: unmet.length === 0,
    provider_dispatches: 0,
    missing_owner_evidence: unmet,
  }) + "\n");
  if (unmet.length > 0) process.exitCode = 2;
}

async function main() {
  const target = process.argv[2] ?? "all";
  if (target === "access-preflight") {
    writeAccessPreflightResult(createAccessPreflightGateReport());
    return;
  }
  if (target === "image-adapter") {
    writeImageAdapterAcceptanceResult(createImageAdapterGateReport());
    return;
  }
  if (target === "eval-policy") {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    writeCreativePolicyResult(evaluateCreativePolicy(repoRoot));
    return;
  }
  if (!Object.hasOwn(requirements, target) && target !== "all") {
    process.stderr.write("Unknown acceptance target " + target + ". Use api, controls, contracts, brief, decision-contract, eval-policy, metering-contract, handoff-contract, versions, creative-metering, access-preflight, image-adapter, or all.\n");
    process.exitCode = 2;
    return;
  }

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const recordPath = path.join(repoRoot, "docs/contracts/canonical-owner-agreements.json");
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  const { unmet, unresolved, proposalState } = await evaluateAcceptanceRecord(record, target, repoRoot);
  if (target === "brief") {
    writeBriefAcceptanceResult({ unmet, proposalState });
    return;
  }
  const creativePolicy = target === "all" ? evaluateCreativePolicy(repoRoot) : null;
  const accessPreflight = target === "all" ? createAccessPreflightGateReport() : null;
  const imageAdapter = target === "all" ? createImageAdapterGateReport() : null;
  if (unmet.length > 0 || unresolved.length > 0 || creativePolicy && !creativePolicy.accepted || accessPreflight || imageAdapter) {
    process.stderr.write("Acceptance blocked: missing or unverified canonical owner agreement evidence or required integration evidence for " + target + " (proposal_state=" + proposalState + ").\n");
    for (const id of unmet) {
      const agreement = record.agreements?.[id];
      process.stderr.write("- " + id + " (" + (agreement?.owner_role ?? "owner unknown") + "; status=" + (agreement?.status ?? "missing") + ")\n");
    }
    for (const gate of unresolved) process.stderr.write("- " + gate + "\n");
    if (creativePolicy && !creativePolicy.accepted) {
      process.stderr.write("Acceptance blocked: CE-Q01 policy and corpus evidence remain pending.\n");
      for (const finding of creativePolicy.findings) {
        process.stderr.write("- CE-Q01 " + finding.key + " (" + finding.reason + ")\n");
      }
    }
    if (accessPreflight) {
      process.stderr.write("Acceptance blocked: CE-A01 live access remains pending external owner, capability, Finance, harness, and trace evidence.\n");
      for (const cell of accessPreflight.cells) {
        process.stderr.write("- CE-A01 " + cell.cell_id + " (" + cell.reason_code + "; owner=" + cell.owner_role + ")\n");
      }
    }
    if (imageAdapter) {
      process.stderr.write("Acceptance blocked: CE-03 provider selection, account access, Finance authority, and usage mapping remain pending.\n");
      for (const evidence of imageAdapter.missing_owner_evidence) process.stderr.write("- CE-03 " + evidence + "\n");
    }
    process.exitCode = 2;
    return;
  }
  process.stdout.write("Owner evidence passed local consistency checks, including independent-review records, for " + target + ".\n");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
