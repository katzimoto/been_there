import { type DomainError, type Result, domainError, ok } from '@been-there/core';

/**
 * Anti-abuse friction (issue #5).
 *
 * Friction is not enforcement, and the difference is structural rather than a
 * matter of tone:
 *
 *   friction     — a rate rule answers `rate_limited`, which is `retryable`.
 *                  It is evaluated against a sliding window of timestamps,
 *                  carries no case, touches no account standing, and cannot
 *                  move a conversation out of `active`. The only way to close a
 *                  conversation is an explicit `end`/`unmatch` event or a
 *                  recorded enforcement case, and none of them is reachable
 *                  from this file.
 *   enforcement  — a human moderator, on a recorded case, changes an account
 *                  standing. That is Moderation & Enforcement's table, not this
 *                  one.
 *
 * A rate limit that could close a conversation would let an automated rule
 * remove someone's ability to talk, which is precisely the outcome the
 * overview's "automation never enforces" commitment forbids.
 */

export type RateRuleId = 'per_conversation_burst' | 'new_conversation_burst';

export interface RateRule {
  readonly id: RateRuleId;
  /** Attempts permitted inside one window. */
  readonly limit: number;
  readonly windowMs: number;
}

/** Sliding-window burst rule for one conversation. */
export const PER_CONVERSATION_RATE_RULE: RateRule = {
  id: 'per_conversation_burst',
  limit: 20,
  windowMs: 60_000,
};

/** Sliding-window rule on how fast one user opens new conversations. */
export const NEW_CONVERSATION_RATE_RULE: RateRule = {
  id: 'new_conversation_burst',
  limit: 10,
  windowMs: 3_600_000,
};

export interface RateVerdict {
  readonly ruleId: RateRuleId;
  readonly limit: number;
  readonly used: number;
  readonly remaining: number;
  readonly windowMs: number;
}

export function evaluateRateRule(
  rule: RateRule,
  attempts: readonly Date[],
  now: Date,
): Result<RateVerdict, DomainError> {
  const inWindow = attempts.filter(
    (at) => at.getTime() > now.getTime() - rule.windowMs && at.getTime() <= now.getTime(),
  );
  const used = inWindow.length;
  if (used >= rule.limit) {
    const oldest = inWindow.reduce<number | null>((earliest, at) => {
      const attemptedAt = at.getTime();
      return earliest === null || attemptedAt < earliest ? attemptedAt : earliest;
    }, null);
    return domainError('rate_limited', 'communication', 'sending too quickly', {
      rule: rule.id,
      limit: rule.limit,
      used,
      retryAfterMs: Math.max(0, (oldest ?? now.getTime()) + rule.windowMs - now.getTime()),
    });
  }
  return ok({
    ruleId: rule.id,
    limit: rule.limit,
    used,
    remaining: rule.limit - used,
    windowMs: rule.windowMs,
  });
}
