import type { Route } from './http/router.js';
import type { ServiceDependencies } from './ports.js';
import { accountRoutes, accountSessionRoutes } from './routes/accounts.js';
import { accountDeletionRoutes } from './routes/account-deletion.js';
import { healthRoutes } from './routes/health.js';
import { readinessRoutes } from './routes/readiness.js';
import { conversationRoutes } from './routes/conversations.js';
import { discoveryRoutes } from './routes/discovery.js';
import { interactionRoutes } from './routes/interactions.js';
import { matchRoutes } from './routes/matches.js';
import { moderationRoutes } from './routes/moderation.js';
import { moderatorWorkspaceRoutes } from './routes/moderation-workspace.js';
import { reportRoutes } from './routes/reports.js';
import { profileRoutes } from './routes/profile.js';
import { goalRoutes } from './routes/goal.js';
import { verificationRoutes } from './routes/verification.js';
import { staffSessionRoutes } from './routes/staff-sessions.js';

export * from './ports.js';
export * from './http/body.js';
export * from './http/failure.js';
export * from './http/router.js';
export * from './http/server.js';
export * from './wiring/attempts.js';
export * from './wiring/dating.js';
export * from './wiring/moderation.js';
export * from './wiring/standing.js';
export * from './wiring/safety.js';

/**
 * Every endpoint, in one table.
 *
 * The list is built once, at the edge, from the same route modules the handlers
 * live in — so there is no second file describing what the API is. Each group
 * takes `dependencies` rather than reaching for a module-level singleton,
 * because a service that cannot be constructed twice cannot be tested against a
 * real database and a fixture in the same process.
 */
export function serviceRoutes(dependencies: ServiceDependencies): readonly Route[] {
  return [
    ...healthRoutes(dependencies),
    ...readinessRoutes(dependencies),
    ...accountRoutes(dependencies),
    ...accountSessionRoutes(dependencies),
    ...staffSessionRoutes(dependencies),
    ...profileRoutes(dependencies),
    ...discoveryRoutes(dependencies),
    ...goalRoutes(dependencies),
    ...accountDeletionRoutes(dependencies),
    ...verificationRoutes(dependencies),
    ...interactionRoutes(dependencies),
    ...matchRoutes(dependencies),
    ...conversationRoutes(dependencies),
    ...reportRoutes(dependencies),
    ...moderationRoutes(dependencies),
    ...moderatorWorkspaceRoutes(dependencies),
  ];
}
export * from './health/meter.js';
export * from './health/metrics.js';
export * from './health/readiness.js';
export * from './health/lifecycle.js';
export * from './health/service.js';
export * from './routes/health.js';
export * from './routes/readiness.js';
export * from './routes/staff-sessions.js';
export * from './accounts/session-resolver.js';
