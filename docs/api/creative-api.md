# Creative API v1

`creative-engine/api/v1` exports a typed, non-UI API and handler factory for the local creative workflow. It implements `generate`, `edit`, `inspect`, `list`, `compare`, `restore`, `cancel`, `handoff`, and `job.status`. The public request version is `CreativeApiRequest` schema `1.0`; unsupported request versions fail with a typed `unsupported_version` error. Public declarations are ESM `.d.mts` files and are checked under strict TypeScript NodeNext resolution.

This package supplies orchestration and validation around injected ports. It does not create an application identity, provider transport, finance authority, approval issuer, storage service, or renderer. With no required port injected, the operation returns a bounded `unavailable` response and cannot report a successful result. `MODE=live` is not implemented. A passing mock check is local conformance evidence only.

## Version and field compatibility

| Contract used by this API | Accepted version | Compatibility behavior |
| --- | --- | --- |
| `CreativeApiRequest` | `1.0` | Exact version only. Any other version returns `unsupported_version`; no request-envelope migration is performed. |
| `CreativeBrief`, `EditPlan`, `DesignVersion` | `1.0` | Each is validated by its pinned local contract before use. The API does not infer a newer version or downgrade a newer object. |
| `DecisionPortRequest`, `DecisionPortResult` | `1.0` | Validated against the pinned DecisionPort contract and request policy. An unsupported schema or policy fails closed. |
| Metering proposal, approval/handoff proposal | Their published local proposal versions | These are injected adapter boundaries. They do not establish external owner acceptance or live-service compatibility. |

The API request envelope requires `contract`, `schema_version`, `event_id`, `request_id`, `tenant_id`, `project_id`, `correlation_id`, `producer`, `occurred_at`, `ingested_at`, `environment`, `billing_mode`, `source_refs`, `operation`, and `payload`. `action_id` is required for `generate`, `edit`, `inspect`, `restore`, `cancel`, and `handoff`; it is optional for the read operations `list`, `compare`, and `job.status`. The payload requires every operation-specific field shown by the `CreativeApiRequest` TypeScript union. Only `generate` and `edit` may include optional `decision_request`; only `list` may include optional `limit` and `cursor`.

The v1.0 envelope and each operation payload reject unrecognized keys. This API version has no additive request-field negotiation: clients must send only declared fields and must not depend on an unknown field being preserved. Nested `EditPlan`, DecisionPort, brief, design, metering, and handoff values are checked by their own versioned validators; the API does not reinterpret unknown nested data as facts, permissions, actions, or authority. The local ResearchPackage normalizer separately supports the `ResearchPackage` alias for `EventIntelligencePackage` 1.0 and 1.1, but the API accepts a scoped `CreativeBrief` from storage rather than accepting a research package as a request.

For `list`, `limit` defaults to 20 and must be an integer from 1 through 100. The opaque cursor is limited to 1,024 characters and is bound to the caller's tenant, project, and brief. Ordering is stable across pages: descending `occurred_at`, then ascending `design_version_id`. A cursor from another brief or scope is rejected.

## Trust and ownership

The application supplies a trusted actor context separately from the request. The runtime checks expiry, required permission, and exact tenant/project agreement before using the request. A request cannot select its own trusted actor, tenant, or project. The storage and job adapters receive the trusted scope on each lookup and write; the runtime also verifies returned records before using them. Storage adapters must implement their own atomic write conditions. `saveDesignVersion` compares the canonical brief hash plus the expected current design ID and hash. `selectDesignVersion` compares the canonical brief hash, target design hash, and selection revision, then changes only the selected pointer.

Mutation requests require an `action_id`. The job adapter's `begin` operation must atomically return the existing job for a matching identity, reject the same identity with a different request hash, or create one job and lease. Results are replayed only after the stored result is revalidated against current scoped records. List cursors are opaque, bounded, and tied to one tenant, project, and brief. Pages use a deterministic ordering by descending `occurred_at`, then ascending `design_version_id`.

`jobs.authorizeDispatch` is a required atomic fence between a running job's lease and each provider, DecisionPort, inspection, or handoff transport attempt. It receives a `context_fence` with the exact canonical brief hash, optional design ID/hash, and, where current selection matters, the expected selected design ID/hash (including explicit `null` for first generation). The adapter must compare this fence against authoritative records in the same transaction that inserts the dispatch intent, alongside cancellation and lease ownership. A mismatch returns `stale_context`; cancellation or lease replacement returns `cancelled` or `lease_lost`. None of those results starts a transport call. If dispatch authorization takes the fence first, a later context change can block publication but cannot erase the transport attempt or its financial exposure; metering and reconciliation remain separate authorities. Every retry needs its own transport identity and authorization. Duplicate intents must match the same job, attempt, transport, lease, and context fence. `completeIfActive` receives a `publication_fence` and must compare it in the same transaction that publishes the result; an operation whose cancellation or context change wins cannot publish.

## Operations

`generate` and `edit` accept a validated `EditPlan`; the latter also supplies the exact base `design_version_id`. Optional DecisionPort work uses the injected `decisionPort` and is validated against the locally pinned request and response contract. Image dispatch is passed to the injected provider port only after reservation, in-flight acknowledgement, and job dispatch authorization. The returned immutable `DesignVersion` is saved through a compare-and-set storage operation. `composition.update` returns typed `unavailable` before routing or reservation until a deterministic composition executor is injected; it never falls through to image editing. `correction.apply` also returns typed `unavailable` before DecisionPort, routing, reservation, or image dispatch until a research-owner correction handoff can update authoritative facts and invalidate dependent creative state.

`inspect` requires an inspection resolver and inspection port. The port receives the initially allocated `transport_attempt_id` and records it before dispatch; usage may report provider and transport identities separately. Inspection runs through the metering boundary and publishes only a projected result whose tenant, project, brief, design, artifact, and content hashes still match the current scoped records. Nested observer and uncertainty objects use exact allowlists; raw raster data and unknown fields are not returned. Public observation strings are also checked for credential, signed-URL, email, and phone-number patterns on both fresh results and persisted replay; ordinary descriptive prose is preserved, while sensitive content fails closed.

`list` and `compare` are scoped reads. `restore` validates a target immutable version and uses `selectDesignVersion` to update the separate selected pointer by revision compare-and-set; it does not create a new `DesignVersion`. `cancel` first loads and validates the target job in the caller's project before asking the job adapter to cancel it. `job.status` returns a scoped status record without exposing stored result bodies. `handoff` verifies a version-bound approval after dispatch authorization and re-reads the brief, facts, assets, permissions, composition, preview, and design binding around verifier and submission waits before accepting a receipt. A receipt must have a valid UTC timestamp no later than trusted now, at or after handoff creation and approval issuance, and strictly before approval expiry. Completed replay still authenticates the current caller and scope, then validates the stored receipt at its historical consumption time without resubmitting or using expired approval as new authority. The consumer still must atomically consume the approval for that exact binding.

Errors use `CreativeApiResponse` schema `1.0`. The envelope contains a stable module (`creative-engine.api`), operation, bounded field path, code, retryable flag, fixed safe message, and diagnostic reference. Adapter exception strings, headers, credentials, and signed URLs are not returned. Trace events use an allowlisted shape, map unknown operations to `unknown`, and omit unsafe identifiers. Public job references accept only bounded opaque identifiers; unsafe stored result references fail closed.

## Injected ports and pending agreements

The public `CreativeRuntimePorts` type describes jobs, scoped storage, provider routing, DecisionPort, inspection, metering, approval verification, handoff, and trace adapters. The repository includes executable fixture adapters for offline checks, not production implementations. Provider routes, SDK/model identities, policy choices, storage transactions, finance settlement, approval issuance, and artifact access still require their real owner agreements and implementations. The creative and DecisionPort schemas, C03 metering shape, and C04 handoff receipt remain local proposals until the external owner gate records and independently verifies the relevant agreements.

In particular, the locally pinned DecisionPort model identifier and synthetic provider names in the fixtures identify test inputs only. They do not establish an active provider route or live SDK compatibility. No live calls are made by the API test, build, or CI commands.

## Local checks and evidence

Use Node.js `22.23.3` for the production-target runtime checks. Node.js `24.15.0` is also tested for development compatibility. `make bootstrap` installs the root package and the locked TypeScript consumer tools. The strict public consumer test uses TypeScript `5.9.3` and imports the actual package subpaths.

```sh
make bootstrap
make build
make check TARGET=api MODE=mock
make check TARGET=all MODE=mock
```

`make check TARGET=api MODE=mock` runs the real standalone API validators and writes a versioned, sanitized summary to `build/api-check-evidence.json`. It records the runtime, implementation revision, schema/model/policy labels used by synthetic fixtures, test counts, and SHA-256 hashes of the API fixture files. It omits artifact bytes, provider headers, credentials, and raw trace payloads. The evidence explicitly says the external acceptance gate is pending and that no paid provider calls occurred.

`make acceptance TARGET=api` checks the same relevant canonical owner agreements as the creative contracts gate. It is expected to fail until those external agreements have accepted, pinned, independently verified evidence; local tests do not satisfy that gate. The current agreement status is in [canonical owner agreements](../contracts/canonical-owner-agreements.json).

The [public client example](../../examples/api/fail-closed-client.mjs) shows the unavailable response when a required scoped job port is not installed. The [strict consumer fixture](../../examples/api/public-consumer.mts) compiles requests for all nine operations and checks read-only reservation and transport identities, context fences, and injected-port callbacks in the public types.
