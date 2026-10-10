import test from "node:test";
import assert from "node:assert/strict";
import {
  createTelemetryEvidence,
  executeCreativeMeteredAttempt,
  TelemetryBoundaryError,
  USAGE_PROFILE,
  createUsageObservation,
} from "../../src/telemetry/index.mjs";
import { FakeMeteringAuthority } from "../../fixtures/contracts/metering/fake-authority.mjs";
import { fixtureAttempt, trustedScope } from "../../fixtures/metering/attempt.mjs";

const modes = Object.freeze({ provider_execution_mode: "live", commerce_mode: "simulated" });

function idFactory() {
  let counter = 0;
  return (kind) => `${kind}:${++counter}`;
}

function observeMetering(authority, events) {
  return new Proxy(authority, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args) => {
        events.push(`metering.${String(property)}`);
        return value.apply(target, args);
      };
    },
  });
}

function evidencePort(events, { failAt = -1 } = {}) {
  const stored = [];
  return {
    stored,
    async append(event) {
      events.push(`evidence.${event.event_type}`);
      if (stored.length === failAt) throw new Error("synthetic evidence outage");
      stored.push(structuredClone(event));
      return { status: "recorded", event_id: event.event_id };
    },
  };
}

function testObservationOutbox() {
  const records = new Map();
  return {
    records,
    async enqueueUsageObservation({ observation }) {
      const record_ref = `observation:${observation.source_observation_id}`;
      records.set(observation.source_observation_id, { record_ref, observation: structuredClone(observation), status: "pending" });
      return { status: "recorded", record_ref, source_observation_id: observation.source_observation_id, payload_hash: "sha256:test" };
    },
    async acknowledgeEnqueuedObservation(input) {
      const record = records.get(input.source_observation_id);
      if (!record || record.record_ref !== input.record_ref) return { status: "mismatch", source_observation_id: input.source_observation_id };
      record.status = "delivered";
      return { status: "acknowledged", source_observation_id: input.source_observation_id };
    },
  };
}

function runWithTelemetry(args) {
  return executeCreativeMeteredAttempt({
    observationOutbox: testObservationOutbox(),
    authorizeTransport: async ({ transport_attempt_id }) => `dispatch:${transport_attempt_id}`,
    ...args,
  });
}

function eventOutbox(events) {
  const records = new Map();
  return {
    records,
    async enqueueUsageObservation({ observation }) {
      events.push("observation.persist");
      const record_ref = `observation:${observation.source_observation_id}`;
      records.set(observation.source_observation_id, { record_ref, observation: structuredClone(observation) });
      return { status: "recorded", record_ref, source_observation_id: observation.source_observation_id, payload_hash: "sha256:test" };
    },
    async acknowledgeEnqueuedObservation(input) {
      events.push("observation.local_ack");
      assert.equal(records.get(input.source_observation_id)?.record_ref, input.record_ref);
      return { status: "acknowledged", source_observation_id: input.source_observation_id };
    },
  };
}

function successfulDispatch(events) {
  return async (context) => {
    events.push("provider.dispatch");
    const observation = createUsageObservation({
      attempt: context.attempt,
      trustedScope,
      profile: USAGE_PROFILE.NORMALIZED,
      sourceObservationId: `usage:${context.attempt.billable_attempt_id}`,
      transportAttemptId: context.transport_attempt_id,
      providerRequestId: `req:${context.attempt.billable_attempt_id}`,
      usage: { input_tokens: 11, output_tokens: 7 },
    });
    return { provider_outcome: "succeeded", usage_observation: observation };
  };
}

test("sanitized evidence is recorded before the C03 reservation, each transport, and outcome", async () => {
  const events = [];
  const authority = new FakeMeteringAuthority();
  const evidence = evidencePort(events);
  const result = await runWithTelemetry({
    meteringPort: observeMetering(authority, events),
    evidencePort: evidence,
    observationOutbox: eventOutbox(events),
    request: fixtureAttempt({ billing_mode: "live" }),
    trustedScope,
    modes,
    authorizeTransport: async ({ transport_attempt_id }) => {
      events.push("jobs.authorizeDispatch");
      return `dispatch:${transport_attempt_id}`;
    },
    dispatch: successfulDispatch(events),
    idFactory: idFactory(),
    clock: () => new Date("2026-10-10T12:00:00.000Z"),
  });
  assert.equal(result.outcome.status, "settled");
  assert.equal(result.evidence_delivery, "recorded");
  assert.deepEqual(evidence.stored.map((item) => item.event_type), ["attempt_intent", "transport_intent", "attempt_outcome"]);
  assert.equal(evidence.stored[0].provider_execution_mode, "live");
  assert.equal(evidence.stored[0].commerce_mode, "simulated");
  assert.equal(evidence.stored[0].billing_mode, "live");
  assert.equal(evidence.stored[1].reservation_ref, "test-reservation:attempt:fixture-001");
  assert.equal(evidence.stored[1].transport_attempt_id, "transport:2");
  assert.equal(evidence.stored[2].provider_request_id, "req:attempt:fixture-001");
  assert.ok(events.indexOf("evidence.attempt_intent") < events.indexOf("metering.reserveAttempt"));
  assert.ok(events.indexOf("evidence.transport_intent") < events.indexOf("jobs.authorizeDispatch"));
  assert.ok(events.indexOf("jobs.authorizeDispatch") < events.indexOf("metering.recordTransportAttempt"));
  assert.ok(events.indexOf("metering.recordTransportAttempt") < events.indexOf("provider.dispatch"));
  assert.ok(events.indexOf("observation.persist") < events.indexOf("metering.recordUsageObservation"));
  assert.ok(events.indexOf("metering.recordUsageObservation") < events.indexOf("metering.settleReservation"));
});

test("failed preflight evidence prevents reservation and provider dispatch", async () => {
  const events = [];
  const authority = new FakeMeteringAuthority();
  const evidence = evidencePort(events, { failAt: 0 });
  let dispatches = 0;
  await assert.rejects(() => runWithTelemetry({
    meteringPort: observeMetering(authority, events),
    evidencePort: evidence,
    request: fixtureAttempt(),
    trustedScope,
    modes,
    dispatch: async () => { dispatches += 1; return {}; },
    idFactory: idFactory(),
  }), TelemetryBoundaryError);
  assert.equal(dispatches, 0);
  assert.equal(authority.reservations.size, 0);
  assert.equal(events.some((entry) => entry.startsWith("metering.")), false);
});

test("invalid request keys never escape through telemetry validation diagnostics", async () => {
  const credentialKey = "ghp_SyntheticCredentialValueSyntheticCredentialValue";
  const request = { ...fixtureAttempt(), [credentialKey]: "synthetic" };
  await assert.rejects(() => runWithTelemetry({
    meteringPort: new FakeMeteringAuthority(),
    evidencePort: evidencePort([]),
    request,
    trustedScope,
    modes,
    dispatch: async () => ({}),
  }), (error) => {
    assert.equal(error.name, "TelemetryBoundaryError");
    assert.equal(error.code, "unknown_field");
    assert.equal(error.field, "telemetry");
    assert.equal(error.message.includes(credentialKey), false);
    assert.equal(JSON.stringify(error).includes(credentialKey), false);
    return true;
  });
  assert.throws(() => createTelemetryEvidence({
    eventId: "event:safe-test",
    type: "attempt_intent",
    attempt: request,
    trustedScope,
    modes,
    occurredAt: "2026-10-10T12:00:00.000Z",
  }), (error) => {
    assert.equal(error.name, "TelemetryBoundaryError");
    assert.equal(error.code, "unknown_field");
    assert.equal(error.field, "telemetry");
    assert.equal(error.message.includes(credentialKey), false);
    assert.equal(JSON.stringify(error).includes(credentialKey), false);
    return true;
  });
});

test("transport evidence failure blocks the call and C03 retains the uncertain hold", async () => {
  const events = [];
  const authority = new FakeMeteringAuthority();
  const evidence = evidencePort(events, { failAt: 1 });
  let dispatches = 0;
  const result = await runWithTelemetry({
    meteringPort: observeMetering(authority, events),
    evidencePort: evidence,
    request: fixtureAttempt(),
    trustedScope,
    modes,
    dispatch: async () => { dispatches += 1; return {}; },
    idFactory: idFactory(),
  });
  assert.equal(dispatches, 0);
  assert.equal(result.outcome.status, "dispatch_outcome_unknown");
  assert.equal(result.outcome.hold, "retained_for_reconciliation");
  assert.equal(authority.reservationFor("attempt:fixture-001").state, "held_for_reconciliation");
});

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

test("abort during transport-intent append fences the provider call and retains the C03 hold", async () => {
  const authority = new FakeMeteringAuthority();
  const controller = new AbortController();
  const entered = deferred();
  const release = deferred();
  const appendFinished = deferred();
  const stored = [];
  const evidence = {
    async append(event) {
      if (event.event_type === "transport_intent") {
        entered.resolve();
        await release.promise;
      }
      stored.push(structuredClone(event));
      if (event.event_type === "transport_intent") appendFinished.resolve();
      return { status: "recorded", event_id: event.event_id };
    },
  };
  let dispatches = 0;
  const pending = runWithTelemetry({
    meteringPort: authority, evidencePort: evidence,
    request: fixtureAttempt({ billable_attempt_id: "attempt:abort-evidence-append" }),
    trustedScope, modes, signal: controller.signal, idFactory: idFactory(),
    dispatch: async () => { dispatches += 1; return {}; },
  });
  await entered.promise;
  controller.abort();
  release.resolve();
  const result = await pending;
  await appendFinished.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dispatches, 0);
  assert.equal(result.outcome.status, "cancelled_after_dispatch");
  assert.equal(result.outcome.hold, "retained_for_reconciliation");
  assert.equal(authority.reservationFor("attempt:abort-evidence-append").state, "held_for_reconciliation");
});

test("abort during C03 transport acknowledgement fences the provider call and retains the hold", async () => {
  const authority = new FakeMeteringAuthority();
  const controller = new AbortController();
  const entered = deferred();
  const release = deferred();
  const transportFinished = deferred();
  const meteringPort = new Proxy(authority, {
    get(target, property) {
      if (property === "recordTransportAttempt") return async (...args) => {
        entered.resolve();
        await release.promise;
        const result = await target.recordTransportAttempt(...args);
        transportFinished.resolve();
        return result;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  let dispatches = 0;
  const pending = runWithTelemetry({
    meteringPort, evidencePort: evidencePort([]),
    request: fixtureAttempt({ billable_attempt_id: "attempt:abort-transport-ack" }),
    trustedScope, modes, signal: controller.signal, idFactory: idFactory(),
    dispatch: async () => { dispatches += 1; return {}; },
  });
  await entered.promise;
  controller.abort();
  release.resolve();
  const result = await pending;
  await transportFinished.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dispatches, 0);
  assert.equal(result.outcome.status, "cancelled_after_dispatch");
  assert.equal(result.outcome.hold, "retained_for_reconciliation");
  assert.equal(authority.reservationFor("attempt:abort-transport-ack").state, "held_for_reconciliation");
});

test("post-settlement evidence outage is reported as pending without converting the settled result to failure", async () => {
  const events = [];
  const authority = new FakeMeteringAuthority();
  const evidence = evidencePort(events, { failAt: 2 });
  const result = await runWithTelemetry({
    meteringPort: observeMetering(authority, events),
    evidencePort: evidence,
    request: fixtureAttempt(),
    trustedScope,
    modes,
    dispatch: successfulDispatch(events),
    idFactory: idFactory(),
  });
  assert.equal(result.outcome.status, "settled");
  assert.equal(result.evidence_delivery, "pending");
  assert.equal(result.pending_evidence.event_type, "attempt_outcome");
  assert.equal(authority.reservationFor("attempt:fixture-001").state, "settled");
});

test("public metering outcome redacts unsafe settlement references without changing Finance outcome", async () => {
  const authority = new FakeMeteringAuthority();
  const settle = authority.settleReservation.bind(authority);
  authority.settleReservation = async (command) => ({
    ...await settle(command),
    posting_refs: [
      "ghp_SyntheticCredentialValueSyntheticCredentialValue",
      "person@example.invalid",
      "posting:fixture-safe-1",
    ],
  });
  const result = await runWithTelemetry({
    meteringPort: authority,
    evidencePort: evidencePort([]),
    request: fixtureAttempt({ billable_attempt_id: "attempt:privacy-posting-refs" }),
    trustedScope,
    modes,
    dispatch: successfulDispatch([]),
    idFactory: idFactory(),
  });
  assert.equal(result.outcome.status, "settled");
  assert.equal(result.outcome.settlement.status, "settled");
  assert.deepEqual(result.outcome.settlement.posting_refs, [
    "[REDACTED]", "[REDACTED]", "posting:fixture-safe-1",
  ]);
  assert.equal(authority.reservationFor("attempt:privacy-posting-refs").state, "settled");
  const publicJson = JSON.stringify(result);
  assert.equal(publicJson.includes("ghp_SyntheticCredentialValueSyntheticCredentialValue"), false);
  assert.equal(publicJson.includes("person@example.invalid"), false);
});

test("oversized Finance metadata cannot turn a completed settlement into an execution failure", async () => {
  const authority = new FakeMeteringAuthority();
  const settle = authority.settleReservation.bind(authority);
  authority.settleReservation = async (command) => ({
    ...await settle(command),
    posting_refs: Array.from({ length: 600 }, (_, index) => `posting:fixture:${index}`),
  });
  const result = await runWithTelemetry({
    meteringPort: authority,
    evidencePort: evidencePort([]),
    request: fixtureAttempt({ billable_attempt_id: "attempt:oversized-settlement-metadata" }),
    trustedScope,
    modes,
    dispatch: successfulDispatch([]),
    idFactory: idFactory(),
  });
  assert.equal(result.outcome.status, "settled");
  assert.equal(result.outcome.settlement.status, "settled");
  assert.equal("posting_refs" in result.outcome.settlement, false);
  assert.equal(authority.reservationFor("attempt:oversized-settlement-metadata").state, "settled");
});

test("C03 authoritative atomic reservation prevents the losing concurrent attempt from dispatching", async () => {
  const authority = new FakeMeteringAuthority({ budget: "0.08", defaultHold: "0.08" });
  const evidence = evidencePort([]);
  const sharedIdFactory = idFactory();
  let dispatches = 0;
  const run = (attempt) => runWithTelemetry({
    meteringPort: authority,
    evidencePort: evidence,
    request: attempt,
    trustedScope,
    modes: { provider_execution_mode: "mock", commerce_mode: "simulated" },
    dispatch: async (context) => {
      dispatches += 1;
      return successfulDispatch([])(context);
    },
    idFactory: sharedIdFactory,
  });
  const [one, two] = await Promise.all([
    run(fixtureAttempt({ logical_operation_id: "logical:concurrent", billable_attempt_id: "attempt:concurrent-1" })),
    run(fixtureAttempt({ logical_operation_id: "logical:concurrent", billable_attempt_id: "attempt:concurrent-2" })),
  ]);
  assert.deepEqual([one.outcome.status, two.outcome.status].sort(), ["reservation_denied", "settled"]);
  assert.equal(dispatches, 1);
  assert.equal(authority.effectiveChargeCount, 1);
});

test("telemetry mode tags remain independent of simulated commerce and unknown is explicit", async () => {
  const unknownModes = { provider_execution_mode: "unknown", commerce_mode: "unknown" };
  const evidence = evidencePort([]);
  const result = await runWithTelemetry({
    meteringPort: new FakeMeteringAuthority(),
    evidencePort: evidence,
    request: fixtureAttempt({ billing_mode: "sandbox" }),
    trustedScope,
    modes: unknownModes,
    dispatch: successfulDispatch([]),
    idFactory: idFactory(),
  });
  assert.equal(result.outcome.status, "settled");
  assert.equal(result.evidence_delivery, "recorded");
  assert.equal(evidence.stored[0].provider_execution_mode, "unknown");
  assert.equal(evidence.stored[0].commerce_mode, "unknown");
  assert.equal(evidence.stored[0].billing_mode, "sandbox");
});

test("every C03 billable operation family can carry an attempt-bound observation", async () => {
  const operationKinds = [
    "image_generation", "image_edit", "responses_orchestration", "planning",
    "vision_observation", "jev_decision", "baseline_evaluation",
  ];
  const authority = new FakeMeteringAuthority({ budget: "2.00", defaultHold: "0.08" });
  const evidence = evidencePort([]);
  const sharedIdFactory = idFactory();
  for (const [index, operationKind] of operationKinds.entries()) {
    const attempt = fixtureAttempt({
      logical_operation_id: `logical:family-${operationKind}`,
      billable_attempt_id: `attempt:family-${operationKind}`,
      operation_kind: operationKind,
    });
    const result = await runWithTelemetry({
      meteringPort: authority,
      evidencePort: evidence,
      request: attempt,
      trustedScope,
      modes: { provider_execution_mode: "mock", commerce_mode: "simulated" },
      dispatch: async (context) => ({
        provider_outcome: index === 0 ? "failed" : "succeeded",
        usage_observation: createUsageObservation({
          attempt: context.attempt,
          trustedScope,
          sourceObservationId: `usage:family-${index}`,
          transportAttemptId: context.transport_attempt_id,
          providerRequestId: `req:family-${index}`,
          profile: USAGE_PROFILE.NORMALIZED,
          usage: { input_tokens: 3, output_tokens: 2 },
        }),
      }),
      idFactory: sharedIdFactory,
    });
    assert.equal(result.outcome.status, "settled");
    assert.equal(result.outcome.provider_outcome, index === 0 ? "failed" : "succeeded");
  }
  assert.equal(authority.reservations.size, operationKinds.length);
  assert.equal(authority.observationsById.size, operationKinds.length);
});

test("two billable retries for one logical operation retain separate attempt and transport IDs", async () => {
  const authority = new FakeMeteringAuthority({ budget: "1.00", defaultHold: "0.08" });
  const evidence = evidencePort([]);
  const sharedIdFactory = idFactory();
  for (const [index, attemptId] of ["attempt:retry-1", "attempt:retry-2"].entries()) {
    const result = await runWithTelemetry({
      meteringPort: authority,
      evidencePort: evidence,
      request: fixtureAttempt({ logical_operation_id: "logical:retry-series", billable_attempt_id: attemptId }),
      trustedScope,
      modes,
      dispatch: async (context) => {
        await context.recordTransportAttempt(`transport:retry-${index + 2}`);
        return {
          provider_outcome: index === 0 ? "failed" : "succeeded",
          usage_observation: createUsageObservation({
            attempt: context.attempt,
            trustedScope,
            sourceObservationId: `usage:retry-${index + 1}`,
            transportAttemptId: `transport:retry-${index + 2}`,
            providerRequestId: `req:retry-${index + 1}`,
            profile: USAGE_PROFILE.NORMALIZED,
            usage: { input_tokens: 4, output_tokens: 2 },
          }),
        };
      },
      idFactory: sharedIdFactory,
    });
    assert.equal(result.outcome.status, "settled");
  }
  const reservations = [authority.reservationFor("attempt:retry-1"), authority.reservationFor("attempt:retry-2")];
  assert.equal(reservations.length, 2);
  assert.deepEqual(reservations.map((item) => item.transport_attempt_ids.length), [2, 2]);
  assert.equal(authority.effectiveChargeCount, 2);
  const transportEvents = evidence.stored.filter((event) => event.event_type === "transport_intent");
  assert.equal(transportEvents.length, 4);
  assert.equal(new Set(transportEvents.map((event) => event.transport_attempt_id)).size, 4);
  assert.deepEqual(authority.observationsById.get("usage:retry-1").provider_request_id, "req:retry-1");
  assert.deepEqual(authority.observationsById.get("usage:retry-2").provider_request_id, "req:retry-2");
});

test("missing usage, lost response, cancellation and lease expiry retain C03 holds", async () => {
  const authority = new FakeMeteringAuthority({ budget: "1.00", defaultHold: "0.08" });
  const evidence = evidencePort([]);
  const ids = idFactory();
  const missing = await runWithTelemetry({
    meteringPort: authority,
    evidencePort: evidence,
    request: fixtureAttempt({ billable_attempt_id: "attempt:unknown-usage" }),
    trustedScope,
    modes,
    dispatch: async () => ({ provider_outcome: "failed" }),
    idFactory: ids,
  });
  assert.equal(missing.outcome.status, "usage_unknown");
  assert.equal(authority.reservationFor("attempt:unknown-usage").state, "held_for_reconciliation");

  const lost = await runWithTelemetry({
    meteringPort: authority,
    evidencePort: evidence,
    request: fixtureAttempt({ billable_attempt_id: "attempt:lost-response" }),
    trustedScope,
    modes,
    dispatch: async () => { throw new Error("synthetic response loss"); },
    idFactory: ids,
  });
  assert.equal(lost.outcome.status, "dispatch_outcome_unknown");
  assert.equal(authority.reservationFor("attempt:lost-response").state, "held_for_reconciliation");

  const controller = new AbortController();
  const cancelled = await runWithTelemetry({
    meteringPort: authority,
    evidencePort: evidence,
    request: fixtureAttempt({ billable_attempt_id: "attempt:cancelled" }),
    trustedScope,
    modes,
    signal: controller.signal,
    dispatch: async (context) => new Promise((resolve) => {
      setTimeout(() => controller.abort(), 0);
      setTimeout(() => resolve({
        provider_outcome: "succeeded",
        usage_observation: createUsageObservation({
          attempt: context.attempt, trustedScope,
          sourceObservationId: "usage:late-cancelled",
          transportAttemptId: context.transport_attempt_id,
          profile: USAGE_PROFILE.NORMALIZED,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      }), 10);
    }),
    idFactory: ids,
  });
  assert.equal(cancelled.outcome.status, "cancelled_after_dispatch");
  assert.equal(cancelled.outcome.hold, "retained_for_reconciliation");
  assert.equal(authority.reservationFor("attempt:cancelled").state, "held_for_reconciliation");

  const leaseAttempt = fixtureAttempt({ billable_attempt_id: "attempt:lease-expired" });
  const leased = await runWithTelemetry({
    meteringPort: authority,
    evidencePort: evidence,
    request: leaseAttempt,
    trustedScope,
    modes,
    dispatch: async (context) => new Promise((resolve) => {
      setTimeout(() => authority.expireWorkerLease(leaseAttempt.billable_attempt_id), 0);
      setTimeout(() => resolve({
        provider_outcome: "succeeded",
        usage_observation: createUsageObservation({
          attempt: context.attempt, trustedScope,
          sourceObservationId: "usage:lease-expired",
          transportAttemptId: context.transport_attempt_id,
          profile: USAGE_PROFILE.NORMALIZED,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      }), 10);
    }),
    idFactory: ids,
  });
  assert.equal(leased.outcome.status, "settlement_pending");
  assert.equal(leased.outcome.settlement.status, "held_for_reconciliation");
  assert.equal(authority.reservationFor("attempt:lease-expired").state, "held_for_reconciliation");
});
