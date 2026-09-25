import { describe, expect, it } from 'vitest';
import { castId, type UserId } from '@been-there/core';
import {
  beginRecovery,
  completeRecovery,
  issueSession,
  recordFailedRecoveryAttempt,
  recoveryAuditFields,
  refreshSession,
  revokeSession,
  validateSession,
  type RecoveryId,
  type Session,
  type SessionId,
} from '../src/index.js';
import { rejected, succeeded } from './helpers.js';

const NOW = new Date('2026-03-01T12:00:00.000Z');
const ALICE = castId<'UserId'>('u-alice') as UserId;
const BOB = castId<'UserId'>('u-bob') as UserId;

function sessionId(seed: string): SessionId {
  return castId<'SessionId'>(seed);
}

function sessionFor(
  userId: UserId,
  id: string,
  ttlSeconds = 900,
  refreshWindowSeconds = 3600,
): Session {
  return succeeded(
    issueSession({
      sessionId: sessionId(id),
      userId,
      authMethod: 'password',
      now: NOW,
      ttlSeconds,
      refreshWindowSeconds,
    }),
  );
}

describe('session lifecycle', () => {
  it('authenticates while active and refuses once the access window closes', () => {
    const session = sessionFor(ALICE, 'sess-1');

    expect(succeeded(validateSession(session, new Date(NOW.getTime() + 899_000))).sessionId).toBe(
      session.sessionId,
    );
    expect(rejected(validateSession(session, new Date(NOW.getTime() + 900_000))).details).toEqual({
      reason: 'expired',
    });
  });

  it('refuses a ttl longer than the refresh window', () => {
    const result = issueSession({
      sessionId: sessionId('sess-long'),
      userId: ALICE,
      authMethod: 'password',
      now: NOW,
      ttlSeconds: 7200,
      refreshWindowSeconds: 3600,
    });

    expect(rejected(result).code).toBe('validation_failed');
  });

  it('stops authenticating at access expiry but can still be rotated inside the refresh window', () => {
    const session = sessionFor(ALICE, 'sess-1');
    const afterExpiry = new Date(NOW.getTime() + 901_000);

    expect(rejected(validateSession(session, afterExpiry)).details).toEqual({ reason: 'expired' });

    const rotated = refreshSession(session, afterExpiry, { sessionId: sessionId('sess-2') });
    expect(succeeded(rotated).current.status).toBe('active');
    expect(rejected(validateSession(session, afterExpiry)).code).toBe('permission_denied');
  });
});

describe('refresh is rotation', () => {
  it('supersedes the old session and keeps the refresh window absolute', () => {
    const original = sessionFor(ALICE, 'sess-1');
    const later = new Date(NOW.getTime() + 600_000);

    const outcome = succeeded(
      refreshSession(original, later, { sessionId: sessionId('sess-2') }),
    );

    expect(outcome.previous.status).toBe('superseded');
    expect(outcome.previous.supersededBy).toBe(outcome.current.sessionId);
    expect(outcome.current.status).toBe('active');
    // The window is absolute: a session that keeps being refreshed must not
    // slide its own deadline forward.
    expect(outcome.current.refreshableUntil.getTime()).toBe(original.refreshableUntil.getTime());
  });

  it('refuses to rotate a session that was already rotated away', () => {
    const original = sessionFor(ALICE, 'sess-1');
    const first = succeeded(refreshSession(original, NOW, { sessionId: sessionId('sess-2') }));

    const second = refreshSession(first.previous, NOW, { sessionId: sessionId('sess-3') });

    expect(rejected(second).details).toEqual({ reason: 'superseded' });
  });

  it('refuses to rotate a session whose refresh window has closed', () => {
    const original = sessionFor(ALICE, 'sess-1');

    const result = refreshSession(original, new Date(NOW.getTime() + 3600_000), {
      sessionId: sessionId('sess-2'),
    });

    expect(rejected(result).details).toEqual({ reason: 'refresh_window_closed' });
  });

  it('refuses to rotate a revoked session', () => {
    const revoked = revokeSession(sessionFor(ALICE, 'sess-1'), 'user_logout');

    const result = refreshSession(revoked, NOW, { sessionId: sessionId('sess-2') });

    expect(rejected(result).details).toEqual({ reason: 'revoked' });
  });

  it('leaves a superseded session superseded when it is revoked afterwards', () => {
    const original = sessionFor(ALICE, 'sess-1');
    const rotated = succeeded(refreshSession(original, NOW, { sessionId: sessionId('sess-2') }));

    const revoked = revokeSession(rotated.previous, 'moderation_enforcement');

    expect(revoked.status).toBe('superseded');
    expect(revoked.revokedReason).toBeUndefined();
  });
});

describe('account recovery', () => {
  it('invalidates every session the account held', () => {
    const recovery = beginRecovery({
      recoveryId: castId<'RecoveryId'>('rec-1') as RecoveryId,
      userId: ALICE,
      method: 'email',
      now: NOW,
    });
    const sessions = [sessionFor(ALICE, 'sess-phone'), sessionFor(ALICE, 'sess-laptop'), sessionFor(BOB, 'sess-bob')];

    const outcome = succeeded(
      completeRecovery(recovery, sessions, new Date(NOW.getTime() + 60_000), {
        sessionId: sessionId('sess-recovered'),
      }),
    );

    const alicesSessions = outcome.sessions.filter((session) => session.userId === ALICE);
    // The attacker's cookie and the owner's cookie both die: that is the whole
    // security value of a reset.
    expect(alicesSessions.map((session) => session.status)).toEqual(['revoked', 'revoked']);
    expect(alicesSessions.every((session) => session.revokedReason === 'recovery_completed')).toBe(true);
    // Another user's session is not collateral damage.
    expect(outcome.sessions.find((session) => session.userId === BOB)?.status).toBe('active');
    // The owner is not left signed out of their own account.
    expect(outcome.session.authMethod).toBe('recovery');
    expect(outcome.request.status).toBe('consumed');
    expect(outcome.request.revokedSessionIds).toHaveLength(2);
  });

  it('cannot be completed twice, and cannot be completed after it expires', () => {
    const recovery = beginRecovery({
      recoveryId: castId<'RecoveryId'>('rec-1') as RecoveryId,
      userId: ALICE,
      method: 'sms',
      now: NOW,
    });
    const sessions = [sessionFor(ALICE, 'sess-phone')];
    const outcome = succeeded(
      completeRecovery(recovery, sessions, new Date(NOW.getTime() + 60_000), {
        sessionId: sessionId('sess-recovered'),
      }),
    );

    const replay = completeRecovery(outcome.request, outcome.sessions, new Date(NOW.getTime() + 120_000), {
      sessionId: sessionId('sess-again'),
    });
    expect(rejected(replay).code).toBe('invalid_transition');

    const fresh = beginRecovery({
      recoveryId: castId<'RecoveryId'>('rec-2') as RecoveryId,
      userId: ALICE,
      method: 'sms',
      now: NOW,
    });
    const late = completeRecovery(fresh, sessions, new Date(NOW.getTime() + 31 * 60_000), {
      sessionId: sessionId('sess-late'),
    });
    expect(rejected(late).details).toEqual({ status: 'expired' });
  });

  it('locks after the attempt threshold rather than inviting another try', () => {
    const recovery = beginRecovery({
      recoveryId: castId<'RecoveryId'>('rec-1') as RecoveryId,
      userId: ALICE,
      method: 'email',
      now: NOW,
    });

    const afterThree = recordFailedRecoveryAttempt(
      recordFailedRecoveryAttempt(recordFailedRecoveryAttempt(recovery, 3), 3),
      3,
    );

    expect(afterThree.attempts).toBe(3);
    expect(afterThree.status).toBe('locked');
    // Locked means locked: a locked request cannot be completed.
    expect(
      rejected(
        completeRecovery(afterThree, [], NOW, { sessionId: sessionId('sess-x') }),
      ).code,
    ).toBe('invalid_transition');
  });

  it('produces audit fields that describe the event without carrying a credential', () => {
    const recovery = beginRecovery({
      recoveryId: castId<'RecoveryId'>('rec-1') as RecoveryId,
      userId: ALICE,
      method: 'email',
      now: NOW,
    });

    const fields = recoveryAuditFields(recovery, {
      revokedSessionIds: [castId<'SessionId'>('sess-1')],
    });

    expect(fields.map((field) => field.name)).toEqual([
      'recovery_id',
      'method',
      'status',
      'attempts',
      'revoked_session_count',
    ]);
    expect(fields.find((field) => field.name === 'revoked_session_count')?.value).toBe(1);
    // Nothing here is `restricted`, so a support console can read the recovery
    // history without the read counting as identity-evidence access.
    expect(fields.every((field) => field.sensitivity !== 'restricted')).toBe(true);
  });
});
