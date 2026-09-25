import type { AccountEvent, ActorId, CaseId, UserId } from '@been-there/core';
import type { DecisionId, EvidenceId } from './ids.js';

/**
 * The audit log (issue #7: "auditability and future appeal support").
 *
 * It is append-only by construction: the `AuditLog` type has `append` and three
 * read projections and nothing else — there is no update, no delete, no
 * truncate. A moderation action therefore cannot be edited out of the record;
 * it can only be answered by a later entry.
 *
 * Every entry is written so that the question "who did what, when, on what
 * evidence, and can it be reversed?" is answerable from one row:
 *
 *   who       → actorId
 *   what      → action + entityType/entityId
 *   when      → occurredAt + sequence (monotonic, gap-free per process)
 *   on what   → caseId + evidenceIds
 *   reversible→ reversal (null means the entry is a fact, not an action)
 *   outcome   → allowed | denied (a denied read is itself the interesting row)
 */
export type AuditEntityType = 'report' | 'case' | 'evidence' | 'decision' | 'account';

export type AuditAction =
  | 'report.submitted'
  | 'report.triaged'
  | 'report.merged'
  | 'report.status_changed'
  | 'case.opened'
  | 'case.assigned'
  | 'case.review_started'
  | 'case.escalated'
  | 'case.reports_merged'
  | 'case.resolved'
  | 'case.reopened'
  | 'evidence.captured'
  | 'evidence.read'
  | 'evidence.read_denied'
  | 'decision.recorded'
  | 'decision.reversed';

export type AuditOutcome = 'allowed' | 'denied';

/** How an entry can be answered later. `null` means "not reversible". */
export type ReversalPath =
  | { readonly via: 'account_state'; readonly accountEvent: AccountEvent }
  | { readonly via: 'new_decision'; readonly decisionId: DecisionId }
  | { readonly via: 'case_reopen'; readonly caseId: CaseId };

export interface NewAuditEntry {
  readonly occurredAt: Date;
  readonly actorId: ActorId | 'system';
  readonly action: AuditAction;
  readonly entityType: AuditEntityType;
  readonly entityId: string;
  /** Whose account this concerns. Null only for pre-subject facts. */
  readonly subjectId: UserId | null;
  readonly caseId: CaseId | null;
  readonly evidenceIds: readonly EvidenceId[];
  readonly decisionId: DecisionId | null;
  readonly outcome: AuditOutcome;
  readonly reversal: ReversalPath | null;
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
}

export interface AuditEntry extends NewAuditEntry {
  /** Monotonic, gap-free within one process. Total order for the read views. */
  readonly sequence: number;
}

export interface AuditLog {
  /** The only mutation. There is no counterpart to undo or delete a row. */
  append(entry: NewAuditEntry): AuditEntry;
  readonly entries: readonly AuditEntry[];
  /** Every action a given moderator (or the system) performed. */
  byActor(actorId: ActorId | 'system'): readonly AuditEntry[];
  /** Everything that ever happened to one account, in order. */
  bySubject(subjectId: UserId): readonly AuditEntry[];
  /** The full history of one report, case, evidence item, decision or account. */
  byEntity(entityType: AuditEntityType, entityId: string): readonly AuditEntry[];
  /** The evidence → review → decision chain for one case. */
  forCase(caseId: CaseId): readonly AuditEntry[];
}

export function createAuditLog(): AuditLog {
  const rows: AuditEntry[] = [];
  let nextSequence = 0;

  return {
    append(entry: NewAuditEntry): AuditEntry {
      const stored: AuditEntry = { ...entry, sequence: nextSequence };
      nextSequence += 1;
      rows.push(stored);
      return stored;
    },
    get entries(): readonly AuditEntry[] {
      return rows;
    },
    byActor(actorId) {
      return rows.filter((row) => row.actorId === actorId);
    },
    bySubject(subjectId) {
      return rows.filter((row) => row.subjectId === subjectId);
    },
    byEntity(entityType, entityId) {
      return rows.filter((row) => row.entityType === entityType && row.entityId === entityId);
    },
    forCase(caseId) {
      return rows.filter((row) => row.caseId === caseId);
    },
  };
}
