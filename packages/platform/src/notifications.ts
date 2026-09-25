import {
  type CorrelationId,
  type DomainError,
  type Result,
  type UserId,
  domainError,
  ok,
} from '@been-there/core';
import { type NotificationId } from './ids.js';
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_KINDS,
  type NotificationContentToken,
  type NotificationCategory,
  type NotificationChannel,
  type NotificationKind,
  type NotificationKindSpec,
} from './notification-catalogue.js';

export interface QuietHours {
  readonly enabled: boolean;
  /** Local hour, 0–23, inclusive start / exclusive end, so 22–07 spans midnight. */
  readonly startHour: number;
  readonly endHour: number;
  /** IANA zone. Per-recipient, because "quiet hours" is a local fact. */
  readonly timeZone: string;
}

export const ALWAYS_ON: QuietHours = {
  enabled: false,
  startHour: 0,
  endHour: 0,
  timeZone: 'UTC',
};

/** When the weekly digest goes out. The day and hour are the user's choice. */
export interface DigestPreference {
  /** Local weekday, 0 = Sunday. */
  readonly dayOfWeek: number;
  /** Local hour, 0–23. */
  readonly hour: number;
}

export type NotificationChannelOptIn = Readonly<
  Partial<Record<NotificationCategory, readonly NotificationChannel[]>>
>;

export interface NotificationPreference {
  /**
   * The only lever the recipient holds. A category absent from this record is
   * switched off on every channel, which is why there is no second whole-category
   * switch: "never tell me about likes, on any channel" is one empty list, not a
   * second list that has to be kept in step with the first.
   */
  readonly channelOptIn: NotificationChannelOptIn;
  readonly quietHours: QuietHours;
  readonly digest: DigestPreference;
}

/**
 * What a recipient has switched on before they have touched the setting. Derived
 * from the catalogue rather than written beside it: a channel is on by default
 * when some kind in the category uses it outright, and off when the only kinds
 * that use it mark it opt-in or never. That is what makes a like push off by
 * default without a second hand-maintained list of likes' preferences.
 */
export const DEFAULT_CHANNEL_OPT_IN: NotificationChannelOptIn =
  // Unchecked cast: `Object.fromEntries` cannot prove the record covers every
  // category, and the keys are exactly the categories the catalogue uses.
  Object.fromEntries(
    Object.values(NOTIFICATION_KINDS)
      .map((spec) => spec.category)
      .filter((category, index, all) => all.indexOf(category) === index)
      .map((category) => [
        category,
        NOTIFICATION_CHANNELS.filter((channel) =>
          Object.values(NOTIFICATION_KINDS).some(
            (spec) =>
              spec.category === category &&
              (spec.channels[channel].mode === 'immediate' || spec.channels[channel].mode === 'digest'),
          ),
        ),
      ]),
  ) as NotificationChannelOptIn;

export const DEFAULT_NOTIFICATION_PREFERENCE: NotificationPreference = {
  channelOptIn: DEFAULT_CHANNEL_OPT_IN,
  quietHours: ALWAYS_ON,
  digest: { dayOfWeek: 1, hour: 9 },
};

/**
 * Categories whose notices are non-suppressible whatever the row says.
 *
 * `verification` is here because the five notices in it answer the one question
 * a user cannot answer for themselves — whether they are discoverable at all —
 * and a mute switch on that answer is a switch on their own visibility. The row
 * flag `critical` is what the per-pair delivery check reads, and it is also
 * still the mechanism for `account` and `safety`, where criticality is a
 * property of the *notice*: `account.restriction.applied` is about the
 * recipient's own standing and `report.received` is a receipt for a report they
 * filed, and the two cannot be told apart from the category alone.
 *
 * So the category rule is a floor under the row flag rather than a replacement
 * for it. Without this floor the property is only as strong as the next row
 * someone adds: `critical` is typed, but it is authored, and an authored flag
 * on a twenty-second verification row is how "a verification notice is not
 * suppressible" quietly stops being true. A category in this list is muteable
 * for no value of `critical`.
 */
export const NON_SUPPRESSIBLE_CATEGORIES: readonly NotificationCategory[] = ['verification'];

/**
 * Why nothing was sent. One reason per fact: a channel the recipient has not
 * switched on for that category is the same fact whether they muted it or never
 * had it, so it is one value rather than two that a dashboard would have to
 * reconcile.
 */
export type SuppressionReason = 'channel_muted' | 'channel_unavailable' | 'block_separation' | 'duplicate';

export interface NotificationRequest {
  readonly notificationId: NotificationId;
  readonly recipientId: UserId;
  readonly kind: NotificationKind;
  readonly channel: NotificationChannel;
  /** The event that caused this. Two sends of the same event are one send. */
  readonly sourceEventId: string;
  /**
   * Whether a block edge exists between the recipient and the other party.
   *
   * Required — as a *presence*, not a truthiness — for every pair-scoped kind:
   * `planNotification` refuses a pair notice whose caller did not state the edge.
   * A missing `blockedPair: false` and a present `blockedPair: false` are
   * different facts, and the one that is missing is the one that must not be
   * guessed. On a kind that concerns no other person it must be absent, because
   * a block edge on `verification.failed` is a caller that has lost track of
   * which kind it is planning.
   */
  readonly blockedPair?: boolean;
  readonly correlationId: CorrelationId;
  readonly now: Date;
}

/** What the plan decided to do with the notice, in delivery terms. */
export type NotificationDeliveryMode = 'immediate' | 'deferred' | 'digest';

export interface NotificationPlan {
  readonly notificationId: NotificationId;
  readonly recipientId: UserId;
  readonly kind: NotificationKind;
  readonly channel: NotificationChannel;
  readonly category: NotificationCategory;
  readonly critical: boolean;
  /**
   * The facts a body on this channel may bind — the catalogue row, carried
   * forward rather than re-derived by whoever renders it.
   *
   * An adapter holding a plan must not look the catalogue up for itself: a
   * re-derivation is a second answer to "what may this notice say", and the
   * one that reaches the bytes would be whichever copy the adapter happened to
   * read. `renderNotificationBody` takes the plan, so the set that constrains
   * the body is the set the planner read.
   */
  readonly content: readonly NotificationContentToken[];
  readonly mode: NotificationDeliveryMode;
  readonly idempotencyKey: string;
  /**
   * When the adapter may hand this over. `now` for an immediate notice, the end
   * of the recipient's quiet window for a deferred one, and the next digest
   * boundary for a digest.
   */
  readonly deliverAt: Date;
}

export interface Suppression {
  readonly notificationId: NotificationId;
  readonly recipientId: UserId;
  readonly kind: NotificationKind;
  readonly channel: NotificationChannel;
  readonly category: NotificationCategory;
  readonly reason: SuppressionReason;
  readonly suppressed: true;
}

/**
 * Idempotency key. Derived from the *event*, not from the notification, so a
 * retry of the same event — a redelivery, an at-least-once publisher, a user
 * tapping twice — collapses onto one claim. The recipient and channel are part
 * of the key because a fan-out across channels is three distinct deliveries.
 *
 * The kind is deliberately not part of it: the kind is a function of the event,
 * so including it would let one event claim the same channel twice, and a
 * deferred release and an immediate send share the key on purpose.
 */
export function idempotencyKeyFor(request: NotificationRequest): string {
  return [request.sourceEventId, request.recipientId, request.channel].join('/');
}

interface LocalClock {
  /** Local minutes since 1970, counted through the local calendar. */
  readonly serial: number;
  readonly dayOfWeek: number;
}

/**
 * The recipient's wall clock. Quiet hours, digest windows, and the deferred
 * release all need the same two facts, so they are read once, here, rather than
 * three times through three date formats.
 */
function localClock(now: Date, timeZone: string): LocalClock {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const field = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    if (part === undefined) {
      throw new Error(`Intl did not return ${type} for ${timeZone}`);
    }
    return Number.parseInt(part.value, 10);
  };
  const year = field('year');
  const month = field('month');
  const day = field('day');
  return {
    serial: Date.UTC(year, month - 1, day) / 60000 + field('hour') * 60 + field('minute'),
    dayOfWeek: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

/** The instant `deltaMinutes` of local wall-clock time after `now`. */
function atLocalMinutes(now: Date, timeZone: string, deltaMinutes: number): Date {
  let candidate = new Date(now.getTime() + deltaMinutes * 60_000);
  // The arithmetic above is wall-clock arithmetic, so a daylight-saving
  // transition between `now` and the boundary lands the candidate an hour off.
  // One correction pass converges on the real instant; the loop exists because a
  // transition can move the boundary the correction itself lands on.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const drift = localClock(now, timeZone).serial + deltaMinutes - localClock(candidate, timeZone).serial;
    if (drift === 0) {
      return candidate;
    }
    candidate = new Date(candidate.getTime() + drift * 60_000);
  }
  return candidate;
}

/** True when `now` falls in the recipient's quiet window, midnight-spanning. */
export function isWithinQuietHours(quietHours: QuietHours, now: Date): boolean {
  if (!quietHours.enabled) {
    return false;
  }
  const minuteOfDay = ((localClock(now, quietHours.timeZone).serial % 1440) + 1440) % 1440;
  return quietHours.startHour <= quietHours.endHour
    ? minuteOfDay >= quietHours.startHour * 60 && minuteOfDay < quietHours.endHour * 60
    : minuteOfDay >= quietHours.startHour * 60 || minuteOfDay < quietHours.endHour * 60;
}

/** The instant the recipient's quiet window closes. */
function endOfQuietHours(quietHours: QuietHours, now: Date): Date {
  const clock = localClock(now, quietHours.timeZone);
  const minuteOfDay = ((clock.serial % 1440) + 1440) % 1440;
  return atLocalMinutes(now, quietHours.timeZone, (quietHours.endHour * 60 - minuteOfDay + 1440) % 1440);
}

function nextDigestBoundary(
  cadence: 'hourly' | 'weekly',
  digest: DigestPreference,
  timeZone: string,
  now: Date,
): Date {
  const clock = localClock(now, timeZone);
  const minuteOfDay = ((clock.serial % 1440) + 1440) % 1440;
  if (cadence === 'hourly') {
    return atLocalMinutes(now, timeZone, (60 - (minuteOfDay % 60)) % 60 || 60);
  }
  let dayOffset = (digest.dayOfWeek - clock.dayOfWeek + 7) % 7;
  if (dayOffset === 0 && digest.hour * 60 <= minuteOfDay) {
    dayOffset = 7;
  }
  return atLocalMinutes(now, timeZone, dayOffset * 1440 + digest.hour * 60 - minuteOfDay);
}

function plannedDelivery(
  spec: NotificationKindSpec,
  critical: boolean,
  channel: NotificationChannel,
  preference: NotificationPreference,
  now: Date,
): { readonly mode: NotificationDeliveryMode; readonly deliverAt: Date } {
  if (spec.channels[channel].mode === 'digest') {
    return {
      mode: 'digest',
      deliverAt: nextDigestBoundary(
        spec.digest?.cadence ?? 'hourly',
        preference.digest,
        preference.quietHours.timeZone,
        now,
      ),
    };
  }
  // Non-critical push and email are held, not dropped. The in-app entry is the
  // durable record and is never deferred; a delayed safety notice would be
  // indistinguishable from no notice, and a critical one is never deferred at all.
  if (!critical && channel !== 'in_app' && isWithinQuietHours(preference.quietHours, now)) {
    return { mode: 'deferred', deliverAt: endOfQuietHours(preference.quietHours, now) };
  }
  return { mode: 'immediate', deliverAt: now };
}

/**
 * Decides delivery for one notification on one channel.
 *
 * In order: that the kind exists, that it uses this channel at all, whether a
 * block edge exists between the two people, whether the account has the channel,
 * and whether the recipient has it switched on. A critical notice is decided by
 * the first three alone, which is the point — no preference, and no setting, can
 * stand between a user and a notice about their own safety or standing.
 *
 * "Critical" is the row's own flag *or* membership of
 * `NON_SUPPRESSIBLE_CATEGORIES`, resolved once and carried on the plan, so the
 * mute check, the quiet-hours check and the renderer all read one answer.
 */
export function planNotification(
  request: NotificationRequest,
  preference: NotificationPreference,
  availableChannels: readonly NotificationChannel[],
): Result<NotificationPlan | Suppression, DomainError> {
  if (!Object.hasOwn(NOTIFICATION_KINDS, request.kind)) {
    return domainError('validation_failed', 'platform', 'unknown notification kind', {
      kind: request.kind,
    });
  }
  const spec: NotificationKindSpec = NOTIFICATION_KINDS[request.kind];
  // Resolved once and read three times: the opt-in check, the quiet-hours
  // check, and the plan the adapter renders from. A verification notice that
  // ignores a mute switch but is still deferred by quiet hours is a notice
  // that is non-suppressible in name only.
  const critical = spec.critical || NON_SUPPRESSIBLE_CATEGORIES.includes(spec.category);

  if (spec.channels[request.channel].mode === 'off') {
    return domainError('validation_failed', 'platform', 'channel is not used for this kind', {
      kind: request.kind,
      channel: request.channel,
    });
  }

  const suppressed = (reason: SuppressionReason): Suppression => ({
    notificationId: request.notificationId,
    recipientId: request.recipientId,
    kind: request.kind,
    channel: request.channel,
    category: spec.category,
    reason,
    suppressed: true,
  });

  if (spec.pairScoped) {
    if (!Object.hasOwn(request, 'blockedPair')) {
      return domainError(
        'validation_failed',
        'platform',
        'a pair-scoped notification must state whether a block edge exists',
        { kind: request.kind },
      );
    }
    if (request.blockedPair === true) {
      // No notification generated by a blocked pair reaches either side, and no
      // criticality overrides it: telling a blocked person that the other side
      // is still active is a safety disclosure, and telling the blocker that the
      // other side still receives notices invites the abuse that caused the block.
      return ok(suppressed('block_separation'));
    }
  } else if (request.blockedPair !== undefined) {
    return domainError('validation_failed', 'platform', 'this kind is not about another person', {
      kind: request.kind,
    });
  }

  if (!availableChannels.includes(request.channel)) {
    return ok(suppressed('channel_unavailable'));
  }

  if (!critical) {
    const optedIn = preference.channelOptIn[spec.category] ?? [];
    if (!optedIn.includes(request.channel)) {
      return ok(suppressed('channel_muted'));
    }
  }

  const { mode, deliverAt } = plannedDelivery(spec, critical, request.channel, preference, request.now);

  return ok({
    notificationId: request.notificationId,
    recipientId: request.recipientId,
    kind: request.kind,
    channel: request.channel,
    category: spec.category,
    critical,
    content: spec.channels[request.channel].content,
    mode,
    idempotencyKey: idempotencyKeyFor(request),
    deliverAt,
  });
}

/**
 * The delivery ledger. A claim is a one-way door: the same key can be won once
 * and never again, so an at-least-once publisher produces at-most-once
 * notification. In production this is the push provider's own idempotency key
 * plus a unique index on the notification table — the interface is the same
 * shape either way.
 */
export interface NotificationLedger {
  claim(idempotencyKey: string): boolean;
}

export class InMemoryNotificationLedger implements NotificationLedger {
  #claimed = new Set<string>();

  claim(idempotencyKey: string): boolean {
    if (this.#claimed.has(idempotencyKey)) {
      return false;
    }
    this.#claimed.add(idempotencyKey);
    return true;
  }
}

/**
 * `planNotification` and the ledger together: the second attempt on a key that
 * has already been won is a duplicate, whether it came from a retry or from a
 * user tapping twice. A deferred release claims the same key as the immediate
 * send it replaced, so the two paths cannot both deliver.
 */
export function deliverNotification(
  request: NotificationRequest,
  preference: NotificationPreference,
  availableChannels: readonly NotificationChannel[],
  ledger: NotificationLedger,
): Result<NotificationPlan | Suppression, DomainError> {
  const planned = planNotification(request, preference, availableChannels);
  if (!planned.ok) {
    return planned;
  }
  if ('suppressed' in planned.value) {
    return planned;
  }
  if (!ledger.claim(planned.value.idempotencyKey)) {
    return ok({
      notificationId: request.notificationId,
      recipientId: request.recipientId,
      kind: request.kind,
      channel: request.channel,
      category: planned.value.category,
      reason: 'duplicate',
      suppressed: true,
    });
  }
  return planned;
}
