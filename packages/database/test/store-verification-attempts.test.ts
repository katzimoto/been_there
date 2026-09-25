/**
 * The verification attempt store's promises, proven against a real database.
 *
 * The test that matters most is the round trip. `submitToProvider` re-derives
 * its decision from the attempt it is handed, and `recordCapture` reads the
 * evidence and the completed checks back before it will accept a retake, so a
 * store that persisted a subset of the aggregate would not fail here — it would
 * let the domain's guard disagree with what is stored, on a decision about
 * whether a real person gets verified. Every field the aggregate has is written
 * and read back, and the field set is compared as well as the values, so a
 * dropped field fails rather than quietly vanishing.
 *
 * `beforeAll` probes the schema and fails if the table is not there. A suite
 * that passes because it connected to nothing is the worst outcome available.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { PoolClient } from 'pg';
import { castId, type UserId } from '@been-there/core';
import { StoreError, type Transaction } from '@been-there/contracts';
import { createTransaction } from '../src/transaction.js';
import {
  PgVerificationAttemptStore,
  VerificationAttemptStoreError,
  type AttemptRecord,
} from '../src/store-verification-attempts.js';

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

/** The table exactly as the schema declares it: seven columns, no payload column. */
const EXPECTED_COLUMNS = [
  'attempt_id',
  'user_id',
  'state',
  'checks',
  'provider_reference',
  'opened_at',
  'closed_at',
];

const OPEN_STATES = ['initiated', 'capturing', 'awaiting_provider', 'manual_review'];
const CLOSED_STATES = ['passed', 'failed', 'expired'];

/**
 * A complete, current envelope, as SQL rather than as a string the driver would
 * have to parse. Used to build rows the store must refuse: the documents are
 * valid in every respect except the one under test.
 */
const VALID_ENVELOPE = `jsonb_build_object(
  'schemaVersion', 1, 'updatedAt', '2026-03-01T10:22:45.678Z', 'reVerification', false,
  'reason', '{"code":"onboarding"}', 'expiresAt', '2026-03-01T10:30:30.123Z',
  'submittedAt', NULL, 'completedChecks', '[]', 'evidence', '[]', 'confidence', NULL,
  'decision', NULL, 'reviewerId', NULL)`;

describeIfDb('VerificationAttemptStore, against Postgres', () => {
  let pool: pg.Pool;
  let raw: PoolClient;
  let transaction: Transaction;
  const store = new PgVerificationAttemptStore();

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString });
    raw = await pool.connect();
    transaction = createTransaction(pool);
    const columns = await raw.query<{ readonly column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'app' AND table_name = 'verification_attempts'
        ORDER BY ordinal_position`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual(EXPECTED_COLUMNS);
    const index = await raw.query<{ readonly indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'app' AND indexname = 'verification_attempts_one_open'`,
    );
    expect(index.rows).toHaveLength(1);
    expect(index.rows[0]!.indexdef).toContain('closed_at IS NULL');
  });

  afterAll(async () => {
    if (pool !== undefined) {
      raw.release();
      await pool.end();
    }
  });

  /** A user the attempts table can point at: the foreign key demands one. */
  async function newUser(): Promise<UserId> {
    const id = randomUUID();
    await raw.query('INSERT INTO app.users (user_id, account_id) VALUES ($1, $2)', [
      id,
      randomUUID(),
    ]);
    return castId<'UserId'>(id);
  }

  /**
   * An attempt carrying *every* field the domain's `VerificationAttempt` has,
   * with nothing null that the domain would have filled in. Each is set to a
   * value no default or partial write could produce by accident.
   */
  function fullAttempt(
    subjectId: UserId,
    overrides: Readonly<Record<string, unknown>> = {},
  ): Readonly<Record<string, unknown>> {
    return {
      verificationId: `attempt:${randomUUID()}`,
      subjectId,
      state: 'awaiting_provider',
      reVerification: true,
      reason: {
        code: 'anomaly_findings',
        findings: [
          {
            code: 'repeated_failed_attempts',
            severity: 'review',
            observations: { attempts: 3, windowDays: 30 },
          },
        ],
      },
      startedAt: new Date('2026-03-01T10:15:30.123Z'),
      updatedAt: new Date('2026-03-01T10:22:45.678Z'),
      expiresAt: new Date('2026-03-01T10:30:30.123Z'),
      submittedAt: new Date('2026-03-01T10:22:00.000Z'),
      completedChecks: ['document_authenticity', 'liveness', 'likeness'],
      evidence: [
        {
          kind: 'government_id_image',
          verificationId: 'attempt:seed',
          capturedAt: new Date('2026-03-01T10:16:00.000Z'),
          storageRef: 'evidence://store/obj_01HZ-not-a-url',
          sensitivity: 'restricted',
          digest: 'a'.repeat(64),
          expiresAt: new Date('2026-03-31T10:16:00.000Z'),
        },
        {
          kind: 'selfie_image',
          verificationId: 'attempt:seed',
          capturedAt: new Date('2026-03-01T10:18:30.500Z'),
          storageRef: 'evidence://store/obj_01HZ-also-not-a-url',
          sensitivity: 'restricted',
          digest: 'b'.repeat(64),
          expiresAt: new Date('2026-03-31T10:18:30.500Z'),
        },
      ],
      confidence: { value: 0.87, band: 'sufficient' },
      decision: {
        decision: 'pass',
        confidence: { value: 0.87, band: 'sufficient' },
        rationale: ['all required checks reported', 'no blocking anomaly'],
        missingChecks: [],
      },
      reviewerId: 'moderator-42',
      providerReference: 'vendor-ref-8f2c1d',
      ...overrides,
    };
  }

  function findOpenFor(userId: UserId): Promise<AttemptRecord | null> {
    return transaction.run((tx) => store.findOpenFor(userId, tx));
  }

  function update(attemptId: string, patch: Readonly<Record<string, unknown>>): Promise<boolean> {
    return transaction.run((tx) => store.update(attemptId, patch, tx));
  }

  function insert(attempt: Readonly<Record<string, unknown>>): Promise<void> {
    return transaction.run((tx) => store.insert(attempt, tx));
  }

  function find(attemptId: string): Promise<AttemptRecord | null> {
    return transaction.run((tx) => store.find(attemptId, tx));
  }


  // ------------------------------------------------------------- the shape --

  it('round-trips every field of the aggregate, and the field set with it', async () => {
    const user = await newUser();
    const attempt = fullAttempt(user);
    await insert(attempt);

    const found = await find(attempt['verificationId'] as string);
    expect(found).not.toBeNull();
    // The set is compared as well as the values: a field this store stopped
    // persisting would otherwise simply not appear, and `toEqual` on the whole
    // record is what makes that a failure rather than a shorter answer.
    expect(Object.keys(found!).sort()).toEqual(Object.keys(attempt).sort());
    expect(found).toEqual(attempt);

    // And the four fields the lifecycle actually reads back, named one by one,
    // because a failure here has to say which one went missing.
    expect(found!.completedChecks).toEqual(['document_authenticity', 'liveness', 'likeness']);
    expect(found!.evidence).toHaveLength(2);
    expect(found!.evidence[0]!.capturedAt).toBeInstanceOf(Date);
    expect(found!.evidence[0]!.capturedAt.toISOString()).toBe('2026-03-01T10:16:00.000Z');
    expect(found!.evidence[1]!.digest).toBe('b'.repeat(64));
    expect(found!.confidence).toEqual({ value: 0.87, band: 'sufficient' });
    expect(found!.decision).toEqual(attempt['decision']);
    expect(found!.reason).toEqual(attempt['reason']);
    expect(found!.reviewerId).toBe('moderator-42');
    expect(found!.submittedAt?.toISOString()).toBe('2026-03-01T10:22:00.000Z');
    expect(found!.expiresAt.toISOString()).toBe('2026-03-01T10:30:30.123Z');
    expect(found!.reVerification).toBe(true);
  });

  it('reads back a null decision, confidence, reviewer and submitted time as null', async () => {
    const user = await newUser();
    const attempt = fullAttempt(user, {
      state: 'initiated',
      submittedAt: null,
      confidence: null,
      decision: null,
      reviewerId: null,
      providerReference: null,
      completedChecks: [],
      evidence: [],
    });
    await insert(attempt);

    const found = await find(attempt['verificationId'] as string);
    expect(found).toEqual(attempt);
    expect(found!.decision).toBeNull();
    expect(found!.confidence).toBeNull();
    expect(found!.providerReference).toBeNull();
  });

  // ---------------------------------------------------------- the one index --

  it('refuses a second open attempt for one user and says which refusal it was', async () => {
    const user = await newUser();
    await insert(fullAttempt(user));

    const failure = await insert(fullAttempt(user)).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(VerificationAttemptStoreError);
    expect((failure as VerificationAttemptStoreError).reason).toBe('open_attempt_exists');
    expect((failure as VerificationAttemptStoreError).retryable).toBe(false);

    const rows = await raw.query<{ readonly count: string }>(
      'SELECT count(*) FROM app.verification_attempts WHERE user_id = $1 AND closed_at IS NULL',
      [user],
    );
    expect(rows.rows[0]!.count).toBe('1');
  });

  it('gives one open attempt and a distinguishable conflict to two concurrent inserts', async () => {
    const user = await newUser();
    const results = await Promise.allSettled([
      insert(fullAttempt(user)),
      insert(fullAttempt(user)),
    ]);
    const refused = results.filter((result) => result.status === 'rejected');
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(refused).toHaveLength(1);
    const reason = (refused[0] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(VerificationAttemptStoreError);
    expect((reason as VerificationAttemptStoreError).reason).toBe('open_attempt_exists');

    const open = await findOpenFor(user);
    expect(open).not.toBeNull();
  });

  it('tells a reused attempt id apart from a second open attempt', async () => {
    const first = await newUser();
    const second = await newUser();
    const attempt = fullAttempt(first);
    await insert(attempt);

    const failure = await insert(fullAttempt(second, { verificationId: attempt['verificationId'] })).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(VerificationAttemptStoreError);
    // Same outcome, different cause: the caller can return the user's open
    // attempt for the second and reject the id for the third.
    expect((failure as VerificationAttemptStoreError).reason).toBe('attempt_id_taken');
  });

  it('derives open or closed from the state, and frees the index by closing', async () => {
    for (const state of [...OPEN_STATES, ...CLOSED_STATES]) {
      const user = await newUser();
      const attempt = fullAttempt(user, { state });
      await insert(attempt);
      const found = await find(attempt['verificationId'] as string);
      expect(found?.state).toBe(state);
      const open = await findOpenFor(user);
      if (OPEN_STATES.includes(state)) {
        expect(open?.verificationId).toBe(attempt['verificationId']);
      } else {
        expect(open).toBeNull();
      }
    }

    // A closed attempt leaves the user able to start again, which is the whole
    // point of the index being partial rather than a plain unique constraint.
    const user = await newUser();
    await insert(fullAttempt(user, { state: 'failed' }));
    await insert(fullAttempt(user));
    expect(await findOpenFor(user)).not.toBeNull();
  });

  // ------------------------------------------------------------ the patching --

  it('refuses to move a closed attempt back to open, and closes an open one', async () => {
    const user = await newUser();
    const open = fullAttempt(user);
    await insert(open);

    expect(await update(open['verificationId'] as string, { state: 'passed' })).toBe(true);
    expect((await findOpenFor(user))).toBeNull();

    // A refusal is `false`, not a fault: the attempt is there, the patch is not
    // one it will take. A stale client replaying a `capturing` event against an
    // attempt that has since passed must not be able to undo the outcome, and
    // must not be told it succeeded either.
    expect(await update(open['verificationId'] as string, { state: 'capturing' })).toBe(false);
    const attemptId = open['verificationId'] as string;
    expect((await find(attemptId))?.state).toBe('passed');
    expect(await findOpenFor(user)).toBeNull();

    // A closed attempt stays closed against a patch that does not name a state
    // at all: `closed_at` is not a patchable key, so there is nothing to reopen
    // it with.
    expect(await update(attemptId, { reviewerId: 'moderator-7' })).toBe(true);
    expect((await find(attemptId))?.state).toBe('passed');
    expect(await findOpenFor(user)).toBeNull();
  });

  it('leaves the rest of the aggregate alone when one field is patched', async () => {
    const user = await newUser();
    const attempt = fullAttempt(user);
    await insert(attempt);
    const attemptId = attempt['verificationId'] as string;

    await update(attemptId, { state: 'passed', submittedAt: new Date('2026-03-01T11:00:00.000Z') });
    const closed = await find(attemptId);
    expect(closed?.state).toBe('passed');
    // The decision and the evidence the domain produced are untouched, which is
    // what stops a state change from leaving a stored outcome behind that
    // contradicts it.
    expect(closed?.decision).toEqual(attempt['decision']);
    expect(closed?.evidence).toEqual(attempt['evidence']);
    expect(closed?.completedChecks).toEqual(attempt['completedChecks']);
    expect(closed?.submittedAt?.toISOString()).toBe('2026-03-01T11:00:00.000Z');

    // Patching one envelope key replaces only that key.
    await update(attemptId, { completedChecks: ['document_authenticity'] });
    const retaken = await find(attemptId);
    expect(retaken?.completedChecks).toEqual(['document_authenticity']);
    expect(retaken?.evidence).toEqual(attempt['evidence']);
    expect(retaken?.reason).toEqual(attempt['reason']);
    expect(retaken?.providerReference).toBe('vendor-ref-8f2c1d');
  });

  it('refuses a patch that would rewrite a fixed field, or name one that is not a field', async () => {
    const user = await newUser();
    const attempt = fullAttempt(user);
    await insert(attempt);
    const attemptId = attempt['verificationId'] as string;

    await expect(update(attemptId, { startedAt: new Date('2020-01-01T00:00:00.000Z') })).rejects.toThrow(
      StoreError,
    );
    await expect(update(attemptId, { decison: 'pass' })).rejects.toThrow(StoreError);
    await expect(update(attemptId, { providerPayload: { image: 'base64' } })).rejects.toThrow(
      StoreError,
    );
    expect((await find(attemptId))?.startedAt).toEqual(attempt['startedAt']);
  });

  it('reports a patch to an attempt that is not there as false, not as a fault', async () => {
    const user = await newUser();
    expect(await update('attempt:never-existed', { state: 'passed' })).toBe(false);
  });

  // ------------------------------------------------------------- the refusals --

  it('answers null for no row and throws for a row it cannot read whole', async () => {
    expect(await find('attempt:never-existed')).toBeNull();
    expect(await findOpenFor(await newUser())).toBeNull();

    // Each row below is written behind the store's back, and each needs its own
    // user: an open row per user is exactly what the partial index enforces, so
    // sharing one would fail on the index rather than on what is being tested.
    // The schema's own default for `checks` is a jsonb array, and a row like
    // that is not an attempt with no checks — it is a row this store cannot
    // read, and handing it to `submitToProvider` would be handing over a guess.
    const notAnEnvelope = `attempt:raw-${randomUUID()}`;
    await raw.query(
      `INSERT INTO app.verification_attempts (attempt_id, user_id, state, checks, opened_at)
       VALUES ($1, $2, 'capturing', '[]'::jsonb, now())`,
      [notAnEnvelope, await newUser()],
    );
    await expect(find(notAnEnvelope)).rejects.toThrow(StoreError);

    // An otherwise valid envelope with something stuffed into it that is not
    // part of the aggregate. This is the guard that keeps a provider response
    // or a captured image out of a column that has no business holding either.
    const stuffed = `attempt:stuffed-${randomUUID()}`;
    await raw.query(
      `INSERT INTO app.verification_attempts (attempt_id, user_id, state, checks, opened_at)
       VALUES ($1, $2, 'capturing', (${VALID_ENVELOPE})::jsonb
               || '{"providerResponse": {"image": "base64"}}'::jsonb, now())`,
      [stuffed, await newUser()],
    );
    await expect(find(stuffed)).rejects.toThrow(StoreError);

    // An envelope from a build that shaped it differently: read as though it
    // were current, the fields would be there but mean something else.
    const future = `attempt:future-${randomUUID()}`;
    await raw.query(
      `INSERT INTO app.verification_attempts (attempt_id, user_id, state, checks, opened_at)
       VALUES ($1, $2, 'capturing',
               (${VALID_ENVELOPE})::jsonb || '{"schemaVersion":2}'::jsonb, now())`,
      [future, await newUser()],
    );
    await expect(find(future)).rejects.toThrow(StoreError);

    // A row whose closed_at disagrees with its state: which of the two
    // open-attempt questions it answers cannot be told, so it is refused rather
    // than read as whichever half the store happens to check first.
    const inconsistent = `attempt:inconsistent-${randomUUID()}`;
    await raw.query(
      `INSERT INTO app.verification_attempts
         (attempt_id, user_id, state, opened_at, closed_at, checks)
       VALUES ($1, $2, 'capturing', now(), now(), ${VALID_ENVELOPE})`,
      [inconsistent, await newUser()],
    );
    await expect(find(inconsistent)).rejects.toThrow(StoreError);
  });

  it('refuses an aggregate that is missing a field rather than storing a hole', async () => {
    const user = await newUser();
    const attempt = fullAttempt(user);
    const { decision: _omitted, ...withoutDecision } = attempt;
    await expect(insert(withoutDecision)).rejects.toThrow(StoreError);
    await expect(insert({ ...attempt, reason: { findings: [] } })).rejects.toThrow(StoreError);
  });

  it('rolls back with the transaction that opened the attempt', async () => {
    const user = await newUser();
    const attempt = fullAttempt(user);
    await expect(
      transaction.run(async (tx) => {
        await store.insert(attempt, tx);
        throw new Error('a later step in the same unit of work failed');
      }),
    ).rejects.toThrow('a later step in the same unit of work failed');
    expect(await find(attempt['verificationId'] as string)).toBeNull();
  });
});
