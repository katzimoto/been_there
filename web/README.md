# The Been There web client

A clickable browser client for the product, served against the running service.

## Start it

```sh
node web/server.mjs
```

Then open **<http://127.0.0.1:5173>**.

Stop with `Ctrl-C`. The database it created is dropped on exit.

It needs the local Postgres that `make up` starts, and the packages built
(`npx tsc --build`, which `make build` runs), because it imports the service from
`dist` the same way every other consumer of this repository does.

Environment:

| Variable | Default | Meaning |
| --- | --- | --- |
| `WEB_PORT` | `5173` | the port the page is served on |
| `WEB_SERVICE_PORT` | `8788` | the port the service binds, behind the page |
| `WEB_STAFF_TOKEN` | `web-senior-moderator` | the local staff credential the Moderator desk uses |

## What it does

Every screen is a rendering of a response. There is no client-side copy of a
domain rule to drift from the server:

- the age gate copy and age band come from the sign-up response;
- what onboarding still needs comes from `GET /v1/accounts/:userId/onboarding`;
- what an account may still do comes from `account.capabilities` on
  `GET /v1/accounts/:userId` — this is how "a restriction cannot remove `report`
  or `block`" is shown rather than asserted;
- what a profile is missing comes from the profile response;
- why a like did not become a match comes from the like response's `resolution`;
- why a message did not send is the `403` the send route returned, rendered in
  full.

Sign up two or three personas with **Add a person** and switch between them. A
match needs both sides, and so does a block.

## Why there is a proxy

The service sends no CORS headers, so a browser cannot call it from another
origin. `proxy()` in `server.mjs` forwards each request unchanged — method, path,
query, `Authorization`, `content-type`, body — and returns the status and body the
service produced. A refusal arrives as the refusal, with its status intact.

## Why it creates its own database

`demoDatabase` gives the run a `t_`-prefixed database, dropped on exit. A shared
database carries rows from the test suites, and discovery pages the population
ordered by creation, so a new account would sit thousands of rows into the list
and never appear. A fresh database makes two people sign up and see each other.
The `t_` prefix is what `scripts/dev/check-no-leaked-databases.mjs` looks for.

## Dependencies

None. `node:http` serves `public/` and forwards the API calls; the client is plain
ES modules with no build step. Nothing was added to the root `package.json`.

## Known gap

`GET /v1/matches` returns the match, its participants and its standings, and no
`conversationId`. The only response that publishes one is the like that created the
match, so the person who liked first has no published way to open a conversation
from the Matches tab. The page says so and offers to ask the service rather than
guessing an id — but this is a missing field on a published projection, not a
client limitation.
