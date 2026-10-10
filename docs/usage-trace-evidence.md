# Creative usage and trace evidence

**Status: local CE-11 source proposal.** The telemetry modules consume the existing C03 metering contract and CE-01 runtime ports. They do not establish a Finance agreement, a canonical cross-repository event schema, an authoritative usage sink, or live Neatlogs acceptance. This branch now includes a telemetry-specific SQLite outbox and independent-process/restart tests. API-path wiring, integration with the CE-08 shared durable transaction, root Make/CI integration, and owner review remain required local work.

## Boundaries and ownership

`src/telemetry/usage.mjs` turns an explicitly selected usage profile into one C03 `UsageObservation`. `src/telemetry/evidence.mjs` wraps C03's `executeMeteredAttempt`: it requires a safe intent record before calling the authoritative reservation port, writes a sanitized transport-intent record before each C03 transport registration, and reports final evidence delivery separately from the metering result. C03 remains the only reservation, settlement, and unknown-hold executor. No monetary rate or local spend calculation is introduced.

The evidence port's `recorded` or `duplicate` acknowledgement is only an acknowledgement from the injected port. It does not mean a Neatlogs service accepted the record, that an event is queryable, or that Finance approved its shape. The static SDK advisory for Neatlogs 1.1.28 found that `Client.flush()` and stock OTLP success do not establish whole-batch acceptance; this work therefore defines no SDK-backed success shortcut and does not advance any durable financial or trace cursor.

`src/telemetry/retry.mjs` handles a bounded batch of observations that the host has already persisted. It asks a trusted resolver for scope on each record, calls C03 `recordUsageObservation`, then acknowledges the outbox record. If the authority has accepted an observation but local acknowledgement fails, a replay sends the same observation ID; the authority can return `duplicate`. This worker has no provider dispatch, reservation, settlement, or financial storage capability.

`src/telemetry/sqlite-outbox.mjs` provides a local durable implementation over a caller-owned Node `DatabaseSync` connection. It stores immutable C03 observation snapshots and sanitized CE-11 evidence in separate versioned tables, hashes canonical payloads, and uses expiring claim tokens whose hashes are stored at rest. A claim can be acknowledged or deferred only by its current token; expired claims can be reclaimed after restart, and separate processes serialize claims through SQLite write transactions. When given a connection already in a transaction, the adapter uses a savepoint and leaves commit/rollback ownership with its caller. It records no budgets, reservations, valuation, settlement, or trace-sink acceptance. This telemetry-private schema is not yet the CE-08 shared transaction adapter used by API operations. The JSON file outbox under `fixtures/metering/` remains a simpler test fixture. Node's built-in `node:sqlite` is still marked active development in Node 22.23.3, so these local process-restart tests do not certify production-host support or power-loss durability.

## Identities and event shape

The local evidence envelope is versioned as `creative.telemetry.evidence/v1`; it is not a canonical shared event. Each attempt keeps the meanings already defined by C03:

| Identity | Meaning |
| --- | --- |
| `logical_operation_id` | One user-intended operation across retries. |
| `billable_attempt_id` | One potentially billed provider execution. A genuinely billed retry uses a new value. |
| `transport_attempt_id` | One network or SDK transport send. Retry adapters report each send before dispatch. |
| `provider_request_id` | An opaque provider identity, included only when returned and safe to publish. |
| `source_observation_id` | One source usage/trace/billing observation, stable when retried. |
| `reservation_ref` | The exact reservation ID returned by the injected C03 authority. |

The envelope records tenant/project/budget scope, provider/model, `environment`, C03 `billing_mode`, provider execution mode, commerce mode, event type, and outcome state. Provider execution mode (`mock`, `recorded`, `sandbox`, `live`, or `unknown`) and commerce mode (`simulated`, `live`, or `unknown`) are separate explicit fields. Neither is inferred from the other or from `billing_mode`; `unknown` remains explicit. Raw provider requests, prompts, output text, image bytes, exception messages, stack traces, and endpoint URLs are not placed into trace evidence.

Before any reservation, the wrapper appends `attempt_intent`. A failed or malformed intent acknowledgement stops before C03 and before dispatch. After C03 reserves and marks an attempt in flight, the wrapper appends each `transport_intent` before registering that transport with C03 and before the injected dispatcher runs. A failed transport evidence write prevents that dispatcher call; C03 conservatively retains the in-flight hold because the wrapper cannot prove whether an external side effect occurred. After C03 returns, its outcome is recursively projected before it is returned to a caller. Unsafe posting-reference values are redacted in that public projection without changing the authoritative settlement state. Final telemetry failure is reported as `evidence_delivery: pending` with a sanitized record when safe; it never converts a settled attempt into an API failure.

The evidence record includes no cost amount. C03 usage observations keep exact provider-reported units, completeness, missing fields, and the distinct identity fields. Valuation and settlement remain with the external authority. A C03 `held_for_reconciliation` state is preserved; this boundary does not invent an external reconciliation ID where the current C03 result has no such field.

## Usage profiles and missing data

Usage parsing requires an explicit profile rather than a guess based on field names:

| Profile | Supported shape | Limitation |
| --- | --- | --- |
| `creative.normalized-token-usage/1` | The trusted adapter's `input_tokens` and `output_tokens`; `total_tokens` is optional. | Internal adapter shape only; it does not claim an external provider schema. |
| `openai.responses-usage/2026-10-10` | `input_tokens`, `output_tokens`, `total_tokens`, optional `input_tokens_details.cached_tokens` / `cache_write_tokens`, optional `output_tokens_details.reasoning_tokens`. | Usage may be absent. New fields mark the observation partial until reviewed. |
| `openai.gpt-image-1-usage/2026-10-10` | `input_tokens`, `output_tokens`, `total_tokens`, and optional nested text/image token details. | The current Images edit reference says usage is optional and documents it for `gpt-image-1` only. The profile refuses other models as unverified. |
| `typesafe.systemone-usage/2026-10-10` | `input_tokens` and `output_tokens` on the pinned `jev-1.13.0` model. | Usage is normalized for the decision attempt; response retry and provider-request identity behavior still require external evidence. |

The Images and Responses documentation was checked on 2026-10-10. The current Images edit reference describes an optional `usage` object with total/input/output tokens and nested text/image details; its description scopes usage to `gpt-image-1`. The Responses create reference describes optional usage with total/input/output counters and cached/cache-write/reasoning details. The TypeSafe API reference describes token usage with integer input/output counts, but does not establish the external retry, deduplication, valuation, or reconciliation protocol. These are documentation shapes, not verified account observations.

When a reported `total_tokens` is present, reported input/output counts are represented as included subsets. Nested detail counts are included subsets of their corresponding parent. No helper sums subsets into a second total. If totals contradict, if a detail total exceeds its reported parent, or if the profile/model is unsupported, numeric units are withheld as `unknown`. Missing or new usage fields are named; a missing field is never represented as zero. New unrecognized extension fields make a known observation partial, and an observation with no usable known units remains unknown.

The pricing page is dynamic. No price table, model rate, currency conversion, amount estimate, or account access is embedded here. Finance must pin an approved rate-card reference and define monetary valuation before any charge attribution can be claimed.

For Responses-orchestrated image tools, orchestration and image-tool charges must be represented as separate billable attempts only when the adapter and external authority establish that those are separate billable executions. A parent response count is not automatically added to nested tool counts. The same applies to JEV, vision, planning, baseline evaluation, edits, and repair: each provider execution uses the existing C03 operation kind that corresponds to the actual billable provider call; this module does not create a new billing category or assert that every network retry was billed.

## Duplicate, retry, and unknown outcomes

The local `deduplicateUsageObservations` helper collapses byte-equivalent normalized payloads only when they share one `source_observation_id`; conflicting payloads with one ID fail closed. Distinct observations are retained. C03 and the injected Finance authority own the actual deduplication key and effective charge. The fixture authority demonstrates one local policy where repeated source IDs and repeated provider request IDs return a duplicate acknowledgement; that is not the external policy.

Each genuinely billed retry must have a different `billable_attempt_id`, its own reservation, all known transport IDs, and its own provider request ID when available. A transport retry retains the same billable attempt only if the adapter's reviewed retry mapping can establish that the transport retry did not create a second billed execution. Otherwise, the adapter must create a new attempt. Unknown retry billing stays unknown instead of being inferred from transport count.

Lost responses, timeout, missing usage, cancellation, expired worker lease, uncertain C03 transitions, and observation-authority failures keep C03's conservative hold. Usage-observation replay and evidence replay never call provider dispatch. A late usage observation for a cancelled in-flight attempt can be durably replayed to C03; an acknowledgement records only that C03 accepted the usage, and it does not clear a held reservation or perform settlement. An outbox record whose attempt scope cannot be re-established is deferred without submission. The current C03 `MeteredAttemptOutcome` provides retained-hold status and reservation identity only for some paths; where it does not return an exact reservation or reconciliation reference, this code omits the missing reference rather than synthesizing one. Finance still needs to define the authoritative reconciliation reference and owner-visible hold lifecycle.

## Privacy and evidence classification

`projectPublicTelemetry` creates a bounded immutable JSON projection. It scans nested string keys and values for credential-like fields/material, bearer/basic credentials, common API-key shapes, signed-URL query parameters, email addresses, and phone numbers. Sensitive key names are omitted; sensitive values are replaced with a fixed marker. Redaction paths contain only positional field indices, not original keys. Dangerous property names are copied as own data properties on null-prototype objects, so `__proto__` remains ordinary data. Cycles, accessors, non-finite numbers, custom object prototypes, and over-limit structures fail closed with constant diagnostics.

The evidence builder uses a strict field allowlist and never accepts raw prompts, source content, image bytes, raw provider errors, or arbitrary SDK span options. It omits admission-token and QR-payload fields, detects short bearer values, and normalizes contract-validation errors to fixed telemetry diagnostics so caller-controlled field names do not escape. Transport evidence and C03 transport authorization are each followed by a cancellation check before the injected dispatcher is invoked. This scanner cannot prove that all personal data or all future credential formats are detected. Keep restricted evidence in separately authorized host storage and expose only reviewed references; do not treat this projection as a retention or deletion policy.

`fixtures/privacy/unsafe-public-values.json` is marked synthetic-only. Its strings are inert canaries, not working credentials, customer data, or provider requests. Tests assert that the canary text and sensitive field names do not appear in the exported projection or redaction diagnostics.

## Local verification and five issue cases

Run source tests and strict public declaration checks directly until root Make/CI ownership is integrated:

```sh
PATH=/Users/completetech/.cache/acv1-toolchains/node-v22.23.3-darwin-arm64/bin:$PATH node --test --test-concurrency=1 tests/telemetry/*.test.mjs
PATH=/Users/completetech/.cache/acv1-toolchains/node-v22.23.3-darwin-arm64/bin:$PATH node /Users/completetech/creative-engine/examples/frontend-action-roundtrip/node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck false --module NodeNext --moduleResolution NodeNext --target ES2022 tests/telemetry/public-consumer.mts
```

The fixture suite covers the five CE-11 cases at the source boundary:

1. Nested image/Responses counts preserve parent/subset relations. Duplicate direct/trace observations for one provider request remain attributable but the fixture authority confirms only one effective charge. The SQLite adapter snapshots payloads, rejects conflicting reuse of a source ID, and retains canonical hashes across reopen.
2. Two distinct attempts for one logical operation retain unique transport and provider request identities. The fixture does not infer that every transport retry is a new billable attempt.
3. Missing usage, lost response, cancellation, and expired lease retain C03 holds. A late observation can be replayed to C03 without a provider call or automatic settlement. Unknown counts are not zero.
4. A required preflight evidence failure stops before reservation, a transport evidence failure stops before provider dispatch, and concurrent competing reservations use C03's injected authority result.
5. Failed provider outcomes remain metered; provider and commerce modes remain independent; nested privacy canaries are omitted/redacted, including C03 posting references on public results. SQLite claim tokens fence stale acknowledgements, separate processes claim a row at most once, and an acknowledgement-loss replay after reopen reuses the same usage ID without provider dispatch. A transaction-composition test verifies the adapter leaves outer commit/rollback to its caller.

These are local fixtures, not live provider, Finance, or Neatlogs evidence. Actual API operation paths have not yet been wired to this module on this source-only branch.

## External and serialized integration gates

Required local follow-up: integrate each CE-01 generation/edit/inspect/list/compare/restore/cancel/handoff/job path; connect C03 retry/outcome records to the CE-08 paired durable store; prove restart/replay and cancellation fences with actual API invocations; add the `creative-metering` Make target, package export, strict public consumer, offline build, acceptance gate and CI workflow after root ownership is released. A fixture outbox alone does not satisfy this local integration requirement.

External agreement and evidence remain pending for Finance's authoritative reservation/settlement/reconciliation and duplicate-attribution contract; canonical versioned producer/consumer correlation and mode schema; provider account-specific usage/retry behavior; accepted dated rate-card; approved Neatlogs host/project/key and regional/privacy controls; actual ingestion and readback; and owner/reviewer acceptance of the shared schema. This branch cannot establish FIN-01/02/03/04/10, BUD-01/02/03, AGT-03, EVAL-03/04, or SPN-01 as globally complete.

## References checked 2026-10-10

- [OpenAI Images edit reference](https://developers.openai.com/api/reference/resources/images/methods/edit)
- [OpenAI Responses create reference](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [OpenAI API pricing](https://developers.openai.com/api/docs/pricing)
- [TypeSafe API reference](https://docs.typesafe.ai/api)
- [Node.js v22.23.3 SQLite API](https://nodejs.org/download/release/v22.23.3/docs/api/sqlite.html)
- Coordinator's read-only static inspection of Neatlogs TypeScript SDK 1.1.28 — local collection, `flush()`, and stock OTLP success are not treated here as durable sink acceptance or Finance acknowledgement.
