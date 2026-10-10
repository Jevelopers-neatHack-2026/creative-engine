export type ControlSchemaVersion = 'creative-controls/1.0' | 'creative-controls/1.1';
export type ApplyVersion = 'creative-apply/1.0' | 'creative-apply/1.1';
export type Route = 'composition.update' | 'artwork.edit';
export const SCHEMA_VERSIONS: readonly ControlSchemaVersion[];
export const ACTION_VERSIONS: readonly ApplyVersion[];
export function isRecord(value: unknown): value is Record<string, unknown>;
export function validId(value: unknown): value is string;
export function equalVersions(a: unknown, b: unknown): boolean;
export interface TrustedPrincipal { actor_id: string; tenant_id: string; project_id: string }
export interface Versions { brief: string; design: string; composition: string }
export interface Draft { selections: Record<string, string>; answers: Record<string, string> }
export interface Control { id: string; label: string; kind: 'select'; value_type: 'string'; field: string;
  route: Route; options: { value: string; label: string }[]; default_value: string; locked: boolean; asset_id?: string }
export interface ControlSchema { schema_version: ControlSchemaVersion; contract_status: 'local-consumer-proposal';
  tenant_id: string; project_id: string; brief_id: string; expected_versions: Versions; controls: Control[];
  follow_up_questions: { id: string; label: string; field: string; route: Route; locked: boolean; when: { control_id: string; value: string }; required: boolean;
    options: { value: string; label: string }[]; default_value: string }[];
  submit_intent: 'apply'; approval: false; purchase: false }
export interface ApplyPayload { action_version: ApplyVersion; schema_version: ControlSchemaVersion; action_id: string;
  control_schema_hash: string;
  tenant_id: string; project_id: string; brief_id: string; expected_versions: Versions; intent: 'apply';
  draft: Draft; draft_hash: string; correlation_id?: string }
export interface TrustedControlState { tenant_id: string; project_id: string; brief_id: string; versions: Versions;
  available_operations: Route[]; values: Record<string, string>; allowed_options: Record<string, string[]>;
  locks?: string[]; logo_asset_id?: string; follow_up_answers: Record<string, string>; follow_up_locks?: string[] }
export interface CurrentProjection { schema: ControlSchema; can_apply: boolean; supported_schema_versions: readonly ControlSchemaVersion[];
  permitted_asset_ids: string[]; dispatchable_routes: Route[]; can_acknowledge?: boolean }
export interface ControlOperation { operation_version: 'creative-control-operation/1.0'; kind: 'creative.control.apply';
  logical_operation_id: string; action_id: string; tenant_id: string; project_id: string; actor_id: string; brief_id: string;
  expected_versions: Versions; draft_hash: string; control_schema_hash: string; tasks: { kind: Route; changes: { field: string; value: string; asset_id?: string }[];
    follow_up_answers?: Record<string, string>; follow_up_state?: Record<string, string>; image_calls?: 0; jev_calls?: 0 }[]; approval: false; purchase: false }
export type RejectionCode = 'validation' | 'unsupported_version' | 'unknown_field' | 'invalid_intent' | 'permission' | 'draft_mismatch'
  | 'stale_version' | 'stale_schema' | 'already_completed' | 'action_conflict' | 'unknown_control' | 'invalid_value' | 'locked' | 'asset_permission'
  | 'unknown_question' | 'follow_up_required' | 'no_changes' | 'conflict' | 'cancelled' | 'unavailable';
export type ApplyResult = { ok: boolean; code: RejectionCode | 'accepted' | 'replayed' | 'ready' | 'completed'; retryable?: boolean;
  operation_id?: string; status?: 'queued' | 'ready' | 'cancelled' | 'completed'; replayed?: boolean; operation?: ControlOperation;
  current_versions?: Versions; audit_ref?: string; audit_status?: 'unavailable' };
export function canonical(value: unknown): string | undefined;
export function hash(value: unknown): string;
export function createControlSchema(state: TrustedControlState, version?: ControlSchemaVersion): ControlSchema;
export function defaultDraft(schema: ControlSchema): Draft;
export function activeQuestions(schema: ControlSchema, draft: Draft): ControlSchema['follow_up_questions'];
export function assertRenderableSchema(schema: unknown): ControlSchema;
export interface ControlContractReference { contract: 'DesignControlSchema'; schema_version: '1.0';
  tenant_id: string; project_id: string; control_contract: 'creative-controls'; control_schema_version: '1.0' | '1.1';
  expected_versions: Versions; control_schema_hash: string }
export function controlContractReference(schema: ControlSchema): ControlContractReference;
export function assertControlContractBinding(envelope: unknown, schema: ControlSchema): ControlSchema;
export class ApplyStore {
  constructor(path: string, getState: (principal: TrustedPrincipal) => CurrentProjection);
  apply(principal: TrustedPrincipal, untrustedBody: unknown): ApplyResult;
  dispatch(principal: TrustedPrincipal, operationId: string): ApplyResult;
  cancel(principal: TrustedPrincipal, operationId: string): ApplyResult;
  acknowledge(trustedConsumer: TrustedPrincipal, operationId: string, receipt: { completion_id: string; result_ref: string; applied_versions: Versions }): ApplyResult;
  counts(): { jobs: number; image_calls: 0; jev_calls: 0 };
  close(): void;
}
