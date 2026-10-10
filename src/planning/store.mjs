import { DatabaseSync } from "node:sqlite";
import {
  assertTrustedScope,
  canonicalHash,
  canonicalSerialize,
  validateCreativeBrief,
} from "../contracts/index.mjs";

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const VERIFIED_INVALIDATION_EVENTS = new WeakSet();
const VERIFIED_INVALIDATION_EVIDENCE = new WeakSet();

/** Internal handoff from the planner's trusted verifier path to the durable adapter. */
export function acceptVerifiedInvalidation(event, evidence) {
  VERIFIED_INVALIDATION_EVENTS.add(event);
  VERIFIED_INVALIDATION_EVIDENCE.add(evidence);
}

function fail(code, message, field) {
  const error = new Error(message);
  error.name = "CreativePlanningError";
  error.code = code;
  if (field !== undefined) error.field = field;
  throw error;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function requiredString(value, field, pattern = null) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || (pattern && !pattern.test(value))) {
    fail("invalid_input", "A scoped store field is invalid.", field);
  }
  return value;
}

function validateTrustedScope(value) {
  if (!isRecord(value)) fail("invalid_input", "A separately trusted scope is required.", "trusted_scope");
  return Object.freeze({
    tenant_id: requiredString(value.tenant_id, "trusted_scope.tenant_id", SAFE_ID),
    project_id: requiredString(value.project_id, "trusted_scope.project_id", SAFE_ID),
  });
}

function safeJson(value, field) {
  try {
    return canonicalSerialize(value);
  } catch {
    fail("invalid_input", "The store accepts only canonical JSON records.", field);
  }
}

function parseJson(value, field) {
  try {
    return JSON.parse(value);
  } catch {
    fail("store_corrupt", "A persisted record is not valid JSON.", field);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function sameScope(row, scope) {
  return row.tenant_id === scope.tenant_id && row.project_id === scope.project_id;
}

function checkedId(value, field) {
  return requiredString(value, field, SAFE_ID);
}

function tx(database, callback) {
  if (typeof database.isTransaction === "boolean" && !database.isTransaction) {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the original storage error.
      }
      throw error;
    }
  }
  database.exec("SAVEPOINT creative_planning_tx");
  try {
    const result = callback();
    database.exec("RELEASE SAVEPOINT creative_planning_tx");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK TO SAVEPOINT creative_planning_tx");
      database.exec("RELEASE SAVEPOINT creative_planning_tx");
    } catch {
      // Preserve the original storage error.
    }
    throw error;
  }
}

function initialize(database) {
  if (database.isTransaction === true) {
    fail("invalid_store", "Initialize the brief store outside an active SQLite transaction.", "database");
  }
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS creative_brief_versions (
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      version_no INTEGER NOT NULL CHECK (version_no > 0),
      brief_hash TEXT NOT NULL CHECK (length(brief_hash) = 71),
      source_package_id TEXT NOT NULL,
      source_package_hash TEXT NOT NULL CHECK (length(source_package_hash) = 71),
      created_at TEXT NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY (tenant_id, project_id, brief_id, version_no),
      UNIQUE (tenant_id, project_id, brief_id, brief_hash)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS creative_brief_source_lookup
      ON creative_brief_versions (tenant_id, project_id, source_package_id, source_package_hash);
    CREATE TABLE IF NOT EXISTS creative_invalidation_events (
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      event_hash TEXT NOT NULL CHECK (length(event_hash) = 71),
      idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) = 71),
      source_package_id TEXT NOT NULL,
      source_revision INTEGER NOT NULL CHECK (source_revision > 0),
      evidence_json TEXT NOT NULL,
      receipt_id TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      PRIMARY KEY (tenant_id, project_id, event_id),
      UNIQUE (tenant_id, project_id, idempotency_key)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS creative_invalidation_package_revision
      ON creative_invalidation_events (tenant_id, project_id, source_package_id, source_revision);
    CREATE TABLE IF NOT EXISTS creative_invalidation_fences (
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      source_package_id TEXT NOT NULL,
      source_package_hash TEXT NOT NULL CHECK (length(source_package_hash) = 71),
      kind TEXT NOT NULL CHECK (kind IN ('fact', 'asset')),
      target_id TEXT NOT NULL,
      target_hash TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (tenant_id, project_id, event_id, kind, target_id, target_hash),
      FOREIGN KEY (tenant_id, project_id, event_id)
        REFERENCES creative_invalidation_events (tenant_id, project_id, event_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS creative_asset_fences
      ON creative_invalidation_fences (tenant_id, project_id, kind, target_id, target_hash);
    CREATE INDEX IF NOT EXISTS creative_fact_fences
      ON creative_invalidation_fences (tenant_id, project_id, source_package_id, source_package_hash, kind, target_id);
    CREATE TABLE IF NOT EXISTS creative_approval_staleness_outbox (
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      brief_hash TEXT NOT NULL CHECK (length(brief_hash) = 71),
      status TEXT NOT NULL CHECK (status IN ('pending', 'acknowledged')),
      acknowledgment_json TEXT,
      PRIMARY KEY (tenant_id, project_id, request_id),
      FOREIGN KEY (tenant_id, project_id, event_id)
        REFERENCES creative_invalidation_events (tenant_id, project_id, event_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS creative_producer_acknowledgments (
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      acknowledgment_json TEXT NOT NULL,
      PRIMARY KEY (tenant_id, project_id, event_id),
      FOREIGN KEY (tenant_id, project_id, event_id)
        REFERENCES creative_invalidation_events (tenant_id, project_id, event_id)
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS creative_brief_versions_no_update
      BEFORE UPDATE ON creative_brief_versions BEGIN
        SELECT RAISE(ABORT, 'brief history is immutable');
      END;
    CREATE TRIGGER IF NOT EXISTS creative_brief_versions_no_delete
      BEFORE DELETE ON creative_brief_versions BEGIN
        SELECT RAISE(ABORT, 'brief history is immutable');
      END;
    CREATE TRIGGER IF NOT EXISTS creative_invalidation_events_no_update
      BEFORE UPDATE ON creative_invalidation_events BEGIN
        SELECT RAISE(ABORT, 'invalidation receipts are immutable');
      END;
    CREATE TRIGGER IF NOT EXISTS creative_invalidation_events_no_delete
      BEFORE DELETE ON creative_invalidation_events BEGIN
        SELECT RAISE(ABORT, 'invalidation receipts are immutable');
      END;
    CREATE TRIGGER IF NOT EXISTS creative_invalidation_fences_no_update
      BEFORE UPDATE ON creative_invalidation_fences BEGIN
        SELECT RAISE(ABORT, 'invalidation fences are monotonic');
      END;
    CREATE TRIGGER IF NOT EXISTS creative_invalidation_fences_no_delete
      BEFORE DELETE ON creative_invalidation_fences BEGIN
        SELECT RAISE(ABORT, 'invalidation fences are monotonic');
      END;
    CREATE TRIGGER IF NOT EXISTS creative_approval_staleness_outbox_monotonic
      BEFORE UPDATE ON creative_approval_staleness_outbox
      WHEN OLD.status <> 'pending' OR NEW.status <> 'acknowledged'
        OR NEW.tenant_id IS NOT OLD.tenant_id OR NEW.project_id IS NOT OLD.project_id
        OR NEW.request_id IS NOT OLD.request_id OR NEW.event_id IS NOT OLD.event_id
        OR NEW.brief_id IS NOT OLD.brief_id OR NEW.brief_hash IS NOT OLD.brief_hash
        OR NEW.acknowledgment_json IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'approval staleness acknowledgments are append-only');
      END;
    CREATE TRIGGER IF NOT EXISTS creative_approval_staleness_outbox_no_delete
      BEFORE DELETE ON creative_approval_staleness_outbox BEGIN
        SELECT RAISE(ABORT, 'approval staleness requests are durable');
      END;
    CREATE TRIGGER IF NOT EXISTS creative_producer_acknowledgments_no_update
      BEFORE UPDATE ON creative_producer_acknowledgments BEGIN
        SELECT RAISE(ABORT, 'producer acknowledgments are immutable');
      END;
    CREATE TRIGGER IF NOT EXISTS creative_producer_acknowledgments_no_delete
      BEFORE DELETE ON creative_producer_acknowledgments BEGIN
        SELECT RAISE(ABORT, 'producer acknowledgments are immutable');
      END;
  `);
}

function makeBriefReceipt(row) {
  return Object.freeze({
    tenant_id: row.tenant_id,
    project_id: row.project_id,
    brief_id: row.brief_id,
    version_no: row.version_no,
    brief_hash: row.brief_hash,
    source_package_id: row.source_package_id,
    source_package_hash: row.source_package_hash,
    created_at: row.created_at,
    brief: deepFreeze(parseJson(row.record_json, "brief_history.record_json")),
  });
}

function makeInvalidationReceipt(database, row) {
  const evidence = parseJson(row.evidence_json, "invalidation.evidence_json");
  const approvalRequests = database.prepare(`
    SELECT request_id, event_id, brief_id, brief_hash, tenant_id, project_id, status
    FROM creative_approval_staleness_outbox
    WHERE tenant_id = ? AND project_id = ? AND event_id = ?
    ORDER BY request_id
  `).all(row.tenant_id, row.project_id, row.event_id).map((request) => Object.freeze({ ...request }));
  return Object.freeze({
    receipt_id: row.receipt_id,
    event_id: row.event_id,
    event_hash: row.event_hash,
    idempotency_key: row.idempotency_key,
    tenant_id: row.tenant_id,
    project_id: row.project_id,
    source_package_id: row.source_package_id,
    source_revision: row.source_revision,
    approval_requests: Object.freeze(approvalRequests),
    verification_classification: evidence.classification,
  });
}

function createStore(database, scope, closeDatabase) {
  if (!database || typeof database.exec !== "function" || typeof database.prepare !== "function") {
    fail("invalid_store", "A synchronous SQLite database connection is required.", "database");
  }
  initialize(database);

  function requireScope(tenantId, projectId, field) {
    if (tenantId !== scope.tenant_id || projectId !== scope.project_id) {
      fail("scope_mismatch", "The record is outside this store's trusted scope.", field);
    }
  }

  function getEventRow(eventId) {
    return database.prepare(`
      SELECT * FROM creative_invalidation_events
      WHERE tenant_id = ? AND project_id = ? AND event_id = ?
    `).get(scope.tenant_id, scope.project_id, eventId);
  }

  const store = {
    /**
     * External invalidation acknowledgments are safe only after this connection
     * commits its fence/outbox writes. Releasing a savepoint inside a caller's
     * transaction is provisional and cannot authorize an external acknowledgment.
     */
    assertInvalidationBoundary() {
      if (typeof database.isTransaction !== "boolean") {
        fail("invalidation_transaction_state_unavailable", "The SQLite connection cannot confirm a committed invalidation boundary.", "database");
      }
      if (database.isTransaction) {
        fail("invalidation_transaction_active", "Research invalidation cannot emit external acknowledgments inside a caller-owned transaction.", "database");
      }
    },

    appendBriefVersion(input) {
      if (!isRecord(input) || !isRecord(input.brief)) fail("invalid_input", "A brief record is required.", "brief");
      const brief = input.brief;
      requireScope(brief.tenant_id, brief.project_id, "brief.scope");
      const briefId = checkedId(brief.brief_id, "brief.brief_id");
      const source = brief.research_package_ref;
      if (!isRecord(source) || source.contract !== "EventIntelligencePackage") {
        fail("invalid_input", "A normalized research package reference is required.", "brief.research_package_ref");
      }
      const sourcePackageId = checkedId(source.package_id, "brief.research_package_ref.package_id");
      const sourcePackageHash = requiredString(source.content_hash, "brief.research_package_ref.content_hash", HASH_PATTERN);
      const briefHash = requiredString(input.brief_hash, "brief_hash", HASH_PATTERN);
      const calculatedHash = canonicalHash(brief);
      if (briefHash !== calculatedHash) fail("brief_hash_mismatch", "The stored hash does not bind the supplied brief.", "brief_hash");
      try {
        validateCreativeBrief(brief, { trustedScope: { ...scope, brief_id: briefId } });
        assertTrustedScope(brief, { ...scope, brief_id: briefId }, "CreativeBrief");
      } catch {
        fail("creative_brief_invalid", "The stored record does not satisfy the local CreativeBrief contract.", "brief");
      }
      const createdAt = requiredString(input.created_at, "created_at");
      if (!ISO_DATE_TIME.test(createdAt) || !Number.isFinite(Date.parse(createdAt)) || createdAt !== brief.occurred_at) {
        fail("invalid_input", "The stored timestamp must match the brief's validated occurrence time.", "created_at");
      }
      const recordJson = safeJson(brief, "brief");
      return tx(database, () => {
        const existing = database.prepare(`
          SELECT * FROM creative_brief_versions
          WHERE tenant_id = ? AND project_id = ? AND brief_id = ? AND brief_hash = ?
        `).get(scope.tenant_id, scope.project_id, briefId, briefHash);
        if (existing) return makeBriefReceipt(existing);
        const latest = database.prepare(`
          SELECT COALESCE(MAX(version_no), 0) AS version_no
          FROM creative_brief_versions
          WHERE tenant_id = ? AND project_id = ? AND brief_id = ?
        `).get(scope.tenant_id, scope.project_id, briefId).version_no;
        const versionNo = latest + 1;
        database.prepare(`
          INSERT INTO creative_brief_versions
            (tenant_id, project_id, brief_id, version_no, brief_hash, source_package_id,
             source_package_hash, created_at, record_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(scope.tenant_id, scope.project_id, briefId, versionNo, briefHash,
          sourcePackageId, sourcePackageHash, createdAt, recordJson);
        const row = database.prepare(`
          SELECT * FROM creative_brief_versions
          WHERE tenant_id = ? AND project_id = ? AND brief_id = ? AND version_no = ?
        `).get(scope.tenant_id, scope.project_id, briefId, versionNo);
        return makeBriefReceipt(row);
      });
    },

    getBriefHistory(briefId) {
      const id = checkedId(briefId, "brief_id");
      return Object.freeze(database.prepare(`
        SELECT * FROM creative_brief_versions
        WHERE tenant_id = ? AND project_id = ? AND brief_id = ?
        ORDER BY version_no
      `).all(scope.tenant_id, scope.project_id, id).map(makeBriefReceipt));
    },

    getBriefVersion(briefId, versionNo) {
      const id = checkedId(briefId, "brief_id");
      if (!Number.isSafeInteger(versionNo) || versionNo < 1) fail("invalid_input", "A positive version number is required.", "version_no");
      const row = database.prepare(`
        SELECT * FROM creative_brief_versions
        WHERE tenant_id = ? AND project_id = ? AND brief_id = ? AND version_no = ?
      `).get(scope.tenant_id, scope.project_id, id, versionNo);
      return row ? makeBriefReceipt(row) : null;
    },

    getInvalidationReceipt(tenantId, projectId, eventId) {
      requireScope(tenantId, projectId, "invalidation.scope");
      const id = checkedId(eventId, "event_id");
      const row = getEventRow(id);
      return row ? makeInvalidationReceipt(database, row) : null;
    },

    persistInvalidationAndFences(event, evidence) {
      if (!isRecord(event) || !isRecord(evidence) ||
        !VERIFIED_INVALIDATION_EVENTS.has(event) || !VERIFIED_INVALIDATION_EVIDENCE.has(evidence)) {
        fail("invalidation_unverified", "Only verifier-accepted evidence can be persisted.", "verification_evidence");
      }
      requireScope(event.tenant_id, event.project_id, "event.scope");
      const eventId = checkedId(event.event_id, "event.event_id");
      const eventHash = requiredString(event.content_hash, "event.content_hash", HASH_PATTERN);
      const idempotencyKey = requiredString(event.idempotency_key, "event.idempotency_key", HASH_PATTERN);
      const { content_hash: _contentHash, idempotency_key: _idempotencyKey, ...eventBody } = event;
      if (canonicalHash(eventBody) !== eventHash || canonicalHash({
        tenant_id: event.tenant_id,
        project_id: event.project_id,
        event_id: event.event_id,
        content_hash: eventHash,
      }) !== idempotencyKey) {
        fail("invalidation_hash_mismatch", "The event hashes do not bind the normalized invalidation.", "event.content_hash");
      }
      const sourcePackageId = checkedId(event.source_package_id, "event.source_package_id");
      const sourceRevision = event.source_revision;
      if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 1) fail("invalid_input", "A positive source revision is required.", "event.source_revision");
      const eventJson = safeJson(event, "event");
      const evidenceJson = safeJson({
        classification: evidence.classification,
        evidence_ref_hash: evidence.evidence_ref_hash,
        verified_at: evidence.verified_at,
        valid_until: evidence.valid_until,
        event_hash: evidence.event_hash,
      }, "verification_evidence");
      return tx(database, () => {
        const prior = getEventRow(eventId);
        if (prior) {
          if (prior.event_hash !== eventHash || prior.idempotency_key !== idempotencyKey) {
            fail("invalidation_event_conflict", "An event ID was already persisted with different content.", "event.event_id");
          }
          return makeInvalidationReceipt(database, prior);
        }
        const collision = database.prepare(`
          SELECT event_id, event_hash FROM creative_invalidation_events
          WHERE tenant_id = ? AND project_id = ? AND idempotency_key = ?
        `).get(scope.tenant_id, scope.project_id, idempotencyKey);
        if (collision && (collision.event_id !== eventId || collision.event_hash !== eventHash)) {
          fail("invalidation_event_conflict", "An idempotency key is already bound to different event content.", "event.idempotency_key");
        }
        const receiptId = `invalidation-receipt:${canonicalHash({
          tenant_id: scope.tenant_id,
          project_id: scope.project_id,
          event_id: eventId,
          event_hash: eventHash,
        }).slice("sha256:".length)}`;
        database.prepare(`
          INSERT INTO creative_invalidation_events
            (tenant_id, project_id, event_id, event_hash, idempotency_key,
             source_package_id, source_revision, evidence_json, receipt_id, receipt_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(scope.tenant_id, scope.project_id, eventId, eventHash, idempotencyKey,
          sourcePackageId, sourceRevision, evidenceJson, receiptId, eventJson);

        const affectedBriefs = new Map();
        for (const reference of event.affected_briefs ?? []) {
          affectedBriefs.set(`${reference.brief_id}\u0000${reference.brief_hash}`, {
            brief_id: reference.brief_id,
            brief_hash: reference.brief_hash,
          });
        }
        const storedBriefs = database.prepare(`
          SELECT brief_id, brief_hash FROM creative_brief_versions
          WHERE tenant_id = ? AND project_id = ? AND source_package_id = ? AND source_package_hash = ?
        `).all(scope.tenant_id, scope.project_id, sourcePackageId, event.source_package_hash);
        for (const reference of storedBriefs) affectedBriefs.set(`${reference.brief_id}\u0000${reference.brief_hash}`, reference);

        const insertStaleness = database.prepare(`
          INSERT OR IGNORE INTO creative_approval_staleness_outbox
            (tenant_id, project_id, request_id, event_id, brief_id, brief_hash, status)
          VALUES (?, ?, ?, ?, ?, ?, 'pending')
        `);
        for (const reference of affectedBriefs.values()) {
          const requestId = `approval-staleness:${canonicalHash({
            tenant_id: scope.tenant_id,
            project_id: scope.project_id,
            event_id: eventId,
            brief_id: reference.brief_id,
            brief_hash: reference.brief_hash,
          }).slice("sha256:".length)}`;
          insertStaleness.run(scope.tenant_id, scope.project_id, requestId, eventId,
            reference.brief_id, reference.brief_hash);
        }

        const insertFence = database.prepare(`
          INSERT OR IGNORE INTO creative_invalidation_fences
            (tenant_id, project_id, event_id, source_package_id, source_package_hash,
             kind, target_id, target_hash)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const affected of event.affected) {
          insertFence.run(scope.tenant_id, scope.project_id, eventId, sourcePackageId,
            event.source_package_hash, affected.kind,
            affected.kind === "fact" ? affected.fact_id : affected.asset_id,
            affected.kind === "asset" ? affected.content_hash : "");
        }

        const row = getEventRow(eventId);
        const enrichedRow = { ...row, classification: evidence.classification };
        return makeInvalidationReceipt(database, enrichedRow);
      });
    },

    listPendingApprovalStaleness(tenantId, projectId, eventId) {
      requireScope(tenantId, projectId, "approval_staleness.scope");
      const id = checkedId(eventId, "event_id");
      return Object.freeze(database.prepare(`
        SELECT request_id, event_id, brief_id, brief_hash, tenant_id, project_id
        FROM creative_approval_staleness_outbox
        WHERE tenant_id = ? AND project_id = ? AND event_id = ? AND status = 'pending'
        ORDER BY request_id
      `).all(scope.tenant_id, scope.project_id, id).map((row) => Object.freeze({ ...row })));
    },

    recordApprovalStalenessAcknowledgment(response) {
      if (!isRecord(response) || response.status !== "acknowledged") fail("invalid_acknowledgment", "A matching acknowledgment is required.", "response");
      requireScope(response.tenant_id, response.project_id, "response.scope");
      const requestId = checkedId(response.request_id, "response.request_id");
      const row = database.prepare(`
        SELECT * FROM creative_approval_staleness_outbox
        WHERE tenant_id = ? AND project_id = ? AND request_id = ?
      `).get(scope.tenant_id, scope.project_id, requestId);
      if (!row || row.status !== "pending" || row.event_id !== response.event_id ||
        row.brief_id !== response.brief_id || row.brief_hash !== response.brief_hash) {
        if (row?.status === "acknowledged" && row.event_id === response.event_id &&
          row.brief_id === response.brief_id && row.brief_hash === response.brief_hash) {
          return Object.freeze({ request_id: row.request_id, status: "acknowledged", event_id: row.event_id,
            brief_id: row.brief_id, brief_hash: row.brief_hash, tenant_id: row.tenant_id, project_id: row.project_id });
        }
        fail("invalid_acknowledgment", "The acknowledgment does not match a pending scoped request.", "response");
      }
      const safeResponse = {
        request_id: row.request_id,
        status: "acknowledged",
        event_id: row.event_id,
        brief_id: row.brief_id,
        brief_hash: row.brief_hash,
        tenant_id: row.tenant_id,
        project_id: row.project_id,
      };
      database.prepare(`
        UPDATE creative_approval_staleness_outbox
        SET status = 'acknowledged', acknowledgment_json = ?
        WHERE tenant_id = ? AND project_id = ? AND request_id = ? AND status = 'pending'
      `).run(safeJson(safeResponse, "response"), scope.tenant_id, scope.project_id, requestId);
      return Object.freeze(safeResponse);
    },

    getProducerAcknowledgment(tenantId, projectId, eventId) {
      requireScope(tenantId, projectId, "producer_acknowledgment.scope");
      const row = database.prepare(`
        SELECT acknowledgment_json FROM creative_producer_acknowledgments
        WHERE tenant_id = ? AND project_id = ? AND event_id = ?
      `).get(scope.tenant_id, scope.project_id, checkedId(eventId, "event_id"));
      return row ? Object.freeze(parseJson(row.acknowledgment_json, "producer_acknowledgment")) : null;
    },

    recordProducerAcknowledgment(response) {
      if (!isRecord(response) || response.status !== "acknowledged") fail("invalid_acknowledgment", "A matching producer acknowledgment is required.", "response");
      requireScope(response.tenant_id, response.project_id, "response.scope");
      const eventId = checkedId(response.event_id, "response.event_id");
      return tx(database, () => {
        const event = getEventRow(eventId);
        if (!event || event.event_hash !== response.event_hash || event.idempotency_key !== response.idempotency_key) {
          fail("invalid_acknowledgment", "The producer acknowledgment does not match a persisted event.", "response");
        }
        const pending = database.prepare(`
          SELECT 1 AS found FROM creative_approval_staleness_outbox
          WHERE tenant_id = ? AND project_id = ? AND event_id = ? AND status = 'pending'
          LIMIT 1
        `).get(scope.tenant_id, scope.project_id, eventId);
        if (pending) {
          fail("approval_staleness_pending", "The producer cannot be acknowledged before all approval-staleness requests are acknowledged.", "event_id");
        }
        const safeResponse = {
          status: "acknowledged",
          event_id: eventId,
          event_hash: event.event_hash,
          idempotency_key: event.idempotency_key,
          tenant_id: scope.tenant_id,
          project_id: scope.project_id,
        };
        database.prepare(`
          INSERT OR IGNORE INTO creative_producer_acknowledgments
            (tenant_id, project_id, event_id, acknowledgment_json)
          VALUES (?, ?, ?, ?)
        `).run(scope.tenant_id, scope.project_id, eventId, safeJson(safeResponse, "response"));
        return Object.freeze(parseJson(database.prepare(`
          SELECT acknowledgment_json FROM creative_producer_acknowledgments
          WHERE tenant_id = ? AND project_id = ? AND event_id = ?
        `).get(scope.tenant_id, scope.project_id, eventId).acknowledgment_json, "producer_acknowledgment"));
      });
    },

    isAssetFenced(tenantId, projectId, assetId, contentHash) {
      requireScope(tenantId, projectId, "asset.scope");
      const row = database.prepare(`
        SELECT 1 AS found FROM creative_invalidation_fences
        WHERE tenant_id = ? AND project_id = ? AND kind = 'asset'
          AND target_id = ? AND target_hash = ? LIMIT 1
      `).get(scope.tenant_id, scope.project_id, checkedId(assetId, "asset_id"),
        requiredString(contentHash, "content_hash", HASH_PATTERN));
      return Boolean(row);
    },

    isFactFenced(tenantId, projectId, packageId, packageHash, factId) {
      requireScope(tenantId, projectId, "fact.scope");
      const row = database.prepare(`
        SELECT 1 AS found FROM creative_invalidation_fences
        WHERE tenant_id = ? AND project_id = ? AND source_package_id = ?
          AND source_package_hash = ? AND kind = 'fact' AND target_id = ? LIMIT 1
      `).get(scope.tenant_id, scope.project_id, checkedId(packageId, "source_package_id"),
        requiredString(packageHash, "source_package_hash", HASH_PATTERN), checkedId(factId, "fact_id"));
      return Boolean(row);
    },

    getInvalidationHistory() {
      return Object.freeze(database.prepare(`
        SELECT event_id, event_hash, idempotency_key, source_package_id, source_revision, receipt_id
        FROM creative_invalidation_events
        WHERE tenant_id = ? AND project_id = ?
        ORDER BY source_package_id, source_revision, event_id
      `).all(scope.tenant_id, scope.project_id).map((row) => Object.freeze({ ...row })));
    },

    close() {
      if (closeDatabase && typeof database.close === "function") database.close();
    },
  };

  return Object.freeze(store);
}

/** Wraps a caller-owned synchronous SQLite connection, such as a future CE08 connection. */
export function createCreativeBriefStore({ database, trustedScope }) {
  return createStore(database, validateTrustedScope(trustedScope), false);
}

/** Opens the local SQLite adapter used by tests and standalone development. */
export function openCreativeBriefStore(path, trustedScope) {
  if (typeof path !== "string" || path.length === 0 || path.length > 4096) {
    fail("invalid_input", "A SQLite database path is required.", "path");
  }
  const database = new DatabaseSync(path);
  try {
    return createStore(database, validateTrustedScope(trustedScope), true);
  } catch (error) {
    database.close();
    throw error;
  }
}
