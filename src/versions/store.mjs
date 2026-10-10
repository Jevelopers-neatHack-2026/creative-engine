import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  canonicalHash,
  canonicalSerialize,
  computeDesignVersionHash,
  validateCreativeBrief,
  validateDesignVersion,
} from "../contracts/index.mjs";
import {
  ContentAddressedStorageError,
  hashArtifactBytes,
  readContentAddressedObject,
  writeContentAddressedObject,
} from "../storage/content-addressed.mjs";

const STORAGE_VERSION = 3;
const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,256}$/;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const ATTEMPT_FIELDS = [
  "job_id", "action_id", "actor_id", "request_hash", "logical_operation_id", "billable_attempt_id",
  "parent_design_hash", "transport_attempt_ids", "provider_request_ids", "usage_refs", "trace_refs",
];
const publicationTransactionRegistries = new WeakMap();

const ERROR_MESSAGES = Object.freeze({
  invalid_request: "The version write does not match the supported local contract.",
  unsupported_version: "The stored version schema is not supported.",
  scope_denied: "The operation is outside the trusted project scope.",
  not_found: "The scoped version was not found.",
  conflict: "The action identity conflicts with an existing operation.",
  stale_version: "The selected version changed before this operation committed.",
  integrity_error: "Stored version or artifact integrity could not be verified.",
  unknown_completion: "The durable operation requires reconciliation.",
  unavailable: "Durable version storage is unavailable.",
});

export class VersionStoreError extends Error {
  constructor(code, field = "", retryable = false) {
    super(ERROR_MESSAGES[code] ?? ERROR_MESSAGES.unavailable);
    this.name = "VersionStoreError";
    this.code = Object.hasOwn(ERROR_MESSAGES, code) ? code : "unavailable";
    this.module = "creative-engine.versions";
    this.field = typeof field === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,119}$/.test(field) ? field : "";
    this.retryable = retryable;
  }
}

function reject(code, field, retryable = false) {
  throw new VersionStoreError(code, field, retryable);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return isRecord(value) && Object.keys(value).every((key) => allowed.includes(key));
}

function snapshotJson(value, code = "invalid_request", field = "record") {
  try { return JSON.parse(canonicalSerialize(value)); }
  catch { reject(code, field); }
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function reference(value, field, max = 256) {
  if (typeof value !== "string" || value.length > max || !ID_PATTERN.test(value) ||
    /(?:gh[pousr]_[A-Za-z0-9]{20,}|(?:sk|rk|pk)-[A-Za-z0-9_-]{12,})/i.test(value)) {
    reject("invalid_request", field);
  }
  return value;
}

function hash(value, field) {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) reject("invalid_request", field);
  return value;
}

function validScope(scope, briefId) {
  if (!isRecord(scope)) reject("scope_denied", "scope");
  const tenant_id = reference(scope.tenant_id, "scope.tenant_id");
  const project_id = reference(scope.project_id, "scope.project_id");
  if (scope.brief_id !== undefined && scope.brief_id !== briefId) reject("scope_denied", "scope.brief_id");
  const brief_id = reference(briefId, "brief_id");
  return Object.freeze({ tenant_id, project_id, brief_id });
}

function attemptEvidence(input) {
  if (!isRecord(input) || Object.keys(input).some((key) => !ATTEMPT_FIELDS.includes(key))) {
    reject("invalid_request", "creation");
  }
  const evidence = {
    job_id: reference(input.job_id, "creation.job_id"),
    action_id: reference(input.action_id, "creation.action_id"),
    actor_id: reference(input.actor_id, "creation.actor_id"),
    request_hash: hash(input.request_hash, "creation.request_hash"),
  };
  for (const field of ["logical_operation_id", "billable_attempt_id"]) {
    if (input[field] !== undefined) evidence[field] = reference(input[field], `creation.${field}`);
  }
  if (input.parent_design_hash !== undefined) evidence.parent_design_hash = hash(input.parent_design_hash, "creation.parent_design_hash");
  for (const field of ["transport_attempt_ids", "provider_request_ids", "usage_refs", "trace_refs"]) {
    if (input[field] === undefined) continue;
    if (!Array.isArray(input[field]) || input[field].length > 100) reject("invalid_request", `creation.${field}`);
    const values = input[field].map((value, index) => reference(value, `creation.${field}[${index}]`));
    if (new Set(values).size !== values.length) reject("invalid_request", `creation.${field}`);
    evidence[field] = values;
  }
  return deepFreeze(evidence);
}

function selectionRequest(value, design) {
  if (!isRecord(value) || Object.keys(value).some((key) => ![
    "mode", "expected_revision", "expected_selected_design_version_id", "expected_selected_design_hash",
  ].includes(key))) reject("invalid_request", "selection");
  if (value.mode !== "advance" && value.mode !== "branch") reject("invalid_request", "selection.mode");
  if (value.mode === "advance") {
    if (!Number.isSafeInteger(value.expected_revision) || value.expected_revision < 0) reject("invalid_request", "selection.expected_revision");
    const id = value.expected_selected_design_version_id;
    const parentHash = value.expected_selected_design_hash;
    if (id === null) {
      if (parentHash !== null) reject("invalid_request", "selection.expected_selected_design_hash");
    } else {
      reference(id, "selection.expected_selected_design_version_id");
      hash(parentHash, "selection.expected_selected_design_hash");
    }
  } else {
    if (design.parent_version_id === null) reject("invalid_request", "selection.mode");
    if (Object.hasOwn(value, "expected_revision") || Object.hasOwn(value, "expected_selected_design_version_id") ||
      Object.hasOwn(value, "expected_selected_design_hash")) reject("invalid_request", "selection");
  }
  return deepFreeze(snapshotJson(value));
}

function validateContextSnapshot(value, scope) {
  const fields = ["brief_snapshot", "brief_hash", "fact_hash", "permission_hash", "lock_hash", "source_identity_hash",
    "configuration_snapshot", "configuration_hash"];
  if (!hasOnlyKeys(value, fields) || Object.keys(value).length !== fields.length) reject("integrity_error", "version_context");
  let brief;
  try { brief = validateCreativeBrief(value.brief_snapshot, { trustedScope: scope }); }
  catch { reject("integrity_error", "version_context.brief_snapshot"); }
  const computed = {
    brief_hash: canonicalHash(brief),
    fact_hash: canonicalHash(brief.facts),
    permission_hash: canonicalHash(brief.permissions),
    lock_hash: canonicalHash(brief.locks),
    source_identity_hash: canonicalHash(brief.source_identity),
  };
  if (Object.entries(computed).some(([field, valueHash]) => value[field] !== valueHash)) {
    reject("integrity_error", "version_context.hashes");
  }
  if (value.configuration_snapshot === null) {
    if (value.configuration_hash !== null) reject("integrity_error", "version_context.configuration_hash");
  } else {
    if (!isRecord(value.configuration_snapshot) || canonicalHash(value.configuration_snapshot) !== value.configuration_hash) {
      reject("integrity_error", "version_context.configuration_hash");
    }
  }
  return brief;
}

function validateContextRecord(value, scope, field = "version_context") {
  try {
    return validateContextSnapshot(value, scope);
  } catch (error) {
    if (error instanceof VersionStoreError) throw error;
    reject("integrity_error", field);
  }
}

function validateCommitIntentRow(row, expectedScope) {
  try {
    if (!isRecord(row) || typeof row.intent_json !== "string" || typeof row.payload_hash !== "string" ||
      !HASH_PATTERN.test(row.payload_hash)) reject("integrity_error", "creation.intent");
    const intent = JSON.parse(row.intent_json);
    if (!isRecord(intent) || canonicalSerialize(intent) !== row.intent_json ||
      intent.storage_contract !== "CreativeVersionCommitIntent" || intent.schema_version !== "1.0") {
      reject("integrity_error", "creation.intent");
    }
    const { created_at: createdAt, ...stableIntent } = intent;
    if (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt)) ||
      new Date(createdAt).toISOString() !== createdAt || row.created_at !== createdAt ||
      canonicalHash(stableIntent) !== row.payload_hash) reject("integrity_error", "creation.intent");

    const scope = validScope({ tenant_id: row.tenant_id, project_id: row.project_id }, row.brief_id);
    if (expectedScope && (scope.tenant_id !== expectedScope.tenant_id ||
      scope.project_id !== expectedScope.project_id || scope.brief_id !== expectedScope.brief_id)) {
      reject("integrity_error", "creation.intent.scope");
    }
    const exactScope = { tenant_id: scope.tenant_id, project_id: scope.project_id, brief_id: scope.brief_id };
    if (!hasOnlyKeys(intent.scope, ["tenant_id", "project_id", "brief_id"]) ||
      canonicalSerialize(intent.scope) !== canonicalSerialize(exactScope) || intent.brief_id !== row.brief_id ||
      reference(row.action_id, "creation.action_id") !== intent.evidence?.creation?.action_id ||
      reference(row.actor_id, "creation.actor_id") !== intent.actor_id ||
      reference(row.job_id, "creation.job_id") !== intent.evidence?.creation?.job_id ||
      hash(row.request_hash, "creation.request_hash") !== intent.evidence?.creation?.request_hash) {
      reject("integrity_error", "creation.intent.identity");
    }

    const creation = attemptEvidence(intent.evidence?.creation);
    if (creation.action_id !== row.action_id || creation.actor_id !== row.actor_id ||
      creation.job_id !== row.job_id || creation.request_hash !== row.request_hash) {
      reject("integrity_error", "creation.intent.identity");
    }
    const expectedEvidence = {
      creation,
      usage_refs: creation.usage_refs ?? [],
      trace_refs: creation.trace_refs ?? [],
      attempt_identities: {
        ...(creation.logical_operation_id ? { logical_operation_id: creation.logical_operation_id } : {}),
        ...(creation.billable_attempt_id ? { billable_attempt_id: creation.billable_attempt_id } : {}),
        transport_attempt_ids: creation.transport_attempt_ids ?? [],
        provider_request_ids: creation.provider_request_ids ?? [],
      },
    };
    if (!isRecord(intent.evidence) || canonicalSerialize(intent.evidence) !== canonicalSerialize(expectedEvidence)) {
      reject("integrity_error", "creation.intent.evidence");
    }

    const brief = validateContextRecord(intent.context, exactScope, "creation.intent.context");
    if (!isRecord(intent.design_version)) reject("integrity_error", "creation.intent.design_version");
    const design = validateDesignVersion(intent.design_version, {
      trustedScope: { ...exactScope, design_version_id: intent.design_version.design_version_id },
      brief_hash: intent.context.brief_hash,
      known_source_refs: brief.source_identity.map((source) => source.source_id),
    });
    if (!hasOnlyKeys(intent.artifact, ["content_hash", "byte_length"]) ||
      intent.artifact.content_hash !== design.artifact.content_hash || !Number.isSafeInteger(intent.artifact.byte_length) ||
      intent.artifact.byte_length < 1 || intent.artifact.byte_length > MAX_ARTIFACT_BYTES) {
      reject("integrity_error", "creation.intent.artifact");
    }
    const selection = selectionRequest(intent.selection, design);
    if (canonicalSerialize(selection) !== canonicalSerialize(intent.selection)) reject("integrity_error", "creation.intent.selection");
    if (intent.job_result !== null && (!isRecord(intent.job_result) ||
      intent.job_result.design?.design_version_id !== design.design_version_id)) {
      reject("integrity_error", "creation.intent.job_result");
    }
    return intent;
  } catch (error) {
    if (error instanceof VersionStoreError && error.code === "integrity_error") throw error;
    reject("integrity_error", "creation.intent");
  }
}

function configurationSnapshot(value) {
  if (value === undefined) return null;
  if (!isRecord(value)) reject("invalid_request", "configuration_snapshot");
  return deepFreeze(snapshotJson(value));
}

function getDesignHashAt(db, scope, designVersionId) {
  if (designVersionId === null) return null;
  return db.prepare(`SELECT design_hash FROM design_versions
    WHERE tenant_id=? AND project_id=? AND brief_id=? AND design_version_id=?`)
    .get(scope.tenant_id, scope.project_id, scope.brief_id, designVersionId)?.design_hash ?? null;
}

function publicationFenceCurrent(store, scope, fence) {
  const allowed = ["brief_id", "brief_hash", "design_version_id", "design_hash",
    "expected_current_design_version_id", "expected_current_design_hash"];
  if (!isRecord(fence) || Object.keys(fence).some((key) => !allowed.includes(key)) ||
    fence.brief_id !== scope.brief_id || typeof fence.brief_hash !== "string") return false;
  try {
    const brief = store.getBrief({ scope, brief_id: scope.brief_id });
    if (!brief || canonicalHash(brief) !== fence.brief_hash) return false;
    if (fence.design_version_id !== undefined) {
      const design = store.getDesignVersion({ scope, brief_id: scope.brief_id,
        design_version_id: reference(fence.design_version_id, "publication_fence.design_version_id") });
      if (!design || design.design_hash !== fence.design_hash) return false;
    }
    if (Object.hasOwn(fence, "expected_current_design_version_id")) {
      const selection = store.getSelection({ scope, brief_id: scope.brief_id });
      if ((selection?.design_version_id ?? null) !== fence.expected_current_design_version_id ||
        (selection?.design_hash ?? null) !== fence.expected_current_design_hash) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function rowScope(row, scope) {
  return row && row.tenant_id === scope.tenant_id && row.project_id === scope.project_id && row.brief_id === scope.brief_id;
}

function injectFault(faultInjector, point) {
  if (faultInjector === undefined) return;
  if (typeof faultInjector !== "function") reject("invalid_request", "fault_injector");
  try {
    const result = faultInjector(point);
    if (result && typeof result.then === "function") reject("invalid_request", "fault_injector");
  } catch (error) {
    if (error instanceof VersionStoreError) throw error;
    reject("unavailable", "fault_injector");
  }
}

function readStoredObjectSync(objectRoot, contentHash) {
  const digest = contentHash.slice(7);
  const path = resolve(objectRoot, "objects", "sha256", digest.slice(0, 2), digest);
  try {
    if (!lstatSync(path).isFile()) return null;
    const bytes = readFileSync(path);
    if (bytes.byteLength > MAX_ARTIFACT_BYTES) return null;
    if (hashArtifactBytes(bytes) !== contentHash) return null;
    return bytes;
  } catch {
    return null;
  }
}

function makeSchema(db) {
  const version = db.prepare("PRAGMA user_version").get().user_version;
  if (![0, 1, 2, STORAGE_VERSION].includes(version)) {
    db.close();
    reject("unsupported_version", "storage_version");
  }
  db.exec(`PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS creative_briefs (
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      brief_hash TEXT NOT NULL,
      brief_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(tenant_id, project_id, brief_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS creative_jobs (
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      brief_id TEXT,
      actor_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued','running','completed','cancelled','failed')),
      lease_hash TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL,
      attempt_evidence_json TEXT,
      result_json TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(tenant_id, project_id, job_id),
      UNIQUE(tenant_id, project_id, action_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS creative_dispatch_intents (
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      transport_attempt_id TEXT NOT NULL,
      billable_attempt_id TEXT,
      dispatch_intent_ref TEXT NOT NULL,
      context_fence_json TEXT NOT NULL,
      authorized_at TEXT NOT NULL,
      PRIMARY KEY(tenant_id, project_id, job_id, transport_attempt_id),
      UNIQUE(tenant_id, project_id, dispatch_intent_ref),
      FOREIGN KEY(tenant_id, project_id, job_id)
        REFERENCES creative_jobs(tenant_id, project_id, job_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS creative_cancel_requests (
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      target_action_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      job_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(tenant_id, project_id, action_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS creation_actions (
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('commit_intent','committed','conflict','cancelled','unknown')),
      intent_json TEXT NOT NULL,
      result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(tenant_id, project_id, action_id),
      UNIQUE(tenant_id, project_id, job_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS design_versions (
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      design_version_id TEXT NOT NULL,
      parent_version_id TEXT,
      parent_design_hash TEXT,
      brief_hash TEXT NOT NULL,
      design_hash TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      media_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      creation_job_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(tenant_id, project_id, brief_id, design_version_id),
      UNIQUE(tenant_id, project_id, brief_id, action_id),
      FOREIGN KEY(tenant_id, project_id, brief_id, parent_version_id)
        REFERENCES design_versions(tenant_id, project_id, brief_id, design_version_id),
      FOREIGN KEY(tenant_id, project_id, creation_job_id)
        REFERENCES creation_actions(tenant_id, project_id, job_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS version_evidence (
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      design_version_id TEXT NOT NULL,
      context_json TEXT NOT NULL,
      context_hash TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      evidence_hash TEXT NOT NULL,
      PRIMARY KEY(tenant_id, project_id, brief_id, design_version_id),
      FOREIGN KEY(tenant_id, project_id, brief_id, design_version_id)
        REFERENCES design_versions(tenant_id, project_id, brief_id, design_version_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS version_selections (
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      design_version_id TEXT NOT NULL,
      design_hash TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision >= 0),
      updated_at TEXT NOT NULL,
      PRIMARY KEY(tenant_id, project_id, brief_id),
      FOREIGN KEY(tenant_id, project_id, brief_id, design_version_id)
        REFERENCES design_versions(tenant_id, project_id, brief_id, design_version_id)
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS immutable_design_versions_update
      BEFORE UPDATE ON design_versions BEGIN SELECT RAISE(ABORT,'immutable version'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_design_versions_delete
      BEFORE DELETE ON design_versions BEGIN SELECT RAISE(ABORT,'immutable version'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_version_evidence_update
      BEFORE UPDATE ON version_evidence BEGIN SELECT RAISE(ABORT,'immutable evidence'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_version_evidence_delete
      BEFORE DELETE ON version_evidence BEGIN SELECT RAISE(ABORT,'immutable evidence'); END;
    `);
  const jobColumns = db.prepare("PRAGMA table_info(creative_jobs)").all();
  if (!jobColumns.some((column) => column.name === "attempt_evidence_json")) {
    db.exec("ALTER TABLE creative_jobs ADD COLUMN attempt_evidence_json TEXT");
  }
  db.exec(`PRAGMA user_version=${STORAGE_VERSION};`);
}

function freezeReturned(value) {
  return deepFreeze(snapshotJson(value, "integrity_error", "stored_record"));
}

/** Durable local version metadata, artifact objects, selection CAS, and commit-intent recovery. */
export class CreativeVersionStore {
  constructor({ databasePath, objectRoot, now = () => Date.now(), maxArtifactBytes = MAX_ARTIFACT_BYTES } = {}) {
    if (typeof databasePath !== "string" || databasePath.length === 0 || typeof objectRoot !== "string" || objectRoot.length === 0) {
      reject("invalid_request", "store_paths");
    }
    this.databasePath = databasePath === ":memory:" ? databasePath : resolve(databasePath);
    this.objectRoot = resolve(objectRoot);
    this.now = now;
    this.maxArtifactBytes = maxArtifactBytes;
    if (!Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes < 1 || maxArtifactBytes > MAX_ARTIFACT_BYTES) {
      reject("invalid_request", "max_artifact_bytes");
    }
    if (this.databasePath !== ":memory:") mkdirSync(dirname(this.databasePath), { recursive: true, mode: 0o700 });
    mkdirSync(this.objectRoot, { recursive: true, mode: 0o700 });
    try {
      this.db = new DatabaseSync(this.databasePath);
      makeSchema(this.db);
    } catch (error) {
      if (error instanceof VersionStoreError) throw error;
      reject("unavailable", "database", true);
    }
    this.closed = false;
    publicationTransactionRegistries.set(this, new WeakMap());
  }

  close() {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  assertOpen() {
    if (this.closed) reject("unavailable", "database");
  }

  timestamp() {
    const value = this.now();
    if (!Number.isFinite(value)) reject("unavailable", "clock");
    return new Date(value).toISOString();
  }

  getBrief({ scope: inputScope, brief_id }) {
    this.assertOpen();
    const scope = validScope(inputScope, brief_id);
    const row = this.db.prepare(`SELECT brief_hash,brief_json FROM creative_briefs
      WHERE tenant_id=? AND project_id=? AND brief_id=?`)
      .get(scope.tenant_id, scope.project_id, scope.brief_id);
    if (!row) return null;
    const brief = snapshotJson(JSON.parse(row.brief_json), "integrity_error", "brief_snapshot");
    const validated = validateCreativeBrief(brief, { trustedScope: scope });
    if (canonicalHash(validated) !== row.brief_hash) reject("integrity_error", "brief_hash");
    return freezeReturned(validated);
  }

  putBrief({ scope: inputScope, brief: briefInput, expected_brief_hash = null }) {
    this.assertOpen();
    const briefSnapshot = snapshotJson(briefInput, "invalid_request", "brief");
    const briefId = reference(briefSnapshot?.brief_id, "brief_id");
    const scope = validScope(inputScope, briefId);
    const brief = validateCreativeBrief(briefSnapshot, { trustedScope: scope });
    const briefHash = canonicalHash(brief);
    if (expected_brief_hash !== null) hash(expected_brief_hash, "expected_brief_hash");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.db.prepare(`SELECT brief_hash FROM creative_briefs
        WHERE tenant_id=? AND project_id=? AND brief_id=?`)
        .get(scope.tenant_id, scope.project_id, scope.brief_id);
      if ((old?.brief_hash ?? null) !== expected_brief_hash) {
        this.db.exec("ROLLBACK");
        return freezeReturned({ status: "stale", brief_hash: old?.brief_hash ?? null });
      }
      this.db.prepare(`INSERT INTO creative_briefs (tenant_id,project_id,brief_id,brief_hash,brief_json,updated_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT(tenant_id,project_id,brief_id) DO UPDATE SET
        brief_hash=excluded.brief_hash,brief_json=excluded.brief_json,updated_at=excluded.updated_at`)
        .run(scope.tenant_id, scope.project_id, scope.brief_id, briefHash, canonicalSerialize(brief), this.timestamp());
      this.db.exec("COMMIT");
      return freezeReturned({ status: "saved", brief_hash: briefHash });
    } catch (error) {
      this.rollback();
      if (error instanceof VersionStoreError) throw error;
      reject("unavailable", "brief", true);
    }
  }

  recordAttemptEvidence(input) {
    this.assertOpen();
    if (!isRecord(input)) reject("invalid_request", "attempt_evidence");
    const scope = validScope(input.scope, input.scope?.brief_id);
    const actor_id = reference(input.actor_id, "actor_id");
    const job_id = reference(input.job_id, "job_id");
    const action_id = reference(input.action_id, "action_id");
    const lease_token = reference(input.lease_token, "lease_token");
    const evidence = attemptEvidence(input.creation);
    if (evidence.actor_id !== actor_id || evidence.job_id !== job_id || evidence.action_id !== action_id ||
      evidence.request_hash !== input.request_hash || evidence.billable_attempt_id === undefined ||
      !Array.isArray(evidence.transport_attempt_ids) || evidence.transport_attempt_ids.length === 0) {
      reject("invalid_request", "attempt_evidence.identity");
    }
    const request_hash = hash(input.request_hash, "request_hash");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`SELECT actor_id,action_id,request_hash,operation,status,lease_hash,attempt_evidence_json
        FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
        .get(scope.tenant_id, scope.project_id, job_id);
      if (!row || row.actor_id !== actor_id || row.action_id !== action_id || row.request_hash !== request_hash ||
        !["generate", "edit"].includes(row.operation) || !["running", "cancelled", "failed"].includes(row.status) ||
        row.lease_hash !== createHash("sha256").update(lease_token).digest("hex")) {
        reject("cancelled", "job.lease_token");
      }
      for (const transportId of evidence.transport_attempt_ids) {
        const dispatch = this.db.prepare(`SELECT billable_attempt_id FROM creative_dispatch_intents
          WHERE tenant_id=? AND project_id=? AND job_id=? AND transport_attempt_id=?`)
          .get(scope.tenant_id, scope.project_id, job_id, transportId);
        if (!dispatch || dispatch.billable_attempt_id !== evidence.billable_attempt_id) {
          reject("integrity_error", "attempt_evidence.transport_attempt_ids");
        }
      }
      const serialized = canonicalSerialize(evidence);
      if (row.attempt_evidence_json !== null) {
        const existing = snapshotJson(JSON.parse(row.attempt_evidence_json), "integrity_error", "job.attempt_evidence");
        if (canonicalSerialize(existing) !== serialized) reject("conflict", "job.attempt_evidence");
        this.db.exec("COMMIT");
        return freezeReturned({ status: "replayed" });
      }
      this.db.prepare(`UPDATE creative_jobs SET attempt_evidence_json=?,updated_at=?
        WHERE tenant_id=? AND project_id=? AND job_id=? AND attempt_evidence_json IS NULL`)
        .run(serialized, this.timestamp(), scope.tenant_id, scope.project_id, job_id);
      this.db.exec("COMMIT");
      return freezeReturned({ status: "recorded" });
    } catch (error) {
      this.rollback();
      if (error instanceof VersionStoreError) throw error;
      reject("unavailable", "job.attempt_evidence", true);
    }
  }

  prepareWrite(input) {
    this.assertOpen();
    if (!isRecord(input)) reject("invalid_request", "write");
    const designInput = snapshotJson(input.design_version, "invalid_request", "design_version");
    const briefInput = snapshotJson(input.brief_snapshot, "invalid_request", "brief_snapshot");
    const briefId = reference(input.brief_id ?? designInput.brief_id, "brief_id");
    const scope = validScope(input.scope, briefId);
    const actor_id = reference(input.actor_id ?? input.creation?.actor_id, "actor_id");
    if (!(input.artifact_bytes instanceof Uint8Array) || input.artifact_bytes.byteLength === 0 ||
      input.artifact_bytes.byteLength > this.maxArtifactBytes) reject("invalid_request", "artifact_bytes");
    const artifactBytes = Uint8Array.from(input.artifact_bytes);
    const contentHash = hashArtifactBytes(artifactBytes);
    if (contentHash !== designInput.artifact?.content_hash) reject("integrity_error", "artifact_bytes");
    const brief = validateCreativeBrief(briefInput, { trustedScope: scope });
    const briefHash = canonicalHash(brief);
    if (designInput.brief_hash !== briefHash) reject("stale_version", "brief_hash");
    const design = validateDesignVersion(designInput, {
      trustedScope: { ...scope, design_version_id: designInput.design_version_id },
      brief_hash: briefHash,
      known_source_refs: brief.source_identity.map((source) => source.source_id),
    });
    if (design.design_hash !== computeDesignVersionHash(design)) reject("integrity_error", "design_hash");
    const creation = attemptEvidence(input.creation);
    if (creation.actor_id !== actor_id) reject("scope_denied", "creation.actor_id");
    const selection = selectionRequest(input.selection, design);
    const parentDesignHash = design.parent_version_id === null
      ? null : getDesignHashAt(this.db, scope, design.parent_version_id);
    if (design.parent_version_id !== null && parentDesignHash === null) reject("not_found", "design_version.parent_version_id");
    if (design.parent_version_id === null && creation.parent_design_hash !== undefined) reject("invalid_request", "creation.parent_design_hash");
    if (design.parent_version_id !== null && creation.parent_design_hash !== parentDesignHash) {
      reject("stale_version", "creation.parent_design_hash");
    }
    if (selection.mode === "branch" && design.parent_version_id === null) reject("invalid_request", "selection.mode");
    if (selection.mode === "advance" && design.parent_version_id !== selection.expected_selected_design_version_id) {
      reject("stale_version", "design_version.parent_version_id");
    }
    const configuration = configurationSnapshot(input.configuration_snapshot);
    const now = this.timestamp();
    const context = deepFreeze({
      brief_snapshot: brief,
      brief_hash: briefHash,
      fact_hash: canonicalHash(brief.facts),
      permission_hash: canonicalHash(brief.permissions),
      lock_hash: canonicalHash(brief.locks),
      source_identity_hash: canonicalHash(brief.source_identity),
      configuration_snapshot: configuration,
      configuration_hash: configuration === null ? null : canonicalHash(configuration),
    });
    const evidence = deepFreeze({
      creation,
      usage_refs: creation.usage_refs ?? [],
      trace_refs: creation.trace_refs ?? [],
      attempt_identities: Object.freeze({
        ...(creation.logical_operation_id ? { logical_operation_id: creation.logical_operation_id } : {}),
        ...(creation.billable_attempt_id ? { billable_attempt_id: creation.billable_attempt_id } : {}),
        transport_attempt_ids: creation.transport_attempt_ids ?? [],
        provider_request_ids: creation.provider_request_ids ?? [],
      }),
    });
    const jobResult = input.job_result === undefined ? null
      : deepFreeze(snapshotJson(input.job_result, "invalid_request", "job_result"));
    if (jobResult !== null && (!isRecord(jobResult) || jobResult.design?.design_version_id !== design.design_version_id)) {
      reject("invalid_request", "job_result");
    }
    const intent = deepFreeze({
      storage_contract: "CreativeVersionCommitIntent",
      schema_version: "1.0",
      scope, actor_id, brief_id: briefId, design_version: design,
      artifact: { content_hash: contentHash, byte_length: artifactBytes.byteLength },
      context, evidence, selection, created_at: now,
      job_result: jobResult,
    });
    const { created_at: _createdAt, ...stableIntent } = intent;
    const payload_hash = canonicalHash(stableIntent);
    return { scope, actor_id, brief_id: briefId, design, brief, artifactBytes, contentHash,
      creation, selection, context, evidence, intent, payload_hash, now };
  }

  async prepareDesignVersion(input, { faultInjector } = {}) {
    const prepared = this.prepareWrite(input);
    if (input.lease_token !== undefined) {
      const job = this.db.prepare(`SELECT actor_id,action_id,request_hash,status,lease_hash,lease_expires_at,attempt_evidence_json
        FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
        .get(prepared.scope.tenant_id, prepared.scope.project_id, prepared.creation.job_id);
      if (!job || job.actor_id !== prepared.actor_id || job.action_id !== prepared.creation.action_id ||
        job.request_hash !== prepared.creation.request_hash || job.status !== "running" ||
        job.lease_hash !== createHash("sha256").update(input.lease_token).digest("hex") ||
        Date.parse(job.lease_expires_at) <= this.now()) reject("cancelled", "job.lease_token");
      if (typeof job.attempt_evidence_json !== "string" ||
        job.attempt_evidence_json !== canonicalSerialize(prepared.creation)) {
        reject("integrity_error", "job.attempt_evidence");
      }
    }
    try {
      await writeContentAddressedObject(this.objectRoot, prepared.artifactBytes, prepared.contentHash);
    } catch (error) {
      if (error instanceof ContentAddressedStorageError && error.code === "hash_mismatch") {
        reject("integrity_error", "artifact_bytes");
      }
      reject("unavailable", "artifact_storage", true);
    }
    injectFault(faultInjector, "after_object_write");

    let prior;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (input.lease_token !== undefined) {
        const job = this.db.prepare(`SELECT actor_id,action_id,request_hash,status,lease_hash,lease_expires_at,attempt_evidence_json
          FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
          .get(prepared.scope.tenant_id, prepared.scope.project_id, prepared.creation.job_id);
        if (!job || job.actor_id !== prepared.actor_id || job.action_id !== prepared.creation.action_id ||
          job.request_hash !== prepared.creation.request_hash || job.status !== "running" ||
          job.lease_hash !== createHash("sha256").update(input.lease_token).digest("hex") ||
          Date.parse(job.lease_expires_at) <= this.now()) reject("cancelled", "job.lease_token");
        if (typeof job.attempt_evidence_json !== "string" ||
          job.attempt_evidence_json !== canonicalSerialize(prepared.creation)) {
          reject("integrity_error", "job.attempt_evidence");
        }
      }
      prior = this.db.prepare(`SELECT * FROM creation_actions
        WHERE tenant_id=? AND project_id=? AND action_id=?`)
        .get(prepared.scope.tenant_id, prepared.scope.project_id, prepared.creation.action_id);
      if (prior) {
        this.assertSameAction(prior, prepared);
      } else {
        this.db.prepare(`INSERT INTO creation_actions
          (tenant_id,project_id,brief_id,action_id,actor_id,job_id,request_hash,payload_hash,state,intent_json,result_json,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,'commit_intent',?,NULL,?,?)`)
          .run(prepared.scope.tenant_id, prepared.scope.project_id, prepared.scope.brief_id, prepared.creation.action_id,
            prepared.actor_id, prepared.creation.job_id, prepared.creation.request_hash,
            prepared.payload_hash, canonicalSerialize(prepared.intent), prepared.now, prepared.now);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.rollback();
      if (error instanceof VersionStoreError) throw error;
      reject("conflict", "creation.action_id");
    }
    if (prior?.state === "committed") return this.readActionResult(prior, true);
    if (prior?.state === "unknown") reject("unknown_completion", "creation.action_id");
    if (prior?.state === "cancelled") reject("cancelled", "creation.action_id");
    if (prior?.state === "conflict") {
      const priorResult = prior.result_json ? snapshotJson(JSON.parse(prior.result_json), "integrity_error", "creation.result") : null;
      if (priorResult?.status === "stale" && priorResult.code === "stale_version") return deepFreeze({ ...priorResult, replayed: true });
      reject("conflict", "creation.action_id");
    }
    injectFault(faultInjector, "after_commit_intent");
    return freezeReturned({ status: "prepared", action_id: prepared.creation.action_id,
      job_id: prepared.creation.job_id, payload_hash: prepared.payload_hash });
  }

  async saveDesignVersion(input, options = {}) {
    const result = await this.prepareDesignVersion(input, options);
    if (result.status === "saved" || result.status === "stale") return result;
    if (result.status !== "prepared") reject("unavailable", "creation.intent");
    const scope = validScope(input.scope, input.brief_id ?? input.design_version?.brief_id);
    const finalized = await this.finalizeAction(scope, result.action_id, options.faultInjector);
    if (finalized.status === "unknown") reject("unknown_completion", "creation.action_id");
    return finalized;
  }

  async commitPreparedDesignVersion(input, transaction) {
    const publication = this.publicationTransactionData(transaction);
    if (!publication || !isRecord(input)) reject("scope_denied", "publication_transaction");
    const briefId = reference(input.brief_id, "brief_id");
    const scope = validScope(input.scope, briefId);
    const actionId = reference(input.action_id, "action_id");
    const jobId = reference(input.job_id, "job_id");
    const payloadHash = hash(input.payload_hash, "payload_hash");
    if (publication.job_id !== jobId || publication.action_id !== actionId ||
      publication.scope.tenant_id !== scope.tenant_id || publication.scope.project_id !== scope.project_id ||
      publication.scope.brief_id !== scope.brief_id) reject("scope_denied", "publication_transaction");
    const row = this.db.prepare(`SELECT * FROM creation_actions WHERE tenant_id=? AND project_id=? AND action_id=?`)
      .get(scope.tenant_id, scope.project_id, actionId);
    if (!row || row.job_id !== jobId || row.payload_hash !== payloadHash || row.state !== "commit_intent") {
      reject("conflict", "creation.action_id");
    }
    const intent = validateCommitIntentRow(row, scope);
    if (intent.actor_id !== publication.actor_id || intent.evidence.creation.request_hash !== publication.request_hash ||
      canonicalSerialize(intent.job_result) !== canonicalSerialize(publication.result)) {
      reject("conflict", "creation.job_result");
    }
    return this.finalizeAction(scope, actionId, publication.faultInjector, transaction);
  }

  assertSameAction(row, prepared) {
    if (row.actor_id !== prepared.actor_id) reject("scope_denied", "creation.actor_id");
    if (row.request_hash !== prepared.creation.request_hash || row.payload_hash !== prepared.payload_hash ||
      row.job_id !== prepared.creation.job_id) reject("conflict", "creation.action_id");
  }

  readActionResult(row, replayed = false) {
    if (row.state === "committed" && typeof row.result_json === "string") {
      const result = snapshotJson(JSON.parse(row.result_json), "integrity_error", "creation.result");
      if (!isRecord(result) || result.status !== "saved" || !isRecord(result.design_version) ||
        !isRecord(result.selection) && result.selection !== null || typeof result.created_at !== "string") {
        reject("integrity_error", "creation.result");
      }
      const scope = validScope({ tenant_id: row.tenant_id, project_id: row.project_id }, row.brief_id);
      const intent = validateCommitIntentRow(row, scope);
      if (intent.scope.tenant_id !== scope.tenant_id || intent.scope.project_id !== scope.project_id ||
        intent.actor_id !== row.actor_id ||
        intent.evidence.creation.action_id !== row.action_id || intent.evidence.creation.job_id !== row.job_id ||
        intent.evidence.creation.request_hash !== row.request_hash ||
        result.design_version.design_version_id !== intent.design_version.design_version_id ||
        canonicalSerialize(result.design_version) !== canonicalSerialize(intent.design_version)) {
        reject("integrity_error", "creation.intent");
      }
      const versionRow = this.db.prepare(`SELECT action_id,creation_job_id,created_at FROM design_versions
        WHERE tenant_id=? AND project_id=? AND brief_id=? AND design_version_id=?`)
        .get(scope.tenant_id, scope.project_id, scope.brief_id, result.design_version.design_version_id);
      if (!versionRow || versionRow.action_id !== row.action_id || versionRow.creation_job_id !== row.job_id ||
        result.created_at !== versionRow.created_at || result.created_at !== row.updated_at) {
        reject("integrity_error", "creation.result");
      }
      const stored = this.getDesignVersion({ scope, brief_id: scope.brief_id,
        design_version_id: result.design_version.design_version_id });
      if (!stored || canonicalSerialize(stored) !== canonicalSerialize(result.design_version)) {
        reject("integrity_error", "creation.result.design_version");
      }
      const bytes = readStoredObjectSync(this.objectRoot, stored.artifact.content_hash);
      if (!bytes || bytes.byteLength !== intent.artifact.byte_length || hashArtifactBytes(bytes) !== stored.artifact.content_hash) {
        reject("integrity_error", "creation.result.artifact");
      }
      if (result.selection !== null) {
        const selection = result.selection;
        if (intent.selection.mode !== "advance" || selection.tenant_id !== scope.tenant_id ||
          selection.project_id !== scope.project_id || selection.brief_id !== scope.brief_id ||
          selection.design_version_id !== stored.design_version_id || selection.design_hash !== stored.design_hash ||
          selection.revision !== intent.selection.expected_revision + 1 ||
          Object.keys(selection).some((key) => !["tenant_id", "project_id", "brief_id", "design_version_id", "design_hash", "revision"].includes(key))) {
          reject("integrity_error", "creation.result.selection");
        }
      } else if (intent.selection.mode !== "branch") reject("integrity_error", "creation.result.selection");
      return deepFreeze({ ...result, status: "saved", replayed });
    }
    reject(row.state === "unknown" ? "unknown_completion" : "conflict", "creation.action_id");
  }

  rollback() {
    try { this.db.exec("ROLLBACK"); } catch { /* transaction may already be closed */ }
  }

  markRecoveryUnknown(row, code, field) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const action = this.db.prepare(`SELECT state FROM creation_actions
        WHERE tenant_id=? AND project_id=? AND action_id=?`)
        .get(row.tenant_id, row.project_id, row.action_id);
      if (action?.state === "commit_intent") {
        this.db.prepare(`UPDATE creation_actions SET state='unknown',updated_at=?
          WHERE tenant_id=? AND project_id=? AND action_id=? AND state='commit_intent'`)
          .run(this.timestamp(), row.tenant_id, row.project_id, row.action_id);
      }
      const job = this.db.prepare(`SELECT job_id,operation,status FROM creative_jobs
        WHERE tenant_id=? AND project_id=? AND action_id=?`)
        .get(row.tenant_id, row.project_id, row.action_id);
      if (job?.status === "running") {
        const safeCode = ["integrity_error", "stale_version"].includes(code) ? code : "unavailable";
        const safeField = ["creation.intent", "creative_context", "job.lease_expired"].includes(field)
          ? field : "creation.intent";
        const operation = ["generate", "edit", "inspect", "list", "compare", "restore", "cancel", "handoff", "job.status"]
          .includes(job.operation) ? job.operation : "unknown";
        const error = {
          code: safeCode,
          module: "creative-engine.api",
          operation,
          field: safeField,
          retryable: safeCode === "unavailable",
          message: safeCode === "integrity_error"
            ? "Stored version or artifact integrity could not be verified."
            : safeCode === "stale_version"
              ? "The requested design version is no longer current."
              : "A required service is unavailable; no successful result was produced.",
          diagnostic_ref: safeCode === "integrity_error" ? "creative-engine:creation-intent-integrity"
            : safeCode === "stale_version" ? "creative-engine:stale-context" : "creative-engine:lease-expired",
        };
        this.db.prepare(`UPDATE creative_jobs SET status='failed',result_json=NULL,error_json=?,updated_at=?
          WHERE tenant_id=? AND project_id=? AND action_id=? AND status='running'`)
          .run(canonicalSerialize(error), this.timestamp(), row.tenant_id, row.project_id, row.action_id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.rollback();
      if (error instanceof VersionStoreError) throw error;
      reject("unavailable", "recovery", true);
    }
  }

  createPublicationTransaction(data) {
    if (!isRecord(data) || this.db.isTransaction !== true || typeof data.job_id !== "string" ||
      typeof data.lease_token !== "string" || !isRecord(data.scope) || !isRecord(data.publication_fence)) {
      reject("invalid_request", "publication_transaction");
    }
    const scope = validScope(data.scope, data.publication_fence.brief_id);
    const jobId = reference(data.job_id, "job_id");
    const actorId = reference(data.actor_id, "actor_id");
    const actionId = reference(data.action_id, "action_id");
    const requestHash = hash(data.request_hash, "request_hash");
    const job = this.db.prepare(`SELECT actor_id,action_id,request_hash,status,lease_hash,lease_expires_at
      FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
      .get(scope.tenant_id, scope.project_id, jobId);
    const recoveryToken = `recovery:${jobId}`;
    const recoveryMode = data.lease_token === recoveryToken;
    if (!job || job.actor_id !== actorId || job.action_id !== actionId || job.request_hash !== requestHash ||
      job.status !== "running" || Date.parse(job.lease_expires_at) <= this.now() ||
      (!recoveryMode && job.lease_hash !== createHash("sha256").update(data.lease_token).digest("hex")) ||
      !publicationFenceCurrent(this, scope, data.publication_fence)) {
      reject("scope_denied", "publication_transaction");
    }
    const transaction = Object.freeze({ job_id: data.job_id, lease_token: data.lease_token });
    const { faultInjector, ...plainData } = data;
    if (faultInjector !== undefined && typeof faultInjector !== "function") reject("invalid_request", "fault_injector");
    const publication = snapshotJson(plainData);
    publicationTransactionRegistries.get(this).set(transaction, deepFreeze({ ...publication,
      ...(faultInjector ? { faultInjector } : {}) }));
    return transaction;
  }

  publicationTransactionData(transaction) {
    return transaction && typeof transaction === "object"
      ? publicationTransactionRegistries.get(this)?.get(transaction) : undefined;
  }

  closePublicationTransaction(transaction) {
    if (transaction && typeof transaction === "object") publicationTransactionRegistries.get(this)?.delete(transaction);
  }

  async finalizeAction(scope, actionId, faultInjector, transaction) {
    this.assertOpen();
    const publication = this.publicationTransactionData(transaction);
    if (transaction !== undefined && faultInjector === undefined) faultInjector = publication?.faultInjector;
    const ownsTransaction = transaction === undefined;
    if (!ownsTransaction && (!publication || publication.scope.tenant_id !== scope.tenant_id ||
      publication.scope.project_id !== scope.project_id || publication.action_id !== actionId)) {
      reject("scope_denied", "publication_transaction");
    }
    if (ownsTransaction) this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`SELECT * FROM creation_actions
        WHERE tenant_id=? AND project_id=? AND action_id=?`)
        .get(scope.tenant_id, scope.project_id, actionId);
      if (!row) reject("not_found", "creation.action_id");
      const intent = validateCommitIntentRow(row, scope);
      if (row.state === "committed") {
        if (ownsTransaction) this.db.exec("COMMIT");
        return this.readActionResult(row, true);
      }
      if (row.state === "unknown") {
        if (ownsTransaction) this.db.exec("COMMIT");
        return { status: "unknown", code: "unknown_completion" };
      }
      if (row.state !== "commit_intent") reject("conflict", "creation.action_id");
      const artifactBytes = readStoredObjectSync(this.objectRoot, intent.artifact.content_hash);
      if (!artifactBytes || artifactBytes.byteLength !== intent.artifact.byte_length) {
        this.db.prepare("UPDATE creation_actions SET state='unknown',updated_at=? WHERE tenant_id=? AND project_id=? AND action_id=?")
          .run(this.timestamp(), scope.tenant_id, scope.project_id, actionId);
        if (ownsTransaction) {
          this.db.exec("COMMIT");
          return { status: "unknown", code: "integrity_error" };
        }
        // A caller-owned publication transaction must never be committed here.
        // Roll back the outer job/version transaction and let recovery record
        // the unknown artifact outcome in its own bounded transaction.
        reject("integrity_error", "artifact.content_hash");
      }
      const design = intent.design_version;
      const selection = intent.selection;
      const currentBrief = this.db.prepare(`SELECT brief_hash FROM creative_briefs
        WHERE tenant_id=? AND project_id=? AND brief_id=?`)
        .get(scope.tenant_id, scope.project_id, scope.brief_id);
      if (currentBrief && currentBrief.brief_hash !== intent.context.brief_hash) {
        const conflict = { status: "stale", code: "stale_version", current: null };
        this.db.prepare("UPDATE creation_actions SET state='conflict',result_json=?,updated_at=? WHERE tenant_id=? AND project_id=? AND action_id=?")
          .run(canonicalSerialize(conflict), this.timestamp(), scope.tenant_id, scope.project_id, actionId);
        if (ownsTransaction) this.db.exec("COMMIT");
        return conflict;
      }
      let parentDesignHash = null;
      if (design.parent_version_id !== null) {
        parentDesignHash = getDesignHashAt(this.db, scope, design.parent_version_id);
        if (!parentDesignHash) {
          this.db.prepare("UPDATE creation_actions SET state='conflict',result_json=?,updated_at=? WHERE tenant_id=? AND project_id=? AND action_id=?")
            .run(canonicalSerialize({ status: "not_found", code: "parent_version" }), this.timestamp(), scope.tenant_id, scope.project_id, actionId);
          if (ownsTransaction) this.db.exec("COMMIT");
          reject("not_found", "design_version.parent_version_id");
        }
        if (intent.evidence.creation.parent_design_hash !== parentDesignHash) {
          const conflict = { status: "stale", code: "stale_version", current: null };
          this.db.prepare("UPDATE creation_actions SET state='conflict',result_json=?,updated_at=? WHERE tenant_id=? AND project_id=? AND action_id=?")
            .run(canonicalSerialize(conflict), this.timestamp(), scope.tenant_id, scope.project_id, actionId);
          if (ownsTransaction) this.db.exec("COMMIT");
          return conflict;
        }
      } else if (intent.evidence.creation.parent_design_hash !== undefined) {
        reject("invalid_request", "creation.parent_design_hash");
      }
      const trustedScope = { tenant_id: scope.tenant_id, project_id: scope.project_id, brief_id: scope.brief_id,
        design_version_id: design.design_version_id };
      validateContextRecord(intent.context, trustedScope);
      validateDesignVersion(design, {
        trustedScope,
        brief_hash: intent.context.brief_hash,
        known_source_refs: intent.context.brief_snapshot.source_identity.map((source) => source.source_id),
        ...(design.parent_version_id !== null ? { design_version_ids: [design.parent_version_id] } : {}),
      });
      if (hashArtifactBytes(artifactBytes) !== design.artifact.content_hash) reject("integrity_error", "artifact.content_hash");
      const existingVersion = this.db.prepare(`SELECT design_hash FROM design_versions WHERE
        tenant_id=? AND project_id=? AND brief_id=? AND design_version_id=?`)
        .get(scope.tenant_id, scope.project_id, scope.brief_id, design.design_version_id);
      if (existingVersion) {
        if (existingVersion.design_hash !== design.design_hash) reject("conflict", "design_version.design_version_id");
        reject("conflict", "design_version.design_version_id");
      }
      let revision = null;
      if (selection.mode === "advance") {
        const current = this.db.prepare(`SELECT design_version_id,design_hash,revision FROM version_selections
          WHERE tenant_id=? AND project_id=? AND brief_id=?`)
          .get(scope.tenant_id, scope.project_id, scope.brief_id);
        const currentId = current?.design_version_id ?? null;
        const currentHash = current?.design_hash ?? null;
        const currentRevision = current?.revision ?? 0;
        if (currentId !== selection.expected_selected_design_version_id || currentHash !== selection.expected_selected_design_hash ||
          currentRevision !== selection.expected_revision) {
          const conflict = { status: "stale", code: "stale_version", current: current ? {
            design_version_id: current.design_version_id, design_hash: current.design_hash, revision: current.revision,
          } : { design_version_id: null, design_hash: null, revision: 0 } };
          this.db.prepare("UPDATE creation_actions SET state='conflict',result_json=?,updated_at=? WHERE tenant_id=? AND project_id=? AND action_id=?")
            .run(canonicalSerialize(conflict), this.timestamp(), scope.tenant_id, scope.project_id, actionId);
          if (ownsTransaction) this.db.exec("COMMIT");
          return conflict;
        }
        if (currentId !== null && getDesignHashAt(this.db, scope, currentId) !== currentHash) reject("integrity_error", "selection.design_hash");
        if (design.parent_version_id !== currentId ||
          (currentId === null ? parentDesignHash !== null : parentDesignHash !== currentHash)) {
          reject("stale_version", "design_version.parent_version_id");
        }
        revision = currentRevision + 1;
      } else if (design.parent_version_id === null || parentDesignHash === null) {
        reject("invalid_request", "selection.mode");
      }
      const createdAt = this.timestamp();
      const metadata = {
        design_version: design,
        artifact: { content_hash: design.artifact.content_hash, byte_length: artifactBytes.byteLength },
        creation: intent.evidence.creation,
        context_hash: canonicalHash(intent.context),
        evidence_hash: canonicalHash(intent.evidence),
      };
      this.db.prepare(`INSERT INTO design_versions
        (tenant_id,project_id,brief_id,design_version_id,parent_version_id,parent_design_hash,brief_hash,design_hash,
         artifact_id,content_hash,media_type,occurred_at,metadata_json,creation_job_id,action_id,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(scope.tenant_id, scope.project_id, scope.brief_id, design.design_version_id,
          design.parent_version_id, parentDesignHash, design.brief_hash, design.design_hash,
          design.artifact.artifact_id, design.artifact.content_hash, design.artifact.media_type,
          design.occurred_at, canonicalSerialize(metadata), intent.evidence.creation.job_id,
          intent.evidence.creation.action_id, createdAt);
      this.db.prepare(`INSERT INTO version_evidence
        (tenant_id,project_id,brief_id,design_version_id,context_json,context_hash,evidence_json,evidence_hash)
        VALUES(?,?,?,?,?,?,?,?)`)
        .run(scope.tenant_id, scope.project_id, scope.brief_id, design.design_version_id,
          canonicalSerialize(intent.context), canonicalHash(intent.context),
          canonicalSerialize(intent.evidence), canonicalHash(intent.evidence));
      if (selection.mode === "advance") {
        this.db.prepare(`INSERT INTO version_selections
          (tenant_id,project_id,brief_id,design_version_id,design_hash,revision,updated_at)
          VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(tenant_id,project_id,brief_id) DO UPDATE SET
            design_version_id=excluded.design_version_id,design_hash=excluded.design_hash,
            revision=excluded.revision,updated_at=excluded.updated_at`)
          .run(scope.tenant_id, scope.project_id, scope.brief_id, design.design_version_id,
            design.design_hash, revision, createdAt);
      }
      const result = {
        status: "saved",
        design_version: design,
        selection: selection.mode === "advance" ? {
          tenant_id: scope.tenant_id, project_id: scope.project_id, brief_id: scope.brief_id,
          design_version_id: design.design_version_id, design_hash: design.design_hash, revision,
        } : null,
        created_at: createdAt,
      };
      this.db.prepare("UPDATE creation_actions SET state='committed',result_json=?,updated_at=? WHERE tenant_id=? AND project_id=? AND action_id=?")
        .run(canonicalSerialize(result), createdAt, scope.tenant_id, scope.project_id, actionId);
      injectFault(faultInjector, "after_metadata_write");
      if (ownsTransaction) {
        this.db.exec("COMMIT");
        injectFault(faultInjector, "after_commit");
      }
      return deepFreeze({ ...result, replayed: false });
    } catch (error) {
      if (ownsTransaction) this.rollback();
      if (error instanceof VersionStoreError) throw error;
      reject("unavailable", "database", true);
    }
  }

  async recover() {
    this.assertOpen();
    const pending = this.db.prepare(`SELECT tenant_id,project_id,brief_id,action_id,job_id FROM creation_actions WHERE state='commit_intent'
      ORDER BY created_at,action_id`).all();
    const outcomes = [];
    for (const row of pending) {
      const scope = Object.freeze({ tenant_id: row.tenant_id, project_id: row.project_id, brief_id: row.brief_id });
      const action = this.db.prepare(`SELECT * FROM creation_actions
        WHERE tenant_id=? AND project_id=? AND action_id=?`)
        .get(row.tenant_id, row.project_id, row.action_id);
      let intent;
      try {
        intent = validateCommitIntentRow(action, scope);
      } catch {
        this.markRecoveryUnknown(row, "integrity_error", "creation.intent");
        outcomes.push({ status: "unknown", code: "integrity_error" });
        continue;
      }
      const job = this.db.prepare(`SELECT * FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
        .get(row.tenant_id, row.project_id, row.job_id);
      if (job && (job.actor_id !== intent.actor_id || job.action_id !== row.action_id ||
        job.request_hash !== intent.evidence.creation.request_hash || job.brief_id !== scope.brief_id ||
        !["generate", "edit"].includes(job.operation) || intent.job_result === null) || !job && intent.job_result !== null) {
        this.markRecoveryUnknown(row, "integrity_error", "creation.intent");
        outcomes.push({ status: "unknown", code: "integrity_error" });
        continue;
      }
      if (job) {
        if (job.status === "cancelled") {
          this.db.prepare(`UPDATE creation_actions SET state='cancelled',updated_at=?
            WHERE tenant_id=? AND project_id=? AND action_id=? AND state='commit_intent'`)
            .run(this.timestamp(), row.tenant_id, row.project_id, row.action_id);
          outcomes.push({ status: "cancelled" });
          continue;
        }
        if (job.status !== "running" || Date.parse(job.lease_expires_at) <= this.now()) {
          this.markRecoveryUnknown(row, "unavailable", "job.lease_expired");
          outcomes.push({ status: "unknown" });
          continue;
        }
        let transaction;
        this.db.exec("BEGIN IMMEDIATE");
        try {
          const freshJob = this.db.prepare(`SELECT * FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
            .get(row.tenant_id, row.project_id, row.job_id);
          if (!freshJob || freshJob.status !== "running" || Date.parse(freshJob.lease_expires_at) <= this.now() ||
            freshJob.actor_id !== intent.actor_id || freshJob.action_id !== row.action_id ||
            freshJob.request_hash !== intent.evidence.creation.request_hash || freshJob.brief_id !== scope.brief_id) {
            this.db.exec("ROLLBACK");
            this.markRecoveryUnknown(row, "unavailable", "job.lease_expired");
            outcomes.push({ status: "unknown" });
            continue;
          }
          const currentAction = this.db.prepare(`SELECT * FROM creation_actions
            WHERE tenant_id=? AND project_id=? AND action_id=?`)
            .get(row.tenant_id, row.project_id, row.action_id);
          const currentIntent = validateCommitIntentRow(currentAction, scope);
          transaction = this.createPublicationTransaction({
            scope, actor_id: freshJob.actor_id, job_id: freshJob.job_id,
            lease_token: "recovery:" + freshJob.job_id, action_id: freshJob.action_id,
            request_hash: freshJob.request_hash, result: currentIntent.job_result,
            publication_fence: { brief_id: scope.brief_id, brief_hash: currentIntent.context.brief_hash },
          });
          const completed = await this.finalizeAction(scope, row.action_id, undefined, transaction);
          if (completed.status === "saved" && currentIntent.job_result !== null) {
            const committedBriefIsCurrent = publicationFenceCurrent(this, scope, {
              brief_id: scope.brief_id, brief_hash: currentIntent.context.brief_hash,
            });
            const finalJob = this.db.prepare(`SELECT * FROM creative_jobs
              WHERE tenant_id=? AND project_id=? AND job_id=?`)
              .get(row.tenant_id, row.project_id, row.job_id);
            const updatedAt = this.timestamp();
            const finalNow = this.now();
            const activeLease = finalJob && finalJob.status === "running" &&
              finalJob.actor_id === freshJob.actor_id && finalJob.action_id === freshJob.action_id &&
              finalJob.request_hash === freshJob.request_hash && finalJob.lease_hash === freshJob.lease_hash &&
              Date.parse(finalJob.lease_expires_at) > Math.max(finalNow, Date.parse(updatedAt));
            let selectionIsCurrent = true;
            if (currentIntent.selection.mode === "advance") {
              const selection = this.db.prepare(`SELECT design_version_id,design_hash,revision FROM version_selections
                WHERE tenant_id=? AND project_id=? AND brief_id=?`)
                .get(scope.tenant_id, scope.project_id, scope.brief_id);
              selectionIsCurrent = selection?.design_version_id === completed.selection?.design_version_id &&
                selection?.design_hash === completed.selection?.design_hash &&
                selection?.revision === completed.selection?.revision;
            }
            if (!activeLease || !committedBriefIsCurrent || !selectionIsCurrent) {
              this.db.exec("ROLLBACK");
              this.markRecoveryUnknown(row, activeLease ? "stale_version" : "unavailable",
                activeLease ? "creative_context" : "job.lease_expired");
              outcomes.push({ status: "unknown" });
              continue;
            }
            const completedJob = this.db.prepare(`UPDATE creative_jobs SET status='completed',result_json=?,error_json=NULL,updated_at=?
              WHERE tenant_id=? AND project_id=? AND job_id=? AND status='running' AND actor_id=? AND action_id=?
                AND request_hash=? AND lease_hash=? AND lease_expires_at>?`)
              .run(canonicalSerialize(currentIntent.job_result), updatedAt, row.tenant_id, row.project_id, row.job_id,
                finalJob.actor_id, finalJob.action_id, finalJob.request_hash, finalJob.lease_hash,
                new Date(finalNow).toISOString()).changes;
            if (completedJob !== 1 || Date.parse(finalJob.lease_expires_at) <= this.now()) {
              this.db.exec("ROLLBACK");
              this.markRecoveryUnknown(row, "unavailable", "job.lease_expired");
              outcomes.push({ status: "unknown" });
              continue;
            }
            this.db.exec("COMMIT");
            outcomes.push(completed);
          } else {
            this.db.prepare(`UPDATE creation_actions SET state='unknown',updated_at=?
              WHERE tenant_id=? AND project_id=? AND action_id=? AND state='commit_intent'`)
              .run(this.timestamp(), row.tenant_id, row.project_id, row.action_id);
            this.db.prepare(`UPDATE creative_jobs SET status='failed',result_json=NULL,error_json=?,updated_at=?
              WHERE tenant_id=? AND project_id=? AND job_id=? AND status='running'`)
              .run(canonicalSerialize({ code: "stale_version", module: "creative-engine.api", operation: freshJob.operation,
                field: "creative_context", retryable: false, message: "The requested design version is no longer current.",
                diagnostic_ref: "creative-engine:stale-context" }), this.timestamp(), row.tenant_id, row.project_id, row.job_id);
            this.db.exec("COMMIT");
            outcomes.push(completed);
          }
        } catch (error) {
          this.rollback();
          const code = error instanceof VersionStoreError ? error.code : "unavailable";
          this.markRecoveryUnknown(row, code === "integrity_error" ? "integrity_error"
            : code === "stale_version" ? "stale_version" : "unavailable",
          code === "integrity_error" ? "creation.intent" : code === "stale_version" ? "creative_context" : "job.lease_expired");
          outcomes.push({ status: "unknown", code });
        } finally {
          this.closePublicationTransaction(transaction);
        }
        continue;
      }
      try {
        outcomes.push(await this.finalizeAction(scope, row.action_id));
      } catch (error) {
        const code = error instanceof VersionStoreError ? error.code : "unavailable";
        this.markRecoveryUnknown(row, code === "integrity_error" ? "integrity_error"
          : code === "stale_version" ? "stale_version" : "unavailable",
        code === "integrity_error" ? "creation.intent" : code === "stale_version" ? "creative_context" : "job.lease_expired");
        outcomes.push({ status: "unknown", code });
      }
    }
    const expiredJobs = this.db.prepare(`SELECT tenant_id,project_id,job_id,operation FROM creative_jobs
      WHERE status='running' AND lease_expires_at<=? ORDER BY created_at,job_id`).all(new Date(this.now()).toISOString());
    for (const job of expiredJobs) {
      const error = { code: "unavailable", module: "creative-engine.api", operation: job.operation,
        field: "job.lease_expired", retryable: true,
        message: "A required service is unavailable; no successful result was produced.",
        diagnostic_ref: "creative-engine:lease-expired" };
      this.db.prepare(`UPDATE creative_jobs SET status='failed',error_json=?,updated_at=?
        WHERE tenant_id=? AND project_id=? AND job_id=? AND status='running'`)
        .run(canonicalSerialize(error), this.timestamp(), job.tenant_id, job.project_id, job.job_id);
      outcomes.push({ status: "unknown" });
    }
    return deepFreeze({ examined: pending.length + expiredJobs.length,
      committed: outcomes.filter((item) => item.status === "saved").length,
      conflicts: outcomes.filter((item) => item.status === "stale").length,
      unknown: outcomes.filter((item) => item.status === "unknown").length,
    });
  }

  getDesignVersion({ scope: inputScope, brief_id, design_version_id }) {
    this.assertOpen();
    const scope = validScope(inputScope, brief_id);
    reference(design_version_id, "design_version_id");
    const row = this.db.prepare(`SELECT * FROM design_versions WHERE tenant_id=? AND project_id=? AND brief_id=? AND design_version_id=?`)
      .get(scope.tenant_id, scope.project_id, scope.brief_id, design_version_id);
    if (!row || !rowScope(row, scope)) return null;
    const metadata = snapshotJson(JSON.parse(row.metadata_json), "integrity_error", "metadata");
    const evidence = this.readEvidence(scope, design_version_id);
    if (!evidence || canonicalHash(evidence.context) !== evidence.context_hash || canonicalHash(evidence.evidence) !== evidence.evidence_hash ||
      metadata.context_hash !== evidence.context_hash || metadata.evidence_hash !== evidence.evidence_hash) reject("integrity_error", "version_evidence");
    validateContextRecord(evidence.context, { ...scope, design_version_id }, "version_evidence.context");
    const design = validateDesignVersion(metadata.design_version, {
      trustedScope: { ...scope, design_version_id },
      brief_hash: evidence.context.brief_hash,
      known_source_refs: evidence.context.brief_snapshot.source_identity.map((source) => source.source_id),
      ...(row.parent_version_id !== null ? { design_version_ids: [row.parent_version_id] } : {}),
    });
    if (design.design_hash !== row.design_hash || design.artifact.content_hash !== row.content_hash ||
      design.artifact.artifact_id !== row.artifact_id || row.brief_hash !== design.brief_hash) reject("integrity_error", "design_version");
    if (design.occurred_at !== row.occurred_at) reject("integrity_error", "design_version.occurred_at");
    if (design.parent_version_id !== row.parent_version_id) reject("integrity_error", "design_version.parent_version_id");
    if (row.parent_version_id === null) {
      if (row.parent_design_hash !== null) reject("integrity_error", "design_version.parent_design_hash");
    } else {
      const parentHash = getDesignHashAt(this.db, scope, row.parent_version_id);
      if (!parentHash || parentHash !== row.parent_design_hash) reject("integrity_error", "design_version.parent_design_hash");
    }
    const storedBytes = readStoredObjectSync(this.objectRoot, design.artifact.content_hash);
    if (!storedBytes || storedBytes.byteLength !== metadata.artifact?.byte_length ||
      hashArtifactBytes(storedBytes) !== design.artifact.content_hash) reject("integrity_error", "artifact.content_hash");
    return freezeReturned(design);
  }

  readEvidence(scope, designVersionId) {
    const row = this.db.prepare(`SELECT context_json,context_hash,evidence_json,evidence_hash FROM version_evidence
      WHERE tenant_id=? AND project_id=? AND brief_id=? AND design_version_id=?`)
      .get(scope.tenant_id, scope.project_id, scope.brief_id, designVersionId);
    if (!row) return null;
    return {
      context: snapshotJson(JSON.parse(row.context_json), "integrity_error", "context"), context_hash: row.context_hash,
      evidence: snapshotJson(JSON.parse(row.evidence_json), "integrity_error", "evidence"), evidence_hash: row.evidence_hash,
    };
  }

  async getArtifactBytes({ scope: inputScope, brief_id, design_version_id }) {
    this.assertOpen();
    const scope = validScope(inputScope, brief_id);
    const design = this.getDesignVersion({ scope, brief_id: scope.brief_id, design_version_id });
    if (!design) return null;
    try { return await readContentAddressedObject(this.objectRoot, design.artifact.content_hash); }
    catch { reject("integrity_error", "artifact.content_hash"); }
  }

  getSelection({ scope: inputScope, brief_id }) {
    this.assertOpen();
    const scope = validScope(inputScope, brief_id);
    const row = this.db.prepare(`SELECT design_version_id,design_hash,revision FROM version_selections
      WHERE tenant_id=? AND project_id=? AND brief_id=?`)
      .get(scope.tenant_id, scope.project_id, scope.brief_id);
    if (!row) return null;
    if (!Number.isSafeInteger(row.revision) || row.revision < 1) reject("integrity_error", "selection.revision");
    const design = this.getDesignVersion({ scope, brief_id: scope.brief_id, design_version_id: row.design_version_id });
    if (!design || design.design_hash !== row.design_hash) reject("integrity_error", "selection.design_hash");
    return freezeReturned({ tenant_id: scope.tenant_id, project_id: scope.project_id, brief_id: scope.brief_id,
      design_version_id: row.design_version_id, design_hash: row.design_hash, revision: row.revision });
  }

  getCurrentDesignVersion({ scope: inputScope, brief_id }) {
    const selection = this.getSelection({ scope: inputScope, brief_id });
    if (!selection) return null;
    return this.getDesignVersion({ scope: inputScope, brief_id, design_version_id: selection.design_version_id });
  }

  listDesignVersions({ scope: inputScope, brief_id, limit = 20, after = null }) {
    this.assertOpen();
    const scope = validScope(inputScope, brief_id);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 101) reject("invalid_request", "limit");
    if (after !== null && (!isRecord(after) || typeof after.occurred_at !== "string" || !Number.isFinite(Date.parse(after.occurred_at)))) {
      reject("invalid_request", "after");
    }
    const rows = after === null
      ? this.db.prepare(`SELECT design_version_id FROM design_versions WHERE tenant_id=? AND project_id=? AND brief_id=?
          ORDER BY occurred_at DESC,design_version_id ASC LIMIT ?`).all(scope.tenant_id, scope.project_id, scope.brief_id, limit + 1)
      : this.db.prepare(`SELECT design_version_id FROM design_versions WHERE tenant_id=? AND project_id=? AND brief_id=?
          AND (occurred_at<? OR (occurred_at=? AND design_version_id>?))
          ORDER BY occurred_at DESC,design_version_id ASC LIMIT ?`).all(scope.tenant_id, scope.project_id, scope.brief_id,
        after.occurred_at, after.occurred_at, reference(after.design_version_id, "after.design_version_id"), limit + 1);
    const selected = rows.slice(0, limit);
    const items = selected.map((row) => this.getDesignVersion({ scope, brief_id: scope.brief_id, design_version_id: row.design_version_id }));
    return freezeReturned({ items, has_more: rows.length > limit });
  }

  compareDesignVersions({ scope, brief_id, left_design_version_id, right_design_version_id }) {
    const left = this.getDesignVersion({ scope, brief_id, design_version_id: left_design_version_id });
    const right = this.getDesignVersion({ scope, brief_id, design_version_id: right_design_version_id });
    if (!left || !right) reject("not_found", "design_version_id");
    return freezeReturned({ left, right, changed_fields: [
      ...(left.artifact.content_hash !== right.artifact.content_hash ? ["artifact.content_hash"] : []),
      ...(left.parent_version_id !== right.parent_version_id ? ["parent_version_id"] : []),
      ...(left.brief_hash !== right.brief_hash ? ["brief_hash"] : []),
    ] });
  }

  async selectDesignVersion(input, transaction) {
    this.assertOpen();
    if (!isRecord(input)) reject("invalid_request", "selection");
    const scope = validScope(input.scope, input.brief_id);
    const publication = this.publicationTransactionData(transaction);
    const ownsTransaction = transaction === undefined;
    if (!ownsTransaction && (!publication || publication.scope.tenant_id !== scope.tenant_id ||
      publication.scope.project_id !== scope.project_id || publication.scope.brief_id !== scope.brief_id)) {
      reject("scope_denied", "publication_transaction");
    }
    const target = this.getDesignVersion({ scope, brief_id: scope.brief_id, design_version_id: input.design_version_id });
    if (!target) reject("not_found", "design_version_id");
    if (target.design_hash !== input.expected_target_design_hash || target.brief_hash !== input.expected_brief_hash) reject("stale_version", "design_hash");
    // Restore is a selection move to an exact retained artifact, never a new version.
    // The paired adapter supplies its caller-owned transaction. In that path,
    // keep validation local and synchronous rather than holding SQLite's write
    // lock across an async filesystem operation.
    const retainedBytes = transaction === undefined
      ? await this.getArtifactBytes({ scope, brief_id: scope.brief_id, design_version_id: target.design_version_id })
      : readStoredObjectSync(this.objectRoot, target.artifact.content_hash);
    if (!retainedBytes || hashArtifactBytes(retainedBytes) !== target.artifact.content_hash) reject("integrity_error", "artifact.content_hash");
    if (!Number.isSafeInteger(input.expected_selection_revision) || input.expected_selection_revision < 0) reject("invalid_request", "expected_selection_revision");
    if (ownsTransaction) this.db.exec("BEGIN IMMEDIATE");
    try {
      const currentBrief = this.getBrief({ scope, brief_id: scope.brief_id });
      if (!currentBrief || canonicalHash(currentBrief) !== input.expected_brief_hash) {
        if (ownsTransaction) this.db.exec("ROLLBACK");
        return Object.freeze({ status: "stale" });
      }
      const current = this.db.prepare(`SELECT design_version_id,design_hash,revision FROM version_selections
        WHERE tenant_id=? AND project_id=? AND brief_id=?`)
        .get(scope.tenant_id, scope.project_id, scope.brief_id);
      const selectedId = current?.design_version_id ?? null;
      const selectedHash = current?.design_hash ?? null;
      if (selectedId !== input.expected_selected_design_version_id || selectedHash !== input.expected_selected_design_hash ||
        (current?.revision ?? 0) !== input.expected_selection_revision) {
        if (ownsTransaction) this.db.exec("ROLLBACK");
        return Object.freeze({ status: "stale" });
      }
      const nextRevision = (current?.revision ?? 0) + 1;
      const now = this.timestamp();
      this.db.prepare(`INSERT INTO version_selections
        (tenant_id,project_id,brief_id,design_version_id,design_hash,revision,updated_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(tenant_id,project_id,brief_id) DO UPDATE SET
        design_version_id=excluded.design_version_id,design_hash=excluded.design_hash,
        revision=excluded.revision,updated_at=excluded.updated_at`)
        .run(scope.tenant_id, scope.project_id, scope.brief_id, target.design_version_id, target.design_hash, nextRevision, now);
      if (ownsTransaction) this.db.exec("COMMIT");
      return freezeReturned({ status: "selected", selection: {
        tenant_id: scope.tenant_id, project_id: scope.project_id, brief_id: scope.brief_id,
        design_version_id: target.design_version_id, design_hash: target.design_hash, revision: nextRevision,
      } });
    } catch (error) {
      if (ownsTransaction) this.rollback();
      if (error instanceof VersionStoreError) throw error;
      reject("unavailable", "selection", true);
    }
  }

}
