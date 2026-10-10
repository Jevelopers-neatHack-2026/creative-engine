.PHONY: bootstrap build check acceptance typecheck-contracts typecheck-boundary-contracts typecheck-api

TARGET ?= all
MODE ?= mock

bootstrap:
	npm ci --ignore-scripts --offline
	npm ci --prefix examples/frontend-action-roundtrip

build:
	npm run build
	node --check src/controls/runtime.mjs
	node --check src/controls/schema.mjs
	node --check src/controls/contract.mjs
	node --check src/controls/actions.mjs
	node --check src/controls/index.mjs
	node --check src/runtime/creative-runtime.mjs
	node --check src/api/v1.mjs
	$(MAKE) typecheck-api

typecheck-contracts:
	node examples/frontend-action-roundtrip/node_modules/typescript/bin/tsc -p tests/contracts/types/tsconfig.json
	$(MAKE) typecheck-boundary-contracts

typecheck-boundary-contracts:
	node examples/frontend-action-roundtrip/node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck false --module NodeNext --moduleResolution NodeNext --target ES2022 tests/contracts/metering/public-consumer.mts

typecheck-api:
	node examples/frontend-action-roundtrip/node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck false --module NodeNext --moduleResolution NodeNext --target ES2022 examples/api/public-consumer.mts
	node examples/frontend-action-roundtrip/node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck false --module NodeNext --moduleResolution NodeNext --target ES2022 tests/contracts/metering/public-consumer.mts

check:
	@if [ "$(MODE)" != "mock" ]; then \
		echo "MODE=$(MODE) is unavailable: only offline mock checks are implemented; no live provider dispatch exists." >&2; \
		exit 2; \
	fi
	@case "$(TARGET)" in \
		contracts) npm run check:contracts ;; \
		decision-contract) npm run check:decision-contract ;; \
		eval-policy) npm run check:eval-policy ;; \
		metering-contract) npm run check:metering-contract && $(MAKE) typecheck-boundary-contracts ;; \
		handoff-contract) npm run check:handoff-contract && $(MAKE) typecheck-boundary-contracts ;; \
		api) npm run check:api && $(MAKE) typecheck-api ;; \
		controls) node fixtures/controls/check.mjs ;; \
		all) npm test && npm run check:eval-policy && npm run check:metering-contract && npm run check:handoff-contract && $(MAKE) typecheck-contracts && $(MAKE) typecheck-api && node fixtures/controls/check.mjs ;; \
		*) echo "Unknown TARGET=$(TARGET). Use api, controls, contracts, decision-contract, eval-policy, metering-contract, handoff-contract, or all." >&2; exit 2 ;; \
	esac

acceptance:
	@node scripts/acceptance-gate.mjs "$(TARGET)"
