import {
  AccessPreflightError,
  runAccessPreflight,
  validateAccessPlan,
  type AccessCapabilityVerifierPort,
  type AccessExecutionPorts,
  type AccessPlan,
  type NormalizedAccessPlanCell,
  type ResolvedOpenAICredential,
  type TrustedAccessScope,
} from 'creative-engine/preflight';

declare const rawPlan: unknown;
declare const trustedScope: TrustedAccessScope;
declare const ports: AccessExecutionPorts;
declare const validPlan: AccessPlan;

const normalized = validateAccessPlan(rawPlan, trustedScope);
const firstCell: NormalizedAccessPlanCell | undefined = normalized.cells[0];
const maybeScope: TrustedAccessScope | null | undefined = firstCell?.scope;
const cellError = new AccessPreflightError('invalid_mode', 'Safe type declaration check.', 'mode');
const publicErrorCode: string = cellError.code;
const bindingDigest: string = ({} as ResolvedOpenAICredential).binding.target_binding_sha256;

const capabilityPort: AccessCapabilityVerifierPort = {
  evidence_mode: 'live',
  async verifyCapability(input) {
    const target = input.target_binding;
    const deadline: string = input.deadline_at;
    return { target, deadline };
  },
  async revalidateCapability(input) {
    const priorEvidence = input.previous_evidence;
    const checkedAt: string = input.at;
    return { priorEvidence, checkedAt };
  },
};

const report = runAccessPreflight({ ...ports, capabilityVerifier: capabilityPort, plan: validPlan });
void maybeScope;
void publicErrorCode;
void bindingDigest;
void report;
