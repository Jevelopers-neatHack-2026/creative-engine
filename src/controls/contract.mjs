import { canonical, assertRenderableSchema } from './schema.mjs';
import { hash } from './actions.mjs';

/** Reference fields for CE-C01's local DesignControlSchema wrapper proposal.
 * Common producer/time/environment/billing/source envelope fields remain owned
 * by that boundary. This reference creates no external schema agreement.
 */
export function controlContractReference(schema) {
  assertRenderableSchema(schema);
  return { contract: 'DesignControlSchema', schema_version: '1.0',
    tenant_id: schema.tenant_id, project_id: schema.project_id,
    control_contract: 'creative-controls', control_schema_version: schema.schema_version.split('/')[1],
    expected_versions: { ...schema.expected_versions }, control_schema_hash: `sha256:${hash(schema)}` };
}
export function assertControlContractBinding(envelope, schema) {
  const expected = controlContractReference(schema);
  if (!envelope || Object.keys(expected).some(key => canonical(envelope[key]) !== canonical(expected[key]))) {
    throw new TypeError('Unsupported or mismatched local control contract binding');
  }
  return schema;
}
