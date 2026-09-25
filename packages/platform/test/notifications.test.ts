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
  NOTIFICATION_CONTENT_TOKENS,
  NON_SUPPRESSIBLE_CATEGORIES,
  deliverNotification,
  isWithinQuietHours,
  planNotification,
  type NotificationCategory,
  type NotificationChannel,
  type NotificationId,
  type NotificationKind,
  type NotificationKindSpec,
  type NotificationPlan,
  renderNotificationBody,
  type NotificationFacts,
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

/**
 * Every channel every kind uses, switched on, with quiet hours off. The render
 * tests are about what a body may say, and a preference that mutes a channel
 * would hide the pairs they need to reach.
 */
const EVERYTHING_ON: NotificationPreference = {
  ...DEFAULT_NOTIFICATION_PREFERENCE,
  channelOptIn: { ...DEFAULT_CHANNEL_OPT_IN, like: [...EVERY_CHANNEL] },
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

/**
 * Adds a catalogue row for the duration of one test and removes it again.
 *
 * The properties below are about what a *twenty-second* row would do, and a
 * test that only reads the twenty-one rows in the table cannot say: a rule
 * keyed off a list the test wrote out is only as strong as that list. The
 * catalogue is a plain object, so a row can be added to it, planned through
 * the public entry point, and taken away before the next test sees it.
 */
function withKind<T>(
  kind: string,
  spec: NotificationKindSpec,
  body: (kind: NotificationKind) => T,
): T {
  Object.defineProperty(NOTIFICATION_KINDS, kind, { value: spec, configurable: true, writable: true });
  try {
    // Unchecked cast: the row was just written into the catalogue, so at runtime
    // it is a `NotificationKind`. The union is a compile-time list of names, and
    // naming one it does not contain yet is the point of the seam.
    return body(kind as NotificationKind);
  } finally {
    delete (NOTIFICATION_KINDS as Record<string, unknown>)[kind];
  }
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

  it('lets a channel say less than the in-app record and never more, on every kind that has one', () => {
    // "Shortening for a locked screen may remove detail, never add it." Where a
    // kind has an in-app record at all, that record is the reference and every
    // other channel is a subset of it — a diff, not a review.
    //
    // The invariant is **conditional**, and the condition is the point. Four
    // kinds have no in-app surface, so for those there is nothing to be a
    // subset of and the loop below does not reach them. They are named rather
    // than tolerated, and the next test says what shape an exception has to
    // have, because a conditional invariant read as a universal one is how the
    // next person reintroduces the bug.
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

  it('lets a kind have no in-app record only where one of the two stated reasons applies', () => {
    // Both reasons are structural, so neither needs a human to remember it:
    //
    //   1. the durable record already exists under another kind in the same
    //      category — a second in-app entry per digest window would say the
    //      same thing twice; or
    //   2. the user cannot reach the app at all, which is a critical notice
    //      whose delivery guarantee is an immediate email and nothing else.
    //
    // A twenty-second kind that is `off` for in-app for any other reason fails
    // here, which is what stops the exception list from becoming a dumping
    // ground for a row nobody wanted to think about.
    for (const kind of EVERY_KIND) {
      const spec: NotificationKindSpec = NOTIFICATION_KINDS[kind];
      if (spec.channels.in_app.mode !== 'off') {
        continue;
      }
      const recordedElsewhere = EVERY_KIND.some(
        (other) =>
          other !== kind &&
          NOTIFICATION_KINDS[other].category === spec.category &&
          NOTIFICATION_KINDS[other].channels.in_app.mode !== 'off',
      );
      const unreachableByDesign =
        spec.critical &&
        spec.channels.email.mode === 'immediate' &&
        spec.channels.push.mode === 'off';

      expect(recordedElsewhere || unreachableByDesign, kind).toBe(true);
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
  it('delivers exactly the non-suppressible pairs and mutes exactly the rest, with every lever pulled', () => {
    // No threshold and no hand-written list: every usable pair in the catalogue
    // is planned, and the two outcomes must partition it exactly. A count with
    // slack in it is not a floor — it is a number that is allowed to shrink
    // until someone notices, and the per-pair assertions only ever reach the
    // rows the loop chose to skip.
    const delivered: string[] = [];
    const muted: string[] = [];

    for (const kind of EVERY_KIND) {
      for (const channel of EVERY_CHANNEL) {
        if (NOTIFICATION_KINDS[kind].channels[channel].mode === 'off') {
          continue;
        }
        const pair = `${kind}/${channel}`;
        const outcome = succeeded(
          planNotification(requestFor(kind, channel), NOISE_PREFERENCE, EVERY_CHANNEL),
        );
        if ('suppressed' in outcome) {
          muted.push(pair);
          expect(outcome, pair).toMatchObject({ reason: 'channel_muted' });
        } else {
          delivered.push(pair);
          expect(outcome.critical, pair).toBe(true);
          expect(outcome.mode, pair).toBe('immediate');
        }
      }
    }

    // Re-derived from the catalogue, independently of the loop: a kind is
    // non-suppressible when its own row says so, or when its category is
    // non-suppressible whatever the row says.
    const usablePairs = (kind: NotificationKind): string[] =>
      EVERY_CHANNEL.filter((channel) => NOTIFICATION_KINDS[kind].channels[channel].mode !== 'off').map(
        (channel) => `${kind}/${channel}`,
      );
    const nonSuppressible = EVERY_KIND.filter(
      (kind) =>
        NOTIFICATION_KINDS[kind].critical ||
        NON_SUPPRESSIBLE_CATEGORIES.includes(NOTIFICATION_KINDS[kind].category),
    );

    expect(delivered.sort()).toEqual(nonSuppressible.flatMap(usablePairs).sort());
    expect(muted.sort()).toEqual(
      EVERY_KIND.filter((kind) => !nonSuppressible.includes(kind)).flatMap(usablePairs).sort(),
    );
  });

  it('delivers every kind in the verification category, whichever way its own row is written', () => {
    // Derived, never written out. The five notices in this category answer the
    // one question a user cannot answer for themselves — whether they are
    // discoverable at all — so a mute switch on them is a switch on the user's
    // own visibility. A twenty-second verification row is covered by this loop
    // on the day it is added, which a list written out here could not be.
    const verificationKinds = EVERY_KIND.filter(
      (kind) => NOTIFICATION_KINDS[kind].category === 'verification',
    );
    expect(verificationKinds.length).toBeGreaterThan(3);

    for (const kind of verificationKinds) {
      for (const channel of EVERY_CHANNEL) {
        if (NOTIFICATION_KINDS[kind].channels[channel].mode === 'off') {
          continue;
        }
        const plan = planned(
          planNotification(requestFor(kind, channel), NOISE_PREFERENCE, EVERY_CHANNEL),
        );
        expect(plan.critical, `${kind}/${channel}`).toBe(true);
        expect(plan.mode, `${kind}/${channel}`).toBe('immediate');
      }
    }
  });

  it('keeps a verification row that does not claim criticality out of reach of the mute switch', () => {
    // The row flag is authored and the category rule is not, so the floor has
    // to be the one that holds. This is the twenty-second kind: added, planned
    // through the public entry point with every channel switched off, and the
    // answer has to be delivery.
    withKind(
      'verification.locked',
      {
        category: 'verification',
        critical: false,
        pairScoped: false,
        channels: {
          in_app: { mode: 'immediate', content: [] },
          email: { mode: 'immediate', content: [] },
          push: { mode: 'immediate', content: [] },
        },
      },
      (locked) => {
        for (const channel of EVERY_CHANNEL) {
          const plan = planned(
            planNotification(requestFor(locked, channel), NOISE_PREFERENCE, EVERY_CHANNEL),
          );
          expect(plan.critical, channel).toBe(true);
          expect(plan.mode, channel).toBe('immediate');
        }
      },
    );
  });
});

describe('a body is assembled from the catalogue and from nothing else', () => {
  const matchPlan = (): NotificationPlan =>
    planned(
      planNotification(requestFor('match.created', 'in_app'), EVERYTHING_ON, EVERY_CHANNEL),
    );

  it('carries the catalogue set on the plan, so an adapter cannot re-derive it', () => {
    // The plan is what an adapter holds. If the bindable set had to be looked
    // up again at render time, the set that reached the bytes would be
    // whichever copy of the catalogue the adapter happened to read.
    expect(matchPlan().content).toEqual(NOTIFICATION_KINDS['match.created'].channels.in_app.content);
  });

  it('renders a declared fact and nothing else', () => {
    const body = succeeded(
      renderNotificationBody(
        matchPlan(),
        'You matched with {{counterparty_first_name}}.',
        { counterparty_first_name: 'Sam' },
      ),
    );

    expect(body.text).toBe('You matched with Sam.');
    expect(body.facts).toEqual(['counterparty_first_name']);
  });

  it('refuses a slot that is not a fact anyone may bind, so a body cannot render a message', () => {
    // The whole guarantee. `message_body` is not a member of the token union,
    // so there is no value that could fill the slot and no key the caller could
    // spell to get one — the template comes back as a refusal rather than as a
    // body with a literal `{{message_body}}` in it.
    const error = rejected(
      renderNotificationBody(matchPlan(), 'Sam said {{message_body}}', {
        counterparty_first_name: 'Sam',
      }),
    );

    expect(error.code).toBe('validation_failed');
    expect(error.message).toContain('message_body');
    expect(error.details).toEqual({
      kind: 'match.created',
      channel: 'in_app',
      slot: 'message_body',
    });
  });

  it('refuses a real fact this channel does not declare', () => {
    // `account.restriction.applied` on email binds the case reference; the
    // deletion receipt's retention date belongs to a different notice and has
    // no business in this one.
    const plan = planned(
      planNotification(requestFor('account.restriction.applied', 'email'), EVERYTHING_ON, EVERY_CHANNEL),
    );
    const error = rejected(
      renderNotificationBody(plan, 'Restricted on {{event_date}} until {{retained_until}}.', {
        own_capability_list: 'send_message',
        case_reference: 'case-1',
        event_date: '2026-03-01',
        appeal_route: '/appeals',
      }),
    );

    expect(error.code).toBe('validation_failed');
    expect(error.details).toMatchObject({ slot: 'retained_until' });
  });

  it('refuses a fact the catalogue declares and the body never binds', () => {
    const error = rejected(renderNotificationBody(matchPlan(), 'You have a new match.', {}));

    expect(error.code).toBe('validation_failed');
    expect(error.message).toContain('counterparty_first_name');
  });

  it('refuses a value for a fact this notification does not declare', () => {
    const error = rejected(
      renderNotificationBody(matchPlan(), 'You matched with {{counterparty_first_name}}.', {
        counterparty_first_name: 'Sam',
        case_reference: 'case-1',
      }),
    );

    expect(error.code).toBe('validation_failed');
    expect(error.details).toMatchObject({ token: 'case_reference' });
  });

  it('binds every declared fact on every channel a kind uses, and leaves no slot behind', () => {
    for (const kind of EVERY_KIND) {
      for (const channel of EVERY_CHANNEL) {
        if (NOTIFICATION_KINDS[kind].channels[channel].mode === 'off') {
          continue;
        }
        const plan = planned(
          planNotification(requestFor(kind, channel), EVERYTHING_ON, EVERY_CHANNEL),
        );
        // Unchecked cast: `fromEntries` cannot prove the keys are tokens, and
        // they are the plan's own `content` list, which is tokens by type.
        const facts = Object.fromEntries(plan.content.map((token) => [token, 'x'])) as NotificationFacts;
        const body = succeeded(
          renderNotificationBody(plan, plan.content.map((token) => `{{${token}}}`).join(' '), facts),
        );

        expect(body.facts, `${kind}/${channel}`).toEqual(plan.content);
        expect(body.text, `${kind}/${channel}`).not.toContain('{{');
      }
    }
  });

  it('binds every token in the vocabulary somewhere, so the union is not padded', () => {
    const bound = new Set(
      EVERY_KIND.flatMap((kind) =>
        [...NOTIFICATION_KINDS[kind].channels.in_app.content, ...NOTIFICATION_KINDS[kind].channels.email.content, ...NOTIFICATION_KINDS[kind].channels.push.content],
      ),
    );

    expect([...NOTIFICATION_CONTENT_TOKENS].filter((token) => !bound.has(token))).toEqual([]);
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
