# Development, checks and acceptance gates

This is the detailed build, check and status reference for `creative-engine`. The [root README](../README.md) is the short front door; the subsystem documents linked from it remain the authoritative detail for each package subpath.

## Toolchain

- [`.node-version`](../.node-version) pins Node.js 24.15.0; [`package.json`](../package.json) `engines` accepts `>=22.23.3`.
- The CI workflows ([api](../.github/workflows/api.yml), [contracts](../.github/workflows/contracts.yml), [controls](../.github/workflows/controls.yml)) run a matrix of Node.js 22.23.3 and 24.15.0 on `ubuntu-24.04`.
- Use Node.js 22.23.3 for the production-target checks. Node.js 24.15.0 is also checked for development compatibility.
- Public type consumers are checked with the locked TypeScript 5.9.3 from [`examples/frontend-action-roundtrip`](../examples/frontend-action-roundtrip/package.json), in strict NodeNext mode.
- `make bootstrap` runs three locked installs: the root package (`npm ci --ignore-scripts --offline`), the browser example (`npm ci --prefix examples/frontend-action-roundtrip`) and the isolated image codec (`npm ci --prefix src/models/codec-runtime --ignore-scripts`).

## Build and offline checks

From the repository root:

```sh
make bootstrap
make build
make check TARGET=api MODE=mock
make check TARGET=brief MODE=mock
make check TARGET=controls MODE=mock
make check TARGET=contracts MODE=mock
make check TARGET=decision-contract MODE=mock
make check TARGET=eval-policy MODE=mock
make check TARGET=metering-contract MODE=mock
make check TARGET=handoff-contract MODE=mock
make check TARGET=access-preflight MODE=mock
make check TARGET=access-preflight MODE=live
make check TARGET=image-adapter MODE=mock
make check TARGET=openrouter-image-adapter MODE=mock
make check TARGET=inspection MODE=mock
make check TARGET=versions MODE=mock
make check TARGET=creative-metering MODE=mock
make check TARGET=all MODE=mock
```

Any other `TARGET`/`MODE` pair is rejected by the [Makefile](../Makefile) with exit 2: only offline mock checks are implemented, no live provider dispatch exists, and the access-preflight, image-adapter, openrouter-image-adapter and inspection live gates are fail-closed.

The API, contract, control, evaluation-policy, access-preflight, versions, and brief checks use synthetic fixtures and make no paid provider calls. `make check TARGET=api MODE=mock` writes a sanitized, versioned summary to `build/api-check-evidence.json`. `make check TARGET=brief MODE=mock` runs the seven CE-02 integration scenarios and strict public planning/API/version type checks. `make check TARGET=access-preflight MODE=mock` exercises the fixed eight-cell access matrix, writes sanitized mock evidence to `build/access-preflight-evidence.json`, and keeps acceptance pending. `make check TARGET=access-preflight MODE=live` writes `build/access-preflight-live-gate.json`, prints the blocked per-cell reasons, and exits 2 with zero provider dispatches when trusted live adapters and external owner evidence are absent. A user-supplied JSON claim cannot enable live access. The exported `runAccessPreflight` API can be composed by a trusted host with real owner adapters; this repository does not install that host or read credentials. `make acceptance TARGET=access-preflight` reports the same missing live owner evidence and exits 2. `make check TARGET=versions MODE=mock` runs the paired durable API/store and process-restart cases, plus strict public-subpath typechecking. `make check TARGET=eval-policy MODE=mock` runs the policy, corpus, register, report, and acceptance-gate fixtures; local checks may pass while owner evidence remains pending. `make acceptance TARGET=brief` emits machine-readable evidence and exits 2 until the canonical package, permission, invalidation, membership, and approval-staleness agreements have been independently verified. `make acceptance TARGET=api`, `make acceptance TARGET=contracts`, `make acceptance TARGET=decision-contract`, `make acceptance TARGET=metering-contract`, `make acceptance TARGET=handoff-contract`, and `make acceptance TARGET=versions` also intentionally fail while their canonical owner agreements remain pending. `make acceptance TARGET=eval-policy` separately emits machine-readable evidence and exits 2 until accountable owners publish and independently verify the required corpus, question inventory, rubric, telemetry, budget, and policy approvals. `make acceptance TARGET=all` includes those agreements, CE-Q01 policy/corpus evidence, and the CE-A01 live access gate.

`make check TARGET=image-adapter MODE=mock` runs the CE-03 native Images adapter tests, writes `build/image-adapter-evidence.json` and typechecks the `creative-engine/models` consumer. `make check TARGET=image-adapter MODE=live` writes `build/image-adapter-live-gate.json` and exits 2 before any provider dispatch; `make acceptance TARGET=image-adapter` also exits 2. See [Direct OpenAI Images adapter](providers/openai-images.md).

`make check TARGET=openrouter-image-adapter MODE=mock` (CE-03-OR) runs all `tests/models/*.test.mjs` (the OpenRouter adapter, its intercepted API/C03/CE08/CE11 integration and store tests, plus the direct adapter tests), writes `build/openrouter-image-adapter-evidence.json` and typechecks the `creative-engine/models` consumer. `make check TARGET=openrouter-image-adapter MODE=live` writes `build/openrouter-image-adapter-live-gate.json`, reads no credential or environment variable, makes zero provider requests, and exits 2. It is part of `TARGET=all`. See [OpenRouter Images adapter](providers/openrouter-images.md).

`make check TARGET=inspection MODE=mock` runs the CE-09 inspection check (`build/inspection-evidence.json`) and typechecks the `creative-engine/inspection` consumers. `make check TARGET=inspection MODE=live` writes `build/inspection-live-gate.json` and exits 2 before any dispatch; `make acceptance TARGET=inspection` also exits 2. See [inspection policy](creative/inspection-policy.md).

The standalone workflows check the public API, contract, metering, approval-handoff, preflight, planning, versions, and telemetry package imports with TypeScript 5.9.3 in strict NodeNext mode. `make bootstrap` installs the locked TypeScript consumer tools used by those checks. Run `make typecheck-api`, `make typecheck-brief`, `make typecheck-preflight`, `make typecheck-versions`, or `make typecheck-telemetry` to check public consumers directly. The Makefile also provides `make typecheck-contracts`, `make typecheck-models`, `make typecheck-inspection` and `make typecheck-controls`. The supported runtime checks use Node.js 22.23.3 and Node.js 24.15.0.

`make check TARGET=creative-metering MODE=mock` exercises the current generate, edit, inspection, and DecisionPort attempt paths against injected fixture ports. It checks usage profiles, durable outbox identity, replay, and rejection before reservation when evidence cannot be committed. CE-02 deterministic brief planning and invalidation are integrated locally without provider calls. Inspection-authorized repair is integrated through the ordinary edit/C03/telemetry path and durable repair limits; see the [inspection policy](creative/inspection-policy.md) and [usage evidence guide](usage-trace-evidence.md) for behavior and pinned component receipts. Durable external-result staging and exact receipt reconciliation for approval-bound handoff remain with the [existing CE-10/H writer](https://github.com/Jevelopers-neatHack-2026/creative-engine/issues/19#issuecomment-6131157476). Responses orchestration is optional until selected; any selected billable path must use C03 metering and this evidence boundary. `make acceptance TARGET=creative-metering` exits 2 because no authoritative Neatlogs evidence-sink agreement reference or verified ingestion/readback is available; the Finance and usage-schema agreement checks do not override this gate.

```sh
make typecheck-api
make typecheck-contracts
```

The controls browser example has its own lockfile and dependency install. Its Node and Chromium roundtrip instructions, local evidence format, and remaining integration requirements are in [controls integration](controls-integration.md). It uses mock application identity and state. The packed-tarball consumer check run by `make check TARGET=controls MODE=mock` is described in [controls package integration](controls-package-integration.md).

`make acceptance TARGET=all` reports the same pending local H → R1 → E1 → R2 → Q integration prerequisites as `TARGET=controls`, alongside canonical owner, policy, access and provider evidence. These local prerequisites remain release blockers even if external evidence is supplied. Mock checks do not satisfy them.

## Detailed package status

These paragraphs were the opening of the root README before the 2026-10-11 refresh.

Creative-engine contains a local controls service, dependency-free contract validators, and a typed non-UI creative API runtime. The controls package validates bounded creative changes and stores a durable local Apply outbox. The API handler implements generate/edit/inspect/list/compare/restore/cancel/handoff, job status, and deterministic `brief.create`/`brief.invalidate` operations around injected jobs, storage, provider, research/rights, DecisionPort, metering, approval, inspection, handoff, and telemetry ports. Current generate/edit/inspection/DecisionPort attempts require explicit usage profiles and persist sanitized attempt evidence on the same SQLite connection as the durable API store. Its public contract and C01/C02/C03/C04 schemas remain local proposals pending external owner agreement; production provider transports, application authentication, finance authority, approval issuance, and rendering are not implemented here.

The `creative-engine/planning` subpath provides the deterministic CreativeBrief planner. Brief history, the current pointer, API idempotency, and invalidation fences share the durable `creative-engine/versions` SQLite connection. Planning does not grant asset rights; exact external ResearchPackage, permission, invalidation, membership, and approval-staleness agreements remain pending. Detail: [creative brief planning](creative-brief.md).

The `creative-engine/versions` subpath exposes a local SQLite-backed version adapter that pairs immutable design records and exact content-addressed artifact bytes with selection CAS and API job completion in one database transaction. Recovery and restore do not dispatch providers. Handoff remains unavailable until durable external-result staging is implemented. Local tests do not certify production-host durability or external acceptance. Detail: [version state machine](creative/version-state-machine.md).

The `creative-engine/telemetry` subpath exposes the CE-11 usage/evidence boundary and SQLite outbox. It reuses the C03 metering authority and does not create a budget ledger. The local outbox refuses to append or claim externally deliverable records inside an uncommitted outer transaction. Neatlogs protocol agreement, actual ingestion, and readback remain unresolved; passing local checks does not satisfy those gates. Detail: [usage and trace evidence](usage-trace-evidence.md).

The controls service, API fixtures, and contract tests exercise local validation and injected port boundaries. They do not establish application membership, a production job store, external finance or approval authority, actual model routing, provider capability, licensing, or external acceptance. Missing runtime ports return an unavailable error; the API does not substitute a successful mock result.
