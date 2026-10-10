import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createUsageObservation, deduplicateUsageObservations, USAGE_PROFILE } from "../../src/telemetry/index.mjs";
import { recordUsageObservation, validateMeteredAttempt } from "../../src/contracts/metering.mjs";
import { fixtureAttempt, trustedScope } from "../../fixtures/metering/attempt.mjs";
import { FakeMeteringAuthority } from "../../fixtures/contracts/metering/fake-authority.mjs";

const fixture = JSON.parse(await readFile(new URL("../../fixtures/metering/provider-usage.json", import.meta.url), "utf8"));

function create(overrides = {}) {
  return createUsageObservation({
    attempt: fixtureAttempt(),
    trustedScope,
    sourceObservationId: "usage:source-1",
    profile: USAGE_PROFILE.OPENAI_GPT_IMAGE_1,
    usage: fixture.openai_image_edit_gpt_image_1_documented_shape,
    ...overrides,
  });
}

test("nested image usage retains aggregate and included-subset relationships", () => {
  const observation = create();
  assert.equal(observation.completeness, "complete");
  assert.deepEqual(observation.usage_units, [
    { name: "input_tokens", quantity: "50", relation: "included_subset", included_in: "total_tokens" },
    { name: "output_tokens", quantity: "50", relation: "included_subset", included_in: "total_tokens" },
    { name: "total_tokens", quantity: "100", relation: "standalone" },
    { name: "input_tokens_details.text_tokens", quantity: "10", relation: "included_subset", included_in: "input_tokens" },
    { name: "input_tokens_details.image_tokens", quantity: "40", relation: "included_subset", included_in: "input_tokens" },
    { name: "output_tokens_details.image_tokens", quantity: "48", relation: "included_subset", included_in: "output_tokens" },
    { name: "output_tokens_details.text_tokens", quantity: "2", relation: "included_subset", included_in: "output_tokens" },
  ]);
  assert.equal("amount" in observation, false, "usage extraction must not invent monetary valuation");
});

test("invalid attempt keys never escape through C03 validation diagnostics", () => {
  const credentialKey = "ghp_SyntheticCredentialValueSyntheticCredentialValue";
  const attempt = { ...fixtureAttempt(), [credentialKey]: "synthetic" };
  assert.throws(() => create({ attempt }), (error) => {
    assert.equal(error.name, "TelemetryUsageError");
    assert.equal(error.code, "unknown_field");
    assert.equal(error.field, "attempt");
    assert.equal(error.message.includes(credentialKey), false);
    assert.equal(JSON.stringify(error).includes(credentialKey), false);
    return true;
  });
});

test("Responses usage uses its own dated shape and preserves cached/reasoning subsets", () => {
  const attempt = fixtureAttempt({
    operation_kind: "responses_orchestration",
    provider: { name: "openai", model: "gpt-6-luna", endpoint: "https://api.example.invalid/v1/responses", sdk: { name: "fixture-adapter", version: "1.0.0" } },
  });
  const observation = create({
    attempt,
    profile: USAGE_PROFILE.OPENAI_RESPONSES,
    usage: fixture.openai_responses_documented_shape,
    sourceObservationId: "usage:responses-1",
    transportAttemptId: "transport:responses-1",
  });
  assert.equal(observation.completeness, "complete");
  assert.equal(observation.usage_units.find((unit) => unit.name === "input_tokens_details.cached_tokens").relation, "included_subset");
  assert.equal(observation.usage_units.find((unit) => unit.name === "output_tokens_details.reasoning_tokens").included_in, "output_tokens");
});

test("TypeSafe decision usage is separately profiled and does not invent provider retries", () => {
  const attempt = fixtureAttempt({
    operation_kind: "jev_decision",
    provider: { name: "typesafe", model: "jev-1.13.0", endpoint: "https://api.example.invalid/v1/systemone", sdk: { name: "fixture-adapter", version: "1.0.0" } },
  });
  const observation = create({
    attempt,
    profile: USAGE_PROFILE.TYPESAFE_DECISION,
    usage: fixture.typesafe_decision_documented_shape,
    sourceObservationId: "usage:typesafe-1",
    transportAttemptId: "transport:typesafe-1",
  });
  assert.equal(observation.completeness, "complete");
  assert.deepEqual(observation.usage_units, [
    { name: "input_tokens", quantity: "296", relation: "standalone" },
    { name: "output_tokens", quantity: "20", relation: "standalone" },
  ]);
  assert.equal("provider_request_id" in observation, false);
});

test("missing, unsupported, malformed and internally contradictory usage stays unknown or partial", () => {
  const missing = create({ usage: null, sourceObservationId: "usage:missing" });
  assert.equal(missing.completeness, "unknown");
  assert.equal(missing.usage_units, undefined);
  assert.ok(missing.missing_fields.includes("provider_usage"));

  const unsupportedModel = create({
    attempt: fixtureAttempt({ provider: { name: "openai", model: "gpt-image-2", endpoint: "https://api.example.invalid/images", sdk: { name: "fixture-adapter", version: "1.0.0" } } }),
    sourceObservationId: "usage:unsupported-model",
  });
  assert.equal(unsupportedModel.completeness, "unknown");
  assert.ok(unsupportedModel.missing_fields.includes("usage_profile_model_unverified"));

  const malformed = create({
    usage: { input_tokens: 20, output_tokens: "NaN", total_tokens: 20 },
    sourceObservationId: "usage:malformed",
  });
  assert.equal(malformed.completeness, "partial");
  assert.ok(malformed.missing_fields.includes("usage.output_tokens.invalid"));

  const contradictory = create({
    usage: fixture.contradictory_usage,
    sourceObservationId: "usage:contradictory",
  });
  assert.equal(contradictory.completeness, "unknown");
  assert.equal(contradictory.usage_units, undefined);
  assert.ok(contradictory.missing_fields.includes("usage.inconsistent_counts"));
});

test("prototype-inherited profile names remain typed unsupported usage instead of throwing", () => {
  for (const profile of ["__proto__", "constructor", "toString"]) {
    const observation = create({ profile, sourceObservationId: `usage:unsupported:${profile}` });
    assert.equal(observation.completeness, "unknown", profile);
    assert.equal(observation.usage_units, undefined, profile);
    assert.ok(observation.missing_fields.includes("usage_profile_unsupported"), profile);
  }
});

test("unsafe provider request identity is omitted and reported as missing", () => {
  const observation = create({
    usage: { ...fixture.openai_image_edit_gpt_image_1_documented_shape, provider_request_id: "Bearer synthetic-not-real-token" },
    sourceObservationId: "usage:unsafe-provider-id",
  });
  assert.equal(observation.provider_request_id, undefined);
  assert.ok(observation.missing_fields.includes("provider_request_id_unavailable"));
  assert.equal(observation.completeness, "partial");
});

test("contradictory request or transport identities make otherwise known usage unknown", () => {
  const providerConflict = create({
    usage: { ...fixture.openai_image_edit_gpt_image_1_documented_shape, provider_request_id: "req:provider-b" },
    providerRequestId: "req:provider-a",
    sourceObservationId: "usage:provider-conflict",
    transportAttemptId: "transport:provider-conflict",
  });
  assert.equal(providerConflict.completeness, "unknown");
  assert.equal(providerConflict.usage_units, undefined);
  assert.ok(providerConflict.missing_fields.includes("provider_request_id_conflict"));

  const transportConflict = create({
    usage: { ...fixture.openai_image_edit_gpt_image_1_documented_shape, transport_attempt_id: "transport:other" },
    sourceObservationId: "usage:transport-conflict",
    transportAttemptId: "transport:recorded",
  });
  assert.equal(transportConflict.completeness, "unknown");
  assert.equal(transportConflict.usage_units, undefined);
  assert.ok(transportConflict.missing_fields.includes("transport_attempt_id_conflict"));
});

test("same source observation is collapsed only when its normalized payload matches", () => {
  const one = create();
  const duplicate = create({ source: "trace" });
  // Source is part of observation identity semantics, so different sources under
  // one source ID are a conflict, not evidence that their counts should be added.
  assert.throws(() => deduplicateUsageObservations([one, duplicate]), /conflicting payloads/);
  assert.equal(deduplicateUsageObservations([one, structuredClone(one)]).length, 1);
  assert.equal(deduplicateUsageObservations([one, Object.fromEntries(Object.entries(one).reverse())]).length, 1);
  const distinct = create({ sourceObservationId: "usage:source-2" });
  assert.equal(deduplicateUsageObservations([one, distinct]).length, 2);
});

test("direct and trace observations for one provider request remain one effective attempt charge", async () => {
  const rawAttempt = fixtureAttempt();
  const attempt = validateMeteredAttempt(rawAttempt, trustedScope);
  const authority = new FakeMeteringAuthority();
  await authority.reserveAttempt(attempt);
  const direct = create({ sourceObservationId: "usage:direct", providerRequestId: "req:shared" });
  const trace = create({ source: "trace", sourceObservationId: "usage:trace", providerRequestId: "req:shared" });
  const directAck = await recordUsageObservation({ port: authority, attempt, trustedScope, observation: direct });
  const traceAck = await recordUsageObservation({ port: authority, attempt, trustedScope, observation: trace });
  assert.equal(directAck.status, "accepted");
  assert.equal(traceAck.status, "duplicate");
  assert.equal(authority.observationsById.size, 2, "both source observations remain attributable");
  assert.equal(authority.effectiveChargeCount, 1, "duplicate sources do not create a second effective charge");
});

test("separate genuinely billed retries keep distinct attempt and transport identities", () => {
  const first = fixtureAttempt({
    logical_operation_id: "logical:retry-series",
    billable_attempt_id: "attempt:retry-1",
  });
  const second = fixtureAttempt({
    logical_operation_id: "logical:retry-series",
    billable_attempt_id: "attempt:retry-2",
  });
  const one = create({ attempt: first, sourceObservationId: "usage:retry-1", transportAttemptId: "transport:retry-1", providerRequestId: "req:retry-1" });
  const two = create({ attempt: second, sourceObservationId: "usage:retry-2", transportAttemptId: "transport:retry-2", providerRequestId: "req:retry-2" });
  assert.equal(one.logical_operation_id, two.logical_operation_id);
  assert.notEqual(one.billable_attempt_id, two.billable_attempt_id);
  assert.notEqual(one.transport_attempt_id, two.transport_attempt_id);
  assert.notEqual(one.provider_request_id, two.provider_request_id);
  assert.equal(deduplicateUsageObservations([one, two]).length, 2);
});
