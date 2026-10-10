import { METERING_PROPOSAL_VERSION } from "../../src/contracts/metering.mjs";

export const trustedScope = Object.freeze({
  tenant_id: "tenant:fixture",
  project_id: "project:creative-fixture",
  budget_scope_id: "budget:creative-fixture",
});

export function fixtureAttempt(overrides = {}) {
  const base = {
    schema_version: METERING_PROPOSAL_VERSION,
    ...trustedScope,
    logical_operation_id: "logical:fixture-001",
    billable_attempt_id: "attempt:fixture-001",
    retry_mapping_ref: "retry-map:fixture-v1",
    environment: "test",
    billing_mode: "simulated",
    operation_kind: "image_generation",
    budget: { scope_id: trustedScope.budget_scope_id, policy_version: "fixture-policy-v1" },
    provider: {
      name: "openai",
      model: "gpt-image-1",
      endpoint: "https://api.example.invalid/v1/images/generations",
      sdk: { name: "fixture-adapter", version: "1.0.0" },
    },
    correlation_id: "correlation:fixture-001",
  };
  return structuredClone({ ...base, ...overrides });
}
