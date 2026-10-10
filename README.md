# creative-engine

Creative-engine contains a local controls service, dependency-free contract validators, and a typed non-UI creative API runtime. The controls package validates bounded creative changes and stores a durable local Apply outbox. The API handler implements generate/edit/inspect/list/compare/restore/cancel/handoff and job status around injected jobs, storage, provider, DecisionPort, metering, approval, inspection, handoff, and trace ports. Its public contract and C01/C02/C03/C04 schemas remain local proposals pending external owner agreement; production provider transports, application authentication, finance authority, approval issuance, and rendering are not implemented here.

## Build and offline checks

Use Node.js 22.23.3 for the production-target checks. Node.js 24.15.0 is also checked for development compatibility. From the repository root:

```sh
make bootstrap
make build
make check TARGET=api MODE=mock
make check TARGET=controls MODE=mock
make check TARGET=contracts MODE=mock
make check TARGET=decision-contract MODE=mock
make check TARGET=eval-policy MODE=mock
make check TARGET=metering-contract MODE=mock
make check TARGET=handoff-contract MODE=mock
make check TARGET=access-preflight MODE=mock
make check TARGET=access-preflight MODE=live
make check TARGET=all MODE=mock
```

The API, contract, control, evaluation-policy, and access-preflight checks use synthetic fixtures and make no paid provider calls. `make check TARGET=api MODE=mock` writes a sanitized, versioned summary to `build/api-check-evidence.json`. `make check TARGET=access-preflight MODE=mock` exercises the fixed eight-cell access matrix, writes sanitized mock evidence to `build/access-preflight-evidence.json`, and keeps acceptance pending. `make check TARGET=access-preflight MODE=live` writes `build/access-preflight-live-gate.json`, prints the blocked per-cell reasons, and exits 2 with zero provider dispatches when trusted live adapters and external owner evidence are absent. A user-supplied JSON claim cannot enable live access. The exported `runAccessPreflight` API can be composed by a trusted host with real owner adapters; this repository does not install that host or read credentials. `make acceptance TARGET=access-preflight` reports the same missing live owner evidence and exits 2. `make check TARGET=eval-policy MODE=mock` runs the policy, corpus, register, report, and acceptance-gate fixtures; local checks may pass while owner evidence remains pending. `make acceptance TARGET=api`, `make acceptance TARGET=contracts`, `make acceptance TARGET=decision-contract`, `make acceptance TARGET=metering-contract`, and `make acceptance TARGET=handoff-contract` intentionally fail while canonical owner agreements remain pending. `make acceptance TARGET=eval-policy` separately emits machine-readable evidence and exits 2 until accountable owners publish and independently verify the required corpus, question inventory, rubric, telemetry, budget, and policy approvals. `make acceptance TARGET=all` includes those agreements, CE-Q01 policy/corpus evidence, and the CE-A01 live access gate.

The standalone workflows check the public API, contract, metering, approval-handoff, and preflight package imports with TypeScript 5.9.3 in strict NodeNext mode. `make bootstrap` installs the locked TypeScript consumer tools used by those checks. Run `make typecheck-api` or `make typecheck-preflight` to check the public consumers directly. The supported runtime checks use Node.js 22.23.3 and Node.js 24.15.0.

```sh
make typecheck-api
make typecheck-contracts
```

The controls browser example has its own lockfile and dependency install. Its Node and Chromium roundtrip instructions, local evidence format, and remaining integration requirements are in [controls integration](docs/controls-integration.md). It uses mock application identity and state.

## Architecture and contracts

- [Repository responsibilities and acceptance criteria](docs/architecture/OWNERSHIP.md) · [acceptance checklist](docs/architecture/ACCEPTANCE.md)
- [Creative consumer contract proposal](docs/contracts/creative-boundary.md) · [DecisionPort proposal](docs/contracts/decision-port.md)
- [Canonical owner agreement status](docs/contracts/canonical-owner-agreements.json)
- [Creative API v1, injected ports, and dispatch fencing](docs/api/creative-api.md)
- [Controls local integration and API boundary](docs/controls-integration.md)
- [Architecture reference](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/blob/main/docs/architecture-kit/v1.0/README.md) · [implementation plan](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/blob/main/docs/planning/implementation-plan.md)

The controls service, API fixtures, and contract tests exercise local validation and injected port boundaries. They do not establish application membership, a production job store, external finance or approval authority, actual model routing, provider capability, licensing, or external acceptance. Missing runtime ports return an unavailable error; the API does not substitute a successful mock result.
