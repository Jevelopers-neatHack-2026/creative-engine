# Creative metering boundary proposal

**Status: local consumer proposal; Finance and reliability and Agent and research agreement is pending.** This document and its executable fixtures do not define an accepted cross-repository protocol. The external cost-intelligence service owns budget decisions, valuation, postings, deduplication, settlement, and reconciliation. Creative owns an injected port and must stop before any billable operation when that authority does not grant a reservation.

The proposal is represented by `src/contracts/metering.mjs` and its public declaration `src/contracts/metering.d.mts`. The port can be supplied by a future cost-intelligence adapter without making creative a ledger or depending on the runtime it unblocks.

## Identity and attempt boundary

Every command has a `logical_operation_id` for the user's intended operation and a new `billable_attempt_id` for each potentially billed execution. Each network or SDK transport attempt has its own `transport_attempt_id`. A provider-created `provider_request_id` is added only after the provider supplies it. Each usage report has a distinct `source_observation_id`. These identifiers have different meanings and must not be synthesized from one another.

An image-generation retry known to dispatch another generation is a new billable attempt with a new reservation, even if it belongs to the same logical operation. A network retry can share an attempt only where the selected adapter can establish that it does not create another billable execution. The adapter records its SDK, endpoint, version, and retry-mapping reference; the contract makes no universal idempotency claim.

| Operation | Identity mapping requirement |
| --- | --- |
| Direct Images generation or edit | Record every transport attempt. A second generation/edit that may be billed gets a new billable attempt and reservation. A lost response remains outcome-unknown unless the provider can resolve the original request. |
| Responses orchestration with image tool | Meter orchestration and image-tool usage separately when the external authority's accepted mapping requires it. Preserve tool/request identity and nested usage subsets; do not add a subset to a reported total twice. |
| JEV | Preserve one logical decision, each provider execution, transport retry, provider request when returned, and each trace/usage observation. The harness owns transport. Apply the adapter's observed retry mapping; do not infer idempotency. |
| Planning or baseline operation | Give each billable execution its own attempt and budget binding, including failed or superseded calls when they may incur a charge. |
| Vision observation | Attribute observation calls independently from the later JEV decision. Do not treat a structured observation as proof that an image call was free. |

## Reserve and dispatch

The sequence is `validate trusted scope → reserve with external authority → mark in flight → record each transport attempt → dispatch → submit observations → settle or retain the hold`. The external service chooses or approves the hold from its policy. Creative sends the operation, provider/model/endpoint/SDK identity, authenticated tenant/project/budget scope, environment, billing mode, and budget-policy version; it does not calculate a price.

`validateMeteredAttempt` compares tenant, project, and budget identifiers with server-provided trusted scope. Request-body claims cannot override them. `executeMeteredAttempt` refuses dispatch when reservation is denied or unavailable. Once the authority may have seen an in-flight transition, any lost response, timeout, cancellation, or incomplete usage is treated conservatively as unresolved and the hold stays reserved for reconciliation.

The module never returns provider payloads. It returns only a bounded provider outcome (`succeeded`, `failed`, `partial`, or `unknown`) after dispatch, plus typed metering state. The caller routes any provider payload through its separate authorized result path. Cancellation after dispatch returns no result for publication and asks the metering port to retain the in-flight hold. A late provider completion must be reconciled as an observation; it cannot make the cancelled operation publishable.

Caught provider and authority failures map to constant error codes; denial reasons and exception messages/stacks are not returned. Unexpected dispatch fields are rejected and leave the hold held for reconciliation. Trace updates use fixed protocol reason codes rather than exception objects.

| State | Required behavior |
| --- | --- |
| Reservation denied/unavailable | Do not dispatch. |
| Reserved, known not dispatched | Release only through the authoritative pre-dispatch operation. |
| In flight, complete usage | Submit observation and ask the authority to settle. |
| In flight, partial or absent usage | Record known fields, mark the rest unknown, and retain the hold for reconciliation. Never turn absence into zero. |
| Timeout, lost response, cancellation, or worker-lease expiry | Preserve the hold while outcome may still be in flight. Cancellation prevents publication but does not erase potential cost. |
| Settled | Use the authority's exact consumed and unused-release amounts. Creative does no amount arithmetic. |

## Usage and amount rules

`completeness` is `complete`, `partial`, or `unknown`. `unknown` carries no numeric usage units and names missing fields. `partial` retains reported units and names omissions. Exact provider quantities are decimal strings; each unit identifies whether it is standalone, an included subset of another unit, or has an unknown relation. Missing cached counts, nested tool counts, or monetary values are never replaced with zero.

Provider usage and cost valuation are separate. A usage observation may include an externally defined rate-card reference and a valuation basis, but only the cost authority returns the reservation, exact currency amounts, effective charge, settlement, and release. Monetary values crossing this boundary are exact decimal strings with currency; the creative module uses them only for shape validation. It neither embeds rate tables nor rounds, sums, or converts amounts.

`environment` (`development`, `test`, `production`) and `billing_mode` (`live`, `sandbox`, `simulated`) are separately recorded. Simulated economic behavior does not relabel a live provider call as simulated billing. The fake authority's arithmetic and fixed amounts exist only inside test fixtures and are not product prices or acceptance evidence for the external ledger.

## Agreement gate and ownership

`evaluateMeteringAgreementGate` reports `blocked` until both Finance and reliability and Agent and research provide an accepted status, pinned artifact reference, SHA-256, pinned revision, and independent review reference, along with a pinned external protocol artifact. Complete evidence still returns `owner_review_required`, never accepted: this local gate cannot authenticate an owner or turn fixture data into agreement. The gate remains pending until the owners publish and accept the exact metering/budget schema, retry mapping, duplicate-observation rule, and reconciliation actions and an independent reviewer verifies the pins.

| Acceptance ID | Global owner retained | Creative contribution |
| --- | --- | --- |
| FIN-01 | Finance and reliability | Bind all provider/model/usage/budget/correlation data to each billable attempt, or preserve explicit incompleteness. |
| FIN-02 | Finance and reliability | Preserve source observation identity and submit repeated direct/trace observations without inventing a second attempt. |
| FIN-03 | Finance and reliability | Assign separate attempt identities and reservations to genuinely billed retries. |
| FIN-04 | Finance and reliability | Keep absent usage and timeout-after-dispatch unknown, with a held reservation and reconciliation path. |
| BUD-01 | Finance and reliability | Reserve atomically before provider dispatch; a denied worker never calls the provider. |
| BUD-02 | Finance and reliability | Defer settlement and release amounts to the authority; release unused capacity only after authoritative settlement. |
| BUD-03 | Finance and reliability | Do not release a potentially in-flight hold when a worker lease expires. |

These are creative contributions; they do not change the master checklist's IDs, meanings, priorities, or owner roles. Closure still needs the actual owner-approved protocol, an affected producer/consumer review, and pinned external implementation evidence.

## Test fixture and commands

`fixtures/contracts/metering/fake-authority.mjs` is explicitly a test double. It proves local call ordering, concurrent capacity conservation, observation deduplication, retry identity, unknown holds, cancellation, lease expiry, and unused-only release. It is not a duplicate ledger, production price authority, or cost-intelligence implementation.

Run the standalone bootstrap check with:

```sh
node --test tests/contracts/metering/*.test.mjs
```

The paired ESM declarations are checked through a strict NodeNext consumer with TypeScript 5.9.3:

```sh
tsc --noEmit --strict --skipLibCheck false --module NodeNext --moduleResolution NodeNext --target ES2022 tests/contracts/metering/public-consumer.mts
```

The repository integration entry point is `make check TARGET=metering-contract MODE=mock`. It must run these tests without depending on the creative runtime, provider credentials, or paid calls. The actual finance agreement, live cost service, and release acceptance remain pending.
