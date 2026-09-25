import type { Route } from './http/router.js';
import type { ServiceDependencies } from './ports.js';
import { accountRoutes } from './routes/accounts.js';
import { conversationRoutes } from './routes/conversations.js';
import { discoveryRoutes } from './routes/discovery.js';
import { interactionRoutes } from './routes/interactions.js';
import { matchRoutes } from './routes/matches.js';
import { moderationRoutes } from './routes/moderation.js';
import { reportRoutes } from './routes/reports.js';
import { profileRoutes } from './routes/profile.js';
import { verificationRoutes } from './routes/verification.js';

export * from './ports.js';
export * from './http/body.js';
export * from './http/failure.js';
export * from './http/router.js';
export * from './http/server.js';
export * from './wiring/attempts.js';
export * from './wiring/dating.js';
export * from './wiring/moderation.js';
export * from './wiring/standing.js';

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
    ...accountRoutes(dependencies),
    ...verificationRoutes(dependencies),
    ...profileRoutes(dependencies),
    ...discoveryRoutes(dependencies),
    ...interactionRoutes(dependencies),
    ...matchRoutes(dependencies),
    ...conversationRoutes(dependencies),
    ...reportRoutes(dependencies),
    ...moderationRoutes(dependencies),
  ];
}
