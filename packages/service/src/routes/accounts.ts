import { randomUUID } from 'node:crypto';
import {
  type AccountId,
  type DomainError,
  type Result,
  type UserId,
  castId,
  domainError,
  err,
  identityMachine,
  ok,
} from '@been-there/core';
import { NOT_FOUND } from '../http/failure.js';
import { okResponse, publicRoute, route, type Route } from '../http/router.js';
import type { ServiceDependencies } from '../ports.js';
import { accountProjectionFor, identityProjectionFor } from '../wiring/standing.js';
import { correlationIdFrom, recordFunnel } from '../accounts/funnel.js';
import { readinessFor } from '../accounts/onboarding.js';
import {
  AGE_GATE_NOTICE,
  readSignUpInput,
  rejectionReasonFor,
  validateSignUp,
} from '../accounts/sign-up.js';
import { applySessionLimit, issueStoredSession } from '../accounts/sessions.js';
import {
  SIGNUP_PER_CONTACT_PER_DAY,
  WINDOW_MS,
  recordAttempt,
  withinLimit,
} from '../accounts/rate-limit.js';

/**
 * Accounts, the identity row every account is born with, and the age gate that
 * decides whether one is born at all.
 *
 * ## The gate is wired here, not merely available
 *
 * The age gate existed as a pure function before this route took a date of birth,
 * which meant it was unit-testable and enforced nowhere. §4.2 lists the
 * consequences of an under-18 result and every one of them are honoured by the
 * *ordering* below rather than by a check at the end:
 *
 * 1. The body is read into `SignUpInput`, which has no `age` field, so a
 *    client-supplied age is refused before any domain function runs.
 * 2. `validateSignUp` runs the gate and returns a `Result`. It writes nothing —
 *    it is a pure function from body to values.
 * 3. **Only if it returned `ok`** does this handler take its first write. So an
 *    under-18 result writes no user row, no credential, no onboarding row, sends
 *    no contact-verification message, and calls no provider, because the code that
 *    would do any of those has not been reached.
 *
 * A funnel event *is* written on the way out, and that is deliberate: §4.2 says a
 * rejection is counted with a coarse `under_18` marker, and an analytics row
 * carries no account-shaped residue — it has no user id, no contact identifier
 * and no date of birth, by the recorder's own rules.
 *
 * ## The identity row
 *
 * Creating an account writes two rows — the user and its identity state — inside
 * the one transaction the dispatcher already opened for the request. An account
 * with no identity row is invisible to every eligibility gate in the system: not
 * restricted, not unverified, simply absent. The state written is
 * `identityMachine.initial`, read from the kernel rather than written as the
 * literal `'unverified'`, so what a new account starts in is declared in exactly
 * one place.
 *
 * There is no `verified` anywhere on this path, and there is no way to add one:
 * the only writer of an identity state is `writeIdentityState` in
 * `routes/verification.ts`, and it takes a state a machine transition produced.
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
    publicRoute('POST', '/v1/accounts', async (request) => {
      const input = readSignUpInput(request.body);
      if (!input.ok) {
        return refusedSignUp(dependencies, request, input.error, correlationIdFrom(undefined));
      }
      const validated = await validateSignUp(input.value, request.now);
      if (!validated.ok) {
        return refusedSignUp(dependencies, request, validated.error, input.value.journeyId ?? randomUUID());
      }
      const signUp = validated.value;
      const correlationId = correlationIdFrom(signUp.journeyId);

      // One verified contact identifier is one account. The lock is taken before
      // the duplicate read so two concurrent sign-ups on the same address cannot
      // both find nothing and both write; the unique index would catch the loser,
      // but a constraint violation is not a duplicate *answer* the caller can give.
      await dependencies.stores.accounts.lockContact(signUp.contact.identifier, request.tx);
      const existing = await dependencies.stores.accounts.findCredentialByContact(
        signUp.contact.identifier,
        request.tx,
      );
      if (existing !== null) {
        return duplicateSignUp(dependencies, request, existing.userId, correlationId);
      }
      const limit = await withinLimit(
        dependencies.stores,
        'signup_per_contact',
        signUp.contact.identifier,
        SIGNUP_PER_CONTACT_PER_DAY,
        WINDOW_MS.day,
        request.now,
        request.tx,
      );
      if (!limit.ok) {
        return refusedSignUp(dependencies, request, limit.error, correlationId);
      }
      await recordAttempt(
        dependencies.stores,
        'signup_per_contact',
        signUp.contact.identifier,
        request.now,
        request.tx,
      );

      const userId = castId<'UserId'>(randomUUID());
      const accountId = castId<'AccountId'>(randomUUID());
      await dependencies.stores.users.create({ userId, accountId, createdAt: request.now }, request.tx);
      await dependencies.stores.identity.insert(
        {
          userId,
          state: identityMachine.initial,
          generation: 1,
          latestVerificationId: null,
          updatedAt: request.now,
        },
        request.tx,
      );
      await dependencies.stores.accounts.insertCredential(
        {
          userId,
          contactKind: signUp.contact.kind,
          contactIdentifier: signUp.contact.identifier,
          // Step 2 is blocking and has not happened yet: the product may read
          // this boolean, and it is `false` until a code is presented.
          contactVerified: false,
          passwordHash: signUp.passwordHash,
          createdAt: request.now,
          updatedAt: request.now,
        },
        request.tx,
      );
      await dependencies.stores.accounts.insertOnboarding(
        {
          userId,
          dateOfBirth: signUp.dateOfBirthIso,
          ageAttested: true,
          termsVersion: signUp.termsVersion,
          termsAcceptedAt: request.now,
          coarseArea: null,
          updatedAt: request.now,
        },
        request.tx,
      );

      // A session here rather than a second round trip: steps 2, 3 and 4 are
      // blocking and the client has a credential it can present to reach them. The
      // token is returned once here and never stored.
      const issued = issueStoredSession(userId, 'password', request.now);
      if (!issued.ok) {
        return issued;
      }
      const existingSessions = await dependencies.stores.accounts.listSessionsFor(userId, request.tx);
      const capped = applySessionLimit([...existingSessions, issued.value.row]);
      for (const row of capped.kept) {
        await dependencies.stores.accounts.insertSession(row, request.tx);
      }

      const funnel = {
        stores: dependencies.stores,
        tx: request.tx,
        correlationId,
        now: request.now,
      };
      await recordFunnel(funnel, 'account.registration_completed', { surface: 'sign_up' });
      await recordFunnel(funnel, 'account.onboarding_step_completed', {
        step: 'age_gate',
        source: 'sign_up',
      });
      await recordFunnel(funnel, 'account.onboarding_step_completed', {
        step: 'terms',
        source: 'sign_up',
      });

      return okResponse(201, {
        userId,
        accountId,
        createdAt: request.now.toISOString(),
        contactVerified: false,
        termsVersion: signUp.termsVersion,
        // The band, which is public. Not the date of birth, not an exact age —
        // §4.3 makes both owner-only-and-never-rendered, and this response is
        // rendered by a client.
        ageBand: signUp.ageBand,
        ageGate: AGE_GATE_NOTICE,
        identity: {
          state: identityMachine.initial,
          generation: 1,
          discoverable: false,
        },
        session: {
          token: issued.value.token,
          sessionId: issued.value.row.sessionId,
          expiresAt: issued.value.row.expiresAt.toISOString(),
          refreshableUntil: issued.value.row.refreshableUntil.toISOString(),
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

    /**
     * The readiness checklist, owner-only.
     *
     * A caller who is not the owner gets the same `404` as a caller asking about
     * an account that does not exist, and that is the point rather than a
     * convenience: a `403` confirms the account is real, which turns a guessable
     * uuid into an existence oracle. One answer for "no such account" and "not
     * yours" means the difference tells an attacker nothing.
     */
    route('GET', '/v1/accounts/:userId/onboarding', async (request) => {
      const userId = userIdOf(request.params['userId']);
      if (!userId.ok) {
        return userId;
      }
      if (request.actor.userId !== userId.value) {
        return NOT_FOUND('account');
      }
      const readiness = await readinessFor(dependencies.stores, userId.value, request.now, request.tx);
      return okResponse(200, readiness);
    }),
  ];
}

/**
 * Sessions, sign-in and recovery, re-exported so the route table is assembled
 * from one module per concern rather than from a file whose name no longer
 * describes its contents.
 */
export { accountSessionRoutes } from './account-sessions.js';
export { accountRecoveryRoutes } from './account-recovery.js';

/**
 * A refused sign-up: the funnel counts it, and the refusal is returned.
 *
 * The only write on this path is the analytics row, and it carries a reason code
 * and at most a coarse band. No date of birth, no exact age and no contact
 * identifier go into it, because `recordAnalyticsEvent` refuses those properties
 * and the table has no column that could hold one.
 */
async function refusedSignUp(
  dependencies: ServiceDependencies,
  request: Parameters<Route['handle']>[0],
  error: DomainError,
  correlationId: string,
): Promise<Result<{ status: number; body: unknown }, DomainError>> {
  await recordFunnel(
    { stores: dependencies.stores, tx: request.tx, correlationId, now: request.now },
    'account.registration_rejected',
    {
      reason_code: rejectionReasonFor(error),
      // The band is supplied only where one exists, and omitted rather than
      // filled with a placeholder: the recorder rejects a non-scalar, and
      // `typeof null === 'object'` means `null` is one. `'under_18'` is the
      // marker §4.2 names, and it is a *marker* rather than a band computed from
      // the refused date — no age and no date is read here, which is the whole
      // point of the gate having refused.
      ...(error.details?.['reason'] === 'under_18' ? { age_band: 'under_18' } : {}),
    },
  );
  // The refusal itself, re-wrapped: `error` is the `DomainError` a `Result`
  // carries, and returning the value rather than the sum would be a type error
  // the compiler is right to refuse.
  return err(error);
}

/**
 * §5.3's duplicate answer, which is the same for an active, a suspended and a
 * banned account.
 *
 * The submitter is not told which — or that there is anything at all. §5.3 is
 * explicit that this response doubles as the answer to an attacker probing for
 * existence, so nothing about the existing account crosses to the submitter: no
 * `AccountId`, no standing, no case. The attempt is counted, and that is all this
 * route does about it.
 */
async function duplicateSignUp(
  dependencies: ServiceDependencies,
  request: Parameters<Route['handle']>[0],
  existingUserId: UserId,
  correlationId: string,
): Promise<Result<{ status: number; body: unknown }, DomainError>> {
  await recordFunnel(
    { stores: dependencies.stores, tx: request.tx, correlationId, now: request.now },
    'account.registration_rejected',
    // No `age_band`: a duplicate is not an age refusal, and the existing
    // account's band belongs to that account and to nobody's funnel.
    { reason_code: 'duplicate' },
  );
  // Counted against the *existing account*, not the string the caller typed:
  // §5.1's "≤ 3 sign-up attempts per contact identifier per day" is about the
  // identifier, and the identifier here is the normalised one the credential
  // table is keyed by — so a duplicate probe is counted against the account it
  // probed rather than against whatever case the caller happened to use.
  await recordAttempt(
    dependencies.stores,
    'signup_per_contact',
    existingUserId,
    request.now,
    request.tx,
  );
  return okResponse(202, {
    status: 'check_your_contact',
    message: "If that account exists, we've sent a message to it.",
  });
}