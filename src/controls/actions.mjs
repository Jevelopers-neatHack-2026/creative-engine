import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ACTION_VERSIONS, SCHEMA_VERSIONS, canonical, isRecord, validId, equalVersions, activeQuestions } from './schema.mjs';
import { assertSupportedRuntime } from './runtime.mjs';

assertSupportedRuntime();

export const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const fields = ['action_version', 'schema_version', 'control_schema_hash', 'action_id', 'tenant_id', 'project_id', 'brief_id', 'expected_versions', 'intent', 'draft', 'draft_hash', 'correlation_id'];
class Rejection extends Error { constructor(code, current) { super(code); this.code = code; this.current = current; } }
const reject = (code, current) => { throw new Rejection(code, current); };
const trusted = ctx => {
  if (!isRecord(ctx) || !validId(ctx.actor_id) || !validId(ctx.tenant_id) || !validId(ctx.project_id)) reject('permission');
};

function envelope(body) {
  if (!isRecord(body)) reject('validation');
  if (!ACTION_VERSIONS.includes(body.action_version) || !SCHEMA_VERSIONS.includes(body.schema_version)) reject('unsupported_version');
  if (body.action_version.split('/')[1] !== body.schema_version.split('/')[1]) reject('unsupported_version');
  if (Object.keys(body).some(k => !fields.includes(k))) reject('unknown_field');
  for (const k of ['action_id', 'tenant_id', 'project_id', 'brief_id']) if (!validId(body[k])) reject('validation');
  if (body.correlation_id !== undefined && !validId(body.correlation_id)) reject('validation');
  if (typeof body.control_schema_hash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(body.control_schema_hash)) reject('validation');
  if (body.intent !== 'apply') reject('invalid_intent');
  if (!isRecord(body.expected_versions) || Object.keys(body.expected_versions).sort().join(',') !== 'brief,composition,design' || Object.values(body.expected_versions).some(v => !validId(v))) reject('validation');
  if (!isRecord(body.draft) || Object.keys(body.draft).sort().join(',') !== 'answers,selections' || !isRecord(body.draft.selections) || !isRecord(body.draft.answers)) reject('validation');
  if (Object.keys(body.draft.selections).length > 4 || Object.keys(body.draft.answers).length > 1 ||
      [...Object.values(body.draft.selections), ...Object.values(body.draft.answers)].some(x => typeof x !== 'string' || x.length > 50)) reject('validation');
  if (typeof body.draft_hash !== 'string' || !/^[a-f0-9]{64}$/.test(body.draft_hash) || body.draft_hash !== hash(body.draft)) reject('draft_mismatch');
}

function validateDraft(body, state) {
  const schema = state.schema;
  if (body.brief_id !== schema.brief_id || !equalVersions(body.expected_versions, schema.expected_versions)) reject('stale_version', schema.expected_versions);
  if (!state.supported_schema_versions?.includes(body.schema_version)) reject('unsupported_version');
  // Supported old/new schemas have identical field semantics; bind their own versioned bytes.
  if (body.control_schema_hash !== `sha256:${hash({ ...schema, schema_version: body.schema_version })}`) reject('stale_schema', schema.expected_versions);
  if (Object.keys(body.draft.selections).sort().join(',') !== schema.controls.map(c => c.id).sort().join(',')) reject('unknown_control');
  const changes = [];
  for (const c of schema.controls) {
    const value = body.draft.selections[c.id];
    if (!c.options.some(o => o.value === value)) reject('invalid_value');
    if (c.locked && value !== c.default_value) reject('locked');
    if (c.asset_id && !state.permitted_asset_ids?.includes(c.asset_id)) reject('asset_permission');
    if (value !== c.default_value) changes.push({ field: c.field, value, route: c.route, ...(c.asset_id ? { asset_id: c.asset_id } : {}) });
  }
  const active = activeQuestions(schema, body.draft);
  if (Object.keys(body.draft.answers).some(k => !active.some(q => q.id === k))) reject('unknown_question');
  for (const q of active) {
    const value = body.draft.answers[q.id];
    if (!q.options.some(o => o.value === value)) reject('follow_up_required');
    if (q.locked && value !== q.default_value) reject('locked');
    if (value !== q.default_value) changes.push({ field: q.field, value, route: q.route });
  }
  if (!changes.length) reject('no_changes');
  return ['composition.update', 'artwork.edit'].flatMap(kind => {
    const relevant = changes.filter(c => c.route === kind);
    return relevant.length ? [{ kind, changes: relevant.map(({ route, ...c }) => c),
      ...(kind === 'composition.update' ? { follow_up_answers: body.draft.answers,
        follow_up_state: Object.fromEntries(schema.follow_up_questions.map(q => [q.id, body.draft.answers[q.id] ?? q.default_value])),
        image_calls: 0, jev_calls: 0 } : {}) }] : [];
  });
}

/** Durable creative Apply outbox, not a harness workflow/lease service or financial ledger.
 * getState is a synchronous trusted application projection. It MUST read current
 * permissions, brief/version/lock/options/asset state for the trusted principal.
 * This boundary only releases typed handoffs; it has no provider or publish hooks.
 */
export class ApplyStore {
  constructor(path, getState) {
    this.getState = getState;
    this.db = new DatabaseSync(path);
    const dbVersion = this.db.prepare('PRAGMA user_version').get().user_version;
    if (![0, 1].includes(dbVersion)) { this.db.close(); throw new TypeError('Unsupported control outbox storage version'); }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS control_jobs (
        operation_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT NOT NULL,
        actor_id TEXT NOT NULL, action_id TEXT NOT NULL, action_hash TEXT NOT NULL,
        draft_hash TEXT NOT NULL, payload TEXT NOT NULL, operation TEXT NOT NULL, status TEXT NOT NULL,
        UNIQUE(tenant_id, project_id, action_id));
      CREATE TABLE IF NOT EXISTS control_audit (audit_id TEXT PRIMARY KEY, code TEXT NOT NULL,
        action_hash TEXT NOT NULL, operation_id TEXT);
      CREATE TABLE IF NOT EXISTS control_completions (operation_id TEXT PRIMARY KEY REFERENCES control_jobs(operation_id),
        completion_hash TEXT NOT NULL, receipt TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_open_apply ON control_jobs(tenant_id,project_id)
        WHERE status IN ('queued','ready'); PRAGMA user_version=1;`);
  }
  close() { this.db.close(); }
  state(ctx, authority = 'can_apply') {
    trusted(ctx);
    let state;
    try { state = this.getState(ctx); } catch { reject('unavailable'); }
    if (state?.[authority] !== true || !state.schema || state.schema.tenant_id !== ctx.tenant_id || state.schema.project_id !== ctx.project_id) reject('permission');
    return state;
  }
  audit(code, actionHash, operationId) {
    const id = `audit_${randomUUID()}`;
    this.db.prepare('INSERT INTO control_audit VALUES(?,?,?,?)').run(id, code, actionHash, operationId ?? null);
    return id;
  }
  execute(actionHash, fn) {
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const result = fn();
      result.audit_ref = this.audit(result.code, actionHash, result.operation_id);
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* no transaction started */ }
      const code = e instanceof Rejection ? e.code : 'unavailable';
      const result = { ok: false, code, retryable: code === 'unavailable',
        ...(e instanceof Rejection && e.current ? { current_versions: e.current } : {}) };
      try { result.audit_ref = this.audit(code, actionHash); } catch { result.audit_status = 'unavailable'; }
      return result;
    }
  }
  apply(ctx, body) {
    // Hashes only in audit; never persist invalid payloads, source strings or credentials.
    let actionHash;
    try { actionHash = hash(body); } catch { actionHash = hash(null); }
    return this.execute(actionHash, () => {
      const state = this.state(ctx);
      envelope(body);
      if (body.tenant_id !== ctx.tenant_id || body.project_id !== ctx.project_id) reject('permission');
      const prior = this.db.prepare('SELECT * FROM control_jobs WHERE tenant_id=? AND project_id=? AND action_id=?').get(ctx.tenant_id, ctx.project_id, body.action_id);
      if (prior) {
        if (prior.actor_id !== ctx.actor_id) reject('permission');
        if (prior.action_hash !== actionHash) reject('action_conflict', state.schema.expected_versions);
        return { ok: prior.status !== 'cancelled', code: prior.status === 'cancelled' ? 'cancelled' : 'replayed', operation_id: prior.operation_id, status: prior.status, replayed: true };
      }
      const tasks = validateDraft(body, state);
      if (this.db.prepare("SELECT 1 FROM control_jobs WHERE tenant_id=? AND project_id=? AND status IN ('queued','ready')").get(ctx.tenant_id, ctx.project_id)) reject('conflict', state.schema.expected_versions);
      const id = `op_${randomUUID()}`;
      const operation = { operation_version: 'creative-control-operation/1.0', kind: 'creative.control.apply',
        logical_operation_id: id, action_id: body.action_id, tenant_id: ctx.tenant_id, project_id: ctx.project_id,
        actor_id: ctx.actor_id, brief_id: body.brief_id, expected_versions: body.expected_versions,
        draft_hash: body.draft_hash, control_schema_hash: body.control_schema_hash, tasks, approval: false, purchase: false };
      this.db.prepare('INSERT INTO control_jobs VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, ctx.tenant_id, ctx.project_id, ctx.actor_id, body.action_id,
        actionHash, body.draft_hash, canonical(body), canonical(operation), 'queued');
      return { ok: true, code: 'accepted', operation_id: id, status: 'queued', replayed: false };
    });
  }
  /** Recheck just before releasing a handoff. No billable tool or production publication. */
  dispatch(ctx, operationId) {
    return this.execute(hash({ operation_id: operationId }), () => {
      const state = this.state(ctx);
      if (!validId(operationId)) reject('validation');
      const job = this.db.prepare('SELECT * FROM control_jobs WHERE operation_id=? AND tenant_id=? AND project_id=? AND actor_id=?').get(operationId, ctx.tenant_id, ctx.project_id, ctx.actor_id);
      if (!job) reject('permission');
      if (job.status === 'cancelled') reject('cancelled');
      if (job.status === 'completed') reject('already_completed');
      const body = JSON.parse(job.payload);
      const tasks = validateDraft(body, state);
      if (canonical(tasks) !== canonical(JSON.parse(job.operation).tasks)) reject('stale_schema', state.schema.expected_versions);
      if (tasks.some(t => !state.dispatchable_routes?.includes(t.kind))) reject('unavailable');
      this.db.prepare("UPDATE control_jobs SET status='ready' WHERE operation_id=?").run(operationId);
      return { ok: true, code: job.status === 'ready' ? 'replayed' : 'ready', operation_id: operationId, status: 'ready',
        replayed: job.status === 'ready', operation: JSON.parse(job.operation) };
    });
  }
  /** Trusted downstream receipt only. No provider execution, approval or billing authority. */
  acknowledge(ctx, operationId, receipt) {
    return this.execute(hash({ operation_id: operationId, receipt }), () => {
      const state = this.state(ctx, 'can_acknowledge');
      if (!validId(operationId)) reject('validation');
      const job = this.db.prepare('SELECT * FROM control_jobs WHERE operation_id=? AND tenant_id=? AND project_id=?').get(operationId, ctx.tenant_id, ctx.project_id);
      if (!job) reject('permission');
      if (!isRecord(receipt) || Object.keys(receipt).sort().join(',') !== 'applied_versions,completion_id,result_ref' ||
          !validId(receipt.completion_id) || !validId(receipt.result_ref) || !isRecord(receipt.applied_versions) ||
          Object.keys(receipt.applied_versions).sort().join(',') !== 'brief,composition,design' || Object.values(receipt.applied_versions).some(v => !validId(v))) reject('validation');
      const prior = this.db.prepare('SELECT * FROM control_completions WHERE operation_id=?').get(operationId);
      const completionHash = hash(receipt);
      if (prior) {
        if (prior.completion_hash !== completionHash) reject('action_conflict', state.schema.expected_versions);
        return { ok: true, code: 'replayed', operation_id: operationId, status: 'completed', replayed: true };
      }
      if (job.status === 'cancelled') reject('cancelled');
      if (job.status !== 'ready') reject('conflict', state.schema.expected_versions);
      const operation = JSON.parse(job.operation);
      const changedVersionKeys = operation.tasks.map(t => t.kind === 'composition.update' ? 'composition' : 'design');
      if (!equalVersions(receipt.applied_versions, state.schema.expected_versions) ||
          Object.keys(operation.expected_versions).some(key => !changedVersionKeys.includes(key) && receipt.applied_versions[key] !== operation.expected_versions[key]) ||
          operation.tasks.some(t => (t.kind === 'composition.update' ? receipt.applied_versions.composition === operation.expected_versions.composition :
            receipt.applied_versions.design === operation.expected_versions.design) || t.changes.some(change =>
            ![...state.schema.controls, ...state.schema.follow_up_questions].some(c => c.field === change.field && c.default_value === change.value)) ||
            Object.entries(t.follow_up_state ?? t.follow_up_answers ?? {}).some(([id, value]) =>
              !state.schema.follow_up_questions.some(q => q.id === id && q.default_value === value)))) {
        reject('stale_version', state.schema.expected_versions);
      }
      this.db.prepare('INSERT INTO control_completions VALUES(?,?,?)').run(operationId, completionHash, canonical(receipt));
      this.db.prepare("UPDATE control_jobs SET status='completed' WHERE operation_id=?").run(operationId);
      return { ok: true, code: 'completed', operation_id: operationId, status: 'completed', replayed: false };
    });
  }
  cancel(ctx, operationId) {
    return this.execute(hash({ operation_id: operationId }), () => {
      trusted(ctx);
      if (!validId(operationId)) reject('validation');
      // A revoked actor can withdraw an existing draft-owned handoff, never approve it.
      const job = this.db.prepare('SELECT * FROM control_jobs WHERE operation_id=? AND tenant_id=? AND project_id=? AND actor_id=?').get(operationId, ctx.tenant_id, ctx.project_id, ctx.actor_id);
      if (!job) reject('permission');
      if (job.status === 'completed') reject('already_completed');
      this.db.prepare("UPDATE control_jobs SET status='cancelled' WHERE operation_id=?").run(operationId);
      return { ok: true, code: 'cancelled', operation_id: operationId, status: 'cancelled' };
    });
  }
  counts() { return { jobs: this.db.prepare('SELECT count(*) AS n FROM control_jobs').get().n,
    // There is deliberately no billable integration in this local boundary.
    image_calls: 0, jev_calls: 0 }; }
}
