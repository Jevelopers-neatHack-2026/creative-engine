import { assertRenderableSchema, defaultDraft, activeQuestions, canonical } from '/schema.mjs';
const $ = id => document.getElementById(id);
let schema, draft, lastAction, operationId, pending = false;
const messages = {
  stale_version: 'These controls are stale. Refresh controls and review the current version before applying.',
  stale_schema: 'These controls have changed. Refresh controls and review the current options before applying.',
  permission: 'Permission denied. The application must provide current authorized project access.',
  invalid_value: 'Unsupported selection. Refresh controls and choose an allowed option.',
  locked: 'This field is locked. Refresh controls to review the current locks.',
  unknown_control: 'Unknown control. Refresh controls before applying.',
  unavailable: 'Handoff unavailable. Required integration or current state is not available; no paid call was made.',
  action_conflict: 'This Apply identity belongs to a different draft. Make a new selection before applying.',
  conflict: 'Another operation is pending. Resolve it before applying another draft.',
  cancelled: 'This operation is cancelled. It cannot be handed off.',
};
async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error('Request unavailable');
  return response.json();
}
function counter(data) { if (data.counters) $('counters').textContent = `Jobs: ${data.counters.jobs} · JEV calls: ${data.counters.jev_calls} · Image calls: ${data.counters.image_calls}`; }
function error(message) { $('error').textContent = message; $('error').hidden = false; $('error').focus(); }
function result(data) {
  counter(data); $('error').hidden = true;
  if (!data.ok) { error(messages[data.code] ?? `Apply rejected (${data.code}). No operation was dispatched.`); return; }
  if (data.operation_id) operationId = data.operation_id;
  $('status').textContent = data.code === 'cancelled' ? 'Operation cancelled. No approval or purchase was created.' :
    `${data.code === 'replayed' ? 'Existing operation returned' : data.code === 'ready' ? 'Typed handoff ready' : 'Apply accepted'}: ${operationId}. No approval or purchase was created.`;
  $('draft-state').textContent = data.code === 'cancelled' ? 'Operation cancelled. Make a new draft selection to Apply again.' : 'Draft submitted. Retry or cancel the existing operation.';
  $('cancel').disabled = data.code === 'cancelled'; $('handoff').disabled = data.code === 'cancelled';
}
function dirty() {
  lastAction = undefined; $('retry').disabled = true;
  $('draft-state').textContent = 'Draft updated. Apply changes to submit.'; $('apply').disabled = pending;
  $('error').hidden = true;
}
function selectField(item, value, onChange, locked = false) {
  const wrapper = document.createElement('div'); wrapper.className = 'field'; wrapper.id = `field-${item.id}`;
  const label = document.createElement('label'); label.htmlFor = item.id; label.textContent = item.label;
  const select = document.createElement('select'); select.id = item.id; select.name = item.id; select.disabled = locked;
  for (const option of item.options) { const element = document.createElement('option'); element.value = option.value; element.textContent = option.label; select.append(element); }
  select.value = value; select.addEventListener('change', () => onChange(select.value));
  wrapper.append(label, select);
  if (locked) { const note = document.createElement('p'); note.id = `lock-${item.id}`; note.className = 'hint'; note.textContent = 'Locked by the current brief.'; select.setAttribute('aria-describedby', note.id); wrapper.append(note); }
  return wrapper;
}
function questions() {
  document.querySelectorAll('[data-question]').forEach(el => el.remove());
  const active = activeQuestions(schema, draft);
  for (const key of Object.keys(draft.answers)) if (!active.some(q => q.id === key)) delete draft.answers[key];
  for (const q of active) {
    draft.answers[q.id] ??= q.default_value;
    const field = selectField(q, draft.answers[q.id], value => { draft.answers[q.id] = value; dirty(); }, q.locked);
    field.dataset.question = 'true'; field.querySelector('select').required = q.required; $('fields').append(field);
  }
}
async function refresh() {
  try {
    const data = await api('/api/schema'); schema = assertRenderableSchema(data.schema); draft = defaultDraft(schema);
    // Keep an already accepted operation available for cancellation after refresh.
    lastAction = undefined;
    $('fields').replaceChildren(Object.assign(document.createElement('legend'), { textContent: 'Draft selections' }));
    for (const c of schema.controls) $('fields').append(selectField(c, draft.selections[c.id], value => { draft.selections[c.id] = value; questions(); dirty(); }, c.locked));
    questions(); $('draft-state').textContent = 'No draft changes.'; $('apply').disabled = true;
    $('retry').disabled = true; $('handoff').disabled = !operationId; $('cancel').disabled = !operationId;
    $('error').hidden = true; $('status').textContent = operationId ? `Controls refreshed. Existing operation: ${operationId}.` : 'No operation submitted.'; counter(data);
    $('versions').textContent = `${schema.schema_version} · brief ${schema.expected_versions.brief} · design ${schema.expected_versions.design} · composition ${schema.expected_versions.composition}`;
  } catch { error('Controls unavailable. Try Refresh controls.'); }
}
async function apply(retry = false) {
  if (pending) return;
  pending = true; $('apply').disabled = true; $('retry').disabled = true;
  $('fields').disabled = true; $('refresh').disabled = true;
  try {
    if (!retry && !lastAction) {
      const digestHex = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)))), b => b.toString(16).padStart(2, '0')).join('');
      lastAction = { action_version: `creative-apply/${schema.schema_version.split('/')[1]}`, schema_version: schema.schema_version,
        action_id: `action_${crypto.randomUUID()}`, tenant_id: schema.tenant_id, project_id: schema.project_id, brief_id: schema.brief_id,
        expected_versions: schema.expected_versions, intent: 'apply', draft: structuredClone(draft),
        control_schema_hash: `sha256:${await digestHex(schema)}`, draft_hash: await digestHex(draft) };
    }
    result(await api('/api/apply', lastAction));
  } catch { error('Response unavailable. Retry last Apply to recover the same operation identity.'); }
  finally { pending = false; $('retry').disabled = !lastAction; $('fields').disabled = false; $('refresh').disabled = false; }
}
$('controls').addEventListener('submit', event => { event.preventDefault(); apply(); });
$('retry').addEventListener('click', () => apply(true));
$('refresh').addEventListener('click', refresh);
for (const [id, path] of [['handoff', '/api/dispatch'], ['cancel', '/api/cancel']]) $(id).addEventListener('click', async () => {
  try { result(await api(path, { operation_id: operationId })); } catch { error('Response unavailable. Operation status remains unknown.'); }
});
refresh();
