#!/bin/sh
# The gate in front of `make migrate` and `make seed`.
#
# Both of those steps have nothing to do yet: this repository has no database
# schema and no migration runner, so there is nothing to apply and nowhere to
# load a dataset into. A target that exits 0 while doing nothing is the worst
# failure mode available here — it tells a developer their database is ready
# when it is empty, and every later error is then blamed on their code. So this
# script inspects the database, reports what it actually found, and exits
# non-zero either way.
#
#   sh scripts/dev/schema-gate.sh migrate
#   sh scripts/dev/schema-gate.sh seed
#
# The message differs by mode, because the useful next step differs: a developer
# who wanted migrations is blocked on the schema, and a developer who wanted the
# dataset can have it in process right now with `make seed-print`.

set -e

mode="${1:-}"
case "$mode" in
  migrate|seed) ;;
  *)
    echo "schema-gate: expected 'migrate' or 'seed', got '${mode}'" >&2
    exit 2
    ;;
esac

: "${POSTGRES_USER:=been_there}"
: "${POSTGRES_DB:=been_there}"
: "${COMPOSE:=docker compose}"

COMPOSE=${COMPOSE# }

if ! $COMPOSE exec -T postgres pg_isready -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
  echo "${mode}: the local database is not reachable, so no schema could be checked." >&2
  echo "${mode}: start it first with 'make up'. Nothing was applied and no state changed." >&2
  exit 1
fi

relations=$(
  $COMPOSE exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -c \
    "select count(*) from information_schema.tables where table_schema = 'public';"
)

if [ "$relations" -eq 0 ]; then
  echo "${mode}: refusing to run. The local database '${POSTGRES_DB}' has no schema:" \
    "the public schema has 0 relations." >&2
  echo "${mode}: this repository has no migrations and no migration runner, so there is" \
    "nothing to apply. Nothing was applied and no state changed." >&2
else
  echo "${mode}: refusing to run. The public schema has ${relations} relation(s), but this" \
    "repository has no migration runner wired up, so applying them is not implemented." >&2
  echo "${mode}: nothing was applied and no state changed." >&2
fi

if [ "$mode" = seed ]; then
  echo "seed: the development dataset itself is real and runs today without a database:" >&2
  echo "seed: 'make seed-print' prints it, 'make seed-verify' asserts its invariants." >&2
fi

echo "${mode}: see docs/development/local-environment.md" >&2
exit 1
