// Import the actual public ESM path, without a shim, allowJs or skipLibCheck.
import { ApplyStore, createControlSchema, defaultDraft, hash, controlContractReference,
  assertControlContractBinding, SCHEMA_VERSIONS, type ApplyPayload, type TrustedControlState,
  type TrustedPrincipal, type ControlSchema } from '../../../src/controls/index.mjs';

const state: TrustedControlState = {
  tenant_id: 'tenant', project_id: 'project', brief_id: 'brief',
  versions: { brief: 'b1', design: 'd1', composition: 'c1' },
  available_operations: ['composition.update'], values: { name_size: 'medium', layout: 'stacked' },
  allowed_options: { name_size: ['medium', 'large'], layout: ['stacked'] },
  follow_up_answers: { q01: 'name' }, follow_up_locks: ['q01'],
};
const principal: TrustedPrincipal = { actor_id: 'actor', tenant_id: 'tenant', project_id: 'project' };
const schema: ControlSchema = createControlSchema(state, SCHEMA_VERSIONS[0]);
const draft = defaultDraft(schema);
const action: ApplyPayload = { action_version: 'creative-apply/1.0', schema_version: schema.schema_version,
  action_id: 'action', control_schema_hash: `sha256:${hash(schema)}`, tenant_id: 'tenant', project_id: 'project',
  brief_id: 'brief', expected_versions: state.versions, intent: 'apply', draft, draft_hash: hash(draft) };
const store = new ApplyStore(':memory:', () => ({ schema, can_apply: true, supported_schema_versions: SCHEMA_VERSIONS,
  permitted_asset_ids: [], dispatchable_routes: ['composition.update'] }));
const result = store.apply(principal, action);
if (result.operation_id) store.dispatch(principal, result.operation_id);
assertControlContractBinding(controlContractReference(schema), schema);
type IsAny<T> = 0 extends (1 & T) ? true : false;
const publicSchemaIsAny: IsAny<typeof schema> = false;
const publicResultIsAny: IsAny<typeof result> = false;
void [publicSchemaIsAny, publicResultIsAny];
// @ts-expect-error unsupported schema versions are not part of the public contract.
createControlSchema(state, 'creative-controls/2.0');
// @ts-expect-error Apply is not purchase authorization.
const privilegedAction: ApplyPayload = { ...action, intent: 'purchase' };
void privilegedAction;
store.close();
