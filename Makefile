.PHONY: bootstrap build check acceptance

TARGET ?= all
MODE ?= mock

bootstrap:
	npm ci --ignore-scripts --offline

build:
	npm run build

check:
	@if [ "$(MODE)" != "mock" ]; then \
		echo "MODE=$(MODE) is unavailable: only offline mock checks are implemented; no live provider dispatch exists." >&2; \
		exit 2; \
	fi
	@case "$(TARGET)" in \
		contracts) npm run check:contracts ;; \
		decision-contract) npm run check:decision-contract ;; \
		all) npm test ;; \
		*) echo "Unknown TARGET=$(TARGET). Use contracts, decision-contract, or all." >&2; exit 2 ;; \
	esac

acceptance:
	node scripts/acceptance-gate.mjs "$(TARGET)"
