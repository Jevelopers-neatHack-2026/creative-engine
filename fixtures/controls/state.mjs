import { createControlSchema, SCHEMA_VERSIONS, defaultDraft } from '../../src/controls/schema.mjs';
import { hash } from '../../src/controls/actions.mjs';

export const principal = Object.freeze({ actor_id: 'fixture_actor', tenant_id: 'fixture_tenant', project_id: 'fixture_project' });
export function fixtureState() {
  return { tenant_id: principal.tenant_id, project_id: principal.project_id, brief_id: 'brief_fixture',
    versions: { brief: 'brief_v1', design: 'design_v1', composition: 'composition_v1' },
    available_operations: ['composition.update', 'artwork.edit'],
    values: { name_size: 'medium', layout: 'centered', logo_position: 'top', style: 'calm' },
    follow_up_answers: { q01: 'balanced' }, follow_up_locks: [],
    allowed_options: { name_size: ['small', 'medium', 'large'], layout: ['centered', 'stacked'], logo_position: ['top', 'bottom'], style: ['calm', 'vibrant'] },
    locks: ['logo_position'], logo_asset_id: 'fixture_approved_logo',
    can_apply: true, permitted_asset_ids: ['fixture_approved_logo'],
    dispatchable_routes: ['composition.update'] };
}
export function projection(state) {
  return { schema: createControlSchema(state), can_apply: state.can_apply,
    supported_schema_versions: SCHEMA_VERSIONS, permitted_asset_ids: state.permitted_asset_ids,
    dispatchable_routes: state.dispatchable_routes, can_acknowledge: state.can_acknowledge === true };
}
export function action(state, overrides = {}) {
  const schema = createControlSchema(state, overrides.schema_version);
  const draft = defaultDraft(schema);
  draft.selections.c01 = 'large';
  const body = { action_version: 'creative-apply/1.1', schema_version: schema.schema_version,
    action_id: 'fixture_action', tenant_id: principal.tenant_id, project_id: principal.project_id,
    control_schema_hash: `sha256:${hash(schema)}`,
    brief_id: schema.brief_id, expected_versions: schema.expected_versions, intent: 'apply', draft,
    draft_hash: hash(draft), ...overrides };
  return body;
}
