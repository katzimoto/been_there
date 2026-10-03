import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { castId, type UserId } from '@been-there/core';
import { type Caller, type Harness, call, member, startHarness } from './support/harness.js';
import { COMPLETE_PROFILE, PASSING_RESULT, newPeer, verify } from './support/fixtures.js';
import { createServiceSafety } from '@been-there/service';

/**
 * The skip-and-report path, end to end, against the real database.
 *
 * What is being proved is not "a ledger can be rebuilt" — it is that a row the
 * domain cannot use produces a **number the caller can read**. Two failure modes
 * are being distinguished, and they look identical from the outside if the count
 * is missing:
 *
 *  - the guard held, and
 *  - nothing happened at all.
 *
 * So this suite asserts both directions. An authored row replays and lands in
 * the ledger (proving the pipe is connected), and a null-author row is skipped,
 * counted and attributed (proving the pipe is honest about its gaps). Asserting
 * only the second would pass against a wiring that never replayed anything.
 */

describe('a replay skips what it cannot use and says how much', () => {
  let harness: Harness;
  const callers: Caller[] = [];

  /**
   * The recorder the routes actually used.
   *
   * `createServiceSafety` memoises on the `ServiceDependencies` identity, so this
   * has to be the harness's own object — a suite that built a second set would
   * get a fresh recorder with an empty ledger and assert against a recorder no
   * request ever touched.
   */
  const safety = () => {
    if (harness.dependencies === undefined) {
      throw new Error('harness was hand-built, so it has no recorder to observe');
    }
    return createServiceSafety(harness.dependencies);
  };

  beforeAll(async () => {
    const first = member('first');
    callers.push(first);
    harness = await startHarness(callers);
  });

  afterAll(async () => {
    await harness?.close();
  });

  /**
   * A signed-up account with its own token and **no profile yet**.
   *
   * Deliberately un-profiled: completing a profile is itself an observed
   * behaviour, and a subject's ledger is seeded from the store on its *first*
   * observation. So a row written after profiling would never be replayed — the
   * suite would then be testing nothing. Sign-up writes no signal and observes
   * nothing, which makes this the one point where rows can be planted.
   */
  async function account(token: string): Promise<UserId> {
    return (await newPeer(harness, callers, token)).userId;
  }

  /** The first observed behaviour for this subject, which triggers the seed. */
  async function observe(token: string, userId: UserId): Promise<void> {
    await call(harness, 'PUT', `/v1/accounts/${userId}/profile`, token, COMPLETE_PROFILE);
    await verify(harness, token, userId, PASSING_RESULT);
  }

  /**
   * A signal row written straight through the store, so the suite cannot drift
   * from the column names.
   *
   * `declaration: null` is the shape a row written before migration 007 has: the
   * author columns exist and say nothing. `weight` is left out of that case on
   * purpose — an unauthored row is skipped before anything else is examined.
   */
  async function appendSignal(
    subject: UserId,
    signalId: string,
    options: { readonly declaration: null | { reliability: string } },
  ): Promise<void> {
    await harness.transaction.run((tx) =>
      harness.stores.risk.appendSignal(
        {
          signalId,
          subjectId: String(subject),
          detector: 'velocity.like_burst',
          behaviour: 'like_velocity',
          entityId: signalId,
          facts: {},
          weight: 0.5,
          occurredAt: new Date('2026-03-01T00:00:00.000Z'),
          actorId: String(subject),
          ...(options.declaration === null
            ? { reliability: null, category: null, escalation: null }
            : {
                reliability: options.declaration.reliability,
                category: 'velocity',
                escalation: 'corroboration_only',
              }),
        },
        tx,
      ),
    );
  }

  async function signalIdsOf(subject: UserId): Promise<readonly unknown[]> {
    return harness.transaction.run((tx) =>
      harness.stores.risk.findSignalsFor(castId<'SubjectId'>(String(subject)), 100, tx),
    ).then((rows) => rows.map((row) => row['signalId']));
  }

  it('counts an authored row as replayed and a null-author row as skipped, naming both', async () => {
    // Both rows are written *before* the subject is observed, because seeding
    // happens once per subject on its first observation — a row written after
    // that is simply never replayed, which is the point of the bound.
    const subject = await account('subject');
    const observer = await account('observer');
    await appendSignal(subject, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {
      declaration: { reliability: 'high' },
    });
    await appendSignal(subject, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', { declaration: null });

    await observe('subject', subject);

    const report = safety()
      .recorder.replays()
      .find((entry) =>
        entry.skipped.some((row) => row.signalId === 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
      );

    // The count is observable by the caller, through the recorder the routes used.
    expect(report).toBeDefined();
    expect(report?.skippedByReason.no_author).toBe(1);
    expect(report?.skipped[0]?.reason).toBe('no_author');
    // The specific row, not a total: an operator can find it in `risk_signals`.
    expect(report?.skipped[0]?.signalId).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

    // The other half of the pair, and the half that makes this test worth
    // anything: the authored row in the *same* window was replayed. A skip
    // count on its own is satisfied by a replay that folds nothing at all — the
    // report would still name the one bad row while every good row was quietly
    // discarded — so without this assertion the suite passes against a dead
    // pipe. Verified: mutating the replay to build each signal and then drop it
    // leaves this assertion red.
    expect(report?.replayed).toBe(1);
    expect(report?.skipped.map((row) => row.signalId)).not.toContain(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
  });

  it('keeps the skipped row in the log rather than deleting the evidence', async () => {
    // The row is unusable for replay, not worthless: `risk_signals` is what a
    // moderator re-reads, so removing it would destroy the record of the
    // observation. Only the replay declines to fold it.
    const subject = await account('keeper');
    await appendSignal(subject, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', { declaration: null });

    await observe('keeper', subject);

    const report = safety()
      .recorder.replays()
      .find((entry) =>
        entry.skipped.some((row) => row.signalId === 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
      );
    expect(report?.skippedByReason.no_author).toBe(1);

    expect(await signalIdsOf(subject)).toContain('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  });

  it('reports nothing for a subject whose whole history is replayable', async () => {
    const subject = await account('clean');
    await appendSignal(subject, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', {
      declaration: { reliability: 'medium' },
    });

    await observe('clean', subject);

    // No report at all: a gap-free replay has nothing to say, so an empty
    // `replays()` is the signal that every ledger in this process is whole.
    expect(
      safety()
        .recorder.replays()
        .some((entry) => entry.skipped.some((row) => row.signalId === 'dddddddd-dddd-4ddd-8ddd-dddddddddddd')),
    ).toBe(false);
  });
});
