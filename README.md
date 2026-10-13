<a href="https://github.com/Jevelopers-neatHack-2026/creative-engine">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/banner-night.svg">
    <img alt="creative-engine — Briefs, versions and creative controls. TicketStub banner showing three offset stub versions layered like proofs with a small control dial." src="docs/assets/readme/banner-day.svg" width="100%">
  </picture>
</a>

# creative-engine

Typed creative API runtime for TicketStub: creative briefs, immutable design versions, parentless concept creation and bounded creative controls around injected provider, metering and approval ports.

<p>
  <a href="https://github.com/Jevelopers-neatHack-2026"><img alt="TicketStub ecosystem" src="https://img.shields.io/badge/TicketStub-ecosystem-E4572E?style=flat-square&labelColor=17140F"></a>
  <a href="#status"><img alt="Status: local foundation, external owner acceptance pending" src="https://img.shields.io/badge/status-local%20foundation-B4693E?style=flat-square&labelColor=17140F"></a>
  <a href=".github/workflows/api.yml"><img alt="Node.js 22.23.3 and 24.15.0" src="https://img.shields.io/badge/node-22.23.3%20%7C%2024.15.0-26302A?style=flat-square&labelColor=17140F"></a>
  <a href="examples/frontend-action-roundtrip/package.json"><img alt="Types checked with TypeScript 5.9.3, strict NodeNext" src="https://img.shields.io/badge/types-TS%205.9.3%20NodeNext-7CC6D2?style=flat-square&labelColor=17140F"></a>
</p>

[Status](#status) · [Architecture](#architecture-and-responsibilities) · [Package subpaths](#package-subpaths) · [Quickstart](#quickstart) · [Configuration](#configuration) · [Checks](#checks) · [Docs](#docs) · [Related](#related-repositories)

## Status

Implemented locally and exercised with synthetic fixtures (no paid provider calls):

- A non-UI API handler for `generate`, `edit`, `inspect`, `list`, `compare`, `restore`, `cancel`, `handoff`, `job.status`, `brief.create` and `brief.invalidate` around injected ports. Missing ports return `unavailable`; the API never substitutes a mock success.
- Parentless `concepts.create` is a separately versioned Creative API 1.1 operation. It edits two authorized image references and persists each candidate as an independent immutable version; legacy 1.0 requests and results retain their prior shape.
- Creative API 1.2 adds durable `composition.create`, `composition.get` and `composition.update`; API 1.3 adds identity-only `composition.history` and fresh-proof `composition.revalidate`. The versioned operation arms stay distinct. Composition uses injected owner evidence and does not itself dispatch image generation, JEV or a Finance reservation ([API versions](docs/api/creative-api.md)).
- Deterministic brief planning, a durable SQLite version store with content-addressed bytes, a controls Apply outbox, inspection checks with a bounded repair counter, and a usage-evidence outbox. Brief history and attempt evidence share the API store's SQLite connection.

Boundaries that local checks do not cross:

- **Planning** does not grant asset rights; permission fields are claims, not grants.
- **Recovery and restore** do not dispatch providers. **Handoff** stays `unavailable` until durable external-result staging is implemented.
- **Telemetry** reuses the C03 metering authority and does not create a budget ledger. Neatlogs protocol agreement, actual ingestion and readback remain unresolved.
- **Live provider access** is fail-closed: the access-preflight, image-adapter, openrouter-image-adapter and inspection live gates exit 2 with zero dispatches, and `MODE=live` is not implemented.
- Application authentication, finance authority, approval issuance and rendering are not implemented here. Local process-restart tests do not certify production-host durability.

Pending: the C01–C04 contract and schema proposals await external owner agreement ([agreement status](docs/contracts/canonical-owner-agreements.json)). Every `make acceptance` target exits 2 until that owner evidence is published and independently verified. The [creative release gate #12](https://github.com/Jevelopers-neatHack-2026/creative-engine/issues/12) remains open. See [development and acceptance gates](docs/development.md#detailed-package-status) for the full statement.

## Architecture and responsibilities

The application supplies authenticated project scope and composes the creative API with research, rights, provider, DecisionPort, Finance, approval and storage ports. This repository owns brief planning, creative operations, immutable design/composition history, provider adapters and their local recovery/usage boundaries.

The customer application owns approval issuance. `cost-intelligence` owns spending authority and reconciliation; `agent-harness` owns the JEV transport. `print-production` owns final event text, personalized typography, rendering and print validation. A local composition preview or selected artwork version is not a production approval.

The core API is a library handler, not an HTTP service. The [frontend roundtrip example](examples/frontend-action-roundtrip/) provides a separate local host with synthetic application authority; its successful fixtures do not establish production-host integration.

## Package subpaths

Exports from [`package.json`](package.json); each has an ESM `.mjs` runtime and a `.d.mts` declaration under [`src/`](src/).

| Import | Purpose | Detail |
| --- | --- | --- |
| `creative-engine/api/v1` | Typed creative API and handler factory | [Creative API v1](docs/api/creative-api.md) |
| `creative-engine/contracts` | Dependency-free contract validators (index) | [Consumer contract proposal](docs/contracts/creative-boundary.md) |
| `creative-engine/contracts/creative/v1` | Creative consumer contract proposal (CE-C01) | [Consumer contract proposal](docs/contracts/creative-boundary.md) |
| `creative-engine/contracts/decision-port/v1` | DecisionPort consumer proposal (CE-C02) | [DecisionPort proposal](docs/contracts/decision-port.md) |
| `creative-engine/contracts/metering` | C03 metering boundary proposal | [Metering proposal](docs/contracts/metering.md) |
| `creative-engine/contracts/approval-handoff` | Approval and exact-artifact handoff proposal | [Handoff proposal](docs/contracts/approval-handoff.md) |
| `creative-engine/contracts/composition-authority` | Versioned composition authority, revision and preview validators | [Composition API](docs/api/creative-api.md) |
| `creative-engine/preflight` | CE-A01 eight-cell provider access preflight | [Provider access](docs/operations/provider-access.md) |
| `creative-engine/planning` | Deterministic CreativeBrief planner (CE-02) | [Brief planning](docs/creative-brief.md) |
| `creative-engine/versions` | SQLite version store, selection CAS and API ports | [Version state](docs/creative/version-state-machine.md) |
| `creative-engine/controls` | Controls runtime, ApplyStore and API adapter (CE-05) | [Controls integration](docs/controls-integration.md) |
| `creative-engine/inspection` | Deterministic checks, DecisionPort questions, bounded repair (CE-09) | [Inspection policy](docs/creative/inspection-policy.md) |
| `creative-engine/models` | Direct OpenAI Images adapter (candidate models unselected, CE-03) and OpenRouter Images adapter (explicit host profile, CE-03-OR) | [OpenAI Images](docs/providers/openai-images.md) · [OpenRouter Images](docs/providers/openrouter-images.md) |
| `creative-engine/telemetry` | CE-11 usage/evidence boundary and SQLite outbox | [Usage evidence](docs/usage-trace-evidence.md) |

The package is `private` at version `0.0.0`; it is not published to a registry.

## Requirements

Use Node.js **22.23.3** for production-target checks. CI also runs **24.15.0**, which [`.node-version`](.node-version) pins for development; `engines` accepts `>=22.23.3`. Make and npm are required for the documented targets. Strict NodeNext typechecks use TypeScript **5.9.3** from the locked browser example, and the image codec has its own locked dependency install.

## Quickstart

For a fresh checkout, install all three locked dependency sets from the repository root:

```sh
npm ci --ignore-scripts
npm ci --prefix examples/frontend-action-roundtrip
npm ci --prefix src/models/codec-runtime --ignore-scripts
make build
make check TARGET=contracts MODE=mock
```

`make build` checks source syntax and strict public-consumer types. With the root packages already cached, `make bootstrap` runs the same three installs with `--offline` on the root install. Browser checks require the separate Chromium installation in [controls integration](docs/controls-integration.md); the quickstart above does not launch the browser example or call a provider.

## Configuration

Core modules receive configuration and credentials through trusted host ports; they do not implicitly read a `.env` file or choose a default live provider.

| Configuration boundary | Required host input |
| --- | --- |
| API and durable storage | Current authenticated scope, explicit dependencies, SQLite database path and content-addressed object root |
| Research, rights and composition | Versioned source packages, current permission/invalidation checks and exact preview/revision evidence |
| Provider and DecisionPort routes | Explicit model/operation/profile pins, server-side credential resolver and owned dispatch fences |
| Finance and telemetry | Current reservation authority, attempt identities, usage profiles and durable evidence delivery |
| Approval and production | Independently issued exact-artifact approval and an accepted handoff consumer |

See [API composition](docs/api/creative-api.md), [execution target preparation](docs/operations/execution-target-preparation.md), [provider access](docs/operations/provider-access.md) and the individual provider guides. Names such as `CREATIVE_ENGINE_OPENROUTER_API_KEY` in host examples are injection placeholders; the adapter does not load that environment variable. Missing or unverified authority leaves the affected operation unavailable.

## Checks

All offline; synthetic fixtures, no paid provider calls:

```sh
make check TARGET=all MODE=mock        # aggregate offline suite
make check TARGET=api MODE=mock        # writes build/api-check-evidence.json
make check TARGET=versions MODE=mock   # durable store and process-restart cases
make check TARGET=composition MODE=mock # API 1.2/1.3 composition and strict types
make acceptance TARGET=all             # expected to exit 2 while owner evidence is pending
```

Per-area targets (`brief`, `controls`, `contracts`, `decision-contract`, `eval-policy`, `metering-contract`, `handoff-contract`, `access-preflight`, `image-adapter`, `openrouter-image-adapter`, `inspection`, `creative-metering`), their live-gate behavior, evidence files and typecheck targets are listed in [development and acceptance gates](docs/development.md). The [Makefile](Makefile) defines the executable target/mode combinations. The concepts target is described below. Install the Chromium prerequisites in [controls integration](docs/controls-integration.md) before browser verification.

`make check TARGET=concepts MODE=mock` runs the native-edit fixture journey, public persistence and recovery cases, and an offline installed-package API consumer. `MODE=CI` runs the same local checks; `MODE=failclosedlive` exits 2 without dispatching or reading provider credentials. The local Creative API 1.1 mapping and external owner agreements remain pending acceptance.

CI has separate [API](.github/workflows/api.yml), [contracts](.github/workflows/contracts.yml) and [controls](.github/workflows/controls.yml) workflows with pinned Node matrices. There is no separate Markdown or application lint script; syntax and strict type checks are part of the build.

## Repository structure

| Path | Contents |
| --- | --- |
| [`src/api/`](src/api/), [`src/runtime/`](src/runtime/) | Versioned request handler and operation orchestration |
| [`src/contracts/`](src/contracts/), [`src/preflight/`](src/preflight/) | Local contract proposals and explicit access checks |
| [`src/planning/`](src/planning/), [`src/generation/`](src/generation/), [`src/models/`](src/models/) | Briefs, concepts, provider adapters and isolated codec |
| [`src/versions/`](src/versions/), [`src/storage/`](src/storage/), [`src/telemetry/`](src/telemetry/) | Durable history, immutable bytes and usage evidence |
| [`src/controls/`](src/controls/), [`src/inspection/`](src/inspection/) | Creative actions, inspection and bounded repairs |
| [`examples/frontend-action-roundtrip/`](examples/frontend-action-roundtrip/) | Separate local browser host and locked test tools |
| [`tests/`](tests/), [`fixtures/`](fixtures/), [`evals/`](evals/), [`docs/`](docs/) | Offline checks, historical migration custody, evaluation policy and guides |

## Docs

- [Development, checks and acceptance gates](docs/development.md)
- [Repository responsibilities](docs/architecture/OWNERSHIP.md) · [acceptance view](docs/architecture/ACCEPTANCE.md)
- [Creative API v1, injected ports and dispatch fencing](docs/api/creative-api.md)
- [Parentless concept creation and local CE-04 integration](docs/creative/concept-generation.md)
- [Brief planning, rights checks and invalidation](docs/creative-brief.md) · [version state machine](docs/creative/version-state-machine.md)
- [Controls integration](docs/controls-integration.md) · [controls package](docs/controls-package-integration.md) · [inspection consumer preparation](docs/controls/inspection-consumer-preparation.md)
- [Inspection policy](docs/creative/inspection-policy.md) · [evaluation policy](docs/evaluation/creative-evaluation.md) · [rubric](docs/evaluation/creative-rubric.md)
- [Provider access preflight](docs/operations/provider-access.md) · [OpenAI Images adapter](docs/providers/openai-images.md) · [OpenRouter Images adapter](docs/providers/openrouter-images.md)
- [Usage and trace evidence](docs/usage-trace-evidence.md)
- Contract proposals: [consumer](docs/contracts/creative-boundary.md) · [DecisionPort](docs/contracts/decision-port.md) · [metering](docs/contracts/metering.md) · [approval handoff](docs/contracts/approval-handoff.md) · [owner agreements](docs/contracts/canonical-owner-agreements.json)
- [Architecture reference](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/blob/main/docs/architecture-kit/v1.0/README.md) · [implementation plan](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/blob/main/docs/planning/implementation-plan.md)

## Related repositories

- [event-intelligence](https://github.com/Jevelopers-neatHack-2026/event-intelligence): research packages, permissions and invalidation consumed by planning.
- [shared-contracts](https://github.com/Jevelopers-neatHack-2026/shared-contracts): canonical schemas for the pending contract agreements.
- [cost-intelligence](https://github.com/Jevelopers-neatHack-2026/cost-intelligence): metering and budget authority behind the C03 port.
- [agent-harness](https://github.com/Jevelopers-neatHack-2026/agent-harness): DecisionPort/JEV transport and workflow coordination; application authentication and approval remain external.
- [print-production](https://github.com/Jevelopers-neatHack-2026/print-production): exact event text, typography and print validation downstream of a selected version.
- [getticketstub.com](https://github.com/Jevelopers-neatHack-2026/getticketstub.com): authenticated application host and approval issuer.
- [integration-evals](https://github.com/Jevelopers-neatHack-2026/integration-evals): cross-component acceptance and selected journey evidence.

## Contributing

Read [AGENTS.md](AGENTS.md) and follow the organization [contribution workflow](https://github.com/Jevelopers-neatHack-2026/.github/blob/main/standards/contribution-workflow.md). Record the exact tested source and fixture scope in PRs. Accepted product states are owned by the [integration-evals master checklist](https://github.com/Jevelopers-neatHack-2026/integration-evals/blob/main/planning/acceptance-checklist.md).

## License

Original project code and technical documentation are licensed under the [MIT License](LICENSE). See [COPYRIGHT.md](COPYRIGHT.md) for team attribution, scope and preserved third-party rights.
