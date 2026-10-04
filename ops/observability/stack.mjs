#!/usr/bin/env node
/**
 * Up, down, reset and status for the local observability stack.
 *
 * A wrapper rather than a `make` target, because the Makefile is CI-mirroring:
 * anything added there is a target `scripts/dev/check-ci-parity.mjs` will then
 * hold to a workflow step that does not exist. This script owns the one thing
 * the Makefile cannot — a second Compose project — and owns it explicitly:
 *
 *   -p been-there-observability
 *
 * The root `docker-compose.yml` runs under the same engine and takes its project
 * name from `COMPOSE_PROJECT_NAME` in the repository `.env`. Without the flag
 * this stack would try to attach itself to that project and fail on a network
 * definition the Postgres file already owns.
 *
 *   node ops/observability/stack.mjs up       start, wait until healthy, print URLs
 *   node ops/observability/stack.mjs status   container state and health
 *   node ops/observability/stack.mjs down     stop, keep the volumes
 *   node ops/observability/stack.mjs reset    stop and delete every volume
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PROJECT = 'been-there-observability';
const here = dirname(fileURLToPath(import.meta.url));
const composeFile = join(here, 'docker-compose.yml');

/** Host ports, resolved the same way the Compose file resolves them. */
function port(name, fallback) {
  return process.env[name] ?? fallback;
}

const URLS = () =>
  [
    `Grafana    http://localhost:${port('OBS_GRAFANA_PORT', '3001')}`,
    `Prometheus http://localhost:${port('OBS_PROMETHEUS_PORT', '9090')}`,
    `Loki       http://localhost:${port('OBS_LOKI_PORT', '3100')}`,
    `Tempo      http://localhost:${port('OBS_TEMPO_PORT', '3200')}`,
  ].join('\n');

function compose(args, { capture = false } = {}) {
  const result = spawnSync(
    'docker',
    ['compose', '-p', PROJECT, '-f', composeFile, ...args],
    { cwd: here, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8' },
  );
  if (result.error !== undefined && result.error !== null) {
    process.stderr.write(
      'docker compose could not be run. Is Docker running?\n' + result.error.message + '\n',
    );
    process.exit(1);
  }
  return result;
}

const [command = 'status'] = process.argv.slice(2);

switch (command) {
  case 'up': {
    const result = compose(['up', '-d', '--wait', '--wait-timeout', '180']);
    if (result.status !== 0) {
      process.stderr.write(
        '\nThe stack did not become healthy. `node ops/observability/stack.mjs status` shows which container, ' +
          'and `docker compose -p been-there-observability -f ops/observability/docker-compose.yml logs <name>` shows why.\n',
      );
      process.exit(result.status === null ? 1 : result.status);
    }
    process.stdout.write(
      '\nThe observability stack is healthy.\n\n' +
        URLS() +
        '\n\nNext: start the instrumented service and drive some traffic through it.\n' +
        '  node ops/observability/metrics-exporter.mjs &\n' +
        '  BEEN_THERE_OBSERVABILITY=1 node --import ./ops/observability/instrumentation.mjs scripts/demo/server.mjs\n' +
        '  npm run demo:journey\n\n' +
        'See docs/observability.md.\n',
    );
    break;
  }
  case 'down': {
    compose(['down']);
    break;
  }
  case 'reset': {
    // Every volume goes: a stale Loki or Tempo volume is the usual reason a
    // "the dashboard is empty" report is not reproducible.
    compose(['down', '--volumes', '--remove-orphans']);
    break;
  }
  case 'status': {
    compose(['ps']);
    break;
  }
  default: {
    process.stderr.write(`Unknown command "${command}". Use up, status, down or reset.\n`);
    process.exit(2);
  }
}