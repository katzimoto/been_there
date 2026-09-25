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

export COMPOSE_PROJECT_NAME POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB POSTGRES_PORT DATABASE_URL

# Which role reads the seeded audit log. Named `AUDIT_AS` rather than `AS`
# because `AS` is a built-in make variable holding the assembler command, so
# `AS=moderator` on the command line would be quietly ignored.
AUDIT_AS ?= senior_moderator

help: ## List every target
	@grep -E '^[a-zA-Z0-9_.-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-16s %s\n", $$1, $$2}'

# --- Verification. Each recipe below is the CI step it is named for. ---------

install: ## Install dependencies exactly as CI does
	npm ci

typecheck: ## Typecheck every package through the project graph
	npm run typecheck

typecheck-tests: ## Typecheck each package's test project
	@set -e; for pkg in packages/*/test/tsconfig.json; do \
		echo "$$pkg"; \
		npx tsc -p "$$pkg"; \
	done

test: ## Run the vitest suite
	npm test

docs: ## Check that documentation links resolve
	node scripts/check-doc-links.mjs

research-check: ## Check the research tool still runs
	node scripts/research/search.mjs --help > /dev/null

check: typecheck typecheck-tests test docs research-check stale-artifacts lockfile migrate parity ## Everything CI runs, in CI order
ci: install check ## The whole CI sequence as one command

lockfile: ## Assert the lockfile covers every workspace package
	node scripts/dev/check-workspace-lockfile.mjs

stale-artifacts: ## Assert no compiled output sits beside the source it was built from
	node scripts/dev/check-stale-artifacts.mjs

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

setup: install up migrate seed ## One command: install, start, migrate, seed

# Not implemented, and it says so. This repository has no schema and no
# migration runner, so there is nothing to apply; the target checks the database
# for the truth of that and then refuses. It will not exit 0 while doing nothing.
migrate: ## Apply the SQL migrations. Idempotent: a second run is a no-op
	@node packages/database/scripts/migrate.mjs

# The seed loads through the domain's own transitions rather than writing state
# directly, so a seeded `verified` account is one the identity machine actually
# produced. A seed that wrote the state column would make the whole point of the
# codebase untrue in the one place a developer goes to look.
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
