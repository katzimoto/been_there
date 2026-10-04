# Local development and verification commands.
#
# The verification targets at the top mirror .github/workflows/ci.yml. That is
# asserted, not hoped for: `make parity` (scripts/dev/check-ci-parity.mjs) reads
# the workflow and this file and fails if a CI step and its local target stop
# running the same commands. Run `make help` for the list.

.DEFAULT_GOAL := help
SHELL := /bin/sh

# `docker compose` reads .env on its own; make reads the same file so a recipe
# can use these values without a second parser. Included only when it exists: a
# clean checkout runs on the defaults below.
ifneq (,$(wildcard .env))
include .env
export
endif

COMPOSE := docker compose

# Local-only defaults, identical to the values documented in .env.example. The
# Makefile is the source of truth for them; compose has no defaults of its own
# and refuses to start when a variable is missing.
COMPOSE_PROJECT_NAME ?= been-there
POSTGRES_USER ?= been_there
POSTGRES_PASSWORD ?= been_there_local_only
POSTGRES_DB ?= been_there
POSTGRES_PORT ?= 55432
DATABASE_URL ?= postgres://$(POSTGRES_USER):$(POSTGRES_PASSWORD)@localhost:$(POSTGRES_PORT)/$(POSTGRES_DB)

# The report/unmatch pairing secret. A local-only placeholder, identical to the
# value documented in .env.example, so `make demo` runs the full six-detector
# catalogue on a clean checkout with no .env at all. It does not make
# `safety.detected_before_first_report` move — see .env.example for why that
# metric is unreachable whatever this is set to — it enables the one detector
# that can carry a subject to `high` and open a human-review case.
RISK_PAIRING_SECRET ?= been_there_local_pairing_only

export COMPOSE_PROJECT_NAME POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB POSTGRES_PORT DATABASE_URL RISK_PAIRING_SECRET

# Which role reads the seeded audit log. Named `AUDIT_AS` rather than `AS`
# because `AS` is a built-in make variable holding the assembler command, so
# `AS=moderator` on the command line would be quietly ignored.
AUDIT_AS ?= senior_moderator

# One awk pass over the file, matching the target name and its `##` comment
# separately rather than splitting on a separator: the descriptions contain `|`
# (the `audit-log` target's role list), and a separator chosen for convenience
# would truncate the one description that has punctuation in it.
help: ## List every target
	@awk 'match($$0, /^[a-zA-Z0-9_.-]+:/) { n = RLENGTH; if (match(substr($$0, n + 1), /## /)) printf "  %-16s %s\n", substr($$0, 1, n - 1), substr($$0, n + 1 + RSTART + 2) }' $(MAKEFILE_LIST)

# --- Verification. Each recipe below is the CI step it is named for. ---------

install: ## Install dependencies exactly as CI does
	npm ci

typecheck: ## Typecheck every package through the project graph
	npm run typecheck

typecheck-tests: ## Typecheck each package's test project
	node scripts/dev/typecheck-tests.mjs

test: ## Run the vitest suite
	npm test

docs: ## Check that documentation links resolve
	node scripts/check-doc-links.mjs

research-check: ## Check the research tool still runs
	node scripts/research/search.mjs --help > /dev/null

check: workflow boundaries typecheck typecheck-tests dist-freshness test docs research-check stale-artifacts no-static-map-set lockfile migrate seed client-test client-ios parity ## Everything CI runs, in CI order
ci: install check ## The whole CI sequence as one command

lockfile: ## Assert the lockfile covers every workspace package
	node scripts/dev/check-workspace-lockfile.mjs

stale-artifacts: ## Assert no compiled output sits beside the source it was built from
	node scripts/dev/check-stale-artifacts.mjs

# Commitment 6 — no domain imports another. It had no gate of any kind until this
# target: a direct dating-to-moderation import passes tsc, passes every test, and
# passed all four other checks in this file. Before the typecheck, because it is
# a 100ms text scan and a boundary violation should fail before a full build.
boundaries: ## Assert no domain package imports another
	node scripts/dev/check-domain-boundaries.mjs

no-static-map-set: ## Assert no Map or Set stands in for a Record over static keys
	node scripts/dev/check-no-static-map-set.mjs

# Between the typecheck that builds and the suite that consumes. A dist that does
# not match its source is code that is not in src, so a test run against one
# passes by executing something nobody wrote -- and this is the last step before
# that run happens.
dist-freshness: ## Assert every built package's dist matches a rebuild of its source
	node scripts/dev/check-dist-freshness.mjs

parity: ## Assert the local targets above run exactly what CI runs
	node scripts/dev/check-ci-parity.mjs

# --- Local dependencies. ---------------------------------------------------

up: ## Start the local dependencies and wait until they are healthy
	$(COMPOSE) up -d --wait --wait-timeout 60

down: ## Stop the local dependencies, keeping the volume
	$(COMPOSE) down

restart: down up ## Stop and start the local dependencies

logs: ## Follow the dependency logs
	$(COMPOSE) logs --follow

ps: ## Show dependency status
	$(COMPOSE) ps

db-shell: ## Open psql against the local database
	$(COMPOSE) exec postgres psql -U "$(POSTGRES_USER)" -d "$(POSTGRES_DB)"

db-url: ## Print the connection string
	@echo "$(DATABASE_URL)"

db-reset: ## Destroy the volume and start from an empty database
	$(COMPOSE) down --volumes
	$(COMPOSE) up -d --wait --wait-timeout 60

# --- Setup. ----------------------------------------------------------------

setup: install up build migrate seed ## One command: install, start, build, migrate, seed

# Applies the SQL migrations in filename order, one transaction each, and records
# what it applied. Idempotent: a second run is a no-op that exits 0.
migrate: ## Apply the SQL migrations. Idempotent: a second run is a no-op
	@node packages/database/scripts/migrate.mjs

# The seed loads through the domain's own transitions and writes with the stores,
# rather than writing state directly, so a seeded `verified` account is one the
# identity machine actually produced. A seed that wrote the state column would make
# the whole point of the codebase untrue in the one place a developer goes to look.
#
# It is a CI step, so it must be the last thing that can still be broken quietly:
# `make setup` runs it, and CI runs the same command against a database nothing
# else has written to. It skips rather than upserts when the dataset is already
# there, and refuses by name when only part of it is — see load.mjs.
seed: ## Load the development dataset through the domain transitions
	@node packages/seed/scripts/load.mjs

# --- The development dataset. ---------------------------------------------

build: ## Build every package, which is what `npm run typecheck` and CI do
	npm run build

# The dataset loads the packages through their dist, so they must be built —
# cross-package imports resolve to dist, never to src. Only the six packages
# the seed actually imports are listed, so a broken project elsewhere in the
# repo cannot stop you from exercising the dataset.
SEED_PACKAGES := packages/core packages/identity packages/dating packages/communication packages/moderation packages/platform

seed-build: ## Build the packages the dataset loads (not the whole solution)
	npx tsc --build $(SEED_PACKAGES)

seed-print: seed-build ## Print the development dataset as a summary
	node scripts/seed/development-seed.mjs

seed-json: seed-build ## Print the development dataset as JSON
	node scripts/seed/development-seed.mjs --format json

seed-verify: seed-build ## Assert the dataset's invariants; non-zero exit on violation
	node scripts/seed/development-seed.mjs --check

audit-log: seed-build ## Read the seeded audit log as a role. AUDIT_AS=senior_moderator|moderator|support|system
	node scripts/seed/development-seed.mjs --audit --as "$(AUDIT_AS)"

# --- The iOS client. ------------------------------------------------------
#
# The client mirrors rules the server enforces. These tests are the only thing
# keeping the two in step, so they run with everything else rather than on
# demand.

client-test: ## Test the client safety gate (needs Xcode)
	cd client/BeenThereKit && swift test

# The whole client source set, not one file. Naming `ClientGate.swift` here
# compiled a single file of nine and left the other eight — the API client, the
# decoding shim and every view model — outside CI entirely, so a client that
# did not compile was still green. The glob is what makes a new source file
# part of the gate by existing.
client-ios: ## Compile the client for the iOS simulator (needs Xcode)
	@export SDK=$$(xcrun --sdk iphonesimulator --show-sdk-path); xcrun swiftc -sdk "$$SDK" -target arm64-apple-ios17.0-simulator -emit-module -module-name BeenThereKit client/BeenThereKit/Sources/BeenThereKit/*.swift -o "$${RUNNER_TEMP:-$${TMPDIR:-/tmp}}/BeenThereKit.swiftmodule"

workflow: ## Validate the CI workflow before pushing it
	node scripts/dev/check-workflow.mjs

# --- The demo. ------------------------------------------------------------
#
# Two independent things, and neither is a CI step: a service left running for a
# person to poke at, and a walk that proves the product's claims and exits
# non-zero when one of them fails.

# Port the demo service listens on. `make demo` prints it, so this is the one
# value worth overriding.
DEMO_PORT ?= 8787

# Where the running service's pid and log live. Under the repository and
# git-ignored, so `make demo-stop` can find the process it started and nothing
# else can.
DEMO_RUN ?= .demo

demo: install up build migrate ## One command: deps up, migrated, seeded, serving
	@mkdir -p "$(DEMO_RUN)"
	@if [ -f "$(DEMO_RUN)/service.pid" ] && kill -0 "$$(cat "$(DEMO_RUN)/service.pid")" 2>/dev/null; then \
		echo "A demo service is already running (pid $$(cat "$(DEMO_RUN)/service.pid"))."; \
		echo "Stop it first: make demo-stop DEMO_RUN=$(DEMO_RUN)"; \
		exit 1; \
	fi
	@rm -f "$(DEMO_RUN)/service.log" "$(DEMO_RUN)/service.pid"
	@if $(MAKE) --no-print-directory seed >"$(DEMO_RUN)/seed.log" 2>&1; then \
		grep -q '^Already loaded' "$(DEMO_RUN)/seed.log" \
			&& echo "Dataset:  already loaded" \
			|| echo "Dataset:  loaded through the domain transitions"; \
	else \
		echo "The dataset did not load, so there is nothing to serve. 'make seed' said:"; \
		cat "$(DEMO_RUN)/seed.log"; \
		echo; \
		echo "To start from an empty database: make db-reset, then make demo."; \
		exit 1; \
	fi
	@DEMO_PORT="$(DEMO_PORT)" nohup node scripts/demo/server.mjs > "$(DEMO_RUN)/service.log" 2>&1 & \
	echo $$! > "$(DEMO_RUN)/service.pid"
	@for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do \
		if grep -q '^READY ' "$(DEMO_RUN)/service.log" 2>/dev/null; then break; fi; \
		if grep -qi '^The packages are not built\|^DATABASE_URL is not set' "$(DEMO_RUN)/service.log" 2>/dev/null; then break; fi; \
		sleep 1; \
	done
	@if grep -q '^READY ' "$(DEMO_RUN)/service.log" 2>/dev/null; then \
		url=$$(sed -n 's/.*"url":"\([^"]*\)".*/\1/p' "$(DEMO_RUN)/service.log" | head -1); \
		pid=$$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$(DEMO_RUN)/service.log" | head -1); \
		echo "Serving:  $$url (pid $$pid)"; \
		echo "Health:   $$url/v1/health/ready"; \
		echo "Sign-up:  $(DEMO_RUN)/service.log has a ready-to-paste curl"; \
		echo "Log:      $(DEMO_RUN)/service.log"; \
		echo "Stop:     make demo-stop DEMO_RUN=$(DEMO_RUN)"; \
	else \
		launched=$$(cat "$(DEMO_RUN)/service.pid" 2>/dev/null || echo ""); \
		if [ -n "$$launched" ]; then kill "$$launched" 2>/dev/null || true; fi; \
		rm -f "$(DEMO_RUN)/service.pid"; \
		echo "The service did not start. Last lines of $(DEMO_RUN)/service.log:"; \
		tail -20 "$(DEMO_RUN)/service.log"; \
		if grep -q 'EADDRINUSE' "$(DEMO_RUN)/service.log" 2>/dev/null; then \
			echo; \
			echo "Port $(DEMO_PORT) is taken. Run: make demo DEMO_PORT=8899"; \
		fi; \
		exit 1; \
	fi

demo-stop: ## Stop the service `make demo` started
	@if [ -f "$(DEMO_RUN)/service.pid" ]; then \
		pid=$$(cat "$(DEMO_RUN)/service.pid"); \
		kill "$$pid" 2>/dev/null || true; \
		rm -f "$(DEMO_RUN)/service.pid"; \
		echo "Stopped pid $$pid."; \
	else \
		echo "No pid file at $(DEMO_RUN)/service.pid; nothing started by make demo is running."; \
	fi

# Builds, then walks. The build is a prerequisite because the walk drives the
# built packages, and a walk that silently loaded stale output would be a
# demonstration of the wrong thing.
demo-journey: build ## Drive the whole product journey over HTTP; non-zero on any failure
	@npm run --silent demo:journey


# --- The downloadable bundle. ----------------------------------------------

# Not a CI step. A bundle is an artefact for one person on one machine, and
# `make check` builds it every run only to delete it again. It runs the same
# script CI would, so a green CI run means a green bundle without the wait.

BUNDLE_OUT ?= dist/demo

demo-bundle: ## Package the repository into a verified, runnable archive
	node scripts/demo/bundle.mjs --out "$(BUNDLE_OUT)"

demo-bundle-verify: ## Rebuild the bundle and keep the unpacked tree for inspection
	node scripts/demo/bundle.mjs --out "$(BUNDLE_OUT)" --keep
