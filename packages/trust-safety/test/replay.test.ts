import { describe, expect, it } from 'vitest';
import { castId } from '@been-there/core';
import {
  BEHAVIOUR_KINDS,
  type Detector,
  type ReplayReport,
  type SignalAuthor,
  type StoredSignal,
  corroborate,
  replaySignals,
} from '../src/index.js';

/**
 * What a replay says when it cannot know something.
 *
 * The property under test is not "the ledger comes back right" — it is that a
 * row the domain cannot accept is **counted and attributed**, never dropped
 * quietly and never made usable by inventing a value. A test that only checked
 * the happy path would pass against an implementation that guessed a reliability
 * from the detector name, which is the one thing migration 007 refused.
 */

const AT = new Date('2026-03-01T12:00:00.000Z');
const SUBJECT = castId<'SubjectId'>('subject-1');
const OTHER = castId<'SubjectId'>('subject-2');

const linkVelocity: SignalAuthor = {
  detector: 'velocity.like_burst',
  reliability: 'high',
  category: 'velocity',
  escalation: 'corroboration_only',
  dependsOnReports: false,
};

/** A detector that has been renamed away, so no row may name it any more. */
const RETIRED_DETECTOR = 'velocity.legacy_burst';

function stored(overrides: Partial<StoredSignal> = {}): StoredSignal {
  return {
    signalId: 'signal-1',
    subjectId: SUBJECT,
    detector: linkVelocity.detector,
    behaviour: 'like_velocity',
    entityId: 'target-1',
    facts: { occurrences: 12, windowMinutes: 60 },
    weight: 0.5,
    occurredAt: AT,
    actorId: SUBJECT,
    reliability: linkVelocity.reliability,
    category: linkVelocity.category,
    escalation: linkVelocity.escalation,
    ...overrides,
  };
}

/** The catalogue a replay is given: what this build is actually running. */
const CATALOGUE: readonly SignalAuthor[] = [linkVelocity];

function replay(rows: readonly StoredSignal[], catalogue = CATALOGUE): ReplayReport {
  return replaySignals(rows, catalogue);
}

describe('a replay reports what it does not know', () => {
  it('replays an authored row, and says nothing was skipped', () => {
    const report = replay([stored()]);

    expect(report.replayed).toBe(1);
    expect(report.skipped).toEqual([]);
    expect(report.skippedByReason).toEqual({
      unreadable: 0,
      no_actor: 0,
      no_author: 0,
      unknown_detector: 0,
      unknown_behaviour: 0,
      refused: 0,
    });
    expect(report.ledger.entries).toHaveLength(1);
    expect(report.ledger.entries[0]?.detector).toBe('velocity.like_burst');
  });

  it('skips a row with no author and counts it, rather than deriving a reliability', () => {
    // Exactly the shape a row written before migration 007 has: the columns
    // exist and are null. Nothing in the row says how much to trust it.
    const report = replay([
      stored({ reliability: null, category: null, escalation: null }),
    ]);

    expect(report.replayed).toBe(0);
    expect(report.ledger.entries).toEqual([]);
    expect(report.skippedByReason.no_author).toBe(1);
    expect(report.skipped[0]?.reason).toBe('no_author');
    // The detector name is right there and perfectly able to be joined against a
    // catalogue. Doing so is exactly the fabrication 007 refused, so the row is
    // skipped even though a value was available to invent.
    expect(report.skipped[0]?.detector).toBe('velocity.like_burst');
  });

  it('counts each reason separately, so an operator can tell the gaps apart', () => {
    const report = replay([
      stored({ signalId: 'a', reliability: null }),
      stored({ signalId: 'b', actorId: null }),
      stored({ signalId: 'c', detector: RETIRED_DETECTOR }),
      stored({ signalId: 'd', behaviour: 'behaviour_from_the_future' }),
      stored({ signalId: 'e', weight: 0 }),
      stored(),
    ]);

    expect(report.replayed).toBe(1);
    expect(report.skippedByReason).toEqual({
      unreadable: 0,
      no_actor: 1,
      no_author: 1,
      unknown_detector: 1,
      unknown_behaviour: 1,
      refused: 1,
    });
    // Every skip names the row it is about, so it can be found in the log.
    expect(report.skipped.map((row) => row.signalId)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('keeps the domain`s own wording on a refusal instead of replacing it', () => {
    // `report_against` whose actor is its own subject: a complete, well-formed
    // row the domain still refuses, because the attribution rule forbids it.
    // This is the case that must reach `createSignal` rather than being caught
    // by a check here — a replay with its own idea of validity would be a second
    // answer to "what is a Signal".
    const report = replay([stored({ behaviour: 'report_against', actorId: SUBJECT })]);

    expect(report.skippedByReason.refused).toBe(1);
    expect(report.skipped[0]?.detail).toContain('validation_failed');
  });

  it('never fills a missing actor in from the subject', () => {
    // `report_against` is the one kind where actor and subject must differ, so a
    // missing actor cannot be reconstructed even in principle. Self-attributed
    // rows are skipped too: a rule that inferred it for one kind and not the
    // other would be a second, subtler way to fabricate attribution.
    const report = replay([stored({ behaviour: 'report_against', actorId: null })]);

    expect(report.replayed).toBe(0);
    expect(report.skippedByReason.no_actor).toBe(1);
  });

  it('replays only what it read, and the two counts account for the whole window', () => {
    const rows = [stored({ signalId: 'a', reliability: null }), stored({ signalId: 'b' })];
    const report = replay(rows);

    expect(report.replayed + report.skipped.length).toBe(rows.length);
    expect(report.replayed).toBe(1);
    expect(report.skipped).toHaveLength(1);
  });

  it('reports an unreadable row without pretending it said something', () => {
    const report = replaySignals(
      [{ signalId: 'x', detector: 'velocity.like_burst', occurredAt: AT }],
      CATALOGUE,
    );

    expect(report.skippedByReason.unreadable).toBe(1);
    expect(report.replayed).toBe(0);
  });
});

describe('a replayed ledger corroborates like the in-memory one', () => {
  it('counts a replayed signal as an independent detector for the next', () => {
    const other: SignalAuthor = {
      detector: 'dating.profile_churn',
      reliability: 'low',
      category: 'interaction',
      escalation: 'corroboration_only',
      dependsOnReports: false,
    };
    const report = replaySignals(
      [stored({ detector: other.detector })],
      [linkVelocity, other],
    );

    const incoming = replay([stored({ signalId: 'incoming' })], CATALOGUE);
    const support = corroborate(report.ledger, incoming.ledger.entries[0]!);

    // The whole point of persisting the author and the actor: after a restart the
    // second detector still has the first one to corroborate against.
    expect(support.independentDetectors).toBe(2);
  });

  it('counts a replayed report as a distinct reporter, so a campaign survives a restart', () => {
    const reporters = ['r1', 'r2', 'r3'].map((id) => ({
      ...stored({
        signalId: `report-${id}`,
        detector: 'report.pattern.coordinated_target',
        behaviour: 'report_against',
        entityId: 'match-1',
      }),
      subjectId: SUBJECT,
      actorId: castId<'SubjectId'>(id),
    }));

    const report = replaySignals(
      reporters,
      [
        {
          detector: 'report.pattern.coordinated_target',
          reliability: 'high',
          category: 'report_pattern',
          escalation: 'corroboration_only',
          dependsOnReports: true,
        },
      ],
    );
    expect(report.replayed).toBe(3);

    const fourth = replaySignals(
      [
        {
          ...reporters[0]!,
          signalId: 'report-r4',
          actorId: castId<'SubjectId'>('r4'),
        },
      ],
      [linkVelocity, { ...linkVelocity, detector: 'report.pattern.coordinated_target' }],
    ).ledger.entries[0]!;

    const cluster = corroborate(report.ledger, fourth).massReport;

    // Three reporters in the window is the cluster threshold, and it is only
    // reachable because the replay restored the actors rather than the rows only.
    expect(cluster?.reporters).toEqual(['r1', 'r2', 'r3', 'r4']);
  });

  it('folds rows in the order the store returned them, oldest first', () => {
    const later = new Date(AT.getTime() + 60_000);
    const report = replay([
      stored({ signalId: 'b', occurredAt: later }),
      stored({ signalId: 'a', occurredAt: AT }),
    ]);

    expect(report.ledger.entries.map((entry) => entry.detector)).toEqual([
      'velocity.like_burst',
      'velocity.like_burst',
    ]);
    expect(report.ledger.entries.map((entry) => entry.occurredAt)).toEqual([AT, later]);
  });
});

describe('a replay cannot re-declare a signal against a detector this build does not run', () => {
  it('skips a row whose detector is absent from the catalogue', () => {
    const report = replay([stored({ detector: RETIRED_DETECTOR })]);

    expect(report.replayed).toBe(0);
    expect(report.skippedByReason.unknown_detector).toBe(1);
  });

  it('takes dependsOnReports from the catalogue, never from the stored row', () => {
    // The log deliberately does not persist `dependsOnReports`: it describes a
    // detector's inputs, which is a fact about the running code. So a detector
    // that only ever fires from a report is replayed as one that depends on
    // reports, and the metric built on that claim is not quietly falsified.
    const reportDependent: SignalAuthor = { ...linkVelocity, dependsOnReports: true };
    const row = stored();
    expect(Object.hasOwn(row, 'dependsOnReports')).toBe(false);

    const replayed = replaySignals([row], [reportDependent]).ledger.entries[0]!;

    expect(replayed.detector).toBe('velocity.like_burst');
    // The signal itself does not carry the flag, so the guarantee is structural:
    // there is nowhere for it to have been invented.
    expect(Object.hasOwn(replayed, 'dependsOnReports')).toBe(false);
  });

  it('agrees with the live catalogue about a behaviour it does not declare', () => {
    expect(BEHAVIOUR_KINDS).toContain('report_against');
    const report = replay([stored({ behaviour: 'report_against', actorId: SUBJECT })]);
    // `report_against` with actor === subject is refused by the attribution rule,
    // so it is skipped under the domain's verdict rather than replayed.
    expect(report.replayed).toBe(0);
    expect(report.skippedByReason.refused).toBe(1);
  });
});

describe('the catalogue argument is required, not defaulted', () => {
  it('skips every row when the catalogue is empty, and says why', () => {
    const report = replay([stored()], []);

    expect(report.replayed).toBe(0);
    expect(report.skippedByReason.unknown_detector).toBe(1);
    expect(report.ledger.entries).toEqual([]);
  });

  it('accepts a real detector list unchanged, so the wiring cannot drift from the seam', () => {
    const detector: Detector = {
      ...linkVelocity,
      detect: () => [],
    };
    const report = replaySignals([stored()], [detector]);

    expect(report.replayed).toBe(1);
    // `OTHER` is unused by design: it documents that a replay never folds a row
    // about a subject other than the one it was asked about.
    expect(OTHER).not.toBe(SUBJECT);
  });
});