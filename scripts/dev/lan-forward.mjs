#!/usr/bin/env node
/**
 * Exposes the running demo service on the local network, for a physical iPhone.
 *
 * ## Why this exists
 *
 * The service binds `127.0.0.1` on purpose (`packages/service/src/http/server.ts`
 * is the source of that default, and it stays that way). A phone on the same
 * Wi-Fi is a different host, so `127.0.0.1` on the phone is the phone. There is
 * no way for the phone to reach the Mac's loopback without something in between,
 * and the three usual candidates are all unavailable here:
 *
 * - `socat` is not installed and would be a new dependency on a developer's
 *   machine for one line of behaviour.
 * - a `pfctl` redirect needs `sudo`, and the rule outlives the process, so a
 *   forgotten rule is an open port nobody remembers adding.
 * - editing the service's bind address changes a safety default in the product
 *   to serve a demo.
 *
 * This script is the fourth option: it binds **one specific address** — the
 * Mac's LAN address, never `0.0.0.0` — forwards to `127.0.0.1:8787`, prints the
 * exact URL to type into the app's Service field, and stops on Ctrl-C with
 * nothing left behind. No dependency, no privileges, no residue.
 *
 * ## What it costs
 *
 * While it runs, anyone else on the same network can reach the demo service
 * over plain HTTP. It is a development service with seeded data and a stub
 * verification provider, so what is at risk is that data, not a person's
 * account. Stop it as soon as the phone has what it needs.
 *
 * ## Usage
 *
 *     node scripts/dev/lan-forward.mjs [--address A] [--interface IF] [--port N] [--target-port N]
 *
 * Defaults: `--interface en0`, `--port` = the demo port (`DEMO_PORT` or 8787),
 * `--target-port` the same. `--address` overrides interface detection, and
 * `--address 0.0.0.0` is refused: binding every interface is broader than a
 * phone needs and this script has no reason to do it.
 */

import http from 'node:http';
import net from 'node:net';
import os from 'node:os';

/** Loopback. The service's own address; the far end of every forwarded connection. */
const LOOPBACK = '127.0.0.1';

/** The loopback address, spelled as a bind address. Refused like the wildcard. */
const LOOPBACK_BIND = '127.0.0.1';

/**
 * The interface whose address the phone is expected to reach. macOS names the
 * Wi-Fi interface `en0` on every machine this repository has been run on, but it
 * is an interface name rather than a fact, so `--interface` overrides it and
 * detection falls back to the first non-internal IPv4 address.
 */
const DEFAULT_INTERFACE = process.env['LAN_INTERFACE'] ?? 'en0';

const options = parse(process.argv.slice(2));
const upstreamPort = options.targetPort;
const listenPort = options.port;

const address = options.address ?? detectAddress(options.interface);

if (address === '0.0.0.0' || address === '::') {
  fail(
    'Refusing to bind a wildcard address. This exposes the service on every ' +
      'interface this Mac has, including any VPN and any virtual network. Pass ' +
      "the LAN address explicitly instead, e.g. --address 172.20.10.10 — or run " +
      `with no --address at all and let the script detect one on ${options.interface}.`,
  );
}

if (!isIpv4(address)) {
  fail(`--address must be an IPv4 address, not "${address}".`);
}

if (isLoopback(address)) {
  fail(
    `"${address}" is a loopback address, so nothing off this machine can reach it. ` +
      `The point of this script is the LAN address: \`ipconfig getifaddr ${options.interface}\`.`,
  );
}

await assertUpstreamListening();

const forwarder = http.createServer(forward);
forwarder.keepAliveTimeout = 5_000;

forwarder.on('clientError', (_error, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
});

try {
  await new Promise((resolvePromise, rejectPromise) => {
    forwarder.once('error', rejectPromise);
    forwarder.listen(listenPort, address, () => {
      forwarder.removeListener('error', rejectPromise);
      resolvePromise();
    });
  });
} catch (error) {
  if (error.code === 'EADDRINUSE') {
    fail(
      `${address}:${listenPort} is already in use, so the forwarder did not start. ` +
        'Stop whatever holds it, or pick another port: --port 8899.',
    );
  }
  fail(`Could not listen on ${address}:${listenPort}: ${error.message}`);
}

say(`listening on http://${address}:${listenPort}`);
say(`forwarding to http://${LOOPBACK}:${upstreamPort}`);
say('');
say('  Service field on the iPhone:');
say('');
say(`    http://${address}:${listenPort}`);
say('');
say(`  check it from this Mac:  curl -s http://${address}:${listenPort}/v1/health/ready`);
say('  stop it:               Ctrl-C here');
say('');
say('This is a development service on the local network while it runs. Anyone');
say('else on this network can reach the seeded demo data over plain HTTP.');
say('Stop it as soon as the phone has what it needs.');

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    forwarder.close(() => {
      // Idle keep-alive sockets would hold `close` open for their timeout.
      forwarder.closeAllConnections?.();
      say('stopped. Nothing is left listening.');
      process.exit(0);
    });
    // A forwarded request still in flight must not hold the exit open.
    setTimeout(() => process.exit(0), 2_000).unref();
  });
}

/**
 * Proxies one request to the loopback service and pipes the response back.
 *
 * The hop-by-hop headers RFC 9110 section 7.6.1 lists are dropped rather than
 * forwarded: a `connection` header naming a tunnel, for instance, means nothing
 * to the far end of this forward and would be a protocol error there.
 *
 * @param {http.IncomingMessage} request
 * @param {http.ServerResponse} response
 */
function forward(request, response) {
  const proxied = http.request(
    {
      host: LOOPBACK,
      port: upstreamPort,
      method: request.method,
      path: request.url,
      headers: { ...request.headers, host: `${LOOPBACK}:${upstreamPort}` },
    },
    (upstream) => {
      response.writeHead(upstream.statusCode ?? 502, stripHopByHop(upstream.headers));
      upstream.pipe(response);
    },
  );

  // An upstream that is down is a fact the phone should see as a failed
  // request, not a hung connection that looks like a slow app.
  proxied.on('error', () => {
    if (!response.headersSent) {
      response.writeHead(502, { 'content-type': 'application/json' });
    }
    response.end(
      JSON.stringify({
        error: 'upstream_unavailable',
        message: `nothing is serving ${LOOPBACK}:${upstreamPort}`,
      }),
    );
  });

  request.pipe(proxied);
}

/**
 * @param {http.IncomingHttpHeaders} headers
 * @returns {http.OutgoingHttpHeaders}
 */
function stripHopByHop(headers) {
  const kept = { ...headers };
  for (const name of [
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
  ]) {
    delete kept[name];
  }
  return kept;
}

/**
 * Fails before binding if nothing is serving the loopback port, because a
 * forwarder that answers 502 for everything looks like a broken app.
 */
async function assertUpstreamListening() {
  const reachable = await new Promise((resolvePromise) => {
    const socket = net.connect({ host: LOOPBACK, port: upstreamPort });
    const finish = (result) => {
      socket.destroy();
      resolvePromise(result);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    setTimeout(() => finish(false), 2_000).unref();
  });

  if (!reachable) {
    fail(
      `Nothing is listening on ${LOOPBACK}:${upstreamPort}, so there is nothing ` +
        'to forward to. Start the service first: `make demo`. To forward to a ' +
        'demo running on another port: --target-port 8899.',
    );
  }
}

/**
 * The IPv4 address of the named interface, or of the first non-internal
 * interface when the named one is absent.
 *
 * @param {string} interfaceName
 * @returns {string}
 */
function detectAddress(interfaceName) {
  const interfaces = os.networkInterfaces();
  const named = interfaces[interfaceName]?.find(
    (entry) => entry.family === 'IPv4' && !entry.internal,
  );
  if (named !== undefined) return named.address;

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }

  fail(
    `No IPv4 address found on ${interfaceName} or on any other interface, so ` +
      'there is nothing to bind. Connect the Mac to the same network as the ' +
      'phone and try again.',
  );
}

/**
 * @param {string[]} argv
 * @returns {{ address: string | undefined, interface: string, port: number, targetPort: number }}
 */
function parse(argv) {
  const parsed = { address: undefined, interface: DEFAULT_INTERFACE, port: undefined, targetPort: undefined };
  const demoPort = Number(process.env['DEMO_PORT'] ?? '8787');

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];

    // Before the value check: `--help` is the one flag that takes nothing.
    if (flag === '--help') {
      process.stdout.write(
        'usage: node scripts/dev/lan-forward.mjs [--address A] [--interface IF] [--port N] [--target-port N]\n',
      );
      process.exit(0);
    }

    const value = argv[index + 1];
    if (value === undefined) fail(`${flag} needs a value.`);

    switch (flag) {
      case '--address':
        parsed.address = value;
        break;
      case '--interface':
        parsed.interface = value;
        break;
      case '--port':
        parsed.port = portOf(value, '--port');
        break;
      case '--target-port':
        parsed.targetPort = portOf(value, '--target-port');
        break;
      default:
        fail(`Unknown argument "${flag}". Run with --help for the usage.`);
    }
    index += 1;
  }

  parsed.targetPort ??= demoPort;
  parsed.port ??= parsed.targetPort;
  return parsed;
}

/**
 * @param {string} value
 * @param {string} flag
 * @returns {number}
 */
function portOf(value, flag) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    fail(`${flag} must be a port number, not "${value}".`);
  }
  return port;
}

/** @param {string} address */
function isIpv4(address) {
  return /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(address) === true;
}

/** @param {string} address */
function isLoopback(address) {
  return address === LOOPBACK_BIND || address.startsWith('127.');
}

/** @param {string} message */
function say(message) {
  process.stdout.write(`[lan-forward] ${message}\n`);
}

/** @param {string} message */
function fail(message) {
  process.stderr.write(`[lan-forward] ${message}\n`);
  process.exit(1);
}