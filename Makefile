.PHONY: bootstrap build check acceptance typecheck-contracts typecheck-boundary-contracts typecheck-api typecheck-preflight typecheck-versions typecheck-telemetry typecheck-brief typecheck-models

TARGET ?= all
MODE ?= mock

bootstrap:
	npm ci --ignore-scripts --offline
	npm ci --prefix examples/frontend-action-roundtrip
	npm ci --prefix src/models/codec-runtime --ignore-scripts

build:
	npm run build
	node --check src/controls/runtime.mjs
	node --check src/controls/schema.mjs
	node --check src/controls/contract.mjs
	node --check src/controls/actions.mjs
	node --check src/controls/index.mjs
	node --check src/runtime/creative-runtime.mjs
	node --check src/api/v1.mjs
	node --check src/preflight/access.mjs
	node --check src/preflight/openai-images.mjs
	node --check src/preflight/index.mjs
	node --check scripts/access-preflight-check.mjs
	$(MAKE) typecheck-api
	$(MAKE) typecheck-preflight
	$(MAKE) typecheck-brief
	$(MAKE) typecheck-versions
	$(MAKE) typecheck-telemetry
	$(MAKE) typecheck-models

typecheck-contracts:
	node examples/frontend-action-roundtrip/node_modules/typescript/bin/tsc -p tests/contracts/types/tsconfig.json
	$(MAKE) typecheck-boundary-contracts

typecheck-boundary-contracts:
	node examples/frontend-action-roundtrip/node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck false --module NodeNext --moduleResolution NodeNext --target ES2022 tests/contracts/metering/public-consumer.mts

typecheck-api:
	node examples/frontend-action-roundtrip/node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck false --module NodeNext --moduleResolution NodeNext --target ES2022 examples/api/public-consumer.mts
	node examples/frontend-action-roundtrip/node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck false --module NodeNext --moduleResolution NodeNext --target ES2022 tests/contracts/metering/public-consumer.mts

typecheck-preflight:
	node examples/frontend-action-roundtrip/node_modules/typescript/bin/tsc -p tests/preflight/types/tsconfig.json

typecheck-brief:
	node examples/frontend-action-roundtrip/node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck false --module NodeNext --moduleResolution NodeNext --target ES2022 tests/api/brief-public-consumer.mts

typecheck-versions:
	node examples/frontend-action-roundtrip/node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck false --module NodeNext --moduleResolution NodeNext --target ES2022 tests/versions/public-consumer.mts

typecheck-telemetry:
	node examples/frontend-action-roundtrip/node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck false --module NodeNext --moduleResolution NodeNext --target ES2022 tests/telemetry/public-consumer.mts

typecheck-models:
	node examples/frontend-action-roundtrip/node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck false --module NodeNext --moduleResolution NodeNext --target ES2022 tests/models/public-consumer.mts

check:
	@case "$(TARGET):$(MODE)" in \
		access-preflight:mock) npm run check:access-preflight && node scripts/access-preflight-check.mjs --mode mock --out build/access-preflight-evidence.json && $(MAKE) typecheck-preflight ;; \
		access-preflight:live) node scripts/access-preflight-check.mjs --mode live --out build/access-preflight-live-gate.json ;; \
		image-adapter:mock) npm run check:models && node scripts/image-adapter-check.mjs --mode mock --out build/image-adapter-evidence.json && $(MAKE) typecheck-models ;; \
		image-adapter:live) node scripts/image-adapter-check.mjs --mode live --out build/image-adapter-live-gate.json ;; \
		brief:mock) npm run check:brief && $(MAKE) typecheck-brief ;; \
		versions:mock) npm run check:versions ;; \
		creative-metering:mock) npm run check:creative-metering && $(MAKE) typecheck-telemetry ;; \
		contracts:mock) npm run check:contracts ;; \
		decision-contract:mock) npm run check:decision-contract ;; \
		eval-policy:mock) npm run check:eval-policy ;; \
		metering-contract:mock) npm run check:metering-contract && $(MAKE) typecheck-boundary-contracts ;; \
		handoff-contract:mock) npm run check:handoff-contract && $(MAKE) typecheck-boundary-contracts ;; \
		api:mock) npm run check:api && $(MAKE) typecheck-api ;; \
		controls:mock) node fixtures/controls/check.mjs ;; \
		all:mock) npm test && npm run check:eval-policy && npm run check:metering-contract && npm run check:handoff-contract && npm run check:access-preflight && node scripts/access-preflight-check.mjs --mode mock --out build/access-preflight-evidence.json && npm run check:models && node scripts/image-adapter-check.mjs --mode mock --out build/image-adapter-evidence.json && npm run check:brief && npm run check:versions && npm run check:creative-metering && $(MAKE) typecheck-contracts && $(MAKE) typecheck-api && $(MAKE) typecheck-preflight && $(MAKE) typecheck-brief && $(MAKE) typecheck-telemetry && $(MAKE) typecheck-models && node fixtures/controls/check.mjs ;; \
		*) echo "Unsupported TARGET=$(TARGET) MODE=$(MODE): only offline mock checks are implemented and no live provider dispatch exists; access-preflight and image-adapter live gates are fail-closed." >&2; exit 2 ;; \
	esac

acceptance:
	@node scripts/acceptance-gate.mjs "$(TARGET)"
