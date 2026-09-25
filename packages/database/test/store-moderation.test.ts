/**
 * `ModerationStore` against a real Postgres.
 *
 * Each test here asserts a property the port promises and the application
 * cannot enforce on its own: a replayed append does not duplicate a decision in
 * the appeal record, the queue is ordered by priority rather than
 * alphabetically and excludes what is resolved, a reversal of something that
 * does not exist is a conflict and not a fault, and two reversals of one
 * decision leave the original exactly as it was. A test that inserted a row and
 * read it back would prove only that the driver works.
 *
 * `DATABASE_URL` is read from the environment and then from `.env`, the same
 * way `scripts/migrate.mjs` does. With no database the suite says so loudly
 * rather than passing on nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { castId, type CaseId, type ReportId, type UserId } from '@been-there/core';
import { StoreError, type ModerationStore, type Transaction } from '@been-there/contracts';
import { isConflict } from '../src/errors.js';
import { clientOf, createTransaction } from '../src/transaction.js';
import { ModerationStoreError, createModerationStore } from '../src/store-moderation.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ENV_FILE = join(REPO_ROOT, '.env');
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const [, key, value] = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line) ?? [];
    if (key !== undefined && value !== undefined && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

const connectionString = process.env['DATABASE_URL'];
const describeIfDb = connectionString === undefined ? describe.skip : describe;

const HOUR = 60 * 60 * 1000;
const OPENED_AT = new Date('2026-01-01T09:00:00.000Z');
const at = (hoursAgo: number): Date => new Date(OPENED_AT.getTime() - hoursAgo * HOUR);

const aCaseId = (): CaseId => castId<'CaseId'>(randomUUID());

describeIfDb('ModerationStore, against Postgres', () => {
  let pool: pg.Pool;
  let transaction: Transaction;
  let store: ModerationStore;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString });
    transaction = createTransaction(pool);
    store = createModerationStore();
  });

  afterAll(async () => {
    await pool.end();
  });

  /** The unit of work every statement runs in, and the only one there is. */
  function run<T>(body: (tx: Transaction) => Promise<T>): Promise<T> {
    return transaction.run(body);
  }

  /** A subject to be reported on. Each test makes its own, so none interfere. */
  async function aSubject(): Promise<UserId> {
    const userId = castId<'UserId'>(randomUUID());
    await run(async (tx) => {
      await clientOf(tx).query('INSERT INTO app.users (user_id, account_id) VALUES ($1,$2)', [
        userId,
        randomUUID(),
      ]);
    });
    return userId;
  }

  /** A `Case` as the domain's own `openCase` produces it. */
  function aCase(subjectId: UserId, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      caseId: aCaseId(),
      subjectId,
      origin: { source: 'user_report', reasons: ['spam'] },
      state: 'open',
      priority: 'normal',
      queue: 'safety',
      openedAt: OPENED_AT,
      dueAt: new Date(OPENED_AT.getTime() + 48 * HOUR),
      openedBy: 'mod-1',
      assignedModeratorId: null,
      reportIds: [],
      evidenceIds: [],
      resolutionDecisionId: null,
      updatedAt: OPENED_AT,
      ...overrides,
    };
  }

  /** A `NewAuditEntry` as the domain's audit log produces it. */
  function anEntry(subjectId: UserId, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      occurredAt: new Date('2026-01-02T10:00:00.000Z'),
      actorId: 'mod-1',
      action: 'decision.recorded',
      entityType: 'decision',
      entityId: randomUUID(),
      subjectId,
      caseId: null,
      evidenceIds: [],
      decisionId: null,
      outcome: 'allowed',
      reversal: null,
      detail: { action: 'ban' },
      ...overrides,
    };
  }

  /** A `Decision` as the domain's own `decide` produces it. */
  function aDecision(
    subjectId: UserId,
    caseId: CaseId,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      decisionId: randomUUID(),
      caseId,
      subjectId,
      action: 'ban',
      reverses: null,
      removedCapabilities: ['browse_discovery', 'like'],
      moderatorId: 'mod-1',
      rationale: 'A credible threat naming the reporter, verified against the recording.',
      decidedAt: new Date('2026-01-03T11:00:00.000Z'),
      ...overrides,
    };
  }

  /** The failure a statement produced, or `null` if it produced none. */
  async function captureFailure(work: () => Promise<unknown>): Promise<unknown> {
    try {
      await work();
      return null;
    } catch (error) {
      return error;
    }
  }

  function auditRowsFor(entityId: string): Promise<readonly Record<string, unknown>[]> {
    return run((tx) => store.findAuditForEntity('decision', entityId, tx));
  }

  function entityIdOf(row: Record<string, unknown>): string {
    return row['entityId'] as string;
  }

  it('keeps one row when the same audit append is replayed', async () => {
    const subjectId = await aSubject();
    const entityId = randomUUID();
    // The key the caller supplies is what makes this one append rather than
    // two: a retried request and a moderator's second identical action are the
    // same four columns, and only the caller knows which of the two it is
    // sending. A duplicate here is a duplicated decision in the appeal record.
    const entry = anEntry(subjectId, { entityId, dedupeKey: `decision.recorded:${entityId}` });

    await run((tx) => store.appendAudit(entry, tx));
    await run((tx) => store.appendAudit(entry, tx));
    await run((tx) => store.appendAudit(entry, tx));

    expect(await auditRowsFor(entityId)).toHaveLength(1);
  });

  it('keeps both rows of an action the caller says may legitimately repeat', async () => {
    const subjectId = await aSubject();
    const entityId = randomUUID();
    // A moderator re-reading the same evidence twice is two real events and
    // the appeal record must not collapse them, so the absence of a key has to
    // mean exactly that rather than "the store could not tell".
    const read = anEntry(subjectId, { entityId, action: 'evidence.read' });

    await run((tx) => store.appendAudit(read, tx));
    await run((tx) => store.appendAudit(read, tx));

    expect(await auditRowsFor(entityId)).toHaveLength(2);
  });

  it('assigns the audit sequence itself and keeps the whole entry readable', async () => {
    const subjectId = await aSubject();
    const first = anEntry(subjectId, { dedupeKey: null });
    const second = anEntry(subjectId, {
      dedupeKey: null,
      occurredAt: new Date('2026-01-02T11:00:00.000Z'),
    });
    // A caller cannot choose where its entry lands in the order.
    await run((tx) => store.appendAudit({ ...first, seq: 999_999 }, tx));
    await run((tx) => store.appendAudit(second, tx));

    const firstRows = await auditRowsFor(entityIdOf(first));
    const secondRows = await auditRowsFor(entityIdOf(second));
    const low = firstRows[0]?.['sequence'];
    const high = secondRows[0]?.['sequence'];

    expect(typeof low).toBe('number');
    expect(typeof high).toBe('number');
    expect(high as number).toBeGreaterThan(low as number);
    // Fields the table has no column for come back off the stored document.
    expect(firstRows[0]?.['outcome']).toBe('allowed');
    expect(firstRows[0]?.['evidenceIds']).toEqual([]);
    expect(firstRows[0]?.['detail']).toEqual({ action: 'ban' });
  });

  it('lists the open queue by priority, oldest first within a priority, and omits resolved cases', async () => {
    const subjectId = await aSubject();
    const mine: string[] = [];
    const open = async (priority: string, hoursAgo: number): Promise<CaseId> => {
      const caseId = aCaseId();
      await run((tx) => store.insertCase(aCase(subjectId, { caseId, priority, openedAt: at(hoursAgo) }), tx));
      mine.push(caseId);
      return caseId;
    };

    const urgent = await open('urgent', 1);
    const highOld = await open('high', 5);
    const highNew = await open('high', 0);
    const normal = await open('normal', 3);
    const low = await open('low', 0);

    // Resolved, and urgent besides: if the ordering were right but the filter
    // were missing, this is the row that would still be in the queue.
    const resolvedId = aCaseId();
    await run((tx) => store.insertCase(aCase(subjectId, { caseId: resolvedId, priority: 'urgent' }), tx));
    const decision = aDecision(subjectId, resolvedId, { action: 'clear', removedCapabilities: [] });
    await run((tx) => store.insertDecision(decision, tx));
    await run((tx) =>
      store.updateCase(
        resolvedId,
        { state: 'resolved', resolutionDecisionId: decision['decisionId'], updatedAt: at(0) },
        tx,
      ),
    );

    const page = await run((tx) => store.listOpenCases({ limit: 500, offset: 0 }, tx));
    const mineInOrder = page.items.map((item) => item.caseId).filter((id) => mine.includes(id));

    expect(mineInOrder).toEqual([urgent, highOld, highNew, normal, low]);
    expect(page.items.map((item) => item.caseId)).not.toContain(resolvedId);
    expect(page.total).toBeGreaterThanOrEqual(mine.length);
  });

  it('refuses a decision that reverses one which does not exist, as a conflict', async () => {
    const subjectId = await aSubject();
    const caseId = aCaseId();
    await run((tx) => store.insertCase(aCase(subjectId, { caseId }), tx));
    const dangling = aDecision(subjectId, caseId, { action: 'clear', reverses: randomUUID() });

    const failure = await captureFailure(() => run((tx) => store.insertDecision(dangling, tx)));

    // A conflict the caller must handle, not a fault: the difference is the
    // whole reason a bad appeal cannot be mistaken for an outage. The reason is
    // a closed value to branch on, not prose, and the driver error stays on
    // `cause` for anything that needs the SQLSTATE.
    expect(failure).toBeInstanceOf(ModerationStoreError);
    expect(failure).toBeInstanceOf(StoreError);
    expect((failure as ModerationStoreError).reason).toBe('reverses_unknown_decision');
    expect((failure as StoreError).retryable).toBe(false);
    expect(isConflict((failure as StoreError).cause)).toBe(true);
    expect(await run((tx) => store.findDecisionsFor(caseId, tx))).toHaveLength(0);
  });

  it('names the constraint it refused on, so a caller branches without reading prose', async () => {
    const subjectId = await aSubject();
    const caseId = aCaseId();
    const caseRow = aCase(subjectId, { caseId });
    await run((tx) => store.insertCase(caseRow, tx));

    const duplicateCase = await captureFailure(() => run((tx) => store.insertCase(caseRow, tx)));
    const unknownSubject = await captureFailure(() =>
      run((tx) => store.insertCase(aCase(castId<'UserId'>(randomUUID())), tx)),
    );
    const unknownAction = await captureFailure(() =>
      run((tx) => store.insertDecision(aDecision(subjectId, caseId, { action: 'obliterate' }), tx)),
    );

    // Three different refusals, three different reasons, none of them "the
    // insert failed". A caller answering an appeal can tell a duplicate from a
    // dangling subject from a malformed action without a single string match.
    for (const failure of [duplicateCase, unknownSubject, unknownAction]) {
      expect(failure).toBeInstanceOf(ModerationStoreError);
      expect(isConflict((failure as StoreError).cause)).toBe(true);
    }
    expect((duplicateCase as ModerationStoreError).reason).toBe('case_id_taken');
    expect((unknownSubject as ModerationStoreError).reason).toBe('subject_does_not_exist');
    expect((unknownAction as ModerationStoreError).reason).toBe('action_not_recognised');
  });

  it('retains two reversals of one decision and leaves the original exactly as it was', async () => {
    const subjectId = await aSubject();
    const caseId = aCaseId();
    await run((tx) => store.insertCase(aCase(subjectId, { caseId }), tx));

    const original = aDecision(subjectId, caseId);
    await run((tx) => store.insertDecision(original, tx));
    const before = (await run((tx) => store.findDecisionsFor(caseId, tx)))[0];

    // The appeal-readiness property: a second appeal answered against the same
    // decision is a second decision naming it. Were a reversal an update, these
    // two calls would leave one row and the original would have been rewritten.
    const first = aDecision(subjectId, caseId, {
      decisionId: randomUUID(),
      action: 'clear',
      removedCapabilities: [],
      reverses: original['decisionId'],
      rationale: 'First appeal: the recording was re-examined and does not show a threat.',
      decidedAt: new Date('2026-02-01T11:00:00.000Z'),
    });
    const second = aDecision(subjectId, caseId, {
      decisionId: randomUUID(),
      action: 'clear',
      removedCapabilities: [],
      reverses: original['decisionId'],
      rationale: 'Second appeal: the reviewer read the evidence the first did not.',
      decidedAt: new Date('2026-03-01T11:00:00.000Z'),
    });
    await run((tx) => store.insertDecision(first, tx));
    await run((tx) => store.insertDecision(second, tx));

    const after = await run((tx) => store.findDecisionsFor(caseId, tx));

    expect(after).toHaveLength(3);
    expect(after.map((decision) => decision['decisionId'])).toEqual([
      original['decisionId'],
      first['decisionId'],
      second['decisionId'],
    ]);
    // All three are their own row: the reversals name the original rather than
    // replacing it, and the original still says what it said.
    expect(after[0]).toEqual(before);
    expect(after[0]?.['action']).toBe('ban');
    expect(after[0]?.['reverses']).toBeNull();
    expect(after.map((decision) => decision['reverses'])).toEqual([
      null,
      original['decisionId'],
      original['decisionId'],
    ]);

    // And the original is still exactly one row in the table, not a row whose
    // columns were rewritten twice under the same id.
    const stored = await run((tx) =>
      clientOf(tx).query('SELECT count(*)::int AS total FROM app.decisions WHERE decision_id = $1', [
        original['decisionId'],
      ]),
    );
    expect(stored.rows[0]?.['total']).toBe(1);
  });

  it('raises rather than returning an empty document when a stored report is malformed', async () => {
    const subjectId = await aSubject();
    const reportId = castId<'ReportId'>(randomUUID());
    const report = {
      reportId,
      subjectId,
      reporterId: null,
      reason: 'threats_or_violence',
      statement: 'He said he would find me.',
      relationship: { matchId: 'match:a|b', at: OPENED_AT },
      capturedEvidence: [],
      state: 'submitted',
      mergedCaseId: null,
      submittedAt: OPENED_AT,
      updatedAt: OPENED_AT,
    };
    await run((tx) => store.insertReport(report, tx));
    expect(await run((tx) => store.findReport(reportId, tx))).toMatchObject({ reason: report.reason });

    // The relationship is frozen at submission and read months later. A row
    // that no longer holds a document must raise, not read as "no relationship
    // was recorded" — which is the reading that would exonerate a case.
    await run((tx) =>
      clientOf(tx).query("UPDATE app.reports SET relationship = '[]'::jsonb WHERE report_id = $1", [reportId]),
    );

    const failure = await captureFailure(() => run((tx) => store.findReport(reportId, tx)));
    expect(failure).toBeInstanceOf(StoreError);
    expect((failure as Error).message).toContain('relationship');
  });

  it('refuses to change a fact intake froze, and reports a case that is not there', async () => {
    const subjectId = await aSubject();
    const caseId = aCaseId();
    await run((tx) => store.insertCase(aCase(subjectId, { caseId }), tx));

    const refused = await captureFailure(() =>
      run((tx) => store.updateCase(caseId, { subjectId: castId<'UserId'>(randomUUID()) }, tx)),
    );
    expect(refused).toBeInstanceOf(StoreError);
    expect((refused as Error).message).toContain('subjectId');

    const moved = await run((tx) =>
      store.updateCase(caseId, { state: 'assigned', assignedModeratorId: 'mod-9' }, tx),
    );
    expect(moved).toBe(true);
    const reread = await run((tx) => store.findCase(caseId, tx));
    expect(reread?.state).toBe('assigned');
    expect(reread?.assignedModeratorId).toBe('mod-9');
    expect(reread?.subjectId).toBe(subjectId);

    expect(await run((tx) => store.updateCase(aCaseId(), { state: 'open' }, tx))).toBe(false);
  });

  it('leaves nothing behind when the unit of work rolls back', async () => {
    const subjectId = await aSubject();
    const caseId = aCaseId();
    const entry = anEntry(subjectId, { dedupeKey: `decision.recorded:${aCaseId()}` });

    // A case and the audit row that explains it are one unit of work: if
    // either half fails, neither may survive, or the appeal record describes
    // something that did not happen.
    const failure = await captureFailure(() =>
      transaction.run(async (tx) => {
        await store.insertCase(aCase(subjectId, { caseId }), tx);
        await store.appendAudit(entry, tx);
        throw new StoreError('the enforcement that followed failed');
      }),
    );

    expect(failure).toBeInstanceOf(StoreError);
    expect(await run((tx) => store.findCase(caseId, tx))).toBeNull();
    expect(await auditRowsFor(entityIdOf(entry))).toHaveLength(0);
  });

  it('rolls back a nested composition as one unit, because the inner write rides the same connection', async () => {
    const subjectId = await aSubject();
    const caseId = aCaseId();
    const entry = anEntry(subjectId, { dedupeKey: `decision.recorded:${aCaseId()}` });

    // A service method composes several stores into one request, so the inner
    // `tx.run` must join the outer transaction rather than open a second
    // connection. If it opened one, the audit row below would commit on that
    // other connection and outlive the rollback — the appeal record describing
    // a case that does not exist, which is the one failure this port exists to
    // make impossible.
    const failure = await captureFailure(() =>
      transaction.run(async (tx) => {
        await store.insertCase(aCase(subjectId, { caseId }), tx);
        await tx.run(async (inner) => store.appendAudit(entry, inner));
        throw new StoreError('the enforcement that followed failed');
      }),
    );

    expect(failure).toBeInstanceOf(StoreError);
    expect(await run((tx) => store.findCase(caseId, tx))).toBeNull();
    expect(await auditRowsFor(entityIdOf(entry))).toHaveLength(0);
  });
});
