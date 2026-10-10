# Creative brief planning proposal

This is the Creative and fulfillment contribution for CE-02 (#10). It consumes the local `EventIntelligencePackage/1.1` validator from CE-C01 and emits the local `CreativeBrief/1.0` proposal. It does not establish that Event Intelligence, Rights, Application, Approval, or the shared-contracts owner has accepted those shapes. The local evaluator remains independent of the external owner gate.

The offline tests run with Node.js 22.23.3 or 24.15.0:

```sh
node --test tests/planning/brief.test.mjs
node /path/to/typescript/bin/tsc --project tests/planning/types/tsconfig.json
```

Root command and package-export integration are serialized separately. The source module is currently imported from `src/planning/index.mjs`; a public `./planning` package subpath must be integrated and reviewed before consumers can rely on that package import.

## Planning behavior

`buildCreativeBrief` takes a normalized or supported legacy research package, a separately trusted `{ tenant_id, project_id }`, and a planning context. It performs deterministic local validation and hashing only. It has no model, network, rights, budget, purchase, renderer, approval-issuer, or provider adapter. The returned policy fixes `provider_calls` to zero and disallows provider dispatch, budget changes, and permission changes.

The brief keeps verified facts, unresolved facts, source provenance, research preferences, customer preferences, research interpretations, customer artistic direction, permissions, and locks in distinct fields. Research-authored interpretation is labeled untrusted. Unknown additive source content is bound into the source package hash but is not copied into the creative output or executed. Customer locks must target a verified fact. Exact event name and date are material facts; if either is missing, unknown, conflicting, empty, or malformed, the plan returns a targeted clarification instead of filling a value in.

A correction to a verified fact creates a pending `ResearchCorrectionRequest` and approval-staleness request. It leaves the verified value and its provenance unchanged. An unchanged correction returns a no-change result. It does not edit the source package or claim that Research accepted the correction.

Source permissions are copied as claims, not authority. A missing, unknown, or denied reproduce claim is blocked. A locally granted claim only reaches `verification_required`. `resolveAssetUse` can produce `eligible_for_downstream_revalidation` only when an injected trusted permission verifier binds tenant, project, asset ID and hash, reproduce action, source package ID and hash, owner evidence, and a current expiry, and the durable invalidation store reports no matching fence. Its result always sets `dispatch_authorized: false`; the actual consumer must revalidate immediately before using the asset. If the trusted clock, owner verifier, or invalidation store is absent, use remains blocked.

The original-artwork option uses no research assets and carries forward verified fact IDs as constraints. It is a planning alternative only; it does not produce typography, SVG/PDF/print files, or a purchasable/shippable item.

## Immutable SQLite history

`openCreativeBriefStore(path, trustedScope)` opens the local `node:sqlite` adapter. `createCreativeBriefStore({ database, trustedScope })` can wrap a caller-owned synchronous SQLite connection, including a future CE08-owned connection, but no CE08 runtime is wired here yet. The adapter scopes every read and write to separately supplied tenant/project IDs.

The brief identity is stable for a scoped source package ID. Each distinct canonical brief hash appends a new increasing `version_no`; an exact duplicate hash returns the existing receipt. A changed source package hash therefore creates a new version under the same brief ID while earlier JSON bytes and hashes remain stored. SQLite triggers reject update/delete attempts against brief history, invalidation receipts, fences, and acknowledgments. The tests close and reopen a file-backed database and verify both versions remain intact.

The adapter persists an authenticated invalidation event, affected fact/asset fences, and approval-staleness outbox rows in one SQLite write transaction. It records the producer acknowledgment only after all associated approval-staleness rows are acknowledged. A failed downstream acknowledgment leaves the durable fence and pending request so replay can retry after restart. Exact duplicate events reuse the existing receipt; a distinct older source revision adds its fences too. Fences only accumulate: this adapter has no permission-restoration or fence-delete operation.

`applyResearchInvalidation` refuses to run while its SQLite connection is inside a caller-owned transaction, and it rechecks this boundary after asynchronous owner/application ports return. A nested savepoint release does not prove durability because the caller can still roll back the outer transaction; no external producer acknowledgment is sent from that provisional state. If another transaction begins while an approval-staleness request is in flight, the run stops before recording that acknowledgment or acknowledging the producer. Replaying the stable request after the transaction completes is expected to be idempotent at the external owner. The SQLite connection's transaction-state property must be available; otherwise invalidation fails closed.

`applyResearchInvalidation` requires a trusted current-time port and an injected owner verifier that authenticates the exact normalized event hash, event ID, tenant, and project. Errors thrown by injected verification and acknowledgment ports are reduced to fixed typed failures; their messages and stacks are never copied into public results. The local event shape and reason vocabulary are a proposal until the Research producer and Application/Approval owners publish and accept their protocols. `synthetic_test` evidence in the fixtures proves adapter behavior only; it is not owner evidence. The code cannot atomically coordinate revocation across independent owner services, and the surrounding application must keep each actual use fenced/revalidated at its own authority boundary.

Evidence references are hashed before entering public planner results or SQLite evidence rows. The actual owner proof remains with the injected authority. This local adapter stores Creative-owned brief snapshots and monotonic invalidation records; it is not a rights ledger or approval issuer.

## Fixtures and required outcomes

`fixtures/planning/research-packages.mjs` provides sourced-event, company-URL, locked-fact, denied-logo, missing-date, conflicting-date, injected-source, and synthetic-admission-credential cases. The test suite checks all seven issue outcomes: repeatable complete briefs and targeted clarification; correction without source-fact overwrite; denied or stale/cross-tenant asset rejection; inert injected source instructions; admission credential omission; changed source hash with immutable new version; and duplicate/out-of-order invalidation across a real SQLite restart without permission resurrection.

The tests use only deterministic local fixtures and injected ports. No real provider, Research, Rights, or Approval service is called. Synthetic verifiers are explicitly labeled and cannot satisfy external acceptance.

## External evidence still required

The following owners must still publish and accept the exact versioned artifacts before CE-02 can be accepted for production integration:

- Research / Event Intelligence: canonical immutable ResearchPackage fields, source identity, fact provenance, content/version hashing, correction request and acknowledgment semantics, and owner-authenticated invalidation events.
- Rights / asset owners: account- and project-scoped permission evidence, the exact meaning and expiry of reproduce permission, revocation delivery, and a current verification endpoint or signed proof format.
- Application / Approval owner: durable approval-staleness request and acknowledgment semantics, stale-approval enforcement at actual consumption, and application membership context.
- Shared contract publisher and CE08 runtime: accepted CreativeBrief / invalidation schemas and the production SQLite connection/transaction ownership contract.

No local fixture, SQLite row, nonempty evidence reference, source URL, or locally reported permission can replace those owner artifacts. The issue remains open until the external agreements, package integration, and acceptance gate are complete.
