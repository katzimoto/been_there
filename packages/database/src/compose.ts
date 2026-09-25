import type { Pool } from 'pg';
import type { Stores } from '@been-there/contracts';
import { PgAccountStandingStore } from './store-account-standing.js';
import { PgConversationStore } from './store-conversation.js';
import { PostgresIdentityStore } from './store-users-identity.js';
import { PostgresInteractionStore } from './store-interaction.js';
import { createModerationStore } from './store-moderation.js';
import { PgRiskStore } from './store-risk.js';
import { PgVerificationAttemptStore } from './store-verification-attempts.js';
import { PostgresUserStore } from './store-users-identity.js';

/**
 * The composition root: one function that turns a pool into the stores the
 * service composes against.
 *
 * The service imports this rather than any concrete store, so the wiring lives
 * in exactly one place. A composition root inside the service package would be
 * a second place, and the second place is where it would be changed and the
 * first one forgotten.
 *
 * Every store is zero-argument and resolves its connection from the caller's
 * `Transaction`, so this assembles them without a pool being passed to any of
 * them. The `pool` parameter is what makes the composition *checkable* — a
 * missing store is a type error at this line rather than an undefined property
 * somewhere in a request handler.
 */
export function createStores(pool: Pool): Stores {
  if (pool === undefined || typeof pool.connect !== 'function') {
    throw new Error('createStores needs a pg Pool; it assembles stores, it does not create one');
  }
  return {
    users: new PostgresUserStore(),
    identity: new PostgresIdentityStore(),
    interaction: new PostgresInteractionStore(),
    conversations: new PgConversationStore(),
    risk: new PgRiskStore(),
    moderation: createModerationStore(),
    accountStanding: new PgAccountStandingStore(),
    verificationAttempts: new PgVerificationAttemptStore(),
  };
}
