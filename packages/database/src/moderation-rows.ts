import { castId, type ActorId, type CaseId, type ReportId, type UserId } from '@been-there/core';
import { StoreError, type CaseRow } from '@been-there/contracts';

/**
 * The schema codecs for the moderation store: what a row is called in the
 * database, what it is called in the domain, and what happens when one of them
 * turns out not to be there.
 *
 * Split out of `store-moderation.ts` so that file holds the port and its SQL
 * and this one holds the translation, which is the part that changes when the
 * schema does. Nothing else imports it: the column lists and the row shapes
 * belong to the moderation store and to no other.
 *
 * Inputs are the domain's own objects — a `Report` from `submitReport`, a
 * `Case` from `openCase`, a `Decision` from `decide`, a `NewAuditEntry` from
 * the audit log. Storage is not the policy layer, so nothing here re-checks
 * intake, priority or authority; it checks only that a value has the shape its
 * column requires. A wrong shape is a `StoreError`, because silently writing
 * `undefined` produces a not-null violation naming the wrong cause, or worse,
 * a plausible-looking empty row that reads as "nothing was recorded".
 */

// ------------------------------------------------------------ value readers --

export function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new StoreError(`\`${field}\` must be a non-empty string`);
  }
  return value;
}

/** A nullable text value: an absent key and an explicit `null` both mean null. */
export function optionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return requireText(value, field);
}

export function requireDate(value: unknown, field: string): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new StoreError(`\`${field}\` is an invalid Date`);
    }
    return value;
  }
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new StoreError(`\`${field}\` is not a date: ${value}`);
    }
    return parsed;
  }
  throw new StoreError(`\`${field}\` must be a Date`);
}

export function stringArray(value: unknown, field: string): readonly string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new StoreError(`\`${field}\` must be an array of strings`);
  }
  return value.map((entry) => {
    if (typeof entry !== 'string') {
      throw new StoreError(`\`${field}\` must contain only strings`);
    }
    return entry;
  });
}

/** A `jsonb` parameter, accepting either a value or an already-encoded string. */
export function jsonParameter(value: unknown, field: string): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value ?? null);
  } catch (error) {
    throw new StoreError(`\`${field}\` is not JSON-encodable`, { cause: error });
  }
}

/** A `jsonb` object read back from the driver, or a loud failure. */
export function jsonObject(value: unknown, column: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new StoreError(`column ${column} is not a JSON object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

export function jsonArray(value: unknown, column: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new StoreError(`column ${column} is not a JSON array`);
  }
  return value;
}

export function readText(value: unknown, column: string): string {
  if (typeof value !== 'string') {
    throw new StoreError(`column ${column} is not text`);
  }
  return value;
}

export function readDate(value: unknown, column: string): Date {
  if (!(value instanceof Date)) {
    throw new StoreError(`column ${column} is not a timestamp`);
  }
  return value;
}

export function readTextArray(value: unknown, column: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new StoreError(`column ${column} is not a text array`);
  }
  return value.map((entry) => readText(entry, column));
}

/** `opened_by` and `actor_id` hold an actor id or the literal `system`. */
export function readActor(value: unknown, column: string): ActorId | 'system' {
  const text = readText(value, column);
  return text === 'system' ? 'system' : castId<'ActorId'>(text);
}

/** `seq` is a `bigint`, which the driver hands over as a string. */
export function readSequence(value: unknown): number {
  const sequence = typeof value === 'string' ? Number(value) : value;
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence)) {
    throw new StoreError('column seq is not an audit sequence');
  }
  return sequence;
}

export /** `opened_by` and `actor_id` hold an actor id or the literal `system`. */
export function readActor(value: unknown, column: string): ActorId | 'system' {
  const text = readText(value, column);
  return text === 'system' ? 'system' : castId<'ActorId'>(text);
}

/** `seq` is a `bigint`, which the driver hands over as a string. */
export function readSequence(value: unknown): number {
  const sequence = typeof value === 'string' ? Number(value) : value;
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence)) {
    throw new StoreError('column seq is not an audit sequence');
  }
  return sequence;
}

export function readPage(page: Page): Page {
  if (!Number.isInteger(page.limit) || page.limit < 0) {
    throw new StoreError('page.limit must be a non-negative integer');
  }
  if (!Number.isInteger(page.offset) || page.offset < 0) {
    throw new StoreError('page.offset must be a non-negative integer');
  }
  return page;
}

/**
 * A store fault, labelled by the class of failure. The kind is in the message
 * because the port's `StoreError` carries no code and a caller that must handle
 * a conflict has no other way to tell one from a fault; the driver error stays
 * reachable as `cause`, where `isConflict` and `isRetryable` still read its
 * SQLSTATE.
 */
export function storeFault(operation: string, error: unknown): StoreError {
  if (error instanceof StoreError) {
    return error;
  }
  const kind = isConflict(error) ? 'conflict' : isRetryable(error) ? 'retryable fault' : 'fault';
  return new StoreError(`${operation}: ${kind}`, { retryable: isRetryable(error), cause: error });
}

// -------------------------------------------------------------- report rows --

export const REPORT_COLUMNS = `report_id, subject_id, reporter_id, reason, statement, relationship,
       captured_evidence, state, merged_case_id, submitted_at, updated_at`;

export function reportParameters(row: Readonly<Record<string, unknown>>): unknown[] {
  return [
    requireText(row['reportId'], 'reportId'),
    requireText(row['subjectId'], 'subjectId'),
    optionalText(row['reporterId'], 'reporterId'),
    requireText(row['reason'], 'reason'),
    optionalText(row['statement'], 'statement'),
    jsonParameter(row['relationship'], 'relationship'),
    jsonParameter(row['capturedEvidence'] ?? [], 'capturedEvidence'),
    requireText(row['state'], 'state'),
    optionalText(row['mergedCaseId'], 'mergedCaseId'),
    requireDate(row['submittedAt'], 'submittedAt'),
    requireDate(row['updatedAt'], 'updatedAt'),
  ];
}

export function readReport(row: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const reporterId = row['reporter_id'];
  return {
    reportId: castId<'ReportId'>(readText(row['report_id'], 'report_id')),
    subjectId: castId<'UserId'>(readText(row['subject_id'], 'subject_id')),
    reporterId: reporterId === null ? null : castId<'UserId'>(readText(reporterId, 'reporter_id')),
    reason: readText(row['reason'], 'reason'),
    statement: row['statement'],
    relationship: jsonObject(row['relationship'], 'relationship'),
    capturedEvidence: jsonArray(row['captured_evidence'], 'captured_evidence'),
    state: readText(row['state'], 'state'),
    mergedCaseId: row['merged_case_id'],
    submittedAt: readDate(row['submitted_at'], 'submitted_at'),
    updatedAt: readDate(row['updated_at'], 'updated_at'),
  };
}

// ---------------------------------------------------------------- case rows --

export const CASE_COLUMNS = `case_id, subject_id, origin, state, priority, queue, opened_at, due_at,
       opened_by, assigned_moderator_id, report_ids, evidence_ids,
       resolution_decision_id, updated_at`;

/**
 * The columns a case transition may write, and nothing else. `case_id`,
 * `subject_id`, `origin`, `opened_at` and `opened_by` are the facts intake
 * froze; a transition able to change them could rewrite what a case is about,
 * which is the one thing a later appeal reads.
 */
export const MUTABLE_CASE_COLUMNS: Readonly<Record<string, string>> = {
  state: 'state',
  priority: 'priority',
  queue: 'queue',
  dueAt: 'due_at',
  assignedModeratorId: 'assigned_moderator_id',
  reportIds: 'report_ids',
  evidenceIds: 'evidence_ids',
  resolutionDecisionId: 'resolution_decision_id',
  updatedAt: 'updated_at',
};

export function caseParameters(row: Readonly<Record<string, unknown>>): unknown[] {
  return [
    requireText(row['caseId'], 'caseId'),
    requireText(row['subjectId'], 'subjectId'),
    caseOriginParameter(row['origin']),
    requireText(row['state'], 'state'),
    requireText(row['priority'], 'priority'),
    requireText(row['queue'], 'queue'),
    requireDate(row['openedAt'], 'openedAt'),
    requireDate(row['dueAt'], 'dueAt'),
    requireText(row['openedBy'], 'openedBy'),
    optionalText(row['assignedModeratorId'], 'assignedModeratorId'),
    stringArray(row['reportIds'], 'reportIds'),
    stringArray(row['evidenceIds'], 'evidenceIds'),
    optionalText(row['resolutionDecisionId'], 'resolutionDecisionId'),
    requireDate(row['updatedAt'], 'updatedAt'),
  ];
}

export function readCase(row: Record<string, unknown>): CaseRow {
  const assigned = row['assigned_moderator_id'];
  const resolution = row['resolution_decision_id'];
  return {
    caseId: castId<'CaseId'>(readText(row['case_id'], 'case_id')),
    subjectId: castId<'UserId'>(readText(row['subject_id'], 'subject_id')),
    origin: readText(row['origin'], 'origin'),
    state: readText(row['state'], 'state'),
    priority: readText(row['priority'], 'priority'),
    queue: readText(row['queue'], 'queue'),
    openedAt: readDate(row['opened_at'], 'opened_at'),
    dueAt: readDate(row['due_at'], 'due_at'),
    openedBy: readActor(row['opened_by'], 'opened_by'),
    assignedModeratorId: assigned === null ? null : castId<'ActorId'>(readText(assigned, 'assigned_moderator_id')),
    reportIds: readTextArray(row['report_ids'], 'report_ids').map((id) => castId<'ReportId'>(id)),
    evidenceIds: readTextArray(row['evidence_ids'], 'evidence_ids'),
    resolutionDecisionId: resolution === null ? null : readText(resolution, 'resolution_decision_id'),
    updatedAt: readDate(row['updated_at'], 'updated_at'),
  };
}

/**
 * The domain's `Case.origin` is a structured union; the column is `text`. A
 * caller already holding a discriminator string gets it stored verbatim, and a
 * structured origin is stored as its JSON — because dropping the reasons or the
 * risk state that opened the case would leave an appeal reading "something
 * happened" instead of "this is what was known at intake".
 */
export function caseOriginParameter(origin: unknown): string {
  return typeof origin === 'string' ? requireText(origin, 'origin') : jsonParameter(origin, 'origin');
}

// ------------------------------------------------------------ decision rows --

export const DECISION_COLUMNS = `decision_id, case_id, subject_id, action, reverses,
       removed_capabilities, moderator_id, rationale, decided_at`;

export function decisionParameters(row: Readonly<Record<string, unknown>>): unknown[] {
  return [
    requireText(row['decisionId'], 'decisionId'),
    requireText(row['caseId'], 'caseId'),
    requireText(row['subjectId'], 'subjectId'),
    requireText(row['action'], 'action'),
    optionalText(row['reverses'], 'reverses'),
    stringArray(row['removedCapabilities'], 'removedCapabilities'),
    requireText(row['moderatorId'], 'moderatorId'),
    requireText(row['rationale'], 'rationale'),
    requireDate(row['decidedAt'], 'decidedAt'),
  ];
}

export function readDecision(row: Record<string, unknown>): Readonly<Record<string, unknown>> {
  return {
    decisionId: readText(row['decision_id'], 'decision_id'),
    caseId: castId<'CaseId'>(readText(row['case_id'], 'case_id')),
    subjectId: castId<'UserId'>(readText(row['subject_id'], 'subject_id')),
    action: readText(row['action'], 'action'),
    reverses: row['reverses'],
    removedCapabilities: readTextArray(row['removed_capabilities'], 'removed_capabilities'),
    moderatorId: readText(row['moderator_id'], 'moderator_id'),
    rationale: readText(row['rationale'], 'rationale'),
    decidedAt: readDate(row['decided_at'], 'decided_at'),
  };
}

// --------------------------------------------------------------- audit rows --

export const AUDIT_COLUMNS = `seq, occurred_at, actor_id, action, entity_type, entity_id,
       subject_id, case_id, detail, dedupe_key`;

/**
 * The conflict target for `appendAudit`, index predicate included: the unique
 * index is partial, and Postgres only infers a partial index when the
 * statement states the same predicate after the column list.
 */
export const AUDIT_DEDUPE_CONFLICT = 'ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING';


/**
 * Fields the domain's `NewAuditEntry` carries that the table has no column for.
 * They are folded into the `detail` document on the way in and lifted back out
 * on the way out, so the entry an appeal reader gets is the whole entry rather
 * than the part that happened to fit in a column.
 */
export const AUDIT_DETAIL_FIELDS: readonly string[] = ['evidenceIds', 'decisionId', 'outcome', 'reversal'];

export function auditParameters(row: Readonly<Record<string, unknown>>): unknown[] {
  // `seq` is deliberately absent: it is the database's to assign.
  return [
    requireDate(row['occurredAt'], 'occurredAt'),
    requireText(row['actorId'], 'actorId'),
    requireText(row['action'], 'action'),
    requireText(row['entityType'], 'entityType'),
    requireText(row['entityId'], 'entityId'),
    optionalText(row['subjectId'], 'subjectId'),
    optionalText(row['caseId'], 'caseId'),
    JSON.stringify(auditDetail(row)),
    optionalText(row['dedupeKey'], 'dedupeKey'),
  ];
}

export function auditDetail(row: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const folded: Record<string, unknown> = { ...jsonObject(row['detail'] ?? {}, 'detail') };
  for (const field of AUDIT_DETAIL_FIELDS) {
    const value = row[field];
    if (value !== undefined && value !== null) {
      folded[field] = value;
    }
  }
  return folded;
}

export function readAudit(row: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const { evidenceIds, decisionId, outcome, reversal, ...detail } = jsonObject(row['detail'], 'detail');
  const subjectId = row['subject_id'];
  const caseId = row['case_id'];
  return {
    sequence: readSequence(row['seq']),
    occurredAt: readDate(row['occurred_at'], 'occurred_at'),
    actorId: readActor(row['actor_id'], 'actor_id'),
    action: readText(row['action'], 'action'),
    entityType: readText(row['entity_type'], 'entity_type'),
    entityId: readText(row['entity_id'], 'entity_id'),
    subjectId: subjectId === null ? null : castId<'SubjectId'>(readText(subjectId, 'subject_id')),
    caseId: caseId === null ? null : castId<'CaseId'>(readText(caseId, 'case_id')),
    ...(evidenceIds === undefined ? {} : { evidenceIds }),
    ...(decisionId === undefined ? {} : { decisionId }),
    ...(outcome === undefined ? {} : { outcome }),
    ...(reversal === undefined ? {} : { reversal }),
    detail,
  };
}

// ---------------------------------------------------------------- the queue --

/**
 * Highest priority first, then oldest first within a priority.
 *
 * The rank is spelled out rather than ordered by the `priority` column because
 * that column is `text`, and alphabetical order would put `urgent` *last*,
 * behind every case that matters. The `cases_queue` index supplies what it
 * can — the partial predicate that makes these rows the unresolved ones, and
 * the candidate set to rank — while the rank itself is a domain fact a text
 * column cannot encode. `case_id` is the tiebreak, so the queue is a total
 * order and a page boundary cannot show the same case twice.
 */
export const OPEN_CASE_ORDER = `CASE priority
  WHEN 'urgent' THEN 0
  WHEN 'high' THEN 1
  WHEN 'normal' THEN 2
  WHEN 'low' THEN 3
  ELSE 4
END, opened_at ASC, case_id ASC`;

/** The `cases_queue` index's own predicate: unresolved is null, not a state. */
export const UNRESOLVED = 'resolution_decision_id IS NULL';
