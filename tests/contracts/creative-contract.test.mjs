import assert from "node:assert/strict";
import test from "node:test";
import {
  ContractError,
  canonicalHash,
  canonicalSerialize,
} from "../../src/contracts/index.mjs";
import {
  assessResearchReadiness,
  computeDesignVersionHash,
  normalizeResearchPackage,
  validateCreativeBrief,
  validateCreativeScope,
  validateDesignControlSchema,
  validateDesignVersion,
  validateEditPlan,
  validateResearchPackage,
} from "../../src/contracts/creative/v1.mjs";
import { clone, fixture } from "./fixture-utils.mjs";

const trustedScope = {
  tenant_id: "tenant-1",
  project_id: "project-1",
  job_id: "job-1",
  artifact_id: "artifact-1",
  design_version_id: "design-v1",
  brief_id: "brief-1",
};

function expectCode(code, callback) {
  assert.throws(callback, (error) => error instanceof ContractError && error.code === code);
}

test("valid current and local alias packages normalize as EventIntelligencePackage", async () => {
  const current = await fixture("creative/current.json");
  const normalized = validateResearchPackage(current, trustedScope);
  const alias = clone(current);
  alias.contract = "ResearchPackage";
  const aliased = normalizeResearchPackage(alias, trustedScope);

  assert.equal(normalized.contract, "EventIntelligencePackage");
  assert.equal(normalized.schema_version, "1.1");
  assert.equal(aliased.contract, "EventIntelligencePackage");
  assert.equal(aliased.package_id, normalized.package_id);
  assert.equal(canonicalHash(normalized), canonicalHash(validateResearchPackage(clone(current), trustedScope)));
  assert.deepEqual(assessResearchReadiness(normalized), { state: "ready", reasons: [] });
});

test("supported older package migrates values and permissions without granting authority", async () => {
  const old = await fixture("creative/older.json");
  const migrated = validateResearchPackage(old, trustedScope);

  assert.equal(migrated.schema_version, "1.1");
  assert.equal(migrated.contract, "EventIntelligencePackage");
  assert.equal(migrated.facts[0].status, "unknown");
  assert.deepEqual(migrated.facts[0].candidate_values, ["2027-05-18"]);
  assert.equal(migrated.facts[0].provenance[0].source_id, "page-1");
  assert.deepEqual(migrated.permissions, { presence: "unknown", items: [] });
  assert.equal(migrated.migration.legacy_permission_claims_present, true);
  assert.equal(migrated.source_identity[0].retrieved_at_status, "unknown");
  assert.equal(migrated.preferences.presence, "absent");
  assert.equal(canonicalHash(migrated), canonicalHash(validateResearchPackage(clone(old), trustedScope)));
  assert.equal(assessResearchReadiness(migrated).state, "incomplete");
});

test("unknown additive optional package fields are preserved but do not affect typed sections", async () => {
  const input = await fixture("creative/unknown-additive.json");
  const normalized = normalizeResearchPackage(input, trustedScope);
  assert.equal(normalized.future_additive.producer_hint, "non-authoritative");
  assert.equal(normalized.future_additive.revision, 2);
  assert.equal(Object.hasOwn(normalized.future_additive, "__proto__"), true);
  assert.deepEqual(normalized.future_additive.__proto__, { preserved: true });
  assert.equal(Object.getPrototypeOf(normalized.future_additive), Object.prototype);
  const withoutAdditiveField = clone(normalized);
  delete withoutAdditiveField.future_additive;
  assert.notEqual(canonicalHash(normalized), canonicalHash(withoutAdditiveField));
  assert.equal(normalized.permissions.presence, "unknown");
  assert.deepEqual(normalized.permissions.items, []);
  assert.equal(assessResearchReadiness(normalized).state, "ready");
});

test("required fields, malformed references, and unsupported versions fail with typed errors", async () => {
  const current = await fixture("creative/current.json");
  const noId = clone(current);
  delete noId.package_id;
  expectCode("invalid_type", () => validateResearchPackage(noId, trustedScope));
  const badReference = clone(current);
  badReference.facts[0].provenance[0].source_id = "unknown-source";
  expectCode("invalid_reference", () => validateResearchPackage(badReference, trustedScope));
  const wrongMajor = clone(current);
  wrongMajor.schema_version = "2.0";
  expectCode("unsupported_major", () => validateResearchPackage(wrongMajor, trustedScope));
  const wrongMinor = clone(current);
  wrongMinor.schema_version = "1.2";
  expectCode("unsupported_version", () => validateResearchPackage(wrongMinor, trustedScope));
});

test("synthetic admission credentials are omitted from declared and unknown nested fields with reasons", async () => {
  const input = await fixture("creative/privacy-sensitive.json");
  const normalized = normalizeResearchPackage(input, trustedScope);
  const serialized = JSON.stringify(normalized);

  assert.equal(normalized.source_identity[0].source_id, "page-1");
  assert.equal(normalized.source_identity[0].uri, "https://example.test/events/1");
  assert.equal(normalized.facts[0].provenance[0].source_id, "page-1");
  assert.equal(Object.hasOwn(normalized.source_identity[0], "admission_credential"), false);
  assert.equal(Object.hasOwn(normalized.future_source_metadata.audit, "source_credential"), false);
  assert.equal(serialized.includes("SYNTHETIC-NOT-A-REAL-CREDENTIAL"), false);
  assert.deepEqual(normalized.security_redactions.map((item) => item.field_path).sort(), [
    "future_source_metadata.audit.source_credential",
    "source_identity[0].admission_credential",
  ]);
  assert.ok(normalized.security_redactions.every((item) => item.reason === "credential_material_omitted"));

  const brief = await fixture("creative/creative-brief.json");
  const packageInput = await fixture("creative/current.json");
  brief.source_credential = "SYNTHETIC-NOT-A-REAL-CREDENTIAL";
  expectCode("forbidden_sensitive_field", () => validateCreativeBrief(brief, {
    trustedScope,
    researchPackage: packageInput,
  }));
});

test("conflicting facts and missing reproduction permissions remain incomplete", async () => {
  const input = await fixture("creative/current.json");
  input.facts[0].status = "conflicting";
  input.facts[0].candidate_values = ["2027-05-18", "2027-05-19"];
  delete input.facts[0].value;
  input.permissions = { presence: "unknown", items: [] };
  const normalized = validateResearchPackage(input, trustedScope);

  assert.equal(normalized.facts[0].status, "conflicting");
  assert.equal(normalized.permissions.items.length, 0);
  assert.deepEqual(assessResearchReadiness(normalized), {
    state: "incomplete",
    reasons: ["unverified_or_conflicting_facts", "missing_reproduction_permission:asset-1"],
  });
});

test("forged tenant, job, artifact, and signed-claim scopes fail against host context", async () => {
  const attacks = await fixture("creative/scope-attacks.json");
  for (const candidate of Object.values(attacks)) {
    expectCode("scope_mismatch", () => validateCreativeScope(candidate, trustedScope));
  }
  assert.equal(attacks.signed_access_claims.signature, "SYNTHETIC-UNVERIFIED-CLAIMS-NOT-A-REAL-SIGNATURE");
});

test("CreativeBrief binds each fact and source back to the normalized package", async () => {
  const packageInput = await fixture("creative/current.json");
  const researchPackage = normalizeResearchPackage(packageInput, trustedScope);
  const brief = await fixture("creative/creative-brief.json");
  const validated = validateCreativeBrief(brief, { trustedScope, researchPackage });
  assert.equal(validated.brief_id, "brief-1");

  const wrongValue = clone(brief);
  wrongValue.facts.verified[0].value = "2027-05-19";
  expectCode("invalid_reference", () => validateCreativeBrief(wrongValue, { trustedScope, researchPackage }));
  const incompleteProjection = clone(brief);
  incompleteProjection.facts.verified = [];
  expectCode("incomplete_projection", () => validateCreativeBrief(incompleteProjection, { trustedScope, researchPackage }));
});

test("DesignControlSchema names and hashes the local creative-controls payload", async () => {
  const wrapper = await fixture("creative/design-control-schema.json");
  const payload = await fixture("creative/local-control-schema.json");
  const validated = validateDesignControlSchema(wrapper, { trustedScope, controlSchemaPayload: payload });
  assert.equal(validated.control_contract, "creative-controls");
  assert.equal(validated.control_schema_version, payload.schema_version);
  assert.equal(validated.control_schema_hash, canonicalHash(payload));

  const changedPayload = clone(payload);
  changedPayload.locks.push("headline");
  expectCode("hash_mismatch", () => validateDesignControlSchema(wrapper, { trustedScope, controlSchemaPayload: changedPayload }));
});

test("EditPlan accepts only bounded typed actions and references", async () => {
  const plan = await fixture("creative/edit-plan.json");
  const validOptions = {
    trustedScope,
    brief_hash: plan.base.brief_hash,
    known_source_refs: ["source:page-1", "asset:asset-1"],
    design_version_ids: ["design-v1"],
    known_asset_ids: ["asset-1"],
    known_fact_ids: ["event-date-1"],
  };
  assert.equal(validateEditPlan(plan, validOptions).steps.length, 1);

  const unknownAction = clone(plan);
  unknownAction.steps[0].action = "image.render_privileged";
  expectCode("unsupported_action", () => validateEditPlan(unknownAction, validOptions));
  const unknownParameter = clone(plan);
  unknownParameter.steps[0].parameters.shell_command = "unsafe";
  expectCode("unknown_field", () => validateEditPlan(unknownParameter, validOptions));
  const outOfBound = clone(plan);
  outOfBound.steps[0].parameters.changes = Array.from({ length: 33 }, () => ({ field: "x", value: 1 }));
  expectCode("out_of_bounds", () => validateEditPlan(outOfBound, validOptions));
  const forgedBrief = clone(plan);
  expectCode("hash_mismatch", () => validateEditPlan(forgedBrief, { ...validOptions, brief_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }));
});

test("DesignVersion hash is canonical, immutable, and bound to the brief", async () => {
  const base = await fixture("creative/design-version-base.json");
  const version = { ...base, design_hash: computeDesignVersionHash(base) };
  const options = {
    trustedScope,
    brief_hash: version.brief_hash,
    known_source_refs: version.source_refs,
    design_version_ids: ["design-v1"],
  };
  assert.equal(validateDesignVersion(version, options).design_hash, version.design_hash);
  const changed = { ...version, artifact: { ...version.artifact, content_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } };
  expectCode("hash_mismatch", () => validateDesignVersion(changed, options));
  const credentialed = { ...version, source_credential: "SYNTHETIC-NOT-A-REAL-CREDENTIAL" };
  credentialed.design_hash = computeDesignVersionHash(credentialed);
  expectCode("forbidden_sensitive_field", () => validateDesignVersion(credentialed, options));

  assert.equal(canonicalHash({ a: 1, b: ["x", 2] }), canonicalHash({ b: ["x", 2], a: 1 }));
  assert.notEqual(canonicalHash([1, 2]), canonicalHash([2, 1]));
  assert.equal(canonicalSerialize({ negative_zero: -0 }), "{\"negative_zero\":0}");
});
