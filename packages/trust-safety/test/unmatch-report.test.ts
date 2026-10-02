import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  InMemoryEventBus,
  type ActorId,
  type CorrelationId,
  type DataSensitivity,
  type DomainEvent,
  type EventId,
  type SubjectId,
  castId,
} from '@been-there/core';
import {
  type Observation,
  type PairingMatcher,
  type Signal,
  createSafetyDetectors,
  createSafetySeam,
  runDetector,
} from '../src/index.js';
import { NOW, at, subject } from './support.js';
import * as pairingPort from '../src/pairing.js';

/**
 * `interaction.unmatch_report` (issue #45).
 *
 * The strongest pattern in the catalogue, and the one that could not work: the
 * report leg was `restricted` and named no match, so there was nothing to join
 * on. What exists now is a keyed join token on a `user`-clearance event, and
 * this file is about the two properties that make it a detector rather than a
 * wider hole — it pairs **only** when the token matches the triple derived from
 * an unmatch it already holds, and it fails to pair when it does not.
 *
 * The matcher below is a local stand-in for the one a deployment builds from its
 * secret. It is written out rather than imported because neither package is
 * allowed to depend on the other's build; the derivation itself is pinned in
 * `packages/moderation/test/pairing.test.ts`, which is where it lives.
 */

const SECRET = 'deployment-secret-for-this-test';

const derive = (triple: { reportId: string; matchId: string; subjectId: string }): string => {
  const framed = [triple.reportId, triple.matchId, triple.subjectId]
    .map((part) => `${part.length}:${part}`)
    .join('|');
  return createHmac('sha256', SECRET)
    .update(['rpt1', framed].join('|'))
    .digest('hex');
};

const matcher = (): PairingMatcher => ({ matches: (token, triple) => token === derive(triple) });

/**
 * The port is the whole of what this side of the join owns, and it is types
 * only: there is no runtime export here at all, so this package cannot hash a
 * triple, decode a token, or offer anything that maps one back to an identity.
 */
describe('the pairing port', () => {
  it('exports nothing at runtime', () => {
    expect(Object.keys(pairingPort)).toEqual([]);
  });
});

/** The reported account, the account everything here is evaluated for. */
const REPORTED = subject('u-reported');
const MATCHER_ACCOUNT = subject('u-matcher');

const unmatchOf = (matchId: string, hoursAgo = 2): Observation => ({
  kind: 'unmatch.performed',
  occurredAt: at(0, hoursAgo),
  actorId: MATCHER_ACCOUNT,
  subjectId: REPORTED,
  entityId: matchId,
});

const reportOf = (reportId: string, matchId: string, hoursAgo = 1): Observation => ({
  kind: 'moderation.report_pairing',
  occurredAt: at(0, hoursAgo),
  actorId: REPORTED,
  subjectId: REPORTED,
  entityId: reportId,
  pairingToken: derive({ reportId, matchId, subjectId: 'u-reported' }),
});

/** The pairing detector, which is the one entry that needs a secret to build. */
function detect(observations: readonly Observation[]): readonly Signal[] {
  const [detector] = createSafetyDetectors(matcher()).slice(-1);
  if (detector === undefined) {
    throw new Error('the pairing detector is not in the catalogue');
  }
  const run = runDetector(detector, { subjectId: REPORTED, now: NOW, observations }, []);
  if (!run.ok) {
    throw new Error(`the pairing detector failed its own run: ${run.error.code}`);
  }
  return run.value;
}

describe('interaction.unmatch_report', () => {
  it('pairs an unmatch with a report whose token is the one derived from that match', () => {
    const signals = detect([unmatchOf('match-1'), reportOf('rep-1', 'match-1')]);

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      subjectId: REPORTED,
      // The reported account, not the account that reported it: the pairing
      // token cannot name a reporter, so neither can the signal.
      actorId: REPORTED,
      behaviour: { kind: 'unmatch_then_report', entityId: 'match-1' },
      occurredAt: at(0, 1),
      weight: 0.6,
    });
  });

  it('does not pair when the token and the match disagree, however alike the rest', () => {
    // The negative case, and the only one that proves the token is being read
    // at all: same subject, same window, same kinds of evidence, and the single
    // fact that differs is which match the token was keyed over.
    expect(detect([unmatchOf('match-2'), reportOf('rep-1', 'match-1')])).toEqual([]);
  });

  it('pairs each report with its own match when two pairs are in the window', () => {
    // Two reports on two matches, two unmatchs. A detector that fired on "an
    // unmatch and a report exist" would answer four times.
    const signals = detect([
      unmatchOf('match-1', 2),
      unmatchOf('match-2', 3),
      reportOf('rep-1', 'match-1', 1),
      reportOf('rep-2', 'match-2', 1),
    ]);

    expect(signals.map((signal) => signal.behaviour.entityId).sort()).toEqual(['match-1', 'match-2']);
  });

  it('is silent when the unmatch came after the report', () => {
    expect(detect([unmatchOf('match-1', 1), reportOf('rep-1', 'match-1', 2)])).toEqual([]);
  });

  it('is silent when the reported account performed the unmatch itself', () => {
    // The observation says the reported account did the unmatching, which no
    // producer means; the detector declines to attribute an unmatch to an
    // account it cannot place, exactly as `unmatch_by_counterparty` does.
    const selfUnmatch: Observation = {
      kind: 'unmatch.performed',
      occurredAt: at(0, 2),
      actorId: REPORTED,
      subjectId: REPORTED,
      entityId: 'match-1',
    };

    expect(detect([selfUnmatch, reportOf('rep-1', 'match-1')])).toEqual([]);
  });

  it('carries no account other than the one it is evaluated for', () => {
    const [signal] = detect([unmatchOf('match-1'), reportOf('rep-1', 'match-1')]);

    expect(JSON.stringify(signal)).not.toContain('u-matcher');
    expect(JSON.stringify(signal)).not.toContain('rep-1');
  });

  it('needs a deployment secret to exist at all', () => {
    // A detector that cannot verify a token must not be constructible, so it is
    // not in the default catalogue: a deployment states which of the two it is
    // bringing, and the type is what forces the choice.
    const seam = createSafetySeam({ now: () => NOW, pairing: matcher() });
    expect(typeof seam.detect).toBe('function');

    // @ts-expect-error a seam with neither detectors nor a secret is not a seam.
    createSafetySeam({ now: () => NOW });
  });
});

/** An event as a producer publishes it, shaped the way each producer spells it. */
function published(
  type: string,
  sensitivity: DataSensitivity,
  payload: Readonly<Record<string, unknown>>,
  subjectId: SubjectId | undefined,
  actorId: string,
): DomainEvent {
  return {
    eventId: castId<'EventId'>(`evt-${type}`),
    type,
    version: 1,
    occurredAt: at(0, sensitivity === 'restricted' ? 0 : sensitivity === 'user' ? 1 : 2),
    actorId: castId<'ActorId'>(actorId),
    ...(subjectId === undefined ? {} : { subjectId }),
    correlationId: castId<'CorrelationId'>('corr-1'),
    sensitivity,
    payload,
  };
}

describe('through the seam, from published events', () => {
  it('pairs from two published events, and is never handed the record itself', async () => {
    // The bus enforces the clearance, so the restricted report is not delivered
    // at all: the pairing event is the only report-shaped thing this seam can
    // ever receive, which is the property the whole arrangement rests on.
    const bus = new InMemoryEventBus();
    const seam = createSafetySeam({ now: () => NOW, pairing: matcher() });
    const stop = seam.subscribe(bus);

    await bus.publish(
      published(
        'unmatch.performed',
        'internal',
        { actorId: 'u-matcher', matchId: 'match-1' },
        REPORTED,
        'u-matcher',
      ),
    );
    await bus.publish(
      published(
        'moderation.report_pairing',
        'user',
        { reportId: 'rep-1', pairingToken: derive({ reportId: 'rep-1', matchId: 'match-1', subjectId: 'u-reported' }) },
        REPORTED,
        'system',
      ),
    );
    await bus.publish(
      published(
        'moderation.report_submitted',
        'restricted',
        { reportId: 'rep-1', reason: 'harassment', anonymous: false },
        REPORTED,
        'u-matcher',
      ),
    );

    const run = seam.detect(REPORTED, []);

    expect(run.failures).toEqual([]);
    // The full catalogue runs, so the unmatch is also the weaker signal it
    // always was; the pairing is the one that needed the report leg.
    expect(run.signals.map((signal) => signal.detector).sort()).toEqual([
      'interaction.unmatch_by_counterparty',
      'interaction.unmatch_report',
    ]);
    // Nothing was refused, because nothing above the clearance was delivered;
    // and the two observations the seam holds name no reporter.
    expect(seam.refusals()).toEqual([]);
    expect(seam.observationsFor(REPORTED).map((entry) => entry.kind)).toEqual([
      'unmatch.performed',
      'moderation.report_pairing',
    ]);
    expect(JSON.stringify(seam.observationsFor(REPORTED))).not.toContain('harassment');
    stop();
  });
});
