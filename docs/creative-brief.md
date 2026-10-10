# Creative brief planning and invalidation

CE-02 (#10) adds deterministic research-package planning to the public `creative-engine` API. The package exposes the typed runtime at `creative-engine/api/v1` and planning helpers at `creative-engine/planning`. `brief.create` and `brief.invalidate` are the only public planning operations. Callers provide customer preferences, interpretation, fact corrections, locks, and an event reference; trusted ports supply the research package, invalidation event, owner verification, and downstream acknowledgments.

Run the local implementation and public-type checks with Node.js 22.23.3 or 24.15.0:

```sh
make check TARGET=brief MODE=mock
make build
make acceptance TARGET=brief
```

The first two commands should pass using deterministic fixtures and make zero provider calls. The acceptance command is expected to exit 2 while required external owner agreements are pending, and emits a machine-readable `creative-brief-acceptance-result/v1` record with `acceptance_allowed: false` and `provider_dispatches: 0`.

## Creating a brief

The API authenticates the actor and checks `creative.brief.create` before loading the current package through `planning.getCurrentResearchPackage`. The request cannot supply verified facts, permissions, package hashes, or evidence as authority. The planner validates the pinned local Event Intelligence package version against a separately trusted tenant/project scope and hashes the normalized input. It emits a `CreativeBrief/1.0` with field-level provenance, verified and unresolved facts, source preferences, customer preferences, untrusted research interpretation, customer artistic direction, permission claims, locks, and a zero-provider execution policy in separate fields.

The request may add preferences, artistic intent, required fact keys, correction proposals, and locks. A missing or conflicting event name/date produces a targeted question instead of an invented fact. A correction remains a request for the source owner; it does not overwrite the verified value or provenance. Unknown source instructions are inert. Ticket/admission credentials and unsafe nested keys or values are omitted or rejected before a public plan is returned.

The API persists a brief action and the current brief head in the CE08 SQLite connection. The scoped action ID is idempotent: an identical replay returns the same plan, while reuse with a different request conflicts. An expected brief hash provides compare-and-set behavior. A changed normalized package hash creates a new immutable brief-history entry and advances the single `creative_briefs` current pointer in the same transaction. The old canonical brief bytes and hash remain available to validate historical DesignVersions. The migration path may copy an already validated legacy current brief into history; that copy does not promote facts, permissions, or owner evidence.

## Asset eligibility and actual use

Research permission fields and the brief's permission section are claims, not grants. There is no public asset-eligibility operation. The trusted runtime permission port binds tenant, project, package ID/hash, asset ID/content hash, action, evidence status, check time, and expiry. An absent, unknown, denied, expired, revoked, cross-scope, mismatched, or durably fenced asset is rejected before route resolution, metering, or provider dispatch.

The runtime rechecks the current package and permission after asynchronous verification, checks the same-database invalidation fences, and relies on the final version-store compare-and-set before publication. Downstream selection, inspection, and handoff paths also check brief usability and retain the exact historical brief context for reads. These local checks do not create a rights ledger or make independent remote authorities atomic. The consuming application must keep its own actual-use and approval boundaries fenced.

The original-artwork alternative uses no research asset and preserves verified fact IDs as constraints. It is not a renderer and does not promise exact typography, print output, or purchasable fulfillment.

## Invalidation, durability, and replay

`brief.invalidate` accepts only an `event_id`. The runtime loads the event from a trusted port, verifies its exact normalized hash and tenant/project scope, then records its receipt, affected fact/asset fences, approval-staleness outbox rows, and acknowledgment state on the same SQLite connection as the current brief and design versions. Fences are monotonic; no permission-restoration operation exists.

External approval-staleness callbacks run only after the local fence transaction commits. The producer acknowledgment is sent only after all required approval acknowledgments are durable. If a callback fails or the process exits after local commit, the fence remains in place and a later call can replay the pending idempotent acknowledgment. An uncommitted caller transaction or nested savepoint cannot authorize external callbacks. Public results report `pending` until the producer acknowledgment exists; a local fixture or nonempty evidence reference cannot claim owner verification.

Current-brief and asset fences are checked again after awaited verifier/provider/telemetry boundaries and by the final storage compare-and-set. An out-of-order older invalidation can add a fence but cannot clear a newer or existing fence. Duplicate events reuse their durable receipt. Historical artwork remains immutable, but invalidated source facts or assets cannot be used for new downstream work.

## Checks and remaining owner decisions

`make check TARGET=brief MODE=mock` runs the planner and public API integration tests, including all seven CE-02 scenarios: repeatable sourced facts and clarification; correction without overwrite; denied, expired, and cross-scope assets blocked before dispatch; inert source instructions; admission credential omission; immutable brief history with retained design context; and duplicate/out-of-order invalidation across restart and hard-exit replay. It also strict-typechecks a consumer using the actual package exports. These tests use synthetic adapters and do not call Research, Rights, Approval, or a paid provider.

`make acceptance TARGET=brief` independently checks pinned, independently verified owner records. The following are still pending and cannot be satisfied by local fixtures:

- Shared contract publisher and Event Intelligence: accepted package, fact/provenance, compatibility, and correction schemas; Event Intelligence issues [#10](https://github.com/Jevelopers-neatHack-2026/event-intelligence/issues/10), [#18](https://github.com/Jevelopers-neatHack-2026/event-intelligence/issues/18), and [#20](https://github.com/Jevelopers-neatHack-2026/event-intelligence/issues/20) cover package provenance, permission states, and durable invalidation delivery.
- Rights and asset owners: authenticated tenant/project scoped permission evidence, exact use/action semantics, expiry and revocation behavior.
- Application/Approval and membership owners: accepted membership context, durable approval-staleness acknowledgment, and enforcement at actual consumption.

The repository still does not implement a Research service, a rights authority, an approval issuer, external owner authentication, or a renderer. The `synthetic_test` fixtures demonstrate local adapter behavior only. CE-02 remains open until those owner agreements and the full integrated acceptance gate pass.
