import { randomUUID } from 'node:crypto';
import {
  type DomainError,
  type Result,
  type UserId,
  domainError,
  ok,
} from '@been-there/core';
import type { SessionRow } from '@been-there/contracts';
import {
  SIGN_IN_FAILED_COPY,
  evaluatePassword,
  hashPassword,
  normalizeContact,
  verifyPassword,
} from '@been-there/platform';
import { readString } from '../http/body.js';
import { MISSING_FIELD } from '../http/failure.js';
import { okResponse, publicRoute, route, type Route } from '../http/router.js';
import type { ContactMessage, ServiceDependencies } from '../ports.js';
import { appendAudit, correlationIdFrom, recordFunnel } from '../accounts/funnel.js';
import {
  LOGIN_ATTEMPTS_PER_WINDOW,
  WINDOW_MS,
  loginDelayMinutes,
  recordAttempt,
  withinLimit,
} from '../accounts/rate-limit.js';
import {
  RECOVERY_ATTEMPTS_PER_SOURCE_PER_DAY,
  RECOVERY_NEUTRAL_RESPONSE,
  admitRecovery,
  attemptsInWindow,
  checkRecoverySecret,
  completeAccountRecovery,
  newRecoveryId,
  newRecoverySecret,
  recoveryMethodFor,
  recoveryRequestOf,
  recoverySecretHash,
} from '../accounts/recovery.js';
import {
  applySessionLimit,
  issueStoredSession,
  revokeAll,
  revokedRow,
  rotateSession,
} from '../accounts/sessions.js';
import { sessionTokenDigest } from '../accounts/session-token.js';
import { accountRecoveryRoutes } from './account-recovery.js';
import {
  type NoticeSender,
  notifyOwner,
  recoveryCompletedFactId,
  recoveryPauseKey,
  signedOutFactId,
} from '../accounts/notices.js';

/**
 * Sign-in, refresh, logout, and recovery.
 *
 * Almost every route here is one a caller reaches *without* a session: sign-up,
 * sign-in, refresh and recovery are the four endpoints where holding one is the
 * thing the caller is trying to get, or to get back. `logoutAll` is the
 * exception — it names an account rather than a session, so it needs the actor
 * the resolver produced, and §6's whole point is that holding a session is the
 * credential. A route that accepted a `userId` from a body would be a second
 * authorisation path and the two would disagree about exactly the case that
 * matters.
 *
 * ## The neutral response
 *
 * `POST /v1/account-recovery` has exactly one exit and it is the same for every
 * input: an existing account, an unknown address, a typo, and a request that
 * crossed the abuse threshold. §5.2 requires that all contact-verification
 * failures return one message so the form is not an account-existence oracle, and
 * §7.1.2 says the same thing about recovery in different words. A route with
 * three exits would leak; a route with one cannot.
 *
 * ## What recovery revokes
 *
 * Every session, always. A password reset that leaves the attacker's cookie alive
 * has reset nothing — the reset is only real when the credential the attacker is
 * using stops working. `completeRecovery` in the platform does that revocation
 * and this route writes every row it returns.
 */

/** The 15-minute expiry §5.2 gives a contact-verification email link. */
const CONTACT_LINK_TTL_MINUTES = 15;

export function accountSessionRoutes(dependencies: ServiceDependencies): readonly Route[] {
  return [
    publicRoute('POST', '/v1/account-sessions', async (request) => {
      const contact = readString(request.body, 'contact');
      if (!contact.ok) {
        return contact;
      }
      const password = readString(request.body, 'password');
      if (!password.ok) {
        return password;
      }
      const normalized = normalizeContact(
        contact.value.includes('@') ? 'email' : 'phone',
        contact.value,
      );
      if (!normalized.ok) {
        // An unusable identifier is refused as a bad sign-in rather than as a
        // validation failure: §9 gives one row for both "wrong password" and
        // "account unknown", and a different status here would be the oracle.
        return signInFailed();
      }
      const credential = await dependencies.stores.accounts.findCredentialByContact(
        normalized.value.identifier,
        request.tx,
      );
      if (credential === null) {
        // The password is still verified against the stored hash of *something*,
        // so an unknown address costs the same wall-clock time as a known one.
        // Without this, response latency alone answers "does this account exist".
        await verifyPassword(password.value, DUMMY_PASSWORD_HASH);
        return signInFailed();
      }
      const attempts = await withinLimit(
        dependencies.stores,
        'login_per_account',
        credential.userId,
        LOGIN_ATTEMPTS_PER_WINDOW,
        WINDOW_MS.login,
        request.now,
        request.tx,
      );
      if (!attempts.ok) {
        await recordAttempt(
          dependencies.stores,
          'login_per_account',
          credential.userId,
          request.now,
          request.tx,
        );
        const failures = await dependencies.stores.accounts.countRateLimitEvents(
          'login_per_account',
          credential.userId,
          new Date(request.now.getTime() - WINDOW_MS.login),
          request.tx,
        );
        const delayMinutes = loginDelayMinutes(failures - LOGIN_ATTEMPTS_PER_WINDOW);
        return domainError('rate_limited', 'service.accounts', SIGN_IN_FAILED_COPY.body, {
          title: SIGN_IN_FAILED_COPY.title,
          reason: 'too_many_attempts',
          delayMinutes,
          retryAfterSeconds: delayMinutes * 60,
        });
      }
      await recordAttempt(
        dependencies.stores,
        'login_per_account',
        credential.userId,
        request.now,
        request.tx,
      );
      const verified = await verifyPassword(password.value, credential.passwordHash);
      if (!verified) {
        return signInFailed();
      }

      const issued = issueStoredSession(credential.userId, 'password', request.now);
      if (!issued.ok) {
        return issued;
      }
      const held = await dependencies.stores.accounts.listSessionsFor(credential.userId, request.tx);
      const capped = applySessionLimit([...held, issued.value.row]);
      await dependencies.stores.accounts.insertSession(issued.value.row, request.tx);
      for (const evicted of capped.evicted) {
        await dependencies.stores.accounts.updateSession(evicted, request.tx);
      }
      const correlationId = correlationIdFrom(undefined);
      await recordFunnel(
        { stores: dependencies.stores, tx: request.tx, correlationId, now: request.now },
        'account.session_started',
        { surface: 'sign_in', auth_method: 'password' },
      );
      return okResponse(201, {
        userId: credential.userId,
        token: issued.value.token,
        sessionId: issued.value.row.sessionId,
        expiresAt: issued.value.row.expiresAt.toISOString(),
        refreshableUntil: issued.value.row.refreshableUntil.toISOString(),
        evictedSessions: capped.evicted.length,
      });
    }),

    /**
     * Refresh, presented as the token being refreshed rather than as a session id.
     *
     * Rotation is unconditional: the old row is written `superseded` in the same
     * transaction that writes the new one, so a stolen token is single-use and the
     * loser of the race is already dead.
     */
    publicRoute('POST', '/v1/account-sessions/refresh', async (request) => {
      const token = readString(request.body, 'token');
      if (!token.ok) {
        return token;
      }
      const row = await dependencies.stores.accounts.findSessionByToken(
        sessionTokenDigest(token.value),
        request.tx,
      );
      if (row === null) {
        return domainError('permission_denied', 'service.accounts', SESSION_EXPIRED_COPY.body, {
          title: SESSION_EXPIRED_COPY.title,
          reason: 'unknown_session',
        });
      }
      const rotated = rotateSession(row, request.now);
      if (!rotated.ok) {
        return domainError('permission_denied', 'service.accounts', SESSION_EXPIRED_COPY.body, {
          title: SESSION_EXPIRED_COPY.title,
          reason: rotated.error.details?.['reason'] ?? 'expired',
        });
      }
      // The new row first, then the supersession. `superseded_by` is a foreign
      // key onto `account_sessions`, so writing the old row as superseded before
      // its replacement exists is a constraint violation — and the failure is
      // silent in the worst way: the client keeps a token whose session no longer
      // exists, rather than a rotation.
      await dependencies.stores.accounts.insertSession(rotated.value.current, request.tx);
      await dependencies.stores.accounts.updateSession(rotated.value.previous, request.tx);
      return okResponse(200, {
        userId: rotated.value.current.userId,
        token: rotated.value.token,
        sessionId: rotated.value.current.sessionId,
        expiresAt: rotated.value.current.expiresAt.toISOString(),
        refreshableUntil: rotated.value.current.refreshableUntil.toISOString(),
      });
    }),

    /**
     * This device. Conversation state is untouched on the server, per §6.1: a
     * sign-out is an access decision and not a deletion.
     */
    publicRoute('DELETE', '/v1/account-sessions', async (request) => {
      const token = readString(request.body, 'token');
      if (!token.ok) {
        return token;
      }
      const row = await dependencies.stores.accounts.findSessionByToken(
        sessionTokenDigest(token.value),
        request.tx,
      );
      if (row === null) {
        return domainError('permission_denied', 'service.accounts', SESSION_EXPIRED_COPY.body, {
          title: SESSION_EXPIRED_COPY.title,
          reason: 'unknown_session',
        });
      }
      await dependencies.stores.accounts.updateSession(
        revokedRow(row, 'user_logout'),
        request.tx,
      );
      await recordFunnel(
        {
          stores: dependencies.stores,
          tx: request.tx,
          correlationId: correlationIdFrom(undefined),
          now: request.now,
        },
        'account.session_revoked',
        { scope: 'this_device' },
      );
      return okResponse(200, { userId: row.userId, revoked: 1, scope: 'this_device' });
    }),
    /**
     * All devices.
     *
     * The notification goes to the verified channel on success, always — including
     * when the request came from a compromised session, because §6.1 says the
     * owner is the person who needs to know. That is why the notice is keyed on the
     * fact and not on the request: a key derived from the session would be
     * different for each of the sessions an attacker holds, and each would deliver.
     */
    route('DELETE', '/v1/account-sessions/all', async (request) => {
      const userId = request.actor.userId;
      if (userId === null) {
        return MISSING_FIELD('session');
      }
      const credential = await dependencies.stores.accounts.findCredential(userId, request.tx);
      if (credential === null) {
        return domainError('not_found', 'service.accounts', 'this account has no credential');
      }
      const revoked = revokeAll(
        await dependencies.stores.accounts.listSessionsFor(userId, request.tx),
        'user_requested',
      );
      for (const row of revoked) {
        await dependencies.stores.accounts.updateSession(row, request.tx);
      }
      const correlationId = correlationIdFrom(undefined);
      const funnel = {
        stores: dependencies.stores,
        tx: request.tx,
        correlationId,
        now: request.now,
      };
      await recordFunnel(funnel, 'account.session_revoked', { scope: 'all_devices' });
      await appendAudit(funnel, {
        action: 'auth.session_revoked',
        actorId: request.actor.actorId,
        subjectId: userId,
        entityType: 'account',
        entityId: userId,
        detail: { scope: 'all_devices', revoked_count: revoked.length },
      });
      await notifyOwner(
        dependencies.stores,
        request.tx,
        contactSender(dependencies),
        {
          userId,
          kind: 'account.signed_out_all_devices',
          sourceFactId: signedOutFactId(userId, request.now),
          correlationId,
          channel: credential.contactKind === 'phone' ? 'in_app' : 'email',
          facts: { count: revoked.length, event_date: request.now.toISOString().slice(0, 10) },
        },
        {
          address: credential.contactIdentifier,
          relayChannel: credential.contactKind === 'phone' ? 'sms' : 'email',
        },
        request.now,
      );
      return okResponse(200, { revoked: revoked.length, scope: 'all_devices' });
    }),
    ...accountRecoveryRoutes(dependencies),
  ];
}

/** §9's row for a session that can no longer authenticate, verbatim. */
const SESSION_EXPIRED_COPY = {
  title: "You've been signed out for security.",
  body: 'Sign in again to pick up where you left off.',
} as const;

/**
 * The one response the recovery request path returns.
 *
 * Built here rather than read from the module so the route has no branch on which
 * it could differ: an unknown account, a known account and a paused recovery all
 * leave through here.
 */
function neutralRecoveryResponse(): Result<{ status: number; body: unknown }, DomainError> {
  return okResponse(202, {
    status: 'recovery_requested',
    title: RECOVERY_NEUTRAL_RESPONSE.title,
    message: RECOVERY_NEUTRAL_RESPONSE.body,
  });
}

/**
 * §9's wrong-code row, reused for an expired and an already-used recovery.
 *
 * One message for all three, because a client that can tell them apart learns the
 * state of somebody's reset link — which is the account-existence oracle the
 * neutral response exists to prevent, reached by a different door.
 */
function recoveryCodeRejected(): Result<never, DomainError> {
  return domainError('validation_failed', 'service.accounts', 'That recovery link is not valid.', {
    field: 'code',
    title: 'That code is not right.',
    reason: 'recovery_code_rejected',
  });
}

/**
 * A failed sign-in, counted and generic.
 *
 * Identical for a wrong password and an unknown account, per §9: the two rows say
 * *identical copy*, and a different status or a different message between them is
 * an existence oracle.
 */
function signInFailed(): Result<never, DomainError> {
  return domainError('permission_denied', 'service.accounts', SIGN_IN_FAILED_COPY.body, {
    title: SIGN_IN_FAILED_COPY.title,
    reason: 'sign_in_failed',
  });
}

/**
 * A scrypt digest nothing matches, so a sign-in for an unknown account costs the
 * same wall-clock time as one for a known account.
 *
 * A real hash of a random password: the point is that `verifyPassword` does the
 * same 250 ms of work either way, so response time does not answer "does this
 * account exist" on its own. It is a constant, so it is computed once.
 */
const DUMMY_PASSWORD_HASH =
  'scrypt:32768:8:1$AAAAAAAAAAAAAAAAAAAAAA==$' +
  'Yv0KQ0kQ0kQ0kQ0kQ0kQ0kQ0kQ0kQ0kQ0kQ0kQ0kQ0kQ0kQ0kQ0kQ0kQ0kQ0kQ0kQ0kQ0kQ0kQ0kQ0kQ0kQ0kQ==';


/**
 * The notice sender, over the same relay the verification and recovery codes use.
 *
 * Exported rather than duplicated: which SMTP host or SMS gateway is in play is an
 * edge decision, and two copies of this closure would be two places to change it.
 */
export function contactSender(dependencies: ServiceDependencies): NoticeSender {
  return {
    send: async (userId: UserId, relayChannel: 'email' | 'sms', message) => {
      const outgoing: ContactMessage = {
        userId,
        channel: relayChannel,
        address: message.address,
        subject: message.subject,
        body: message.body,
        referenceId: '',
        secret: message.secret,
      };
      await dependencies.contacts.deliver(outgoing);
    },
  };
}
