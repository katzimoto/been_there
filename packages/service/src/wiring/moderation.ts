import { randomUUID } from 'node:crypto';
import {
  type AccountEvent,
  type AccountState,
  type ActorId,
  type CaseId,
  type CorrelationId,
  type DataSensitivity,
  type DomainEvent,
  type EventId,
  type EventPublisher,
  type ReportId,
  type SubjectId,
  type UserId,
  castId,
} from '@been-there/core';
import { StoreError, type CaseRow, type ModerationStore, type Transaction } from '@been-there/contracts';
import {
  type AuditEntry,
  type AuditLog,
  type Case,
  type CaseOrigin,
  type CasePriority,
  type CaseQueue,
  type CaseState,
  type Decision,
  type DecisionId,
  type EvidenceCapture,
  type EvidenceId,
  type EvidenceKind,
  type EvidenceRecord,
  type EvidenceSourceDomain,
  type EmitSpec,
  type EventEmitter,
  type IdSource,
  type ModerationContext,
  type NewAuditEntry,
  type PairingKey,
  type Report,
  type ReportReason,
  REPORT_REASON_POLICY,
  EVIDENCE_POLICY,
  SLA_HOURS_BY_PRIORITY,
  caseMachine,
  createAuditLog,
  createContext,
  reportMachine,
} from '@been-there/moderation';

/**
 * Moderation, wired to the transaction.
 *
 * ## The audit log is in memory until it is flushed
 *
 * `ModerationContext.audit` is a synchronous `AuditLog` — `append` returns an
 * entry, it does not await anything — so the domain writes its audit rows into a
 * buffer while it runs, and `flushAudit` writes them to the store afterwards,
 * inside the same transaction. That is the only way both halves of the promise
 * hold: a decision and its audit row commit together or not at all, and the
 * domain never has to know a database exists.
 *
 * The ordering matters. The domain appends as it goes, so the buffer is flushed
 * in the order the entries were made, and the sequence numbers the domain
 * assigned are preserved — the appeal record is read as a sequence.
 *
 * ## Ids are UUIDs because the schema says so
 *
 * `cases.case_id`, `cases.report_ids`, `cases.evidence_ids` and
 * `decisions.decision_id` are all `uuid`, while `EvidenceId` and `DecisionId` are
 * plain strings the domain mints through `IdSource`. So the id source here yields
 * UUIDs. That is not a service decision about identity; it is the shape the
 * columns demand, and a counter would fail at the first insert.
 */

/** UUIDs, because every id the moderation tables key on is a `uuid` column. */
export function uuidIdSource(): IdSource {
  return { next: () => randomUUID() };
}

/**
 * What a request's moderation context is given beyond its clock.
 *
 * Both of these exist because the context is the only place a moderation event
 * can be published from, and a context that publishes into the void is the
 * default rather than a choice: it is why `POST /v1/reports` emitted nothing at
 * all — including the `moderation.report_pairing` join that the safety layer's
 * strongest detector needs.
 */
export interface ModerationWiring {
  /**
   * The per-deployment secret the pairing token is keyed with.
   *
   * A deployment without one publishes no pairing event, so the join simply does
   * not exist there. That is the honest outcome and is deliberately not replaced
   * by a default secret anybody could guess.
   */
  readonly pairingKey?: PairingKey;
  /** Where this context's published events go. Absent builds and drops them. */
  readonly publish?: EventPublisher;
}

/**
 * A context bound to one request's clock, plus the audit buffer to flush.
 *
 * `now` is the request's instant, not a fresh `new Date()`: a decision, its case
 * update and its audit rows all carry the same `occurredAt`, and a report that
 * says it was submitted three milliseconds after the decision that produced it is
 * a record nobody can reason about later.
 */
export function requestModerationContext(
  at: Date,
  wiring: ModerationWiring = {},
): {
  readonly context: ModerationContext;
  readonly audit: AuditLog;
  readonly pending: AuditEntry[];
} {
  const audit = createAuditLog();
  const emitted: AuditEntry[] = [];
  const context = createContext({
    audit: {
      append(entry: NewAuditEntry) {
        const stored = audit.append(entry);
        emitted.push(stored);
        return stored;
      },
      get entries() {
        return audit.entries;
      },
      byActor: (actorId) => audit.byActor(actorId),
      bySubject: (subjectId) => audit.bySubject(subjectId),
      byEntity: (entityType, entityId) => audit.byEntity(entityType, entityId),
      forCase: (caseId) => audit.forCase(caseId),
    },
    ids: uuidIdSource(),
    now: () => at,
    ...(wiring.pairingKey === undefined ? {} : { pairingKey: wiring.pairingKey }),
    ...(wiring.publish === undefined ? {} : { events: publishingEmitter(wiring.publish, at) }),
  });
  return { context, audit, pending: emitted };
}

/**
 * `createContext`'s own envelope construction, with the event handed to a bus.
 *
 * The default emitter builds an event and drops it. Reusing the shape here rather
 * than writing a second one matters because the envelope *is* the contract: an
 * event published to the metrics sink with a different `occurredAt` than the one
 * moderation recorded would make the detection-before-report reduction compare
 * two different instants for one decision.
 */
export function publishingEmitter(publish: EventPublisher, at: Date): EventEmitter {
  const ids = uuidIdSource();
  return {
    emit<P extends Readonly<Record<string, unknown>>>(spec: EmitSpec<P>): DomainEvent<P> {
      const event: DomainEvent<P> = {
        eventId: castId<'EventId'>(ids.next()),
        type: spec.type,
        version: 1,
        occurredAt: at,
        actorId: spec.actorId,
        ...(spec.subjectId === undefined ? {} : { subjectId: castId<'SubjectId'>(spec.subjectId) }),
        correlationId: spec.correlationId,
        ...(spec.causationId === undefined ? {} : { causationId: spec.causationId }),
        sensitivity: spec.sensitivity,
        payload: spec.payload,
      };
      // Fire-and-forget: `emit` is synchronous by contract and every caller in
      // this repository ignores the envelope's fate. The in-process bus
      // delivers to its subscribers on a microtask, so the metric reduction sees
      // the event after the handler that produced it has returned.
      void publish.publish(event);
      return event;
    },
  };
}

/**
 * Writes the buffered audit rows, in the order the domain made them.
 *
 * `dedupe_key` is derived from the entry's own identity rather than invented, so
 * a retried request that re-runs the same domain calls produces the same key and
 * collapses onto the rows already there. An entry whose facts are identical but
 * which is a genuine repeat — a moderator reading the same evidence twice — has
 * the same key and would collapse, so the sequence is folded in: two entries in
 * the same run differ, and two *runs* of the same action differ by their
 * transaction. In practice the store treats a null key as "always append", and
 * this is left null because a wrong dedupe key would silently lose an appeal
 * record, which is the one failure the audit table exists to prevent.
 */
export async function flushAudit(
  entries: readonly AuditEntry[],
  append: (row: Readonly<Record<string, unknown>>, tx: Transaction) => Promise<void>,
  tx: Transaction,
): Promise<void> {
  for (const entry of entries) {
    await append(
      {
        occurredAt: entry.occurredAt,
        actorId: entry.actorId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        subjectId: entry.subjectId,
        caseId: entry.caseId,
        evidenceIds: entry.evidenceIds,
        decisionId: entry.decisionId,
        outcome: entry.outcome,
        reversal: entry.reversal,
        detail: entry.detail,
        sequence: entry.sequence,
        dedupeKey: null,
      },
      tx,
    );
  }
}

export function corrupt(detail: string): StoreError {
  return new StoreError(`stored moderation row is malformed: ${detail}`, { retryable: false });
}

const CASE_STATES: readonly CaseState[] = [
  ...caseMachine.states,
];
const PRIORITIES: readonly CasePriority[] = ['low', 'normal', 'high', 'urgent'];
const QUEUES: readonly CaseQueue[] = ['safety', 'identity_integrity', 'appeals'];
const REPORT_STATES: readonly Report['state'][] = [...reportMachine.states];

export function reportStateOf(value: string, reportId: ReportId): Report['state'] {
  const state = REPORT_STATES.find((candidate) => candidate === value);
  if (state === undefined) {
    throw corrupt(`'${value}' is not a report state (report ${reportId})`);
  }
  return state;
}

/**
 * The `CaseOrigin` round trip through the port's `origin: string`.
 *
 * `decide` reads `caseId`, `subjectId`, `state` and `evidenceIds` and never
 * reads `origin` — but the aggregate it takes is a `Case`, so an origin has to
 * exist. Storing it as JSON text is lossless and, more importantly, is checked:
 * a row whose origin does not parse is a `StoreError`, not a placeholder. A
 * placeholder origin would sail through `decide` and land in the audit trail as
 * though the case had arrived by a route nobody recorded.
 */
export function encodeOrigin(origin: CaseOrigin): string {
  return JSON.stringify(origin);
}

export function decodeOrigin(value: string, caseId: CaseId): CaseOrigin {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw corrupt(`the origin of case ${caseId} is not JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw corrupt(`the origin of case ${caseId} is not an object`);
  }
  return parsed as CaseOrigin;
}

export function caseOf(row: CaseRow): Case {
  const priority = PRIORITIES.find((candidate) => candidate === row.priority);
  if (priority === undefined) {
    throw corrupt(`'${row.priority}' is not a case priority (case ${row.caseId})`);
  }
  const queue = QUEUES.find((candidate) => candidate === row.queue);
  if (queue === undefined) {
    throw corrupt(`'${row.queue}' is not a case queue (case ${row.caseId})`);
  }
  const state = CASE_STATES.find((candidate) => candidate === row.state);
  if (state === undefined) {
    throw corrupt(`'${row.state}' is not a case state (case ${row.caseId})`);
  }
  const dueAt = new Date(row.dueAt);
  if (Number.isNaN(dueAt.getTime())) {
    throw corrupt(`the due date of case ${row.caseId} is not an instant`);
  }
  return {
    caseId: row.caseId,
    subjectId: row.subjectId,
    origin: decodeOrigin(row.origin, row.caseId),
    state,
    priority,
    queue,
    openedAt: row.openedAt,
    // The SLA is recomputed rather than trusted from the row: it is a pure
    // function of the priority and the open instant, both of which the aggregate
    // carries, and a stored due date that disagreed with them would put a case in
    // the wrong queue order for reasons nobody could see.
    dueAt: new Date(row.openedAt.getTime() + SLA_HOURS_BY_PRIORITY[priority] * 3_600_000),
    openedBy: row.openedBy,
    assignedModeratorId: row.assignedModeratorId,
    reportIds: row.reportIds,
    evidenceIds: row.evidenceIds,
    resolutionDecisionId: row.resolutionDecisionId,
    updatedAt: row.updatedAt,
  };
}

/** The row a case is written as. The origin is JSON text, for the reason above. */
export function caseRowOf(moderationCase: Case): Readonly<Record<string, unknown>> {
  return {
    caseId: moderationCase.caseId,
    subjectId: moderationCase.subjectId,
    origin: encodeOrigin(moderationCase.origin),
    state: moderationCase.state,
    priority: moderationCase.priority,
    queue: moderationCase.queue,
    openedAt: moderationCase.openedAt,
    dueAt: moderationCase.dueAt,
    openedBy: moderationCase.openedBy,
    assignedModeratorId: moderationCase.assignedModeratorId,
    reportIds: moderationCase.reportIds,
    evidenceIds: moderationCase.evidenceIds,
    resolutionDecisionId: moderationCase.resolutionDecisionId,
    updatedAt: moderationCase.updatedAt,
  };
}

export function decisionRowOf(decision: Decision): Readonly<Record<string, unknown>> {
  return {
    decisionId: decision.decisionId,
    caseId: decision.caseId,
    subjectId: decision.subjectId,
    action: decision.action,
    removedCapabilities: decision.removedCapabilities,
    moderatorId: decision.moderatorId,
    rationale: decision.rationale,
    decidedAt: decision.decidedAt,
    reverses: decision.reverses,
  };
}

export function reportRowOf(report: Report): Readonly<Record<string, unknown>> {
  return {
    reportId: report.reportId,
    subjectId: report.subjectId,
    reporterId: report.reporterId,
    reason: report.reason,
    statement: report.statement,
    relationship: report.relationship,
    capturedEvidence: report.capturedEvidence,
    state: report.state,
    mergedCaseId: report.mergedCaseId,
    submittedAt: report.submittedAt,
    updatedAt: report.updatedAt,
  };
}

/** Evidence as a row fragment; the ids are already what the tables key on. */
export function evidenceIdsOf(records: readonly EvidenceRecord[]): readonly EvidenceId[] {
  return records.map((record) => record.evidenceId);
}

/**
 * The report as `findReport` returns it, rebuilt into the aggregate
 * `triageReport` and `openCase` take.
 *
 * The report is the one record whose whole point is that it outlives what
 * produced it, so its decoding is strict: a `relationship` that is not an object
 * or a `capturedEvidence` that is not an array means the frozen evidence is
 * unreadable, and a case opened on unreadable evidence is exactly the failure
 * commitment 4 exists to prevent.
 */
export function reportOf(row: Readonly<Record<string, unknown>>): Report {
  const reportId = castId<'ReportId'>(textOf(row, 'reportId'));
  const subjectId = castId<'UserId'>(textOf(row, 'subjectId'));
  const reporterId = row['reporterId'];
  if (reporterId !== null && typeof reporterId !== 'string') {
    throw corrupt(`reporterId is neither a string nor null (report ${reportId})`);
  }
  const reason = REPORT_REASONS.find((candidate) => candidate === row['reason']);
  if (reason === undefined) {
    throw corrupt(`'${String(row['reason'])}' is not a report reason (report ${reportId})`);
  }
  const relationship = row['relationship'];
  if (typeof relationship !== 'object' || relationship === null) {
    throw corrupt(`relationship is not an object (report ${reportId})`);
  }
  const captured = row['capturedEvidence'];
  if (!Array.isArray(captured)) {
    throw corrupt(`capturedEvidence is not an array (report ${reportId})`);
  }
  return {
    reportId,
    subjectId,
    reporterId: reporterId === null ? null : castId<'UserId'>(reporterId),
    reason,
    statement: typeof row['statement'] === 'string' ? row['statement'] : null,
    relationship: relationship as Report['relationship'],
    capturedEvidence: captured as readonly EvidenceRecord[],
    state: reportStateOf(textOf(row, 'state'), reportId),
    mergedCaseId: typeof row['mergedCaseId'] === 'string' ? row['mergedCaseId'] : null,
    submittedAt: dateOf(row, 'submittedAt', reportId),
    updatedAt: dateOf(row, 'updatedAt', reportId),
  };
}

const REPORT_REASONS: readonly ReportReason[] = Object.keys(REPORT_REASON_POLICY) as ReportReason[];

/**
 * The store-bound audit appender, so both route modules flush through the same
 * call and neither has its own idea of what an audit row is.
 */
export function auditAppender(append: (
  row: Readonly<Record<string, unknown>>,
  tx: Transaction,
) => Promise<void>): (row: Readonly<Record<string, unknown>>, tx: Transaction) => Promise<void> {
  return append;
}

/**
 * The row readers, exported because `moderation-decisions.ts` and
 * `moderation-evidence.ts` decode the same rows and must refuse them the same
 * way. A second copy of "a column that is not a string is a corrupt row" is a
 * second answer to the question of whether a store is lying.
 */
export function textOf(row: Readonly<Record<string, unknown>>, field: string): string {
  const value = row[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw corrupt(`'${field}' is not a non-empty string`);
  }
  return value;
}

export function dateOf(row: Readonly<Record<string, unknown>>, field: string, subject: string): Date {
  const value = row[field];
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  throw corrupt(`'${field}' is not an instant (${subject})`);
}
