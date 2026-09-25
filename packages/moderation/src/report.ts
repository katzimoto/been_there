import {
  type ActorId,
  type ConversationId,
  type CorrelationId,
  type DomainError,
  type ReportId,
  type Result,
  type StateMachine,
  type UserId,
  defineStateMachine,
  domainError,
  castId,
  ok,
} from '@been-there/core';
import {
  type EvidenceKind,
  type EvidenceRecord,
  type EvidenceSourceDomain,
  captureEvidence,
} from './evidence.js';
import type { ModerationContext } from './events.js';
import { type CasePriority, highestPriority } from './queue.js';

/**
 * Reports (issue #7).
 *
 * A report is the user's way of saying "this is not acceptable", and it is the
 * only intake path a member controls. Two properties matter more than the rest:
 *
 *  - **A report outlives its relationship.** `submitReport` takes a frozen
 *    `RelationshipSnapshot`, not a live match, and captures the evidence at that
 *    moment. Once submitted, the record is self-contained: the match can end and
 *    the conversation can be deleted, and the report is still reviewable. This is
 *    commitment #4 of the architecture overview, expressed as a parameter type.
 *  - **Reporting is always available.** Every account state in the shared kernel
 *    grants the `report` capability, including `banned`, because a banned user
 *    with a genuine safety concern is exactly the person who must be able to
 *    reach a human.
 */
export type ReportReason =
  | 'harassment'
  | 'hate_or_discrimination'
  | 'threats_or_violence'
  | 'sexual_content'
  | 'non_consensual_intimacy'
  | 'minor_safety'
  | 'scam_or_solicitation'
  | 'impersonation'
  | 'fake_or_misleading_profile'
  | 'spam'
  | 'other';

export interface ReportTriagePolicy {
  /** Priority this reason implies when a case is opened from the report. */
  readonly priority: CasePriority;
  /** Free text is mandatory — the category is too vague to action on its own. */
  readonly requiresStatement: boolean;
  /** Safety-of-a-person reasons jump the queue whatever else says. */
  readonly isPersonSafety: boolean;
}

export const REPORT_REASON_POLICY: Readonly<Record<ReportReason, ReportTriagePolicy>> = {
  harassment: { priority: 'normal', requiresStatement: false, isPersonSafety: false },
  hate_or_discrimination: { priority: 'high', requiresStatement: false, isPersonSafety: true },
  threats_or_violence: { priority: 'urgent', requiresStatement: false, isPersonSafety: true },
  sexual_content: { priority: 'normal', requiresStatement: false, isPersonSafety: true },
  non_consensual_intimacy: { priority: 'urgent', requiresStatement: false, isPersonSafety: true },
  minor_safety: { priority: 'urgent', requiresStatement: false, isPersonSafety: true },
  scam_or_solicitation: { priority: 'normal', requiresStatement: false, isPersonSafety: false },
  impersonation: { priority: 'high', requiresStatement: false, isPersonSafety: false },
  fake_or_misleading_profile: { priority: 'low', requiresStatement: false, isPersonSafety: false },
  spam: { priority: 'low', requiresStatement: false, isPersonSafety: false },
  other: { priority: 'normal', requiresStatement: true, isPersonSafety: false },
};

const MAX_STATEMENT_LENGTH = 2000;
const MIN_STATEMENT_LENGTH = 20;

export type ReportState =
  | 'submitted'
  | 'triaged'
  | 'merged'
  | 'actioned'
  | 'dismissed'
  | 'escalated';

export type ReportEvent = 'triage' | 'merge' | 'action' | 'dismiss' | 'escalate';

export interface ReportContext {
  readonly caseId?: string;
  readonly moderatorId?: string;
  readonly decisionId?: string;
}

export const reportMachine: StateMachine<ReportState, ReportEvent, ReportContext> =
  defineStateMachine<ReportState, ReportEvent, ReportContext>({
    domain: 'moderation.report',
    initial: 'submitted',
    transitions: [
      {
        event: 'triage',
        from: ['submitted'],
        to: 'triaged',
        note: 'Triage is the gate a report passes before it is worth a moderator’s time.',
      },
      {
        event: 'merge',
        from: ['triaged'],
        to: 'merged',
        guard: (ctx) => ctx?.caseId !== undefined && ctx?.moderatorId !== undefined,
        note: 'A report is merged into a case by a named moderator; the report survives as an auditable record.',
      },
      {
        event: 'action',
        from: ['triaged', 'escalated'],
        to: 'actioned',
        guard: (ctx) =>
          ctx?.caseId !== undefined && ctx?.moderatorId !== undefined && ctx?.decisionId !== undefined,
        note: 'A report is actioned only by a decision — a sanction without a report is a different record.',
      },
      {
        event: 'dismiss',
        from: ['triaged', 'escalated'],
        to: 'dismissed',
        guard: (ctx) =>
          ctx?.caseId !== undefined && ctx?.moderatorId !== undefined && ctx?.decisionId !== undefined,
        note: 'Dismissal is a decision too, so it is accountable in exactly the same way.',
      },
      {
        event: 'escalate',
        from: ['triaged'],
        to: 'escalated',
        guard: (ctx) => ctx?.moderatorId !== undefined,
        note: 'Escalation is a judgement call by a person, and it is recorded under their name.',
      },
    ],
  });

/** A frozen view of the dating relationship, taken at report time. */
export interface RelationshipSnapshot {
  readonly status: 'matched' | 'unmatched' | 'never_matched' | 'blocked';
  readonly capturedAt: Date;
  readonly conversationId: ConversationId | null;
  readonly messageRange: { readonly from: string; readonly to: string } | null;
}

export interface Report {
  readonly reportId: ReportId;
  /** Whose behaviour is reported. */
  readonly subjectId: UserId;
  /** null = anonymous report. Anonymity never weakens the record. */
  readonly reporterId: UserId | null;
  readonly reason: ReportReason;
  readonly statement: string | null;
  readonly relationship: RelationshipSnapshot;
  /** Frozen at submission. This is what a case reads months later. */
  readonly capturedEvidence: readonly EvidenceRecord[];
  readonly state: ReportState;
  readonly mergedCaseId: string | null;
  readonly submittedAt: Date;
  readonly updatedAt: Date;
}

export interface ReportEvidenceInput {
  readonly kind: EvidenceKind;
  readonly sourceDomain: EvidenceSourceDomain;
  readonly artefactReference: string;
  readonly digest: string;
  readonly redactedSummary: string;
  readonly retentionExpiresAt?: Date | null;
}

export interface SubmitReportCommand {
  readonly reportId: ReportId;
  readonly subjectId: UserId;
  readonly reporterId: UserId | null;
  readonly reason: ReportReason;
  readonly statement: string | null;
  readonly relationship: RelationshipSnapshot;
  readonly evidence: readonly ReportEvidenceInput[];
  readonly correlationId: CorrelationId;
}

export interface ReportSubmission {
  readonly report: Report;
  readonly evidence: readonly EvidenceRecord[];
  readonly eventId: string;
}

export function submitReport(
  ctx: ModerationContext,
  command: SubmitReportCommand,
): Result<ReportSubmission, DomainError> {
  if (command.reporterId !== null && command.reporterId === command.subjectId) {
    return domainError('validation_failed', 'moderation.report', 'a user cannot report themselves', {
      subjectId: command.subjectId,
    });
  }
  if (command.statement !== null && command.statement.length > MAX_STATEMENT_LENGTH) {
    return domainError(
      'validation_failed',
      'moderation.report',
      `a report statement is limited to ${MAX_STATEMENT_LENGTH} characters`,
      { length: command.statement.length },
    );
  }
  const policy = REPORT_REASON_POLICY[command.reason];
  const statementLength = command.statement?.trim().length ?? 0;
  if (policy.requiresStatement && statementLength < MIN_STATEMENT_LENGTH) {
    return domainError(
      'validation_failed',
      'moderation.report',
      `a '${command.reason}' report must describe what happened (at least ${MIN_STATEMENT_LENGTH} characters)`,
      { reason: command.reason },
    );
  }
  if (command.evidence.length === 0) {
    return domainError(
      'validation_failed',
      'moderation.report',
      'a report must capture at least one piece of evidence at the moment it is made',
      { reportId: command.reportId },
    );
  }

  // A reporter acts on themselves; an anonymous report has no actor of its own.
  const reporterActor: ActorId | 'system' =
    command.reporterId === null ? 'system' : castId<'ActorId'>(command.reporterId);

  const captured: EvidenceRecord[] = [];
  for (const input of command.evidence) {
    const result = captureEvidence(ctx, {
      kind: input.kind,
      subjectId: command.subjectId,
      sourceDomain: input.sourceDomain,
      artefactReference: input.artefactReference,
      digest: input.digest,
      redactedSummary: input.redactedSummary,
      capture: { at: 'report_submission', reportId: command.reportId },
      caseId: null,
      actorId: reporterActor,
      correlationId: command.correlationId,
      retentionExpiresAt: input.retentionExpiresAt,
    });
    if (!result.ok) {
      return result;
    }
    captured.push(result.value);
  }

  const submittedAt = ctx.now();
  const report: Report = {
    reportId: command.reportId,
    subjectId: command.subjectId,
    reporterId: command.reporterId,
    reason: command.reason,
    statement: command.statement,
    relationship: command.relationship,
    capturedEvidence: captured,
    state: 'submitted',
    mergedCaseId: null,
    submittedAt,
    updatedAt: submittedAt,
  };

  const event = ctx.events.emit({
    type: 'moderation.report_submitted',
    actorId: reporterActor,
    subjectId: command.subjectId,
    correlationId: command.correlationId,
    sensitivity: 'restricted',
    payload: { reportId: command.reportId, reason: command.reason, anonymous: command.reporterId === null },
  });

  ctx.audit.append({
    occurredAt: submittedAt,
    actorId: reporterActor,
    action: 'report.submitted',
    entityType: 'report',
    entityId: command.reportId,
    subjectId: command.subjectId,
    caseId: null,
    evidenceIds: captured.map((item) => item.evidenceId),
    decisionId: null,
    outcome: 'allowed',
    reversal: null,
    detail: {
      reason: command.reason,
      anonymous: command.reporterId === null,
      relationshipStatus: command.relationship.status,
    },
  });

  return ok({ report, evidence: captured, eventId: event.eventId });
}

/** Priority a report implies on its own, before it meets a risk signal. */
export function priorityForReason(reason: ReportReason): CasePriority {
  return REPORT_REASON_POLICY[reason].priority;
}

export interface TriageCommand {
  readonly report: Report;
  readonly moderatorId: ActorId;
  readonly correlationId: CorrelationId;
}

/**
 * Triage. No case exists yet, so no case id is required — the moderator is.
 * A report is never actioned or dismissed from `submitted`; the table forbids it.
 */
export function triageReport(
  ctx: ModerationContext,
  command: TriageCommand,
): Result<Report, DomainError> {
  const next = reportMachine.next(command.report.state, 'triage', {
    moderatorId: command.moderatorId,
  });
  if (!next.ok) {
    return next;
  }
  const report: Report = {
    ...command.report,
    state: next.value,
    updatedAt: ctx.now(),
  };
  ctx.audit.append({
    occurredAt: report.updatedAt,
    actorId: command.moderatorId,
    action: 'report.triaged',
    entityType: 'report',
    entityId: report.reportId,
    subjectId: report.subjectId,
    caseId: null,
    evidenceIds: report.capturedEvidence.map((item) => item.evidenceId),
    decisionId: null,
    outcome: 'allowed',
    reversal: null,
    detail: { reason: report.reason, priority: priorityForReason(report.reason) },
  });
  return ok(report);
}

/** The strongest priority a set of reasons implies — used when reports merge. */
export function strongestPriority(reasons: readonly ReportReason[]): CasePriority {
  return reasons.reduce<CasePriority>(
    (acc, reason) => highestPriority(acc, priorityForReason(reason)),
    'low',
  );
}
