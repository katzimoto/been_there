import { randomUUID } from 'node:crypto';
import { StoreError } from '@been-there/contracts';
import type { Stores, Transaction } from '@been-there/contracts';
import { type UserId, castId } from '@been-there/core';
import {
  type AccountSecurityKind,
  type NotificationFacts,
  ACCOUNT_SECURITY_COPY,
  DEFAULT_NOTIFICATION_PREFERENCE,
  type NotificationChannel,
  type NotificationKind,
  deliverNotification,
  renderNotificationBody,
} from '@been-there/platform';

/**
 * The notice ledger, and the one rule it exists to make structural.
 *
 * §7.2's invariant is that **the account owner learns that recovery was used
 * against them exactly once** — after it succeeded or after the abuse threshold
 * was crossed, never on a per-attempt basis, and never in a form that confirms
 * anything to the attacker. "Never per attempt" is the part that is easy to state
 * and hard to keep, because the caller of a notify function is a request handler
 * and a request handler runs once per attempt.
 *
 * So the guarantee is not "remember not to notify twice". It is a unique index on
 * `account_notices.idempotency_key`: the key is derived from the *fact* — the
 * recovery id, the abuse window — rather than from the attempt, so two attempts
 * against the same recovery produce the same key, the second insert collides, and
 * the notice is recorded as suppressed. A handler that notifies on every attempt
 * therefore still notifies once, because the second attempt cannot get a key of
 * its own.
 *
 * `insertNotice` raises a `StoreError` on the collision rather than returning a
 * boolean, so the handler catches it and reports "already claimed". That is the
 * one place a storage error is treated as an answer, and it is safe here because
 * the unique index is the only thing that can produce this particular error at
 * this point in the request: the insert is a single row into a table whose other
 * columns are all values this function just wrote.
 */

/** What the caller asks for. Everything else is derived. */
export interface SecurityNotice {
  readonly userId: UserId;
  readonly kind: AccountSecurityKind;
  /**
   * The fact that caused this. Two sends of the same fact are one send — this is
   * what makes a burst collapse. A recovery id is the right value here and an
   * attempt counter is the wrong one.
   */
  readonly sourceFactId: string;
  readonly correlationId: string;
  readonly facts: NotificationFacts;
  /** The verified channel to deliver on. Never a channel the account lacks. */
  readonly channel: NotificationChannel;
}

export interface NoticeDelivery {
  /** The address or number the message went to. Already normalised. */
  readonly address: string;
  readonly subject: string;
  readonly body: string;
  readonly secret: string;
}

export interface NoticeSender {
  /**
   * Hands the rendered message to the relay. Separate from this module because
   * the service does not know which SMTP host or SMS gateway is in play.
   *
   * The channel here is the *relay's*, not the notification channel: the
   * planner's `in_app` for a phone account still travels over SMS, and the two
   * vocabularies answer different questions.
   */
  send(userId: UserId, relayChannel: 'email' | 'sms', message: NoticeDelivery): Promise<void>;
}

/** The address the notice goes to, and the channel it travels on. */
export interface NoticeTarget {
  readonly address: string;
  readonly relayChannel: 'email' | 'sms';
}

/**
 * The channel an account's verified contact delivers on.
 *
 * `phone` maps to `sms` for the relay and to `in_app` for the notification
 * planner, because the catalogue has no `sms` channel by design — a phone number
 * is personal data the account does not put in a notification payload. The two
 * answers are different questions and are kept apart rather than forced into one
 * enum.
 */
export function noticeChannelsFor(relayChannel: 'email' | 'sms'): readonly NotificationChannel[] {
  return relayChannel === 'email' ? ['email'] : ['in_app'];
}

/**
 * Claims and delivers one security notice.
 *
 * Returns `false` when the notice was already claimed, which is the *expected*
 * outcome for a repeated fact rather than an error: it is how "the owner learns
 * once" reports itself to the caller that asked.
 */
export async function notifyOwner(
  stores: Stores,
  tx: Transaction,
  sender: NoticeSender,
  notice: SecurityNotice,
  target: NoticeTarget,
  now: Date,
): Promise<boolean> {
  const correlationId = castId<'CorrelationId'>(notice.correlationId);
  const planned = deliverNotification(
    {
      notificationId: castId<'NotificationId'>(randomUUID()),
      recipientId: notice.userId,
      kind: notice.kind as NotificationKind,
      channel: notice.channel,
      sourceEventId: notice.sourceFactId,
      correlationId,
      now,
    },
    DEFAULT_NOTIFICATION_PREFERENCE,
    noticeChannelsFor(target.relayChannel),
    // The durable ledger is the database's unique index, not this object: an
    // in-memory set would forget on restart and would be per-process, so two
    // instances would each deliver the notice the other had already sent.
    { claim: () => true },
  );
  if (!planned.ok) {
    throw new Error(`planning ${notice.kind} was refused: ${planned.error.message}`);
  }
  if ('suppressed' in planned.value) {
    // Muted, unavailable, or blocked. A critical notice cannot be muted, so in
    // practice this is "the channel is not available" — recorded, not sent.
    await recordNotice(stores, tx, notice, planned.value.notificationId, target, 'suppressed', planned.value.reason, now);
    return false;
  }
  const copy = ACCOUNT_SECURITY_COPY[notice.kind][notice.channel];
  if (copy === undefined) {
    // The catalogue declared the channel and the copy table did not: a
    // disagreement between two Platform files, and never something to paper over
    // with a default string.
    throw new Error(`no ${notice.channel} copy exists for ${notice.kind}`);
  }
  const rendered = renderNotificationBody(planned.value, copy.body, notice.facts);
  if (!rendered.ok) {
    throw new Error(`rendering ${notice.kind} was refused: ${rendered.error.message}`);
  }
  try {
    await recordNotice(stores, tx, notice, planned.value.notificationId, target, 'planned', null, now);
  } catch (error) {
    if (error instanceof StoreError && isDuplicateNotice(error)) {
      // The unique index refused the second claim. This is the whole of §7.2's
      // "never per attempt", and it is why no caller needs a counter.
      return false;
    }
    throw error;
  }
  await sender.send(notice.userId, target.relayChannel, {
    address: target.address,
    subject: copy.title,
    body: rendered.value.text,
    secret: '',
  });
  return true;
}

async function recordNotice(
  stores: Stores,
  tx: Transaction,
  notice: SecurityNotice,
  notificationId: string,
  target: NoticeTarget,
  status: 'planned' | 'suppressed',
  suppressionReason: string | null,
  now: Date,
): Promise<void> {
  await stores.accounts.insertNotice(
    {
      notificationId,
      userId: notice.userId,
      kind: notice.kind,
      channel: target.relayChannel,
      status,
      suppressionReason,
      idempotencyKey: idempotencyKeyOf(notice),
      deliverAt: now,
      createdAt: now,
    },
    tx,
  );
}

/**
 * The key two attempts at the same fact collide on.
 *
 * Fact, recipient and channel — the same three things the platform's own
 * `idempotencyKeyFor` joins, and for the same reason: a fan-out across channels
 * is three distinct deliveries, and a repeat of the fact is one.
 */
export function idempotencyKeyOf(notice: SecurityNotice): string {
  return [notice.sourceFactId, notice.userId, notice.channel].join('/');
}

/**
 * Whether a storage error is the unique index refusing a second claim.
 *
 * Postgres reports it as `23505`, and `StoreError` keeps the driver error as its
 * cause, so the code is still readable here. Anything else is rethrown by the
 * caller: the alternative is treating every storage fault as "already notified",
 * which would silently swallow a real outage.
 */
function isDuplicateNotice(error: StoreError): boolean {
  const cause: unknown = error.cause;
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) {
    return false;
  }
  return cause.code === '23505';
}

/**
 * The pause-window key for a recovery that crossed the abuse threshold.
 *
 * Keyed on the account and the window rather than on the attempt, so a burst of
 * forty requests inside one day produces one key and therefore one notice — which
 * is the invariant, stated as a string.
 */
export function recoveryPauseKey(userId: UserId, windowStartedAt: Date): string {
  return [`recovery_paused`, userId, windowStartedAt.toISOString().slice(0, 10)].join('/');
}

/** The fact id for a completed recovery. Unique per recovery, by construction. */
export function recoveryCompletedFactId(recoveryId: string): string {
  return `recovery_completed/${recoveryId}`;
}

/** The fact id for signing out everywhere. One per request, by construction. */
export function signedOutFactId(userId: UserId, at: Date): string {
  return `signed_out_all/${userId}/${at.toISOString()}`;
}