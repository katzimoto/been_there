# Been There — runnable demo

A dating product where every user is verified and safety is structural rather
than reactive. This archive is a working backend and an end-to-end walk through
it, not a design document.

**Read the two sections below before you run anything.** The first is what the
demo proves. The second is what it does not do — ten gaps, listed plainly,
because a demo that overstates itself costs more of your time than one that
admits one.

## What this demonstrates

The product makes claims that are easy to state and hard to enforce. This demo
drives a real HTTP service, against a real Postgres database, through the whole
journey a user takes — and shows what the system does when someone misbehaves.

The four claims it proves, with the step that proves each:

| Claim                                                                     | Step | What is observed                                                                                                        |
| ------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------- |
| **Unverified means undiscoverable.** Not "shown with a warning" — absent. | 4    | An unverified account is withheld from a verified viewer's page. An unverified viewer gets an empty page and no reason. |
| **A block stops contact, and does not explain itself.**                   | 7    | The send is refused on rule `blocked`, nothing is stored, and the refusal discloses nothing about the block.            |
| **A restriction cannot remove the ability to report.**                    | 10   | Messaging is refused on a missing capability; report and block both still return `201`.                                 |
| **State is durable.**                                                     | 11   | The process is `SIGTERM`ed and replaced by a different pid; every row above is re-read from the new one.                |

## What is _not_ real

Stated plainly, because a demo that overstates itself costs more of your time
than one that admits a gap:

- **Identity verification is a fixture, not a vendor.** There is no selfie, no
  liveness check and no third-party IDV call. The walk posts a provider result
  of `0.95` to the same endpoint a vendor's client would call. The identity
  machine, its `0.9` floor and every resulting decision are real — what is
  absent is the capture and the vendor behind the number.
- **Staff identity is a static token.** The service is handed one bearer token
  for a `senior_moderator`. There is no staff login, no SSO and no staff session
  row, so a real deployment needs that built before a person can moderate
  anything. Members authenticate through the real session table. The decision in
  step 9 is a real row written by the real route — but _who_ made it is a token,
  not an authenticated person.
- **No outbound email.** Recovery codes and sign-out notices are composed by the
  service and then dropped; no relay is configured. The walk does not use them.
- **No UI is started by this walk.** It exercises the server and the rules it
  enforces, driven as a client would drive it. A web client exists — `node
  web/server.mjs`, then <http://127.0.0.1:5173> — and is the way to *look* at
  this rather than read it.
- **Step 7 deviates from a straight three-person script.** Carol completes
  verification and matches Alice before blocking her, because an unverified
  account cannot hold a conversation, so the block would have nothing to close.
  The walk prints the deviation inside the step. Step 4's discovery claim is
  unaffected — Carol is still unverified when it runs.
- **A signal in the first few milliseconds can leave the throwaway database
  behind**, and `SIGKILL` always does. Neither is catchable in-process. What is
  gone is the wider window it used to have: the teardown is now a single memoised
  promise, every spawned child is registered from the moment it exists, and the
  create is held so teardown awaits it. Measured over 66 interrupts across
  `SIGINT` and `SIGTERM`: 0 leaked databases. The handler prints the exact DROP
  command when it cannot clean up, so the failure is visible rather than silent.
  It holds no rows; clear it with
  `make db-shell` and `DROP DATABASE <name> WITH (FORCE)`. A run that completes
  normally always drops its own.
- **No production infrastructure.** One Postgres container on port `55432`, a
  service on `127.0.0.1:8787`. No TLS, no deployment story.
- **Social events are not built.** Deferred by decision, not by omission. See
  `docs/architecture/event-chat-safety.md`.
- **Profile and onboarding are partial.** They work over HTTP but there is no
  surface for a person to use them from.

The full status map, including what is decided but deliberately unbuilt, is in
`docs/delivery-state.md`.

## Prerequisites

| You need              | Version     | Why                                           |
| --------------------- | ----------- | --------------------------------------------- |
| Docker                | any recent  | Runs Postgres. Nothing else needs installing. |
| Node.js               | 20 or newer | The service is TypeScript built to ESM.       |
| GNU `tar` or `bsdtar` | any         | Only if you rebuild the archive yourself.     |

No database to install, no global npm packages, no Xcode.

## Run it

```bash
tar -xzf been-there-demo-0.1.0.tar.gz
cd been-there-demo-0.1.0        # or whatever directory it unpacked into
npm ci
```

`npm ci` is not optional. This archive deliberately contains no `node_modules`:
a copy of someone else's installed tree is unreproducible and often wrong for
your platform. The lockfile is here so `npm ci` gives you the exact versions
this was built and tested against.

Then walk the whole journey, which is the thing worth running:

```bash
npm run demo:journey
```

That is one command on a fresh machine. It builds the packages, creates its own
database, migrates it, starts a service, drives all eleven steps against it over
HTTP, restarts the service at step 11, and drops the database on the way out.
It takes about a second.

### Or: a live service to poke at by hand

```bash
make demo              # deps up, migrated, serving on http://127.0.0.1:8787
make demo-stop         # stops the service, leaves Postgres running
make down              # stops Postgres too, keeping the data
```

`make demo` starts Postgres, applies the migrations, and serves on
<http://127.0.0.1:8787>, printing the URL, the pid and a ready-to-paste `curl`
line in `.demo/service.log`. Health: `curl http://127.0.0.1:8787/v1/health/ready`.

**`make demo` seeds 87 rows** and refuses to serve if that fails — it prints what
`make seed` said and exits 1, rather than starting an empty database and letting
you believe the product worked. The rows are written through the domain's own
stores, so a seeded `verified` account is one the domain would have produced.

(An earlier version of this file said the served database was empty because
`packages/seed` did not exist. It does now; the claim was stale, not a defect in
the demo.)

### What the walk proves

The database it uses is its own, named `t_journey_*`, created and migrated for
that run and dropped at the end. It never touches what `make demo` serves.

It exits non-zero if any step fails, naming the step and the reason, and with
code 130 if you interrupt it. A demo that cannot fail is a brochure; if this
exits 0 you know the four claims above were observed, not asserted.

The eleven steps:

| #   | Step                                        | Proves                                                                                                                                                                                 |
| --- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Alice signs up and passes the age gate      | An under-18 signup is refused with `422 not_eligible` and writes nothing. Alice's account is created with `identity.discoverable false`.                                               |
| 2   | Alice verifies (provider result 0.95)       | A clean provider result grants `verified` and flips `discoverable` to true.                                                                                                            |
| 3   | Bob does the same                           | Verified, the same way.                                                                                                                                                                |
| 4   | Alice browses discovery                     | Alice sees Bob. Carol is absent from Alice's page _because Carol is unverified_, and Carol's own page is empty with no reason given. **Key claim.**                                    |
| 5   | Alice likes Bob, Bob likes Alice            | Exactly one match, and the conversation is opened by the match rather than by either person.                                                                                           |
| 6   | Alice sends a message                       | Delivered through the communication gate.                                                                                                                                              |
| 7   | Carol blocks Alice                          | Alice's send is refused `403` on rule `blocked`, nothing is stored, and nothing discloses that a block exists. **Key claim.**                                                          |
| 8   | Bob reports Alice for harassment            | The report is recorded with its evidence frozen at report time, and still works after the relationship ends.                                                                           |
| 9   | A moderation case opens, a named human acts | A member reading the case queue is refused `403`. A `senior_moderator` then records `restrict` over the real route; the decision, case transition and audit rows all land in Postgres. |
| 10  | Alice is restricted                         | Messaging is refused on `missing_send_message_capability`; report and block both still return `201`. Identity stays `verified` — a sanction is not an identity change. **Key claim.**  |
| 11  | Restart the service                         | `SIGTERM` to the process, a second process starts, and all six row groups are re-read from it. Different pid, no shared memory. **Key claim.**                                         |

### Run the test suite

```bash
make check
```

Typecheck, tests, documentation links, migrations, the client gate, and a check
that the local commands and the CI workflow have not drifted apart. It needs
Xcode for the two client steps; on a machine without Xcode, `make test` alone
runs the TypeScript suite.

## How it is put together

Dependencies point inward: feature → domain → `core`. No domain package imports
another domain package. Cross-domain data arrives as a `DomainEvent` or a
versioned read-model projection, never as direct reads of another domain's
tables.

Lifecycles are transition tables, not scattered status assignment — so a guard
cannot be removed from one call site and left in another. Expected failures are
`Result` values, not exceptions.

```
packages/core            shared kernel: ids, Result, the state-machine helper,
                         event envelope, and the three shared state machines
packages/identity        verification: the provider scores, the domain decides
packages/dating          profiles, preferences, discovery, likes, matches
packages/communication   conversations, messages, the gate
packages/trust-safety    behavioural risk; detectors that recommend, never act
packages/moderation      reports, cases, enforcement
packages/platform        privacy, sensitivity classes, shared capabilities
packages/database        eight stores over real Postgres, plus migrations
packages/service         the HTTP surface: routes, wiring, health, readiness
client/BeenThereKit      Swift mirror of the rules the server enforces
docs/architecture        boundaries and ADRs; read 00-overview.md first
docs/features            one specification per feature
```

The full design argument is in `docs/architecture/00-overview.md`.

## Troubleshooting

| Symptom                                       | Cause                                                                                         |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `make up` fails with `POSTGRES_USER is unset` | You ran `docker compose` by hand instead of `make up`. `make up` supplies the local defaults. |
| Port 55432 already in use                     | Another Postgres. Change `POSTGRES_PORT` in `.env` and in `DATABASE_URL` to match.            |
| `make demo` cannot reach the database         | Postgres is not up yet: run `make ps`.                                                        |
| The service exits at start                    | Run `make logs`. Usually a port already in use; `make demo-stop` then retry.                  |
| A `t_journey_*` database survives a run       | You interrupted the walk near step 11. It holds no rows; drop it. See "What is _not_ real".   |
| `Dataset: NOT loaded` from `make demo`        | No longer expected — `make demo` now seeds 87 rows and hard-fails if seeding fails.         |

## Notes on this archive

`BUNDLE-MANIFEST.txt` at the archive root lists every file included, with sizes.

Deliberately absent: `node_modules/` (rebuild with `npm ci`), `dist/` and
`.build/` (compiled output; a stale copy runs old code), `.git/`, every `.env*`
file (your machine's configuration — `.env.example` is included, and the
Makefile's defaults match it exactly), `*.tsbuildinfo`, `*.log`, any `*.dump`,
and any `t_*` per-suite test database artefact.
