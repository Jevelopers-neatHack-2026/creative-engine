import {
  CREATIVE_TELEMETRY_SCHEMA,
  TELEMETRY_COMMERCE_MODES,
  TELEMETRY_PROVIDER_MODES,
  USAGE_PROFILE,
  TelemetryBoundaryError,
  TelemetryPrivacyError,
  assertSafePublicIdentifier,
  createTelemetryEvidence,
  createUsageObservation,
  deduplicateUsageObservations,
  deliverPendingUsageObservations,
  executeCreativeMeteredAttempt,
  projectPublicTelemetry,
  type CreativeTelemetryEvidence,
  type TelemetryEvidencePort,
  type TelemetryModeContext,
  type UsageObservationOutboxPort,
} from "../../src/telemetry/index.mjs";
import { METERING_PROPOSAL_VERSION, type MeteredAttemptRequest, type TrustedMeteringScope, type UsageObservation } from "../../src/contracts/metering.mjs";

const scope: TrustedMeteringScope = {
  tenant_id: "tenant:typecheck",
  project_id: "project:typecheck",
  budget_scope_id: "budget:typecheck",
};
const attempt: MeteredAttemptRequest = {
  schema_version: METERING_PROPOSAL_VERSION,
  ...scope,
  logical_operation_id: "logical:typecheck",
  billable_attempt_id: "attempt:typecheck",
  retry_mapping_ref: "retry-map:v1",
  environment: "test",
  billing_mode: "simulated",
  operation_kind: "planning",
  budget: { scope_id: scope.budget_scope_id, policy_version: "policy:v1" },
  provider: { name: "openai", model: "gpt-6-luna", endpoint: "https://api.example.invalid/v1/responses", sdk: { name: "adapter", version: "1" } },
};
const modes: TelemetryModeContext = {
  provider_execution_mode: TELEMETRY_PROVIDER_MODES[0],
  commerce_mode: TELEMETRY_COMMERCE_MODES[0],
};
const usage: UsageObservation = createUsageObservation({
  attempt,
  trustedScope: scope,
  usage: { input_tokens: 1, output_tokens: 2 },
  profile: USAGE_PROFILE.NORMALIZED,
  sourceObservationId: "usage:typecheck",
  transportAttemptId: "transport:typecheck",
});
const unique: readonly UsageObservation[] = deduplicateUsageObservations([usage]);
const evidence: CreativeTelemetryEvidence = createTelemetryEvidence({
  eventId: "event:typecheck",
  type: "attempt_intent",
  attempt,
  trustedScope: scope,
  modes,
  occurredAt: "2026-10-10T12:00:00.000Z",
});
const sink: TelemetryEvidencePort = {
  async append(event) { return { status: "recorded", event_id: event.event_id }; },
};
const outbox: UsageObservationOutboxPort = {
  async claimPending() { return { status: "claimed", records: [] }; },
  async acknowledge(args) { return { status: "acknowledged", source_observation_id: args.source_observation_id }; },
  async defer() { return { status: "retained" }; },
};

void executeCreativeMeteredAttempt({
  meteringPort: {
    async reserveAttempt() { return { status: "denied" }; },
    async releaseBeforeDispatch() {}, async markAttemptInFlight() { return { status: "in_flight", reservation_id: "reservation:typecheck" }; },
    async recordTransportAttempt() {}, async recordUsageObservation() { return { status: "accepted", source_observation_id: "usage:typecheck", effective_billable_attempt_id: attempt.billable_attempt_id }; },
    async settleReservation() { return { reservation_id: "reservation:typecheck", status: "held_for_reconciliation" }; }, async markOutcomeUnknown() {},
  },
  evidencePort: sink,
  request: attempt,
  trustedScope: scope,
  modes,
  dispatch: async (context) => {
    context.reservation_ref satisfies string;
    context.transport_attempt_id satisfies string;
    return { provider_outcome: "unknown", usage_observation: usage };
  },
});
void deliverPendingUsageObservations({
  meteringPort: { async recordUsageObservation() { return { status: "accepted", source_observation_id: "usage:typecheck", effective_billable_attempt_id: attempt.billable_attempt_id }; } },
  outbox,
  trustedScopeForRecord: () => scope,
});
assertSafePublicIdentifier("attempt:typecheck");
projectPublicTelemetry({ unknown_additive: { ordinary: "safe" } });
new TelemetryBoundaryError("telemetry_unavailable");
new TelemetryPrivacyError("unsafe_public_evidence");
void CREATIVE_TELEMETRY_SCHEMA;
void unique;
void evidence;

// @ts-expect-error The evidence schema is immutable to consumers.
evidence.event_type = "transport_intent";
