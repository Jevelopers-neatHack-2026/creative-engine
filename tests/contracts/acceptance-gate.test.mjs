import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { canonicalHash } from "../../src/contracts/validation.mjs";
import { evaluateAcceptanceRecord } from "../../scripts/acceptance-gate.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("canonical owner acceptance gate reports missing C01 and C02 agreements as failures", async () => {
  const agreements = JSON.parse(await readFile(new URL("../../docs/contracts/canonical-owner-agreements.json", import.meta.url), "utf8"));
  assert.equal(agreements.proposal_state, "pending_external_owner_agreement");
  const decision = spawnSync(process.execPath, ["scripts/acceptance-gate.mjs", "decision-contract"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(decision.status, 2);
  assert.match(decision.stderr, /Acceptance blocked: missing or unverified canonical owner agreement evidence/);
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

  const api = spawnSync(process.execPath, ["scripts/acceptance-gate.mjs", "api"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(api.status, 2);
  assert.match(api.stderr, /shared_contracts_creative_schemas/);
  assert.match(api.stderr, /event_intelligence_producer/);
  assert.match(api.stderr, /trusted_project_membership/);

  for (const [target, expectedIds] of [
    ["metering-contract", ["finance_metering_budget_protocol", "shared_contracts_usage_budget_schemas"]],
    ["handoff-contract", ["product_approval_protocol_and_consumer", "production_artwork_handoff", "shared_contracts_approval_handoff_schemas"]],
  ]) {
    const result = spawnSync(process.execPath, ["scripts/acceptance-gate.mjs", target], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 2, `${target} must fail while external approvals are absent`);
    assert.match(result.stderr, /Acceptance blocked: missing or unverified canonical owner agreement evidence/);
    for (const id of expectedIds) assert.match(result.stderr, new RegExp(id));
  }

  const all = spawnSync(process.execPath, ["scripts/acceptance-gate.mjs", "all"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(all.status, 2, "all acceptance must stay blocked while any external agreement is pending");
  assert.match(all.stderr, /finance_metering_budget_protocol/);
  assert.match(all.stderr, /product_approval_protocol_and_consumer/);
  assert.match(all.stderr, /CE-A01 live access remains pending/);

  const access = spawnSync("make", ["acceptance", "TARGET=access-preflight"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(access.status, 2, "CE-A01 acceptance must wait for actual owner and access evidence");
  const accessGate = JSON.parse(access.stdout);
  assert.equal(accessGate.target, "CE-A01");
  assert.equal(accessGate.acceptance_allowed, false);
  assert.equal(accessGate.provider_dispatches, 0);
  assert.equal(accessGate.cells.length, 8);
  assert.ok(accessGate.missing_owner_evidence.includes("openai_edit_account_permission_and_quota"));
  assert.ok(accessGate.missing_owner_evidence.includes("external_grant_and_finance_reservation"));
});

test("acceptance requires an accepted proposal, pinned input bytes, canonical schema hashes, and matching review evidence", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "contracts-acceptance-"));
  try {
    const payload = { contract: "example/1", keys: ["id", "value"] };
    const payloadBytes = Buffer.from(JSON.stringify(payload, null, 2) + "\n");
    await mkdir(path.join(tempRoot, "evidence"), { recursive: true });
    await writeFile(path.join(tempRoot, "evidence", "schema.json"), payloadBytes);
    const schemaHash = canonicalHash(payload);
    const fileSha256 = "sha256:" + createHash("sha256").update(payloadBytes).digest("hex");
    const accepted = {
      proposal_state: "accepted",
      agreements: {},
    };
    for (const id of [
      "shared_contracts_creative_schemas",
      "event_intelligence_producer",
      "trusted_project_membership",
      "creative_controls_consumer",
      "shared_contracts_decision_port",
      "harness_decision_port_consumer",
      "harness_jev_transport_owner",
      "finance_metering_budget_protocol",
      "shared_contracts_usage_budget_schemas",
      "product_approval_protocol_and_consumer",
      "production_artwork_handoff",
      "shared_contracts_approval_handoff_schemas",
    ]) {
      const acceptedCommit = "b".repeat(40);
      const ownerRef = "https://example.test/owners/" + id;
      const input = {
        path: "evidence/schema.json",
        owner_ref: ownerRef,
        owner_commit: acceptedCommit,
        file_sha256: fileSha256,
        schema_hash: schemaHash,
      };
      const evidencePath = "evidence/" + id + "-review.json";
      const reviewEvidence = {
        agreement_id: id,
        decision: "accepted",
        owner_role: "test owner",
        owner_ref: ownerRef,
        accepted_commit: acceptedCommit,
        schema_hashes: [schemaHash],
        accepted_inputs: [input],
      };
      const reviewBytes = Buffer.from(JSON.stringify(reviewEvidence, null, 2) + "\n");
      await writeFile(path.join(tempRoot, evidencePath), reviewBytes);
      const reviewHash = "sha256:" + createHash("sha256").update(reviewBytes).digest("hex");
      const verificationPath = "evidence/" + id + "-independent-review.json";
      const verificationEvidence = {
        agreement_id: id,
        verification: "independent_owner_check",
        verifier_role: "independent test reviewer",
        verifier_id: "reviewer-fixture-1",
        checked_at: "2026-10-10T12:00:00Z",
        owner_ref: ownerRef,
        accepted_commit: acceptedCommit,
        owner_review_sha256: reviewHash,
        accepted_inputs: [input],
      };
      const verificationBytes = Buffer.from(JSON.stringify(verificationEvidence, null, 2) + "\n");
      await writeFile(path.join(tempRoot, verificationPath), verificationBytes);
      accepted.agreements[id] = {
        status: "accepted",
        owner_role: "test owner",
        owner_ref: ownerRef,
        accepted_commit: acceptedCommit,
        schema_hashes: [schemaHash],
        accepted_inputs: [input],
        review_record: {
          path: evidencePath,
          sha256: reviewHash,
        },
        independent_verification: {
          status: "verified",
          record: {
            path: verificationPath,
            sha256: "sha256:" + createHash("sha256").update(verificationBytes).digest("hex"),
          },
        },
      };
    }

    const valid = await evaluateAcceptanceRecord(accepted, "contracts", tempRoot);
    assert.deepEqual(valid.unmet, []);
    assert.deepEqual((await evaluateAcceptanceRecord(accepted, "metering-contract", tempRoot)).unmet, []);
    assert.deepEqual((await evaluateAcceptanceRecord(accepted, "handoff-contract", tempRoot)).unmet, []);
    assert.deepEqual((await evaluateAcceptanceRecord(accepted, "all", tempRoot)).unmet, []);
    const pendingProposal = { ...accepted, proposal_state: "pending_external_owner_agreement" };
    assert.equal((await evaluateAcceptanceRecord(pendingProposal, "contracts", tempRoot)).unmet.length, 4);
    assert.equal((await evaluateAcceptanceRecord(pendingProposal, "metering-contract", tempRoot)).unmet.length, 2);
    assert.equal((await evaluateAcceptanceRecord(pendingProposal, "handoff-contract", tempRoot)).unmet.length, 3);
    assert.equal((await evaluateAcceptanceRecord(pendingProposal, "all", tempRoot)).unmet.length, 12);

    const awaitingIndependentReview = structuredClone(accepted);
    for (const agreement of Object.values(awaitingIndependentReview.agreements)) {
      agreement.independent_verification.status = "pending";
    }
    assert.equal((await evaluateAcceptanceRecord(awaitingIndependentReview, "contracts", tempRoot)).unmet.length, 4);
    assert.equal((await evaluateAcceptanceRecord(awaitingIndependentReview, "metering-contract", tempRoot)).unmet.length, 2);
    assert.equal((await evaluateAcceptanceRecord(awaitingIndependentReview, "handoff-contract", tempRoot)).unmet.length, 3);
    assert.equal((await evaluateAcceptanceRecord(awaitingIndependentReview, "all", tempRoot)).unmet.length, 12);

    const forged = structuredClone(accepted);
    for (const agreement of Object.values(forged.agreements)) {
      agreement.accepted_commit = "0".repeat(40);
      agreement.schema_hashes = ["sha256:" + "0".repeat(64)];
      agreement.review_record = "owner reviewed and accepted";
    }
    assert.equal((await evaluateAcceptanceRecord(forged, "contracts", tempRoot)).unmet.length, 4);
    assert.equal((await evaluateAcceptanceRecord(forged, "metering-contract", tempRoot)).unmet.length, 2);
    assert.equal((await evaluateAcceptanceRecord(forged, "handoff-contract", tempRoot)).unmet.length, 3);
    assert.equal((await evaluateAcceptanceRecord(forged, "all", tempRoot)).unmet.length, 12);

    const tampered = structuredClone(accepted);
    tampered.agreements.shared_contracts_creative_schemas.accepted_inputs[0].file_sha256 = "sha256:" + "a".repeat(64);
    assert.ok((await evaluateAcceptanceRecord(tampered, "contracts", tempRoot)).unmet.includes("shared_contracts_creative_schemas"));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
