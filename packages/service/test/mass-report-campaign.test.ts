import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { castId, type UserId } from '@been-there/core';
import { type Caller, type Harness, call, member, moderator, startHarness } from './support/harness.js';
import { newPeer } from './support/fixtures.js';

/**
 * A mass-report campaign, end to end over HTTP.
 *
 * Three accounts file reports against one target. Nothing about the target
 * moves: `assessSignal` discards every `report_against` signal, so the reported
 * account keeps the risk state it had and no case is ever opened against it.
 * What the third report produces is a *cluster* — three distinct reporters — and
 * the thing that goes in front of a human is the campaign: one case per
 * reporter, each about that reporter.
 *
 * These assertions are deliberately about what a moderator sees rather than
 * about internal wiring. A campaign case that opened and then vanished, or
 * opened against the wrong account, would satisfy a test that only counted
 * signals.
 */
const TARGET = 'campaign-target';
const REPORTERS = ['reporter-one', 'reporter-two', 'reporter-three', 'reporter-four'];
const MOD = 'campaign-moderator-token';

interface QueuedCase {
  readonly caseId: string;
  readonly subjectId: string;
  readonly origin: string;
  readonly priority: string;
  readonly queue: string;
}

describe('a mass-report campaign opens cases about the reporters', () => {
  let harness: Harness;
  let callers: Caller[];
  let target: UserId;
  /** Each reporter's account id, in `REPORTERS` order. */
  let reporterIds: (string | undefined)[] = [];

  beforeAll(async () => {
    const reporterCallers = REPORTERS.map((token) => member(token));
    callers = [...reporterCallers, moderator(MOD)];
    harness = await startHarness(callers);
    target = (await newPeer(harness, callers, TARGET)).userId;

    for (const [index, token] of REPORTERS.entries()) {
      const reporter = await newPeer(harness, callers, token);
      reporterCallers[index]!.userId = reporter.userId;
      reporterIds[index] = reporter.userId;
      // `evidenceForReport` is the right to report: it reads the retained
      // records, and a pair with none has nothing to report. A pass is the
      // smallest interaction that satisfies it, which keeps this fixture about
      // the reporting rather than about how a pair is matched.
      const passed = await call(harness, 'POST', '/v1/interactions/passes', token, {
        toUserId: target,
      });
      expect(passed.status).toBe(201);
    }
  });

  afterAll(async () => {
    if (harness !== undefined) {
      await harness.close();
    }
  });

  const queue = async (): Promise<readonly QueuedCase[]> => {
    const response = await call(harness, 'GET', '/v1/moderation/cases', MOD);
    expect(response.status).toBe(200);
    return response.body['cases'] as readonly QueuedCase[];
  };

  const campaignCases = async (): Promise<readonly QueuedCase[]> => {
    const all = await queue();
    return all.filter((row) => (JSON.parse(row.origin) as Record<string, unknown>)['source'] === 'mass_report_campaign');
  };

  const report = async (token: string): Promise<void> => {
    const filed = await call(harness, 'POST', '/v1/reports', token, {
      subjectUserId: target,
      reason: 'harassment',
      statement: 'they are harassing me',
    });
    expect(filed.status).toBe(201);
  };

  it('opens one case per reporter once three of them have reported the same target', async () => {
    const before = await queue();

    for (const token of REPORTERS.slice(0, 3)) {
      await report(token);
    }

    const opened = await campaignCases();

    // A case with no audit row explaining how it opened is a case nobody can
    // appeal, so the buffered rows have to reach the store along with it.
    const openedCase = opened[0]!;
    const audit = await harness.transaction.run((tx) =>
      harness.stores.moderation.findAuditForSubject(
        castId<'SubjectId'>(openedCase.subjectId),
        { limit: 50, offset: 0 },
        tx,
      ),
    );
    expect(audit.items.map((row) => row['action']).sort()).toEqual(['case.opened', 'evidence.captured']);

    // `MASS_REPORT_CLUSTER_SIZE` is three: two accounts filing reports about one
    // account is two people disagreeing, not a campaign, and a case opened at
    // two would be the detector's threshold leaking into the queue.
    expect(opened).toHaveLength(3);
    expect(opened.map((row) => row.subjectId).sort()).toEqual(reporterIds.slice(0, 3).sort());
    for (const row of opened) {
      expect(row.priority).toBe('high');
      expect(row.queue).toBe('safety');
      const origin = JSON.parse(row.origin) as Record<string, unknown>;
      expect(origin['targetId']).toBe(target);
      expect((origin['reporters'] as readonly string[]).length).toBe(3);
    }
    expect((await queue()).length).toBe(before.length + 3);
  });

  it('never opens a case against the account the reports were aimed at', async () => {
    const all = await queue();

    expect(all.map((row) => row.subjectId)).not.toContain(target);
    const row = await harness.transaction.run((tx) => harness.stores.risk.findAssessment(target, tx));
    expect(row === null ? 'normal' : row['state']).toBe('normal');
  });

  it('gives one campaign one key, and cases each reporter exactly once', async () => {
    await report(REPORTERS[3]!);

    const opened = await campaignCases();
    const keys = new Set(opened.map((row) => (JSON.parse(row.origin) as Record<string, unknown>)['clusterKey']));

    // A fourth reporter is cased and the first three are not cased again. The
    // detector re-reads every report in the window on each pass, so the same
    // campaign is offered once per report; without de-duplication this report
    // alone would open four more cases.
    expect(opened).toHaveLength(4);
    expect(keys.size).toBe(1);
    expect(opened.map((row) => row.subjectId).sort()).toEqual(reporterIds.slice().sort());
  });
});