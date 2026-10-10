import {
  ContractError,
  assertHash,
  assertIsoDateTime,
  assertOnlyKeys,
  canonicalHash,
  expectArray,
  expectEnum,
  expectInteger,
  expectObject,
  expectString,
  fail,
  rejectCredentialMaterial,
  requireField,
  sanitizeCredentialFields,
} from "../validation.mjs";
import { assertTrustedScope } from "../scope.mjs";

export { ContractError };

export const CREATIVE_CONTRACT_VERSIONS = Object.freeze({
  EventIntelligencePackage: "1.1",
  CreativeBrief: "1.0",
  DesignControlSchema: "1.0",
  EditPlan: "1.0",
  DesignVersion: "1.0",
});

export const SUPPORTED_RESEARCH_PACKAGE_VERSIONS = Object.freeze(["1.0", "1.1"]);

const ENVIRONMENTS = ["development", "test", "production"];
const BILLING_MODES = ["live", "sandbox", "simulated"];
const FACT_STATES = ["verified", "conflicting", "unknown"];
const SECTION_STATES = ["absent", "unknown", "present"];
const PERMISSION_STATES = ["granted", "denied", "unknown"];
const ACTIONS = [
  "concept.generate",
  "image.edit",
  "composition.update",
  "correction.apply",
];

function requireContract(value, contractName, supportedVersion) {
  expectObject(value, contractName, contractName);
  if (value.contract !== contractName) {
    fail("invalid_contract", contractName, "contract", "Expected contract " + contractName + ".");
  }
  const version = expectString(value.schema_version, contractName, "schema_version", { maxLength: 20 });
  if (version !== supportedVersion) {
    const requestedMajor = version.split(".")[0];
    const supportedMajor = supportedVersion.split(".")[0];
    fail(
      requestedMajor === supportedMajor ? "unsupported_version" : "unsupported_major",
      contractName,
      "schema_version",
      "Unsupported " + contractName + " schema version " + version + "; supported version is " + supportedVersion + ".",
    );
  }
}

function validateEnvelope(value, contractName) {
  expectString(value.event_id, contractName, "event_id", { maxLength: 200 });
  expectString(value.tenant_id, contractName, "tenant_id", { maxLength: 200 });
  expectString(value.project_id, contractName, "project_id", { maxLength: 200 });
  expectString(value.producer, contractName, "producer", { maxLength: 200 });
  assertIsoDateTime(value.occurred_at, contractName, "occurred_at");
  assertIsoDateTime(value.ingested_at, contractName, "ingested_at");
  expectEnum(value.environment, ENVIRONMENTS, contractName, "environment");
  expectEnum(value.billing_mode, BILLING_MODES, contractName, "billing_mode");
  expectString(value.correlation_id, contractName, "correlation_id", { maxLength: 200 });
  expectArray(value.source_refs, contractName, "source_refs");
  value.source_refs.forEach((ref, index) => expectString(ref, contractName, "source_refs[" + index + "]", { maxLength: 300 }));
  for (const field of [
    "workflow_id", "run_id", "order_id", "job_id", "design_version_id", "artifact_id",
    "logical_operation_id", "billable_attempt_id", "transport_attempt_id", "provider_request_id",
  ]) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      expectString(value[field], contractName, field, { maxLength: 200 });
    }
  }
}

function validateSection(section, contractName, field, validateItem) {
  expectObject(section, contractName, field);
  expectEnum(section.presence, SECTION_STATES, contractName, field + ".presence");
  const items = expectArray(section.items, contractName, field + ".items");
  if (section.presence !== "present" && items.length !== 0) {
    fail("invalid_presence", contractName, field, field + " must have no items when absent or unknown.");
  }
  items.forEach((item, index) => validateItem(item, field + ".items[" + index + "]"));
}

function validateFact(fact, contractName, field, sourceIds) {
  expectObject(fact, contractName, field);
  expectString(fact.fact_id, contractName, field + ".fact_id", { maxLength: 200 });
  expectString(fact.key, contractName, field + ".key", { maxLength: 200 });
  expectEnum(fact.status, FACT_STATES, contractName, field + ".status");
  const provenance = expectArray(fact.provenance, contractName, field + ".provenance");
  provenance.forEach((item, index) => {
    const path = field + ".provenance[" + index + "]";
    expectObject(item, contractName, path);
    const sourceId = expectString(item.source_id, contractName, path + ".source_id", { maxLength: 200 });
    if (!sourceIds.has(sourceId)) {
      fail("invalid_reference", contractName, path + ".source_id", "Fact provenance refers to an unknown source.");
    }
    if (Object.prototype.hasOwnProperty.call(item, "retrieved_at")) {
      assertIsoDateTime(item.retrieved_at, contractName, path + ".retrieved_at");
    } else {
      expectEnum(item.retrieved_at_status, ["unknown"], contractName, path + ".retrieved_at_status");
    }
    if (Object.prototype.hasOwnProperty.call(item, "evidence_ref")) {
      expectString(item.evidence_ref, contractName, path + ".evidence_ref", { maxLength: 300 });
    }
  });
  if (fact.status === "verified") {
    if (!Object.prototype.hasOwnProperty.call(fact, "value")) {
      fail("missing_field", contractName, field + ".value", "Verified facts require a value.");
    }
    if (provenance.length === 0) {
      fail("missing_provenance", contractName, field + ".provenance", "Verified facts require provenance.");
    }
  } else if (Object.prototype.hasOwnProperty.call(fact, "value")) {
    fail("invalid_fact_state", contractName, field + ".value", "Conflicting and unknown facts cannot carry a verified value.");
  }
  if (fact.status === "conflicting" && Object.prototype.hasOwnProperty.call(fact, "candidate_values")) {
    expectArray(fact.candidate_values, contractName, field + ".candidate_values");
  }
}

function validatePermission(permission, contractName, field, sourceIds, assetIds) {
  expectObject(permission, contractName, field);
  const assetId = expectString(permission.asset_id, contractName, field + ".asset_id", { maxLength: 200 });
  if (!assetIds.has(assetId)) {
    fail("invalid_reference", contractName, field + ".asset_id", "Permission refers to an unknown asset.");
  }
  expectEnum(permission.action, ["reproduce", "modify", "publish", "display"], contractName, field + ".action");
  expectEnum(permission.status, PERMISSION_STATES, contractName, field + ".status");
  expectArray(permission.evidence_refs, contractName, field + ".evidence_refs").forEach((ref, index) => {
    const evidenceRef = expectString(ref, contractName, field + ".evidence_refs[" + index + "]", { maxLength: 300 });
    if (!sourceIds.has(evidenceRef)) {
      fail("invalid_reference", contractName, field + ".evidence_refs[" + index + "]", "Permission evidence refers to an unknown source.");
    }
  });
}

function validateAsset(asset, contractName, field, sourceIds) {
  expectObject(asset, contractName, field);
  expectString(asset.asset_id, contractName, field + ".asset_id", { maxLength: 200 });
  const sourceId = expectString(asset.source_id, contractName, field + ".source_id", { maxLength: 200 });
  if (!sourceIds.has(sourceId)) {
    fail("invalid_reference", contractName, field + ".source_id", "Asset refers to an unknown source.");
  }
  assertHash(asset.content_hash, contractName, field + ".content_hash");
  expectString(asset.media_type, contractName, field + ".media_type", { maxLength: 100 });
}

function validateResearchPackageCurrent(value, trustedScope) {
  const contract = "EventIntelligencePackage";
  if (value.contract !== contract) {
    fail("invalid_contract", contract, "contract", "ResearchPackage is a local alias for EventIntelligencePackage.");
  }
  const version = expectString(value.schema_version, contract, "schema_version", { maxLength: 20 });
  if (version !== "1.1") {
    const code = version.split(".")[0] === "1" ? "unsupported_version" : "unsupported_major";
    fail(code, contract, "schema_version", "Only normalized EventIntelligencePackage version 1.1 can be validated.");
  }
  validateEnvelope(value, contract);
  expectString(value.package_id, contract, "package_id", { maxLength: 200 });
  const sources = expectArray(value.source_identity, contract, "source_identity");
  const sourceIds = new Set();
  sources.forEach((source, index) => {
    const field = "source_identity[" + index + "]";
    expectObject(source, contract, field);
    const sourceId = expectString(source.source_id, contract, field + ".source_id", { maxLength: 200 });
    if (sourceIds.has(sourceId)) fail("duplicate_id", contract, field + ".source_id", "Source IDs must be unique.");
    sourceIds.add(sourceId);
    expectString(source.uri, contract, field + ".uri", { maxLength: 2048 });
    if (Object.prototype.hasOwnProperty.call(source, "retrieved_at")) {
      assertIsoDateTime(source.retrieved_at, contract, field + ".retrieved_at");
    } else {
      expectEnum(source.retrieved_at_status, ["unknown"], contract, field + ".retrieved_at_status");
    }
    if (Object.prototype.hasOwnProperty.call(source, "content_hash")) {
      assertHash(source.content_hash, contract, field + ".content_hash");
    }
  });
  const assetsSection = value.assets;
  validateSection(assetsSection, contract, "assets", (asset, field) => validateAsset(asset, contract, field, sourceIds));
  const assetIds = new Set(assetsSection.items.map((asset) => asset.asset_id));
  if (assetIds.size !== assetsSection.items.length) {
    fail("duplicate_id", contract, "assets.items", "Asset IDs must be unique.");
  }
  const facts = expectArray(value.facts, contract, "facts");
  const factIds = new Set();
  facts.forEach((fact, index) => {
    validateFact(fact, contract, "facts[" + index + "]", sourceIds);
    if (factIds.has(fact.fact_id)) fail("duplicate_id", contract, "facts[" + index + "].fact_id", "Fact IDs must be unique.");
    factIds.add(fact.fact_id);
  });
  validateSection(value.preferences, contract, "preferences", (item, field) => {
    expectObject(item, contract, field);
    expectString(item.preference_id, contract, field + ".preference_id", { maxLength: 200 });
    expectString(item.value, contract, field + ".value", { maxLength: 1000 });
    if (item.provenance && !sourceIds.has(item.provenance.source_id)) {
      fail("invalid_reference", contract, field + ".provenance.source_id", "Preference provenance refers to an unknown source.");
    }
  });
  validateSection(value.interpretations, contract, "interpretations", (item, field) => {
    expectObject(item, contract, field);
    expectString(item.interpretation_id, contract, field + ".interpretation_id", { maxLength: 200 });
    expectString(item.text, contract, field + ".text", { maxLength: 2000 });
    expectString(item.basis, contract, field + ".basis", { maxLength: 200 });
  });
  validateSection(value.permissions, contract, "permissions", (item, field) =>
    validatePermission(item, contract, field, sourceIds, assetIds));
  validateSection(value.locks, contract, "locks", (item, field) => {
    expectObject(item, contract, field);
    expectString(item.lock_id, contract, field + ".lock_id", { maxLength: 200 });
    expectString(item.field, contract, field + ".field", { maxLength: 200 });
    expectString(item.value_hash, contract, field + ".value_hash", { maxLength: 71 });
    expectString(item.reason, contract, field + ".reason", { maxLength: 500 });
  });
  if (Object.prototype.hasOwnProperty.call(value, "security_redactions")) {
    expectArray(value.security_redactions, contract, "security_redactions").forEach((redaction, index) => {
      const field = "security_redactions[" + index + "]";
      expectObject(redaction, contract, field);
      expectString(redaction.field_path, contract, field + ".field_path", { maxLength: 500 });
      if (redaction.reason !== "credential_material_omitted") {
        fail("invalid_redaction", contract, field + ".reason", "Redaction reason must be credential_material_omitted.");
      }
    });
  }
  assertTrustedScope(value, trustedScope, contract);
  rejectCredentialMaterial(value, contract);
  return value;
}

function normalizeSection(value, field) {
  if (value === undefined) return { presence: "absent", items: [] };
  if (Array.isArray(value)) return { presence: "present", items: value };
  if (value && typeof value === "object") return value;
  fail("invalid_type", "EventIntelligencePackage", field, field + " must be an array or a section object.");
}

function migrateLegacyFact(fact) {
  const provenance = Array.isArray(fact.provenance)
    ? fact.provenance
    : (Array.isArray(fact.source_refs) ? fact.source_refs.map((source_id) => ({
      source_id,
      ...(fact.retrieved_at
        ? { retrieved_at: fact.retrieved_at }
        : { retrieved_at_status: "unknown" }),
    })) : []);
  const candidateValues = Object.prototype.hasOwnProperty.call(fact, "value") ? [fact.value] : [];
  const migrated = { ...fact, status: "unknown", provenance };
  delete migrated.value;
  delete migrated.source_refs;
  if (candidateValues.length > 0) migrated.candidate_values = candidateValues;
  return migrated;
}

export function normalizeResearchPackage(value, trustedScope) {
  if (!trustedScope) fail("missing_trusted_context", "EventIntelligencePackage", "trusted_scope", "A separately supplied trusted scope is required.");
  expectObject(value, "EventIntelligencePackage", "EventIntelligencePackage");
  const aliasUsed = value.contract === "ResearchPackage";
  if (value.contract !== "EventIntelligencePackage" && !aliasUsed) {
    fail("invalid_contract", "EventIntelligencePackage", "contract", "ResearchPackage is a local alias for EventIntelligencePackage.");
  }
  const version = expectString(value.schema_version, "EventIntelligencePackage", "schema_version", { maxLength: 20 });
  if (!SUPPORTED_RESEARCH_PACKAGE_VERSIONS.includes(version)) {
    const code = version.split(".")[0] === "1" ? "unsupported_version" : "unsupported_major";
    fail(code, "EventIntelligencePackage", "schema_version", "Unsupported EventIntelligencePackage version " + version + ".");
  }
  const sanitized = sanitizeCredentialFields(value);
  if (version === "1.1") {
    const normalized = { ...sanitized.value, contract: "EventIntelligencePackage" };
    if (sanitized.omissions.length > 0) {
      normalized.security_redactions = [
        ...(Array.isArray(value.security_redactions) ? value.security_redactions : []),
        ...sanitized.omissions,
      ];
    }
    return validateResearchPackageCurrent(normalized, trustedScope);
  }

  const safeInput = sanitized.value;
  const sources = safeInput.source_identity ?? safeInput.sources;
  if (!Array.isArray(sources)) {
    fail("missing_field", "EventIntelligencePackage", "sources", "Legacy packages require source_identity or sources.");
  }
  const migrated = {
    ...safeInput,
    contract: "EventIntelligencePackage",
    schema_version: "1.1",
    source_identity: sources,
    facts: expectArray(safeInput.facts, "EventIntelligencePackage", "facts").map(migrateLegacyFact),
    preferences: normalizeSection(safeInput.preferences, "preferences"),
    interpretations: normalizeSection(safeInput.interpretations, "interpretations"),
    permissions: {
      presence: safeInput.permissions === undefined ? "absent" : "unknown",
      items: [],
    },
    locks: normalizeSection(safeInput.locks, "locks"),
    assets: normalizeSection(safeInput.assets, "assets"),
    migration: {
      from_schema_version: "1.0",
      ...(aliasUsed ? { from_contract_alias: "ResearchPackage" } : {}),
      policy: "legacy-facts-and-permissions-remain-unverified",
      legacy_permission_claims_present: safeInput.permissions !== undefined,
    },
  };
  if (sanitized.omissions.length > 0) {
    migrated.security_redactions = [
      ...(Array.isArray(safeInput.security_redactions) ? safeInput.security_redactions : []),
      ...sanitized.omissions,
    ];
  }
  delete migrated.sources;
  return validateResearchPackageCurrent(migrated, trustedScope);
}

export function validateResearchPackage(value, trustedScope) {
  return normalizeResearchPackage(value, trustedScope);
}

export function assessResearchReadiness(value) {
  const contract = "EventIntelligencePackage";
  expectObject(value, contract, "package");
  const reasons = [];
  if (expectArray(value.facts, contract, "facts").some((fact) => fact.status !== "verified")) {
    reasons.push("unverified_or_conflicting_facts");
  }
  const assetIds = new Set(expectArray(value.assets.items, contract, "assets.items").map((asset) => asset.asset_id));
  if (assetIds.size > 0) {
    const permissions = new Map(expectArray(value.permissions.items, contract, "permissions.items")
      .map((permission) => [permission.asset_id + ":" + permission.action, permission.status]));
    for (const assetId of assetIds) {
      if (permissions.get(assetId + ":reproduce") !== "granted") {
        reasons.push("missing_reproduction_permission:" + assetId);
      }
    }
  }
  return Object.freeze({ state: reasons.length === 0 ? "ready" : "incomplete", reasons });
}

export function validateCreativeBrief(value, options = {}) {
  const contract = "CreativeBrief";
  requireContract(value, contract, CREATIVE_CONTRACT_VERSIONS.CreativeBrief);
  if (!options.trustedScope) fail("missing_trusted_context", contract, "trusted_scope", "A separately supplied trusted scope is required.");
  validateEnvelope(value, contract);
  expectString(value.brief_id, contract, "brief_id", { maxLength: 200 });
  expectObject(value.research_package_ref, contract, "research_package_ref");
  if (value.research_package_ref.contract !== "EventIntelligencePackage") {
    fail("invalid_reference", contract, "research_package_ref.contract", "ResearchPackage maps to EventIntelligencePackage.");
  }
  expectString(value.research_package_ref.schema_version, contract, "research_package_ref.schema_version", { maxLength: 20 });
  expectString(value.research_package_ref.package_id, contract, "research_package_ref.package_id", { maxLength: 200 });
  assertHash(value.research_package_ref.content_hash, contract, "research_package_ref.content_hash");
  const briefSources = expectArray(value.source_identity, contract, "source_identity");
  const briefSourceIds = new Set();
  briefSources.forEach((source, index) => {
    expectObject(source, contract, "source_identity[" + index + "]");
    expectString(source.source_id, contract, "source_identity[" + index + "].source_id", { maxLength: 200 });
    expectString(source.uri, contract, "source_identity[" + index + "].uri", { maxLength: 2048 });
    if (briefSourceIds.has(source.source_id)) fail("duplicate_id", contract, "source_identity[" + index + "].source_id", "Source IDs must be unique.");
    briefSourceIds.add(source.source_id);
  });
  expectObject(value.facts, contract, "facts");
  const verified = expectArray(value.facts.verified, contract, "facts.verified");
  const unresolved = expectArray(value.facts.unresolved, contract, "facts.unresolved");
  const allFactIds = new Set();
  verified.forEach((fact, index) => {
    const field = "facts.verified[" + index + "]";
    expectObject(fact, contract, field);
    const id = expectString(fact.fact_id, contract, field + ".fact_id", { maxLength: 200 });
    if (allFactIds.has(id)) fail("duplicate_id", contract, field + ".fact_id", "Fact IDs must be unique.");
    allFactIds.add(id);
    expectString(fact.key, contract, field + ".key", { maxLength: 200 });
    requireField(fact, "value", contract, field + ".value");
    const refs = expectArray(fact.provenance_refs, contract, field + ".provenance_refs");
    if (refs.length === 0) fail("missing_provenance", contract, field + ".provenance_refs", "Verified facts require provenance references.");
    refs.forEach((ref, refIndex) => {
      expectString(ref, contract, field + ".provenance_refs[" + refIndex + "]", { maxLength: 300 });
      if (!briefSourceIds.has(ref)) fail("invalid_reference", contract, field + ".provenance_refs[" + refIndex + "]", "Fact provenance refers to an unknown source.");
    });
  });
  unresolved.forEach((fact, index) => {
    const field = "facts.unresolved[" + index + "]";
    expectObject(fact, contract, field);
    const id = expectString(fact.fact_id, contract, field + ".fact_id", { maxLength: 200 });
    if (allFactIds.has(id)) fail("duplicate_id", contract, field + ".fact_id", "Fact IDs must be unique.");
    allFactIds.add(id);
    expectString(fact.key, contract, field + ".key", { maxLength: 200 });
    expectEnum(fact.status, ["conflicting", "unknown"], contract, field + ".status");
    if (Object.prototype.hasOwnProperty.call(fact, "value")) {
      fail("invalid_fact_state", contract, field + ".value", "Unresolved facts cannot carry a verified value.");
    }
    const refs = expectArray(fact.provenance_refs, contract, field + ".provenance_refs");
    refs.forEach((ref, refIndex) => {
      expectString(ref, contract, field + ".provenance_refs[" + refIndex + "]", { maxLength: 300 });
      if (!briefSourceIds.has(ref)) fail("invalid_reference", contract, field + ".provenance_refs[" + refIndex + "]", "Unresolved fact provenance refers to an unknown source.");
    });
    if (Object.prototype.hasOwnProperty.call(fact, "candidate_values")) {
      expectArray(fact.candidate_values, contract, field + ".candidate_values");
    }
  });
  for (const section of ["preferences", "interpretations", "permissions", "locks"]) {
    expectObject(value[section], contract, section);
    expectEnum(value[section].presence, SECTION_STATES, contract, section + ".presence");
    const items = expectArray(value[section].items, contract, section + ".items");
    if (value[section].presence !== "present" && items.length !== 0) {
      fail("invalid_presence", contract, section, section + " must have no items when absent or unknown.");
    }
  }
  validateSection(value.permissions, contract, "permissions", (permission, field) => {
    expectObject(permission, contract, field);
    expectString(permission.asset_id, contract, field + ".asset_id", { maxLength: 200 });
    expectEnum(permission.action, ["reproduce", "modify", "publish", "display"], contract, field + ".action");
    expectEnum(permission.status, PERMISSION_STATES, contract, field + ".status");
    expectArray(permission.evidence_refs, contract, field + ".evidence_refs").forEach((ref, index) => {
      expectString(ref, contract, field + ".evidence_refs[" + index + "]", { maxLength: 300 });
      if (!briefSourceIds.has(ref)) fail("invalid_reference", contract, field + ".evidence_refs[" + index + "]", "Permission evidence refers to an unknown source.");
    });
  });
  validateSection(value.preferences, contract, "preferences", (item, field) => {
    expectObject(item, contract, field);
    expectString(item.preference_id, contract, field + ".preference_id", { maxLength: 200 });
    expectString(item.value, contract, field + ".value", { maxLength: 1000 });
  });
  validateSection(value.interpretations, contract, "interpretations", (item, field) => {
    expectObject(item, contract, field);
    expectString(item.interpretation_id, contract, field + ".interpretation_id", { maxLength: 200 });
    expectString(item.text, contract, field + ".text", { maxLength: 2000 });
    expectString(item.basis, contract, field + ".basis", { maxLength: 200 });
  });
  validateSection(value.locks, contract, "locks", (item, field) => {
    expectObject(item, contract, field);
    expectString(item.lock_id, contract, field + ".lock_id", { maxLength: 200 });
    expectString(item.field, contract, field + ".field", { maxLength: 200 });
    assertHash(item.value_hash, contract, field + ".value_hash");
    expectString(item.reason, contract, field + ".reason", { maxLength: 500 });
  });
  if (options.researchPackage) {
    const research = normalizeResearchPackage(options.researchPackage, options.trustedScope);
    if (research.package_id !== value.research_package_ref.package_id) {
      fail("invalid_reference", contract, "research_package_ref.package_id", "Brief does not reference the supplied research package.");
    }
    if (research.schema_version !== value.research_package_ref.schema_version) {
      fail("version_mismatch", contract, "research_package_ref.schema_version", "Brief research schema version does not match the supplied package.");
    }
    if (canonicalHash(research) !== value.research_package_ref.content_hash) {
      fail("hash_mismatch", contract, "research_package_ref.content_hash", "Research package hash does not match the supplied package.");
    }
    const sourceIds = new Set(research.source_identity.map((source) => source.source_id));
    for (const source of briefSources) {
      const original = research.source_identity.find((candidate) => candidate.source_id === source.source_id);
      if (!original || original.uri !== source.uri) {
        fail("invalid_reference", contract, "source_identity", "Brief source identity does not match the referenced research package.");
      }
    }
    const packageFactIds = new Set(research.facts.map((candidate) => candidate.fact_id));
    for (const fact of verified) {
      const original = research.facts.find((candidate) => candidate.fact_id === fact.fact_id);
      if (!original || original.status !== "verified" || original.key !== fact.key ||
        canonicalHash(original.value) !== canonicalHash(fact.value)) {
        fail("invalid_reference", contract, "facts.verified", "Brief verified fact is not verified in its research package.");
      }
      for (const ref of fact.provenance_refs) {
        if (!sourceIds.has(ref) || !original.provenance.some((item) => item.source_id === ref)) {
          fail("invalid_reference", contract, "facts.verified", "Brief fact provenance does not match the referenced package.");
        }
      }
    }
    for (const fact of unresolved) {
      const original = research.facts.find((candidate) => candidate.fact_id === fact.fact_id);
      if (!original || original.status !== fact.status || original.key !== fact.key) {
        fail("invalid_reference", contract, "facts.unresolved", "Brief unresolved fact state does not match the referenced package.");
      }
      if (fact.candidate_values && canonicalHash(fact.candidate_values) !== canonicalHash(original.candidate_values ?? [])) {
        fail("invalid_reference", contract, "facts.unresolved", "Brief candidate values do not match the referenced package.");
      }
      for (const ref of fact.provenance_refs) {
        if (!sourceIds.has(ref) || !original.provenance.some((item) => item.source_id === ref)) {
          fail("invalid_reference", contract, "facts.unresolved", "Brief unresolved fact provenance does not match the referenced package.");
        }
      }
    }
    if (verified.length + unresolved.length !== packageFactIds.size) {
      fail("incomplete_projection", contract, "facts", "Brief must carry every research-package fact as verified or unresolved.");
    }
    if (value.permissions.presence !== research.permissions.presence) {
      fail("invalid_reference", contract, "permissions.presence", "Brief permission presence must match the referenced research package.");
    }
    const permissionKey = (permission) => permission.asset_id + "\u0000" + permission.action;
    const researchPermissions = new Map();
    for (const permission of research.permissions.items) {
      const key = permissionKey(permission);
      if (researchPermissions.has(key)) {
        fail("duplicate_reference", contract, "permissions", "Research package permission asset/action pairs must be unique.");
      }
      researchPermissions.set(key, permission);
    }
    const briefPermissions = new Set();
    for (const permission of value.permissions.items) {
      const key = permissionKey(permission);
      if (briefPermissions.has(key)) {
        fail("duplicate_reference", contract, "permissions", "Brief permission asset/action pairs must be unique.");
      }
      briefPermissions.add(key);
      const original = researchPermissions.get(key);
      if (!original || original.status !== permission.status ||
        canonicalHash(original.evidence_refs) !== canonicalHash(permission.evidence_refs)) {
        fail("invalid_reference", contract, "permissions", "Brief permission must match the referenced package action, status, and evidence.");
      }
    }
    if (briefPermissions.size !== researchPermissions.size) {
      fail("incomplete_projection", contract, "permissions", "Brief must carry every research-package permission record.");
    }
  }
  assertTrustedScope(value, options.trustedScope, contract);
  rejectCredentialMaterial(value, contract);
  return value;
}

export function validateDesignControlSchema(value, options = {}) {
  const contract = "DesignControlSchema";
  requireContract(value, contract, CREATIVE_CONTRACT_VERSIONS.DesignControlSchema);
  validateEnvelope(value, contract);
  expectString(value.control_contract, contract, "control_contract", { maxLength: 100 });
  if (value.control_contract !== "creative-controls") {
    fail("invalid_reference", contract, "control_contract", "Control schema must reference creative-controls.");
  }
  expectEnum(value.control_schema_version, ["1.0", "1.1"], contract, "control_schema_version");
  expectObject(value.expected_versions, contract, "expected_versions");
  assertOnlyKeys(value.expected_versions, ["brief", "design", "composition"], contract, "expected_versions");
  for (const key of ["brief", "design", "composition"]) {
    expectString(value.expected_versions[key], contract, "expected_versions." + key, { maxLength: 200 });
  }
  assertHash(value.control_schema_hash, contract, "control_schema_hash");
  if (options.controlSchemaPayload) {
    expectObject(options.controlSchemaPayload, contract, "control_schema_payload");
    const expectedPayloadVersion = value.control_contract + "/" + value.control_schema_version;
    if (options.controlSchemaPayload.schema_version !== expectedPayloadVersion) {
      fail("version_mismatch", contract, "control_schema_payload.schema_version", "Control payload version does not match the referenced producer schema version.");
    }
    if (options.controlSchemaPayload.tenant_id !== value.tenant_id ||
      options.controlSchemaPayload.project_id !== value.project_id ||
      canonicalHash(options.controlSchemaPayload.expected_versions) !== canonicalHash(value.expected_versions)) {
      fail("scope_mismatch", contract, "control_schema_payload", "Control payload scope and expected versions must match the outer reference.");
    }
    if (canonicalHash(options.controlSchemaPayload) !== value.control_schema_hash) {
      fail("hash_mismatch", contract, "control_schema_hash", "Control schema hash does not match the canonical local UI control payload.");
    }
  }
  if (!options.trustedScope) fail("missing_trusted_context", contract, "trusted_scope", "A separately supplied trusted scope is required.");
  assertTrustedScope(value, options.trustedScope, contract);
  rejectCredentialMaterial(value, contract);
  return value;
}

export function validateEditPlan(value, options = {}) {
  const contract = "EditPlan";
  requireContract(value, contract, CREATIVE_CONTRACT_VERSIONS.EditPlan);
  validateEnvelope(value, contract);
  expectString(value.plan_id, contract, "plan_id", { maxLength: 200 });
  expectObject(value.base, contract, "base");
  assertHash(value.base.brief_hash, contract, "base.brief_hash");
  if (options.brief_hash && value.base.brief_hash !== options.brief_hash) {
    fail("hash_mismatch", contract, "base.brief_hash", "Edit plan is not bound to the supplied brief hash.");
  }
  assertHash(value.base.design_hash, contract, "base.design_hash");
  if (options.design_hash && value.base.design_hash !== options.design_hash) {
    fail("hash_mismatch", contract, "base.design_hash", "Edit plan is not bound to the supplied base design hash.");
  }
  if (Object.prototype.hasOwnProperty.call(value.base, "design_version_id")) {
    expectString(value.base.design_version_id, contract, "base.design_version_id", { maxLength: 200 });
    if (options.design_version_ids && !options.design_version_ids.includes(value.base.design_version_id)) {
      fail("invalid_reference", contract, "base.design_version_id", "Edit plan refers to an unknown design version.");
    }
  }
  validateAction(value.operation, contract, "operation");
  const sourceRefs = new Set(expectArray(value.source_refs, contract, "source_refs"));
  for (const [index, ref] of [...sourceRefs].entries()) {
    expectString(ref, contract, "source_refs[" + index + "]", { maxLength: 300 });
  }
  if (sourceRefs.size !== value.source_refs.length) {
    fail("duplicate_reference", contract, "source_refs", "Edit plan source references must be unique.");
  }
  if (options.known_source_refs) {
    const known = new Set(options.known_source_refs);
    for (const ref of sourceRefs) {
      if (!known.has(ref)) fail("invalid_reference", contract, "source_refs", "Edit plan refers to an unknown source.");
    }
  }
  const steps = expectArray(value.steps, contract, "steps");
  if (steps.length === 0 || steps.length > 20) {
    fail("out_of_bounds", contract, "steps", "Edit plans require between 1 and 20 steps.");
  }
  const stepIds = new Set();
  steps.forEach((step, index) => {
    const field = "steps[" + index + "]";
    expectObject(step, contract, field);
    const stepId = expectString(step.step_id, contract, field + ".step_id", { maxLength: 200 });
    if (stepIds.has(stepId)) fail("duplicate_id", contract, field + ".step_id", "Step IDs must be unique within the plan.");
    stepIds.add(stepId);
    validateAction(step.action, contract, field + ".action");
    if (step.action !== value.operation && !(value.operation === "concept.generate" && step.action === "image.edit")) {
      fail("invalid_action", contract, field + ".action", "Step action is not allowed by the plan operation.");
    }
    expectArray(step.source_refs, contract, field + ".source_refs").forEach((ref, refIndex) => {
      expectString(ref, contract, field + ".source_refs[" + refIndex + "]", { maxLength: 300 });
      if (!sourceRefs.has(ref)) fail("invalid_reference", contract, field + ".source_refs[" + refIndex + "]", "Step source is absent from plan source_refs.");
    });
    const parameters = expectObject(step.parameters, contract, field + ".parameters");
    validateActionParameters(step.action, parameters, contract, field + ".parameters", {
      ...options,
      known_source_refs: [...sourceRefs],
    });
  });
  expectObject(value.expected_result, contract, "expected_result");
  if (value.expected_result.contract !== "DesignVersion" || value.expected_result.schema_version !== "1.0") {
    fail("invalid_reference", contract, "expected_result", "Edit plan results must target DesignVersion schema 1.0.");
  }
  expectString(value.expected_result.parent_version_id, contract, "expected_result.parent_version_id", { maxLength: 200 });
  expectEnum(value.expected_result.artifact_kind, ["image"], contract, "expected_result.artifact_kind");
  if (options.design_version_ids && !options.design_version_ids.includes(value.expected_result.parent_version_id)) {
    fail("invalid_reference", contract, "expected_result.parent_version_id", "Expected parent design version is unknown.");
  }
  expectArray(value.invalidates, contract, "invalidates").forEach((item, index) =>
    expectString(item, contract, "invalidates[" + index + "]", { maxLength: 200 }));
  if (!options.trustedScope) fail("missing_trusted_context", contract, "trusted_scope", "A separately supplied trusted scope is required.");
  assertTrustedScope(value, options.trustedScope, contract);
  rejectCredentialMaterial(value, contract);
  return value;
}

function validateAction(value, contract, field) {
  if (!ACTIONS.includes(value)) {
    fail("unsupported_action", contract, field, "Unknown actions are never executable.");
  }
  return value;
}

function validateActionParameters(action, parameters, contract, field, options) {
  let serialized;
  try {
    serialized = JSON.stringify(parameters);
  } catch {
    fail("invalid_type", contract, field, "Action parameters must be serializable JSON.");
  }
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > 8192) {
    fail("out_of_bounds", contract, field, "Action parameters exceed the 8 KiB limit.");
  }
  switch (action) {
    case "concept.generate": {
      assertOnlyKeys(parameters, ["brief_id", "variant_count", "style_ref"], contract, field);
      expectString(parameters.brief_id, contract, field + ".brief_id", { maxLength: 200 });
      expectInteger(parameters.variant_count, contract, field + ".variant_count", { min: 1, max: 4 });
      if (Object.prototype.hasOwnProperty.call(parameters, "style_ref")) {
        expectString(parameters.style_ref, contract, field + ".style_ref", { maxLength: 300 });
        if (options.known_source_refs && !options.known_source_refs.includes(parameters.style_ref)) {
          fail("invalid_reference", contract, field + ".style_ref", "Style reference is not listed in plan source_refs.");
        }
      }
      return;
    }
    case "image.edit": {
      assertOnlyKeys(parameters, ["design_version_id", "artifact_id", "instruction", "mask_source_ref"], contract, field);
      const designId = expectString(parameters.design_version_id, contract, field + ".design_version_id", { maxLength: 200 });
      if (options.design_version_ids && !options.design_version_ids.includes(designId)) {
        fail("invalid_reference", contract, field + ".design_version_id", "Image edit refers to an unknown design version.");
      }
      const artifactId = expectString(parameters.artifact_id, contract, field + ".artifact_id", { maxLength: 200 });
      if (options.known_artifact_ids && !options.known_artifact_ids.includes(artifactId)) {
        fail("invalid_reference", contract, field + ".artifact_id", "Image edit refers to an unknown artifact.");
      }
      expectString(parameters.instruction, contract, field + ".instruction", { maxLength: 2000 });
      if (Object.prototype.hasOwnProperty.call(parameters, "mask_source_ref")) {
        expectString(parameters.mask_source_ref, contract, field + ".mask_source_ref", { maxLength: 300 });
        if (!options.known_source_refs?.includes(parameters.mask_source_ref)) {
          fail("invalid_reference", contract, field + ".mask_source_ref", "Mask source must appear in plan source_refs.");
        }
      }
      return;
    }
    case "composition.update": {
      assertOnlyKeys(parameters, ["design_version_id", "changes"], contract, field);
      const designId = expectString(parameters.design_version_id, contract, field + ".design_version_id", { maxLength: 200 });
      if (options.design_version_ids && !options.design_version_ids.includes(designId)) {
        fail("invalid_reference", contract, field + ".design_version_id", "Composition update refers to an unknown design version.");
      }
      const changes = expectArray(parameters.changes, contract, field + ".changes");
      if (changes.length === 0 || changes.length > 32) {
        fail("out_of_bounds", contract, field + ".changes", "Composition updates require 1 to 32 allowlisted field changes.");
      }
      changes.forEach((change, index) => {
        const path = field + ".changes[" + index + "]";
        expectObject(change, contract, path);
        assertOnlyKeys(change, ["field", "value", "asset_id"], contract, path);
        expectString(change.field, contract, path + ".field", { maxLength: 100 });
        if (!Object.prototype.hasOwnProperty.call(change, "value")) {
          fail("missing_field", contract, path + ".value", "Each composition change requires a value.");
        }
        validateBoundedJson(change.value, contract, path + ".value", 2048, 5);
        if (Object.prototype.hasOwnProperty.call(change, "asset_id")) {
          const assetId = expectString(change.asset_id, contract, path + ".asset_id", { maxLength: 200 });
          if (options.known_asset_ids && !options.known_asset_ids.includes(assetId)) {
            fail("invalid_reference", contract, path + ".asset_id", "Composition change refers to an unknown asset.");
          }
        }
      });
      return;
    }
    case "correction.apply": {
      assertOnlyKeys(parameters, ["design_version_id", "fact_id", "replacement_value", "evidence_refs"], contract, field);
      const designId = expectString(parameters.design_version_id, contract, field + ".design_version_id", { maxLength: 200 });
      if (options.design_version_ids && !options.design_version_ids.includes(designId)) {
        fail("invalid_reference", contract, field + ".design_version_id", "Correction refers to an unknown design version.");
      }
      const factId = expectString(parameters.fact_id, contract, field + ".fact_id", { maxLength: 200 });
      if (options.known_fact_ids && !options.known_fact_ids.includes(factId)) {
        fail("invalid_reference", contract, field + ".fact_id", "Correction refers to an unknown fact.");
      }
      validateBoundedJson(parameters.replacement_value, contract, field + ".replacement_value", 2048, 5);
      const refs = expectArray(parameters.evidence_refs, contract, field + ".evidence_refs");
      if (refs.length === 0 || refs.length > 8) {
        fail("out_of_bounds", contract, field + ".evidence_refs", "A correction requires 1 to 8 evidence references.");
      }
      refs.forEach((ref, index) => {
        expectString(ref, contract, field + ".evidence_refs[" + index + "]", { maxLength: 300 });
        if (options.known_source_refs && !options.known_source_refs.includes(ref)) {
          fail("invalid_reference", contract, field + ".evidence_refs[" + index + "]", "Correction evidence must be listed in plan source_refs.");
        }
      });
      return;
    }
    default:
      validateAction(action, contract, field);
  }
}

function validateBoundedJson(value, contract, field, maxBytes, maxDepth) {
  const active = new Set();
  function walk(current, path, depth) {
    if (depth > maxDepth) fail("out_of_bounds", contract, path, "Nested values exceed the maximum depth.");
    if (current === null || typeof current === "string" || typeof current === "boolean") return;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) fail("invalid_number", contract, path, "Action values must be finite.");
      return;
    }
    if (Array.isArray(current)) {
      if (active.has(current)) fail("cyclic_value", contract, path, "Action values cannot contain cycles.");
      active.add(current);
      current.forEach((item, index) => walk(item, path + "[" + index + "]", depth + 1));
      active.delete(current);
      return;
    }
    if (current === null || typeof current !== "object" || Object.getPrototypeOf(current) !== Object.prototype) {
      fail("invalid_type", contract, path, "Action values must use bounded JSON values.");
    }
    if (active.has(current)) fail("cyclic_value", contract, path, "Action values cannot contain cycles.");
    active.add(current);
    for (const [key, item] of Object.entries(current)) walk(item, path + "." + key, depth + 1);
    active.delete(current);
  }
  walk(value, field, 0);
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > maxBytes) {
    fail("out_of_bounds", contract, field, "Action value exceeds its byte limit.");
  }
}

export function computeDesignVersionHash(value) {
  const copy = { ...value };
  delete copy.design_hash;
  return canonicalHash(copy);
}

export function validateDesignVersion(value, options = {}) {
  const contract = "DesignVersion";
  requireContract(value, contract, CREATIVE_CONTRACT_VERSIONS.DesignVersion);
  validateEnvelope(value, contract);
  expectString(value.design_version_id, contract, "design_version_id", { maxLength: 200 });
  if (value.parent_version_id !== null) {
    expectString(value.parent_version_id, contract, "parent_version_id", { maxLength: 200 });
    if (options.design_version_ids && !options.design_version_ids.includes(value.parent_version_id)) {
      fail("invalid_reference", contract, "parent_version_id", "Design version parent is unknown.");
    }
  }
  assertHash(value.brief_hash, contract, "brief_hash");
  if (options.brief_hash && value.brief_hash !== options.brief_hash) {
    fail("hash_mismatch", contract, "brief_hash", "Design version is not bound to the supplied brief hash.");
  }
  expectArray(value.source_refs, contract, "source_refs").forEach((ref, index) => {
    expectString(ref, contract, "source_refs[" + index + "]", { maxLength: 300 });
    if (options.known_source_refs && !options.known_source_refs.includes(ref)) {
      fail("invalid_reference", contract, "source_refs[" + index + "]", "Design version refers to an unknown source.");
    }
  });
  expectObject(value.artifact, contract, "artifact");
  expectString(value.artifact.artifact_id, contract, "artifact.artifact_id", { maxLength: 200 });
  if (Object.prototype.hasOwnProperty.call(value, "artifact_id") && value.artifact_id !== value.artifact.artifact_id) {
    fail("scope_mismatch", contract, "artifact.artifact_id", "Nested artifact identity must match the design version envelope.");
  }
  if (options.trustedScope?.artifact_id !== undefined && value.artifact.artifact_id !== options.trustedScope.artifact_id) {
    fail("scope_mismatch", contract, "artifact.artifact_id", "Nested artifact identity does not match the trusted object reference.");
  }
  assertHash(value.artifact.content_hash, contract, "artifact.content_hash");
  expectString(value.artifact.media_type, contract, "artifact.media_type", { maxLength: 100 });
  assertHash(value.design_hash, contract, "design_hash");
  if (value.design_hash !== computeDesignVersionHash(value)) {
    fail("hash_mismatch", contract, "design_hash", "Design hash does not match the canonical version payload.");
  }
  if (!options.trustedScope) fail("missing_trusted_context", contract, "trusted_scope", "A separately supplied trusted scope is required.");
  assertTrustedScope(value, options.trustedScope, contract);
  rejectCredentialMaterial(value, contract);
  return value;
}

export function validateCreativeScope(value, trustedScope, contract = "CreativeScope") {
  return assertTrustedScope(value, trustedScope, contract);
}
