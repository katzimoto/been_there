import { type DomainError, type Result } from '@been-there/core';
import { type HttpResponse, type Route, okResponse, publicRoute } from '../http/router.js';
import type { ServiceDependencies } from '../ports.js';
import { createServiceHealth } from '../health/service.js';

/**
 * Readiness — public, and non-transactional.
 *
 * Public because an orchestrator holds no session, and readiness that needs one is
 * readiness nobody calls: the probe would be answered 403 and every replica taken
 * out of rotation by a 403 that says nothing about the database. Public is safe
 * here precisely because the body is a reachability boolean and a per-dependency
 * check list — no subject, no case id, no person, nothing an observer could learn
 * about anybody.
 *
 * Non-transactional for the reason spelled out in `health.ts`: the whole purpose
 * of this endpoint is to be answerable while the transactional store is not.
 */
export function readinessRoutes(dependencies: ServiceDependencies): readonly Route[] {
  const health = createServiceHealth(dependencies);
  return [
    publicRoute(
      'GET',
      '/v1/health/ready',
      async (): Promise<Result<HttpResponse, DomainError>> => {
        const report = await health.readiness();
        return okResponse(report.ready ? 200 : 503, report);
      },
      { transactional: false },
    ),
  ];
}