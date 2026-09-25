import { randomUUID } from 'node:crypto';
import {
  type AccountId,
  type DomainError,
  type Result,
  type UserId,
  castId,
  domainError,
  identityMachine,
  ok,
} from '@been-there/core';
import { NOT_FOUND } from '../http/failure.js';
import { okResponse, route, type Route } from '../http/router.js';
import type { ServiceDependencies } from '../ports.js';
import { accountProjectionFor, identityProjectionFor } from '../wiring/standing.js';

/**
 * Accounts, and the identity row every account is born with.
 *
 * Creating an account writes two rows — the user and its identity state — inside
 * the one transaction the dispatcher already opened for the request. An account
 * with no identity row is invisible to every eligibility gate in the system: not
 * restricted, not unverified, simply absent, and an absent row is a much harder
 * thing to debug than a wrong one. The state written is
 * `identityMachine.initial`, read from the kernel rather than written as the
 * literal `'unverified'`, so what a new account starts in is declared in exactly
 * one place.
 *
 * There is no `verified` anywhere on this path, and there is no way to add one:
 * the only writer of an identity state is `writeIdentityState` in
 * `routes/verification.ts`, and it takes a state that a machine transition
 * produced.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function userIdOf(value: string | undefined): Result<UserId, DomainError> {
  if (value === undefined || !UUID.test(value)) {
    return domainError('validation_failed', 'service.http', 'the user id is not a uuid', {
      field: 'userId',
    });
  }
  return ok(castId<'UserId'>(value));
}

export function accountRoutes(dependencies: ServiceDependencies): readonly Route[] {
  return [
    route('POST', '/v1/accounts', async (request) => {
      const userId = castId<'UserId'>(randomUUID());
      const accountId = castId<'AccountId'>(randomUUID());
      const createdAt = request.now;
      await dependencies.stores.users.create({ userId, accountId, createdAt }, request.tx);
      await dependencies.stores.identity.insert(
        {
          userId,
          state: identityMachine.initial,
          generation: 1,
          latestVerificationId: null,
          updatedAt: createdAt,
        },
        request.tx,
      );
      return okResponse(201, {
        userId,
        accountId,
        createdAt: createdAt.toISOString(),
        identity: {
          state: identityMachine.initial,
          generation: 1,
          discoverable: false,
        },
      });
    }),

    route('GET', '/v1/accounts/:userId', async (request) => {
      const userId = userIdOf(request.params['userId']);
      if (!userId.ok) {
        return userId;
      }
      const [user, identity, account] = await Promise.all([
        dependencies.stores.users.find(userId.value, request.tx),
        dependencies.stores.identity.find(userId.value, request.tx),
        dependencies.stores.accountStanding.find(userId.value, request.tx),
      ]);
      if (user === null) {
        return NOT_FOUND('account');
      }
      if (identity === null) {
        // Written together by the route above, and nothing ever deletes one, so
        // this is a defect rather than an absence. Reporting `not_found` would
        // tell a caller the account does not exist, which is false and sends them
        // looking in the wrong place.
        throw new Error(`account ${userId.value} has no identity row; account creation is broken`);
      }
      const standing = accountProjectionFor(account, userId.value);
      return okResponse(200, {
        userId: user.userId,
        accountId: user.accountId,
        createdAt: user.createdAt.toISOString(),
        identity: identityProjectionFor(identity, userId.value),
        account: standing,
      });
    }),
  ];
}
