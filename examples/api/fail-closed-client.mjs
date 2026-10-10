import { createCreativeApi } from "creative-engine/api/v1";

const api = createCreativeApi();
const response = await api.invoke({
  actor_id: "actor-fixture",
  tenant_id: "tenant-fixture",
  project_id: "project-fixture",
  expires_at: "2026-10-11T00:00:00.000Z",
  permissions: ["creative.read"],
  budget_scope_id: "budget-fixture",
  budget_policy_version: "budget-policy/1",
}, {
  contract: "CreativeApiRequest",
  schema_version: "1.0",
  event_id: "event-fixture",
  request_id: "request-fixture",
  tenant_id: "tenant-fixture",
  project_id: "project-fixture",
  correlation_id: "correlation-fixture",
  producer: "fail-closed-example",
  occurred_at: "2026-10-10T12:00:00.000Z",
  ingested_at: "2026-10-10T12:00:00.000Z",
  environment: "test",
  billing_mode: "simulated",
  source_refs: [],
  operation: "job.status",
  payload: { job_id: "job-fixture" },
});

if (response.ok) throw new Error("This example requires a real injected jobs.get port.");
process.stdout.write(JSON.stringify({
  contract: response.contract,
  schema_version: response.schema_version,
  code: response.error.code,
  module: response.error.module,
  operation: response.error.operation,
}, null, 2) + "\n");
