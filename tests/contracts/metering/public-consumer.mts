import {
  MeteringContractError,
  executeMeteredAttempt,
  type MeteredAttemptRequest,
  type MeteringPort,
  type TrustedMeteringScope,
  type UsageObservation,
} from 'creative-engine/contracts/metering';
import {
  ApprovalHandoffContractError,
  createArtworkHandoff,
  createCompositionEditPlan,
  hashCompositionLayerManifest,
  validateConsumptionReceipt,
  type ApprovalBinding,
  type ArtworkHandoff,
  type ConsumptionReceipt,
  type TrustedApprovalScope,
} from 'creative-engine/contracts/approval-handoff';

declare const meteringPort: MeteringPort;
declare const meteringScope: TrustedMeteringScope;
declare const meteredRequest: MeteredAttemptRequest;
declare const approvalScope: TrustedApprovalScope;
declare const binding: ApprovalBinding;
declare const handoff: ArtworkHandoff;
declare const verifier: Parameters<typeof createArtworkHandoff>[0]['approvalVerifier'];
declare const receipt: ConsumptionReceipt;

const usageObservation: UsageObservation = {
  schema_version: 'creative.metering.proposal/v1',
  tenant_id: 'example:tenant',
  project_id: 'example:project',
  budget_scope_id: 'example:budget',
  logical_operation_id: 'example:operation',
  billable_attempt_id: 'example:billable-attempt',
  source_observation_id: 'example:observation',
  source: 'provider_response',
  provider_name: 'example:provider',
  model: 'example:model',
  environment: 'test',
  billing_mode: 'simulated',
  completeness: 'unknown',
  missing_fields: ['provider_usage'],
};
const meteringError = new MeteringContractError('invalid_input', 'Invalid input', 'attempt.provider');
const approvalError = new ApprovalHandoffContractError('approval_stale', 'Approval is stale', {
  field: 'approval',
  retryable: true,
});

export async function consumeContractDeclarations(): Promise<void> {
  const outcome = await executeMeteredAttempt({
    port: meteringPort,
    request: meteredRequest,
    trustedScope: meteringScope,
    dispatch: async ({ recordTransportAttempt }) => {
      await recordTransportAttempt('example:transport-attempt');
      return { provider_outcome: 'failed' };
    },
  });
  if (outcome.status === 'settled') {
    const exactConsumedAmount: string = outcome.settlement.consumed_amount.amount;
    void exactConsumedAmount;
  }

  const handoffDigest = hashCompositionLayerManifest({
    binding,
    artifact: handoff.artifact,
    layer_manifest: handoff.layer_manifest,
    trustedScope: approvalScope,
  });
  const plan = createCompositionEditPlan({
    plan_id: 'example:composition-plan',
    binding,
    layer_manifest: handoff.layer_manifest,
    target_composition_revision_id: 'example:composition-revision-next',
    operations: [{
      operation_id: 'example:set-name',
      kind: 'set_text',
      layer_id: 'example:name-layer',
      value: 'Jordan Avery',
    }],
    trustedScope: approvalScope,
  });
  const checkedReceipt = validateConsumptionReceipt(receipt, handoff, { trustedScope: approvalScope });
  if (plan.operations[2]?.kind === 'set_layer_layout') {
    const normalizedWidth: number | undefined = plan.operations[2].layout.width_milli;
    void normalizedWidth;
  }
  void handoffDigest;
  void plan.approval_required_after_application;
  void checkedReceipt.status;
  void verifier;
  void usageObservation;
  void meteringError;
  void approvalError;
}
