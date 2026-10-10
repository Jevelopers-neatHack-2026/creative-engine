import { createHash, randomUUID } from "node:crypto";
import {
  MeteringContractError,
  validateMeteredAttempt,
  validateUsageObservation,
} from "../contracts/metering.mjs";
import { canonicalHash, canonicalSerialize } from "../contracts/validation.mjs";
import { CREATIVE_TELEMETRY_SCHEMA, TelemetryBoundaryError } from "./evidence.mjs";
import { assertSafePublicIdentifier, projectPublicTelemetry } from "./privacy.mjs";

const OBSERVATION_DEFER_REASONS = new Set([
  "trusted_scope_or_record_unavailable",
  "metering_observation_unconfirmed",
  "metering_acknowledgement_mismatch",
  "outbox_acknowledgement_unconfirmed",
]);
const EVIDENCE_DEFER_REASONS = new Set([
  "sink_unavailable",
  "acknowledgement_unknown",
  "sink_acknowledgement_invalid",
]);
const EVENT_TYPES = new Set(["attempt_intent", "transport_intent", "attempt_outcome"]);
const OPERATION_KINDS = new Set([
  "image_generation", "image_edit", "responses_orchestration", "planning",
  "vision_observation", "jev_decision", "baseline_evaluation",
]);
const PROVIDER_MODES = new Set(["mock", "recorded", "sandbox", "live", "unknown"]);
const COMMERCE_MODES = new Set(["simulated", "live", "unknown"]);
const ENVIRONMENTS = new Set(["development", "test", "production"]);
const BILLING_MODES = new Set(["live", "sandbox", "simulated"]);
const MAX_BATCH = 32;
const MAX_LEASE_MS = 60 * 60 * 1000;
const MAX_PAYLOAD_BYTES = 128 * 1024;
const OBSERVATION_TABLE = "creative_telemetry_observations_v1";
const EVIDENCE_TABLE = "creative_telemetry_evidence_outbox_v1";
let savepointSequence = 0;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function freezeTree(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

function boundary(code) {
  return new TelemetryBoundaryError(code);
}

function safeIdentifier(value, code) {
  try {
    return assertSafePublicIdentifier(value, { maxLength: 256 });
  } catch {
    throw boundary(code);
  }
}

function nowMilliseconds(clock) {
  let value;
  try { value = clock(); } catch { throw boundary("telemetry_clock_unavailable"); }
  const timestamp = value instanceof Date ? value.getTime() : value;
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw boundary("telemetry_clock_invalid");
  return timestamp;
}

function makeSnapshot(value, code) {
  try {
    const projected = projectPublicTelemetry(value, { maxDepth: 24, maxNodes: 8192, maxBytes: MAX_PAYLOAD_BYTES });
    if (projected.redactions.length !== 0) throw boundary(code);
    const payloadJson = canonicalSerialize(projected.value);
    if (Buffer.byteLength(payloadJson, "utf8") > MAX_PAYLOAD_BYTES) throw boundary(code);
    const payloadValue = freezeTree(JSON.parse(payloadJson));
    return Object.freeze({ payloadJson, payloadHash: canonicalHash(payloadValue), payloadValue });
  } catch (error) {
    if (error instanceof TelemetryBoundaryError) throw error;
    throw boundary(code);
  }
}

function hashClaimToken(token) {
  const safe = safeIdentifier(token, "invalid_claim_token");
  return createHash("sha256").update(safe, "utf8").digest("hex");
}

function withTransaction(database, operation) {
  const nested = database.isTransaction === true;
  const savepoint = nested
    ? `creative_telemetry_sp_${++savepointSequence}_${randomUUID().replaceAll("-", "")}`
    : undefined;
  try {
    database.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
    const result = operation();
    database.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
    return result;
  } catch (error) {
    try {
      if (nested) {
        database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        database.exec(`RELEASE SAVEPOINT ${savepoint}`);
      } else if (database.isTransaction === true) {
        database.exec("ROLLBACK");
      }
    } catch {
      // Keep the public error fixed even if rollback also fails.
    }
    if (error instanceof TelemetryBoundaryError) throw error;
    throw boundary("telemetry_storage_unavailable");
  }
}

function initializeSchema(database) {
  withTransaction(database, () => database.exec(`
    CREATE TABLE IF NOT EXISTS ${OBSERVATION_TABLE} (
      record_ref TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      budget_scope_id TEXT NOT NULL,
      logical_operation_id TEXT NOT NULL,
      billable_attempt_id TEXT NOT NULL,
      source_observation_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256) = 64),
      status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'delivered')),
      claim_token_sha256 TEXT,
      lease_expires_at INTEGER,
      claim_count INTEGER NOT NULL DEFAULT 0 CHECK(claim_count >= 0),
      created_at INTEGER NOT NULL,
      delivered_at INTEGER,
      metering_ack_status TEXT CHECK(metering_ack_status IN ('accepted', 'duplicate')),
      last_defer_reason TEXT CHECK(last_defer_reason IN (
        'trusted_scope_or_record_unavailable', 'metering_observation_unconfirmed',
        'metering_acknowledgement_mismatch', 'outbox_acknowledgement_unconfirmed'
      )),
      UNIQUE(tenant_id, project_id, budget_scope_id, source_observation_id),
      CHECK((status = 'claimed' AND claim_token_sha256 IS NOT NULL AND lease_expires_at IS NOT NULL) OR
            (status <> 'claimed' AND claim_token_sha256 IS NULL AND lease_expires_at IS NULL)),
      CHECK((status = 'delivered' AND delivered_at IS NOT NULL AND metering_ack_status IS NOT NULL) OR
            (status <> 'delivered' AND delivered_at IS NULL AND metering_ack_status IS NULL))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS creative_telemetry_observations_pending_v1
      ON ${OBSERVATION_TABLE}(status, created_at, record_ref);
    CREATE TABLE IF NOT EXISTS ${EVIDENCE_TABLE} (
      event_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      budget_scope_id TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type IN ('attempt_intent', 'transport_intent', 'attempt_outcome')),
      payload_json TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256) = 64),
      status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'delivered')),
      claim_token_sha256 TEXT,
      lease_expires_at INTEGER,
      claim_count INTEGER NOT NULL DEFAULT 0 CHECK(claim_count >= 0),
      created_at INTEGER NOT NULL,
      delivered_at INTEGER,
      last_defer_reason TEXT CHECK(last_defer_reason IN (
        'sink_unavailable', 'acknowledgement_unknown', 'sink_acknowledgement_invalid'
      )),
      CHECK((status = 'claimed' AND claim_token_sha256 IS NOT NULL AND lease_expires_at IS NOT NULL) OR
            (status <> 'claimed' AND claim_token_sha256 IS NULL AND lease_expires_at IS NULL)),
      CHECK((status = 'delivered' AND delivered_at IS NOT NULL) OR
            (status <> 'delivered' AND delivered_at IS NULL))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS creative_telemetry_evidence_pending_v1
      ON ${EVIDENCE_TABLE}(status, created_at, event_id);
  `));
}

function validateDatabase(database) {
  if (database === null || typeof database !== "object" || Array.isArray(database) ||
    typeof database.exec !== "function" || typeof database.prepare !== "function" ||
    typeof database.isOpen !== "boolean" || database.isOpen !== true || typeof database.isTransaction !== "boolean") {
    throw boundary("telemetry_sqlite_connection_unavailable");
  }
}

function assertOutermostCommitBoundary(database) {
  if (database.isTransaction === true) throw boundary("telemetry_outer_transaction_active");
}

function normalizeEvent(event) {
  if (!isRecord(event)) throw boundary("invalid_evidence_event");
  const snapshot = makeSnapshot(event, "unsafe_evidence_event");
  const value = snapshot.payloadValue;
  if (value.schema_version !== CREATIVE_TELEMETRY_SCHEMA || !EVENT_TYPES.has(value.event_type) ||
    value.producer !== "creative-engine.telemetry" ||
    !ENVIRONMENTS.has(value.environment) || !BILLING_MODES.has(value.billing_mode) ||
    !PROVIDER_MODES.has(value.provider_execution_mode) || !COMMERCE_MODES.has(value.commerce_mode) ||
    !OPERATION_KINDS.has(value.operation_kind) || typeof value.occurred_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value.occurred_at) ||
    !Number.isFinite(Date.parse(value.occurred_at))) {
    throw boundary("invalid_evidence_event");
  }
  safeIdentifier(value.event_id, "invalid_evidence_identity");
  safeIdentifier(value.tenant_id, "invalid_evidence_identity");
  safeIdentifier(value.project_id, "invalid_evidence_identity");
  safeIdentifier(value.budget_scope_id, "invalid_evidence_identity");
  safeIdentifier(value.logical_operation_id, "invalid_evidence_identity");
  safeIdentifier(value.billable_attempt_id, "invalid_evidence_identity");
  for (const field of ["reservation_ref", "transport_attempt_id", "provider_request_id", "source_observation_id"]) {
    if (value[field] !== undefined) safeIdentifier(value[field], "invalid_evidence_identity");
  }
  if (!isRecord(value.provider)) throw boundary("invalid_evidence_event");
  safeIdentifier(value.provider.name, "invalid_evidence_identity");
  safeIdentifier(value.provider.model, "invalid_evidence_identity");
  if (value.event_type === "transport_intent" && (!value.reservation_ref || !value.transport_attempt_id)) {
    throw boundary("invalid_evidence_event");
  }
  if (value.provider_outcome !== undefined && !["succeeded", "failed", "partial", "unknown"].includes(value.provider_outcome)) {
    throw boundary("invalid_evidence_event");
  }
  if (value.usage_completeness !== undefined && !["complete", "partial", "unknown"].includes(value.usage_completeness)) {
    throw boundary("invalid_evidence_event");
  }
  if (value.missing_fields !== undefined && (!Array.isArray(value.missing_fields) || value.missing_fields.length > 32 ||
    value.missing_fields.some((field) => typeof field !== "string" || !/^[A-Za-z0-9_.-]{1,120}$/.test(field)))) {
    throw boundary("invalid_evidence_event");
  }
  return snapshot;
}

function normalizeObservation({ attempt: rawAttempt, trustedScope, observation: rawObservation }) {
  let attempt;
  let observation;
  try {
    attempt = validateMeteredAttempt(rawAttempt, trustedScope);
    observation = validateUsageObservation(rawObservation, attempt);
  } catch (error) {
    if (error instanceof MeteringContractError) throw boundary("invalid_observation_binding");
    throw boundary("invalid_observation_binding");
  }
  const snapshot = makeSnapshot({ attempt, observation }, "unsafe_usage_observation");
  const value = snapshot.payloadValue;
  return Object.freeze({
    ...snapshot,
    tenantId: value.attempt.tenant_id,
    projectId: value.attempt.project_id,
    budgetScopeId: value.attempt.budget_scope_id,
    logicalOperationId: value.attempt.logical_operation_id,
    billableAttemptId: value.attempt.billable_attempt_id,
    sourceObservationId: value.observation.source_observation_id,
  });
}

function decodePayload(row, { kind, idField, hashField }) {
  let value;
  try {
    value = JSON.parse(row.payload_json);
    const snapshot = makeSnapshot(value, `corrupt_${kind}_record`);
    const storedId = kind === "observation"
      ? value?.observation?.[idField]
      : value?.[idField];
    if (snapshot.payloadHash.slice("sha256:".length) !== row[hashField] ||
      snapshot.payloadJson !== row.payload_json || storedId !== row[idField]) {
      throw boundary(`corrupt_${kind}_record`);
    }
    return snapshot.payloadValue;
  } catch (error) {
    if (error instanceof TelemetryBoundaryError) throw error;
    throw boundary(`corrupt_${kind}_record`);
  }
}

function nextSafeId(idFactory, kind) {
  let value;
  try { value = idFactory(kind); } catch { throw boundary("telemetry_identity_unavailable"); }
  return safeIdentifier(value, "telemetry_identity_invalid");
}

function selectClaimable(database, table, limit, now, leaseUntil, idFactory, kind, decode) {
  const expire = database.prepare(`
    UPDATE ${table}
    SET status = 'pending', claim_token_sha256 = NULL, lease_expires_at = NULL
    WHERE status = 'claimed' AND lease_expires_at <= ?
  `);
  expire.run(now);
  const rows = database.prepare(`
    SELECT * FROM ${table} WHERE status = 'pending'
    ORDER BY created_at ASC, rowid ASC LIMIT ?
  `).all(limit);
  const keyField = table === EVIDENCE_TABLE ? "event_id" : "record_ref";
  const claimUpdate = database.prepare(`
    UPDATE ${table}
    SET status = 'claimed', claim_token_sha256 = ?, lease_expires_at = ?, claim_count = ?
    WHERE ${keyField} = ? AND status = 'pending' AND claim_count = ?
  `);
  const tokenHashes = new Set();
  return rows.map((row) => {
    const generation = row.claim_count + 1;
    if (!Number.isSafeInteger(row.claim_count) || row.claim_count < 0 || !Number.isSafeInteger(generation)) {
      throw boundary("claim_generation_invalid");
    }
    // claim_count is durable per-record fencing state. A repeated host
    // idFactory value therefore cannot recreate a token from an older lease.
    const hostIdentity = nextSafeId(idFactory, `${kind}_claim`);
    const tokenSeed = JSON.stringify([kind, row[keyField], generation, hostIdentity]);
    const token = `claim:${createHash("sha256").update(tokenSeed, "utf8").digest("hex")}`;
    const tokenHash = hashClaimToken(token);
    if (tokenHashes.has(tokenHash)) throw boundary("duplicate_claim_identity");
    tokenHashes.add(tokenHash);
    const changed = claimUpdate.run(tokenHash, leaseUntil, generation, row[keyField], row.claim_count).changes;
    if (changed !== 1) throw boundary("claim_conflict");
    const payload = decode(row);
    return Object.freeze({ ...payload, record_ref: row[keyField], claim_token: token });
  });
}

function claimLeaseArgs(limit, leaseMs, now) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH ||
    !Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > MAX_LEASE_MS ||
    !Number.isSafeInteger(now + leaseMs)) {
    throw boundary("invalid_telemetry_claim_request");
  }
  return { leaseUntil: now + leaseMs };
}

function makeClaimTokenMatcher(database, table, keyField, recordRef, claimToken, now) {
  const row = database.prepare(`SELECT * FROM ${table} WHERE ${keyField} = ?`).get(recordRef);
  if (!row || row.status !== "claimed" || row.lease_expires_at <= now) return undefined;
  const expectedHash = hashClaimToken(claimToken);
  if (row.claim_token_sha256 !== expectedHash) return undefined;
  return row;
}

/**
 * A domain-specific durable queue for sanitized CE-11 records only. The caller
 * owns the supplied Node DatabaseSync connection; this adapter never opens,
 * closes, or owns a database and contains no reservation/valuation authority.
 */
export function createSqliteTelemetryOutbox({
  database,
  idFactory = () => randomUUID(),
  clock = () => Date.now(),
  claimLeaseMs = 30_000,
}) {
  validateDatabase(database);
  if (typeof idFactory !== "function" || typeof clock !== "function" ||
    !Number.isSafeInteger(claimLeaseMs) || claimLeaseMs < 1 || claimLeaseMs > MAX_LEASE_MS) {
    throw boundary("invalid_telemetry_store_options");
  }
  initializeSchema(database);

  return Object.freeze({
    /** Persist an event before the caller treats the local evidence append as durable. */
    async append(rawEvent) {
      assertOutermostCommitBoundary(database);
      const event = normalizeEvent(rawEvent).payloadValue;
      const now = nowMilliseconds(clock);
      return withTransaction(database, () => {
        const existing = database.prepare(`SELECT payload_sha256, tenant_id, project_id, budget_scope_id FROM ${EVIDENCE_TABLE} WHERE event_id = ?`)
          .get(event.event_id);
        const payloadHash = canonicalHash(event);
        if (existing) {
          if (existing.payload_sha256 !== payloadHash.slice("sha256:".length) || existing.tenant_id !== event.tenant_id ||
            existing.project_id !== event.project_id || existing.budget_scope_id !== event.budget_scope_id) {
            throw boundary("evidence_identity_conflict");
          }
          return Object.freeze({ status: "duplicate", event_id: event.event_id });
        }
        const payloadJson = canonicalSerialize(event);
        database.prepare(`INSERT INTO ${EVIDENCE_TABLE}
          (event_id, tenant_id, project_id, budget_scope_id, event_type, payload_json, payload_sha256, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
          .run(event.event_id, event.tenant_id, event.project_id, event.budget_scope_id,
            event.event_type, payloadJson, payloadHash.slice("sha256:".length), now);
        return Object.freeze({ status: "recorded", event_id: event.event_id });
      });
    },

    /** Retry a sanitized outcome append through a direct durable queue path. */
    async stagePendingEvidence(rawEvent) {
      assertOutermostCommitBoundary(database);
      const event = normalizeEvent(rawEvent).payloadValue;
      const now = nowMilliseconds(clock);
      return withTransaction(database, () => {
        const existing = database.prepare(`SELECT payload_sha256, tenant_id, project_id, budget_scope_id FROM ${EVIDENCE_TABLE} WHERE event_id = ?`)
          .get(event.event_id);
        const payloadHash = canonicalHash(event);
        if (existing) {
          if (existing.payload_sha256 !== payloadHash.slice("sha256:".length) || existing.tenant_id !== event.tenant_id ||
            existing.project_id !== event.project_id || existing.budget_scope_id !== event.budget_scope_id) {
            throw boundary("evidence_identity_conflict");
          }
          return Object.freeze({ status: "duplicate", event_id: event.event_id });
        }
        const payloadJson = canonicalSerialize(event);
        database.prepare(`INSERT INTO ${EVIDENCE_TABLE}
          (event_id, tenant_id, project_id, budget_scope_id, event_type, payload_json, payload_sha256, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
          .run(event.event_id, event.tenant_id, event.project_id, event.budget_scope_id,
            event.event_type, payloadJson, payloadHash.slice("sha256:".length), now);
        return Object.freeze({ status: "recorded", event_id: event.event_id });
      });
    },

    /** Persist one exact C03 pair; same source identity and payload is idempotent. */
    async enqueueUsageObservation(input) {
      assertOutermostCommitBoundary(database);
      const record = normalizeObservation(input);
      const now = nowMilliseconds(clock);
      return withTransaction(database, () => {
        const existing = database.prepare(`SELECT record_ref, payload_sha256, billable_attempt_id
          FROM ${OBSERVATION_TABLE}
          WHERE tenant_id = ? AND project_id = ? AND budget_scope_id = ? AND source_observation_id = ?`)
          .get(record.tenantId, record.projectId, record.budgetScopeId, record.sourceObservationId);
        if (existing) {
          if (existing.payload_sha256 !== record.payloadHash.slice("sha256:".length) ||
            existing.billable_attempt_id !== record.billableAttemptId) {
            throw boundary("observation_identity_conflict");
          }
          return Object.freeze({
            status: "duplicate",
            record_ref: existing.record_ref,
            source_observation_id: record.sourceObservationId,
            payload_hash: record.payloadHash,
          });
        }
        const recordRef = nextSafeId(idFactory, "observation_record");
        database.prepare(`INSERT INTO ${OBSERVATION_TABLE}
          (record_ref, tenant_id, project_id, budget_scope_id, logical_operation_id, billable_attempt_id,
           source_observation_id, payload_json, payload_sha256, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
          .run(recordRef, record.tenantId, record.projectId, record.budgetScopeId, record.logicalOperationId,
            record.billableAttemptId, record.sourceObservationId, record.payloadJson,
            record.payloadHash.slice("sha256:".length), now);
        return Object.freeze({
          status: "recorded",
          record_ref: recordRef,
          source_observation_id: record.sourceObservationId,
          payload_hash: record.payloadHash,
        });
      });
    },

    /** Record a synchronous C03 acceptance against its already durable row. */
    async acknowledgeEnqueuedObservation({ record_ref, source_observation_id, effective_billable_attempt_id, authority_status }) {
      assertOutermostCommitBoundary(database);
      const recordRef = safeIdentifier(record_ref, "invalid_observation_reference");
      const observationId = safeIdentifier(source_observation_id, "invalid_observation_identity");
      const billableAttemptId = safeIdentifier(effective_billable_attempt_id, "invalid_observation_identity");
      if (!["accepted", "duplicate"].includes(authority_status)) throw boundary("invalid_metering_acknowledgement");
      const now = nowMilliseconds(clock);
      return withTransaction(database, () => {
        const row = database.prepare(`SELECT source_observation_id, billable_attempt_id, status, metering_ack_status
          FROM ${OBSERVATION_TABLE} WHERE record_ref = ?`).get(recordRef);
        if (!row || row.source_observation_id !== observationId || row.billable_attempt_id !== billableAttemptId) {
          return Object.freeze({ status: "mismatch", source_observation_id: observationId });
        }
        if (row.status === "delivered") {
          return Object.freeze({ status: "acknowledged", source_observation_id: observationId,
            authority_status: row.metering_ack_status });
        }
        const changed = database.prepare(`UPDATE ${OBSERVATION_TABLE}
          SET status = 'delivered', claim_token_sha256 = NULL, lease_expires_at = NULL,
              delivered_at = ?, metering_ack_status = ?, last_defer_reason = NULL
          WHERE record_ref = ? AND source_observation_id = ? AND billable_attempt_id = ? AND status <> 'delivered'`)
          .run(now, authority_status, recordRef, observationId, billableAttemptId).changes;
        return Object.freeze({ status: changed === 1 ? "acknowledged" : "mismatch",
          source_observation_id: observationId, authority_status });
      });
    },

    /** Port consumed by deliverPendingUsageObservations; each claim has a lease fence. */
    async claimPending({ limit }) {
      assertOutermostCommitBoundary(database);
      const now = nowMilliseconds(clock);
      const { leaseUntil } = claimLeaseArgs(limit, claimLeaseMs, now);
      const records = withTransaction(database, () => selectClaimable(
        database, OBSERVATION_TABLE, limit, now, leaseUntil, idFactory, "observation",
        (row) => {
          const payload = decodePayload(row, { kind: "observation", idField: "source_observation_id", hashField: "payload_sha256" });
          if (payload.attempt.tenant_id !== row.tenant_id || payload.attempt.project_id !== row.project_id ||
            payload.attempt.budget_scope_id !== row.budget_scope_id ||
            payload.attempt.logical_operation_id !== row.logical_operation_id ||
            payload.attempt.billable_attempt_id !== row.billable_attempt_id ||
            payload.observation.source_observation_id !== row.source_observation_id) {
            throw boundary("corrupt_observation_record");
          }
          return payload;
        },
      ));
      return Object.freeze({ status: "claimed", records: Object.freeze(records) });
    },

    async acknowledge({ record_ref, claim_token, source_observation_id, effective_billable_attempt_id, authority_status }) {
      assertOutermostCommitBoundary(database);
      const recordRef = safeIdentifier(record_ref, "invalid_observation_reference");
      const observationId = safeIdentifier(source_observation_id, "invalid_observation_identity");
      safeIdentifier(effective_billable_attempt_id, "invalid_observation_identity");
      const tokenHash = hashClaimToken(claim_token);
      if (!["accepted", "duplicate"].includes(authority_status)) throw boundary("invalid_metering_acknowledgement");
      const now = nowMilliseconds(clock);
      return withTransaction(database, () => {
        const row = makeClaimTokenMatcher(database, OBSERVATION_TABLE, "record_ref", recordRef, claim_token, now);
        if (!row || row.claim_token_sha256 !== tokenHash || row.source_observation_id !== observationId ||
          row.billable_attempt_id !== effective_billable_attempt_id) {
          return Object.freeze({ status: "mismatch", source_observation_id: observationId });
        }
        const changed = database.prepare(`UPDATE ${OBSERVATION_TABLE}
          SET status = 'delivered', claim_token_sha256 = NULL, lease_expires_at = NULL,
              delivered_at = ?, metering_ack_status = ?, last_defer_reason = NULL
          WHERE record_ref = ? AND status = 'claimed' AND claim_token_sha256 = ? AND lease_expires_at > ?`)
          .run(now, authority_status, recordRef, tokenHash, now).changes;
        return Object.freeze({
          status: changed === 1 ? "acknowledged" : "mismatch",
          source_observation_id: observationId,
        });
      });
    },

    async defer({ record_ref, claim_token, reason }) {
      assertOutermostCommitBoundary(database);
      const recordRef = safeIdentifier(record_ref, "invalid_observation_reference");
      const tokenHash = hashClaimToken(claim_token);
      if (!OBSERVATION_DEFER_REASONS.has(reason)) throw boundary("invalid_observation_defer_reason");
      const now = nowMilliseconds(clock);
      return withTransaction(database, () => {
        const row = makeClaimTokenMatcher(database, OBSERVATION_TABLE, "record_ref", recordRef, claim_token, now);
        if (!row || row.claim_token_sha256 !== tokenHash) return Object.freeze({ status: "lease_lost" });
        const changed = database.prepare(`UPDATE ${OBSERVATION_TABLE}
          SET status = 'pending', claim_token_sha256 = NULL, lease_expires_at = NULL, last_defer_reason = ?
          WHERE record_ref = ? AND status = 'claimed' AND claim_token_sha256 = ? AND lease_expires_at > ?`)
          .run(reason, recordRef, tokenHash, now).changes;
        return Object.freeze({ status: changed === 1 ? "retained" : "lease_lost" });
      });
    },

    /** Evidence delivery claim API; a sink acknowledgement is owned by the host. */
    async claimPendingEvidence({ limit, leaseMs = claimLeaseMs }) {
      assertOutermostCommitBoundary(database);
      const now = nowMilliseconds(clock);
      const { leaseUntil } = claimLeaseArgs(limit, leaseMs, now);
      const records = withTransaction(database, () => selectClaimable(
        database, EVIDENCE_TABLE, limit, now, leaseUntil, idFactory, "evidence",
        (row) => {
          const event = decodePayload(row, { kind: "evidence", idField: "event_id", hashField: "payload_sha256" });
          if (event.tenant_id !== row.tenant_id || event.project_id !== row.project_id ||
            event.budget_scope_id !== row.budget_scope_id || event.event_type !== row.event_type) {
            throw boundary("corrupt_evidence_record");
          }
          return Object.freeze({ event });
        },
      ));
      return Object.freeze({ status: "claimed", records: Object.freeze(records) });
    },

    async acknowledgeEvidence({ event_id, claim_token }) {
      assertOutermostCommitBoundary(database);
      const eventId = safeIdentifier(event_id, "invalid_evidence_identity");
      const tokenHash = hashClaimToken(claim_token);
      const now = nowMilliseconds(clock);
      return withTransaction(database, () => {
        const row = makeClaimTokenMatcher(database, EVIDENCE_TABLE, "event_id", eventId, claim_token, now);
        if (!row || row.claim_token_sha256 !== tokenHash) return Object.freeze({ status: "lease_lost", event_id: eventId });
        const changed = database.prepare(`UPDATE ${EVIDENCE_TABLE}
          SET status = 'delivered', claim_token_sha256 = NULL, lease_expires_at = NULL, delivered_at = ?, last_defer_reason = NULL
          WHERE event_id = ? AND status = 'claimed' AND claim_token_sha256 = ? AND lease_expires_at > ?`)
          .run(now, eventId, tokenHash, now).changes;
        return Object.freeze({ status: changed === 1 ? "acknowledged" : "lease_lost", event_id: eventId });
      });
    },

    async deferEvidence({ event_id, claim_token, reason }) {
      assertOutermostCommitBoundary(database);
      const eventId = safeIdentifier(event_id, "invalid_evidence_identity");
      const tokenHash = hashClaimToken(claim_token);
      if (!EVIDENCE_DEFER_REASONS.has(reason)) throw boundary("invalid_evidence_defer_reason");
      const now = nowMilliseconds(clock);
      return withTransaction(database, () => {
        const row = makeClaimTokenMatcher(database, EVIDENCE_TABLE, "event_id", eventId, claim_token, now);
        if (!row || row.claim_token_sha256 !== tokenHash) return Object.freeze({ status: "lease_lost" });
        const changed = database.prepare(`UPDATE ${EVIDENCE_TABLE}
          SET status = 'pending', claim_token_sha256 = NULL, lease_expires_at = NULL, last_defer_reason = ?
          WHERE event_id = ? AND status = 'claimed' AND claim_token_sha256 = ? AND lease_expires_at > ?`)
          .run(reason, eventId, tokenHash, now).changes;
        return Object.freeze({ status: changed === 1 ? "retained" : "lease_lost" });
      });
    },

    async status(kind, reference) {
      const table = kind === "evidence" ? EVIDENCE_TABLE : kind === "observation" ? OBSERVATION_TABLE : undefined;
      if (!table) throw boundary("invalid_telemetry_record_kind");
      const keyField = kind === "evidence" ? "event_id" : "record_ref";
      const safe = safeIdentifier(reference, "invalid_telemetry_reference");
      try {
        const row = database.prepare(`SELECT status, claim_count, created_at, delivered_at FROM ${table} WHERE ${keyField} = ?`).get(safe);
        if (!row) return undefined;
        return Object.freeze({
          status: row.status,
          claim_count: row.claim_count,
          created_at: row.created_at,
          ...(row.delivered_at === null ? {} : { delivered_at: row.delivered_at }),
        });
      } catch {
        throw boundary("telemetry_storage_unavailable");
      }
    },
  });
}
