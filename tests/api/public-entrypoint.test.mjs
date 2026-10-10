import assert from "node:assert/strict";
import test from "node:test";
import * as apiModule from "creative-engine/api/v1";

test("public API subpath exports the typed runtime symbols and errors", async () => {
  assert.deepEqual(Object.keys(apiModule).sort(), [
    "CREATIVE_API_OPERATIONS",
    "CREATIVE_API_VERSION",
    "CreativeApiError",
    "createCreativeApi",
    "createCreativeRuntime",
  ]);
  assert.equal(apiModule.CREATIVE_API_VERSION, "1.0");
  assert.deepEqual(apiModule.CREATIVE_API_OPERATIONS, [
    "generate", "edit", "inspect", "list", "compare", "restore", "cancel", "handoff", "job.status",
  ]);
  const error = new apiModule.CreativeApiError("invalid_request", "generate", "plan");
  assert.ok(error instanceof Error);
  assert.equal(error.code, "invalid_request");
  assert.equal(error.operation, "generate");
  assert.equal(error.module, "creative-engine.api");
});

test("missing required runtime ports fail with a bounded versioned error and no fake success", async () => {
  const api = apiModule.createCreativeApi({ now: () => Date.parse("2026-10-10T12:00:00.000Z") });
  const actor = {
    actor_id: "actor-fixture",
    tenant_id: "tenant-fixture",
    project_id: "project-fixture",
    expires_at: "2026-10-11T00:00:00.000Z",
    permissions: ["creative.read"],
    budget_scope_id: "budget-fixture",
    budget_policy_version: "budget-policy/1",
  };
  const response = await api.invoke(actor, {
    contract: "CreativeApiRequest",
    schema_version: "1.0",
    event_id: "event-fixture",
    request_id: "request-fixture",
    tenant_id: "tenant-fixture",
    project_id: "project-fixture",
    correlation_id: "correlation-fixture",
    producer: "api-runtime-export-test",
    occurred_at: "2026-10-10T12:00:00.000Z",
    ingested_at: "2026-10-10T12:00:00.000Z",
    environment: "test",
    billing_mode: "simulated",
    source_refs: [],
    operation: "job.status",
    payload: { job_id: "job-fixture" },
  });
  assert.equal(response.ok, false);
  assert.equal(response.contract, "CreativeApiResponse");
  assert.equal(response.schema_version, "1.0");
  assert.equal(response.error.code, "unavailable");
  assert.equal(response.error.operation, "job.status");
  assert.equal(response.error.module, "creative-engine.api");
  assert.equal(response.error.retryable, false);
  assert.match(response.error.diagnostic_ref, /^creative-api:unavailable:[A-Za-z0-9_.:-]{1,200}$/);
  assert.equal(response.job, undefined);
  assert.equal(response.result, undefined);

  const malformedActor = await api.invoke({ ...actor, actor_id: "" }, {
    contract: "CreativeApiRequest",
    schema_version: "1.0",
    event_id: "event-malformed-actor",
    request_id: "request-malformed-actor",
    tenant_id: "tenant-fixture",
    project_id: "project-fixture",
    correlation_id: "correlation-malformed-actor",
    producer: "api-runtime-export-test",
    occurred_at: "2026-10-10T12:00:00.000Z",
    ingested_at: "2026-10-10T12:00:00.000Z",
    environment: "test",
    billing_mode: "simulated",
    source_refs: [],
    operation: "job.status",
    payload: { job_id: "job-fixture" },
  });
  assert.equal(malformedActor.ok, false);
  assert.equal(malformedActor.error.code, "unauthorized");
  assert.equal(malformedActor.error.operation, "job.status");

  const malformed = await api.invoke(actor, {
    contract: "CreativeApiRequest",
    schema_version: "1.0",
    event_id: "event-malformed",
    request_id: "request-malformed",
    tenant_id: "tenant-fixture",
    project_id: "project-fixture",
    correlation_id: "correlation-malformed",
    producer: "api-runtime-export-test",
    occurred_at: "2026-10-10T12:00:00.000Z",
    ingested_at: "2026-10-10T12:00:00.000Z",
    environment: "test",
    billing_mode: "simulated",
    source_refs: [],
    operation: "list",
    payload: { brief_id: 42 },
  });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.error.code, "invalid_request");
  assert.equal(malformed.error.operation, "list");
  assert.equal(malformed.error.field, "payload.brief_id");
});
