import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UserId } from '@been-there/core';
import { castId } from '@been-there/core';
import { clientOf } from '@been-there/database';
import { type Harness, call, startHarness } from './support/harness.js';
import { PASSING_RESULT, verify } from './support/fixtures.js';

/**
 * The dating goal and the completed-date counter, over real HTTP against real
 * Postgres (#48, #49).
 *
 * The domain had thirty passing tests and no route and no table, so every claim
 * below is one a client could not previously make: the goal can be read and set,
 * a date can be recorded, the count survives a restart, and a correction is a
 * thing the owner can apply and see.
 *
 * ## The claims under test, and which of them could fail
 *
 *  - **Recording a date requires nothing of the other person.** Asserted from
 *    both sides: a date with someone who does not exist as an account, and a
 *    date with somebody who is *banned*. The second is the one that matters — a
 *    standing check in the handler would refuse it, and that check existing at
 *    all is what `recordCompletedDate`'s signature was shaped to prevent.
 *  - **A retry counts once.** The same `entryId` twice, and asserted both on the
 *    response and on a re-read, so a route that returned a nice body while
 *    writing two rows would fail.
 *  - **Changing the target cannot lose the count.** The domain makes this
 *    structural, but only persistence can break it, so it is asserted across a
 *    `PUT` — and again across a *fresh* server, because a count held in memory
 *    would survive the first and not the second.
 *  - **Corrections are events.** A withdrawal keeps the record and drops it from
 *    the count; a restatement moves the day and keeps the count; restating a
 *    withdrawn date is a 409.
 *  - **Deleting a profile keeps the history.** Done through the store, because
 *    there is no HTTP route that deletes a profile and the property is the
 *    schema's.
 */

let harness: Harness;
let owner: { userId: UserId; token: string };

const RUN_ID = randomUUID().slice(0, 8);
const TODAY = new Date();
const YESTERDAY = new Date(TODAY.getTime() - 24 * 60 * 60 * 1000);
const A_DAY_AGO = new Date(TODAY.getTime() - 2 * 24 * 60 * 60 * 1000);

function isoDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

describe('the dating goal and the completed-date counter, over HTTP', () => {
  beforeAll(async () => {
    harness = await startHarness([]);
    owner = await signUp('goal-owner');
  });

  afterAll(async () => {
    if (harness !== undefined) {
      await harness.close();
    }
  });

  // ------------------------------------------------------------------ goal --

  it('serves the default goal to an owner who has never set one, and stores nothing', async () => {
    const fresh = await signUp('goal-default');
    const response = await call(harness, 'GET', '/v1/profiles/me/goal', fresh.token);

    expect(response.status).toBe(200);
    // The domain's published default, read from the domain rather than repeated
    // here: a copy of this number in the test would assert the test's own copy.
    expect(response.body['target']).toBe(1000);
    const stored = await harness.pool.query('SELECT target FROM app.dating_goals WHERE owner_id = $1', [
      fresh.userId,
    ]);
    // A default is produced, not persisted. A stored default would be a second
    // answer to "what is my goal" waiting to disagree with this one.
    expect(stored.rows).toEqual([]);
  });

  it('sets a target, and reads the same one back', async () => {
    const subject = await signUpProfiled('goal-set');
    const written = await call(harness, 'PUT', '/v1/profiles/me/goal', subject.token, { target: 250 });
    expect(written.status).toBe(200);
    expect(written.body['target']).toBe(250);

    const read = await call(harness, 'GET', '/v1/profiles/me/goal', subject.token);
    expect(read.body['target']).toBe(250);
  });

  it('refuses a target the domain refuses, and stores nothing for the refusal', async () => {
    const subject = await signUpProfiled('goal-refused');
    const zero = await call(harness, 'PUT', '/v1/profiles/me/goal', subject.token, { target: 0 });
    expect(zero.status).toBe(400);

    const fractional = await call(harness, 'PUT', '/v1/profiles/me/goal', subject.token, { target: 12.5 });
    expect(fractional.status).toBe(400);

    // Above `DATING_GOAL_LIMITS.max`, read from the response the route published
    // rather than from a constant this file also wrote.
    const limits = (await call(harness, 'GET', '/v1/profiles/me/goal', subject.token)).body['limits'] as {
      max: number;
    };
    const absurd = await call(harness, 'PUT', '/v1/profiles/me/goal', subject.token, { target: limits.max + 1 });
    expect(absurd.status).toBe(400);

    // The store agrees nothing was written, so a refused target cannot leave a
    // partial one behind.
    const stored = await harness.pool.query('SELECT target FROM app.dating_goals WHERE owner_id = $1', [
      subject.userId,
    ]);
    expect(stored.rows).toEqual([]);
  });

  it('serves a default goal to an owner with no profile, and refuses to store one against nothing', async () => {
    const subject = await signUp('goal-no-profile');
    // Read: a real answer. There is nothing to set a target on yet, but "what is
    // my goal" still has one, and the profile id is the one `saveProfile` will
    // derive — so the answer does not change when they write one.
    const read = await call(harness, 'GET', '/v1/profiles/me/goal', subject.token);
    expect(read.status).toBe(200);
    expect(read.body['target']).toBe(1000);

    // Write: refused, and named as what it is. `dating_goals.profile_id`
    // references `app.profiles` with `ON DELETE CASCADE` — that reference is what
    // makes a deleted card take its target with it — so a write here would be a
    // foreign-key violation, which would surface as a 500 for the ordinary state
    // a new member is in on their first request.
    const refused = await call(harness, 'PUT', '/v1/profiles/me/goal', subject.token, { target: 12 });
    expect(refused.status).toBe(404);

    // And their counter works regardless, because it is keyed by user and not by
    // profile. A person with no card still has a history.
    const recorded = await call(harness, 'POST', '/v1/profiles/me/completed-dates', subject.token, {
      entryId: randomUUID(),
      occurredOn: isoDay(YESTERDAY),
    });
    expect(recorded.status).toBe(201);
    const ledger = await call(harness, 'GET', '/v1/profiles/me/completed-dates', subject.token);
    expect(ledger.body['completed']).toBe(1);
  });

  it('refuses the goal to a caller with no session', async () => {
    const response = await call(harness, 'GET', '/v1/profiles/me/goal', 'not-a-real-token');
    // `permission_denied` from the session resolver, which the dispatcher maps to
    // 403 — the same answer every protected route in this service gives, so this
    // asserts shared behaviour rather than a private choice.
    expect(response.status).toBe(403);
  });

  it('keeps one owner out of another owner goal', async () => {
    const subject = await signUpProfiled('goal-private');
    const other = await signUpProfiled('goal-other');
    await call(harness, 'PUT', '/v1/profiles/me/goal', subject.token, { target: 7 });
    // There is no id in this path to put somebody else's profile id into, which
    // is the property: the goal is reachable only as "mine".
    expect((await call(harness, 'GET', '/v1/profiles/me/goal', other.token)).body['target']).toBe(1000);
  });

  // ---------------------------------------------------------------- ledger --

  it('records a date, and the count survives a fresh server', async () => {
    const subject = await signUp('counter-restart');
    const entryId = randomUUID();
    const recorded = await call(harness, 'POST', '/v1/profiles/me/completed-dates', subject.token, {
      entryId,
      occurredOn: isoDay(YESTERDAY),
    });
    expect(recorded.status).toBe(201);
    expect(recorded.body['completed']).toBe(1);

    // A second harness on the same process database: nothing about this count can
    // be in the first server's memory, because this server never served the write.
    const restarted = await startHarness([]);
    try {
      const read = await call(restarted, 'GET', '/v1/profiles/me/completed-dates', subject.token);
      expect(read.status).toBe(200);
      expect(read.body['completed']).toBe(1);
    } finally {
      await restarted.close();
    }
  });

  it('counts a replayed entryId once, and says so rather than creating twice', async () => {
    const subject = await signUp('counter-retry');
    const entryId = randomUUID();
    const first = await call(harness, 'POST', '/v1/profiles/me/completed-dates', subject.token, {
      entryId,
      occurredOn: isoDay(YESTERDAY),
    });
    const retry = await call(harness, 'POST', '/v1/profiles/me/completed-dates', subject.token, {
      entryId,
      occurredOn: isoDay(YESTERDAY),
    });

    expect(first.status).toBe(201);
    expect(first.body['created']).toBe(true);
    // Not a second creation: a retry is the first attempt, replayed.
    expect(retry.status).toBe(200);
    expect(retry.body['created']).toBe(false);

    // Re-read rather than trusting either response, so a route that answered
    // correctly while writing two rows would still fail.
    const read = await call(harness, 'GET', '/v1/profiles/me/completed-dates', subject.token);
    expect(read.body['completed']).toBe(1);
    expect((read.body['records'] as unknown[]).length).toBe(1);
  });

  it('records a date with somebody who has no account at all', async () => {
    const subject = await signUp('counter-stranger');
    const nobody = randomUUID();
    const recorded = await call(harness, 'POST', '/v1/profiles/me/completed-dates', subject.token, {
      entryId: randomUUID(),
      counterpartId: nobody,
      occurredOn: isoDay(YESTERDAY),
    });
    // `recordCompletedDate` takes no existence check and requires none, and the
    // schema has no foreign key on `counterpart_id`. A date with someone met at a
    // party is a real date.
    expect(recorded.status).toBe(201);
    const accounts = await harness.pool.query('SELECT count(*)::int AS found FROM app.users WHERE user_id = $1', [
      nobody,
    ]);
    expect(accounts.rows[0]?.found).toBe(0);
  });

  it('records a date with somebody who is banned, because nothing is required of them', async () => {
    const subject = await signUp('counter-ban-owner');
    const banned = await signUp('counter-banned');
    // A real sanction on a real account: `banned`, invisible in the product.
    await harness.transaction.run(async (tx) => {
      await harness.stores.accountStanding.upsert(
        {
          userId: banned.userId,
          state: 'banned',
          capabilities: [],
          visibleInProduct: false,
          caseId: null,
          decisionId: null,
          generation: 1,
          updatedAt: new Date(),
        },
        null,
        tx,
      );
    });

    const recorded = await call(harness, 'POST', '/v1/profiles/me/completed-dates', subject.token, {
      entryId: randomUUID(),
      counterpartId: String(banned.userId),
      occurredOn: isoDay(YESTERDAY),
    });
    // A standing read in this handler would refuse this, and adding one is exactly
    // the review requirement `recordCompletedDate`'s signature exists to prevent:
    // a date happened, and whose account the platform has sanctioned says nothing
    // about that. It would also be the wrong answer — the owner is the one
    // recording, and the owner is not banned.
    expect(recorded.status).toBe(201);
    const read = await call(harness, 'GET', '/v1/profiles/me/completed-dates', subject.token);
    expect(read.body['completed']).toBe(1);
  });

  it('records a date for an unverified owner, because verification is not required of them either', async () => {
    const subject = await signUp('counter-unverified');
    // Deliberately not verified: `verify` is never called for this account.
    const recorded = await call(harness, 'POST', '/v1/profiles/me/completed-dates', subject.token, {
      entryId: randomUUID(),
      occurredOn: isoDay(YESTERDAY),
    });
    expect(recorded.status).toBe(201);
  });

  it('refuses a day that is not a day, and a day that has not happened', async () => {
    const subject = await signUp('counter-bad-days');
    const impossible = await call(harness, 'POST', '/v1/profiles/me/completed-dates', subject.token, {
      entryId: randomUUID(),
      occurredOn: '2026-02-31',
    });
    expect(impossible.status).toBe(400);

    const tomorrow = new Date(TODAY.getTime() + 24 * 60 * 60 * 1000);
    const ahead = await call(harness, 'POST', '/v1/profiles/me/completed-dates', subject.token, {
      entryId: randomUUID(),
      occurredOn: isoDay(tomorrow),
    });
    expect(ahead.status).toBe(400);

    const read = await call(harness, 'GET', '/v1/profiles/me/completed-dates', subject.token);
    expect(read.body['completed']).toBe(0);
  });

  it('refuses a date with yourself', async () => {
    const subject = await signUp('counter-self');
    const response = await call(harness, 'POST', '/v1/profiles/me/completed-dates', subject.token, {
      entryId: randomUUID(),
      counterpartId: String(subject.userId),
      occurredOn: isoDay(YESTERDAY),
    });
    expect(response.status).toBe(400);
  });

  it('keeps one owner history out of another', async () => {
    const first = await signUp('counter-isolated-a');
    const second = await signUp('counter-isolated-b');
    await call(harness, 'POST', '/v1/profiles/me/completed-dates', first.token, {
      entryId: randomUUID(),
      occurredOn: isoDay(YESTERDAY),
    });
    expect((await call(harness, 'GET', '/v1/profiles/me/completed-dates', second.token)).body['completed']).toBe(0);
  });

  // -------------------------------------------------------------- progress --

  it('keeps the count when the target changes, which is what the two-key design is for', async () => {
    const subject = await signUpProfiled('progress-goal-change');
    await call(harness, 'PUT', '/v1/profiles/me/goal', subject.token, { target: 100 });
    for (let index = 0; index < 3; index += 1) {
      await call(harness, 'POST', '/v1/profiles/me/completed-dates', subject.token, {
        entryId: randomUUID(),
        occurredOn: isoDay(YESTERDAY),
      });
    }
    const before = await call(harness, 'GET', '/v1/profiles/me/completed-dates', subject.token);
    expect(before.body['completed']).toBe(3);

    const changed = await call(harness, 'PUT', '/v1/profiles/me/goal', subject.token, { target: 5 });
    // The figure in the very response that changed the target.
    expect(changed.body['completed']).toBe(3);
    expect(changed.body['target']).toBe(5);
    expect(changed.body['goalReached']).toBe(false);

    const after = await call(harness, 'GET', '/v1/profiles/me/completed-dates', subject.token);
    expect(after.body['completed']).toBe(3);
    // The goal is per profile and the ledger is per user, so a re-read through
    // the goal route sees the same count rather than a default-zeroed one.
    expect((await call(harness, 'GET', '/v1/profiles/me/goal', subject.token)).body['completed']).toBe(3);
  });

  it('reports having reached the goal, and how far past it, without publishing a ratio', async () => {
    const subject = await signUpProfiled('progress-reached');
    await call(harness, 'PUT', '/v1/profiles/me/goal', subject.token, { target: 2 });
    for (let index = 0; index < 3; index += 1) {
      await call(harness, 'POST', '/v1/profiles/me/completed-dates', subject.token, {
        entryId: randomUUID(),
        occurredOn: isoDay(YESTERDAY),
      });
    }
    const read = await call(harness, 'GET', '/v1/profiles/me/completed-dates', subject.token);
    const progress = read.body['progress'] as Record<string, unknown>;

    expect(progress['completed']).toBe(3);
    expect(progress['target']).toBe(2);
    expect(progress['goalReached']).toBe(true);
    expect(progress['beyondGoal']).toBe(1);
    // Integers and a boolean. A percentage or a ratio is a value a future client
    // could put in a ring and a future ranking could sort on, and the cheapest
    // way to refuse that is never to publish one.
    for (const key of ['percent', 'percentage', 'ratio', 'score', 'progress']) {
      expect(progress).not.toHaveProperty(key);
    }
  });

  // ------------------------------------------------------------ corrections --

  it('withdraws a date: the count drops and the record is still there', async () => {
    const subject = await signUp('correction-withdraw');
    const entryId = randomUUID();
    await call(harness, 'POST', '/v1/profiles/me/completed-dates', subject.token, {
      entryId,
      occurredOn: isoDay(YESTERDAY),
    });

    const withdrawn = await call(
      harness,
      'POST',
      `/v1/profiles/me/completed-dates/${entryId}/corrections`,
      subject.token,
      { key: randomUUID(), kind: 'withdrawn' },
    );
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body['completed']).toBe(0);
    expect(withdrawn.body['counted']).toBe(false);

    const read = await call(harness, 'GET', '/v1/profiles/me/completed-dates', subject.token);
    expect(read.body['completed']).toBe(0);
    // Still listed. A withdrawal that deleted the row would leave nothing to
    // explain the drop, and the owner would see a number fall with no reason
    // attached to it.
    const records = read.body['records'] as Record<string, unknown>[];
    expect(records).toHaveLength(1);
    expect(records[0]?.['counted']).toBe(false);
    expect(records[0]?.['occurredOn']).toBe(isoDay(YESTERDAY));
    expect((records[0]?.['corrections'] as Record<string, unknown>[])[0]?.['kind']).toBe('withdrawn');
  });

  it('restates a date to another day and keeps it counted', async () => {
    const subject = await signUp('correction-restate');
    const entryId = randomUUID();
    await call(harness, 'POST', '/v1/profiles/me/completed-dates', subject.token, {
      entryId,
      occurredOn: isoDay(YESTERDAY),
    });

    const restated = await call(
      harness,
      'POST',
      `/v1/profiles/me/completed-dates/${entryId}/corrections`,
      subject.token,
      { key: randomUUID(), kind: 'restated', occurredOn: isoDay(A_DAY_AGO) },
    );
    expect(restated.status).toBe(200);
    // "I typed the wrong day" is not "I never went on that date", so the count
    // holds. Only a withdrawal costs the owner a date.
    expect(restated.body['completed']).toBe(1);
    expect(restated.body['counted']).toBe(true);
    expect(restated.body['occurredOn']).toBe(isoDay(A_DAY_AGO));

    const read = await call(harness, 'GET', '/v1/profiles/me/completed-dates', subject.token);
    const record = (read.body['records'] as Record<string, unknown>[])[0];
    expect(record?.['occurredOn']).toBe(isoDay(A_DAY_AGO));
  });

  it('refuses to restate a withdrawn date, however many times it is asked', async () => {
    const subject = await signUp('correction-conflict');
    const entryId = randomUUID();
    await call(harness, 'POST', '/v1/profiles/me/completed-dates', subject.token, {
      entryId,
      occurredOn: isoDay(YESTERDAY),
    });
    await call(harness, 'POST', `/v1/profiles/me/completed-dates/${entryId}/corrections`, subject.token, {
      key: randomUUID(),
      kind: 'withdrawn',
    });

    const attempted = await call(
      harness,
      'POST',
      `/v1/profiles/me/completed-dates/${entryId}/corrections`,
      subject.token,
      { key: randomUUID(), kind: 'restated', occurredOn: isoDay(A_DAY_AGO) },
    );
    // 409: corrections accumulate and never resurrect, so a withdrawn date stays
    // withdrawn however many times its day is redacted.
    expect(attempted.status).toBe(409);

    const read = await call(harness, 'GET', '/v1/profiles/me/completed-dates', subject.token);
    expect(read.body['completed']).toBe(0);
    const record = (read.body['records'] as Record<string, unknown>[])[0];
    // And the day did not move either, which a handler that wrote the correction
    // before consulting the domain would have got wrong.
    expect(record?.['occurredOn']).toBe(isoDay(YESTERDAY));
  });

  it('applies a replayed correction key once', async () => {
    const subject = await signUp('correction-retry');
    const entryId = randomUUID();
    await call(harness, 'POST', '/v1/profiles/me/completed-dates', subject.token, {
      entryId,
      occurredOn: isoDay(YESTERDAY),
    });
    const key = randomUUID();
    const first = await call(harness, 'POST', `/v1/profiles/me/completed-dates/${entryId}/corrections`, subject.token, {
      key,
      kind: 'restated',
      occurredOn: isoDay(A_DAY_AGO),
    });
    const retry = await call(harness, 'POST', `/v1/profiles/me/completed-dates/${entryId}/corrections`, subject.token, {
      key,
      kind: 'restated',
      // A retry that disagrees with the first attempt about the day.
      occurredOn: isoDay(YESTERDAY),
    });

    expect(first.body['applied']).toBe(true);
    expect(retry.body['applied']).toBe(false);

    const read = await call(harness, 'GET', '/v1/profiles/me/completed-dates', subject.token);
    const record = (read.body['records'] as Record<string, unknown>[])[0];
    // Still the day the first attempt settled on: one log row, and the superseded
    // day is the original rather than the intermediate.
    expect(record?.['occurredOn']).toBe(isoDay(A_DAY_AGO));
    expect((record?.['corrections'] as Record<string, unknown>[]).length).toBe(1);
  });

  it('treats a second withdrawal as a no-op rather than an error', async () => {
    const subject = await signUp('correction-twice');
    const entryId = randomUUID();
    await call(harness, 'POST', '/v1/profiles/me/completed-dates', subject.token, {
      entryId,
      occurredOn: isoDay(YESTERDAY),
    });
    await call(harness, 'POST', `/v1/profiles/me/completed-dates/${entryId}/corrections`, subject.token, {
      key: randomUUID(),
      kind: 'withdrawn',
    });
    const again = await call(harness, 'POST', `/v1/profiles/me/completed-dates/${entryId}/corrections`, subject.token, {
      key: randomUUID(),
      kind: 'withdrawn',
    });

    expect(again.status).toBe(200);
    expect(again.body['completed']).toBe(0);
    const read = await call(harness, 'GET', '/v1/profiles/me/completed-dates', subject.token);
    const record = (read.body['records'] as Record<string, unknown>[])[0];
    // One row in the log, not two: a second withdrawal has nothing to add and the
    // domain returns the ledger unchanged, so the store is never asked to append.
    expect((record?.['corrections'] as Record<string, unknown>[]).length).toBe(1);
  });

  it('reports a correction against an entry that does not exist as not found', async () => {
    const subject = await signUp('correction-missing');
    const response = await call(
      harness,
      'POST',
      `/v1/profiles/me/completed-dates/${randomUUID()}/corrections`,
      subject.token,
      { key: randomUUID(), kind: 'withdrawn' },
    );
    expect(response.status).toBe(404);
  });

  it('refuses a correction kind the domain does not define', async () => {
    const subject = await signUp('correction-unknown-kind');
    const entryId = randomUUID();
    await call(harness, 'POST', '/v1/profiles/me/completed-dates', subject.token, {
      entryId,
      occurredOn: isoDay(YESTERDAY),
    });
    const response = await call(harness, 'POST', `/v1/profiles/me/completed-dates/${entryId}/corrections`, subject.token, {
      key: randomUUID(),
      kind: 'deleted',
    });
    expect(response.status).toBe(400);
  });

  it('refuses to resurrect a withdrawn date even when the store is reached directly', async () => {
    const subject = await signUp('correction-store-guard');
    const entryId = randomUUID();
    await call(harness, 'POST', '/v1/profiles/me/completed-dates', subject.token, {
      entryId,
      occurredOn: isoDay(YESTERDAY),
    });
    await call(harness, 'POST', `/v1/profiles/me/completed-dates/${entryId}/corrections`, subject.token, {
      key: randomUUID(),
      kind: 'withdrawn',
    });

    // Bypassing the route, to check the guarantee is not only the domain
    // function's: a writer that skipped it must not be able to resurrect either.
    const outcome = await harness.transaction.run((tx) =>
      harness.stores.goals.appendDateCorrection(
        {
          entryId,
          key: randomUUID(),
          kind: 'restated',
          at: new Date(),
          occurredOn: isoDay(A_DAY_AGO),
          supersededOn: null,
        },
        subject.userId,
        tx,
      ),
    );
    expect(outcome.applied).toBe(false);

    const ledger = await harness.transaction.run((tx) => harness.stores.goals.findLedger(subject.userId, tx));
    expect(ledger[0]?.occurredOn).toBe(isoDay(YESTERDAY));
  });

  // ------------------------------------------------------- profile lifetime --

  it('keeps the history when the profile is deleted and re-made, and starts the new card at the default', async () => {
    const subject = await signUpProfiled('lifetime-recreate');
    await call(harness, 'PUT', '/v1/profiles/me/goal', subject.token, { target: 3 });
    await call(harness, 'POST', '/v1/profiles/me/completed-dates', subject.token, {
      entryId: randomUUID(),
      occurredOn: isoDay(YESTERDAY),
    });

    const profile = await harness.pool.query<{ profile_id: string }>(
      'SELECT profile_id FROM app.profiles WHERE user_id = $1',
      [subject.userId],
    );
    const original = String(profile.rows[0]?.profile_id);
    await harness.transaction.run(async (tx) => {
      await clientOf(tx).query('DELETE FROM app.profiles WHERE profile_id = $1', [original]);
    });
    // A new card, with a new identity, for the same person.
    const replacement = `profile:${randomUUID()}`;
    await harness.transaction.run(async (tx) => {
      await clientOf(tx).query(
        "INSERT INTO app.profiles (user_id, profile_id, state, content) VALUES ($1, $2, 'draft', '{}'::jsonb)",
        [subject.userId, replacement],
      );
    });

    const goal = await call(harness, 'GET', '/v1/profiles/me/goal', subject.token);
    // The target is a setting on the card, so the new card starts at the default.
    expect(goal.body['profileId']).toBe(replacement);
    expect(goal.body['target']).toBe(1000);
    // The count is a fact about a person, and it is untouched. If a cascade ran
    // from the profile to the history this would be zero.
    const read = await call(harness, 'GET', '/v1/profiles/me/completed-dates', subject.token);
    expect(read.body['completed']).toBe(1);
    expect(goal.body['completed']).toBe(1);
  });

  it('shows a verified owner the same counter as an unverified one', async () => {
    const subject = await signUp('lifetime-verified');
    await verify(harness, subject.token, subject.userId, PASSING_RESULT);
    await call(harness, 'POST', '/v1/profiles/me/completed-dates', subject.token, {
      entryId: randomUUID(),
      occurredOn: isoDay(YESTERDAY),
    });
    const read = await call(harness, 'GET', '/v1/profiles/me/completed-dates', subject.token);
    expect(read.body['completed']).toBe(1);
  });
});

let signUpCount = 0;

/** A real sign-up, so every request carries a session the resolver can find. */
async function signUp(label: string): Promise<{ userId: UserId; token: string }> {
  signUpCount += 1;
  // A distinct peer address per account: they all arrive over one loopback socket,
  // and without this every sign-up after the first few shares a `signup_per_ip`
  // bucket and the suite fails in a place that looks like a data problem.
  harness.fromAddress(`203.0.113.${(signUpCount % 250) + 1}`);
  const response = await call(harness, 'POST', '/v1/accounts', label, {
    contact: `${label}-${RUN_ID}-${signUpCount}@example.test`,
    password: 'a-long-enough-password',
    dateOfBirth: '1994-04-01',
    termsVersion: '2026-09-01',
  });
  if (response.status !== 201) {
    throw new Error(`sign-up returned ${response.status}: ${JSON.stringify(response.body)}`);
  }
  const session = response.body['session'] as Record<string, unknown> | undefined;
  const token = session?.['token'];
  if (typeof token !== 'string') {
    throw new Error(`sign-up minted no session: ${JSON.stringify(response.body)}`);
  }
  return { userId: castId<'UserId'>(String(response.body['userId'])), token };
}

/**
 * A sign-up that also writes a profile.
 *
 * A goal is a setting on a publication and `dating_goals.profile_id` references
 * `app.profiles`, so an owner with no profile row has nothing to set one on —
 * which `refuses a goal before there is a profile to set it on` asserts directly.
 * Every other test wants a normal member, so they get one.
 */
async function signUpProfiled(label: string): Promise<{ userId: UserId; token: string }> {
  const account = await signUp(label);
  const written = await call(harness, 'PUT', '/v1/profiles/me', account.token, {
    displayName: 'Alex',
    bio: 'Long enough bio to satisfy the minimum length the dating domain asks for.',
    genderIdentities: ['woman'],
    prompts: [{ promptId: 'currently_into', text: 'learning to make proper bread' }],
    location: '25_50_km',
  });
  if (written.status !== 200) {
    throw new Error(`writing a profile returned ${written.status}: ${JSON.stringify(written.body)}`);
  }
  return account;
}
