import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const target = process.argv[2] ?? "all";
const requirements = {
  contracts: [
    "shared_contracts_creative_schemas",
    "event_intelligence_producer",
    "trusted_project_membership",
    "creative_controls_consumer",
  ],
  "decision-contract": [
    "shared_contracts_decision_port",
    "harness_decision_port_consumer",
    "harness_jev_transport_owner",
  ],
};

if (!Object.hasOwn(requirements, target) && target !== "all") {
  process.stderr.write("Unknown acceptance target " + target + ". Use contracts, decision-contract, or all.\n");
  process.exit(2);
}

const path = fileURLToPath(new URL("../docs/contracts/canonical-owner-agreements.json", import.meta.url));
const record = JSON.parse(await readFile(path, "utf8"));
const selected = target === "all"
  ? [...requirements.contracts, ...requirements["decision-contract"]]
  : requirements[target];
const unmet = selected.filter((id) => {
  const agreement = record.agreements[id];
  return !agreement || agreement.status !== "accepted" ||
    !/^[a-f0-9]{40}$/.test(agreement.accepted_commit ?? "") ||
    !Array.isArray(agreement.schema_hashes) || agreement.schema_hashes.length === 0 ||
    agreement.schema_hashes.some((hash) => !/^sha256:[a-f0-9]{64}$/.test(hash)) ||
    typeof agreement.review_record !== "string" || agreement.review_record.trim() === "";
});

if (unmet.length > 0) {
  process.stderr.write("Acceptance blocked: missing canonical owner agreement evidence for " + target + ".\n");
  for (const id of unmet) {
    const agreement = record.agreements[id];
    process.stderr.write("- " + id + " (" + (agreement?.owner_role ?? "owner unknown") + "; status=" + (agreement?.status ?? "missing") + ")\n");
  }
  process.exit(2);
}

process.stdout.write("Canonical owner agreement evidence is present for " + target + ".\n");
