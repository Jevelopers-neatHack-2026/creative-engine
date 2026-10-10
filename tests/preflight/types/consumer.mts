import {
  AccessPreflightError,
  runAccessPreflight,
  validateAccessPlan,
  type AccessProviderAdapter,
  type AccessCapabilityVerifierPort,
  type AccessExecutionPorts,
  type AccessPlan,
  type AuthorizationPort,
  type NormalizedAccessPlanCell,
  type ReservationVerifierPort,
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

const authorizationPort: AuthorizationPort = ports.authorizationPort;
const authorizationInput: Parameters<AuthorizationPort['verifyGrant']>[0] = {
  grant_ref: 'test:grant',
  expected: {},
  at: '2026-10-10T12:00:00.000Z',
};
const reservationInput: Parameters<ReservationVerifierPort['verifyReservation']>[0] = {
  reservation: {},
  attempt: ports.meteringRequest,
  expected: {},
  grant_ref: 'test:grant',
  authorization_evidence: {} as Parameters<ReservationVerifierPort['verifyReservation']>[0]['authorization_evidence'],
  at: '2026-10-10T12:00:00.000Z',
};
const adapter: AccessProviderAdapter = {
  evidence_mode: 'mock',
  async inspect() { return {}; },
  async dispatch(input) {
    const reservationRef: string = input.metering.reservation_ref;
    await input.metering.authorizeTransport();
    input.metering.assertTransportReady();
    return { reservationRef };
  },
};
void authorizationPort.verifyGrant(authorizationInput);
void ports.reservationVerifier.verifyReservation(reservationInput);
void adapter;

const report = runAccessPreflight({ ...ports, capabilityVerifier: capabilityPort, plan: validPlan });
void maybeScope;
void publicErrorCode;
void bindingDigest;
void report;
