import type { QueryResult } from 'pg';
import { castId, type ActorId, type CaseId, type ReportId, type UserId } from '@been-there/core';
import {
  StoreError,
  type CaseRow,
  type ModerationStore,
  type Page,
  type PageResult,
  type Transaction,
} from '@been-there/contracts';
import { isConflict, isRetryable } from './errors.js';
import { clientOf } from './transaction.js';

/**
 * Reports, cases, decisions, and the append-only audit (issue #7).
 *
 * ## Atomicity
 *
 * Every method runs on the `PoolClient` the caller's transaction already holds,
 * via the one `clientOf` in `./transaction.js`, and opens no transaction of its
 * own. That is the whole point of the port: a decision and the audit row that
 * explains it commit together or not at all. A store that issued its statement
 * on a second connection would look identical in the type and would half-succeed
 * the first time a ban committed without its appeal record.
 *
 * ## The audit log
 *
 * `appendAudit` is the only write. There is no update, no delete, and no
 * accessor that could become one; `seq` is never supplied, because the sequence
 * is the database's and a caller that could pick its own place in the order
 * could reorder history.
 *
 * Idempotence is keyed on the caller's `dedupe_key` (a unique index over
 * non-null keys). That is deliberate and it is the only honest key: no set of
 * columns describing *what happened* can tell a retried append from a genuine
 * repeat, because a moderator re-reading the same evidence twice is two real
 * rows the appeal record must keep. So the caller states which of the two it
 * is — a key for an action that must happen at most once, absent for one that
 * may legitimately repeat — and the store enforces exactly that.
 *
 * ## Row shapes
 *
 * The port types every row as `Readonly<Record<string, unknown>>`, so the keys
 * read here are named here and nowhere else. Inputs are the domain's own
 * objects: a `Report` from `submitReport`, a `Case` from `openCase`, a
 * `Decision` from `decide`, a `NewAuditEntry` from the audit log. Storage is
 * not the policy layer — nothing here re-checks intake, priority or authority,
 * only that a value has the shape its column requires. A wrong shape is a
 * `StoreError`, because silently writing `undefined` produces a not-null
 * violation naming the wrong cause, or worse, a plausible-looking empty row.
 */

// ------------------------------------------------------------ value readers --

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new StoreError(`\`${field}\` must be a non-empty string`);
  }
  return value;
}

/** A nullable text value: an absent key and an explicit `null` both mean null. */
function optionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return requireText(value, field);
}

function requireDate(value: unknown, field: string): Date {
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

function stringArray(value: unknown, field: string): readonly string[] {
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
function jsonParameter(value: unknown, field: string): string {
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
function jsonObject(value: unknown, column: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new StoreError(`column ${column} is not a JSON object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function jsonArray(value: unknown, column: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new StoreError(`column ${column} is not a JSON array`);
  }
  return value;
}

function readText(value: unknown, column: string): string {
  if (typeof value !== 'string') {
    throw new StoreError(`column ${column} is not text`);
  }
  return value;
}

function readDate(value: unknown, column: string): Date {
  if (!(value instanceof Date)) {
    throw new StoreError(`column ${column} is not a timestamp`);
  }
  return value;
}

function readTextArray(value: unknown, column: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new StoreError(`column ${column} is not a text array`);
  }
  return value.map((entry) => readText(entry, column));
}

/** `count(*)::int` lands on row zero, or the statement is not what it claims. */
function readCount(result: QueryResult): number {
  const first: unknown = result.rows[0];
  if (typeof first !== 'object' || first === null) {
    throw new StoreError('a count query returned no row');
  }
  const total = (first as Record<string, unknown>)['total'];
  if (typeof total !== 'number') {
    throw new StoreError('a count query did not return a number');
  }
  return total;
}

/** `opened_by` and `actor_id` hold an actor id or the literal `system`. */
function readActor(value: unknown, column: string): ActorId | 'system' {
  const text = readText(value, column);
  return text === 'system' ? 'system' : castId<'ActorId'>(text);
}

/** `seq` is a `bigint`, which the driver hands over as a string. */
function readSequence(value: unknown): number {
  const sequence = typeof value === 'string' ? Number(value) : value;
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence)) {
    throw new StoreError('column seq is not an audit sequence');
  }
  return sequence;
}

function readPage(page: Page): Page {
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
function storeFault(operation: string, error: unknown): StoreError {
  if (error instanceof StoreError) {
    return error;
  }
  const kind = isConflict(error) ? 'conflict' : isRetryable(error) ? 'retryable fault' : 'fault';
  return new StoreError(`${operation}: ${kind}`, { retryable: isRetryable(error), cause: error });
}

// -------------------------------------------------------------- report rows --

const REPORT_COLUMNS = `report_id, subject_id, reporter_id, reason, statement, relationship,
       captured_evidence, state, merged_case_id, submitted_at, updated_at`;

function reportParameters(row: Readonly<Record<string, unknown>>): unknown[] {
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

function readReport(row: Record<string, unknown>): Readonly<Record<string, unknown>> {
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

const CASE_COLUMNS = `case_id, subject_id, origin, state, priority, queue, opened_at, due_at,
       opened_by, assigned_moderator_id, report_ids, evidence_ids,
       resolution_decision_id, updated_at`;

/**
 * The columns a case transition may write, and nothing else. `case_id`,
 * `subject_id`, `origin`, `opened_at` and `opened_by` are the facts intake
 * froze; a transition able to change them could rewrite what a case is about,
 * which is the one thing a later appeal reads.
 */
const MUTABLE_CASE_COLUMNS: Readonly<Record<string, string>> = {
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

function caseParameters(row: Readonly<Record<string, unknown>>): unknown[] {
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

function readCase(row: Record<string, unknown>): CaseRow {
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
function caseOriginParameter(origin: unknown): string {
  return typeof origin === 'string' ? requireText(origin, 'origin') : jsonParameter(origin, 'origin');
}

// ------------------------------------------------------------ decision rows --

const DECISION_COLUMNS = `decision_id, case_id, subject_id, action, reverses,
       removed_capabilities, moderator_id, rationale, decided_at`;

function decisionParameters(row: Readonly<Record<string, unknown>>): unknown[] {
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

function readDecision(row: Record<string, unknown>): Readonly<Record<string, unknown>> {
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

const AUDIT_COLUMNS = `seq, occurred_at, actor_id, action, entity_type, entity_id,
       subject_id, case_id, detail, dedupe_key`;

/**
 * The conflict target for `appendAudit`, predicate included: the unique index
 * is partial, and Postgres will only infer a partial index if the statement
 * states the same predicate.
 */
const AUDIT_DEDUPE_CONFLICT = 'dedupe_key WHERE dedupe_key IS NOT NULL';

/**
 * Fields the domain's `NewAuditEntry` carries that the table has no column for.
 * They are folded into the `detail` document on the way in and lifted back out
 * on the way out, so the entry an appeal reader gets is the whole entry rather
 * than the part that happened to fit in a column.
 */
const AUDIT_DETAIL_FIELDS: readonly string[] = ['evidenceIds', 'decisionId', 'outcome', 'reversal'];

function auditParameters(row: Readonly<Record<string, unknown>>): unknown[] {
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

function auditDetail(row: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const folded: Record<string, unknown> = { ...jsonObject(row['detail'] ?? {}, 'detail') };
  for (const field of AUDIT_DETAIL_FIELDS) {
    const value = row[field];
    if (value !== undefined && value !== null) {
      folded[field] = value;
    }
  }
  return folded;
}

function readAudit(row: Record<string, unknown>): Readonly<Record<string, unknown>> {
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
const OPEN_CASE_ORDER = `CASE priority
  WHEN 'urgent' THEN 0
  WHEN 'high' THEN 1
  WHEN 'normal' THEN 2
  WHEN 'low' THEN 3
  ELSE 4
END, opened_at ASC, case_id ASC`;

/** The `cases_queue` index's own predicate: unresolved is null, not a state. */
const UNRESOLVED = 'resolution_decision_id IS NULL';

// ------------------------------------------------------------------- factory --

export function createModerationStore(): ModerationStore {
  async function findAuditPage(
    where: string,
    key: unknown[],
    page: Page,
    tx: Transaction,
  ): Promise<PageResult<Readonly<Record<string, unknown>>>> {
    const { limit, offset } = readPage(page);
    const client = clientOf(tx);
    const [items, counted] = await Promise.all([
      client.query(
        `SELECT ${AUDIT_COLUMNS} FROM app.audit_log WHERE ${where}
         ORDER BY occurred_at DESC, seq DESC LIMIT $2 OFFSET $3`,
        [...key, limit, offset],
      ),
      client.query(`SELECT count(*)::int AS total FROM app.audit_log WHERE ${where}`, key),
    ]);
    const total = readCount(counted);
    return { items: items.rows.map((row) => readAudit(row)), total };
  }

  return {
    async insertReport(row, tx) {
      try {
        await clientOf(tx).query(
          `INSERT INTO app.reports (${REPORT_COLUMNS})
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          reportParameters(row),
        );
      } catch (error) {
        throw storeFault('insertReport', error);
      }
    },

    async findReport(reportId, tx) {
      const found = await clientOf(tx).query(
        `SELECT ${REPORT_COLUMNS} FROM app.reports WHERE report_id = $1`,
        [reportId],
      );
      const row = found.rows[0];
      return row === undefined ? null : readReport(row);
    },

    async insertCase(row, tx) {
      try {
        const inserted = await clientOf(tx).query(
          `INSERT INTO app.cases (${CASE_COLUMNS})
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           RETURNING ${CASE_COLUMNS}`,
          caseParameters(row),
        );
        const insertedRow = inserted.rows[0];
        if (insertedRow === undefined) {
          throw new StoreError('insertCase inserted no row');
        }
        return readCase(insertedRow);
      } catch (error) {
        throw storeFault('insertCase', error);
      }
    },

    async findCase(caseId, tx) {
      const found = await clientOf(tx).query(`SELECT ${CASE_COLUMNS} FROM app.cases WHERE case_id = $1`, [
        caseId,
      ]);
      const row = found.rows[0];
      return row === undefined ? null : readCase(row);
    },

    async updateCase(caseId, patch, tx) {
      // The column names interpolated here are the only thing in the statement
      // that is not a bound parameter, and they come from the fixed map above;
      // a key that is not a mutable case column is refused, not written.
      const assignments: string[] = [];
      const values: unknown[] = [];
      for (const [field, value] of Object.entries(patch)) {
        const column = MUTABLE_CASE_COLUMNS[field];
        if (column === undefined) {
          throw new StoreError(`\`${field}\` is not a mutable case column`);
        }
        if (value === undefined) {
          continue;
        }
        values.push(casePatchValue(field, value));
        assignments.push(`${column} = $${values.length}`);
      }
      if (assignments.length === 0) {
        throw new StoreError('updateCase was given no columns to change');
      }
      values.push(caseId);
      try {
        const updated = await clientOf(tx).query(
          `UPDATE app.cases SET ${assignments.join(', ')} WHERE case_id = $${values.length}`,
          values,
        );
        return (updated.rowCount ?? 0) === 1;
      } catch (error) {
        throw storeFault('updateCase', error);
      }
    },

    async listOpenCases(page, tx) {
      const { limit, offset } = readPage(page);
      const client = clientOf(tx);
      const [items, counted] = await Promise.all([
        client.query(
          `SELECT ${CASE_COLUMNS} FROM app.cases WHERE ${UNRESOLVED}
           ORDER BY ${OPEN_CASE_ORDER} LIMIT $1 OFFSET $2`,
          [limit, offset],
        ),
        client.query(`SELECT count(*)::int AS total FROM app.cases WHERE ${UNRESOLVED}`),
      ]);
      const total = readCount(counted);
      return { items: items.rows.map((row) => readCase(row)), total };
    },

    async insertDecision(row, tx) {
      // An INSERT and nothing else. A reversal is a new row naming the decision
      // it answers, and `reverses` is a foreign key onto the original, so a
      // reversal of a decision that does not exist cannot be recorded. No path
      // in this method can turn into an update of the row it references, which
      // is the property an appeal depends on: the reviewer reads the original,
      // the first reversal and the second, and finds all three.
      try {
        await clientOf(tx).query(
          `INSERT INTO app.decisions (${DECISION_COLUMNS})
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          decisionParameters(row),
        );
      } catch (error) {
        throw storeFault('insertDecision', error);
      }
    },

    async findDecisionsFor(caseId, tx) {
      const found = await clientOf(tx).query(
        `SELECT ${DECISION_COLUMNS} FROM app.decisions WHERE case_id = $1
         ORDER BY decided_at ASC, decision_id ASC`,
        [caseId],
      );
      return found.rows.map((row) => readDecision(row));
    },

    async appendAudit(row, tx) {
      try {
        await clientOf(tx).query(
          `INSERT INTO app.audit_log
             (occurred_at, actor_id, action, entity_type, entity_id, subject_id, case_id, detail, dedupe_key)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (${AUDIT_DEDUPE_CONFLICT}) DO NOTHING`,
          auditParameters(row),
        );
      } catch (error) {
        throw storeFault('appendAudit', error);
      }
    },

    findAuditForActor(actorId, page, tx) {
      return findAuditPage('actor_id = $1', [actorId], page, tx);
    },

    findAuditForSubject(subjectId, page, tx) {
      return findAuditPage('subject_id = $1', [subjectId], page, tx);
    },

    async findAuditForEntity(entityType, entityId, tx) {
      const found = await clientOf(tx).query(
        `SELECT ${AUDIT_COLUMNS} FROM app.audit_log
         WHERE entity_type = $1 AND entity_id = $2
         ORDER BY occurred_at DESC, seq DESC`,
        [entityType, entityId],
      );
      return found.rows.map((row) => readAudit(row));
    },
  };
}

/** Encodes one patch value by the column it lands in. */
function casePatchValue(field: string, value: unknown): unknown {
  switch (field) {
    case 'dueAt':
    case 'updatedAt':
      return requireDate(value, field);
    case 'reportIds':
    case 'evidenceIds':
      return stringArray(value, field);
    case 'assignedModeratorId':
    case 'resolutionDecisionId':
      return value === null ? null : requireText(value, field);
    default:
      return requireText(value, field);
  }
}
