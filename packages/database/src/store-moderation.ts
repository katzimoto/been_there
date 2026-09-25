import type { QueryResult } from 'pg';
import { StoreError, type ModerationStore, type Page, type PageResult, type Transaction } from '@been-there/contracts';
import { isConflict, isRetryable } from './errors.js';
import { clientOf } from './transaction.js';
import {
  AUDIT_COLUMNS,
  AUDIT_DEDUPE_CONFLICT,
  CASE_COLUMNS,
  DECISION_COLUMNS,
  MUTABLE_CASE_COLUMNS,
  OPEN_CASE_ORDER,
  REPORT_COLUMNS,
  UNRESOLVED,
  auditParameters,
  caseParameters,
  casePatchValue,
  decisionParameters,
  readAudit,
  readCase,
  readDecision,
  readReport,
  reportParameters,
} from './moderation-rows.js';

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
 * Idempotence is keyed on the caller's `dedupe_key`, unique over non-null keys.
 * That is deliberate and it is the only honest key: no set of columns describing
 * *what happened* can tell a retried append from a genuine repeat, because a
 * moderator re-reading the same evidence twice is two real rows the appeal
 * record must keep. So the caller states which of the two it is — a key for an
 * action that must happen at most once, absent for one that may legitimately
 * repeat — and this store enforces exactly that.
 *
 * The row shapes and the column names live in `./moderation-rows.ts`.
 */

function readPage(page: Page): Page {
  if (!Number.isInteger(page.limit) || page.limit < 0) {
    throw new StoreError('page.limit must be a non-negative integer');
  }
  if (!Number.isInteger(page.offset) || page.offset < 0) {
    throw new StoreError('page.offset must be a non-negative integer');
  }
  return page;
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

/**
 * Why a moderation write was refused, as a closed vocabulary.
 *
 * These are integrity outcomes the database enforced, not business decisions
 * the domain made: a caller that caught them as a domain error would have to
 * parse prose or enumerate constraint names to tell them apart. A caller
 * branches on `reason` and never on the message.
 */
export type ModerationConflictReason =
  | 'report_id_taken'
  | 'case_id_taken'
  | 'decision_id_taken'
  | 'subject_does_not_exist'
  | 'reporter_does_not_exist'
  | 'case_does_not_exist'
  | 'reverses_unknown_decision'
  | 'action_not_recognised'
  | 'constraint_unrecognised';

/**
 * A refusal the caller must handle, distinct from a fault whose answer is
 * unknown. Extends the contracts' `StoreError` rather than replacing it, so a
 * caller catching `StoreError` still catches this, and the driver error stays
 * on `cause` where `isConflict` reads its SQLSTATE.
 */
export class ModerationStoreError extends StoreError {
  readonly reason: ModerationConflictReason;
  constructor(reason: ModerationConflictReason, message: string, cause: unknown) {
    super(message, { retryable: false, cause });
    this.name = 'ModerationStoreError';
    this.reason = reason;
  }
}

/**
 * The constraints these statements can violate, read from the live database
 * rather than assumed from Postgres' naming rules, so a renamed constraint
 * surfaces as `constraint_unrecognised` instead of silently reading as some
 * other reason. A violation nobody anticipated still gets a closed reason; it
 just gets the honest one.
 */
const CONFLICT_REASON_BY_CONSTRAINT: Readonly<Record<string, ModerationConflictReason>> = {
  reports_pkey: 'report_id_taken',
  reports_subject_id_fkey: 'subject_does_not_exist',
  reports_reporter_id_fkey: 'reporter_does_not_exist',
  cases_pkey: 'case_id_taken',
  cases_subject_id_fkey: 'subject_does_not_exist',
  decisions_pkey: 'decision_id_taken',
  decisions_case_id_fkey: 'case_does_not_exist',
  decisions_subject_id_fkey: 'subject_does_not_exist',
  decisions_reverses_fkey: 'reverses_unknown_decision',
  decisions_action_check: 'action_not_recognised',
};

/**
 * The constraint a driver error names, or `null`. `errors.ts` narrows a driver
 * error to its SQLSTATE and keeps that helper private; this reads the sibling
 * field, and belongs beside it if the two are ever generalised together.
 */
function constraintOf(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'constraint' in error) {
    const constraint = (error as { constraint?: unknown }).constraint;
    return typeof constraint === 'string' && constraint.length > 0 ? constraint : null;
  }
  return null;
}

/**
 * A store fault, labelled by the class of failure. A conflict the caller must
 * handle becomes a `ModerationStoreError` with a reason to branch on; anything
 * else keeps its classification in the message, because there is nothing for a
 * caller to do about it but surface it.
 */
function storeFault(operation: string, error: unknown): StoreError {
  if (error instanceof StoreError) {
    return error;
  }
  if (isConflict(error)) {
    const constraint = constraintOf(error);
    const reason =
      constraint === null
        ? 'constraint_unrecognised'
        : (CONFLICT_REASON_BY_CONSTRAINT[constraint] ?? 'constraint_unrecognised');
    return new ModerationStoreError(reason, `${operation}: ${reason}`, error);
  }
  const kind = isRetryable(error) ? 'retryable fault' : 'fault';
  return new StoreError(`${operation}: ${kind}`, { retryable: isRetryable(error), cause: error });
}


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
           ${AUDIT_DEDUPE_CONFLICT}`,
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
