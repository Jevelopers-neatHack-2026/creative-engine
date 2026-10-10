import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  applyResearchInvalidation,
  buildCreativeBrief,
  persistCreativeBrief,
  resolveAssetUse,
} from "../../src/planning/index.mjs";
import { createCreativeBriefStore, openCreativeBriefStore } from "../../src/planning/store.mjs";
import {
  completeResearchPackage,
  conflictingDateResearchPackage,
  companyUrlResearchPackage,
  deniedAssetResearchPackage,
  injectedSourceResearchPackage,
  missingDateResearchPackage,
  syntheticAdmissionCredentialResearchPackage,
} from "../../fixtures/planning/research-packages.mjs";

const trustedScope = Object.freeze({ tenant_id: "tenant-1", project_id: "project-1" });
const baseTime = "2026-10-10T12:00:00.000Z";

function plan(researchPackage = completeResearchPackage(), createdAt = baseTime, extra = {}) {
  return buildCreativeBrief({
    trusted_scope: trustedScope,
    research_package: researchPackage,
    context: { created_at: createdAt, environment: "test", billing_mode: "simulated" },
    ...extra,
  });
}

function expectCode(code, callback) {
  assert.throws(callback, (error) => error?.code === code);
}

async function temporaryStore(t) {
  const dir = await mkdtemp(join(tmpdir(), "creative-brief-store-"));
  const path = join(dir, "briefs.sqlite");
  t.after(async () => rm(dir, { recursive: true, force: true }));
  return { dir, path };
}

function invalidationEvent(briefPlan, { eventId = "source-change-2", revision = 2, occurredAt = baseTime } = {}) {
  return {
    event_id: eventId,
    tenant_id: trustedScope.tenant_id,
    project_id: trustedScope.project_id,
    source_package_id: briefPlan.research_provenance.package_id,
    source_package_hash: briefPlan.research_provenance.package_hash,
    source_revision: revision,
    occurred_at: occurredAt,
    kind: "asset",
    reason: "asset_permission_revoked",
    assets: [{ asset_id: "asset-1", content_hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }],
    affected_briefs: [{ brief_id: briefPlan.brief.brief_id, brief_hash: briefPlan.brief_hash }],
  };
}

function syntheticVerifier(clock) {
  return {
    async verifyInvalidation({ event }) {
      return {
        status: "verified",
        classification: "synthetic_test",
        evidence_ref: "fixture-owner-proof",
        event_hash: event.content_hash,
        event_id: event.event_id,
        tenant_id: event.tenant_id,
        project_id: event.project_id,
        verified_at: clock.now(),
        valid_until: "2026-10-10T13:00:00.000Z",
      };
    },
  };
}

function stalenessPort({ fail = false, order = [] } = {}) {
  return {
    async markBriefStale(request) {
      order.push("approval-stale");
      if (fail) return { status: "denied", request_id: request.request_id };
      return {
        status: "acknowledged",
        request_id: request.request_id,
        brief_id: request.brief_id,
        brief_hash: request.brief_hash,
        event_id: request.event_id,
        tenant_id: request.tenant_id,
        project_id: request.project_id,
      };
    },
  };
}

function producerAckPort(order = []) {
  return {
    async acknowledgeInvalidation(request) {
      order.push("producer-ack");
      return {
        status: "acknowledged",
        event_id: request.event_id,
        idempotency_key: request.idempotency_key,
        event_hash: request.event_hash,
        tenant_id: request.tenant_id,
        project_id: request.project_id,
      };
    },
  };
}

test("brief planning is repeatable, separates source facts/preferences/interpretation/locks, and never dispatches", () => {
  const first = plan(completeResearchPackage());
  const second = plan(completeResearchPackage());

  assert.deepEqual(first, second);
  assert.equal(first.brief.contract, "CreativeBrief");
  assert.equal(first.brief.schema_version, "1.0");
  assert.equal(first.required_facts.every((entry) => entry.status === "ready"), true);
  assert.equal(first.brief.facts.verified.some((fact) => fact.key === "event_name"), true);
  assert.equal(first.brief.preferences.items.some((item) => item.origin === "research_package"), true);
  assert.equal(first.brief.interpretations.items.some((item) => item.origin === "research_untrusted"), true);
  assert.equal(first.brief.locks.items.some((item) => item.origin === "research_package"), true);
  assert.equal(first.brief.permissions.items[0].status, "granted");
  assert.equal(first.asset_readiness[0].state, "verification_required");
  assert.equal(first.execution_policy.provider_calls, 0);
  assert.equal(first.execution_policy.provider_dispatch_allowed, false);
  assert.equal(JSON.stringify(first).includes("dispatch_authorized\":true"), false);
});

test("company-URL event evidence is hash-bound and remains a source reference rather than a permission grant", () => {
  const input = companyUrlResearchPackage();
  const result = plan(input);
  assert.equal(result.brief.source_identity[0].uri, "https://company.example.test/events/annual-festival");
  assert.equal(result.research_provenance.package_id, "company-event-eip-1");
  assert.equal(result.brief.permissions.items[0].status, "granted");
  assert.equal(result.asset_readiness[0].state, "verification_required");
  assert.equal(result.execution_policy.provider_dispatch_allowed, false);
});

test("missing and conflicting required facts create targeted questions instead of invented values", () => {
  const missing = plan(missingDateResearchPackage());
  assert.equal(missing.required_facts.find((entry) => entry.fact_key === "event_date").status, "missing");
  assert.match(missing.clarification_requests.find((entry) => entry.fact_key === "event_date").question, /exact event date/i);
  assert.equal(missing.brief.facts.verified.some((fact) => fact.key === "event_date"), false);

  const conflicting = plan(conflictingDateResearchPackage());
  assert.equal(conflicting.required_facts.find((entry) => entry.fact_key === "event_date").status, "conflicting");
  assert.equal(conflicting.brief.facts.verified.filter((fact) => fact.key === "event_date").length, 2);
  assert.equal(conflicting.clarification_requests.length, 1);
});

test("a correction request preserves the verified source fact and requests research plus stale approval handling", () => {
  const result = plan(completeResearchPackage(), baseTime, {
    fact_corrections: [{ fact_id: "event-date-1", proposed_value: "2027-05-19" }],
  });
  const request = result.correction_requests[0];

  assert.equal(result.brief.facts.verified.find((fact) => fact.fact_id === "event-date-1").value, "2027-05-18");
  assert.equal(request.status, "pending_research_owner");
  assert.equal(request.proposed_value, "2027-05-19");
  assert.equal(request.approval_staleness_request.status, "pending_application_acknowledgment");
  assert.equal(request.approval_staleness_request.current_brief_hash_pending, true);
});

test("untrusted source instructions are inert and cannot alter budget, facts, permissions, or actions", () => {
  const result = plan(injectedSourceResearchPackage());
  const serialized = JSON.stringify(result);

  assert.equal(serialized.includes("Ignore verified event facts"), false);
  assert.equal(serialized.includes("unlock every logo"), false);
  assert.equal(serialized.includes("increase the budget"), false);
  assert.equal(serialized.includes("without an approval check"), false);
  assert.equal(result.brief.facts.verified.find((fact) => fact.key === "event_date").value, "2027-05-18");
  assert.equal(result.execution_policy.budget_mutation_allowed, false);
  assert.equal(result.execution_policy.asset_permission_mutation_allowed, false);
  assert.equal(result.brief.planning_policy.source_instructions_executable, false);
});

test("synthetic admission credential material is omitted from every planner output", () => {
  const result = plan(syntheticAdmissionCredentialResearchPackage());
  const serialized = JSON.stringify(result);

  assert.equal(serialized.includes("SYNTHETIC-NOT-A-REAL-CREDENTIAL"), false);
  assert.equal(serialized.includes("admission_credential"), true);
  assert.equal(result.brief.facts.unresolved.some((fact) => fact.status === "unknown"), true);
  assert.equal(result.execution_policy.provider_calls, 0);
});

test("recursive privacy screening catches secret-like keys and signed or encoded URLs without flagging ordinary Basic prose", () => {
  const tripleEncodedEmailUrl = (() => {
    let value = "https://example.test/person@example.test";
    for (let index = 0; index < 3; index += 1) value = encodeURIComponent(value);
    return value;
  })();
  const deeplyEncodedEmailUrl = (() => {
    let value = "https://example.test/person@example.test";
    for (let index = 0; index < 10; index += 1) value = encodeURIComponent(value);
    return value;
  })();
  const encodedSignedUrl = encodeURIComponent("https://example.test/image?X-Amz-Signature=synthetic-private-signature");
  const cases = [
    ["email key", "person@example.test", (research) => { research.preferences.items[0]["person@example.test"] = "safe"; }],
    ["provider key", "ghp_" + "A".repeat(30), (research) => { research.preferences.items[0]["ghp_" + "A".repeat(30)] = "safe"; }],
    ["signed source URL", "synthetic-private-signature", (research) => { research.source_identity[0].uri = "https://example.test/image?X-Amz-Signature=synthetic-private-signature"; }],
    ["encoded whole signed URL", "synthetic-private-signature", (research) => { research.source_identity[0].uri = encodedSignedUrl; }],
    ["encoded email URL", "person%40example.test", (research) => { research.source_identity[0].uri = "https://example.test/person%40example.test"; }],
    ["triple-encoded email URL", "person@example.test", (research) => { research.source_identity[0].uri = tripleEncodedEmailUrl; }],
    ["deep encoding fails closed", "person@example.test", (research) => { research.source_identity[0].uri = deeplyEncodedEmailUrl; }],
    ["URL userinfo", "user:password", (research) => { research.source_identity[0].uri = "https://user:password@example.test/path"; }],
    ["nested sensitive key", "person@example.test", (research) => { research.preferences.items[0]["person@example.test"] = { authorization: "synthetic-private-value" }; }],
  ];
  for (const [name, marker, mutate] of cases) {
    const research = completeResearchPackage();
    mutate(research);
    let failure;
    try { plan(research); } catch (error) { failure = error; }
    assert.equal(failure?.code, "sensitive_input", name);
    assert.equal(`${failure.message} ${failure.field} ${failure.stack}`.includes(marker), false, name);
  }
  const ordinaryEncodedUrl = completeResearchPackage();
  ordinaryEncodedUrl.source_identity[0].uri = "https://example.test/illustrations%20for%20the%20event";
  assert.equal(plan(ordinaryEncodedUrl).brief.source_identity[0].uri,
    "https://example.test/illustrations%20for%20the%20event");
});

test("Basic prose remains usable while credential-looking values are rejected", () => {
  const result = plan(completeResearchPackage(), baseTime, {
    customer_preferences: [{ preference_id: "illustration-style", value: "Basic illustrations with warm colors" }],
  });
  assert.equal(result.brief.preferences.items.some((item) => item.value === "Basic illustrations with warm colors"), true);
  assert.equal(plan(completeResearchPackage(), baseTime, {
    customer_preferences: [{ preference_id: "basic-shapes", value: "Basic shapes" }],
  }).brief.preferences.items.some((item) => item.value === "Basic shapes"), true);
  let failure;
  try {
    plan(completeResearchPackage(), baseTime, {
      customer_preferences: [{ preference_id: "auth-style", value: "Basic dTpw" }],
    });
  } catch (error) { failure = error; }
  assert.equal(failure?.code, "sensitive_input");
  assert.equal(`${failure.message} ${failure.field} ${failure.stack}`.includes("dTpw"), false);

  const unicodeBasic = "Basic " + Buffer.from("üser:päss", "utf8").toString("base64");
  failure = undefined;
  try {
    plan(completeResearchPackage(), baseTime, {
      customer_preferences: [{ preference_id: "unicode-auth-style", value: unicodeBasic }],
    });
  } catch (error) { failure = error; }
  assert.equal(failure?.code, "sensitive_input");
  assert.equal(`${failure.message} ${failure.field} ${failure.stack}`.includes(unicodeBasic), false);

  failure = undefined;
  try {
    plan(completeResearchPackage(), baseTime, {
      customer_preferences: [{ preference_id: "empty-basic-auth", value: "Basic Og==" }],
    });
  } catch (error) { failure = error; }
  assert.equal(failure?.code, "sensitive_input");
  assert.equal(`${failure.message} ${failure.field} ${failure.stack}`.includes("Og=="), false);
});

test("prototype-named additional fact keys produce ordinary missing-fact clarifications", () => {
  const result = plan(completeResearchPackage(), baseTime, {
    additional_required_fact_keys: ["constructor", "toString"],
  });
  assert.deepEqual(result.required_facts.filter((item) => ["constructor", "toString"].includes(item.fact_key))
    .map((item) => [item.fact_key, item.status]), [["constructor", "missing"], ["toString", "missing"]]);
  assert.equal(result.clarification_requests.every((item) => typeof item.question === "string" && item.question.length > 0), true);
});

test("denied assets remain blocked and original artwork is offered without using the denied asset", () => {
  const result = plan(deniedAssetResearchPackage());

  assert.equal(result.asset_readiness[0].state, "blocked");
  assert.equal(result.asset_readiness[0].reason, "permission_denied");
  assert.deepEqual(result.original_artwork_alternative, {
    available_when_assets_blocked: true,
    uses_research_assets: false,
    preserves_verified_fact_ids: ["event-date-1", "event-name-1"],
  });
});

test("changed source hashes create immutable consecutive brief versions and survive a real SQLite restart", async (t) => {
  const { path } = await temporaryStore(t);
  let store = openCreativeBriefStore(path, trustedScope);
  const firstPlan = plan(completeResearchPackage(), baseTime);
  const first = persistCreativeBrief(store, firstPlan, trustedScope);
  const duplicate = persistCreativeBrief(store, firstPlan, trustedScope);
  const changedResearch = completeResearchPackage();
  changedResearch.facts.find((fact) => fact.key === "event_date").value = "2027-05-20";
  const secondPlan = plan(changedResearch, "2026-10-10T12:05:00.000Z");
  const second = persistCreativeBrief(store, secondPlan, trustedScope);

  assert.equal(first.version_no, 1);
  assert.equal(duplicate.version_no, 1);
  assert.equal(second.version_no, 2);
  assert.equal(first.brief_id, second.brief_id);
  assert.notEqual(first.brief_hash, second.brief_hash);
  assert.equal(Object.isFrozen(first.brief), true);
  assert.equal(first.brief.facts.verified.find((fact) => fact.key === "event_date").value, "2027-05-18");
  assert.equal(second.brief.facts.verified.find((fact) => fact.key === "event_date").value, "2027-05-20");
  assert.equal(store.getBriefHistory(first.brief_id).length, 2);
  store.close();

  store = openCreativeBriefStore(path, trustedScope);
  t.after(() => store.close());
  const history = store.getBriefHistory(first.brief_id);
  assert.deepEqual(history.map((entry) => entry.brief_hash), [first.brief_hash, second.brief_hash]);
  assert.equal(history[0].brief.facts.verified.find((fact) => fact.key === "event_date").value, "2027-05-18");
  assert.equal(history[1].brief.facts.verified.find((fact) => fact.key === "event_date").value, "2027-05-20");
  const direct = new DatabaseSync(path);
  assert.throws(() => direct.prepare("UPDATE creative_brief_versions SET created_at = ? WHERE brief_id = ?").run(baseTime, first.brief_id));
  assert.throws(() => direct.prepare("DELETE FROM creative_brief_versions WHERE brief_id = ?").run(first.brief_id));
  direct.close();
});

test("persistence rejects a brief bound to another tenant or a hash that does not match its bytes", () => {
  const result = plan();
  const memory = openCreativeBriefStore(":memory:", trustedScope);
  assert.throws(() => persistCreativeBrief(memory, result, { tenant_id: "tenant-2", project_id: "project-1" }),
    (error) => error.code === "scope_mismatch");
  const changed = { ...result, brief_hash: "sha256:" + "0".repeat(64) };
  assert.throws(() => persistCreativeBrief(memory, changed, trustedScope), (error) => error.code === "brief_hash_mismatch");
  const alteredPlan = { ...result, execution_policy: { ...result.execution_policy, provider_calls: 1 } };
  assert.throws(() => persistCreativeBrief(memory, alteredPlan, trustedScope), (error) => error.code === "plan_hash_mismatch");
  memory.close();
});

test("asset resolution rejects a plan whose policy or other immutable fields were changed", async () => {
  const original = plan();
  const alteredPlan = { ...original, execution_policy: { ...original.execution_policy, asset_permission_mutation_allowed: true } };
  await assert.rejects(resolveAssetUse({
    trusted_scope: trustedScope,
    plan: alteredPlan,
    research_package: completeResearchPackage(),
    clock: { now: () => baseTime },
    invalidation_store: { isAssetFenced: () => false },
    permission_verifier: { async verifyAssetUse() { throw new Error("a modified plan must fail before permission verification"); } },
  }), (error) => error.code === "plan_hash_mismatch");
});

test("permission resolution blocks expired, cross-tenant, or durably fenced assets and never authorizes dispatch", async () => {
  const briefPlan = plan();
  let now = baseTime;
  const clock = { now: () => now };
  const store = {
    isAssetFenced(_tenantId, _projectId, assetId) { return assetId === "asset-1"; },
  };
  const proofFor = (overrides = {}) => ({
    status: "granted",
    tenant_id: trustedScope.tenant_id,
    project_id: trustedScope.project_id,
    asset_id: "asset-1",
    content_hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    action: "reproduce",
    package_id: briefPlan.research_provenance.package_id,
    package_hash: briefPlan.research_provenance.package_hash,
    owner_evidence_status: "verified",
    evidence_ref: "owner-proof-1",
    checked_at: baseTime,
    expires_at: "2026-10-10T12:10:00.000Z",
    ...overrides,
  });
  const resolve = (proof) => resolveAssetUse({
    trusted_scope: trustedScope,
    plan: briefPlan,
    research_package: completeResearchPackage(),
    clock,
    invalidation_store: store,
    permission_verifier: { async verifyAssetUse() { return proof; } },
  });

  assert.equal((await resolve(proofFor())) .decisions[0].reason, "asset_invalidation_fence_active");
  store.isAssetFenced = () => false;
  now = "2026-10-10T12:11:00.000Z";
  assert.equal((await resolve(proofFor())) .decisions[0].reason, "permission_proof_expired_or_unverified");
  now = baseTime;
  assert.equal((await resolve(proofFor({ tenant_id: "tenant-foreign" }))).decisions[0].reason, "permission_proof_unavailable_or_mismatched");
  const eligible = await resolve(proofFor());
  assert.equal(eligible.decisions[0].state, "eligible_for_downstream_revalidation");
  assert.equal(eligible.decisions[0].permission_evidence_ref, undefined);
  assert.equal(typeof eligible.decisions[0].permission_evidence_ref_hash, "string");
  assert.equal(eligible.dispatch_authorized, false);
});

test("permission evidence is rechecked against current time after the async owner verifier returns", async () => {
  const briefPlan = plan();
  let now = baseTime;
  const result = await resolveAssetUse({
    trusted_scope: trustedScope,
    plan: briefPlan,
    research_package: completeResearchPackage(),
    clock: { now: () => now },
    invalidation_store: { isAssetFenced: () => false },
    permission_verifier: {
      async verifyAssetUse() {
        now = "2026-10-10T12:11:00.000Z";
        return {
          status: "granted",
          tenant_id: trustedScope.tenant_id,
          project_id: trustedScope.project_id,
          asset_id: "asset-1",
          content_hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          action: "reproduce",
          package_id: briefPlan.research_provenance.package_id,
          package_hash: briefPlan.research_provenance.package_hash,
          owner_evidence_status: "verified",
          evidence_ref: "owner-proof-1",
          checked_at: baseTime,
          expires_at: "2026-10-10T12:10:00.000Z",
        };
      },
    },
  });
  assert.equal(result.decisions[0].reason, "permission_proof_expired_or_unverified");
});

test("asset permission verifier failures are reduced to a safe blocked result", async () => {
  const briefPlan = plan();
  const result = await resolveAssetUse({
    trusted_scope: trustedScope,
    plan: briefPlan,
    research_package: completeResearchPackage(),
    clock: { now: () => baseTime },
    invalidation_store: { isAssetFenced: () => false },
    permission_verifier: { async verifyAssetUse() { throw new Error("Bearer synthetic-permission-secret"); } },
  });
  assert.equal(result.decisions[0].state, "blocked");
  assert.equal(result.decisions[0].reason, "permission_verifier_unavailable");
  assert.equal(JSON.stringify(result).includes("synthetic-permission-secret"), false);
});

test("invalidation verifies exact owner evidence, persists a fence before acknowledgments, and rejects forged proof", async (t) => {
  const { path } = await temporaryStore(t);
  const store = openCreativeBriefStore(path, trustedScope);
  const briefPlan = plan();
  persistCreativeBrief(store, briefPlan, trustedScope);
  const event = invalidationEvent(briefPlan);
  const clock = { now: () => baseTime };
  const order = [];
  const result = await applyResearchInvalidation({
    trusted_scope: trustedScope,
    event,
    ports: {
      clock,
      store,
      verifier: syntheticVerifier(clock),
      approvalStaleness: stalenessPort({ order }),
      producerAcknowledgment: producerAckPort(order),
    },
  });

  assert.equal(result.durable_receipt.verification_classification, "synthetic_test");
  assert.equal(store.isAssetFenced(trustedScope.tenant_id, trustedScope.project_id, "asset-1", event.assets[0].content_hash), true);
  assert.deepEqual(order, ["approval-stale", "producer-ack"]);
  assert.equal(result.approval_staleness.status, "acknowledged");
  assert.equal(result.producer_acknowledgment.status, "acknowledged");
  assert.throws(() => store.persistInvalidationAndFences(result.durable_receipt, {
    __verified_in_memory: true,
    classification: "owner_verified",
  }), (error) => error.code === "invalidation_unverified");
  store.close();
});

test("invalidation owner verifier exceptions are returned only as a safe typed failure", async () => {
  const store = openCreativeBriefStore(":memory:", trustedScope);
  const briefPlan = plan();
  persistCreativeBrief(store, briefPlan, trustedScope);
  const event = invalidationEvent(briefPlan);
  let failure;
  try {
    await applyResearchInvalidation({
      trusted_scope: trustedScope,
      event,
      ports: {
        clock: { now: () => baseTime },
        store,
        verifier: { async verifyInvalidation() { throw new Error("Bearer synthetic-invalidation-secret"); } },
      },
    });
  } catch (error) {
    failure = error;
  }
  assert.equal(failure.code, "invalidation_verification_unavailable");
  assert.equal(`${failure.name} ${failure.message} ${failure.stack}`.includes("synthetic-invalidation-secret"), false);
  assert.equal(store.getInvalidationHistory().length, 0);
  store.close();
});

test("caller-owned SQLite transactions cannot produce provisional external acknowledgments", async (t) => {
  const database = new DatabaseSync(":memory:");
  const store = createCreativeBriefStore({ database, trustedScope });
  t.after(() => {
    if (database.isTransaction) database.exec("ROLLBACK");
    store.close();
    database.close();
  });
  const briefPlan = plan();
  persistCreativeBrief(store, briefPlan, trustedScope);
  const event = invalidationEvent(briefPlan);
  const order = [];

  database.exec("BEGIN");
  await assert.rejects(applyResearchInvalidation({
    trusted_scope: trustedScope,
    event,
    ports: {
      clock: { now: () => baseTime },
      store,
      verifier: syntheticVerifier({ now: () => baseTime }),
      approvalStaleness: stalenessPort({ order }),
      producerAcknowledgment: producerAckPort(order),
    },
  }), (error) => error.code === "invalidation_transaction_active");
  assert.deepEqual(order, []);
  database.exec("ROLLBACK");
  assert.equal(store.isAssetFenced(trustedScope.tenant_id, trustedScope.project_id, "asset-1", event.assets[0].content_hash), false);
  assert.equal(store.getInvalidationHistory().length, 0);
});

test("a caller transaction opened during owner verification stops before provisional fence persistence", async (t) => {
  const database = new DatabaseSync(":memory:");
  const store = createCreativeBriefStore({ database, trustedScope });
  t.after(() => {
    if (database.isTransaction) database.exec("ROLLBACK");
    store.close();
    database.close();
  });
  const briefPlan = plan();
  persistCreativeBrief(store, briefPlan, trustedScope);
  const event = invalidationEvent(briefPlan);
  const order = [];
  const synthetic = syntheticVerifier({ now: () => baseTime });
  await assert.rejects(applyResearchInvalidation({
    trusted_scope: trustedScope,
    event,
    ports: {
      clock: { now: () => baseTime },
      store,
      verifier: {
        async verifyInvalidation(input) {
          const evidence = await synthetic.verifyInvalidation(input);
          database.exec("BEGIN");
          return evidence;
        },
      },
      approvalStaleness: stalenessPort({ order }),
      producerAcknowledgment: producerAckPort(order),
    },
  }), (error) => error.code === "invalidation_transaction_active");
  assert.deepEqual(order, []);
  assert.equal(store.getInvalidationHistory().length, 0);
  database.exec("ROLLBACK");
  assert.equal(store.isAssetFenced(trustedScope.tenant_id, trustedScope.project_id, "asset-1", event.assets[0].content_hash), false);
});

test("a transaction opened during an approval callback cannot lead to producer acknowledgment", async (t) => {
  const database = new DatabaseSync(":memory:");
  const store = createCreativeBriefStore({ database, trustedScope });
  t.after(() => {
    if (database.isTransaction) database.exec("ROLLBACK");
    store.close();
    database.close();
  });
  const briefPlan = plan();
  persistCreativeBrief(store, briefPlan, trustedScope);
  const event = invalidationEvent(briefPlan);
  const order = [];
  await assert.rejects(applyResearchInvalidation({
    trusted_scope: trustedScope,
    event,
    ports: {
      clock: { now: () => baseTime },
      store,
      verifier: syntheticVerifier({ now: () => baseTime }),
      approvalStaleness: {
        async markBriefStale(request) {
          order.push("approval-stale");
          database.exec("BEGIN");
          return {
            status: "acknowledged",
            request_id: request.request_id,
            brief_id: request.brief_id,
            brief_hash: request.brief_hash,
            event_id: request.event_id,
            tenant_id: request.tenant_id,
            project_id: request.project_id,
          };
        },
      },
      producerAcknowledgment: producerAckPort(order),
    },
  }), (error) => error.code === "invalidation_transaction_active");
  assert.deepEqual(order, ["approval-stale"]);
  assert.equal(store.getInvalidationHistory().length, 1);
  assert.equal(store.getProducerAcknowledgment(trustedScope.tenant_id, trustedScope.project_id, event.event_id), null);
  database.exec("ROLLBACK");

  const replayOrder = [];
  const replay = await applyResearchInvalidation({
    trusted_scope: trustedScope,
    event,
    ports: {
      clock: { now: () => baseTime },
      store,
      approvalStaleness: stalenessPort({ order: replayOrder }),
      producerAcknowledgment: producerAckPort(replayOrder),
    },
  });
  assert.deepEqual(replayOrder, ["approval-stale", "producer-ack"]);
  assert.equal(replay.producer_acknowledgment.status, "acknowledged");
  assert.equal(store.isAssetFenced(trustedScope.tenant_id, trustedScope.project_id, "asset-1", event.assets[0].content_hash), true);
});

test("duplicate and out-of-order invalidations survive restart without removing an asset fence", async (t) => {
  const { path } = await temporaryStore(t);
  let store = openCreativeBriefStore(path, trustedScope);
  const briefPlan = plan();
  persistCreativeBrief(store, briefPlan, trustedScope);
  const event2 = invalidationEvent(briefPlan, { eventId: "source-change-2", revision: 2 });
  const clock = { now: () => baseTime };
  let verifierCalls = 0;
  const verifier = {
    async verifyInvalidation({ event }) {
      verifierCalls += 1;
      return {
        ...await syntheticVerifier(clock).verifyInvalidation({ event }),
        valid_until: "2026-10-10T13:00:00.000Z",
      };
    },
  };
  const pending = await applyResearchInvalidation({
    trusted_scope: trustedScope,
    event: event2,
    ports: { clock, store, verifier },
  });
  assert.equal(pending.approval_staleness.status, "pending");
  assert.equal(pending.producer_acknowledgment, null);
  assert.equal(store.isAssetFenced(trustedScope.tenant_id, trustedScope.project_id, "asset-1", event2.assets[0].content_hash), true);
  assert.throws(() => store.recordProducerAcknowledgment({
    status: "acknowledged",
    event_id: event2.event_id,
    event_hash: pending.event_hash,
    idempotency_key: pending.durable_receipt.idempotency_key,
    tenant_id: trustedScope.tenant_id,
    project_id: trustedScope.project_id,
  }), (error) => error.code === "approval_staleness_pending");
  store.close();

  store = openCreativeBriefStore(path, trustedScope);
  const order = [];
  const replay = await applyResearchInvalidation({
    trusted_scope: trustedScope,
    event: event2,
    ports: {
      clock,
      store,
      verifier: { async verifyInvalidation() { throw new Error("stored duplicate must not need a new owner proof"); } },
      approvalStaleness: stalenessPort({ order }),
      producerAcknowledgment: producerAckPort(order),
    },
  });
  assert.equal(replay.durable_receipt.receipt_id, pending.durable_receipt.receipt_id);
  assert.equal(replay.approval_staleness.status, "acknowledged");
  assert.deepEqual(order, ["approval-stale", "producer-ack"]);
  assert.equal(store.isAssetFenced(trustedScope.tenant_id, trustedScope.project_id, "asset-1", event2.assets[0].content_hash), true);
  const acknowledgedReplay = await applyResearchInvalidation({
    trusted_scope: trustedScope,
    event: event2,
    ports: {
      clock,
      store,
      approvalStaleness: { async markBriefStale() { throw new Error("an acknowledged stale request must not be repeated"); } },
      producerAcknowledgment: { async acknowledgeInvalidation() { throw new Error("an acknowledged producer receipt must not be repeated"); } },
    },
  });
  assert.equal(acknowledgedReplay.approval_staleness.status, "acknowledged");
  assert.equal(acknowledgedReplay.approval_staleness.acknowledged, 1);

  const event1 = invalidationEvent(briefPlan, {
    eventId: "source-change-1",
    revision: 1,
    occurredAt: "2026-10-10T11:00:00.000Z",
  });
  await applyResearchInvalidation({
    trusted_scope: trustedScope,
    event: event1,
    ports: { clock, store, verifier, approvalStaleness: stalenessPort(), producerAcknowledgment: producerAckPort() },
  });
  assert.equal(store.isAssetFenced(trustedScope.tenant_id, trustedScope.project_id, "asset-1", event1.assets[0].content_hash), true);
  assert.deepEqual(store.getInvalidationHistory().map((entry) => entry.source_revision), [1, 2]);
  assert.equal(verifierCalls, 2);
  const direct = new DatabaseSync(path);
  assert.throws(() => direct.prepare("DELETE FROM creative_invalidation_fences WHERE target_id = ?").run("asset-1"));
  assert.throws(() => direct.prepare("UPDATE creative_invalidation_fences SET target_hash = ? WHERE target_id = ?").run("", "asset-1"));
  direct.close();
  store.close();
});

test("failed downstream acknowledgment leaves durable fences and retryable outbox state", async (t) => {
  const { path } = await temporaryStore(t);
  let store = openCreativeBriefStore(path, trustedScope);
  const briefPlan = plan();
  persistCreativeBrief(store, briefPlan, trustedScope);
  const event = invalidationEvent(briefPlan);
  const clock = { now: () => baseTime };
  await assert.rejects(applyResearchInvalidation({
    trusted_scope: trustedScope,
    event,
    ports: {
      clock,
      store,
      verifier: syntheticVerifier(clock),
      approvalStaleness: stalenessPort({ fail: true }),
      producerAcknowledgment: producerAckPort(),
    },
  }), (error) => error.code === "approval_staleness_unconfirmed");
  assert.equal(store.getInvalidationHistory().length, 1);
  assert.equal(store.getProducerAcknowledgment(trustedScope.tenant_id, trustedScope.project_id, event.event_id), null);
  store.close();

  store = openCreativeBriefStore(path, trustedScope);
  t.after(() => store.close());
  const retry = await applyResearchInvalidation({
    trusted_scope: trustedScope,
    event,
    ports: {
      clock,
      store,
      approvalStaleness: stalenessPort(),
      producerAcknowledgment: producerAckPort(),
    },
  });
  assert.equal(retry.approval_staleness.status, "acknowledged");
  assert.equal(retry.producer_acknowledgment.status, "acknowledged");
  assert.equal(store.isAssetFenced(trustedScope.tenant_id, trustedScope.project_id, "asset-1", event.assets[0].content_hash), true);
});

test("cross-tenant invalidation and unverified owner evidence do not create a fence", async (t) => {
  const store = openCreativeBriefStore(":memory:", trustedScope);
  const briefPlan = plan();
  const foreignEvent = invalidationEvent(briefPlan, { eventId: "foreign-event" });
  foreignEvent.tenant_id = "tenant-foreign";
  await assert.rejects(applyResearchInvalidation({
    trusted_scope: trustedScope,
    event: foreignEvent,
    ports: { clock: { now: () => baseTime }, store, verifier: syntheticVerifier({ now: () => baseTime }) },
  }), (error) => error.code === "scope_mismatch");

  const event = invalidationEvent(briefPlan);
  await assert.rejects(applyResearchInvalidation({
    trusted_scope: trustedScope,
    event,
    ports: {
      clock: { now: () => baseTime },
      store,
      verifier: { async verifyInvalidation({ event: candidate }) {
        return {
          status: "verified",
          classification: "synthetic_test",
          evidence_ref: "fixture-owner-proof",
          event_hash: "sha256:" + "0".repeat(64),
          event_id: candidate.event_id,
          tenant_id: candidate.tenant_id,
          project_id: candidate.project_id,
          verified_at: baseTime,
          valid_until: "2026-10-10T13:00:00.000Z",
        };
      } },
    },
  }), (error) => error.code === "invalidation_unverified");
  assert.equal(store.getInvalidationHistory().length, 0);
  assert.equal(store.isAssetFenced(trustedScope.tenant_id, trustedScope.project_id, "asset-1", event.assets[0].content_hash), false);
  store.close();
});
