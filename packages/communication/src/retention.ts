/**
 * Retention and deletion (issue #5, overview commitment #4).
 *
 * Unmatching ends a relationship; it does not end the record. The record
 * outlives the relationship for exactly as long as a moderation case could
 * still need it, and no longer — the periods below are policy inputs to a legal
 * answer per market, not a technical constant. They live here as a pure
 * function so the ordering is testable now and the numbers can be replaced
 * later without touching a transition table.
 */

export interface RetentionPolicy {
  /** Days of full history a participant can read. */
  readonly conversationHistoryDays: number;
  /** Days after which only case-scoped evidence survives. */
  readonly reportEvidenceDays: number;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  conversationHistoryDays: 180,
  reportEvidenceDays: 365,
};

export type RetentionOutcome =
  /** Readable by the participants, in the product. */
  | 'live_history'
  /** Withdrawn from the product; still available to a recorded case. */
  | 'reportable_only'
  /** Nothing survives. A report opened after this point has no evidence. */
  | 'purged';

export function retentionOutcome(ageDays: number, policy: RetentionPolicy): RetentionOutcome {
  if (ageDays <= policy.conversationHistoryDays) {
    return 'live_history';
  }
  if (ageDays <= policy.reportEvidenceDays) {
    return 'reportable_only';
  }
  return 'purged';
}
