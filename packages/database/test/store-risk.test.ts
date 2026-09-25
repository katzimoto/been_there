/**
 * The risk store's promises, proven against a real database.
 *
 * Every test here asserts a property the *port* makes, not a shape the driver
 * happens to return: that a replayed delivery is one signal, that the limit
 * takes the newest rows and hands them back oldest-first, that a rolled-back
 * unit of work leaves nothing, and that a malformed row is loud. A test that
 * inserted a row and read it back would pass against an implementation that
 * ordered by nothing and deduplicated nowhere.
 *
 * Skipped, loudly, when `DATABASE_URL` is unset. A suite that silently passes
 * because it connected to nothing is the worst outcome available.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { PoolClient } from 'pg';
import { castId, type RiskAssessmentId, type SubjectId } from '@been-there/core';
import { StoreError, type Transaction } from '@been-there/contracts';
import { createTransaction } from '../src/transaction.js';
import { PgRiskStore, type RiskSignalInput } from '../src/store-risk.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = resolve(HERE, '..', '..', '..', '.env');
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match !== null && process.env[match[1]!] === undefined) {
      process.env[match[1]!] = match[2]!;
    }
  }
}

const connectionString = process.env.DATABASE_URL;
const describeIfDb = connectionString === undefined ? describe.skip : describe;

const MINUTE = 60_000;

describeIfDb('RiskStore, against Postgres', () => {
  let pool: pg.Pool;
  let raw: PoolClient;
  let transaction: Transaction;
  const store = new PgRiskStore();

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString });
    raw = await pool.connect();
    transaction = createTransaction(pool);
  });

  afterAll(async () => {
    if (pool !== undefined) {
      raw.release();
      await pool.end();
    }
  });

  /** A subject the risk tables can point at: the FK demands a real user. */
  async function newSubject(): Promise<SubjectId> {
    const id = randomUUID();
    await raw.query('INSERT INTO app.users (user_id, account_id) VALUES ($1, $2)', [
      id,
      randomUUID(),
    ]);
    return castId<SubjectId>(id);
  }

  function signal(subjectId: SubjectId, overrides: Partial<RiskSignalInput> = {}): RiskSignalInput {
    return {
      signalId: randomUUID(),
      subjectId,
      detector: 'link_velocity',
      behaviour: 'linked_forty_profiles_in_an_hour',
      entityId: null,
      facts: { count: 40 },
      weight: 0.6,
      occurredAt: new Date('2026-01-01T00:00:00.000Z'),
      ...overrides,
    };
  }

  /** Appends a signal inside its own unit of work, as a service would. */
  function append(input: RiskSignalInput): Promise<void> {
    return transaction.run((tx) => store.appendSignal(input, tx));
  }

  function signalsOf(subjectId: SubjectId, limit = 100) {
    return transaction.run((tx) => store.findSignalsFor(subjectId, limit, tx));
  }

  function assessmentOf(subjectId: SubjectId) {
    return transaction.run((tx) => store.findAssessment(subjectId, tx));
  }

  function assess(
    subjectId: SubjectId,
    state: string,
    lastSignalAt: Date | null,
    detectors: readonly string[],
  ): Promise<void> {
    return transaction.run((tx) =>
      store.upsertAssessment(
        subjectId,
        castId<RiskAssessmentId>(randomUUID()),
        state,
        lastSignalAt,
        detectors,
        tx,
      ),
    );
  }

  it('treats a redelivered signal as one signal, so a retry cannot escalate a subject', async () => {
    const subject = await newSubject();
    const delivered = signal(subject, { weight: 0.9, detector: 'harassment_language' });

    await append(delivered);
    // The same id again from an at-least-once producer — after a timeout, so
    // the first delivery certainly committed and the producer cannot know it.
    await expect(append(delivered)).resolves.toBeUndefined();

    const found = await signalsOf(subject);
    expect(found).toHaveLength(1);
    expect(found[0]?.signalId).toBe(delivered.signalId);
    expect(found[0]?.weight).toBe(0.9);
  });

  it('does not double-count a replay inside one unit of work either', async () => {
    const subject = await newSubject();
    const delivered = signal(subject);

    await transaction.run(async (tx) => {
      await store.appendSignal(delivered, tx);
      await store.appendSignal(delivered, tx);
      await store.appendSignal(delivered, tx);
    });

    expect(await signalsOf(subject)).toHaveLength(1);
  });

  it('keeps the first delivery when a redelivery disagrees with it', async () => {
    const subject = await newSubject();
    const delivered = signal(subject, { weight: 0.2, behaviour: 'original' });

    await append(delivered);
    await append(
      signal(subject, { signalId: delivered.signalId, weight: 1, behaviour: 'rewritten' }),
    );

    const found = await signalsOf(subject);
    expect(found).toHaveLength(1);
    expect(found[0]?.behaviour).toBe('original');
    expect(found[0]?.weight).toBe(0.2);
  });

  it('returns the newest N oldest-first, so the window a caller reads is the recent one', async () => {
    const subject = await newSubject();
    const base = Date.parse('2026-03-01T00:00:00.000Z');
    // Five signals a minute apart, so an implementation that took the oldest N
    // returns a visibly different set rather than merely a different count.
    for (let index = 0; index < 5; index += 1) {
      await append(
        signal(subject, {
          behaviour: `burst_${index}`,
          occurredAt: new Date(base + index * MINUTE),
        }),
      );
    }

    const window = await transaction.run((tx) => store.findSignalsFor(subject, 3, tx));

    // Identity, not just size: the oldest two must be the ones dropped.
    expect(window.map((row) => row.behaviour)).toEqual(['burst_2', 'burst_3', 'burst_4']);
    expect(window.map((row) => row.occurredAt.getTime())).toEqual([
      base + 2 * MINUTE,
      base + 3 * MINUTE,
      base + 4 * MINUTE,
    ]);
    for (let index = 1; index < window.length; index += 1) {
      expect(window[index]!.occurredAt.getTime()).toBeGreaterThanOrEqual(
        window[index - 1]!.occurredAt.getTime(),
      );
    }

    // A limit above the total returns everything, still oldest-first.
    const all = await signalsOf(subject);
    expect(all.map((row) => row.behaviour)).toEqual([
      'burst_0',
      'burst_1',
      'burst_2',
      'burst_3',
      'burst_4',
    ]);
  });

  it('keeps one subject signals out of another subject window', async () => {
    const mine = await newSubject();
    const theirs = await newSubject();
    const base = Date.parse('2026-03-05T00:00:00.000Z');
    await append(signal(theirs, { occurredAt: new Date(base + 10 * MINUTE) }));
    await append(signal(mine, { behaviour: 'mine_early', occurredAt: new Date(base) }));
    await append(signal(mine, { behaviour: 'mine_late', occurredAt: new Date(base + MINUTE) }));

    expect((await signalsOf(mine)).map((row) => row.behaviour)).toEqual([
      'mine_early',
      'mine_late',
    ]);
    expect((await signalsOf(theirs)).map((row) => row.behaviour)).toHaveLength(1);
  });

  it('orders signals that share a timestamp deterministically', async () => {
    const subject = await newSubject();
    const instant = new Date('2026-04-01T12:00:00.000Z');
    for (let index = 0; index < 4; index += 1) {
      await append(signal(subject, { occurredAt: instant, behaviour: `same_${index}` }));
    }

    const first = await signalsOf(subject);
    const second = await signalsOf(subject);
    expect(first).toHaveLength(4);
    // Two detectors can observe the same instant; an order that changed
    // between reads would make the domain's repeat count non-deterministic.
    expect(first.map((row) => row.signalId)).toEqual(second.map((row) => row.signalId));
  });

  it('orders same-instant signals by detector, as the domain ledger does', async () => {
    const subject = await newSubject();
    const instant = new Date('2026-04-02T12:00:00.000Z');
    // Inserted in reverse order: the domain sorts a ledger by
    // (occurredAt, detector, subjectId), so a replayed ledger has to come back
    // in that order or the repeat count changes across a restart.
    await append(signal(subject, { occurredAt: instant, detector: 'z.detector' }));
    await append(signal(subject, { occurredAt: instant, detector: 'a.detector' }));
    await append(signal(subject, { occurredAt: instant, detector: 'm.detector' }));

    expect((await signalsOf(subject)).map((row) => row.detector)).toEqual([
      'a.detector',
      'm.detector',
      'z.detector',
    ]);
  });

  it('returns an empty list for a subject with no signals rather than failing', async () => {
    const subject = await newSubject();
    expect(await signalsOf(subject)).toEqual([]);

    // Not merely "no rows": an id that is not a user at all, so a caller can
    // never confuse a missing subject with a missing history.
    expect(await signalsOf(castId<SubjectId>(randomUUID()))).toEqual([]);
  });

  it('refuses a limit that cannot mean a window', async () => {
    const subject = await newSubject();
    await expect(
      transaction.run((tx) => store.findSignalsFor(subject, 0, tx)),
    ).rejects.toBeInstanceOf(StoreError);
    await expect(
      transaction.run((tx) => store.findSignalsFor(subject, -1, tx)),
    ).rejects.toBeInstanceOf(StoreError);
  });

  it('leaves nothing behind when the unit of work rolls back', async () => {
    const subject = await newSubject();
    const doomed = signal(subject);

    await expect(
      transaction.run(async (tx) => {
        await store.appendSignal(doomed, tx);
        await store.upsertAssessment(
          subject,
          castId<RiskAssessmentId>(randomUUID()),
          'high',
          doomed.occurredAt,
          ['link_velocity'],
          tx,
        );
        throw new Error('moderation refused the decision');
      }),
    ).rejects.toThrow('moderation refused the decision');

    expect(await signalsOf(subject)).toEqual([]);
    expect(await assessmentOf(subject)).toBeNull();
  });

  it('refuses to run outside a unit of work rather than on a released connection', async () => {
    const subject = await newSubject();
    await expect(store.appendSignal(signal(subject), transaction)).rejects.toBeInstanceOf(
      StoreError,
    );
    expect(await signalsOf(subject)).toEqual([]);
  });

  it('raises on a corrupt facts column instead of handing the domain undefined', async () => {
    const subject = await newSubject();
    // The column is NOT NULL and `jsonb` accepts any JSON, so a scalar passes
    // every constraint and still is not the derived-metadata object the domain
    // indexes into.
    await raw.query(
      `INSERT INTO app.risk_signals (signal_id, subject_id, detector, behaviour, facts, weight, occurred_at)
       VALUES ($1, $2, 'manual_edit', 'edited', '"a string, not an object"'::jsonb, 0.5, now())`,
      [randomUUID(), subject],
    );

    await expect(signalsOf(subject)).rejects.toBeInstanceOf(StoreError);
    await expect(signalsOf(subject)).rejects.toThrow(/facts/);
  });

  it('reports no assessment as null, and a written one as a row', async () => {
    const subject = await newSubject();
    expect(await assessmentOf(subject)).toBeNull();

    const assessmentId = castId<RiskAssessmentId>(randomUUID());
    const lastSignalAt = new Date('2026-05-05T09:30:00.000Z');
    await transaction.run((tx) =>
      store.upsertAssessment(
        subject,
        assessmentId,
        'high',
        lastSignalAt,
        ['link_velocity', 'harassment_language'],
        tx,
      ),
    );

    const found = await assessmentOf(subject);
    expect(found?.subjectId).toBe(subject);
    expect(found?.assessmentId).toBe(assessmentId);
    expect(found?.state).toBe('high');
    expect(found?.lastSignalAt?.toISOString()).toBe(lastSignalAt.toISOString());
    // A `text[]` read as a list, not a JSON blob the caller has to parse.
    expect(found?.contributingDetectors).toEqual(['link_velocity', 'harassment_language']);
  });

  it('replaces the detector list on re-assessment, so decayed detectors do not accumulate', async () => {
    const subject = await newSubject();

    await assess(subject, 'high', new Date('2026-05-01T00:00:00.000Z'), [
      'link_velocity',
      'image_similarity',
    ]);
    await assess(subject, 'elevated', new Date('2026-06-01T00:00:00.000Z'), ['link_velocity']);

    const found = await assessmentOf(subject);
    expect(found?.state).toBe('elevated');
    expect(found?.contributingDetectors).toEqual(['link_velocity']);
  });

  it('keeps one subject assessment out of another subject row', async () => {
    const mine = await newSubject();
    const theirs = await newSubject();
    await assess(mine, 'high', null, ['link_velocity']);
    await assess(theirs, 'normal', null, []);

    expect((await assessmentOf(theirs))?.contributingDetectors).toEqual([]);
    expect((await assessmentOf(mine))?.state).toBe('high');
  });

  it('stores an empty detector list as an empty list and no signal date as null', async () => {
    const subject = await newSubject();
    await assess(subject, 'normal', null, []);

    const found = await assessmentOf(subject);
    expect(found?.contributingDetectors).toEqual([]);
    expect(found?.lastSignalAt).toBeNull();
  });

  it('stores detector names as a Postgres array, not as an encoded string', async () => {
    const subject = await newSubject();
    // Names a hand-built array literal or a JSON blob would mangle: a comma,
    // a quote, a brace, and a backslash are all array-syntax characters.
    const awkward = ['a,b', 'c"d', 'e{f}', 'back\\slash', ' leading space '];
    await assess(subject, 'high', null, awkward);

    const found = await assessmentOf(subject);
    expect(found?.contributingDetectors).toEqual(awkward);
  });

  it('surfaces a state the risk machine cannot produce as a fault, not a silent no-op', async () => {
    const subject = await newSubject();
    await expect(assess(subject, 'imminent_danger', null, [])).rejects.toBeInstanceOf(StoreError);
    expect(await assessmentOf(subject)).toBeNull();
  });

  it('surfaces an out-of-range weight as a fault, and does not record the signal', async () => {
    const subject = await newSubject();
    await expect(append(signal(subject, { weight: 1.5 }))).rejects.toBeInstanceOf(StoreError);
    expect(await signalsOf(subject)).toEqual([]);
  });

  it('surfaces a signal for a subject that is not a user, rather than orphaning it', async () => {
    await expect(append(signal(castId<SubjectId>(randomUUID())))).rejects.toBeInstanceOf(
      StoreError,
    );
  });

  it('reports a query fault as a StoreError, not as an empty history', async () => {
    const subject = await newSubject();
    await raw.query('ALTER TABLE app.risk_signals RENAME TO risk_signals_moved');

    try {
      await expect(signalsOf(subject)).rejects.toBeInstanceOf(StoreError);
    } finally {
      await raw.query('ALTER TABLE app.risk_signals_moved RENAME TO risk_signals');
    }

    expect(await signalsOf(subject)).toEqual([]);
  });
});
