import {
  type ActorId,
  type ConversationId,
  type CorrelationId,
  type DomainEvent,
  type ReportId,
  type Result,
  type RiskState,
  type UserId,
  castId,
} from '@been-there/core';
import {
  type AuditLog,
  type CaseIntake,
  type Case,
  type ContextOptions,
  type EmitSpec,
  type HumanActorId,
  type ModerationContext,
  type ModerationEventType,
  type ModeratorActor,
  type Report,
  type ReportEvidenceInput,
  type ReportReason,
  type RelationshipSnapshot,
  assignCase,
  createAuditLog,
  createContext,
  openCase,
  startCaseReview,
  submitReport,
  triageReport,
} from '../src/index.js';
import { asHumanActor } from '../src/ids.js';

/**
 * Test seams. Reading `.value` off a `Result` is a compile error by design, so
 * a test should fail with the error code rather than dereference blindly.
 */
export function succeeded<T, E extends { code: string; message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

export function rejected<T, E extends { code: string; message: string }>(result: Result<T, E>): E {
  if (result.ok) {
    throw new Error('expected a rejection, got success');
  }
  return result.error;
}

export interface TestClock {
  now(): Date;
  advanceHours(hours: number): void;
}

export function createTestClock(start: string = '2026-01-05T09:00:00.000Z'): TestClock {
  let current = new Date(start).getTime();
  return {
    now: () => new Date(current),
    advanceHours(hours) {
      current += hours * 60 * 60 * 1000;
    },
  };
}

export interface Harness {
  readonly ctx: ModerationContext;
  readonly audit: AuditLog;
  readonly clock: TestClock;
  /** Every event published through the context, in order. */
  readonly published: readonly DomainEvent[];
  /** The event types published so far, in order. */
  typesPublished(): readonly ModerationEventType[];
}

/**
 * A spy over the real emitter rather than a second implementation of it: the
 * recorded envelopes are the ones a deployment would publish, and the functions
 * that return nothing (`captureEvidence`, `assignCase`, `readEvidence`) become
 * observable here.
 */
export function harness(options: ContextOptions = {}): Harness {
  const clock = createTestClock();
  const audit = createAuditLog();
  const { events, ...rest } = createContext({ ...options, audit, now: clock.now });
  const published: DomainEvent[] = [];
  const ctx: ModerationContext = {
    ...rest,
    events: {
      emit<P extends Readonly<Record<string, unknown>>>(spec: EmitSpec<P>): DomainEvent<P> {
        const event = events.emit(spec);
        published.push(event);
        return event;
      },
    },
  };
  return {
    ctx,
    audit,
    clock,
    published,
    typesPublished: () => published.map((event) => event.type as ModerationEventType),
  };
}

export const REPORTER: UserId = castId<'UserId'>('u-reporter');
export const SUBJECT: UserId = castId<'UserId'>('u-subject');
export const OTHER_SUBJECT: UserId = castId<'UserId'>('u-other');
export const MODERATOR: ModeratorActor = {
  actorId: castId<'ActorId'>('mod-rivera'),
  isLead: false,
  identityPrivacyRole: false,
  automated: false,
};
export const LEAD: ModeratorActor = {
  actorId: castId<'ActorId'>('mod-lead'),
  isLead: true,
  identityPrivacyRole: false,
  automated: false,
};
export const IDENTITY_OFFICER: ModeratorActor = {
  actorId: castId<'ActorId'>('privacy-1'),
  isLead: false,
  identityPrivacyRole: true,
  automated: false,
};

/**
 * The id a decision is recorded under. It can only be built through the
 * package's own minting crossing point, which the barrel deliberately does not
 * export — so this import is the one legitimate way in, and it exists here
 * because these tests live inside the package.
 */
export const HUMAN_MODERATOR: HumanActorId = asHumanActor(MODERATOR.actorId);

export const CORRELATION: CorrelationId = castId<'CorrelationId'>('corr-1');

export const CONVERSATION: ConversationId = castId<'ConversationId'>('conv-1');

/** A relationship that is already over: the post-unmatch case. */
export function unmatchedRelationship(): RelationshipSnapshot {
  return {
    status: 'unmatched',
    capturedAt: new Date('2026-01-04T22:00:00.000Z'),
    conversationId: CONVERSATION,
    messageRange: { from: 'msg-1', to: 'msg-3' },
  };
}

export function messageEvidence(overrides: Partial<ReportEvidenceInput> = {}): ReportEvidenceInput {
  return {
    kind: 'message_snapshot',
    sourceDomain: 'communication',
    artefactReference: 'blob://messages/1',
    digest: 'sha256:msg-1',
    redactedSummary: 'Message: "you should leave"',
    ...overrides,
  };
}

export interface MakeReportOptions {
  readonly reportId?: ReportId;
  readonly subjectId?: UserId;
  readonly reporterId?: UserId | null;
  readonly reason?: ReportReason;
  readonly relationship?: RelationshipSnapshot;
  readonly evidence?: readonly ReportEvidenceInput[];
  readonly statement?: string | null;
}

let reportCounter = 0;

export function makeReport(h: Harness, options: MakeReportOptions = {}): Result<Report, { code: string; message: string }> {
  reportCounter += 1;
  const submitted = submitReport(h.ctx, {
    reportId: options.reportId ?? castId<'ReportId'>(`r-${reportCounter}`),
    subjectId: options.subjectId ?? SUBJECT,
    reporterId: options.reporterId === undefined ? REPORTER : options.reporterId,
    reason: options.reason ?? 'harassment',
    statement: options.statement === undefined ? 'He kept messaging after I said no.' : options.statement,
    relationship: options.relationship ?? unmatchedRelationship(),
    evidence: options.evidence ?? [messageEvidence()],
    correlationId: CORRELATION,
  });
  return submitted.ok ? { ok: true, value: submitted.value.report } : submitted;
}

export function submitAndTriage(h: Harness, options: MakeReportOptions = {}): Report {
  const report = succeeded(makeReport(h, options));
  return succeeded(
    triageReport(h.ctx, { report, moderatorId: MODERATOR.actorId, correlationId: CORRELATION }),
  );
}

/** Report → triage → case: the path a queue actually walks. */
export function openCaseFromReport(h: Harness, report: Report, actor: ModeratorActor = MODERATOR): Case {
  const triaged = succeeded(
    triageReport(h.ctx, { report, moderatorId: actor.actorId, correlationId: CORRELATION }),
  );
  return succeeded(
    openCase(h.ctx, {
      source: 'user_report',
      report: triaged,
      openedBy: actor.actorId,
      correlationId: CORRELATION,
    }),
  ).moderationCase;
}

/** The triaged report and the case it opened, for tests about the report itself. */
export function triagedCaseFromReport(
  h: Harness,
  options: MakeReportOptions = {},
): { readonly report: Report; readonly moderationCase: Case } {
  const report = submitAndTriage(h, options);
  const opened = succeeded(
    openCase(h.ctx, {
      source: 'user_report',
      report,
      openedBy: MODERATOR.actorId,
      correlationId: CORRELATION,
    }),
  );
  return { report, moderationCase: opened.moderationCase };
}

/** Case → assigned → in_review, so a decision becomes eligible. */
export function caseInReview(h: Harness, moderationCase: Case, actor: ModeratorActor = MODERATOR): Case {
  const assigned = succeeded(assignCase(h.ctx, { moderationCase, actor, correlationId: CORRELATION }));
  return succeeded(startCaseReview(h.ctx, { moderationCase: assigned, actor, correlationId: CORRELATION }));
}

export function trustSafetyIntake(
  riskState: RiskState = 'critical',
): Extract<CaseIntake, { source: 'trust_safety_review' }> {
  return {
    source: 'trust_safety_review',
    subjectId: SUBJECT,
    riskAssessmentId: castId<'RiskAssessmentId'>('risk-9'),
    riskState,
    detectors: ['velocity', 'duplicate_device'],
    digest: 'sha256:risk-9',
    openedBy: 'system',
    correlationId: CORRELATION,
  };
}

export function identityIntake(
  anomaly = 'liveness provider disagreement',
): Extract<CaseIntake, { source: 'identity_anomaly' }> {
  return {
    source: 'identity_anomaly',
    subjectId: SUBJECT,
    verificationId: castId<'VerificationId'>('ver-3'),
    anomaly,
    digest: 'sha256:ver-3',
    openedBy: 'system',
    correlationId: CORRELATION,
  };
}
