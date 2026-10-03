import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { castId, type UserId } from '@been-there/core';
import { type Caller, type Harness, call, member, moderator, startHarness } from './support/harness.js';
import { COMPLETE_PROFILE, PASSING_RESULT, createAccount, newPeer, verify } from './support/fixtures.js';

process.env['RISK_PAIRING_SECRET'] = 'probe-secret';

describe('probe', () => {
  let harness: Harness;
  const callers: Caller[] = [];
  let alice = '' as UserId;
  let erin = '' as UserId;

  beforeAll(async () => {
    const aliceCaller = member('alice');
    callers.push(aliceCaller, moderator('mod'));
    harness = await startHarness(callers);
    alice = (await createAccount(harness, 'alice')).userId;
    aliceCaller.userId = alice;
    await call(harness, 'PUT', `/v1/accounts/${alice}/profile`, 'alice', COMPLETE_PROFILE);
    await verify(harness, 'alice', alice, PASSING_RESULT);
    erin = (await newPeer(harness, callers, 'erin')).userId;
    await call(harness, 'PUT', `/v1/accounts/${erin}/profile`, 'erin', COMPLETE_PROFILE);
    await verify(harness, 'erin', erin, PASSING_RESULT);

    await call(harness, 'POST', '/v1/interactions/likes', 'alice', { toUserId: erin });
    const matched = await call(harness, 'POST', '/v1/interactions/likes', 'erin', { toUserId: alice });
    expect(matched.status).toBe(201);
    await dump(harness, 'after-match', { alice, erin });
    const unmatched = await call(harness, 'POST', `/v1/matches/${String(matched.body['match'])}/unmatch`, 'alice', {
      idempotencyKey: 'probe-unmatch',
    });
    expect(unmatched.status).toBe(200);
    await dump(harness, 'after-unmatch', { alice, erin });
    const reported = await call(harness, 'POST', '/v1/reports', 'alice', {
      subjectUserId: erin,
      reason: 'harassment',
      statement: 'probe',
    });
    expect(reported.status).toBe(201);
    await dump(harness, 'after-report', { alice, erin });

    const victim = (await newPeer(harness, callers, 'victim')).userId;
    await call(harness, 'PUT', `/v1/accounts/${victim}/profile`, 'victim', COMPLETE_PROFILE);
    await verify(harness, 'victim', victim, PASSING_RESULT);
    const reporters: [string, UserId][] = [];
    for (const token of ['rep1', 'rep2', 'rep3']) {
      const id = (await newPeer(harness, callers, token)).userId;
      await call(harness, 'PUT', `/v1/accounts/${id}/profile`, token, COMPLETE_PROFILE);
      await verify(harness, token, id, PASSING_RESULT);
      await call(harness, 'POST', '/v1/interactions/likes', token, { toUserId: victim });
      const m = await call(harness, 'POST', '/v1/interactions/likes', 'victim', { toUserId: id });
      expect(m.status).toBe(201);
      reporters.push([token, id]);
    }
    for (const [token, id] of reporters) {
      const rep = await call(harness, 'POST', '/v1/reports', token, {
        subjectUserId: victim,
        reason: 'spam',
        statement: 'campaign probe statement long enough',
      });
      expect(rep.status).toBe(201);
      await dump(harness, `after-report-by-${token}`, { victim });
    }
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('dumps', () => {});
});

async function dump(harness: Harness, label: string, who: Record<string, UserId>): Promise<void> {
  const out = await harness.transaction.run(async (tx) => {
    const rows: unknown[] = [];
    for (const [name, id] of Object.entries(who)) {
      const subject = castId<'SubjectId'>(String(id));
      const assessment = await harness.stores.risk.findAssessment(subject, tx);
      const signals = await harness.stores.risk.findSignalsFor(subject, 100, tx);
      rows.push({
        name,
        state: assessment?.state ?? null,
        detectors: assessment?.contributingDetectors ?? null,
        signals: signals.map((s) => `${String(s['detector'])}/${String(s['behaviour'])}/actor=${String(s['actorId']).slice(0, 8)}`),
      });
    }
    const cases = await harness.pool.query(
      'SELECT subject_id, origin, state, opened_by FROM app.cases ORDER BY opened_at',
    );
    return { rows, cases: cases.rows };
  });
  process.stdout.write(`### ${label}\n${JSON.stringify(out, null, 1)}\n`);
}