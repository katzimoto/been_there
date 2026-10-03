import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { castId, type SubjectId, type UserId } from '@been-there/core';
import {
  type Caller,
  type Harness,
  type JsonResponse,
  call,
  member,
  moderator,
  startHarness,
} from './support/harness.js';
import { COMPLETE_PROFILE, PASSING_RESULT, newPeer, verify } from './support/fixtures.js';

/**
 * A report must never move the reported person's risk state.
 *
 * This is a service-level test and not a domain argument, because the failure it
 * guards against is *invisible in the record*. `assessSignal` discards every
 * `report_against` signal, which means a discarded signal adds no contributing
 * detector and does not touch `lastSignalAt`. A test asserting only "the record
 * did not move" would therefore pass while the state moved anyway — the discard
 * is precisely what removes the evidence that would have revealed it.
 *
 * So every assertion is made against a **control that has moved**. `unmatched`
 * and `reported` are two accounts built identically — each verified, each with
 * the same `identity.reuse` evidence, each touched only by requests this suite
 * makes — and they then receive the same volume of activity of different kinds.
 * The first is repeatedly unmatched; the second is repeatedly reported. One
 * escalates and the other must not, and the two outcomes are only meaningful
 * together: a safety layer that is disconnected fails the first, and a subject
 * that simply cannot be escalated fails the second.
 */

process.env['RISK_PAIRING_SECRET'] = 'report-guard-secret';

/** The detector whose every signal must be discarded. */
const REPORT_DETECTOR = 'report.pattern.coordinated_target';
/** A real, non-discarded detector present on every account here. */
const IDENTITY_DETECTOR = 'identity.reuse';
/** The detector that does escalate a subject, given its own corroboration. */
const UNMATCH_DETECTOR = 'interaction.unmatch_by_counterparty';

const CAMPAIGN_SIZE = 20;

interface RiskRecord {
  readonly state: string | null;
  readonly detectors: readonly string[];
  readonly byDetector: Readonly<Record<string, number>>;
  readonly distinctReportActors: number;
}

describe('a report must not move the reported account', () => {
  let harness: Harness;
  let callers: Caller[] = [];
  const ids = new Map<string, UserId>();

  /**
   * A distinct address for every request this suite makes after setup.
   *
   * Per-address limits are real, and a bucket shared by twenty requests would
   * refuse the sixth and look like a domain decision. Sign-ups bring their own
   * rotating addresses (`fixtures.ts`), so this counter covers likes and reports
   * only. 65 536 addresses per /16 is far more than this suite issues.
   */
  let presented = 0;
  function present(): void {
    presented += 1;
    harness.fromAddress(`192.0.2.${Math.floor(presented / 256) % 256}.${presented % 256}`);
  }

  /** Repeatedly unmatched by other accounts. Escalates. */
  let unmatched = '' as UserId;
  /** Repeatedly reported. Built identically, must not escalate. */
  let reported = '' as UserId;
  /** Reported three times by three accounts: a campaign. */
  let campaignVictim = '' as UserId;

  beforeAll(async () => {
    callers = [];
    const seed = member('seed');
    callers.push(seed, moderator('mod'));
    harness = await startHarness(callers);
    seed.userId = await subject('seed');

    unmatched = await subject('unmatched');
    reported = await subject('reported');
    campaignVictim = await subject('campaign-victim');

    for (let i = 1; i <= CAMPAIGN_SIZE; i += 1) {
      const token = `peer${i}`;
      const id = await subject(token);
      // Every peer likes both subjects first, so the report route will accept a
      // report about either and both subjects have identical histories.
      expect((await like(token, unmatched)).status).toBe(201);
      expect((await like(token, reported)).status).toBe(201);
      ids.set(token, id);
    }
  });

  afterAll(async () => {
    if (harness !== undefined) {
      await harness.close();
    }
  });

  it('moves the account that is unmatched, and leaves the reported account where it was', async () => {
    const before = {
      unmatched: await recordOf(unmatched),
      reported: await recordOf(reported),
    };
    // Both start identical and both normal, so any divergence below is caused
    // by the activity and not by a difference in how they were built.
    expect(before.unmatched.state).toBe('normal');
    expect(before.reported.state).toBe('normal');
    expect(before.unmatched.byDetector[IDENTITY_DETECTOR]).toBe(before.reported.byDetector[IDENTITY_DETECTOR]);

    // Same volume, same number of requests each, different behaviour.
    for (let i = 1; i <= CAMPAIGN_SIZE; i += 1) {
      await matchAndUnmatch(`peer${i}`, 'unmatched', `unmatch-${i}`);
      expect((await report(`peer${i}`, idOf('reported'))).status).toBe(201);
    }

    const after = {
      unmatched: await recordOf(unmatched),
      reported: await recordOf(reported),
    };

    // --- the arm that must move -------------------------------------------------
    // Without this the assertions below would also hold for a safety layer that
    // is simply disconnected, which is the failure this suite exists to rule out.
    expect(after.unmatched.byDetector[UNMATCH_DETECTOR]).toBeGreaterThan(0);
    expect(after.unmatched.detectors).toContain(UNMATCH_DETECTOR);
    expect(after.unmatched.state).toBe('elevated');

    // --- the arm that must not --------------------------------------------------
    // The reports really were observed, so this arm is not passing because the
    // wiring is dead: the producer at `routes/reports.ts` emitted signals, they
    // were persisted, and the state still did not move.
    expect(after.reported.byDetector[REPORT_DETECTOR]).toBeGreaterThan(0);
    expect(after.reported.distinctReportActors).toBe(CAMPAIGN_SIZE);
    expect(after.reported.state).toBe(before.reported.state);
    expect(after.reported.state).toBe('normal');

    // A discarded signal leaves no trace on the record at all: no contributing
    // detector, and — the part that hid the original bug — no clock either.
    expect(after.reported.detectors).not.toContain(REPORT_DETECTOR);
    expect(after.reported.detectors).toEqual(before.reported.detectors);
  });

  it('recognises a campaign without opening a case about the account it targeted', async () => {
    expect((await like('peer1', campaignVictim)).status).toBe(201);

    // Three distinct reporters is `MASS_REPORT_CLUSTER_SIZE`.
    for (const token of ['peer1', 'peer2', 'peer3']) {
      expect((await report(token, campaignVictim)).status).toBe(201);
    }

    const after = await recordOf(campaignVictim);

    // The campaign is still recognisable. This is the guarantee the fix had to
    // preserve: `detectMassReport` reads `behaviour.kind` and `actorId` directly
    // and never consults `corroboratingDetectors`, so excluding a discarded
    // signal from corroboration cost campaign detection nothing.
    expect(after.distinctReportActors).toBeGreaterThanOrEqual(3);
    expect(after.byDetector[REPORT_DETECTOR]).toBeGreaterThan(0);

    // And the account the campaign targeted is untouched, in the record and in
    // the queue. A case here would be a case *about the victim*, which is the
    // failure this whole suite is about.
    expect(after.state).toBe('normal');
    expect(await casesAbout(campaignVictim)).toEqual([]);

    const queue = await call(harness, 'GET', '/v1/moderation/cases', 'mod');
    expect(queue.status).toBe(200);
    expect(queue.body['cases']).toEqual([]);
  });

  /** A verified, profiled account, so it carries `identity.reuse` and little else. */
  async function subject(token: string): Promise<UserId> {
    const id = (await newPeer(harness, callers, token)).userId;
    ids.set(token, id);
    await call(harness, 'PUT', `/v1/accounts/${id}/profile`, token, COMPLETE_PROFILE);
    await verify(harness, token, id, PASSING_RESULT);
    return id;
  }

  function idOf(token: string): UserId {
    const id = ids.get(token);
    if (id === undefined) {
      throw new Error(`no account was seeded for ${token}`);
    }
    return id;
  }

  async function like(token: string, toUserId: UserId): Promise<JsonResponse> {
    // A distinct presented address per request, so nothing shares a rate-limit
    // bucket and a refusal is never mistaken for a domain decision.
    present();
    return call(harness, 'POST', '/v1/interactions/likes', token, { toUserId });
  }

  async function report(token: string, subjectUserId: UserId): Promise<JsonResponse> {
    present();
    return call(harness, 'POST', '/v1/reports', token, {
      subjectUserId,
      reason: 'spam',
      statement: 'a long enough statement for the report route',
    });
  }

  async function matchAndUnmatch(token: string, victimToken: string, key: string): Promise<void> {
    // `peerN` has already liked the victim, so the like back is what matches.
    const match = await like(victimToken, idOf(token));
    expect(match.status).toBe(201);
    expect(match.body['resolution']).toBe('match_created');
    present();
    const unmatched = await call(
      harness,
      'POST',
      `/v1/matches/${String(match.body['match'])}/unmatch`,
      token,
      { idempotencyKey: key },
    );
    expect(unmatched.status).toBe(200);
  }

  async function recordOf(userId: UserId): Promise<RiskRecord> {
    const subjectId = castId<'SubjectId'>(String(userId)) as SubjectId;
    return harness.transaction.run(async (tx) => {
      const assessment = await harness.stores.risk.findAssessment(subjectId, tx);
      const signals = await harness.stores.risk.findSignalsFor(subjectId, 1000, tx);
      const byDetector: Record<string, number> = {};
      for (const signal of signals) {
        const name = String(signal['detector']);
        byDetector[name] = (byDetector[name] ?? 0) + 1;
      }
      const reportActors = new Set(
        signals
          .filter((signal) => String(signal['detector']) === REPORT_DETECTOR)
          .map((signal) => String(signal['actorId'])),
      );
      return {
        state: assessment?.state ?? null,
        detectors: assessment?.contributingDetectors ?? [],
        byDetector,
        distinctReportActors: reportActors.size,
      };
    });
  }

  async function casesAbout(userId: UserId): Promise<readonly unknown[]> {
    const rows = await harness.pool.query('SELECT case_id, subject_id, origin FROM app.cases WHERE subject_id = $1', [
      String(userId),
    ]);
    return rows.rows;
  }
});