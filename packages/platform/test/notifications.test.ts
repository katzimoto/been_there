import { describe, expect, it } from 'vitest';
import { castId, type UserId } from '@been-there/core';
import {
  InMemoryNotificationLedger,
  deliverNotification,
  isWithinQuietHours,
  planNotification,
  type NotificationChannel,
  type NotificationId,
  type NotificationPlan,
  type NotificationPreference,
  type NotificationRequest,
} from '../src/index.js';
import { rejected, succeeded } from './helpers.js';

const ALICE = castId<'UserId'>('u-alice') as UserId;
const ALL_CHANNELS: readonly NotificationChannel[] = ['in_app', 'email', 'push', 'sms'];

function notificationId(seed: string): NotificationId {
  return castId<'NotificationId'>(seed);
}

function requestFor(
  overrides: Partial<NotificationRequest> & { readonly category: NotificationRequest['category']; readonly channel: NotificationChannel },
): NotificationRequest {
  return {
    notificationId: notificationId('n-1'),
    recipientId: ALICE,
    sourceEventId: 'evt-match-1',
    correlationId: castId<'CorrelationId'>('corr-1'),
    now: new Date('2026-03-01T12:00:00.000Z'),
    ...overrides,
  };
}

/** Narrows a plan to the delivery branch, failing loudly on a suppression. */
function planned(result: ReturnType<typeof planNotification>): NotificationPlan {
  const value = succeeded(result);
  if ('suppressed' in value) {
    throw new Error(`expected delivery, got ${value.reason}`);
  }
  return value;
}

function preferenceFor(overrides: Partial<NotificationPreference> = {}): NotificationPreference {
  return {
    disabledCategories: [],
    mutedChannels: [],
    quietHours: { enabled: false, startHour: 23, endHour: 7, timeZone: 'UTC' },
    ...overrides,
  };
}

describe('suppressibility', () => {
  it('refuses a user preference that would silence a safety notification', () => {
    // Every suppression lever the user controls is pulled at once.
    const preference = preferenceFor({
      disabledCategories: ['safety', 'account'],
      mutedChannels: [...ALL_CHANNELS],
      quietHours: { enabled: true, startHour: 0, endHour: 24, timeZone: 'UTC' },
    });

    for (const channel of ALL_CHANNELS) {
      const plan = planned(planNotification(requestFor({ category: 'safety', channel }), preference, ALL_CHANNELS));
      expect(plan.critical, channel).toBe(true);
      expect(plan.channel, channel).toBe(channel);
    }
  });

  it('honours a preference against a like', () => {
    const plan = succeeded(
      planNotification(
        requestFor({ category: 'like', channel: 'push' }),
        preferenceFor({ disabledCategories: ['like'] }),
        ALL_CHANNELS,
      ),
    );

    expect(plan).toEqual({
      notificationId: notificationId('n-1'),
      recipientId: ALICE,
      reason: 'user_preference',
      suppressed: true,
    });
  });

  it('honours a muted channel against a match', () => {
    const plan = succeeded(
      planNotification(
        requestFor({ category: 'match', channel: 'email' }),
        preferenceFor({ mutedChannels: ['email'] }),
        ALL_CHANNELS,
      ),
    );

    expect(plan).toMatchObject({ reason: 'channel_muted', suppressed: true });
  });

  it('refuses a channel the category does not use', () => {
    // A marketing push is a misrouted request, not a preference: it should not
    // be recorded as suppressed, because nothing was ever going to be sent.
    const result = planNotification(
      requestFor({ category: 'marketing', channel: 'push' }),
      preferenceFor(),
      ALL_CHANNELS,
    );

    expect(rejected(result).code).toBe('validation_failed');
  });
});

describe('quiet hours are per recipient and per timezone', () => {
  it('suppresses a match inside the recipient local night', () => {
    // 22:30 UTC is 23:30 in Berlin, which is inside a 23:00–07:00 window.
    const at = new Date('2026-03-01T22:30:00.000Z');
    const berlin = preferenceFor({
      quietHours: { enabled: true, startHour: 23, endHour: 7, timeZone: 'Europe/Berlin' },
    });

    const plan = succeeded(
      planNotification(requestFor({ category: 'match', channel: 'push', now: at }), berlin, ALL_CHANNELS),
    );

    expect(plan).toMatchObject({ reason: 'quiet_hours', suppressed: true });
  });

  it('delivers the same instant for a recipient whose local evening has not started', () => {
    const at = new Date('2026-03-01T22:30:00.000Z');
    const utc = preferenceFor({
      quietHours: { enabled: true, startHour: 23, endHour: 7, timeZone: 'UTC' },
    });

    const plan = planned(planNotification(requestFor({ category: 'match', channel: 'push', now: at }), utc, ALL_CHANNELS));

    expect(plan).toMatchObject({ deliverAt: at, critical: false });
  });

  it('treats a window that spans midnight as one window', () => {
    const window = { enabled: true, startHour: 22, endHour: 6, timeZone: 'UTC' } as const;

    expect(isWithinQuietHours(window, new Date('2026-03-01T23:30:00.000Z'))).toBe(true);
    expect(isWithinQuietHours(window, new Date('2026-03-01T02:00:00.000Z'))).toBe(true);
    expect(isWithinQuietHours(window, new Date('2026-03-01T12:00:00.000Z'))).toBe(false);
    // A daytime window is inclusive-start, exclusive-end.
    expect(
      isWithinQuietHours({ enabled: true, startHour: 9, endHour: 17, timeZone: 'UTC' }, new Date('2026-03-01T09:00:00.000Z')),
    ).toBe(true);
    expect(
      isWithinQuietHours({ enabled: true, startHour: 9, endHour: 17, timeZone: 'UTC' }, new Date('2026-03-01T17:00:00.000Z')),
    ).toBe(false);
  });
});

describe('idempotency', () => {
  it('collapses a repeated event onto one delivery per channel', () => {
    const ledger = new InMemoryNotificationLedger();
    const request = requestFor({ category: 'like', channel: 'push' });
    const preference = preferenceFor();

    const first = planned(deliverNotification(request, preference, ALL_CHANNELS, ledger));
    const second = succeeded(deliverNotification(request, preference, ALL_CHANNELS, ledger));

    expect(first).toMatchObject({ channel: 'push', critical: false });
    expect(second).toMatchObject({ reason: 'duplicate', suppressed: true });
  });

  it('treats a fan-out across channels as distinct deliveries of one event', () => {
    const ledger = new InMemoryNotificationLedger();
    const preference = preferenceFor();

    const push = planned(
      deliverNotification(requestFor({ category: 'like', channel: 'push' }), preference, ALL_CHANNELS, ledger),
    );
    const inApp = planned(
      deliverNotification(requestFor({ category: 'like', channel: 'in_app' }), preference, ALL_CHANNELS, ledger),
    );

    expect(push.idempotencyKey).not.toBe(inApp.idempotencyKey);
    expect(push.idempotencyKey).toContain('evt-match-1');
  });

  it('lets a different event through after a duplicate was refused', () => {
    const ledger = new InMemoryNotificationLedger();
    const preference = preferenceFor();
    const now = new Date('2026-03-01T12:00:00.000Z');

    planned(deliverNotification(requestFor({ category: 'like', channel: 'push', now }), preference, ALL_CHANNELS, ledger));
    const next = planned(
      deliverNotification(
        requestFor({ category: 'like', channel: 'push', sourceEventId: 'evt-match-2', now }),
        preference,
        ALL_CHANNELS,
        ledger,
      ),
    );

    expect(next).toMatchObject({ channel: 'push' });
  });

  it('skips a channel the account does not have, even for a safety notice', () => {
    // The notice still goes out on the channels the account does have; the
    // missing one is recorded rather than retried forever.
    const plan = succeeded(
      planNotification(
        requestFor({ category: 'safety', channel: 'sms' }),
        preferenceFor(),
        ['in_app', 'email', 'push'],
      ),
    );

    expect(plan).toMatchObject({ reason: 'channel_unavailable', suppressed: true });
  });
});
