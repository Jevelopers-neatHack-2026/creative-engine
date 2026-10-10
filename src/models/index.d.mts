import type { ProviderInput, ProviderOutput, CreativeProviderRoute, UsageRecord } from "../api/v1.mjs";

export type OpenAIImageOperation = "generate" | "edit";
export type OpenAIImageOutputFormat = "png" | "jpeg" | "webp";
export type OpenAIImageQuality = "low" | "medium" | "high" | "xhigh" | "max";

export interface OpenAIImageConfiguration {
  readonly quality: OpenAIImageQuality;
  readonly size: "auto" | `${number}x${number}`;
  readonly output_format: OpenAIImageOutputFormat;
  readonly background: "opaque" | "transparent";
  readonly moderation: "auto" | "low";
}

export interface OpenAIImageTokenDetails {
  readonly [detail: string]: number | undefined;
  readonly text_tokens?: number;
  readonly image_tokens?: number;
}

/** Raw allowlisted provider counters. The owner-reviewed operation profile maps these to C03. */
export interface OpenAIImageUsage extends UsageRecord {
  readonly [providerField: string]: unknown;
  readonly completeness: "unknown";
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly total_tokens?: number;
  readonly input_tokens_details?: OpenAIImageTokenDetails;
  readonly output_tokens_details?: OpenAIImageTokenDetails;
  readonly provider_request_id?: string;
  readonly transport_attempt_id?: string;
  readonly missing_fields: readonly string[];
}

export type OpenAIImagesInput = ProviderInput & { readonly reservation_ref: string };

export interface OpenAIImagesOutput extends ProviderOutput {
  readonly target_binding_sha256: `sha256:${string}`;
  readonly usage: OpenAIImageUsage;
}

export interface OpenAIImageEvidence {
  readonly evidence_ref: string;
  readonly evidence_sha256: `sha256:${string}`;
}

export interface OpenAIImageTargetBinding {
  readonly service: "openai";
  readonly endpoint: string;
  readonly model: string;
  readonly sdk_name: "native-fetch";
  readonly sdk_version: string;
  readonly configuration_sha256: `sha256:${string}`;
  readonly operation: OpenAIImageOperation;
  readonly operation_kind: string;
  readonly input_sha256: `sha256:${string}`;
  readonly prompt_sha256: `sha256:${string}`;
  readonly plan_sha256: `sha256:${string}`;
  readonly parent_artifact_sha256?: `sha256:${string}`;
  readonly mask_content_sha256?: `sha256:${string}`;
  readonly image_reference_manifest_sha256?: `sha256:${string}`;
  readonly deadline_at: string;
  readonly transport_policy: Readonly<{
    maximum_transport_attempts: 1;
    automatic_retry: false;
    stop_on: readonly string[];
  }>;
  readonly tenant_id: string;
  readonly project_id: string;
  readonly budget_scope_id: string;
  readonly billable_attempt_id: string;
}

export interface OpenAIImageCapabilityRequest {
  readonly scope: ProviderInput["scope"];
  readonly attempt: ProviderInput["attempt"];
  readonly operation: OpenAIImageOperation;
  readonly model: string;
  readonly target_binding: OpenAIImageTargetBinding;
  readonly target_binding_sha256: `sha256:${string}`;
  readonly reservation_ref: string;
  readonly billable_attempt_id: string;
  readonly deadline_at: string;
  readonly checked_at?: string;
  readonly phase?: "post_transport_ack";
  readonly account_ref?: string;
  readonly project_ref?: string;
  readonly grant_ref?: string;
}

export interface OpenAIImageCapabilityPort {
  /** Must read trusted, current account/project eligibility and operation quota evidence. */
  verify(input: OpenAIImageCapabilityRequest): Promise<unknown> | unknown;
  revalidate(input: OpenAIImageCapabilityRequest): Promise<unknown> | unknown;
}

export interface OpenAIImageAuthorizationRequest {
  readonly scope: ProviderInput["scope"];
  readonly attempt: ProviderInput["attempt"];
  readonly operation: OpenAIImageOperation;
  readonly target_binding: OpenAIImageTargetBinding;
  readonly target_binding_sha256: `sha256:${string}`;
  readonly reservation_ref: string;
  readonly account_ref?: string;
  readonly project_ref?: string;
  readonly grant_ref?: string;
  readonly finance_lease_ref?: string;
  readonly billable_attempt_id: string;
  readonly budget_scope_id: string;
  readonly dispatch_intent_ref: string;
  readonly deadline_at: string;
  readonly phase: "preparation" | "post_transport_ack";
}

export interface OpenAIImageAuthorizationPort {
  /** Authenticates grant and Finance reservation/lease identity, cap, currency and current state. */
  revalidate(input: OpenAIImageAuthorizationRequest): Promise<unknown> | unknown;
}

export interface OpenAIImageCredentialPort {
  resolveCredential(input: Readonly<Record<string, unknown>>): Promise<unknown> | unknown;
}

export interface OpenAIImagePromptPort {
  render(input: Readonly<Record<string, unknown>>): Promise<string | { prompt: string }> | string | { prompt: string };
}

export interface OpenAIImageAssetPort {
  readArtifact(input: Readonly<Record<string, unknown>>): Promise<Uint8Array> | Uint8Array;
  readReference?(input: Readonly<Record<string, unknown>>): Promise<Uint8Array> | Uint8Array;
}

export interface OpenAIImageRetryPolicy {
  readonly max_attempts?: number;
  readonly max_elapsed_ms?: number;
  readonly max_delay_ms?: number;
}

export interface OpenAIImageProviderOptions {
  readonly model_id: string;
  readonly configuration: OpenAIImageConfiguration;
  readonly capabilityPort: OpenAIImageCapabilityPort;
  readonly authorizationPort: OpenAIImageAuthorizationPort;
  readonly credentialPort: OpenAIImageCredentialPort;
  readonly promptPort: OpenAIImagePromptPort;
  readonly assetPort?: OpenAIImageAssetPort;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly idFactory?: () => string;
  readonly retryPolicy?: OpenAIImageRetryPolicy;
}

export type OpenAIImagesErrorCode =
  | "invalid_configuration" | "unsupported_model_profile" | "unsupported_image_configuration" | "unsupported_operation"
  | "provider_ports_unavailable" | "provider_attempt_mismatch" | "invalid_provider_input" | "reservation_reference_missing"
  | "model_capability_unverified" | "model_capability_unavailable" | "authorization_unavailable"
  | "credential_unavailable" | "asset_unavailable" | "asset_invalid" | "asset_integrity_error"
  | "mask_unavailable" | "mask_invalid" | "prompt_unavailable" | "prompt_invalid" | "unsupported_plan"
  | "deadline_or_cancelled" | "cancelled_before_dispatch" | "dispatch_fence_closed" | "transport_ack_unknown"
  | "transport_ack_mismatch" | "provider_transport_unknown" | "provider_response_invalid" | "provider_request_failed"
  | "provider_rate_limited" | "provider_quota_exhausted" | "authentication_denied" | "operation_permission_denied"
  | "moderation_blocked" | "provider_output_mismatch" | "provider_outcome_unknown" | "image_bytes_invalid"
  | "image_decoder_unavailable";

export interface OpenAIImageRetryDecision {
  readonly decision: "stop" | "eligible_for_separately_authorized_attempt";
  readonly stop_reason?: string;
  readonly delay_ms: number | null;
  readonly automatic_retry: false;
  readonly new_billable_identity_required?: true;
}

export declare const OPENAI_IMAGE_CANDIDATE_PROFILES: Readonly<Record<string, Readonly<{
  model_id: string;
  docs_checked_at: string;
  documentation_status: "candidate_unselected";
  qualities: readonly OpenAIImageQuality[];
  formats: readonly OpenAIImageOutputFormat[];
  transparent_formats: readonly ("png" | "webp")[];
  moderation: readonly ("auto" | "low")[];
  size_policy: string;
  response_encoding: "base64";
  supports_input_fidelity: false;
  supports_streaming: false;
}>>>;

export declare const OPENAI_IMAGES_ENDPOINTS: Readonly<{
  generation: "https://api.openai.com/v1/images/generations";
  edit: "https://api.openai.com/v1/images/edits";
}>;

export declare class OpenAIImagesProviderError extends Error {
  constructor(code: OpenAIImagesErrorCode | string, message: string, options?: {
    outcome?: "succeeded" | "failed" | "partial" | "unknown";
    http_status?: number;
    retry?: OpenAIImageRetryDecision;
    provider_request_ref?: string;
    field?: string;
  });
  readonly code: OpenAIImagesErrorCode | string;
  readonly provider_outcome: "succeeded" | "failed" | "partial" | "unknown";
  readonly http_status?: number;
  readonly retry?: OpenAIImageRetryDecision;
  readonly provider_request_ref?: string;
  readonly field?: string;
  /** Raw allowlisted counters observed before a failed outcome; never implies settlement. */
  readonly usage?: OpenAIImageUsage;
}

export declare function createOpenAIImagesProvider(options: OpenAIImageProviderOptions): Readonly<{
  resolveRoute(input: { operation: OpenAIImageOperation }): CreativeProviderRoute;
  generate(input: OpenAIImagesInput): Promise<OpenAIImagesOutput>;
  edit(input: OpenAIImagesInput): Promise<OpenAIImagesOutput>;
}>;

export declare function inspectOpenAIImageBytes(value: Uint8Array): Promise<Readonly<{
  format: OpenAIImageOutputFormat;
  width: number;
  height: number;
  has_alpha: boolean;
  has_transparency: boolean;
}>>;

export declare function normalizeOpenAIImageUsage(raw: unknown, identities?: {
  transport_attempt_id?: string;
  provider_request_id?: string;
}): OpenAIImageUsage;

export declare function evaluateOpenAIImageRetry(input: {
  retry_after?: string;
  attempt_number: number;
  started_at: string;
  now_at: string;
  deadline_at: string;
  max_attempts?: number;
  max_elapsed_ms?: number;
  max_delay_ms?: number;
  next_attempt_authorized?: boolean;
}): OpenAIImageRetryDecision;
