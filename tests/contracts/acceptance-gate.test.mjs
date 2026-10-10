import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("canonical owner acceptance gate reports missing C01 and C02 agreements as failures", async () => {
  const agreements = JSON.parse(await readFile(new URL("../../docs/contracts/canonical-owner-agreements.json", import.meta.url), "utf8"));
  assert.equal(agreements.proposal_state, "pending_external_owner_agreement");
  const decision = spawnSync(process.execPath, ["scripts/acceptance-gate.mjs", "decision-contract"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(decision.status, 2);
  assert.match(decision.stderr, /Acceptance blocked: missing canonical owner agreement evidence/);
  assert.match(decision.stderr, /shared_contracts_decision_port/);
  assert.match(decision.stderr, /harness_decision_port_consumer/);
  assert.match(decision.stderr, /harness_jev_transport_owner/);

  const creative = spawnSync(process.execPath, ["scripts/acceptance-gate.mjs", "contracts"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(creative.status, 2);
  assert.match(creative.stderr, /shared_contracts_creative_schemas/);
  assert.match(creative.stderr, /event_intelligence_producer/);
  assert.match(creative.stderr, /trusted_project_membership/);
});
