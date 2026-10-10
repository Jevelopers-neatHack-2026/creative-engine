# Approval and exact-artifact handoff proposal

**Status: local consumer proposal; Product and frontend, Creative and fulfillment, and Agent and research agreement is pending.** Creative does not issue customer approval, sign approval claims, implement a production renderer, or certify printing. The verifier, key store, current revocation state, stable artifact access, and production consumer belong to their external owners. Local fake verifier and consumer fixtures are clearly test-only and do not establish those owners' readiness.

The proposal uses `src/contracts/approval-handoff.mjs` with its public declaration `src/contracts/approval-handoff.d.mts`. `ArtworkHandoff` and `CompositionEditPlan` are separate from the external `ProductionBundle`.

## Approval binding and verification

An approval request is checked against authenticated server scope and a normalized binding containing:

- tenant and project;
- immutable design version ID and artwork SHA-256;
- brief ID/hash and facts revision/hash;
- every included asset ID/hash, permission reference, and intended use;
- composition ID/revision/hash and displayed preview hash;
- optional action and actor IDs when the issuer contract supplies them.

`createArtworkHandoff` requires an injected `verifyApproval` port. It sends the trusted scope, exact expected binding, opaque approval reference, and expected consumer audience. It creates no handoff unless the verifier returns a current valid result whose binding matches byte-for-byte after deterministic normalization. The composition digest is computed over the exact normalized ordered layer manifest, so changing an asset, text layer, or layer order invalidates the bound composition. A local UI flag, customer session, preview click, or Creative-generated value is not an approval.

Verifier outcomes are fail-closed: rejected/forged, stale, expired, revoked, wrong-audience, and unavailable/revocation-unavailable results do not create a handoff. Unavailability is typed and retryable, but never falls through to approval. The external verifier owns key rotation and revocation: it must identify the issuer and key-set version it actually trusted, accept only its documented current/overlap key policy, reject unknown or retired keys, and report current revocation evidence. Creative preserves those references and asks the authority again at consumption. It does not retain signing keys or invent a grace period.

Changing artwork bytes/version, any material fact or brief, an approved asset/permission, or composition/preview revision/hash makes the earlier approval stale. Final regeneration creates a new `DesignVersion` and must pass external approval again.

## Immutable handoff and consumer receipt

The handoff contains the exact artwork artifact ID, opaque stable locator reference, SHA-256, MIME type, pixel dimensions, and access-policy reference. Every binary artifact ID is unique across the selected artwork and approved-asset layers so map-based retrieval cannot overwrite one artifact with another. It contains no bearer URL. Retrieval must reauthorize each fetch through the access owner; expired access is renewed by authorization, never by reviving an expired signed URL. Each approved binary layer asset carries its own immutable artifact reference/hash/MIME/dimensions and permission reference. Text layers carry exact text and typed layer identity.

The declared consumer reads the selected bytes through authorized access, recomputes SHA-256 for every binary object, checks MIME/dimensions and all required layers, and returns a typed `ConsumptionReceipt` with the handoff/approval/design IDs, byte hashes, layer IDs, access-grant references, consumer identity, and time. The receipt also binds SHA-256 digests of the normalized approval binding, composition digest, normalized layer manifest, and approval proof; changing any approved material makes an earlier receipt stale. Wrong bytes, denied access, a missing layer, stale approval, or unavailable revocation check must fail explicitly. A receipt proves the declared consumer accepted those exact bytes; it does not prove rendering, preflight, printing, shipping, or purchase.

The local `verifyHandoffArtifacts` helper verifies byte hashes and required layer coverage. It does not fetch artifacts or authorize access. Those actions remain with the consumer. `validateConsumptionReceipt` compares the receipt to the trusted handoff and scope; it cannot authenticate an external consumer's signature or access decision.

## Composition instructions

`createCompositionEditPlan` accepts only typed composition operations: exact text replacement, text size, bounded normalized layout, and positioning of an already bound approved logo. It has no image-provider or renderer dependency and returns a new composition revision that requires review and approval after application. It does not rasterize text, select fonts, produce SVG/PDF, calculate print output, call Images, or claim a `ProductionBundle` exists. Composition instructions describe consumer work; they are not proof that the external renderer applied it.

The zero-image fixture exercises name/size, layout, and approved-logo-position operations through a declared test consumer with a counted fake image adapter. Its zero-call result applies only to that fixture boundary; the accepted live route still needs the separately owned integration evidence.

## Agreement gate and acceptance mapping

`evaluateApprovalHandoffAgreementGate` reports `blocked` until Product and frontend, Creative and fulfillment, and Agent and research provide an accepted status, pinned artifact reference, SHA-256, pinned revision, and independent review reference, along with a pinned external protocol artifact. Complete evidence still returns `owner_review_required`, never accepted: this local gate cannot authenticate an owner or turn fixture data into agreement. The owners and reviewers must verify the actual issuer/verifier protocol, exact binding, access renewal semantics, consumer manifest and receipt, and compatibility before external acceptance.

| Acceptance ID | Global owner retained | Creative contribution |
| --- | --- | --- |
| ART-02 | Product and frontend | Reject stale approval after artwork, fact, asset, or composition change; verify through an external issuer/verifier. |
| ART-03 | Creative and fulfillment | Hand off exact deterministic text and composition instructions; actual typography/rendering stays with production. |
| ART-04 | Creative and fulfillment | Preserve exact artifact hash and metadata for consumer verification; print preflight remains external. |
| ART-05 | Creative and fulfillment | Bind every included asset and its permission reference; production must consume only those approved references. |
| CON-01 | Agent and research | Use an explicitly versioned proposal and reject unsupported schema versions. |
| CON-02 | Agent and research | Validate tenant/project against trusted scope and reject forged or cross-tenant approval claims. |

These are contributions only. They preserve the global acceptance IDs, meanings, priorities, and owner roles. The local fixture does not satisfy product approval, production readiness, typography, preflight, or commercial release.

## Test fixture and commands

`fixtures/contracts/approval/fake-boundaries.mjs` declares both the issuer/verifier and production consumer as test doubles. It covers stale binding, forged/cross-tenant/expired/revoked/unavailable approval, exact-byte hash comparison, missing layers, denied artifact access, typed consumer receipts, and deterministic composition edits with a counted zero-call image double. No fixture signs a real approval or renders production art.

Run the standalone bootstrap check with:

```sh
node --test tests/contracts/approval/*.test.mjs
```

The public `.d.mts` declarations for both boundary modules are exercised by a strict NodeNext consumer with TypeScript 5.9.3:

```sh
tsc --noEmit --strict --skipLibCheck false --module NodeNext --moduleResolution NodeNext --target ES2022 tests/contracts/metering/public-consumer.mts
```

The package exposes this proposal as `creative-engine/contracts/approval-handoff`; the repository integration entry point is `make check TARGET=handoff-contract MODE=mock`. It runs these tests and the strict public type consumer independently of the creative runtime and makes no provider calls. `make acceptance TARGET=handoff-contract` must fail until Product and frontend accepts the approval verifier/consumer boundary, Creative and fulfillment accepts the production handoff, and Agent and research accepts the shared approval/handoff schemas. The real issuer/verifier, production consumer agreement, and all live or print acceptance remain pending.
