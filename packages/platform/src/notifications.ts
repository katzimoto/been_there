import {
  type CorrelationId,
  type DomainError,
  type Result,
  type UserId,
  domainError,
  ok,
} from '@been-there/core';
import { type NotificationId } from './ids.js';

export type NotificationChannel = 'in_app' | 'email' | 'push' | 'sms';

export type NotificationCategory =
  | 'safety'
  | 'account'
  | 'like'
  | 'match'
  | 'message'
  | 'marketing'
  | 'system';

/**
 * Categories a user may not switch off.
 *
 * This is the one place where "the user is the customer" and "the user might be
 * in danger" disagree, and safety wins. A quiet-hours setting that could silence
 * "someone reported your photo" is a safety control operated by the person it
 * protects. Everything else — likes, matches, marketing — is preference, and a
 * user who never wants to hear about a like again should be able to say so.
 */
export const NON_SUPPRESSIBLE_CATEGORIES: readonly NotificationCategory[] = ['safety', 'account'];

export const CATEGORY_CHANNELS: Readonly<Record<NotificationCategory, readonly NotificationChannel[]>> = {
  // A safety notice must reach the user even if push is broken, so it fans out
  // across every channel the account has.
  safety: ['in_app', 'push', 'email', 'sms'],
  account: ['in_app', 'email', 'push'],
  like: ['in_app', 'push'],
  match: ['in_app', 'push', 'email'],
  message: ['in_app', 'push'],
  marketing: ['email'],
  system: ['in_app', 'email'],
};

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

export interface NotificationPreference {
  readonly disabledCategories: readonly NotificationCategory[];
  readonly mutedChannels: readonly NotificationChannel[];
  readonly quietHours: QuietHours;
}

export type SuppressionReason =
  | 'user_preference'
  | 'quiet_hours'
  | 'channel_muted'
  | 'channel_unavailable'
  | 'duplicate';

export interface NotificationRequest {
  readonly notificationId: NotificationId;
  readonly recipientId: UserId;
  readonly category: NotificationCategory;
  readonly channel: NotificationChannel;
  /** The event that caused this. Two sends of the same event are one send. */
  readonly sourceEventId: string;
  readonly correlationId: CorrelationId;
  readonly now: Date;
}

export interface NotificationPlan {
  readonly notificationId: NotificationId;
  readonly recipientId: UserId;
  readonly channel: NotificationChannel;
  readonly category: NotificationCategory;
  readonly critical: boolean;
  readonly idempotencyKey: string;
  readonly deliverAt: Date;
}

export interface Suppression {
  readonly notificationId: NotificationId;
  readonly recipientId: UserId;
  readonly reason: SuppressionReason;
  readonly suppressed: true;
}

/**
 * Idempotency key. Derived from the *event*, not from the notification, so a
 * retry of the same event — a redelivery, an at-least-once publisher, a user
 * tapping twice — collapses onto one claim. The recipient and channel are part
 * of the key because a fan-out across channels is four distinct deliveries.
 */
export function idempotencyKeyFor(request: NotificationRequest): string {
  return [request.sourceEventId, request.recipientId, request.channel].join('/');
}

function localHour(now: Date, timeZone: string): number {
  const formatted = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    hour12: false,
  }).format(now);
  return Number.parseInt(formatted, 10) % 24;
}

/** True when `now` falls in the recipient's quiet window, midnight-spanning. */
export function isWithinQuietHours(quietHours: QuietHours, now: Date): boolean {
  if (!quietHours.enabled) {
    return false;
  }
  const hour = localHour(now, quietHours.timeZone);
  return quietHours.startHour <= quietHours.endHour
    ? hour >= quietHours.startHour && hour < quietHours.endHour
    : hour >= quietHours.startHour || hour < quietHours.endHour;
}

/**
 * Decides delivery. Preference and quiet hours are honoured for everything
 * except `safety` and `account`, and a channel the account does not have
 * available is skipped rather than silently retried forever.
 */
export function planNotification(
  request: NotificationRequest,
  preference: NotificationPreference,
  availableChannels: readonly NotificationChannel[],
): Result<NotificationPlan | Suppression, DomainError> {
  if (!CATEGORY_CHANNELS[request.category].includes(request.channel)) {
    return domainError('validation_failed', 'platform', 'channel is not used for this category', {
      category: request.category,
      channel: request.channel,
    });
  }

  const critical = NON_SUPPRESSIBLE_CATEGORIES.includes(request.category);

  if (!availableChannels.includes(request.channel)) {
    return ok({
      notificationId: request.notificationId,
      recipientId: request.recipientId,
      reason: 'channel_unavailable',
      suppressed: true,
    });
  }

  if (!critical) {
    if (preference.disabledCategories.includes(request.category)) {
      return ok({
        notificationId: request.notificationId,
        recipientId: request.recipientId,
        reason: 'user_preference',
        suppressed: true,
      });
    }
    if (preference.mutedChannels.includes(request.channel)) {
      return ok({
        notificationId: request.notificationId,
        recipientId: request.recipientId,
        reason: 'channel_muted',
        suppressed: true,
      });
    }
    if (isWithinQuietHours(preference.quietHours, request.now)) {
      return ok({
        notificationId: request.notificationId,
        recipientId: request.recipientId,
        reason: 'quiet_hours',
        suppressed: true,
      });
    }
  }

  return ok({
    notificationId: request.notificationId,
    recipientId: request.recipientId,
    channel: request.channel,
    category: request.category,
    critical,
    idempotencyKey: idempotencyKeyFor(request),
    deliverAt: request.now,
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
 * user tapping twice.
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
      reason: 'duplicate',
      suppressed: true,
    });
  }
  return planned;
}
