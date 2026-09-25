import { randomUUID } from 'node:crypto';
import {
  type AccountEvent,
  type AccountState,
  type ActorId,
  type CaseId,
  type DataSensitivity,
  type ReportId,
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
  type IdSource,
  type ModerationContext,
  type NewAuditEntry,
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
 * A context bound to one request's clock, plus the audit buffer to flush.
 *
 * `now` is the request's instant, not a fresh `new Date()`: a decision, its case
 * update and its audit rows all carry the same `occurredAt`, and a report that
 * says it was submitted three milliseconds after the decision that produced it is
 * a record nobody can reason about later.
 */
export function requestModerationContext(at: Date): {
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
  });
  return { context, audit, pending: emitted };
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

function corrupt(detail: string): StoreError {
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

function stringListOf(row: Readonly<Record<string, unknown>>, field: string): readonly string[] {
  const value = row[field];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw corrupt(`'${field}' is not a list of strings`);
  }
  return value;
}


const DECISION_ACTIONS: readonly Decision['action'][] = ['warn', 'restrict', 'suspend', 'ban', 'clear'];
const ACCOUNT_STATES: readonly AccountState[] = ['active', 'limited', 'suspended', 'banned'];
const ACCOUNT_EVENTS: readonly AccountEvent[] = [
  'restrict',
  'lift_restriction',
  'suspend',
  'reinstate',
  'ban',
  'lift_ban',
];

/**
 * The two facts of a `Decision` the `decisions` table does not hold.
 *
 * `resultingAccountState` is `detail.toState` on the decision's own audit row,
 * and `accountEvent` is `reversal.accountEvent` on it — the audit log is where
 * the account move was recorded, so it is where a later reader takes it from.
 * The one case the audit cannot answer is a reversal: its row records the
 * `reversal` fold as null, and the event that actually moved the account is
 * the lift the decision it reverses named. The caller supplies that, because
 * there is nowhere else in the schema it was written down.
 */
export interface DecisionFacts {
  readonly resultingAccountState: AccountState;
  readonly accountEvent: AccountEvent | null;
}

/**
 * Reads those two facts off a decision's audit row. A row that does not name a
 * standing is corrupt rather than empty: a decision without one could not have
 * been taken, so a reversal that guessed it would be guessing a sanction.
 */
export function decisionFactsFrom(audit: Readonly<Record<string, unknown>>): DecisionFacts {
  const detail = audit['detail'];
  if (typeof detail !== 'object' || detail === null) {
    throw corrupt('a decision audit row carries no detail');
  }
  const toState = (detail as Readonly<Record<string, unknown>>)['toState'];
  const state = ACCOUNT_STATES.find((candidate) => candidate === toState);
  if (state === undefined) {
    throw corrupt(`'${String(toState)}' is not the standing a decision produced`);
  }
  const reversal = audit['reversal'];
  if (reversal === undefined || reversal === null) {
    return { resultingAccountState: state, accountEvent: null };
  }
  const named = (reversal as Readonly<Record<string, unknown>>)['accountEvent'];
  const event = ACCOUNT_EVENTS.find((candidate) => candidate === named);
  if (event === undefined) {
    throw corrupt(`'${String(named)}' is not an account event`);
  }
  return { resultingAccountState: state, accountEvent: event };
}

/**
 * The stored decision, rebuilt into the aggregate a reversal takes.
 *
 * The decoding is strict for the same reason `caseOf` is: a row whose action is
 * not one the domain defines is a `StoreError` rather than a `Decision` with a
 * cast on it, because the action is what decides which lift a reversal performs
 * and who is allowed to perform it.
 */
export function decisionOf(
  row: Readonly<Record<string, unknown>>,
  facts: DecisionFacts,
): Decision {
  const action = DECISION_ACTIONS.find((candidate) => candidate === row['action']);
  if (action === undefined) {
    throw corrupt(`'${String(row['action'])}' is not a decision action`);
  }
  const decisionId = textOf(row, 'decisionId');
  const caseId = castId<'CaseId'>(textOf(row, 'caseId'));
  return {
    decisionId,
    caseId,
    moderatorId: castId<'ActorId'>(textOf(row, 'moderatorId')),
    subjectId: castId<'UserId'>(textOf(row, 'subjectId')),
    action,
    removedCapabilities: stringListOf(row, 'removedCapabilities'),
    rationale: textOf(row, 'rationale'),
    decidedAt: dateOf(row, 'decidedAt', castId<'ReportId'>(decisionId)),
    reverses: typeof row['reverses'] === 'string' ? castId<'DecisionId'>(row['reverses']) : null,
    accountEvent: facts.accountEvent,
    resultingAccountState: facts.resultingAccountState,
  };
}

/**
 * Every decision a case has taken, rebuilt, in the order they were taken.
 *
 * The two facts the table does not hold are read from each decision's own audit
 * row, because the audit log is where the account move was recorded. A reversal
 * is the one case the audit cannot answer — its row records the `reversal` fold
 * as null — and it is answered by the decision it reverses, which is in this
 * same set: a reversal names a decision that already exists, on the same case.
 */
export async function loadDecisions(
  store: ModerationStore,
  caseId: CaseId,
  tx: Transaction,
): Promise<readonly Decision[]> {
  const rows = await store.findDecisionsFor(caseId, tx);
  const facts = new Map<string, DecisionFacts>();
  for (const row of rows) {
    const decisionId = textOf(row, 'decisionId');
    // The decision's own row and not any other row naming it: both the decision
    // and the case resolution it caused are recorded against the decision's
    // entity, and only one of them carries a standing.
    const audit = (await store.findAuditForEntity('decision', decisionId, tx)).find(
      (entry) => entry['action'] === 'decision.recorded' || entry['action'] === 'decision.reversed',
    );
    if (audit === undefined) {
      throw corrupt(`decision ${decisionId} has no row in the audit log`);
    }
    facts.set(decisionId, decisionFactsFrom(audit));
  }
  return rows.map((row) => {
    const decisionId = textOf(row, 'decisionId');
    const recorded = facts.get(decisionId);
    if (recorded === undefined) {
      throw corrupt(`decision ${decisionId} has no recorded account move`);
    }
    const reverses = typeof row['reverses'] === 'string' ? row['reverses'] : null;
    return decisionOf(row, {
      resultingAccountState: recorded.resultingAccountState,
      accountEvent:
        recorded.accountEvent ?? (reverses === null ? null : (facts.get(reverses)?.accountEvent ?? null)),
    });
  });
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

const EVIDENCE_KINDS: readonly EvidenceKind[] = Object.keys(EVIDENCE_POLICY) as EvidenceKind[];
const EVIDENCE_SOURCE_DOMAINS: readonly EvidenceSourceDomain[] = [
  'moderation',
  'communication',
  'trust-safety',
  'identity',
  'dating-core',
];
const DATA_SENSITIVITIES: readonly DataSensitivity[] = ['public', 'user', 'internal', 'sensitive', 'restricted'];

/**
 * A stored evidence record, rebuilt into the aggregate the redaction gate takes.
 *
 * The decoding is strict where `reportOf` is lenient, and deliberately so. The
 * gate reads `record.access` and `record.capturedAt` and nothing else, and both
 * of those are exactly what `jsonb` does not give back: a date comes back as
 * the string `JSON.stringify` wrote, and `access` is a field a stored row could
 * disagree with. So a record whose `access` is not the one `EVIDENCE_POLICY`
 * declares for its kind is corrupt rather than merely unusual — a record that
 * claimed `reviewer` for a liveness artefact would be served raw, and a
 * StoreError is the only answer that does not depend on someone noticing.
 */
export function evidenceRecordOf(value: unknown, caseId: CaseId): EvidenceRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw corrupt('a captured evidence entry is not an object (case ' + caseId + ')');
  }
  const row = value as Readonly<Record<string, unknown>>;
  const kind = EVIDENCE_KINDS.find((candidate) => candidate === row['kind']);
  if (kind === undefined) {
    throw corrupt(`'${String(row['kind'])}' is not an evidence kind (case ${caseId})`);
  }
  const policy = EVIDENCE_POLICY[kind];
  if (row['access'] !== policy.access) {
    throw corrupt(`evidence ${String(row['evidenceId'])} claims access ${String(row['access'])}, not ${policy.access}`);
  }
  if (row['sensitivity'] !== policy.sensitivity) {
    throw corrupt(
      `evidence ${String(row['evidenceId'])} claims sensitivity ${String(row['sensitivity'])}, not ${policy.sensitivity}`,
    );
  }
  const source = EVIDENCE_SOURCE_DOMAINS.find((candidate) => candidate === row['sourceDomain']);
  if (source === undefined) {
    throw corrupt(`'${String(row['sourceDomain'])}' is not an evidence source domain (case ${caseId})`);
  }
  const sensitivity = DATA_SENSITIVITIES.find((candidate) => candidate === row['sensitivity']);
  if (sensitivity === undefined) {
    throw corrupt(`'${String(row['sensitivity'])}' is not a data sensitivity (case ${caseId})`);
  }
  const retention = row['retentionExpiresAt'];
  if (retention !== null && retention !== undefined && typeof retention !== 'string') {
    throw corrupt(`evidence ${String(row['evidenceId'])} has an unreadable retention date`);
  }
  return {
    evidenceId: textOf(row, 'evidenceId'),
    kind,
    subjectId: castId<'UserId'>(textOf(row, 'subjectId')),
    capturedAt: new Date(textOf(row, 'capturedAt')),
    capture: captureOf(row, kind, caseId),
    sourceDomain: source,
    artefactReference: textOf(row, 'artefactReference'),
    digest: textOf(row, 'digest'),
    redactedSummary: textOf(row, 'redactedSummary'),
    access: policy.access,
    sensitivity,
    retentionExpiresAt: retention === null || retention === undefined ? null : new Date(retention),
  };
}

/**
 * Where the evidence came from, which is fixed at capture and is what tells a
 * reviewer's summary from a moderator's own note.
 */
function captureOf(
  row: Readonly<Record<string, unknown>>,
  kind: EvidenceKind,
  caseId: CaseId,
): EvidenceCapture {
  const capture = row['capture'];
  if (typeof capture !== 'object' || capture === null) {
    throw corrupt(`evidence of kind ${kind} carries no capture (case ${caseId})`);
  }
  const at = (capture as Readonly<Record<string, unknown>>)['at'];
  if (at === 'report_submission') {
    return { at, reportId: castId<'ReportId'>(textOf(capture as Readonly<Record<string, unknown>>, 'reportId')) };
  }
  if (at === 'case_intake') {
    return { at, caseId: castId<'CaseId'>(textOf(capture as Readonly<Record<string, unknown>>, 'caseId')) };
  }
  if (at === 'review') {
    return {
      at,
      caseId: castId<'CaseId'>(textOf(capture as Readonly<Record<string, unknown>>, 'caseId')),
      moderatorId: castId<'ActorId'>(textOf(capture as Readonly<Record<string, unknown>>, 'moderatorId')),
    };
  }
  throw corrupt(`'${String(at)}' is not an evidence capture (case ${caseId})`);
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

function textOf(row: Readonly<Record<string, unknown>>, field: string): string {
  const value = row[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw corrupt(`'${field}' is not a non-empty string`);
  }
  return value;
}

function dateOf(row: Readonly<Record<string, unknown>>, field: string, reportId: ReportId): Date {
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
  throw corrupt(`'${field}' is not an instant (report ${reportId})`);
}
