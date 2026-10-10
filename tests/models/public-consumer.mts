import {
  createOpenAIImagesProvider,
  evaluateOpenAIImageRetry,
  inspectOpenAIImageBytes,
  normalizeOpenAIImageUsage,
  type OpenAIImagesInput,
  type OpenAIImagesOutput,
  type OpenAIImageAuthorizationRequest,
} from "creative-engine/models";
import type { PrivateProviderUsageAttribution } from "creative-engine/api/v1";
import type { TrustedProviderUsageProfileAuthority } from "creative-engine/telemetry";
import type { UsageObservation } from "creative-engine/contracts/metering";

const provider = createOpenAIImagesProvider({
  model_id: "gpt-image-2.5-sunburst-2026-09-08",
  configuration: { quality: "high", size: "1024x1024", output_format: "png", background: "opaque", moderation: "auto" },
  capabilityPort: { verify: async (_input) => ({}), revalidate: async (_input) => ({}) },
  authorizationPort: { revalidate: async (_input) => ({}) },
  credentialPort: { resolveCredential: async (_input) => ({}) },
  promptPort: { render: async (_input) => "local fixture" },
  fetchImpl: async (_input, _init) => new Response("{}"),
});

export async function consume(input: OpenAIImagesInput): Promise<OpenAIImagesOutput> {
  const route = provider.resolveRoute({ operation: "generate" });
  const output = await provider.generate(input);
  const detailCount: number | undefined = output.usage.input_tokens_details?.image_tokens;
  const totalCount: number | undefined = output.usage.total_tokens;
  const transportId: string | undefined = output.usage.transport_attempt_id;
  void route.provider.model;
  void detailCount;
  void totalCount;
  void transportId;
  return output;
}

export function consumeAuthorizationBinding(input: OpenAIImageAuthorizationRequest) {
  const prompt: `sha256:${string}` = input.target_binding.prompt_sha256;
  const operationInput: `sha256:${string}` = input.target_binding.input_sha256;
  const parent: `sha256:${string}` | undefined = input.target_binding.parent_artifact_sha256;
  return { prompt, operationInput, parent };
}

export async function consumeImageBytes(bytes: Uint8Array) {
  const info = await inspectOpenAIImageBytes(bytes);
  const usage = normalizeOpenAIImageUsage({ input_tokens: 12, output_tokens: 8 }, { transport_attempt_id: "transport-01" });
  const retry = evaluateOpenAIImageRetry({ attempt_number: 1, started_at: new Date(0).toISOString(),
    now_at: new Date(1000).toISOString(), deadline_at: new Date(100_000).toISOString(), retry_after: "1" });
  return { format: info.format, width: info.width, usage, retry };
}

export const ownerUsageProfile: TrustedProviderUsageProfileAuthority = {
  mapProviderUsage(input) {
    const exactAttempt: string = input.attempt.billable_attempt_id;
    const exactTarget: `sha256:${string}` = input.targetBindingSha256;
    const reservation: string = input.reservationRef;
    const dispatch: string = input.dispatchIntentRef;
    void exactAttempt;
    void exactTarget;
    void reservation;
    void dispatch;
    const observation: UsageObservation = {
      schema_version: "creative.metering.proposal/v1",
      tenant_id: input.attempt.tenant_id,
      project_id: input.attempt.project_id,
      budget_scope_id: input.attempt.budget_scope_id,
      logical_operation_id: input.attempt.logical_operation_id,
      billable_attempt_id: input.attempt.billable_attempt_id,
      source_observation_id: input.sourceObservationId,
      source: "provider_response",
      provider_name: input.attempt.provider.name,
      model: input.attempt.provider.model,
      transport_attempt_id: input.transportAttemptId,
      environment: input.attempt.environment,
      billing_mode: input.attempt.billing_mode,
      completeness: "unknown",
      missing_fields: ["profile_not_selected"],
    };
    return {
      status: "mapped",
      profile_ref: "owner-profile/illustrative",
      profile_sha256: `sha256:${"0".repeat(64)}`,
      raw_usage_sha256: input.rawUsageSha256,
      target_binding_sha256: input.targetBindingSha256,
      attempt_binding_sha256: input.attemptBindingSha256,
      observation,
    };
  },
};

export function retainPrivateUsage(input: PrivateProviderUsageAttribution) {
  const target: `sha256:${string}` = input.target_binding_sha256;
  const count: number | undefined = input.usage.total_tokens;
  return { target, count };
}
