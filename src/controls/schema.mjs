/** Local consumer proposal; not an agreed shared-contracts publication. */
export const SCHEMA_VERSIONS = Object.freeze(['creative-controls/1.0', 'creative-controls/1.1']);
export const ACTION_VERSIONS = Object.freeze(['creative-apply/1.0', 'creative-apply/1.1']);
const definitions = Object.freeze([
  { id: 'c01', label: 'Name size', field: 'name_size', route: 'composition.update', options: ['small', 'medium', 'large'] },
  { id: 'c02', label: 'Layout', field: 'layout', route: 'composition.update', options: ['centered', 'stacked'] },
  { id: 'c03', label: 'Approved logo position', field: 'logo_position', route: 'composition.update', options: ['top', 'bottom'] },
  { id: 'c04', label: 'Artwork style', field: 'style', route: 'artwork.edit', options: ['calm', 'vibrant'] },
]);

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const isRecord = x => x !== null && typeof x === 'object' && !Array.isArray(x);
export const validId = x => typeof x === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(x);
export function equalVersions(a, b) { return canonical(a) === canonical(b); }

/** Only a trusted, versioned brief/state projection may be passed here. */
export function createControlSchema(state, version = SCHEMA_VERSIONS.at(-1)) {
  if (!SCHEMA_VERSIONS.includes(version)) throw new TypeError('Unsupported local schema version');
  if (!isRecord(state) || !validId(state.tenant_id) || !validId(state.project_id) ||
      !isRecord(state.versions) || Object.keys(state.versions).sort().join(',') !== 'brief,composition,design' ||
      Object.values(state.versions).some(v => !validId(v)) || !validId(state.brief_id) ||
      !Array.isArray(state.available_operations) || state.available_operations.some(x => !['composition.update', 'artwork.edit'].includes(x)) ||
      (state.locks !== undefined && (!Array.isArray(state.locks) || state.locks.some(x => !definitions.some(d => d.field === x)))) ||
      (state.follow_up_locks !== undefined && (!Array.isArray(state.follow_up_locks) || state.follow_up_locks.some(x => x !== 'q01'))) ||
      !isRecord(state.values) || !isRecord(state.allowed_options)) {
    throw new TypeError('Invalid trusted control state');
  }
  const controls = definitions.filter(d => state.available_operations.includes(d.route) &&
    // Logo controls require a separately permitted asset reference, never a client URL.
    (d.field !== 'logo_position' || validId(state.logo_asset_id))).map(d => {
      const configured = state.allowed_options[d.field];
      if (!Array.isArray(configured) || !configured.length || configured.some(x => !d.options.includes(x)) ||
          new Set(configured).size !== configured.length || !configured.includes(state.values[d.field])) {
        throw new TypeError('Invalid trusted option state');
      }
      return { id: d.id, label: d.label, kind: 'select', value_type: 'string', field: d.field,
        route: d.route, options: configured.map(value => ({ value, label: value[0].toUpperCase() + value.slice(1) })),
        default_value: state.values[d.field], locked: state.locks?.includes(d.field) === true,
        ...(d.field === 'logo_position' ? { asset_id: state.logo_asset_id } : {}) };
    });
  const hasLayout = controls.some(c => c.field === 'layout');
  if (hasLayout && (!isRecord(state.follow_up_answers) || Object.keys(state.follow_up_answers).some(k => k !== 'q01') ||
      !['balanced', 'name'].includes(state.follow_up_answers.q01))) throw new TypeError('Missing or invalid trusted follow-up baseline');
  return { schema_version: version, contract_status: 'local-consumer-proposal',
    tenant_id: state.tenant_id, project_id: state.project_id, brief_id: state.brief_id,
    expected_versions: { ...state.versions }, controls,
    follow_up_questions: hasLayout ? [{ id: 'q01', label: 'Stacked layout emphasis', field: 'layout_emphasis', route: 'composition.update',
      when: { control_id: 'c02', value: 'stacked' }, required: true,
      locked: state.follow_up_locks?.includes('q01') === true,
      options: [{ value: 'balanced', label: 'Balanced' }, { value: 'name', label: 'Name' }], default_value: state.follow_up_answers.q01 }] : [],
    submit_intent: 'apply', approval: false, purchase: false };
}

export function defaultDraft(schema) {
  const draft = { selections: Object.fromEntries(schema.controls.map(c => [c.id, c.default_value])), answers: {} };
  for (const q of activeQuestions(schema, draft)) draft.answers[q.id] = q.default_value;
  return draft;
}
export function activeQuestions(schema, draft) {
  return schema.follow_up_questions.filter(q => draft.selections[q.when.control_id] === q.when.value);
}

/** Defensive consumer check before rendering; application never executes schema strings. */
export function assertRenderableSchema(schema) {
  if (!isRecord(schema) || !SCHEMA_VERSIONS.includes(schema.schema_version) ||
      schema.contract_status !== 'local-consumer-proposal' || !Array.isArray(schema.controls) || schema.controls.length > definitions.length ||
      !Array.isArray(schema.follow_up_questions) || schema.follow_up_questions.length > 1 ||
      !validId(schema.tenant_id) || !validId(schema.project_id) || !validId(schema.brief_id) || !isRecord(schema.expected_versions) ||
      Object.keys(schema.expected_versions).sort().join(',') !== 'brief,composition,design' || Object.values(schema.expected_versions).some(x => !validId(x)) ||
      schema.submit_intent !== 'apply' || schema.approval !== false || schema.purchase !== false) throw new TypeError('Unsupported controls');
  const seen = new Set();
  for (const c of schema.controls) {
    const d = definitions.find(d => d.id === c.id);
    if (!d || seen.has(c.id) || c.kind !== 'select' || c.value_type !== 'string' || c.field !== d.field || c.route !== d.route ||
        c.label !== d.label || typeof c.locked !== 'boolean' || !Array.isArray(c.options) || !c.options.length ||
        c.options.some(o => !d.options.includes(o.value) || typeof o.label !== 'string' || o.label.length > 80) ||
        !c.options.some(o => o.value === c.default_value)) throw new TypeError('Unsupported controls');
    seen.add(c.id);
  }
  for (const q of schema.follow_up_questions) {
    if (q.id !== 'q01' || q.label !== 'Stacked layout emphasis' || q.when?.control_id !== 'c02' || q.when.value !== 'stacked' ||
        q.field !== 'layout_emphasis' || q.route !== 'composition.update' || typeof q.locked !== 'boolean' ||
        !['balanced', 'name'].includes(q.default_value) || q.required !== true || !Array.isArray(q.options) || q.options.length !== 2 ||
        new Set(q.options.map(o => o.value)).size !== 2 || q.options.some(o => !['balanced', 'name'].includes(o.value) || typeof o.label !== 'string')) {
      throw new TypeError('Unsupported question');
    }
  }
  return schema;
}
