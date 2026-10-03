import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { castId, type UserId } from '@been-there/core';
import { type Caller, type Harness, call, member, startHarness } from './support/harness.js';
import { COMPLETE_PROFILE, PASSING_RESULT, createAccount, newPeer, verify } from './support/fixtures.js';

process.env['RISK_PAIRING_SECRET'] = 'probe-secret';

/** Two identical accounts; the only difference is that one is reported against. */
describe('probe2', () => {
  let harness: Harness;
  const callers: Caller[] = [];
  let reported = '' as UserId;
  let untouched = '' as UserId;
  let reporter = '' as UserId;

  beforeAll(async () => {
    const caller = member('reporter');
    callers.push(caller);
    harness = await startHarness(callers);
    reporter = (await createAccount(harness, 'reporter')).userId;
    caller.userId = reporter;
    await call(harness, 'PUT', `/v1/accounts/${reporter}/profile`, 'reporter', COMPLETE_PROFILE);
    await verify(harness, 'reporter', reporter, PASSING_RESULT);

    // A: will be reported against.
    reported = (await newPeer(harness, callers, 'a-reported')).userId;
    await call(harness, 'PUT', `/v1/accounts/${reported}/profile`, 'a-reported', COMPLETE_PROFILE);
    await verify(harness, 'a-reported', reported, PASSING_RESULT);
    await match(harness, 'reporter', reporter, 'a-reported', reported, 'm1');

    // B: identical history, never reported.
    untouched = (await newPeer(harness, callers, 'b-untouched')).userId;
    await call(harness, 'PUT', `/v1/accounts/${untouched}/profile`, 'b-untouched', COMPLETE_PROFILE);
    await verify(harness, 'b-untouched', untouched, PASSING_RESULT);
    await match(harness, 'reporter', reporter, 'b-untouched', untouched, 'm2');

    await dump(harness, 'baseline', { reported, untouched });

    // A second observed behaviour for each, so a detect run happens after the
    // report has landed in A's ledger.
    await call(harness, 'POST', '/v1/interactions/likes', 'a-reported', { toUserId: reporter });
    await call(harness, 'POST', '/v1/interactions/likes', 'b-untouched', { toUserId: reporter });
    await dump(harness, 'before-any-report', { reported, untouched });

    const rep = await call(harness, 'POST', '/v1/reports', 'reporter', {
      subjectUserId: reported,
      reason: 'harassment',
      statement: 'probe statement long enough to be worth reading',
    });
    expect(rep.status).toBe(201);
    await dump(harness, 'right-after-the-one-report', { reported, untouched });

    // Now push both through another detect cycle, with no new report.
    await call(harness, 'POST', '/v1/interactions/likes', 'a-reported', { toUserId: untouched });
    await call(harness, 'POST', '/v1/interactions/likes', 'b-untouched', { toUserId: reporter });
    await dump(harness, 'after-another-cycle-no-new-report', { reported, untouched });
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('dumps', () => {});
});

async function match(
  harness: Harness,
  token: string,
  tokenId: UserId,
  otherToken: string,
  otherId: UserId,
  key: string,
): Promise<void> {
  await call(harness, 'POST', '/v1/interactions/likes', token, { toUserId: otherId });
  const m = await call(harness, 'POST', '/v1/interactions/likes', otherToken, { toUserId: tokenId });
  expect(m.status).toBe(201);
  const u = await call(harness, 'POST', `/v1/matches/${String(m.body['match'])}/unmatch`, otherToken, {
    idempotencyKey: key,
  });
  expect(u.status).toBe(200);
}

async function dump(harness: Harness, label: string, who: Record<string, UserId>): Promise<void> {
  const out = await harness.transaction.run(async (tx) => {
    const rows: unknown[] = [];
    for (const [name, id] of Object.entries(who)) {
      const subject = castId<'SubjectId'>(String(id));
      const a = await harness.stores.risk.findAssessment(subject, tx);
      const s = await harness.stores.risk.findSignalsFor(subject, 100, tx);
      rows.push({
        name,
        state: a?.state ?? null,
        generation: a?.generation ?? null,
        detectors: a?.contributingDetectors ?? null,
        signalCount: s.length,
        byDetector: s.reduce<Record<string, number>>((acc, r) => {
          const k = String(r['detector']);
          acc[k] = (acc[k] ?? 0) + 1;
          return acc;
        }, {}),
      });
    }
    const cases = await harness.pool.query('SELECT subject_id, origin FROM app.cases');
    return { rows, cases: cases.rows };
  });
  process.stdout.write(`### ${label}\n${JSON.stringify(out, null, 1)}\n`);
}