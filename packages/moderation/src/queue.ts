/**
 * The moderator queue vocabulary (issue #7). Priority and queue live in their
 * own module because both the report triage policy and the case lifecycle
 * speak them: keeping them here is what stops "urgent report" and "critical
 * risk" from being modelled as two different notions of urgent.
 */
export type CasePriority = 'low' | 'normal' | 'high' | 'urgent';

export type CaseQueue = 'safety' | 'identity_integrity' | 'appeals';

export const PRIORITY_RANK: Readonly<Record<CasePriority, number>> = {
  low: 0,
  normal: 1,
  high: 2,
  urgent: 3,
};

export const QUEUE_LABEL: Readonly<Record<CaseQueue, string>> = {
  safety: 'Member safety',
  identity_integrity: 'Identity integrity',
  appeals: 'Appeals (reserved for v0.2)',
};

/** Response target per priority. A queue is only real if it has a clock. */
export const SLA_HOURS_BY_PRIORITY: Readonly<Record<CasePriority, number>> = {
  low: 72,
  normal: 48,
  high: 24,
  urgent: 4,
};

export function highestPriority(a: CasePriority, b: CasePriority): CasePriority {
  return PRIORITY_RANK[a] >= PRIORITY_RANK[b] ? a : b;
}
