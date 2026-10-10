import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ContractError,
  canonicalHash,
  canonicalSerialize,
} from "../../src/contracts/index.mjs";
import { ContractError as CreativeContractError } from "../../src/contracts/creative/v1.mjs";
import { assertControlContractBinding, controlContractReference } from "../../src/controls/contract.mjs";
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

test("creative subpath runtime exports the same ContractError declared by its public type surface", () => {
  assert.equal(CreativeContractError, ContractError);
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
  assert.equal(normalized.facts[1].key, "admission_credential");
  assert.equal(normalized.facts[1].status, "unknown");
  assert.equal(Object.hasOwn(normalized.facts[1], "value"), false);
  assert.equal(Object.hasOwn(normalized.facts[1], "candidate_values"), false);
  assert.equal(Object.hasOwn(normalized.facts[1], "raw_value"), false);
  assert.equal(normalized.facts[1].provenance[0].source_id, "page-1");
  assert.equal(Object.hasOwn(normalized.source_identity[0], "admission_credential"), false);
  assert.equal(Object.hasOwn(normalized.future_source_metadata.audit, "source_credential"), false);
  assert.equal(Object.hasOwn(normalized.future_source_metadata.audit.semantic_field, "value"), false);
  assert.equal(serialized.includes("SYNTHETIC-NOT-A-REAL-CREDENTIAL"), false);
  assert.deepEqual(normalized.security_redactions.map((item) => item.field_path).sort(), [
    "facts[1].candidate_values",
    "facts[1].raw_value",
    "facts[1].value",
    "future_source_metadata.audit.semantic_field.value",
    "future_source_metadata.audit.source_credential",
    "source_identity[0].admission_credential",
  ]);
  assert.ok(normalized.security_redactions.every((item) => item.reason === "credential_material_omitted"));

  const legacy = await fixture("creative/older.json");
  legacy.facts.push({
    fact_id: "admission-credential-legacy",
    key: "admission_credential",
    status: "verified",
    value: "SYNTHETIC-NOT-A-REAL-CREDENTIAL",
    candidate_values: ["SYNTHETIC-NOT-A-REAL-CREDENTIAL"],
    raw_value: "SYNTHETIC-NOT-A-REAL-CREDENTIAL",
    source_refs: ["page-1"],
  });
  const migratedLegacy = normalizeResearchPackage(legacy, trustedScope);
  const legacyCredential = migratedLegacy.facts.find((fact) => fact.fact_id === "admission-credential-legacy");
  assert.equal(legacyCredential.status, "unknown");
  assert.equal(Object.hasOwn(legacyCredential, "value"), false);
  assert.equal(Object.hasOwn(legacyCredential, "candidate_values"), false);
  assert.equal(Object.hasOwn(legacyCredential, "raw_value"), false);
  assert.equal(legacyCredential.provenance[0].source_id, "page-1");
  assert.equal(JSON.stringify(migratedLegacy).includes("SYNTHETIC-NOT-A-REAL-CREDENTIAL"), false);
  assert.deepEqual(migratedLegacy.security_redactions.map((item) => item.field_path).sort(), [
    "facts[1].candidate_values",
    "facts[1].raw_value",
    "facts[1].value",
  ]);

  const brief = await fixture("creative/creative-brief.json");
  const packageInput = await fixture("creative/current.json");
  brief.source_credential = "SYNTHETIC-NOT-A-REAL-CREDENTIAL";
  expectCode("forbidden_sensitive_field", () => validateCreativeBrief(brief, {
    trustedScope,
    researchPackage: packageInput,
  }));
  for (const [field, value] of [
    ["value", "SYNTHETIC-NOT-A-REAL-CREDENTIAL"],
    ["candidate_values", ["SYNTHETIC-NOT-A-REAL-CREDENTIAL"]],
    ["raw_value", "SYNTHETIC-NOT-A-REAL-CREDENTIAL"],
  ]) {
    const semanticCredential = clone(await fixture("creative/creative-brief.json"));
    semanticCredential.future_metadata = { key: "admission_credential", [field]: value };
    expectCode("forbidden_sensitive_field", () => validateCreativeBrief(semanticCredential, {
      trustedScope,
      researchPackage: packageInput,
    }));
  }
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
  const wrongKey = clone(brief);
  wrongKey.facts.verified[0].key = "venue_name";
  expectCode("invalid_reference", () => validateCreativeBrief(wrongKey, { trustedScope, researchPackage }));
  const incompleteProjection = clone(brief);
  incompleteProjection.facts.verified = [];
  expectCode("incomplete_projection", () => validateCreativeBrief(incompleteProjection, { trustedScope, researchPackage }));

  const unresolvedInput = clone(packageInput);
  unresolvedInput.facts[0].status = "unknown";
  delete unresolvedInput.facts[0].value;
  const unresolvedPackage = normalizeResearchPackage(unresolvedInput, trustedScope);
  const unresolvedBrief = clone(brief);
  unresolvedBrief.research_package_ref.content_hash = canonicalHash(unresolvedPackage);
  unresolvedBrief.facts.verified = [];
  unresolvedBrief.facts.unresolved = [{
    fact_id: unresolvedPackage.facts[0].fact_id,
    key: unresolvedPackage.facts[0].key,
    status: "unknown",
    provenance_refs: ["page-1"],
  }];
  assert.equal(validateCreativeBrief(unresolvedBrief, { trustedScope, researchPackage: unresolvedPackage }).facts.unresolved.length, 1);
  const renamedUnresolved = clone(unresolvedBrief);
  renamedUnresolved.facts.unresolved[0].key = "venue_name";
  expectCode("invalid_reference", () => validateCreativeBrief(renamedUnresolved, { trustedScope, researchPackage: unresolvedPackage }));
});

test("CreativeBrief cannot grant permissions absent or unknown in its research package", async () => {
  const packageInput = await fixture("creative/current.json");
  packageInput.permissions = { presence: "unknown", items: [] };
  const researchPackage = normalizeResearchPackage(packageInput, trustedScope);
  const brief = await fixture("creative/creative-brief.json");
  brief.research_package_ref.content_hash = canonicalHash(researchPackage);
  brief.permissions = { presence: "unknown", items: [] };
  assert.equal(validateCreativeBrief(brief, { trustedScope, researchPackage }).permissions.items.length, 0);

  const forgedGrant = clone(brief);
  forgedGrant.permissions = {
    presence: "present",
    items: [{ asset_id: "asset-1", action: "reproduce", status: "granted", evidence_refs: ["page-1"] }],
  };
  expectCode("invalid_reference", () => validateCreativeBrief(forgedGrant, { trustedScope, researchPackage }));
});

test("DesignControlSchema translates the checked-in producer's names, scope, versions, and hash", async () => {
  const wrapper = await fixture("creative/design-control-schema.json");
  const producer = await fixture("creative/controls-producer-valid.json");
  const producerSource = JSON.parse(await readFile(new URL("../../fixtures/controls/valid.json", import.meta.url), "utf8"));
  const payload = producer.schema;
  const controlsScope = { ...trustedScope, tenant_id: wrapper.tenant_id, project_id: wrapper.project_id };
  assert.deepEqual(producer, producerSource);
  assert.deepEqual(producer.control_reference, controlContractReference(producerSource.schema));
  assert.equal(assertControlContractBinding(producer.control_reference, producerSource.schema), producerSource.schema);
  assert.equal(producer.control_reference.control_contract, wrapper.control_contract);
  assert.equal(producer.control_reference.control_schema_version, wrapper.control_schema_version);
  assert.equal(producer.control_reference.tenant_id, wrapper.tenant_id);
  assert.equal(producer.control_reference.project_id, wrapper.project_id);
  assert.deepEqual(producer.control_reference.expected_versions, wrapper.expected_versions);
  assert.equal(producer.control_reference.control_schema_hash, wrapper.control_schema_hash);
  const validated = validateDesignControlSchema(wrapper, { trustedScope: controlsScope, controlSchemaPayload: payload });
  assert.equal(validated.control_contract, "creative-controls");
  assert.equal(validated.control_schema_version, payload.schema_version.split("/")[1]);
  assert.equal(validated.control_schema_hash, canonicalHash(payload));

  const changedPayload = clone(payload);
  changedPayload.controls[0].label = "Altered by consumer";
  expectCode("hash_mismatch", () => validateDesignControlSchema(wrapper, { trustedScope: controlsScope, controlSchemaPayload: changedPayload }));
  const foreignScope = clone(payload);
  foreignScope.tenant_id = "tenant-forged";
  expectCode("scope_mismatch", () => validateDesignControlSchema(wrapper, { trustedScope: controlsScope, controlSchemaPayload: foreignScope }));
  const wrongVersion = clone(payload);
  wrongVersion.schema_version = "creative-controls/1.0";
  expectCode("version_mismatch", () => validateDesignControlSchema(wrapper, { trustedScope: controlsScope, controlSchemaPayload: wrongVersion }));
});

test("EditPlan accepts only bounded typed actions and references", async () => {
  const plan = await fixture("creative/edit-plan.json");
  const baseDesign = await fixture("creative/design-version-base.json");
  const baseDesignHash = computeDesignVersionHash(baseDesign);
  assert.equal(plan.base.design_hash, baseDesignHash);
  const validOptions = {
    trustedScope,
    brief_hash: plan.base.brief_hash,
    design_hash: baseDesignHash,
    known_source_refs: ["source:page-1", "asset:asset-1"],
    design_version_ids: ["design-v1"],
    known_asset_ids: ["asset-1"],
    known_fact_ids: ["event-date-1"],
  };
  assert.equal(validateEditPlan(plan, validOptions).steps.length, 1);

  const conceptPlan = clone(plan);
  conceptPlan.operation = "concept.generate";
  conceptPlan.steps[0].action = "concept.generate";
  conceptPlan.steps[0].parameters = { brief_id: "brief-1", variant_count: 1 };
  assert.equal(validateEditPlan(conceptPlan, validOptions).steps.length, 1);
  const foreignBrief = clone(conceptPlan);
  foreignBrief.steps[0].parameters.brief_id = "brief-other-tenant";
  expectCode("scope_mismatch", () => validateEditPlan(foreignBrief, validOptions));
  expectCode("missing_trusted_context", () => validateEditPlan(conceptPlan, {
    ...validOptions,
    trustedScope: { tenant_id: "tenant-1", project_id: "project-1" },
  }));

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
  expectCode("hash_mismatch", () => validateEditPlan(plan, { ...validOptions, design_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }));
  const missingDesignHash = clone(plan);
  delete missingDesignHash.base.design_hash;
  expectCode("invalid_type", () => validateEditPlan(missingDesignHash, validOptions));
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
  const foreignNestedArtifact = clone(version);
  foreignNestedArtifact.artifact.artifact_id = "artifact-other-owned";
  foreignNestedArtifact.design_hash = computeDesignVersionHash(foreignNestedArtifact);
  expectCode("scope_mismatch", () => validateDesignVersion(foreignNestedArtifact, options));
  const credentialed = { ...version, source_credential: "SYNTHETIC-NOT-A-REAL-CREDENTIAL" };
  credentialed.design_hash = computeDesignVersionHash(credentialed);
  expectCode("forbidden_sensitive_field", () => validateDesignVersion(credentialed, options));

  assert.equal(canonicalHash({ a: 1, b: ["x", 2] }), canonicalHash({ b: ["x", 2], a: 1 }));
  assert.notEqual(canonicalHash([1, 2]), canonicalHash([2, 1]));
  assert.equal(canonicalSerialize({ negative_zero: -0 }), "{\"negative_zero\":0}");
});
