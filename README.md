# creative-engine

Creative-engine now contains a local controls and contract implementation. The controls package validates bounded creative changes and stores a durable local Apply outbox; the contracts package provides dependency-free ESM validators and offline fixtures for creative and DecisionPort boundaries. The contracts remain local consumer proposals until their external schema, producer, application and harness owners record acceptance. API orchestration, live providers, JEV transport, production rendering, and application authentication are not implemented here.

## Build and offline checks

Use Node.js 22.23.3 for the production-target checks. Node.js 24.15.0 is also checked for development compatibility. From the repository root:

```sh
make bootstrap
make build
make check TARGET=controls MODE=mock
make check TARGET=contracts MODE=mock
make check TARGET=decision-contract MODE=mock
make check TARGET=metering-contract MODE=mock
make check TARGET=handoff-contract MODE=mock
make check TARGET=all MODE=mock
```

The contracts and control checks use synthetic fixtures and make no provider calls. `make acceptance TARGET=contracts`, `make acceptance TARGET=decision-contract`, `make acceptance TARGET=metering-contract`, and `make acceptance TARGET=handoff-contract` intentionally fail while external owner agreements remain pending. `MODE=live` fails closed because there is no live dispatch implementation.

The standalone contracts workflow also checks the public package imports with TypeScript 5.9.3 in strict NodeNext mode, including the metering and approval-handoff subpaths. Reproduce that typecheck locally after installing the browser fixture's locked development tools:

```sh
npm ci --prefix examples/frontend-action-roundtrip
make typecheck-contracts
```

The controls browser example has its own lockfile and dependency install. Its Node and Chromium roundtrip instructions, local evidence format, and remaining integration requirements are in [controls integration](docs/controls-integration.md). It uses mock application identity and state.

## Architecture and contracts

- [Repository responsibilities and acceptance criteria](docs/architecture/OWNERSHIP.md) · [acceptance checklist](docs/architecture/ACCEPTANCE.md)
- [Creative consumer contract proposal](docs/contracts/creative-boundary.md) · [DecisionPort proposal](docs/contracts/decision-port.md)
- [Canonical owner agreement status](docs/contracts/canonical-owner-agreements.json)
- [Controls local integration and API boundary](docs/controls-integration.md)
- [Architecture reference](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/blob/main/docs/architecture-kit/v1.0/README.md) · [implementation plan](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/blob/main/docs/planning/implementation-plan.md)

The controls service, fixtures, and contract tests exercise local validation and storage boundaries. They do not establish integrated application membership, API job lifecycle, actual model routing, provider capability, licensing, or external acceptance.
