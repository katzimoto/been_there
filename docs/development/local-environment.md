# Local environment

Everything a newcomer needs to run this repository locally: one Postgres, one
Makefile, and a development dataset that is built by running the domain rather
than by writing rows into a table.

`make setup` is the one command: it installs, starts the dependencies, builds,
applies the migrations and loads the development dataset. Each of those is also a
CI step, and `make check` runs all of them in CI order — so a clean checkout that
`make setup` can complete is a checkout CI has already proven.

The dataset is the part worth knowing about. `make seed` does not write rows: it
runs the identity machine, the risk machine, the like/match/block rules, the send
path and the moderation queue walk to produce the state, and then persists it
through the same stores the HTTP routes use. A seeded `verified` account is one
the identity machine verified.

## Quick start

```sh
npm install          # or: make install, which runs `npm ci` as CI does
make up              # start Postgres and wait until it reports healthy
make check           # exactly what CI runs, in CI order
```

`make up` is the only command needed for the dependency. `make setup` is the
full one-command path — install, start, build, migrate, seed — and it is the
command CI exercises step for step, so if it fails for you it fails there too.

Nothing has to be configured first. A clean checkout runs on the defaults in the
Makefile. Copy `.env.example` to `.env` only if you want to change the port, the
project name or the credentials.

## What runs, and what it is for

| Service | Port | Purpose |
| --- | --- | --- |
| `postgres` (postgres:17-alpine) | 55432 on the host | The one transactional store for the modular monolith |

One service, on purpose. ADR 0001 commits to a single deployable unit with one
transactional store, so there is no per-domain database to stand up: the domain
packages will share schema namespaces inside this instance, and a like that
becomes a match is a local transaction rather than a distributed one. The port
is 55432 so a Postgres installed on the host keeps working.

There is deliberately **no broker**. ADR 0003 wants a transactional outbox plus a
broker in production, but the outbox is a table in this database and the worker
that drains it is a process inside the application. Neither exists yet, and a
queue container that nothing reads is a second thing for a newcomer to start,
forget about and misconfigure. When the outbox lands, add the broker here and
nothing else in this setup has to change.

If you want to see the ADR reasoning rather than the summary:
[0001](../architecture/adr/0001-modular-monolith.md),
[0003](../architecture/adr/0003-events-not-calls.md).

## Commands

`make help` lists all of them. The ones that matter:

| Command | What it does |
| --- | --- |
| `make install` | `npm ci`, exactly as CI does |
| `make check` | The whole CI command set, in CI order, plus the parity check |
| `make ci` | `make install` and then `make check` |
| `make parity` | Asserts the local targets run exactly the commands CI runs |
| `make up` / `make down` / `make restart` | Dependencies, waiting for healthy |
| `make ps` / `make logs` | Dependency status and logs |
| `make db-shell` | `psql` against the local database |
| `make db-url` | Print the connection string |
| `make db-reset` | Destroy the volume and start from an empty database |
| `make migrate` | Applies the migrations in order. Idempotent: a second run is a no-op |
| `make seed` | Loads the dataset through the domain transitions and the stores. Skips if it is already loaded |
| `make build` | Build the whole solution into `dist` |
| `make seed-build` | Build only the six packages the dataset loads |
| `make seed-print` / `make seed-json` | The development dataset, as a summary or as JSON |
| `make seed-verify` | Assert the dataset's invariants; non-zero exit on violation |
| `make audit-log AUDIT_AS=<role>` | Read the seeded audit log as a role |

### Local runs match CI

`make check` is not a summary of CI, it is CI: `npm ci`'s sibling
`npm run typecheck`, `node scripts/dev/typecheck-tests.mjs`, `npm test`, the
documentation link check and the research-tool check, in the same order.

`typecheck-tests` is a separate step from `typecheck` because `tsc --build`
walks the *package* project graph and the test projects are not in it: each
`packages/<pkg>/test/tsconfig.json` is referenced by nothing, so the solution
build never opens it. Seven type errors sat in test projects for a session
while `npm run typecheck` reported zero, because the gate being quoted did not
cover the files being edited. The step is one script called by the Makefile
target, the CI step and `npm run check`, rather than three copies of the loop —
and it exits non-zero if it finds no projects at all, since a glob matching
nothing is a green gate that checks nothing.

That equivalence is asserted rather than assumed. `scripts/dev/check-ci-parity.mjs`
reads `.github/workflows/ci.yml` and the `Makefile`, compares the *commands*
rather than the target names, and fails if a CI step gains a command the local
target does not run, if a local target runs a command CI does not, if a CI step
is not mapped to a target at all, or if `make check` stops running them in CI
order. It runs as the last step of `make check`, so drift fails locally before
anyone pushes.

## The development dataset

`make seed-print` builds and prints a dataset that exercises the safety model:

- six users verified through a real provider round trip, and one whose
  verification has **expired** (still known, out of discovery);
- one verification **pending** — submitted to the provider, no result yet;
- one **review_required**, from a borderline provider result routed to a human;
- one **limited** account and one **banned** account, each backed by a case and a
  named moderator;
- a **block** that ends an open match and stops contact in both directions;
- a **match with a live conversation** and two messages sent through the real
  send path;
- a **report**, triaged into a case that a moderator has taken and started
  reviewing, plus the Trust & Safety case behind the restriction;
- an **audit log**, with a read that was granted and a read that was redacted.

### Nobody is verified because the seed says so

Every state in the dataset is the answer a machine gave to an event. The seed
runs the identity provider flow (`planVerificationStart` → captures →
`submitToProvider` → `completeFromProvider`) and records the move the domain
proposed, checking it against `identityMachine` rather than trusting it.
`limited` and `banned` go through `accountMachine` with the case and moderator
the guards demand. Risk is replayed through `riskMachine` from the signals, never
assigned.

Each person therefore carries the trail that produced their state, and
`make seed-verify` replays every trail through the live machine and compares:

```
Dataset invariants hold: 8 users, 3 risk assessments, 2 cases, 18 audit records.
```

It also checks that a verified user has a provider result at or above the
confidence floor or a named reviewer, that every enforcement step names a case
that exists in the dataset, that a restricted or banned account still grants
`report` and `block`, that the ban belongs to the case opened from the report,
and that the audit log actually withholds records below `restricted`. A seed
that hard-coded a state, or a transition table edited under it, fails here
instead of producing a confident, wrong dataset.

### Poking at it from a REPL

```sh
make seed-build
node --input-type=module
```

```js
const { loadDevelopmentDataset } = await import('./scripts/seed/development-dataset.mjs');
const dataset = loadDevelopmentDataset();
dataset.users.map((u) => `${u.userId} ${u.identityState}/${u.accountState}`);
dataset.users[0].identityTrail;          // the transitions that produced the state
dataset.platformAuditLog.read({ upTo: 'restricted' }).length;
```

The dataset is built in process and thrown away when the process exits. There is
nothing to clean up, and nothing is written anywhere.

## The audit log, with and without clearance

There are two logs in the dataset, and they answer different questions.

**The case log** (`createAuditLog()` in the moderation package) is append-only
by construction: it has `append` and read projections, and no way to update or
delete a row. It is the appeal record for one case — `forCase(caseId)`,
`bySubject(userId)`, `byActor(actorId)`. It is visible in `make seed-print`.

**The platform log** (`InMemoryAuditLog`) is the one with a clearance on the
read side, and it is the one the `audit-log` target reads:

```sh
make audit-log                                  # as senior_moderator
make audit-log AUDIT_AS=moderator               # refused
make audit-log AUDIT_AS=support                 # refused
make audit-log AUDIT_AS=system                  # refused
```

Only `senior_moderator` is allowed to read it, and that decision comes from the
domain, not from the script: reading the audit log is the protected action
`audit.read`, which needs both the `audit.read.restricted` permission and
`restricted` clearance. Run it as anything else and you get the domain's own
refusal with its reason:

```
Reading the audit log as "moderator" is refused.
  permission_denied: role "moderator" may not audit.read
  clearance held by this role: sensitive; the action requires restricted
```

`system` is refused too, and deliberately so: a detector that could read case
evidence would be a machine making an enforcement decision, which is the one
thing this codebase does not do. The seeded log contains the row for that
attempted crossing (`authz.permission_denied`).

Once a reader is authorised, visibility is still decided per record and per
field: a record classified above the reader's clearance is not returned at all,
and inside a record a field above the reader's clearance is dropped rather than
blanked. That is why the `senior_moderator` view shows 18 records and a
moderator, who cannot read the log at all, sees none.

**Evidence** has its own clearance ladder, and `make seed-print` shows it for
the two artefacts the seeded case holds:

```
  evidence mod-1: message_snapshot, needs reviewer
  evidence mod-3: identity_artefact, needs identity_privacy_officer
    the identity artefact as a moderator: redacted — "Liveness capture attached by the verification provider."
    the same artefact as the identity privacy officer: full — blob://identity/frankie/selfie.webm
```

Both reads happened for real while the dataset was built, so the audit log
records a granted read and a redacted one.

When the audit log does move into Postgres, the same two questions have to be
answerable from the database: who is allowed to read it, and which records are
above their clearance. That is where row-level security enters, and it is the
reason the local container has exactly one role today rather than a
reader/writer pair that grants nothing yet.

## Resetting

```sh
make db-reset    # destroy the volume, start again empty
make down        # stop, keep the data
```

The data in the local container is disposable by construction: it is a named
volume, nothing in it is ever dumped, and no dump or fixture is committed.

## Troubleshooting

**`make up` fails with "port is already allocated".** Something is on 55432 —
usually a Postgres you started by hand earlier. Either stop it, or change
`POSTGRES_PORT` in `.env` and run `make up` again.

**`docker compose` complains that `POSTGRES_USER` is unset.** You ran Compose
directly instead of through the Makefile. The variables have no defaults in the
compose file on purpose, so a hand-run `docker compose up` cannot invent
credentials. Use `make up`, or export them:

```sh
set -a; . ./.env; set +a     # if you have a .env
```

**The database is up but looks empty after `make check`.** `make check` seeds the
shared database, so an empty `\dt` at the `make db-shell` prompt means nothing
ran. `make migrate` says so when the schema is missing; `make seed` says so when
it cannot write. `make db-reset` followed by `make setup` is the clean answer to
either.

**A stale volume.** If Postgres logs a complaint about `PGDATA`, or the data
directory looks wrong after an image change (Postgres 18 moved the default data
path), `make db-reset` is the fix. The compose file pins `PGDATA` inside the
volume so a major-version bump cannot silently orphan your data.

**`make seed` refuses because the database holds part of the dataset.** Something
else wrote there, or an earlier run failed partway. It names the tables and rows
it found rather than merging: which of them to trust is not a decision a seed
script should make on your behalf. `make db-reset`, then `make setup`.

**The seed fails with "the packages are not built".** Cross-package imports
resolve to `packages/*/dist`, not to `src`, so a stale `dist` silently runs old
code. `make seed-print` depends on `make seed-build`, which builds exactly the
six packages the dataset imports; if you run the script directly, run
`make seed-build` first. The same trap applies to any change you make under
`packages/` before running a consumer: rebuild before you test.

**A compiled `.js` appears next to a `.ts` under `packages/*/src/`.** Delete it
and say so. Vitest resolves `../src/index.js` to the real file before it reaches
the `.ts`, so a committed artefact makes the suite run stale code in silence.
`.gitignore` blocks it; a file that got there anyway is a bug to report, not to
keep.

## What is not here, and why

- **A broker.** See above: the outbox is a table in this database, and neither it
  nor the worker draining it exists.
- **A migration tool with a rollback story.** `make migrate` applies the SQL files
  in order, one transaction each, and records what it applied. There is no
  `down`, and a schema change here is a forward file.
- **Per-domain databases.** ADR 0001 says one store.
- **Risk signals in the seeded database.** The dataset builds risk by replaying
  the risk machine's events, so the *assessment* it folds to is a real answer and
  is seeded; the individual `RiskSignal` records are not, because the dataset
  never had per-observation detectors to write. `packages/seed/scripts/load.mjs`
  says so at the top rather than inventing evidence.
- **A clearance gate over the seeded audit log.** `app.audit_log` has no
  classification column, so the platform log's clearance decision is stored with
  each field's own classification rather than as a column to filter on.
