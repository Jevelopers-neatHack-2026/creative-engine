# Provider access preflight

CE-A01 defines a fixed, eight-cell access matrix for the later creative smoke. It is a prerequisite report, not a blanket billing grant or release-acceptance result. Every required cell remains in the denominator, and `acceptance_allowed` is always `false`; a successful mock run reports `simulated`, never `verified`.

The plan carries explicit target and configuration pins. It cannot carry or establish credentials, owner approval, operation permission, quota, Finance authority, or a reservation. Those decisions come from injected adapters in the trusted host composition. A serialized plan or a port object loaded from user-controlled JSON is not a trusted integration. The `evidence_mode` field labels a source; it is not authentication by itself.

## Required cells and current selection

| Cell | Required evidence | Current boundary |
| --- | --- | --- |
| `image_generation` | Exact generation endpoint, selected model, Node/runtime pin, prompt template hash, authenticated account/project, exact operation permission, quota, grant, reservation, one result and usage observation | Direct Images API candidate is `gpt-image-2.5-sunburst-2026-09-08`; it remains unevaluated and account access is unverified. |
| `image_edit` | Independent edit entitlement and the same account, target, spend, and usage checks; source asset has a pinned digest and MIME type | Separate `/v1/images/edits` operation. Generation success does not imply edit access. |
| `harness_jev` | Agent-harness adapter and accepted DecisionPort evidence for the exact JEV operation | JEV transport belongs in agent-harness; no JEV transport is implemented here. The dated `jev-1.13.0` candidate is not account-access evidence. |
| `vision_observer` | Separately selected observer model, endpoint/configuration, permission, quota, authorization, and usage | Selection and account eligibility are unresolved. |
| `generative_classifier_baseline` | Separately selected baseline model, endpoint/configuration, permission, quota, authorization, and usage | Selection and account eligibility are unresolved. |
| `planning` | Separately selected billable planning model, endpoint/configuration, permission, quota, authorization, and usage | Selection and account eligibility are unresolved. |
| `neatlogs_ingestion` | Accepted Finance/owner ingestion operation, sanitized capture policy, exact authorization, and receipt | Blocked until the external owner publishes and accepts the operation and verifier. Console output is not ingestion. |
| `neatlogs_readback` | Separate authorized readback operation and a sanitized receipt bound to the captured event | Blocked until the external owner publishes and accepts readback semantics. Ingestion alone does not prove retrieval. |

An unresolved target stays blocked. The runner does not substitute a convenient model, use a moving alias, or treat model listing as permission. EVAL-03 remains Product and frontend owned; FIN-10 and SPN-01 remain Finance and reliability owned. This preflight records the Creative and fulfillment contribution without changing those roles.

## Trusted capability and Finance ports

Before a billable cell can request a reservation, the host supplies a trusted `AccessCapabilityVerifierPort`. Its decision must bind the authenticated tenant, project, and budget scope; provider account and project; cell and owner; exact service, endpoint, model, SDK/runtime and configuration digest; operation; and the approved deadline. It returns separate operation-permission and quota states, evidence hashes and pinned independent-review references, owner role, protocol pin, check time, and expiry. Evidence must be fresh (at most five minutes old) and valid through the exact operation deadline. The verifier is called again at the dispatch boundary after the reservation is established. If capability or authorization is denied, unknown, stale, expired, or revoked, no provider transport starts. A hold already established remains for reconciliation when the result is uncertain.

The capability verifier is deliberately distinct from the provider metadata adapter, pin verifier, authorization verifier, and Finance verifier:

1. The provider adapter can check non-billable account authentication and model listing. The built-in Images adapter reports permission and quota as unknown because the model-list endpoint does not establish either for an image operation.
2. The capability verifier must independently confirm current eligibility and quota for the exact operation and target. A model-list result, configuration pin, or later billing grant cannot replace it.
3. The authorization verifier must authenticate an external grant for the same tenant/project/budget, provider account/project, full target and operation, logical operation and billable-attempt IDs, exact cap/currency, deadline, and stop conditions. It is revalidated both at dispatch entry and after the metering authority acknowledges the single transport identity.
4. The Finance reservation verifier must confirm the actual reservation and active lease against the same grant/evidence, attempt, full target, cap, and currency. The accepted Finance protocol must enforce one-use authorization, aggregate caps, and lease binding.
5. The existing C03 metering consumer records distinct logical-operation, billable-attempt, transport, provider-request, and usage-observation identities. The provider adapter records its single transport, awaits Finance acknowledgement, revalidates the current Finance lease, capability, and grant, then performs a synchronous cancellation/deadline/expiry/freshness check immediately before network I/O. It must not retry.

Those independent verifications are sequential reads. This proposal does not claim atomic cross-authority revocation protection: a provider, grant issuer, and Finance service can change state between their separate responses. A live integration needs each external owner to define the binding and dispatch linearization semantics for its one-use grant and lease. If any post-acknowledgement check is denied, stale, unavailable, expired, revoked, or cancelled, the adapter sends no Images POST and C03 retains the acknowledged attempt for reconciliation.

These are injected interfaces, not a claim that Creative owns or implements the provider, capability, authorization, or Finance authorities. The current external agreement and accepted account/owner evidence are missing. The test fixture is explicitly fake and only exercises boundary behavior; it cannot satisfy a live cell or prove account quality.

## Direct OpenAI Images adapter

The built-in generation/edit adapter uses one native `fetch` request to the explicit Images endpoint. It is not the official OpenAI SDK and does not call the Responses API. The target pin labels this client as `native-fetch` and checks its version against the actual `process.versions.node` value. The adapter does not read environment variables, choose a model, follow redirects, retry, or log authorization headers.

Current official references list the dated Sunburst snapshot as an Images model candidate and document separate generation and edit endpoints. They also describe `OpenAI-Organization` and `OpenAI-Project` request headers, which scope usage to the named IDs. The credential resolver must independently bind the token, provider routing IDs, exact target, and—on a billable operation—the grant reference before the adapter sends either a read-only model-list request or a paid request. This documentation does not establish eligibility for the configured account. See the [Images API guide](https://developers.openai.com/api/docs/guides/images-vision), [generation endpoint reference](https://developers.openai.com/api/reference/resources/images/methods/generate), [edit endpoint reference](https://developers.openai.com/api/reference/resources/images/methods/edit), and [API authentication and project headers](https://developers.openai.com/api/reference/overview).

Edit input must match the pinned asset digest and pass bounded PNG structure, checksum, and decompressed-scanline checks before the credential resolver is called. Indexed-color PNGs are explicitly rejected because this bounded decoder does not validate palette indexes. A successful output requires a supported, decoded PNG with the exact pinned 1024×1024 dimensions. The report contains its digest and dimensions, not image bytes. Raw provider request IDs are represented only by a SHA-256 surrogate. Provider JSON and image bytes have size limits. When token usage includes input/output text and image detail counts, the adapter preserves each as an `included_subset` of its input/output parent; top-level input/output are themselves subsets of total. Missing or malformed reported usage dimensions remain explicit as partial/unknown, are never priced locally, and keep the C03 hold in reconciliation.

The documented model candidate is not a selected owner-approved target. The fixture's prompt, account IDs, evidence, Finance authority, reservation, and provider responses are test-only. No provider call, account inspection, JEV request, or Neatlogs write/read was made for this implementation.

## Run and verify

The public ESM and strict type entrypoint is `creative-engine/preflight`. The deterministic checks are:

```sh
make check TARGET=access-preflight MODE=mock
make check TARGET=access-preflight MODE=live
```

The mock command runs both generation and edit through synthetic ports, keeps the other six required cells visible as blocked, and writes sanitized evidence to `build/access-preflight-evidence.json`. Its report remains `simulated_or_pending`, with `acceptance_allowed: false`. The live command writes `build/access-preflight-live-gate.json`, emits the blocked eight-cell gate as JSON, and exits 2 while trusted capability, authorization, Finance reservation, and owner adapters are absent. It performs zero provider dispatches and reads no credentials. It never loads adapter claims or grants from user-editable JSON. The exported `runAccessPreflight` function is executable with real trusted adapters supplied by a host composition; this repository does not contain or install that composition. `make acceptance TARGET=access-preflight` and `make acceptance TARGET=all` keep CE-A01 pending until the external evidence and actual authorized access work are available.

Standalone checks for these source files are:

```sh
node --test tests/preflight/*.test.mjs
node --check src/preflight/access.mjs
node --check src/preflight/openai-images.mjs
```

The strict NodeNext consumer check uses TypeScript 5.9 with `strict` and `skipLibCheck: false`. Tests exercise fixed denominators, individual cell separation, missing/denied/unknown capability, scope/deadline/freshness mismatches, stale grant revalidation, denied and mismatched reservations, uncertain release/usage holds, one-transport limits, privacy-safe diagnostics, account/project-bound credential routing, PNG validation, and the absence of retry or fallback behavior. Live provider, Finance, JEV, and Neatlogs execution remains pending their respective owner agreements and exact authorization.
