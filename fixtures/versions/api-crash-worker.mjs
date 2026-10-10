import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createCreativeApi } from "../../src/api/v1.mjs";
import { createCreativeVersionApiPorts } from "../../src/versions/api-ports.mjs";
import { CreativeVersionStore } from "../../src/versions/store.mjs";
import { createSqliteTelemetryOutbox } from "../../src/telemetry/index.mjs";

const databasePath = process.env.CREATIVE_API_DATABASE;
const objectRoot = process.env.CREATIVE_API_OBJECTS;
const actionId = process.env.CREATIVE_API_ACTION;
const callLog = process.env.CREATIVE_API_CALL_LOG;
const crashAt = process.env.CREATIVE_API_CRASH_AT;
const now = Date.parse("2026-10-10T12:30:00.000Z");
if (![databasePath, objectRoot, actionId, callLog, crashAt].every((value) => typeof value === "string" && value.length > 0)) {
  process.exit(2);
}

const brief = JSON.parse(await readFile(new URL("../../fixtures/api/brief.json", import.meta.url), "utf8"));
const plan = JSON.parse(await readFile(new URL("../../fixtures/api/generate-plan.json", import.meta.url), "utf8"));
const bytes = Buffer.from("crash-recovery exact artifact bytes");
const contentHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const scope = Object.freeze({ tenant_id: "tenant-api-1", project_id: "project-api-1", brief_id: "brief-api-1" });
const store = new CreativeVersionStore({ databasePath, objectRoot, now: () => now });
const adapter = createCreativeVersionApiPorts({
  store,
  idFactory: (() => { let next = 0; return () => `crash-worker-id-${++next}`; })(),
  faultInjector(point) { if (point === crashAt) process.exit(86); },
  otherPorts: {
    provider: {
      resolveRoute() { return { retry_mapping_ref: "retry:fixture/1", provider: { name: "fixture-provider",
        model: "fixture-model", endpoint: "test:/image", sdk: { name: "fixture-sdk", version: "1.0" } } }; },
      async generate(input) {
        appendFileSync(callLog, `${actionId}\n`, { mode: 0o600 });
        await input.recordTransportAttempt(input.transport_attempt_id);
        return { design_version_id: "design-api-crash-1",
          artifact: { artifact_id: "artifact-api-crash-1", content_hash: contentHash, media_type: "image/png" },
          artifact_bytes: Uint8Array.from(bytes), provider: "fixture-provider", model: "fixture-model",
          usage: { completeness: "complete", input_tokens: 2, output_tokens: 3 } };
      },
    },
    metering: {
      async reserveAttempt(attempt) { return { status: "reserved", reservation_id: `reservation:${attempt.billable_attempt_id}`,
        billable_attempt_id: attempt.billable_attempt_id, held_amount: { amount: "1.00", currency: "USD" },
        lease_id: `finance-lease:${attempt.billable_attempt_id}` }; },
      async releaseBeforeDispatch() { return { status: "released" }; },
      async markAttemptInFlight(input) { return { status: "in_flight", reservation_id: input.reservation_id }; },
      async recordTransportAttempt() { return { status: "recorded" }; },
      async recordUsageObservation(input) { return { status: "accepted",
        source_observation_id: input.observation.source_observation_id,
        effective_billable_attempt_id: input.observation.billable_attempt_id }; },
      async settleReservation(input) { return { status: "settled", reservation_id: input.reservation_id,
        consumed_amount: { amount: "0.10", currency: "USD" },
        released_unused_amount: { amount: "0.90", currency: "USD" } }; },
      async markOutcomeUnknown() { return { status: "held_for_reconciliation" }; },
    },
  },
});

const api = createCreativeApi({ ports: { ...adapter.ports, telemetry: {
  outbox: createSqliteTelemetryOutbox({ database: store.db, clock: () => now }),
  modes: { provider_execution_mode: "mock", commerce_mode: "simulated" },
  usage_profiles: { image_generation: "creative.normalized-token-usage/1" },
} }, now: () => now,
  idFactory: (() => { let next = 0; return () => `api-crash-id-${++next}`; })() });
const request = { contract: "CreativeApiRequest", schema_version: "1.0", event_id: `event-${actionId}`,
  request_id: `request-${actionId}`, tenant_id: scope.tenant_id, project_id: scope.project_id,
  correlation_id: `correlation-${actionId}`, producer: "versions-crash-worker",
  occurred_at: "2026-10-10T12:20:00.000Z", ingested_at: "2026-10-10T12:20:00.000Z",
  environment: "test", billing_mode: "simulated", source_refs: ["source-api-1"],
  operation: "generate", action_id: actionId,
  payload: { brief_id: scope.brief_id, plan } };
const actor = { actor_id: "actor-api-1", tenant_id: scope.tenant_id, project_id: scope.project_id,
  expires_at: "2026-10-11T00:00:00.000Z", permissions: ["creative.generate"], budget_scope_id: "budget-api-1",
  budget_policy_version: "budget-policy/1" };

const result = await api.invoke(actor, request);
if (result?.ok !== true) {
  process.stderr.write(JSON.stringify({ code: result?.error?.code ?? "unknown", field: result?.error?.field ?? "" }));
  process.exit(3);
}
store.close();
