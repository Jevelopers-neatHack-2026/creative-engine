import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { canonicalHash, canonicalSerialize } from "../contracts/index.mjs";
import { CreativeVersionStore, VersionStoreError } from "./store.mjs";

const OPERATIONS = new Set(["generate", "edit", "inspect", "list", "compare", "restore", "cancel", "handoff", "job.status"]);
const HASH = /^sha256:[a-f0-9]{64}$/;

function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

function safeReference(value, field, max = 256) {
  if (typeof value !== "string" || value.length < 1 || value.length > max ||
    !/^[A-Za-z0-9_.:-]+$/.test(value) || /(?:gh[pousr]_[A-Za-z0-9]{20,}|(?:sk|rk|pk)-[A-Za-z0-9_-]{12,})/i.test(value)) {
    throw new VersionStoreError("invalid_request", field);
  }
  return value;
}

function safeHash(value, field) {
  if (typeof value !== "string" || !HASH.test(value)) throw new VersionStoreError("invalid_request", field);
  return value;
}

function safeJson(value, field) {
  try { return JSON.parse(canonicalSerialize(value)); }
  catch { throw new VersionStoreError("invalid_request", field); }
}

function tokenHash(value) { return createHash("sha256").update(value).digest("hex"); }

function jobFromRow(row) {
  if (!row) return null;
  let result;
  let error;
  try { result = row.result_json === null ? undefined : JSON.parse(row.result_json); }
  catch { throw new VersionStoreError("integrity_error", "job.result"); }
  try { error = row.error_json === null ? undefined : JSON.parse(row.error_json); }
  catch { throw new VersionStoreError("integrity_error", "job.error"); }
  return Object.freeze({
    tenant_id: row.tenant_id,
    project_id: row.project_id,
    ...(row.brief_id ? { brief_id: row.brief_id } : {}),
    actor_id: row.actor_id,
    action_id: row.action_id,
    operation: row.operation,
    job_id: row.job_id,
    status: row.status,
    request_hash: row.request_hash,
    ...(result !== undefined ? { result } : {}),
    ...(error !== undefined ? { error } : {}),
  });
}

function briefScope(scope, briefId) {
  const tenant_id = safeReference(scope?.tenant_id, "scope.tenant_id");
  const project_id = safeReference(scope?.project_id, "scope.project_id");
  const checkedBriefId = safeReference(briefId ?? scope?.brief_id, "brief_id");
  if (scope?.brief_id !== undefined && scope.brief_id !== checkedBriefId) throw new VersionStoreError("scope_denied", "scope.brief_id");
  return Object.freeze({ tenant_id, project_id, brief_id: checkedBriefId });
}

function contextFenceMatches(store, scope, fence) {
  if (!record(fence) || Object.keys(fence).some((key) => ![
    "brief_id", "brief_hash", "design_version_id", "design_hash",
    "expected_current_design_version_id", "expected_current_design_hash",
  ].includes(key))) return false;
  try {
    const checkedScope = briefScope(scope, fence.brief_id);
    const brief = store.getBrief({ scope: checkedScope, brief_id: checkedScope.brief_id });
    if (!brief || canonicalHash(brief) !== fence.brief_hash) return false;
    if (fence.design_version_id !== undefined) {
      safeReference(fence.design_version_id, "context_fence.design_version_id");
      safeHash(fence.design_hash, "context_fence.design_hash");
      const design = store.getDesignVersion({ scope: checkedScope, brief_id: checkedScope.brief_id,
        design_version_id: fence.design_version_id });
      if (!design || design.design_hash !== fence.design_hash) return false;
    }
    if (Object.hasOwn(fence, "expected_current_design_version_id")) {
      const selection = store.getSelection({ scope: checkedScope, brief_id: checkedScope.brief_id });
      const selectedId = selection?.design_version_id ?? null;
      const selectedHash = selection?.design_hash ?? null;
      if (selectedId !== fence.expected_current_design_version_id || selectedHash !== fence.expected_current_design_hash) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function transactionStatusFor(row, scope, actorId, leaseToken, now) {
  if (!row || row.tenant_id !== scope.tenant_id || row.project_id !== scope.project_id ||
    row.actor_id !== actorId || row.lease_hash !== tokenHash(leaseToken)) return "lease_lost";
  if (row.status === "cancelled") return "cancelled";
  if (row.status !== "running" || Date.parse(row.lease_expires_at) <= now) return "lease_lost";
  return "active";
}

/**
 * Bind the durable version store and CE-01 jobs port to the same SQLite
 * connection. `completeIfActive` runs its publication callback while holding
 * one BEGIN IMMEDIATE transaction; version metadata/selection and the job
 * result commit together. Provider, metering, decision, inspection, approval,
 * handoff, and trace capabilities remain caller-injected. Handoff submission
 * is rejected by this adapter until it has a durable external-result staging
 * protocol, because external approval/consumer calls cannot run under SQLite's
 * write transaction.
 */
export function createCreativeVersionApiPorts({ store, otherPorts = {}, idFactory = randomUUID,
  leaseDurationMs = 60_000, faultInjector } = {}) {
  if (!(store instanceof CreativeVersionStore) || typeof idFactory !== "function" ||
    !Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1_000 || leaseDurationMs > 24 * 60 * 60 * 1000 ||
    faultInjector !== undefined && typeof faultInjector !== "function") {
    throw new VersionStoreError("invalid_request", "adapter_options");
  }
  const transactionContext = new AsyncLocalStorage();
  let serialQueue = Promise.resolve();
  const serial = (work) => {
    if (transactionContext.getStore() === store) return Promise.resolve().then(work);
    const prior = serialQueue;
    let release;
    const barrier = new Promise((resolve) => { release = resolve; });
    serialQueue = prior.then(() => barrier);
    return prior.then(() => transactionContext.run(store, work)).finally(() => release());
  };

  const storage = {
    getBrief(input) { return serial(() => store.getBrief(input)); },
    getDesignVersion(input) { return serial(() => store.getDesignVersion(input)); },
    getCurrentDesignVersion(input) { return serial(() => store.getCurrentDesignVersion(input)); },
    getSelection(input) { return serial(() => store.getSelection(input)); },
    listDesignVersions(input) { return serial(() => store.listDesignVersions(input)); },
    getHandoffContext(input) {
      const get = otherPorts.storage?.getHandoffContext;
      return typeof get === "function" ? serial(() => get(input)) : Promise.resolve(null);
    },
    async prepareDesignVersion(input) {
      return serial(async () => {
        if (!record(input) || input.selection_mode !== "advance" && input.selection_mode !== "branch") {
          throw new VersionStoreError("invalid_request", "design_version");
        }
        const scope = briefScope(input.scope, input.brief_id);
        const brief = store.getBrief({ scope, brief_id: scope.brief_id });
        if (!brief || canonicalHash(brief) !== input.expected_brief_hash) {
          throw new VersionStoreError("stale_version", "brief_hash");
        }
        const selection = store.getSelection({ scope, brief_id: scope.brief_id });
        const versionSelection = input.selection_mode === "branch" ? { mode: "branch" } : {
          mode: "advance",
          expected_revision: selection?.revision ?? 0,
          expected_selected_design_version_id: input.expected_current_design_version_id,
          expected_selected_design_hash: input.expected_current_design_hash,
        };
        if (input.selection_mode === "advance" &&
          (selection?.design_version_id ?? null) !== input.expected_current_design_version_id ||
          input.selection_mode === "advance" && (selection?.design_hash ?? null) !== input.expected_current_design_hash) {
          throw new VersionStoreError("stale_version", "selection");
        }
        if (input.expected_parent_design_version_id !== (input.design_version.parent_version_id ?? null)) {
          throw new VersionStoreError("stale_version", "parent_version_id");
        }
        if (input.expected_parent_design_version_id !== null) {
          const parent = store.getDesignVersion({ scope, brief_id: scope.brief_id,
            design_version_id: input.expected_parent_design_version_id });
          if (!parent || parent.design_hash !== input.expected_parent_design_hash) throw new VersionStoreError("stale_version", "parent_design_hash");
        }
        const prepared = await store.prepareDesignVersion({
          ...input,
          scope,
          brief_snapshot: brief,
          actor_id: input.creation?.actor_id,
          selection: versionSelection,
          artifact_bytes: Uint8Array.from(input.artifact_bytes),
        }, { faultInjector });
        if (!record(prepared) || prepared.status !== "prepared") {
          throw new VersionStoreError("unavailable", "creation.intent", true);
        }
        return Object.freeze({ status: "prepared", action_id: prepared.action_id,
          job_id: prepared.job_id, payload_hash: prepared.payload_hash });
      });
    },
    commitPreparedDesignVersion(input, transaction) {
      return serial(() => store.commitPreparedDesignVersion(input, transaction));
    },
    saveDesignVersion(input, transaction) {
      // This fallback supports non-durable conformance adapters. The paired
      // adapter's API path uses prepare+commit so its creation intent survives
      // a process exit between bytes and publication.
      return serial(async () => {
        const scope = briefScope(input.scope, input.brief_id);
        const brief = store.getBrief({ scope, brief_id: scope.brief_id });
        if (!brief) throw new VersionStoreError("not_found", "brief_id");
        const selection = store.getSelection({ scope, brief_id: scope.brief_id });
        const prepared = await store.prepareDesignVersion({ ...input, scope, brief_snapshot: brief,
          selection: input.selection_mode === "branch" ? { mode: "branch" } : {
            mode: "advance", expected_revision: selection?.revision ?? 0,
            expected_selected_design_version_id: input.expected_current_design_version_id,
            expected_selected_design_hash: input.expected_current_design_hash,
          } });
        if (transaction) return store.commitPreparedDesignVersion({ ...prepared, scope,
          brief_id: scope.brief_id }, transaction);
        return store.finalizeAction(scope, prepared.action_id);
      });
    },
    selectDesignVersion(input, transaction) {
      return serial(() => store.selectDesignVersion(input, transaction));
    },
  };

  const jobs = {
    assertOperationAvailable({ operation }) {
      if (operation === "handoff") {
        throw new VersionStoreError("unavailable", "handoff.durable_result_staging", true);
      }
      return Object.freeze({ status: "available" });
    },
    begin(input) {
      return serial(() => {
        store.assertOpen();
        if (!record(input) || !record(input.scope)) throw new VersionStoreError("invalid_request", "job");
        const tenant_id = safeReference(input.scope.tenant_id, "scope.tenant_id");
        const project_id = safeReference(input.scope.project_id, "scope.project_id");
        const actor_id = safeReference(input.actor_id, "actor_id");
        const action_id = safeReference(input.action_id, "action_id");
        const request_hash = safeHash(input.request_hash, "request_hash");
        if (!OPERATIONS.has(input.operation)) throw new VersionStoreError("invalid_request", "operation");
        const brief_id = input.scope.brief_id === undefined ? null : safeReference(input.scope.brief_id, "brief_id");
        const now = store.timestamp();
        store.db.exec("BEGIN IMMEDIATE");
        try {
          const existing = store.db.prepare(`SELECT * FROM creative_jobs
            WHERE tenant_id=? AND project_id=? AND action_id=?`)
            .get(tenant_id, project_id, action_id);
          if (existing) {
            store.db.exec("COMMIT");
            if (existing.request_hash !== request_hash || existing.actor_id !== actor_id || existing.operation !== input.operation) {
              return Object.freeze({ kind: "conflict" });
            }
            return Object.freeze({ kind: "existing", job: jobFromRow(existing) });
          }
          const job_id = safeReference(idFactory(), "job_id");
          const lease_token = safeReference(idFactory(), "lease_token");
          const expires = new Date(Date.parse(now) + leaseDurationMs).toISOString();
          store.db.prepare(`INSERT INTO creative_jobs
            (tenant_id,project_id,job_id,brief_id,actor_id,action_id,operation,request_hash,status,lease_hash,
             lease_expires_at,result_json,error_json,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,'running',?,?,NULL,NULL,?,?)`)
            .run(tenant_id, project_id, job_id, brief_id, actor_id, action_id, input.operation, request_hash,
              tokenHash(lease_token), expires, now, now);
          store.db.exec("COMMIT");
          return Object.freeze({ kind: "started", job_id, lease_token });
        } catch (error) {
          store.rollback();
          if (error instanceof VersionStoreError) throw error;
          throw new VersionStoreError("unavailable", "job", true);
        }
      });
    },
    async authorizeDispatch(input) {
      return serial(() => {
        store.db.exec("BEGIN IMMEDIATE");
        try {
          const row = store.db.prepare(`SELECT * FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
            .get(input.scope.tenant_id, input.scope.project_id, input.job_id);
          const status = transactionStatusFor(row, input.scope, input.actor_id, input.lease_token, store.now());
          if (status !== "active") {
            store.db.exec("ROLLBACK");
            return Object.freeze({ status });
          }
          if (row.action_id !== input.action_id || row.operation !== input.operation) {
            store.db.exec("ROLLBACK");
            return Object.freeze({ status: "lease_lost" });
          }
          if (!contextFenceMatches(store, input.scope, input.context_fence)) {
            store.db.exec("ROLLBACK");
            return Object.freeze({ status: "stale_context" });
          }
          const transport_attempt_id = safeReference(input.transport_attempt_id, "transport_attempt_id");
          const existing = store.db.prepare(`SELECT dispatch_intent_ref,context_fence_json,billable_attempt_id FROM creative_dispatch_intents
            WHERE tenant_id=? AND project_id=? AND job_id=? AND transport_attempt_id=?`)
            .get(input.scope.tenant_id, input.scope.project_id, input.job_id, transport_attempt_id);
          if (existing) {
            const sameFence = existing.context_fence_json === canonicalSerialize(input.context_fence);
            const sameAttempt = (existing.billable_attempt_id ?? null) === (input.billable_attempt_id ?? null);
            const finalStatus = transactionStatusFor(row, input.scope, input.actor_id, input.lease_token, store.now());
            if (finalStatus !== "active") {
              store.db.exec("ROLLBACK");
              return Object.freeze({ status: finalStatus });
            }
            store.db.exec("COMMIT");
            return sameFence && sameAttempt ? Object.freeze({ status: "authorized", dispatch_intent_ref: existing.dispatch_intent_ref })
              : Object.freeze({ status: "lease_lost" });
          }
          const dispatch_intent_ref = safeReference(idFactory(), "dispatch_intent_ref");
          const authorized_at = store.timestamp();
          const authorizedAtMs = Date.parse(authorized_at);
          if (!Number.isFinite(authorizedAtMs) ||
            transactionStatusFor(row, input.scope, input.actor_id, input.lease_token, authorizedAtMs) !== "active") {
            store.db.exec("ROLLBACK");
            return Object.freeze({ status: "lease_lost" });
          }
          store.db.prepare(`INSERT INTO creative_dispatch_intents
            (tenant_id,project_id,job_id,transport_attempt_id,billable_attempt_id,dispatch_intent_ref,context_fence_json,authorized_at)
            VALUES(?,?,?,?,?,?,?,?)`)
            .run(input.scope.tenant_id, input.scope.project_id, input.job_id, transport_attempt_id,
              input.billable_attempt_id ?? null, dispatch_intent_ref, canonicalSerialize(input.context_fence), authorized_at);
          store.db.exec("COMMIT");
          return Object.freeze({ status: "authorized", dispatch_intent_ref });
        } catch (error) {
          store.rollback();
          if (error instanceof VersionStoreError) throw error;
          return Object.freeze({ status: "lease_lost" });
        }
      });
    },
    recordAttemptEvidence(input) {
      return serial(() => store.recordAttemptEvidence(input));
    },
    async completeIfActive(input, publish) {
      return serial(async () => {
        if (typeof publish !== "function") throw new VersionStoreError("invalid_request", "publish");
        if (input?.operation === "handoff") {
          throw new VersionStoreError("unavailable", "handoff.durable_result_staging", true);
        }
        const scope = briefScope(input.scope, input.publication_fence?.brief_id);
        store.db.exec("BEGIN IMMEDIATE");
        let transaction;
        try {
          const row = store.db.prepare(`SELECT * FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
            .get(scope.tenant_id, scope.project_id, input.job_id);
          const status = transactionStatusFor(row, scope, input.actor_id, input.lease_token, store.now());
          if (status !== "active") {
            store.db.exec("ROLLBACK");
            return Object.freeze({ status: status === "cancelled" ? "cancelled" : "cancelled", ...(row ? { job: jobFromRow(row) } : {}) });
          }
          if (row.action_id !== input.action_id || row.operation !== input.operation || !record(input.publication_fence) ||
            !contextFenceMatches(store, scope, input.publication_fence)) {
            store.db.exec("ROLLBACK");
            return Object.freeze({ status: "stale_context", job: jobFromRow(row) });
          }
          transaction = store.createPublicationTransaction({
            scope, actor_id: input.actor_id, job_id: input.job_id, lease_token: input.lease_token,
            action_id: row.action_id, request_hash: row.request_hash, result: input.result,
            publication_fence: input.publication_fence, faultInjector,
          });
          await publish(transaction);
          const fresh = store.db.prepare(`SELECT * FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
            .get(scope.tenant_id, scope.project_id, input.job_id);
          if (transactionStatusFor(fresh, scope, input.actor_id, input.lease_token, store.now()) !== "active") {
            throw new VersionStoreError("cancelled", "job.lease_token");
          }
          const committedBrief = store.getBrief({ scope, brief_id: scope.brief_id });
          if (!committedBrief || canonicalHash(committedBrief) !== input.publication_fence.brief_hash) {
            throw new VersionStoreError("stale_version", "brief_hash");
          }
          const result_json = canonicalSerialize(safeJson(input.result, "job.result"));
          const updated_at = store.timestamp();
          const completedAt = Date.parse(updated_at);
          const finalRow = store.db.prepare(`SELECT * FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
            .get(scope.tenant_id, scope.project_id, input.job_id);
          if (!Number.isFinite(completedAt) ||
            transactionStatusFor(finalRow, scope, input.actor_id, input.lease_token, completedAt) !== "active" ||
            finalRow.action_id !== input.action_id || finalRow.operation !== input.operation ||
            finalRow.request_hash !== row.request_hash) {
            throw new VersionStoreError("cancelled", "job.lease_token");
          }
          const completedChanges = store.db.prepare(`UPDATE creative_jobs SET status='completed',result_json=?,error_json=NULL,updated_at=?
            WHERE tenant_id=? AND project_id=? AND job_id=? AND status='running' AND actor_id=? AND action_id=?
              AND operation=? AND request_hash=? AND lease_hash=? AND lease_expires_at>?`)
            .run(result_json, updated_at, scope.tenant_id, scope.project_id, input.job_id,
              input.actor_id, input.action_id, input.operation, row.request_hash, tokenHash(input.lease_token), updated_at).changes;
          if (completedChanges !== 1) throw new VersionStoreError("cancelled", "job.lease_token");
          store.db.exec("COMMIT");
          faultInjector?.("after_job_commit");
          const completed = store.db.prepare(`SELECT * FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
            .get(scope.tenant_id, scope.project_id, input.job_id);
          return Object.freeze({ status: "completed", job: jobFromRow(completed), result: JSON.parse(result_json) });
        } catch (error) {
          store.rollback();
          if (error instanceof VersionStoreError) {
            if (["stale_version", "scope_denied", "conflict"].includes(error.code)) {
              const current = store.db.prepare(`SELECT * FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
                .get(scope.tenant_id, scope.project_id, input.job_id);
              return Object.freeze({ status: "stale_context", ...(current ? { job: jobFromRow(current) } : {}) });
            }
            throw error;
          }
          throw new VersionStoreError("unavailable", "job_publication", true);
        } finally {
          store.closePublicationTransaction(transaction);
        }
      });
    },
    failIfActive(input) {
      return serial(() => {
        const scope = briefScope(input.scope, input.scope.brief_id ?? "job-scope");
        store.db.exec("BEGIN IMMEDIATE");
        try {
          const row = store.db.prepare(`SELECT * FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
            .get(scope.tenant_id, scope.project_id, input.job_id);
          if (!row || row.actor_id !== input.actor_id || row.lease_hash !== tokenHash(input.lease_token) || row.status !== "running") {
            store.db.exec("ROLLBACK");
            return Object.freeze({ status: "cancelled", job: row ? jobFromRow(row) : undefined });
          }
          const error = safeJson(input.error, "job.error");
          store.db.prepare(`UPDATE creative_jobs SET status='failed',error_json=?,updated_at=?
            WHERE tenant_id=? AND project_id=? AND job_id=?`)
            .run(canonicalSerialize(error), store.timestamp(), scope.tenant_id, scope.project_id, input.job_id);
          store.db.exec("COMMIT");
          const updated = store.db.prepare(`SELECT * FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
            .get(scope.tenant_id, scope.project_id, input.job_id);
          return Object.freeze({ status: "failed", job: jobFromRow(updated) });
        } catch (error) {
          store.rollback();
          if (error instanceof VersionStoreError) throw error;
          throw new VersionStoreError("unavailable", "job_failure", true);
        }
      });
    },
    get(input) {
      return serial(() => {
        const tenant_id = safeReference(input.scope?.tenant_id, "scope.tenant_id");
        const project_id = safeReference(input.scope?.project_id, "scope.project_id");
        const job_id = safeReference(input.job_id, "job_id");
        const row = store.db.prepare(`SELECT * FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
          .get(tenant_id, project_id, job_id);
        return jobFromRow(row);
      });
    },
    cancel(input) {
      return serial(() => {
        const tenant_id = safeReference(input.scope?.tenant_id, "scope.tenant_id");
        const project_id = safeReference(input.scope?.project_id, "scope.project_id");
        const actor_id = safeReference(input.actor_id, "actor_id");
        const action_id = safeReference(input.action_id, "action_id");
        const target_action_id = safeReference(input.target_action_id, "target_action_id");
        const request_hash = safeHash(input.request_hash, "request_hash");
        store.db.exec("BEGIN IMMEDIATE");
        try {
          const prior = store.db.prepare(`SELECT * FROM creative_cancel_requests WHERE tenant_id=? AND project_id=? AND action_id=?`)
            .get(tenant_id, project_id, action_id);
          if (prior) {
            store.db.exec("COMMIT");
            if (prior.actor_id !== actor_id || prior.target_action_id !== target_action_id || prior.request_hash !== request_hash) {
              return Object.freeze({ kind: "conflict" });
            }
            const replayJob = store.db.prepare(`SELECT * FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
              .get(tenant_id, project_id, prior.job_id);
            return replayJob ? Object.freeze({ kind: "replayed", job: jobFromRow(replayJob) }) : Object.freeze({ kind: "not_found" });
          }
          const row = store.db.prepare(`SELECT * FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
            .get(tenant_id, project_id, input.job_id);
          if (!row || row.action_id !== target_action_id) {
            store.db.exec("ROLLBACK");
            return Object.freeze({ kind: "not_found" });
          }
          const now = store.timestamp();
          store.db.prepare(`INSERT INTO creative_cancel_requests
            (tenant_id,project_id,action_id,actor_id,target_action_id,request_hash,job_id,created_at)
            VALUES(?,?,?,?,?,?,?,?)`)
            .run(tenant_id, project_id, action_id, actor_id, target_action_id, request_hash, row.job_id, now);
          if (row.status === "running" || row.status === "queued") {
            // Keep the original lease hash as evidence identity. Terminal job
            // status fences dispatch/publication; a late worker with that
            // lease may still append usage references for reconciliation.
            store.db.prepare(`UPDATE creative_jobs SET status='cancelled',updated_at=?
              WHERE tenant_id=? AND project_id=? AND job_id=?`)
              .run(now, tenant_id, project_id, row.job_id);
          }
          store.db.exec("COMMIT");
          const updated = store.db.prepare(`SELECT * FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
            .get(tenant_id, project_id, row.job_id);
          return Object.freeze({ kind: "cancelled", job: jobFromRow(updated) });
        } catch (error) {
          store.rollback();
          if (error instanceof VersionStoreError) throw error;
          throw new VersionStoreError("unavailable", "job_cancel", true);
        }
      });
    },
  };

  const ports = { ...otherPorts, storage: { ...otherPorts.storage, ...storage }, jobs: { ...otherPorts.jobs, ...jobs } };
  return Object.freeze({ ports, storage: ports.storage, jobs: ports.jobs });
}
