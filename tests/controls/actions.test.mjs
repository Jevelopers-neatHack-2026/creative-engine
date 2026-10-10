import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { ApplyStore, hash } from '../../src/controls/actions.mjs';
import { createControlSchema, defaultDraft, assertRenderableSchema, canonical } from '../../src/controls/schema.mjs';
import { controlContractReference, assertControlContractBinding } from '../../src/controls/contract.mjs';
import { assertSupportedRuntime } from '../../src/controls/runtime.mjs';
import { action, fixtureState, principal, projection } from '../../fixtures/controls/state.mjs';

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'creative-controls-'));
  const path = join(dir, 'outbox.sqlite');
  const state = fixtureState();
  let store = new ApplyStore(path, () => projection(state));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { state, get store() { return store; }, path,
    restart() { store.close(); store = new ApplyStore(path, () => projection(state)); return store; } };
}

test('controls reject unsupported runtime lines with an explicit upgrade target', () => {
  assert.doesNotThrow(() => assertSupportedRuntime());
  for (const version of ['20.20.0', '22.13.0', '22.23.2', '23.11.0', '24.14.0', '25.0.0', 'invalid']) {
    assert.throws(() => assertSupportedRuntime(version), /Node 22\.23\.3/);
  }
});

test('typed composition Apply creates one durable handoff; lost-response replay survives restart', t => {
  const f = setup(t), body = action(f.state);
  const accepted = f.store.apply(principal, body);
  assert.equal(accepted.code, 'accepted');
  const replay = f.restart().apply(principal, body);
  assert.equal(replay.code, 'replayed');
  assert.equal(replay.operation_id, accepted.operation_id);
  const ready = f.store.dispatch(principal, accepted.operation_id);
  assert.equal(ready.code, 'ready');
  assert.deepEqual(ready.operation.tasks, [{ kind: 'composition.update', changes: [{ field: 'name_size', value: 'large' }], follow_up_answers: {}, follow_up_state: { q01: 'balanced' }, image_calls: 0, jev_calls: 0 }]);
  assert.equal(ready.operation.approval, false);
  assert.equal(ready.operation.purchase, false);
  assert.equal(f.store.dispatch(principal, accepted.operation_id).code, 'replayed');
  assert.deepEqual(f.store.counts(), { jobs: 1, image_calls: 0, jev_calls: 0 });
});

test('rejections are typed, sanitized and create no jobs', t => {
  const f = setup(t);
  const draftCase = change => { const a = action(f.state); change(a.draft); a.draft_hash = hash(a.draft); return a; };
  const cases = [
    [action(f.state, { tenant_id: 'forged' }), 'permission'],
    [action(f.state, { project_id: 'forged' }), 'permission'],
    [action(f.state, { actor_id: 'forged_admin' }), 'unknown_field'],
    [action(f.state, { intent: 'purchase' }), 'invalid_intent'],
    [action(f.state, { locks: [] }), 'unknown_field'],
    [action(f.state, { html: '<script>window.attack=true</script>' }), 'unknown_field'],
    [action(f.state, { action_version: 'creative-apply/2.0' }), 'unsupported_version'],
    [action(f.state, { schema_version: 'creative-controls/1.0' }), 'unsupported_version'],
    [action(f.state, { expected_versions: { ...f.state.versions, brief: 'old' } }), 'stale_version'],
    [action(f.state, { expected_versions: { ...f.state.versions, design: 'old' } }), 'stale_version'],
    [action(f.state, { expected_versions: { ...f.state.versions, composition: 'old' } }), 'stale_version'],
    [action(f.state, { draft_hash: '0'.repeat(64) }), 'draft_mismatch'],
    [draftCase(d => { delete d.selections.c01; d.selections.unknown = 'large'; }), 'unknown_control'],
    [draftCase(d => { d.selections.c01 = '<script>'; }), 'invalid_value'],
    [draftCase(d => { d.selections.c03 = 'bottom'; }), 'locked'],
    [draftCase(d => { d.selections.c02 = 'stacked'; }), 'follow_up_required'],
    [draftCase(d => { d.answers.unknown = 'balanced'; }), 'unknown_question'],
    [draftCase(d => { d.selections.c01 = 'medium'; }), 'no_changes'],
  ];
  for (const [body, code] of cases) {
    const result = f.store.apply(principal, body);
    assert.equal(result.code, code, canonical(body));
    assert.match(result.audit_ref, /^audit_/);
    assert.equal(JSON.stringify(result).includes('<script>'), false);
  }
  assert.equal(f.store.apply({ ...principal, tenant_id: 'forged' }, action(f.state)).code, 'permission');
  assert.equal(f.store.apply(undefined, action(f.state)).code, 'permission');
  assert.deepEqual(f.store.counts(), { jobs: 0, image_calls: 0, jev_calls: 0 });
  const audits = f.store.db.prepare('SELECT * FROM control_audit').all();
  assert.equal(audits.length, cases.length + 2);
  assert.equal(JSON.stringify(audits).includes('forged'), false);
});

test('older negotiated versions and optional fields; unknown additive fields rejected explicitly', t => {
  const f = setup(t);
  const old = action(f.state, { action_version: 'creative-apply/1.0', schema_version: 'creative-controls/1.0', correlation_id: 'journey_fixture' });
  assert.equal(createControlSchema(f.state, old.schema_version).schema_version, old.schema_version);
  assert.equal(f.store.apply(principal, old).code, 'accepted');
  assert.equal(f.store.apply(principal, { ...old, extra: true }).code, 'unknown_field');
  assert.throws(() => createControlSchema(f.state, 'creative-controls/0.9'));
});

test('follow-up answers are bounded; artwork and compound changes stay typed without paid calls', t => {
  const f = setup(t), a = action(f.state);
  a.draft.selections.c02 = 'stacked'; a.draft.answers.q01 = 'name'; a.draft.selections.c04 = 'vibrant'; a.draft_hash = hash(a.draft);
  const r = f.store.apply(principal, a);
  assert.equal(r.code, 'accepted');
  const op = JSON.parse(f.store.db.prepare('SELECT operation FROM control_jobs').get().operation);
  assert.deepEqual(op.tasks.map(t => t.kind), ['composition.update', 'artwork.edit']);
  assert.equal(op.tasks[0].follow_up_answers.q01, 'name');
  assert.equal(f.store.dispatch(principal, r.operation_id).code, 'unavailable');
  assert.equal(f.store.db.prepare('SELECT status FROM control_jobs').get().status, 'queued');
  assert.deepEqual(f.store.counts(), { jobs: 1, image_calls: 0, jev_calls: 0 });
});

test('locks, options, versions, permissions and assets rechecked before handoff', t => {
  for (const [mutate, expected] of [
    [s => { s.can_apply = false; }, 'permission'],
    [s => { s.versions.design = 'design_v2'; }, 'stale_version'],
    [s => { s.locks.push('name_size'); }, 'stale_schema'],
    [s => { s.allowed_options.name_size = ['medium']; }, 'stale_schema'],
    [s => { s.permitted_asset_ids = []; }, 'asset_permission'],
  ]) {
    const s = fixtureState(), store = new ApplyStore(':memory:', () => projection(s));
    t.after(() => store.close());
    const a = store.apply(principal, action(s)); assert.equal(a.code, 'accepted');
    mutate(s);
    assert.equal(store.dispatch(principal, a.operation_id).code, expected);
    assert.equal(store.db.prepare('SELECT status FROM control_jobs').get().status, 'queued');
  }
});

test('cancelled operation cannot dispatch/replay late; cross-tenant job access denied', t => {
  const f = setup(t), body = action(f.state), a = f.store.apply(principal, body);
  assert.equal(f.store.cancel({ ...principal, tenant_id: 'forged' }, a.operation_id).code, 'permission');
  assert.equal(f.store.dispatch({ ...principal, tenant_id: 'forged' }, a.operation_id).code, 'permission');
  f.state.can_apply = false;
  assert.equal(f.store.cancel(principal, a.operation_id).code, 'cancelled');
  f.state.can_apply = true;
  assert.equal(f.restart().dispatch(principal, a.operation_id).code, 'cancelled');
  assert.equal(f.store.apply(principal, body).code, 'cancelled');
  assert.deepEqual(f.store.counts(), { jobs: 1, image_calls: 0, jev_calls: 0 });
});

test('same action identity with different meaning conflicts; independent concurrent changes never silently rebase', t => {
  const f = setup(t), a = action(f.state);
  assert.equal(f.store.apply(principal, a).code, 'accepted');
  const changed = structuredClone(a); changed.draft.selections.c01 = 'small'; changed.draft_hash = hash(changed.draft);
  assert.equal(f.store.apply(principal, changed).code, 'action_conflict');
  changed.action_id = 'new_action';
  const conflict = f.store.apply(principal, changed);
  assert.equal(conflict.code, 'conflict'); assert.deepEqual(conflict.current_versions, f.state.versions);
  assert.equal(f.store.apply({ ...principal, actor_id: 'other_actor' }, a).code, 'permission');
});

test('simultaneous independent SQLite connections atomically dedup action and job', async t => {
  const f = setup(t);
  const results = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./concurrent-worker.mjs', import.meta.url), { workerData: { path: f.path } });
    worker.on('message', resolve); worker.on('error', reject);
  })));
  assert.equal(results.filter(r => r.code === 'accepted').length, 1);
  assert.equal(results.filter(r => r.code === 'replayed').length, 3);
  assert.equal(new Set(results.map(r => r.operation_id)).size, 1);
  assert.equal(f.restart().counts().jobs, 1);
});

test('SQLite rollback makes interrupted partial insert invisible after restart', t => {
  const f = setup(t), originalAudit = f.store.audit;
  f.store.audit = () => { throw new Error('simulated interruption before commit'); };
  assert.equal(f.store.apply(principal, action(f.state)).code, 'unavailable');
  f.store.audit = originalAudit;
  assert.equal(f.restart().counts().jobs, 0);
  assert.equal(f.store.apply(principal, action(f.state)).code, 'accepted');
});

test('durable restarted queued action revalidates stale and revoked current state before handoff', t => {
  const f = setup(t), a = f.store.apply(principal, action(f.state));
  f.restart(); f.state.versions.design = 'design_v2';
  assert.equal(f.store.dispatch(principal, a.operation_id).code, 'stale_version');
  const oldBody = action(f.state, { action_id: 'second_action', expected_versions: { ...f.state.versions, design: 'design_v1' } });
  assert.equal(f.store.apply(principal, oldBody).code, 'stale_version');
  f.restart(); f.state.can_apply = false;
  assert.equal(f.store.dispatch(principal, a.operation_id).code, 'permission');
  assert.deepEqual(f.store.counts(), { jobs: 1, image_calls: 0, jev_calls: 0 });
});

test('same-version schema mutation cannot reinterpret Apply or return different immutable tasks', t => {
  const f = setup(t), body = action(f.state), accepted = f.store.apply(principal, body);
  f.state.values.name_size = 'small';
  assert.equal(f.store.apply(principal, { ...body, action_id: 'next_action' }).code, 'stale_schema');
  assert.equal(f.restart().dispatch(principal, accepted.operation_id).code, 'stale_schema');
  assert.equal(f.store.counts().jobs, 1);
});

test('authorized durable completion frees the next actual version Apply without cancellation', t => {
  const f = setup(t), a = f.store.apply(principal, action(f.state));
  const consumer = { ...principal, actor_id: 'fixture_harness_consumer' };
  const receipt = { completion_id: 'completion_fixture', result_ref: 'composition_fixture_v2', applied_versions: { ...f.state.versions, composition: 'composition_v2' } };
  assert.equal(f.store.acknowledge(consumer, a.operation_id, receipt).code, 'permission');
  f.state.can_acknowledge = true;
  assert.equal(f.store.acknowledge(consumer, a.operation_id, receipt).code, 'conflict');
  assert.equal(f.store.dispatch(principal, a.operation_id).code, 'ready');
  assert.equal(f.store.acknowledge(consumer, a.operation_id, receipt).code, 'stale_version');
  f.state.versions.composition = 'composition_v2'; f.state.values.name_size = 'large';
  f.state.versions.design = 'unexpected_design';
  assert.equal(f.store.acknowledge(consumer, a.operation_id, { ...receipt, applied_versions: { ...f.state.versions } }).code, 'stale_version');
  f.state.versions.design = 'design_v1';
  assert.equal(f.store.acknowledge(consumer, a.operation_id, receipt).code, 'completed');
  f.restart();
  assert.equal(f.store.acknowledge(consumer, a.operation_id, receipt).code, 'replayed');
  assert.equal(f.store.acknowledge(consumer, a.operation_id, { ...receipt, result_ref: 'tampered_result' }).code, 'action_conflict');
  assert.equal(f.store.cancel(principal, a.operation_id).code, 'already_completed');
  assert.equal(f.store.dispatch(principal, a.operation_id).code, 'already_completed');
  const next = action(f.state, { action_id: 'next_version_action' });
  next.draft.selections.c01 = 'small'; next.draft_hash = hash(next.draft);
  assert.equal(f.store.apply(principal, next).code, 'accepted');
  assert.deepEqual(f.store.counts(), { jobs: 2, image_calls: 0, jev_calls: 0 });
});

test('follow-up-only edit completes and the next size edit preserves the acknowledged emphasis', t => {
  const f = setup(t); f.state.values.layout = 'stacked';
  const body = action(f.state);
  body.draft.selections.c01 = f.state.values.name_size;
  body.draft.answers.q01 = 'name'; body.draft_hash = hash(body.draft);
  const first = f.store.apply(principal, body);
  assert.equal(first.code, 'accepted');
  const handoff = f.store.dispatch(principal, first.operation_id);
  assert.deepEqual(handoff.operation.tasks[0].changes, [{ field: 'layout_emphasis', value: 'name' }]);
  assert.deepEqual(handoff.operation.tasks[0].follow_up_answers, { q01: 'name' });
  f.state.can_acknowledge = true; f.state.versions.composition = 'composition_v2';
  const receipt = { completion_id: 'emphasis_complete', result_ref: 'composition_v2', applied_versions: { ...f.state.versions } };
  assert.equal(f.store.acknowledge(principal, first.operation_id, receipt).code, 'stale_version');
  f.state.follow_up_answers.q01 = 'name';
  assert.equal(f.store.acknowledge(principal, first.operation_id, receipt).code, 'completed');
  f.restart();
  assert.deepEqual(defaultDraft(createControlSchema(f.state)).answers, { q01: 'name' });
  const next = action(f.state, { action_id: 'next_size_edit' });
  assert.equal(next.draft.answers.q01, 'name');
  const second = f.store.apply(principal, next);
  const nextHandoff = f.store.dispatch(principal, second.operation_id);
  assert.deepEqual(nextHandoff.operation.tasks[0].changes, [{ field: 'name_size', value: 'large' }]);
  assert.deepEqual(nextHandoff.operation.tasks[0].follow_up_answers, { q01: 'name' });
  f.state.versions.composition = 'composition_v3'; f.state.values.name_size = 'large';
  f.state.follow_up_answers.q01 = 'balanced';
  assert.equal(f.store.acknowledge(principal, second.operation_id, { completion_id: 'size_complete', result_ref: 'composition_v3',
    applied_versions: { ...f.state.versions } }).code, 'stale_version');
  f.state.follow_up_answers.q01 = 'name';
  assert.equal(f.store.acknowledge(principal, second.operation_id, { completion_id: 'size_complete', result_ref: 'composition_v3',
    applied_versions: { ...f.state.versions } }).code, 'completed');
  assert.equal(f.state.follow_up_answers.q01, 'name');
});

test('follow-up locks and same-version baseline changes cannot bypass draft or dispatch validation', t => {
  const f = setup(t); f.state.values.layout = 'stacked'; f.state.follow_up_answers.q01 = 'name'; f.state.follow_up_locks = ['q01'];
  const locked = action(f.state); locked.draft.answers.q01 = 'balanced'; locked.draft_hash = hash(locked.draft);
  assert.equal(f.store.apply(principal, locked).code, 'locked');
  f.state.follow_up_locks = [];
  const body = action(f.state); body.draft.selections.c01 = 'medium'; body.draft.answers.q01 = 'balanced'; body.draft_hash = hash(body.draft);
  const accepted = f.store.apply(principal, body);
  assert.equal(accepted.code, 'accepted');
  f.state.follow_up_locks = ['q01'];
  assert.equal(f.store.dispatch(principal, accepted.operation_id).code, 'stale_schema');
  f.state.follow_up_locks = []; f.state.follow_up_answers.q01 = 'balanced';
  assert.equal(f.store.dispatch(principal, accepted.operation_id).code, 'stale_schema');
  assert.equal(f.store.counts().jobs, 1);
});

test('inactive follow-up baseline is retained and absent trusted baseline fails closed', t => {
  const f = setup(t); f.state.follow_up_answers.q01 = 'name';
  const body = action(f.state); body.draft.selections.c01 = 'medium'; body.draft.selections.c02 = 'stacked'; body.draft.answers.q01 = 'name'; body.draft_hash = hash(body.draft);
  const accepted = f.store.apply(principal, body);
  const result = f.store.dispatch(principal, accepted.operation_id);
  assert.deepEqual(result.operation.tasks[0].changes, [{ field: 'layout', value: 'stacked' }]);
  assert.deepEqual(result.operation.tasks[0].follow_up_answers, { q01: 'name' });
  const bad = fixtureState(); delete bad.follow_up_answers;
  assert.throws(() => createControlSchema(bad), /trusted follow-up baseline/);
  const inactive = setup(t); inactive.state.follow_up_answers.q01 = 'name';
  const pending = inactive.store.apply(principal, action(inactive.state));
  const handoff = inactive.store.dispatch(principal, pending.operation_id);
  assert.deepEqual(handoff.operation.tasks[0].follow_up_answers, {});
  assert.deepEqual(handoff.operation.tasks[0].follow_up_state, { q01: 'name' });
  inactive.state.can_acknowledge = true; inactive.state.versions.composition = 'composition_v2'; inactive.state.values.name_size = 'large';
  inactive.state.follow_up_answers.q01 = 'balanced';
  const receipt = { completion_id: 'inactive_complete', result_ref: 'inactive_v2', applied_versions: { ...inactive.state.versions } };
  assert.equal(inactive.store.acknowledge(principal, pending.operation_id, receipt).code, 'stale_version');
  inactive.state.follow_up_answers.q01 = 'name';
  assert.equal(inactive.store.acknowledge(principal, pending.operation_id, receipt).code, 'completed');
});

test('schema producer and consumer reject nonallowlisted rendering; permission controls are derived', () => {
  const s = fixtureState(); assertRenderableSchema(createControlSchema(s));
  const bad = createControlSchema(s); bad.controls[0].kind = 'script';
  assert.throws(() => assertRenderableSchema(bad));
  s.available_operations = ['composition.update'];
  assert.equal(createControlSchema(s).controls.some(c => c.field === 'style'), false);
  delete s.logo_asset_id;
  assert.equal(createControlSchema(s).controls.some(c => c.field === 'logo_position'), false);
});

test('local wrapper binding checks exact hash, versions and scope for both supported consumers', () => {
  for (const version of ['creative-controls/1.0', 'creative-controls/1.1']) {
    const schema = createControlSchema(fixtureState(), version), wrapper = controlContractReference(schema);
    assert.equal(wrapper.schema_version, '1.0'); assert.equal(wrapper.control_schema_version, version.split('/')[1]);
    assertControlContractBinding({ ...wrapper, producer: 'creative-engine-fixture' }, schema);
    for (const tamper of [{ schema_version: '2.0' }, { control_schema_version: '1.2' }, { tenant_id: 'forged' },
      { control_schema_hash: `sha256:${'0'.repeat(64)}` }, { expected_versions: { ...schema.expected_versions, design: 'old' } }]) {
      assert.throws(() => assertControlContractBinding({ ...wrapper, ...tamper }, schema));
    }
  }
});

test('serialized producer/consumer fixtures cover valid, invalid, old and unknown-field policies', t => {
  const f = setup(t);
  for (const [name, code] of [['valid', 'accepted'], ['invalid', 'invalid_value'], ['older', 'accepted'], ['unknown-field', 'unknown_field']]) {
    const fixture = JSON.parse(readFileSync(new URL(`../../fixtures/controls/${name}.json`, import.meta.url)));
    assertControlContractBinding(fixture.control_reference, fixture.schema);
    assert.equal(f.store.apply(principal, fixture.action).code, code);
    if (code === 'accepted') f.store.cancel(principal, f.store.db.prepare('SELECT operation_id FROM control_jobs WHERE action_id=?').get(fixture.action.action_id).operation_id);
  }
});
