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
    const pendingProposal = { ...accepted, proposal_state: "pending_external_owner_agreement" };
    assert.equal((await evaluateAcceptanceRecord(pendingProposal, "contracts", tempRoot)).unmet.length, 4);

    const awaitingIndependentReview = structuredClone(accepted);
    for (const agreement of Object.values(awaitingIndependentReview.agreements)) {
      agreement.independent_verification.status = "pending";
    }
    assert.equal((await evaluateAcceptanceRecord(awaitingIndependentReview, "contracts", tempRoot)).unmet.length, 4);

    const forged = structuredClone(accepted);
    for (const agreement of Object.values(forged.agreements)) {
      agreement.accepted_commit = "0".repeat(40);
      agreement.schema_hashes = ["sha256:" + "0".repeat(64)];
      agreement.review_record = "owner reviewed and accepted";
    }
    assert.equal((await evaluateAcceptanceRecord(forged, "contracts", tempRoot)).unmet.length, 4);

    const tampered = structuredClone(accepted);
    tampered.agreements.shared_contracts_creative_schemas.accepted_inputs[0].file_sha256 = "sha256:" + "a".repeat(64);
    assert.ok((await evaluateAcceptanceRecord(tampered, "contracts", tempRoot)).unmet.includes("shared_contracts_creative_schemas"));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
