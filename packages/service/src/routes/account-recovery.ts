import { randomUUID } from 'node:crypto';
import {
  type DomainError,
  type Result,
  type UserId,
  domainError,
  ok,
} from '@been-there/core';
import { readString } from '../http/body.js';
import { okResponse, publicRoute, type Route } from '../http/router.js';
import type { ContactMessage, ServiceDependencies } from '../ports.js';
import { appendAudit, correlationIdFrom, recordFunnel } from '../accounts/funnel.js';
import { WINDOW_MS, checkLimit, recordAttempt, sourceKey } from '../accounts/rate-limit.js';
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
import { issueStoredSession } from '../accounts/sessions.js';
import { contactSender } from './account-sessions.js';
import {
  type NoticeSender,
  notifyOwner,
  recoveryCompletedFactId,
  recoveryPauseKey,
} from '../accounts/notices.js';
import { evaluatePassword, hashPassword, normalizeContact } from '@been-there/platform';

/**
 * Account recovery: the request and its completion.
 *
 * ## The request path has exactly one exit
 *
 * `POST /v1/account-recovery` answers identically for an existing account, an
 * unknown address, a typo, and a request that has just crossed the abuse
 * threshold. §7.1.2 says so in words and §5.2 requires the same of contact
 * verification. A route with three exits leaks; a route with one cannot, so
 * `neutralRecoveryResponse` is the only thing this file ever returns from that
 * handler.
 *
 * ## The owner learns once, and the arithmetic is why
 *
 * The third attempt inside 24 hours pauses recovery (§7.2). The owner's notice
 * is keyed on the pause *window* rather than the attempt, so every request after
 * the threshold collides on the same unique index in `notices.ts` and delivers
 * nothing. A handler that notified per attempt would still notify once, which is
 * the point: the guarantee is structural rather than remembered.
 *
 * ## Why completion revokes everything
 *
 * A password reset that leaves the attacker's cookie alive has reset nothing.
 * `completeRecovery` in the platform does the revocation and this route writes
 * every row it returns; the test asserts on the rows rather than on the count in
 * the response, because a response that says "signed out" while a session is still
 * active is precisely the failure §7.1 step 4 exists to prevent.
 */
export function accountRecoveryRoutes(dependencies: ServiceDependencies): readonly Route[] {
  return [

    publicRoute('POST', '/v1/account-recovery', async (request) => {
      const contact = readString(request.body, 'contact');
      if (!contact.ok) {
        return contact;
      }
      const normalized = normalizeContact(
        contact.value.includes('@') ? 'email' : 'phone',
        contact.value,
      );
      if (!normalized.ok) {
        return neutralRecoveryResponse();
      }
      // §10's per-source limit is counted against the caller's address and before
      // the credential is read. Both halves matter. Counting it before the lookup
      // is what makes it a limit on *this endpoint's* use rather than a limit on
      // recovery for accounts that happen to exist: a caller spraying unknown
      // addresses is the case the limit exists for, and a version that returned
      // early for an unknown contact would count none of it.
      //
      // It was previously keyed on `request.actor.actorId`, which on a public
      // route is the constant 'anonymous' — so every caller in the world shared
      // one bucket, and the first five recovery requests from anywhere on the
      // internet consumed it for everyone. The result was also discarded, so
      // nothing was enforced at all.
      const sourceAddress = sourceKey(request.clientAddress);
      const bySource = await checkLimit(
        dependencies.stores,
        'recovery_per_source',
        sourceAddress,
        RECOVERY_ATTEMPTS_PER_SOURCE_PER_DAY,
        WINDOW_MS.day,
        request.now,
        request.tx,
      );
      // Every attempt is logged, refused or not. A log holding only the allowed
      // ones would let a caller whose sixth request was refused keep going, and
      // each further attempt would itself have been allowed.
      await recordAttempt(
        dependencies.stores,
        'recovery_per_source',
        sourceAddress,
        request.now,
        request.tx,
      );
      if (!bySource.ok) {
        // The neutral response, not the refusal. This endpoint has exactly one
        // exit (§7.1.2): a rate limit that returned its own error here would be
        // readable as a signal — and since it fires on a source-address budget
        // rather than an account one, a caller could otherwise map how close a
        // given address was to its budget by watching for the change. The refusal
        // is enforced by not issuing anything, and `account.recovery_locked` is
        // what makes it visible to an operator.
        return neutralRecoveryResponse();
      }
      const credential = await dependencies.stores.accounts.findCredentialByContact(
        normalized.value.identifier,
        request.tx,
      );
      if (credential === null) {
        return neutralRecoveryResponse();
      }
      const correlationId = correlationIdFrom(undefined);
      const funnel = {
        stores: dependencies.stores,
        tx: request.tx,
        correlationId,
        now: request.now,
      };

      // §7.1's per-account limit. Counted before anything is written, and it does
      // not change the response either: the requester learns nothing either way.
      const seen = await attemptsInWindow(
        (bucket, key, since) =>
          dependencies.stores.accounts.countRateLimitEvents(bucket, key, since, request.tx),
        credential.userId,
        request.now,
      );
      await recordAttempt(
        dependencies.stores,
        'recovery_per_account',
        credential.userId,
        request.now,
        request.tx,
      );

      const existing = await dependencies.stores.accounts.findOpenRecoveryFor(credential.userId, request.tx);
      const admission = admitRecovery(
        credential.userId,
        newRecoveryId(),
        recoveryMethodFor(credential),
        seen,
        existing,
        request.now,
      );
      if (!admission.admitted) {
        // The third attempt in the window pauses recovery. The owner is told once
        // — the notice key is the pause window, so the fourth attempt through the
        // fortieth all collide on the same unique index and deliver nothing.
        await recordFunnel(funnel, 'account.recovery_locked', {
          reason_code: 'abuse_threshold',
          window_hours: 24,
        });
        await appendAudit(funnel, {
          action: 'auth.recovery_abuse_suspected',
          actorId: request.actor.actorId,
          subjectId: credential.userId,
          entityType: 'recovery',
          entityId: credential.userId,
          detail: { attempt_count: admission.attemptNumber, window_hours: 24 },
        });
        if (existing !== null) {
          await dependencies.stores.accounts.updateRecovery(
            { ...existing, status: 'locked' },
            request.tx,
          );
        }
        await notifyOwner(
          dependencies.stores,
          request.tx,
          contactSender(dependencies),
          {
            userId: credential.userId,
            kind: 'account.recovery_paused',
            sourceFactId: recoveryPauseKey(credential.userId, admission.pausedFrom),
            correlationId,
            channel: credential.contactKind === 'phone' ? 'in_app' : 'email',
            facts: { event_date: admission.pausedFrom.toISOString().slice(0, 10) },
          },
          {
            address: credential.contactIdentifier,
            relayChannel: credential.contactKind === 'phone' ? 'sms' : 'email',
          },
          request.now,
        );
        return neutralRecoveryResponse();
      }

      const secret = newRecoverySecret();
      await dependencies.stores.accounts.insertRecovery(
        {
          recoveryId: admission.recovery.recoveryId,
          userId: credential.userId,
          method: admission.recovery.method,
          status: admission.recovery.status,
          secretHash: recoverySecretHash(secret),
          requestedAt: admission.recovery.requestedAt,
          expiresAt: admission.recovery.expiresAt,
          attempts: admission.recovery.attempts,
          consumedAt: null,
          revokedSessionIds: [],
        },
        request.tx,
      );
      if (existing !== null) {
        // One open recovery at a time, the same rule §5.2 states for contact
        // verification: a second request supersedes the first rather than running
        // beside it, because whoever asked second would otherwise hold a live
        // link the legitimate owner never saw.
        await dependencies.stores.accounts.updateRecovery(
          { ...existing, status: 'expired' },
          request.tx,
        );
      }
      await recordFunnel(funnel, 'account.recovery_started', {
        method: admission.recovery.method,
      });
      await appendAudit(funnel, {
        action: 'auth.recovery_requested',
        actorId: request.actor.actorId,
        subjectId: credential.userId,
        entityType: 'recovery',
        entityId: admission.recovery.recoveryId,
        detail: { method: admission.recovery.method, status: admission.recovery.status },
      });
      await dependencies.contacts.deliver({
        userId: credential.userId,
        channel: credential.contactKind === 'phone' ? 'sms' : 'email',
        address: credential.contactIdentifier,
        subject: 'Reset your Been There password',
        body: `Use this code to finish signing back in. It expires ${admission.recovery.expiresAt.toISOString()}.`,
        referenceId: admission.recovery.recoveryId,
        secret,
      });
      return neutralRecoveryResponse();
    }),

    /**
     * Recovery completion.
     *
     * The one place a password is replaced and every session dies. The revocation
     * is not a side effect of the password change — it *is* the security value of
     * the flow, and a reset that left the attacker's cookie alive would have reset
     * nothing.
     */
    publicRoute('POST', '/v1/account-recovery/complete', async (request) => {
      const contact = readString(request.body, 'contact');
      if (!contact.ok) {
        return contact;
      }
      const secret = readString(request.body, 'code');
      if (!secret.ok) {
        return secret;
      }
      const password = readString(request.body, 'password');
      if (!password.ok) {
        return password;
      }
      const rule = evaluatePassword(password.value);
      if (!rule.ok) {
        return rule;
      }
      const normalized = normalizeContact(
        contact.value.includes('@') ? 'email' : 'phone',
        contact.value,
      );
      if (!normalized.ok) {
        return recoveryCodeRejected();
      }
      const credential = await dependencies.stores.accounts.findCredentialByContact(
        normalized.value.identifier,
        request.tx,
      );
      if (credential === null) {
        return recoveryCodeRejected();
      }
      const open = await dependencies.stores.accounts.findOpenRecoveryFor(credential.userId, request.tx);
      if (open === null) {
        return recoveryCodeRejected();
      }
      const recovery = checkRecoverySecret(
        recoveryRequestOf(open, credential.userId, recoveryMethodFor(credential)),
        secret.value,
        open.secretHash,
        request.now,
      );
      if (!recovery.ok) {
        // The attempt counter moves even on a wrong code, so a brute force is
        // bounded by the stored count rather than by the code's entropy alone.
        await dependencies.stores.accounts.updateRecovery(
          { ...open, attempts: open.attempts + 1 },
          request.tx,
        );
        return recovery;
      }

      const passwordHash = await hashPassword(password.value);
      await dependencies.stores.accounts.updatePasswordHash(
        credential.userId,
        passwordHash,
        request.now,
        request.tx,
      );
      const held = await dependencies.stores.accounts.listSessionsFor(credential.userId, request.tx);
      const completed = completeAccountRecovery(
        recovery.value,
        held,
        randomUUID(),
        request.now,
      );
      if (!completed.ok) {
        return completed;
      }
      for (const row of completed.value.revoked) {
        await dependencies.stores.accounts.updateSession(row, request.tx);
      }
      await dependencies.stores.accounts.updateRecovery(
        {
          recoveryId: completed.value.recovery.recoveryId,
          userId: credential.userId,
          method: completed.value.recovery.method,
          status: completed.value.recovery.status,
          secretHash: open.secretHash,
          requestedAt: completed.value.recovery.requestedAt,
          expiresAt: completed.value.recovery.expiresAt,
          attempts: completed.value.recovery.attempts,
          consumedAt: completed.value.recovery.consumedAt ?? null,
          revokedSessionIds: completed.value.recovery.revokedSessionIds,
        },
        request.tx,
      );

      const issued = issueStoredSession(credential.userId, 'recovery', request.now);
      if (!issued.ok) {
        return issued;
      }
      await dependencies.stores.accounts.insertSession(issued.value.row, request.tx);

      const correlationId = correlationIdFrom(undefined);
      const funnel = {
        stores: dependencies.stores,
        tx: request.tx,
        correlationId,
        now: request.now,
      };
      await recordFunnel(funnel, 'account.recovery_completed', {
        method: completed.value.recovery.method,
        sessions_revoked_count: completed.value.revoked.length,
      });
      await recordFunnel(funnel, 'account.session_revoked', { scope: 'recovery' });
      await recordFunnel(funnel, 'account.session_started', {
        surface: 'recovery',
        auth_method: 'recovery',
      });
      await appendAudit(funnel, {
        action: 'auth.recovery_completed',
        actorId: request.actor.actorId,
        subjectId: credential.userId,
        entityType: 'recovery',
        entityId: completed.value.recovery.recoveryId,
        detail: {
          method: completed.value.recovery.method,
          status: completed.value.recovery.status,
          attempts: completed.value.recovery.attempts,
          revoked_session_count: completed.value.revoked.length,
        },
      });
      await appendAudit(funnel, {
        action: 'auth.session_revoked',
        actorId: request.actor.actorId,
        subjectId: credential.userId,
        entityType: 'account',
        entityId: credential.userId,
        detail: { scope: 'recovery', revoked_count: completed.value.revoked.length },
      });
      await notifyOwner(
        dependencies.stores,
        request.tx,
        contactSender(dependencies),
        {
          userId: credential.userId,
          kind: 'account.recovery_completed',
          sourceFactId: recoveryCompletedFactId(completed.value.recovery.recoveryId),
          correlationId,
          channel: credential.contactKind === 'phone' ? 'in_app' : 'email',
          facts: {
            count: completed.value.revoked.length,
            event_date: request.now.toISOString().slice(0, 10),
          },
        },
        {
          address: credential.contactIdentifier,
          relayChannel: credential.contactKind === 'phone' ? 'sms' : 'email',
        },
        request.now,
      );
      return okResponse(200, {
        userId: credential.userId,
        token: issued.value.token,
        sessionId: issued.value.row.sessionId,
        sessionsRevoked: completed.value.revoked.length,
      });
    }),
  ];
}

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
