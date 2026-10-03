#!/usr/bin/env node
/**
 * The Been There web client: a static UI plus a pass-through to the real
 * service, in one process and with no dependencies.
 *
 * ## What this is
 *
 * A person opening `http://127.0.0.1:5173` gets the product. Every decision the
 * UI shows — whether an account may be discovered, whether a send is allowed,
 * which capabilities a restricted account keeps — is a `DomainError` or a
 * projection the service produced. Nothing here decides anything, and the UI has
 * no copy of a rule to fall back on when a call fails.
 *
 * ## Why a proxy rather than the service's own port
 *
 * The service sends no CORS headers, so a browser cannot call it from another
 * origin. `proxy()` below forwards a request byte for byte — method, path, query,
 * `Authorization`, `content-type`, body — and returns the status and body the
 * service produced. A refusal arrives as the refusal, with its status intact,
 * because that is the whole point: a `403` shown to a user as "something went
 * wrong" is the failure mode this UI exists to avoid.
 *
 * ## Why its own database
 *
 * `demoDatabase` gives the run a `t_`-prefixed database that is dropped on exit.
 * A shared database carries 16k rows left by the test suites, and discovery pages
 * the population ordered by creation, so a new account would sit 16,000 rows into
 * the list and never appear. A fresh database makes two people sign up and see
 * each other, which is the journey this UI exists to demonstrate. The `t_` prefix
 * is what `scripts/dev/check-no-leaked-databases.mjs` looks for, so a run killed
 * with SIGKILL is reported rather than becoming invisible.
 *
 * ## Zero dependencies, on purpose
 *
 * `node:http` serves the files and forwards the calls. A framework would add a
 * build step, a lockfile entry and a version to keep current, in exchange for
 * routing that this page does not need — it is one screen with a state machine
 * in `public/app.js`. The root `package.json` is untouched.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { demoDatabase, loadDotEnv } from '../scripts/demo/lib/demo-database.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, 'public');

/** Headers that describe one hop and must not be copied onto the next. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

loadDotEnv();

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const WEB_PORT = portFrom('WEB_PORT', 5173);
const SERVICE_PORT = portFrom('WEB_SERVICE_PORT', 8788);

/** The local staff credential the moderator desk signs in with. */
const STAFF_TOKEN = process.env['WEB_STAFF_TOKEN'] ?? 'web-senior-moderator';

const pg = (await import('pg')).default;
const { createStores, createTransaction } = await import('@been-there/database');
const { ok } = await import('@been-there/core');
const {
  createSessionActorResolver,
  serviceRoutes,
  startService,
} = await import('@been-there/service');

const database = demoDatabase(pg, 'webui');
const connectionString = await database.create();

const pool = new pg.Pool({ connectionString });
const stores = createStores(pool);
const transaction = createTransaction(pool);

// Assert the schema before binding anything. A service answering traffic
// against a database it cannot read looks healthy and then fails on the first
// real request, which is the worst moment to find out.
await pool.query('SELECT 1 FROM app.users LIMIT 0');

const dependencies = {
  stores,
  transaction,
  actors: actorsFor(STAFF_TOKEN, stores, transaction),
  // Composed, never sent. There is no relay in this repository, and a client
  // that quietly posted mail would be an outbound side effect nobody asked for.
  contacts: {
    deliver: async (message) => {
      say(
        `contact message to ${message.address}: "${message.subject}" ` +
          `(reference ${message.referenceId}) — composed, not sent: no relay is configured`,
      );
    },
  },
  now: () => new Date(),
};

const service = await startService(dependencies, {
  routes: serviceRoutes(dependencies),
  port: SERVICE_PORT,
});
const serviceUrl = new URL(service.url);

const web = createServer((req, res) => {
  if (req.url?.startsWith('/v1/') === true) {
    proxy(req, res, serviceUrl);
    return;
  }
  serveStatic(req, res);
});

await new Promise((resolve, reject) => {
  web.once('error', reject);
  web.listen(WEB_PORT, '127.0.0.1', () => {
    web.removeListener('error', reject);
    resolve();
  });
});

const url = `http://127.0.0.1:${WEB_PORT}`;
say(`Been There is at ${url}`);
say(`service ${service.url} — every button on that page calls it directly`);
say(`database ${redact(connectionString)} (dropped when this process exits)`);
say(`moderator desk signs in with the staff token: ${STAFF_TOKEN}`);
say('stop with Ctrl-C');

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopping) {
      return;
    }
    stopping = true;
    say('stopping');
    void (async () => {
      await new Promise((resolve) => web.close(resolve));
      await service.close();
      await pool.end();
      await database.drop();
      process.exit(0);
    })();
  });
}

/**
 * One request, forwarded unchanged.
 *
 * The status code is passed through rather than flattened to 200-with-a-body,
 * because a refusal the browser cannot see is a refusal the browser cannot show.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} target
 */
function proxy(req, res, target) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase()) && value !== undefined) {
      headers[name] = value;
    }
  }
  const upstream = httpRequest(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: req.url,
      headers,
    },
    (upstreamRes) => {
      const out = {};
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (!HOP_BY_HOP.has(name.toLowerCase()) && value !== undefined) {
          out[name] = value;
        }
      }
      res.writeHead(upstreamRes.statusCode ?? 502, out);
      upstreamRes.pipe(res);
    },
  );
  upstream.on('error', (error) => {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          code: 'service_unreachable',
          domain: 'web',
          message: `the service at ${target.origin} did not answer: ${error.message}`,
          retryable: true,
        },
      }),
    );
  });
  req.pipe(upstream);
}

/**
 * A file from `public/`, or the SPA entry point.
 *
 * The path is normalised and then checked to still be inside `public/`, because
 * `GET /../../.env` is a request a demo server should refuse rather than answer.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
function serveStatic(req, res) {
  const requested = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const candidate = normalize(join(PUBLIC, requested === '/' ? '/index.html' : requested));
  const file =
    candidate.startsWith(PUBLIC) && existsSync(candidate) && statSync(candidate).isFile()
      ? candidate
      : join(PUBLIC, 'index.html');
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(file).pipe(res);
}

/**
 * Static staff first, then the production session resolver, so an unrecognised
 * token is refused by the same code path that refuses a revoked session.
 *
 * @param {string} token
 * @param {import('@been-there/contracts').Stores} storesForActors
 * @param {import('@been-there/contracts').Transaction} transactionForActors
 */
function actorsFor(token, storesForActors, transactionForActors) {
  const live = createSessionActorResolver({
    stores: storesForActors,
    transaction: transactionForActors,
    now: () => new Date(),
  });
  return {
    async resolve(authorization) {
      const bearer = authorization?.startsWith('Bearer ') === true ? authorization.slice(7) : undefined;
      if (bearer === token) {
        return ok({
          userId: null,
          role: 'senior_moderator',
          principal: { userId: null, role: 'senior_moderator' },
          automated: false,
          actorId: token,
        });
      }
      return live.resolve(authorization);
    },
  };
}

/** @param {string} name @param {number} fallback */
function portFrom(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new Error(`${name} must be a port number; got ${String(raw)}`);
  }
  return value;
}

/** @param {string} text */
function say(text) {
  process.stdout.write(`[web] ${text}\n`);
}

/** @param {string} connectionStringToRedact */
function redact(connectionStringToRedact) {
  try {
    const parsed = new URL(connectionStringToRedact);
    const credentials = parsed.password === '' ? '' : ':***';
    return `${parsed.protocol}//${parsed.username}${credentials}@${parsed.host}${parsed.pathname}`;
  } catch {
    return '(unparseable connection string)';
  }
}

