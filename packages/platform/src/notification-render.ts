import { type DomainError, type Result, domainError, ok } from '@been-there/core';
import {
  NOTIFICATION_CONTENT_TOKENS,
  type NotificationContentToken,
} from './notification-catalogue.js';
import type { NotificationPlan } from './notifications.js';

/**
 * The values a body may bind, keyed by the token that names them.
 *
 * A mapped type over the union rather than a hand-written record, so adding a
 * member to `NOTIFICATION_CONTENT_TOKENS` widens this and cannot leave a token
 * with nowhere to put its value. Every member is optional because a kind
 * declares its own subset per channel, and what the renderer checks is that the
 * set supplied is the set declared — not that both are the whole union.
 */
export type NotificationFacts = {
  readonly [Token in NotificationContentToken]?: string | number;
};

export interface RenderedNotificationBody {
  readonly kind: NotificationPlan['kind'];
  readonly channel: NotificationPlan['channel'];
  /** The body, with every slot substituted. No `{{…}}` survives. */
  readonly text: string;
  /** The facts that reached the bytes, in the order the catalogue declares them. */
  readonly facts: readonly NotificationContentToken[];
}

/**
 * A value slot. Double braces, because the notification spec's own copy
 * already uses `{…}` for its placeholders — `{n}`, `{capabilities}` — and a
 * single-brace slot would either collide with that copy or be a second
 * placeholder convention in the same string. A slot names a
 * `NotificationContentToken`; a `{…}` in copy is the copy owner's prose.
 */
const SLOT = /\{\{\s*([^}]*?)\s*\}\}/g;

/**
 * Assembles the body of a planned notification.
 *
 * This is where `NotificationContentToken` stops being decorative. The
 * catalogue says which facts a channel may say; the plan carries that set
 * forward; and this is the only function that turns a set of facts into
 * characters. Three refusals, and between them they close both directions:
 *
 * - a `{{slot}}` that is not a member of the token union, or that names a fact
 *   this kind does not declare on this channel. **This is the guarantee.** A
 *   template cannot render a message body, because `message_body` is not a fact
 *   anyone may bind — not here, and not anywhere else, and a template that
 *   tries comes back as a `validation_failed` rather than as a body with a
 *   literal `{{message_body}}` in it.
 * - a declared fact with no value, or a fact supplied that the channel does not
 *   declare. Under-delivery and smuggling are the same class of mistake, so
 *   they are one check: the supplied set and the declared set must be equal.
 * - nothing else. The literal prose is the copy owner's, reviewed as a string
 *   like any other user-facing safety copy; what this function guarantees is
 *   that the *facts* interpolated into it are the catalogue's and no more.
 */
export function renderNotificationBody(
  plan: NotificationPlan,
  copy: string,
  facts: NotificationFacts,
): Result<RenderedNotificationBody, DomainError> {
  const declared = plan.content;
  const where = { kind: plan.kind, channel: plan.channel } as const;
  const slots = [...copy.matchAll(SLOT)].map((match) => match[1] ?? '');

  for (const slot of slots) {
    // Widening the tuple so `.includes` accepts a plain `string` — the check
    // itself is the guard, and the cast on the next branch is safe because a
    // slot that reaches it is already a member of the union.
    const isKnown = (NOTIFICATION_CONTENT_TOKENS as readonly string[]).includes(slot);
    if (!isKnown) {
      return domainError(
        'validation_failed',
        'platform',
        `"{{${slot}}}" is not a fact any notification body may bind`,
        { ...where, slot },
      );
    }
    if (!declared.includes(slot as NotificationContentToken)) {
      return domainError(
        'validation_failed',
        'platform',
        `"{{${slot}}}" is not a fact this notification declares on this channel`,
        { ...where, slot },
      );
    }
  }

  for (const token of NOTIFICATION_CONTENT_TOKENS) {
    if (declared.includes(token) && facts[token] === undefined) {
      return domainError(
        'validation_failed',
        'platform',
        `the catalogue declares "${token}" on this channel and no value was supplied`,
        { ...where, token },
      );
    }
    if (!declared.includes(token) && facts[token] !== undefined) {
      return domainError(
        'validation_failed',
        'platform',
        'a fact was supplied that this notification does not declare on this channel',
        { ...where, token },
      );
    }
  }

  const text = copy.replace(SLOT, (_slot, name: string) => String(facts[name as NotificationContentToken]));

  return ok({ kind: plan.kind, channel: plan.channel, text, facts: declared });
}
