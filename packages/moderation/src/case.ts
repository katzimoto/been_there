import {
  type ActorId,
  type CaseId,
  type CorrelationId,
  type DomainError,
  type ReportId,
  type Result,
  type RiskAssessmentId,
  type RiskState,
  type StateMachine,
  type UserId,
  type VerificationId,
  castId,
  defineStateMachine,
  domainError,
  ok,
} from '@been-there/core';
import { type EvidenceRecord, type ModeratorActor, captureEvidence } from './evidence.js';
import {
  type CaseReopenedPayload,
  type CaseAssignedPayload,
  type CaseReviewStartedPayload,
  type ModerationContext,
} from './events.js';
import type { DecisionId, EvidenceId } from './ids.js';
import {
  type CasePriority,
  type CaseQueue,
  PRIORITY_RANK,
  SLA_HOURS_BY_PRIORITY,
  highestPriority,
} from './queue.js';
import { type Report, type ReportReason, reportMachine, strongestPriority } from './report.js';

/**
 * Cases (issue #7).
 *
 * The case is the unit a moderator works and the unit an auditor reads. Three
 * intake paths converge on it — a user report, a trust & safety review
 * candidate, an automated identity anomaly — and the convergence is the point:
 * once a case exists, *how the behaviour was found* is one field on the record
 * and the evidence → review → decision chain is identical for all three.
 * Without a single case record, "we only action things users report" and "we
 * action things we found ourselves" would be two processes with two audit
 * stories, and the second one would drift towards "the system decided".
 */
export type CaseState = 'open' | 'assigned' | 'in_review' | 'escalated' | 'resolved';

export type CaseEvent = 'assign' | 'start_review' | 'escalate' | 'resolve' | 'reopen';

export interface CaseContext {
  readonly moderatorId?: string;
  readonly decisionId?: string;
  readonly reason?: string;
}

export const caseMachine: StateMachine<CaseState, CaseEvent, CaseContext> =
  defineStateMachine<CaseState, CaseEvent, CaseContext>({
    domain: 'moderation.case',
    initial: 'open',
    transitions: [
      {
        event: 'assign',
        from: ['open', 'assigned', 'escalated'],
        to: 'assigned',
        guard: (ctx) => ctx?.moderatorId !== undefined,
        note: 'An escalated case can be picked up, but only by a lead — see `canWorkCase`.',
      },
      {
        event: 'start_review',
        from: ['assigned'],
        to: 'in_review',
        guard: (ctx) => ctx?.moderatorId !== undefined,
      },
      {
        event: 'escalate',
        from: ['open', 'assigned', 'in_review'],
        to: 'escalated',
        guard: (ctx) => ctx?.moderatorId !== undefined && (ctx?.reason ?? '').trim().length > 0,
        note: 'Escalation is only meaningful with a stated reason; a bare escalation is not reviewable.',
      },
      {
        event: 'resolve',
        from: ['open', 'assigned', 'in_review', 'escalated'],
        to: 'resolved',
        guard: (ctx) => ctx?.moderatorId !== undefined && ctx?.decisionId !== undefined,
        note: 'A case never closes on a shrug: resolution requires a recorded decision, `clear` included.',
      },
      {
        event: 'reopen',
        from: ['resolved'],
        to: 'open',
        guard: (ctx) => ctx?.moderatorId !== undefined && (ctx?.reason ?? '').trim().length > 0,
        note: 'The entry point a future appeal flow will use; today only a moderator may take it.',
      },
    ],
  });

/** How the behaviour was found. Retained, because it changes the appeal argument. */
export type CaseOrigin =
  | { readonly source: 'user_report'; readonly reasons: readonly ReportReason[] }
  | {
      readonly source: 'trust_safety_review';
      readonly riskAssessmentId: RiskAssessmentId;
      readonly riskState: RiskState;
      readonly detectors: readonly string[];
    }
  | {
      readonly source: 'identity_anomaly';
      readonly verificationId: VerificationId;
      readonly anomaly: string;
    };

export interface Case {
  readonly caseId: CaseId;
  readonly subjectId: UserId;
  readonly origin: CaseOrigin;
  readonly state: CaseState;
  readonly priority: CasePriority;
  readonly queue: CaseQueue;
  readonly openedAt: Date;
  /** Response target derived from priority; a queue is only real with a clock. */
  readonly dueAt: Date;
  readonly openedBy: ActorId | 'system';
  readonly assignedModeratorId: ActorId | null;
  /** Every report folded into this case. Merge never drops one. */
  readonly reportIds: readonly ReportId[];
  readonly evidenceIds: readonly EvidenceId[];
  readonly resolutionDecisionId: DecisionId | null;
  readonly updatedAt: Date;
}

const PRIORITY_BY_RISK_STATE: Readonly<Record<RiskState, CasePriority>> = {
  normal: 'low',
  elevated: 'normal',
  high: 'high',
  critical: 'urgent',
};

/** An identity anomaly is never less than `high`: it questions who is on the app. */
const IDENTITY_ANOMALY_PRIORITY: CasePriority = 'high';

export type CaseIntake =
  | {
      readonly source: 'user_report';
      readonly report: Report;
      readonly openedBy: ActorId | 'system';
      readonly correlationId: CorrelationId;
    }
  | {
      readonly source: 'trust_safety_review';
      readonly subjectId: UserId;
      readonly riskAssessmentId: RiskAssessmentId;
      readonly riskState: RiskState;
      readonly detectors: readonly string[];
      /** Content hash of the risk snapshot being frozen into the case. */
      readonly digest: string;
      readonly openedBy: ActorId | 'system';
      readonly correlationId: CorrelationId;
    }
  | {
      readonly source: 'identity_anomaly';
      readonly subjectId: UserId;
      readonly verificationId: VerificationId;
      readonly anomaly: string;
      readonly digest: string;
      readonly openedBy: ActorId | 'system';
      readonly correlationId: CorrelationId;
    };

export interface CaseOpened {
  readonly moderationCase: Case;
  readonly evidence: readonly EvidenceRecord[];
  readonly eventId: string;
}

/** SLA arithmetic, named so the unit conversion is not an inline `* 3600000`. */
function dueFrom(openedAt: Date, priority: CasePriority): Date {
  return new Date(openedAt.getTime() + SLA_HOURS_BY_PRIORITY[priority] * 60 * 60 * 1000);
}

export function openCase(
  ctx: ModerationContext,
  intake: CaseIntake,
): Result<CaseOpened, DomainError> {
  const openedAt = ctx.now();
  const caseId = castId<'CaseId'>(ctx.ids.next());

  if (intake.source === 'user_report') {
    return openFromReport(ctx, intake, caseId, openedAt);
  }
  if (intake.source === 'trust_safety_review' && intake.riskState === 'normal') {
    return domainError(
      'not_eligible',
      'moderation.case',
      'risk at `normal` is not a review candidate; a detector must raise it first',
      { subjectId: intake.subjectId, riskState: intake.riskState },
    );
  }
  if (intake.source === 'identity_anomaly' && intake.anomaly.trim().length === 0) {
    return domainError(
      'validation_failed',
      'moderation.case',
      'an identity anomaly must name the anomaly it refers to',
      { subjectId: intake.subjectId },
    );
  }

  // Intake freezes the triggering fact as evidence, so the case can be read
  // months later without asking another domain what it thought at the time.
  const captured = captureEvidence(ctx, {
    kind: intake.source === 'trust_safety_review' ? 'risk_assessment' : 'identity_anomaly',
    subjectId: intake.subjectId,
    sourceDomain: intake.source === 'trust_safety_review' ? 'trust-safety' : 'identity',
    artefactReference:
      intake.source === 'trust_safety_review'
        ? `risk-assessment:${intake.riskAssessmentId}`
        : `verification:${intake.verificationId}`,
    digest: intake.digest,
    redactedSummary:
      intake.source === 'trust_safety_review'
        ? `Risk ${intake.riskState} raised by ${intake.detectors.join(', ')}`
        : `Identity anomaly: ${intake.anomaly}`,
    capture: { at: 'case_intake', caseId },
    caseId,
    actorId: intake.openedBy,
    correlationId: intake.correlationId,
  });
  if (!captured.ok) {
    return captured;
  }

  return finishCase(ctx, {
    subjectId: intake.subjectId,
    origin:
      intake.source === 'trust_safety_review'
        ? {
            source: 'trust_safety_review',
            riskAssessmentId: intake.riskAssessmentId,
            riskState: intake.riskState,
            detectors: intake.detectors,
          }
        : {
            source: 'identity_anomaly',
            verificationId: intake.verificationId,
            anomaly: intake.anomaly,
          },
    priority:
      intake.source === 'trust_safety_review'
        ? PRIORITY_BY_RISK_STATE[intake.riskState]
        : IDENTITY_ANOMALY_PRIORITY,
    queue: intake.source === 'identity_anomaly' ? 'identity_integrity' : 'safety',
    caseId,
    openedAt,
    openedBy: intake.openedBy,
    correlationId: intake.correlationId,
    reportIds: [],
    evidence: [captured.value],
  });
}

function openFromReport(
  ctx: ModerationContext,
  intake: Extract<CaseIntake, { source: 'user_report' }>,
  caseId: CaseId,
  openedAt: Date,
): Result<CaseOpened, DomainError> {
  const { report } = intake;
  if (report.state === 'merged' && report.mergedCaseId !== null) {
    return domainError(
      'conflict',
      'moderation.case',
      'this report is already merged into a case',
      { reportId: report.reportId, caseId: report.mergedCaseId },
    );
  }
  if (report.state !== 'triaged') {
    return domainError(
      'not_eligible',
      'moderation.case',
      'a report must be triaged before it opens a case',
      { reportId: report.reportId, state: report.state },
    );
  }
  // The relationship that produced the report is irrelevant here, by design:
  // an unmatch never invalidates a report, and the evidence is already frozen.
  return finishCase(ctx, {
    subjectId: report.subjectId,
    origin: { source: 'user_report', reasons: [report.reason] },
    priority: strongestPriority([report.reason]),
    queue: 'safety',
    caseId,
    openedAt,
    openedBy: intake.openedBy,
    correlationId: intake.correlationId,
    reportIds: [report.reportId],
    evidence: report.capturedEvidence,
  });
}

interface CaseDraft {
  readonly subjectId: UserId;
  readonly origin: CaseOrigin;
  readonly priority: CasePriority;
  readonly queue: CaseQueue;
  readonly caseId: CaseId;
  readonly openedAt: Date;
  readonly openedBy: ActorId | 'system';
  readonly correlationId: CorrelationId;
  readonly reportIds: readonly ReportId[];
  readonly evidence: readonly EvidenceRecord[];
}

function finishCase(ctx: ModerationContext, draft: CaseDraft): Result<CaseOpened, DomainError> {
  if (draft.evidence.length === 0) {
    return domainError(
      'validation_failed',
      'moderation.case',
      'a case opens on evidence; there is nothing to review without it',
      { caseId: draft.caseId, subjectId: draft.subjectId },
    );
  }
  const evidenceIds = draft.evidence.map((item) => item.evidenceId);
  const moderationCase: Case = {
    caseId: draft.caseId,
    subjectId: draft.subjectId,
    origin: draft.origin,
    state: 'open',
    priority: draft.priority,
    queue: draft.queue,
    openedAt: draft.openedAt,
    dueAt: dueFrom(draft.openedAt, draft.priority),
    openedBy: draft.openedBy,
    assignedModeratorId: null,
    reportIds: draft.reportIds,
    evidenceIds,
    resolutionDecisionId: null,
    updatedAt: draft.openedAt,
  };

  const event = ctx.events.emit({
    type: 'moderation.case_opened',
    actorId: draft.openedBy,
    subjectId: draft.subjectId,
    correlationId: draft.correlationId,
    sensitivity: 'restricted',
    payload: {
      caseId: draft.caseId,
      origin: draft.origin.source,
      priority: draft.priority,
      queue: draft.queue,
    },
  });

  ctx.audit.append({
    occurredAt: draft.openedAt,
    actorId: draft.openedBy,
    action: 'case.opened',
    entityType: 'case',
    entityId: draft.caseId,
    subjectId: draft.subjectId,
    caseId: draft.caseId,
    evidenceIds,
    decisionId: null,
    outcome: 'allowed',
    reversal: { via: 'case_reopen', caseId: draft.caseId },
    detail: { origin: draft.origin.source, priority: draft.priority, queue: draft.queue },
  });

  return ok({ moderationCase, evidence: draft.evidence, eventId: event.eventId });
}

/**
 * An escalated case is a lead's decision, not a reviewer's. Escalation is where
 * the product's safety commitments are hardest to keep, so it is deliberately
 * not self-service.
 */
export function canWorkCase(moderationCase: Case, actor: ModeratorActor): Result<true, DomainError> {
  if (actor.automated) {
    return domainError(
      'permission_denied',
      'moderation.case',
      'automation may not work a case: only a human moderator acts on one',
      { caseId: moderationCase.caseId, actorId: actor.actorId },
    );
  }
  if (moderationCase.state === 'escalated' && !actor.isLead) {
    return domainError(
      'permission_denied',
      'moderation.case',
      'an escalated case may only be worked by a moderation lead',
      { caseId: moderationCase.caseId, state: moderationCase.state },
    );
  }
  return ok(true);
}

export interface CaseCommand {
  readonly moderationCase: Case;
  readonly actor: ModeratorActor;
  readonly correlationId: CorrelationId;
}

export interface ReasonedCaseCommand extends CaseCommand {
  readonly reason: string;
}

export function assignCase(ctx: ModerationContext, command: CaseCommand): Result<Case, DomainError> {
  const permitted = canWorkCase(command.moderationCase, command.actor);
  if (!permitted.ok) {
    return permitted;
  }
  const next = caseMachine.next(command.moderationCase.state, 'assign', {
    moderatorId: command.actor.actorId,
  });
  if (!next.ok) {
    return next;
  }
  const updatedAt = ctx.now();
  const updated: Case = {
    ...command.moderationCase,
    state: next.value,
    assignedModeratorId: command.actor.actorId,
    updatedAt,
  };

  ctx.events.emit<CaseAssignedPayload>({
    type: 'moderation.case_assigned',
    actorId: command.actor.actorId,
    subjectId: updated.subjectId,
    correlationId: command.correlationId,
    sensitivity: 'restricted',
    payload: { caseId: updated.caseId, assignedModeratorId: command.actor.actorId },
  });
  ctx.audit.append({
    occurredAt: updatedAt,
    actorId: command.actor.actorId,
    action: 'case.assigned',
    entityType: 'case',
    entityId: updated.caseId,
    subjectId: updated.subjectId,
    caseId: updated.caseId,
    evidenceIds: [],
    decisionId: null,
    outcome: 'allowed',
    reversal: null,
    detail: { assignedModeratorId: updated.assignedModeratorId ?? 'none' },
  });

  return ok(updated);
}

export function startCaseReview(
  ctx: ModerationContext,
  command: CaseCommand,
): Result<Case, DomainError> {
  const permitted = canWorkCase(command.moderationCase, command.actor);
  if (!permitted.ok) {
    return permitted;
  }
  const next = caseMachine.next(command.moderationCase.state, 'start_review', {
    moderatorId: command.actor.actorId,
  });
  if (!next.ok) {
    return next;
  }
  const updatedAt = ctx.now();
  const updated: Case = { ...command.moderationCase, state: next.value, updatedAt };

  ctx.events.emit<CaseReviewStartedPayload>({
    type: 'moderation.case_review_started',
    actorId: command.actor.actorId,
    subjectId: updated.subjectId,
    correlationId: command.correlationId,
    sensitivity: 'restricted',
    payload: { caseId: updated.caseId, state: updated.state },
  });
  ctx.audit.append({
    occurredAt: updatedAt,
    actorId: command.actor.actorId,
    action: 'case.review_started',
    entityType: 'case',
    entityId: updated.caseId,
    subjectId: updated.subjectId,
    caseId: updated.caseId,
    evidenceIds: updated.evidenceIds,
    decisionId: null,
    outcome: 'allowed',
    reversal: null,
    detail: { state: updated.state },
  });

  return ok(updated);
}

export function escalateCase(
  ctx: ModerationContext,
  command: ReasonedCaseCommand,
): Result<Case, DomainError> {
  const permitted = canWorkCase(command.moderationCase, command.actor);
  if (!permitted.ok) {
    return permitted;
  }
  const next = caseMachine.next(command.moderationCase.state, 'escalate', {
    moderatorId: command.actor.actorId,
    reason: command.reason,
  });
  if (!next.ok) {
    return next;
  }
  const updatedAt = ctx.now();
  const updated: Case = { ...command.moderationCase, state: next.value, updatedAt };

  ctx.events.emit({
    type: 'moderation.case_escalated',
    actorId: command.actor.actorId,
    subjectId: updated.subjectId,
    correlationId: command.correlationId,
    sensitivity: 'restricted',
    payload: { caseId: updated.caseId, reason: command.reason },
  });
  ctx.audit.append({
    occurredAt: updatedAt,
    actorId: command.actor.actorId,
    action: 'case.escalated',
    entityType: 'case',
    entityId: updated.caseId,
    subjectId: updated.subjectId,
    caseId: updated.caseId,
    evidenceIds: [],
    decisionId: null,
    outcome: 'allowed',
    reversal: null,
    detail: { reason: command.reason },
  });

  return ok(updated);
}

export function reopenCase(
  ctx: ModerationContext,
  command: ReasonedCaseCommand,
): Result<Case, DomainError> {
  const permitted = canWorkCase(command.moderationCase, command.actor);
  if (!permitted.ok) {
    return permitted;
  }
  const next = caseMachine.next(command.moderationCase.state, 'reopen', {
    moderatorId: command.actor.actorId,
    reason: command.reason,
  });
  if (!next.ok) {
    return next;
  }
  const updatedAt = ctx.now();
  const updated: Case = {
    ...command.moderationCase,
    state: next.value,
    resolutionDecisionId: null,
    updatedAt,
  };

  // A reopen is a case going back into a queue. It was invisible on the bus
  // while writing a `case.reopened` audit row, so a consumer watching cases
  // could never see the resolution pointer move.
  ctx.events.emit<CaseReopenedPayload>({
    type: 'moderation.case_reopened',
    actorId: command.actor.actorId,
    subjectId: updated.subjectId,
    correlationId: command.correlationId,
    sensitivity: 'restricted',
    payload: {
      caseId: updated.caseId,
      state: updated.state,
      clearedDecisionId: command.moderationCase.resolutionDecisionId,
    },
  });

  ctx.audit.append({
    occurredAt: updatedAt,
    actorId: command.actor.actorId,
    action: 'case.reopened',
    entityType: 'case',
    entityId: updated.caseId,
    subjectId: updated.subjectId,
    caseId: updated.caseId,
    evidenceIds: [],
    decisionId: null,
    outcome: 'allowed',
    reversal: null,
    detail: { reason: command.reason },
  });

  return ok(updated);
}

export interface MergeOutcome {
  readonly moderationCase: Case;
  /** The reports as they stand after this merge. None is discarded. */
  readonly mergedReports: readonly Report[];
  readonly mergedReportIds: readonly ReportId[];
}

/**
 * Merge (issue #7). Several reports describing one behaviour collapse into one
 * case, and no report is lost: each keeps its own id, reporter, statement and
 * captured evidence, and each moves to `merged` pointing at the case. The case's
 * evidence is the union, deduplicated by id and order-preserving, so a moderator
 * reads each artefact once and can still see which report brought it.
 *
 * A merge rewrites a case, so it goes through `canWorkCase` like every other
 * case operation even though it changes no standing: intake is automated
 * (`openedBy: 'system'`), working a case is not.
 */
export function mergeReports(
  ctx: ModerationContext,
  moderationCase: Case,
  reports: readonly Report[],
  actor: ModeratorActor,
  correlationId: CorrelationId,
): Result<MergeOutcome, DomainError> {
  const permitted = canWorkCase(moderationCase, actor);
  if (!permitted.ok) {
    return permitted;
  }
  if (moderationCase.state === 'resolved') {
    return domainError(
      'conflict',
      'moderation.case',
      'a resolved case cannot take further reports; reopen it first',
      { caseId: moderationCase.caseId, state: moderationCase.state },
    );
  }
  const stranger = reports.find((report) => report.subjectId !== moderationCase.subjectId);
  if (stranger !== undefined) {
    return domainError(
      'conflict',
      'moderation.case',
      'reports can only merge into a case about the same subject',
      { caseId: moderationCase.caseId, reportId: stranger.reportId },
    );
  }

  const mergedReports: Report[] = [];
  const mergedReportIds: ReportId[] = [];
  const evidenceIds: EvidenceId[] = [...moderationCase.evidenceIds];
  const reasons: ReportReason[] =
    moderationCase.origin.source === 'user_report' ? [...moderationCase.origin.reasons] : [];

  for (const report of reports) {
    if (report.state === 'merged') {
      if (report.mergedCaseId === moderationCase.caseId) {
        continue;
      }
      return domainError(
        'conflict',
        'moderation.case',
        `report '${report.reportId}' already belongs to case '${report.mergedCaseId ?? 'unknown'}'`,
        { caseId: moderationCase.caseId, reportId: report.reportId },
      );
    }
    const next = reportMachine.next(report.state, 'merge', {
      caseId: moderationCase.caseId,
      moderatorId: actor.actorId,
    });
    if (!next.ok) {
      return domainError(
        next.error.code,
        'moderation.case',
        `report '${report.reportId}' at '${report.state}' cannot be merged into this case`,
        { caseId: moderationCase.caseId, reportId: report.reportId, state: report.state },
      );
    }
    const updatedAt = ctx.now();
    mergedReports.push({
      ...report,
      state: next.value,
      mergedCaseId: moderationCase.caseId,
      updatedAt,
    });
    if (!moderationCase.reportIds.includes(report.reportId)) {
      mergedReportIds.push(report.reportId);
    }
    for (const item of report.capturedEvidence) {
      if (!evidenceIds.includes(item.evidenceId)) {
        evidenceIds.push(item.evidenceId);
      }
    }
    reasons.push(report.reason);
  }

  const updatedAt = ctx.now();
  const priority = highestPriority(moderationCase.priority, strongestPriority(reasons));
  const updated: Case = {
    ...moderationCase,
    priority,
    dueAt:
      PRIORITY_RANK[priority] > PRIORITY_RANK[moderationCase.priority]
        ? dueFrom(moderationCase.openedAt, priority)
        : moderationCase.dueAt,
    reportIds: [...moderationCase.reportIds, ...mergedReportIds],
    evidenceIds,
    updatedAt,
  };

  for (const report of mergedReports) {
    ctx.audit.append({
      occurredAt: report.updatedAt,
      actorId: actor.actorId,
      action: 'report.merged',
      entityType: 'report',
      entityId: report.reportId,
      subjectId: report.subjectId,
      caseId: updated.caseId,
      evidenceIds: report.capturedEvidence.map((item) => item.evidenceId),
      decisionId: null,
      outcome: 'allowed',
      reversal: null,
      detail: { reason: report.reason, caseId: updated.caseId },
    });
  }
  ctx.audit.append({
    occurredAt: updatedAt,
    actorId: actor.actorId,
    action: 'case.reports_merged',
    entityType: 'case',
    entityId: updated.caseId,
    subjectId: updated.subjectId,
    caseId: updated.caseId,
    evidenceIds: [],
    decisionId: null,
    outcome: 'allowed',
    reversal: null,
    detail: { merged: mergedReportIds.length, reportTotal: updated.reportIds.length },
  });
  // A merge is not a resolution. This used to publish `moderation.case_resolved`
  // with a merge payload, so a bus consumer read "this case is over" at the
  // moment reports were folded into it, and `case_reports_merged` — the event
  // declared for exactly this — was published from nowhere in the package.
  ctx.events.emit({
    type: 'moderation.case_reports_merged',
    actorId: actor.actorId,
    subjectId: updated.subjectId,
    correlationId,
    sensitivity: 'restricted',
    payload: { caseId: updated.caseId, mergedReportIds, reportTotal: updated.reportIds.length },
  });

  return ok({ moderationCase: updated, mergedReports, mergedReportIds });
}
