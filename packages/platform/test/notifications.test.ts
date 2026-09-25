import { describe, expect, it } from 'vitest';
import {
  castId,
  type DomainError,
  type Result,
  type UserId,
} from '@been-there/core';
import {
  ALWAYS_ON,
  DEFAULT_CHANNEL_OPT_IN,
  DEFAULT_NOTIFICATION_PREFERENCE,
  InMemoryNotificationLedger,
  NOTIFICATION_KINDS,
  deliverNotification,
  isWithinQuietHours,
  planNotification,
  type NotificationCategory,
  type NotificationChannel,
  type NotificationId,
  type NotificationKind,
  type NotificationKindSpec,
  type NotificationPlan,
  type NotificationPreference,
  type NotificationRequest,
  type Suppression,
} from '../src/index.js';
import { rejected, succeeded } from './helpers.js';

const ALICE = castId<'UserId'>('u-alice') as UserId;
const EVERY_CHANNEL: readonly NotificationChannel[] = ['in_app', 'email', 'push'];
const EVERY_KIND = Object.keys(NOTIFICATION_KINDS) as readonly NotificationKind[];
const NOISE_PREFERENCE: NotificationPreference = {
  channelOptIn: {},
  quietHours: { enabled: true, startHour: 0, endHour: 24, timeZone: 'UTC' },
  digest: { dayOfWeek: 1, hour: 9 },
};

function notificationId(seed: string): NotificationId {
  return castId<'NotificationId'>(seed);
}

/**
 * `blockedPair` is part of the request rather than of the preference because it
 * is a fact about the two people, and a test that leaves it out is then testing
 * a notice nobody proved was deliverable.
 */
function requestFor(
  kind: NotificationKind,
  channel: NotificationChannel,
  overrides: Partial<NotificationRequest> = {},
): NotificationRequest {
  const spec: NotificationKindSpec = NOTIFICATION_KINDS[kind];
  return {
    notificationId: notificationId('n-1'),
    recipientId: ALICE,
    kind,
    channel,
    sourceEventId: 'evt-1',
    correlationId: castId<'CorrelationId'>('corr-1'),
    now: new Date('2026-03-01T12:00:00.000Z'),
    ...(spec.pairScoped ? { blockedPair: false } : {}),
    ...overrides,
  };
}

/** Narrows a plan to the delivery branch, failing loudly on a suppression. */
function planned(result: Result<NotificationPlan | Suppression, DomainError>): NotificationPlan {
  const value = succeeded(result);
  if ('suppressed' in value) {
    throw new Error(`expected delivery, got ${value.reason}`);
  }
  return value;
}

function preferenceFor(overrides: Partial<NotificationPreference> = {}): NotificationPreference {
  return { ...DEFAULT_NOTIFICATION_PREFERENCE, ...overrides };
}

describe('the catalogue is the whole of what a notification may say', () => {
  it('gives every category at least one kind, so no category is a dead group', () => {
    const declared: readonly NotificationCategory[] = [
      'safety',
      'account',
      'verification',
      'like',
      'match',
      'message',
      'system',
    ];
    const used = new Set(EVERY_KIND.map((kind) => NOTIFICATION_KINDS[kind].category));

    expect([...used].sort()).toEqual([...declared].sort());
  });

  it('declares a digest cadence on exactly the kinds that ride a digest window', () => {
    for (const kind of EVERY_KIND) {
      const spec: NotificationKindSpec = NOTIFICATION_KINDS[kind];
      const digests = EVERY_CHANNEL.filter((channel) => spec.channels[channel].mode === 'digest');
      // A cadence on a kind with no digest channel is a window nobody waits for,
      // and a digest channel with no cadence is a window with no boundary.
      expect(spec.digest !== undefined, kind).toBe(digests.length > 0);
    }
  });

  it('names a counterpart only where a match already exists', () => {
    // "A counterparty name may appear only after a match exists." A like has no
    // match behind it and an end-of-match notice must not say who ended it, so
    // exactly three kinds may bind a name — and every one of them is pair-scoped.
    const naming = EVERY_KIND.filter((kind) => {
      const spec: NotificationKindSpec = NOTIFICATION_KINDS[kind];
      return spec.channels.email.content.includes('counterparty_first_name');
    });

    expect(naming).toEqual(['match.created', 'message.received', 'message.digest']);
    for (const kind of naming) {
      expect(NOTIFICATION_KINDS[kind].pairScoped, kind).toBe(true);
    }
    // A like is about a person and still may not name them.
    expect(NOTIFICATION_KINDS['like.received'].channels.in_app.content).toEqual([]);
  });

  it('keeps message text out of every body by having no word for it', () => {
    const tokens = new Set(
      EVERY_KIND.flatMap((kind) =>
        EVERY_CHANNEL.flatMap((channel) => [...NOTIFICATION_KINDS[kind].channels[channel].content]),
      ),
    );

    expect(tokens).toContain('counterparty_first_name');
    expect([...tokens].some((token) => /text|body|excerpt|message/i.test(token))).toBe(false);
  });

  it('lets a channel say less than the in-app record and never more', () => {
    // "Shortening for a locked screen may remove detail, never add it." Where a
    // kind has an in-app record at all, that record is the reference and every
    // other channel is a subset of it — a diff, not a review. Four kinds have no
    // in-app surface by design (a ban, a recovery receipt, a deletion receipt, a
    // message digest), and for those there is nothing to be a subset of.
    // The exceptions are named, not tolerated: a conditional invariant read as a
    // universal one is how the next person reintroduces the bug. Four kinds have
    // no in-app record, for two stated reasons — the durable record already
    // exists under another kind (`message.digest`), or the user cannot reach the
    // app at all (a ban, a recovery receipt, a deletion receipt).
    const withoutInApp = EVERY_KIND.filter(
      (kind) => NOTIFICATION_KINDS[kind].channels.in_app.mode === 'off',
    );
    expect(withoutInApp).toEqual([
      'message.digest',
      'account.banned',
      'account.recovery',
      'account.deletion_completed',
    ]);

    for (const kind of EVERY_KIND) {
      const spec: NotificationKindSpec = NOTIFICATION_KINDS[kind];
      if (spec.channels.in_app.mode === 'off') {
        continue;
      }
      for (const channel of EVERY_CHANNEL) {
        for (const token of spec.channels[channel].content) {
          expect(
            spec.channels.in_app.content,
            `${kind}/${channel} adds ${token} to the in-app record`,
          ).toContain(token);
        }
      }
    }
  });

  it('keeps the case reference off a lock screen and in the email the user quotes', () => {
    const enforcementKinds = [
      'account.restriction.applied',
      'account.suspended',
      'account.banned',
      'moderation.warning_issued',
      'appeal.resolved',
    ] as const;

    for (const kind of enforcementKinds) {
      const spec: NotificationKindSpec = NOTIFICATION_KINDS[kind];
      // The case reference is how a user contests, and §2.1 is explicit that the
      // notice carries it. It is the push that omits it: a push is rendered on a
      // device that may not be the user's own, which is the same reason no
      // notification carries a distance band.
      expect(spec.channels.email.content, kind).toContain('case_reference');
      expect(spec.channels.push.content, kind).not.toContain('case_reference');
      if (spec.channels.in_app.mode !== 'off') {
        expect(spec.channels.in_app.content, kind).toContain('case_reference');
      }
    }
  });
});

describe('a critical notice cannot be switched off', () => {
  it('delivers every critical kind on every channel it uses, with every lever pulled', () => {
    let delivered = 0;

    for (const kind of EVERY_KIND) {
      const spec: NotificationKindSpec = NOTIFICATION_KINDS[kind];
      if (!spec.critical) {
        continue;
      }
      for (const channel of EVERY_CHANNEL) {
        if (spec.channels[channel].mode === 'off') {
          continue;
        }
        const plan = planned(planNotification(requestFor(kind, channel), NOISE_PREFERENCE, EVERY_CHANNEL));
        expect(plan.critical, `${kind}/${channel}`).toBe(true);
        expect(plan.mode, `${kind}/${channel}`).toBe('immediate');
        delivered += 1;
      }
    }

    expect(delivered).toBeGreaterThan(20);
  });

  it('suppresses every non-critical kind once its channels are all switched off', () => {
    for (const kind of EVERY_KIND) {
      const spec: NotificationKindSpec = NOTIFICATION_KINDS[kind];
      if (spec.critical) {
        continue;
      }
      for (const channel of EVERY_CHANNEL) {
        if (spec.channels[channel].mode === 'off') {
          continue;
        }
        const outcome = succeeded(planNotification(requestFor(kind, channel), NOISE_PREFERENCE, EVERY_CHANNEL));
        expect(outcome, `${kind}/${channel}`).toMatchObject({ suppressed: true, reason: 'channel_muted' });
      }
    }
  });

  it('treats a verification outcome as critical, which is why it has its own category', () => {
    // The four verification notices determine whether the user is discoverable at
    // all; filing them under a suppressible category made them muteable.
    const verificationKinds = [
      'verification.passed',
      'verification.failed',
      'verification.rate_limited',
      'verification.review_required',
      'verification.expired',
    ] as const;

    for (const kind of verificationKinds) {
      expect(NOTIFICATION_KINDS[kind].category, kind).toBe('verification');
      expect(NOTIFICATION_KINDS[kind].critical, kind).toBe(true);
    }
  });
});

describe('block separation', () => {
  it('withholds every pair notice from both sides of a block', () => {
    const pairKinds = EVERY_KIND.filter((kind) => NOTIFICATION_KINDS[kind].pairScoped);
    expect(pairKinds.length).toBeGreaterThan(3);

    for (const kind of pairKinds) {
      for (const channel of EVERY_CHANNEL) {
        if (NOTIFICATION_KINDS[kind].channels[channel].mode === 'off') {
          continue;
        }
        const outcome = succeeded(
          planNotification(
            requestFor(kind, channel, { blockedPair: true }),
            DEFAULT_NOTIFICATION_PREFERENCE,
            EVERY_CHANNEL,
          ),
        );
        expect(outcome, `${kind}/${channel}`).toMatchObject({ suppressed: true, reason: 'block_separation' });
      }
    }
  });

  it('refuses a pair notice whose caller never stated the block edge', () => {
    const withoutEdge: NotificationRequest = { ...requestFor('message.received', 'push') };
    delete (withoutEdge as { blockedPair?: boolean }).blockedPair;

    expect(rejected(planNotification(withoutEdge, DEFAULT_NOTIFICATION_PREFERENCE, EVERY_CHANNEL)).code).toBe(
      'validation_failed',
    );
  });

  it('refuses a block edge on a notice that is about nobody in particular', () => {
    const request = requestFor('verification.failed', 'push', { blockedPair: true });

    expect(rejected(planNotification(request, DEFAULT_NOTIFICATION_PREFERENCE, EVERY_CHANNEL)).code).toBe(
      'validation_failed',
    );
  });
});

describe('quiet hours defer, they do not drop', () => {
  const berlinNight = { enabled: true, startHour: 23, endHour: 7, timeZone: 'Europe/Berlin' } as const;
  const at = new Date('2026-03-01T22:30:00.000Z');

  it('holds a match push until the recipient local morning', () => {
    const plan = planned(
      planNotification(
        requestFor('match.created', 'push', { now: at }),
        preferenceFor({ quietHours: berlinNight }),
        EVERY_CHANNEL,
      ),
    );

    // 22:30 UTC is 23:30 in Berlin on 1 March (CET), so the release is 07:00
    // local — 06:00 UTC — and the notice is held rather than discarded.
    expect(plan.mode).toBe('deferred');
    expect(plan.deliverAt.toISOString()).toBe('2026-03-02T06:00:00.000Z');
  });

  it('sends the same instant to a recipient whose evening has not started', () => {
    const plan = planned(
      planNotification(
        requestFor('match.created', 'push', { now: at }),
        preferenceFor({ quietHours: { ...berlinNight, timeZone: 'UTC' } }),
        EVERY_CHANNEL,
      ),
    );

    expect(plan).toMatchObject({ mode: 'immediate', deliverAt: at });
  });

  it('never defers the in-app entry, which is the durable record', () => {
    const plan = planned(
      planNotification(
        requestFor('match.created', 'in_app', { now: at }),
        preferenceFor({ quietHours: berlinNight }),
        EVERY_CHANNEL,
      ),
    );

    expect(plan).toMatchObject({ mode: 'immediate', deliverAt: at });
  });

  it('reads the window in the recipient local zone, midnight-spanning', () => {
    const window = { enabled: true, startHour: 22, endHour: 6, timeZone: 'UTC' } as const;
    const daytime = { ...window, startHour: 9, endHour: 17 };

    expect(isWithinQuietHours(window, new Date('2026-03-01T23:30:00.000Z'))).toBe(true);
    expect(isWithinQuietHours(window, new Date('2026-03-01T02:00:00.000Z'))).toBe(true);
    expect(isWithinQuietHours(window, new Date('2026-03-01T12:00:00.000Z'))).toBe(false);
    // A daytime window is inclusive-start, exclusive-end.
    expect(isWithinQuietHours(daytime, new Date('2026-03-01T09:00:00.000Z'))).toBe(true);
    expect(isWithinQuietHours(daytime, new Date('2026-03-01T17:00:00.000Z'))).toBe(false);
    // "Quiet hours" is a local fact: 22:30 UTC is 23:30 in Berlin, so the same
    // instant is inside a 23–07 window in Berlin and outside it in UTC.
    const evening = { ...window, startHour: 23, endHour: 7 };
    expect(isWithinQuietHours({ ...evening, timeZone: 'Europe/Berlin' }, at)).toBe(true);
    expect(isWithinQuietHours(evening, at)).toBe(false);
    expect(isWithinQuietHours(ALWAYS_ON, at)).toBe(false);
  });
});

describe('digest is a schedule, not a prohibition', () => {
  it('puts a non-critical email on the next hourly window rather than refusing it', () => {
    const plan = planned(
      planNotification(
        requestFor('match.created', 'email', { now: new Date('2026-03-01T12:34:00.000Z') }),
        preferenceFor(),
        EVERY_CHANNEL,
      ),
    );

    expect(plan.mode).toBe('digest');
    expect(plan.deliverAt.toISOString()).toBe('2026-03-01T13:00:00.000Z');
  });

  it('puts the discovery digest on the day and hour the recipient chose', () => {
    const plan = planned(
      planNotification(
        requestFor('discovery.weekly_digest', 'email', { now: new Date('2026-03-01T12:00:00.000Z') }),
        preferenceFor({ digest: { dayOfWeek: 1, hour: 9 } }),
        EVERY_CHANNEL,
      ),
    );

    // 1 March 2026 is a Sunday, so the next Monday 09:00 is the following day.
    expect(plan.mode).toBe('digest');
    expect(plan.deliverAt.toISOString()).toBe('2026-03-02T09:00:00.000Z');
  });

  it('refuses a channel the kind never uses, which is a misroute and not a preference', () => {
    // A like email: there is nothing in a like worth an inbox.
    expect(rejected(planNotification(requestFor('like.received', 'email'), preferenceFor(), EVERY_CHANNEL)).code).toBe(
      'validation_failed',
    );
    // A banned account has no product surface, so push is unreachable for a ban.
    expect(rejected(planNotification(requestFor('account.banned', 'push'), preferenceFor(), EVERY_CHANNEL)).code).toBe(
      'validation_failed',
    );
  });

  it('leaves a like push off by default and a like in-app on', () => {
    expect(DEFAULT_CHANNEL_OPT_IN.like).toEqual(['in_app']);

    const push = succeeded(planNotification(requestFor('like.received', 'push'), preferenceFor(), EVERY_CHANNEL));
    const inApp = planned(planNotification(requestFor('like.received', 'in_app'), preferenceFor(), EVERY_CHANNEL));

    expect(push).toMatchObject({ suppressed: true, reason: 'channel_muted' });
    expect(inApp.channel).toBe('in_app');
  });

  it('delivers a like push once the recipient switches it on', () => {
    const plan = planned(
      planNotification(
        requestFor('like.received', 'push'),
        preferenceFor({ channelOptIn: { ...DEFAULT_CHANNEL_OPT_IN, like: ['in_app', 'push'] } }),
        EVERY_CHANNEL,
      ),
    );

    expect(plan).toMatchObject({ channel: 'push', mode: 'immediate' });
  });
});

describe('idempotency', () => {
  it('collapses a repeated event onto one delivery per channel', () => {
    const ledger = new InMemoryNotificationLedger();
    const request = requestFor('like.received', 'in_app');

    const first = planned(deliverNotification(request, preferenceFor(), EVERY_CHANNEL, ledger));
    const second = succeeded(deliverNotification(request, preferenceFor(), EVERY_CHANNEL, ledger));

    expect(first).toMatchObject({ channel: 'in_app', critical: false });
    expect(second).toMatchObject({ reason: 'duplicate', suppressed: true });
  });

  it('treats a fan-out across channels as distinct deliveries of one event', () => {
    const ledger = new InMemoryNotificationLedger();

    const inApp = planned(
      deliverNotification(requestFor('like.received', 'in_app'), preferenceFor(), EVERY_CHANNEL, ledger),
    );
    const push = planned(
      deliverNotification(
        requestFor('like.received', 'push'),
        preferenceFor({ channelOptIn: { ...DEFAULT_CHANNEL_OPT_IN, like: ['in_app', 'push'] } }),
        EVERY_CHANNEL,
        ledger,
      ),
    );

    expect(push.idempotencyKey).toBe('evt-1/u-alice/push');
    expect(inApp.idempotencyKey).toBe('evt-1/u-alice/in_app');
  });

  it('lets a deferred release and the immediate send it replaced share one key', () => {
    const ledger = new InMemoryNotificationLedger();
    const at = new Date('2026-03-01T22:30:00.000Z');
    const noisy = preferenceFor({
      quietHours: { enabled: true, startHour: 23, endHour: 7, timeZone: 'Europe/Berlin' },
    });

    const deferred = planned(
      deliverNotification(requestFor('match.created', 'push', { now: at }), noisy, EVERY_CHANNEL, ledger),
    );
    const retried = succeeded(
      deliverNotification(requestFor('match.created', 'push', { now: at }), noisy, EVERY_CHANNEL, ledger),
    );

    expect(deferred.mode).toBe('deferred');
    expect(retried).toMatchObject({ reason: 'duplicate' });
  });

  it('skips a channel the account does not have, even for a safety notice', () => {
    const plan = succeeded(
      planNotification(requestFor('moderation.warning_issued', 'push'), preferenceFor(), ['in_app', 'email']),
    );

    expect(plan).toMatchObject({ reason: 'channel_unavailable', suppressed: true });
  });
});
