import { describe, expect, it } from 'vitest';
import { NOW, at, subject } from './support.js';
import type { RiskState } from '@been-there/core';
import {
  type ReviewCandidate,
  type ReviewOrigin,
  type ReviewTarget,
  RECENCY_HORIZON_DAYS,
  addHours,
  rankReviewCandidates,
} from '../src/index.js';
const target = (id: string): ReviewTarget => ({ kind: 'account', subjectId: subject(id) });

const candidate = (overrides: Partial<ReviewCandidate> = {}): ReviewCandidate => ({
  target: target('s-1'),
  state: 'high' satisfies RiskState,
  origin: 'detection' satisfies ReviewOrigin,
  raisedAt: NOW,
  expiresAt: addHours(NOW, 72),
  independentDetectors: 1,
  confidence: 0.8,
  detectors: ['interaction.unmatch_report'],
  ...overrides,
});

const priorityOf = (entry: ReviewCandidate, now: Date = NOW): number => {
  const ranked = rankReviewCandidates([entry], now);
  return ranked[0]?.priority ?? Number.NaN;
};

describe('review queue ranking', () => {
  it('puts a fresh critical above a fresh high', () => {
    const ranked = rankReviewCandidates([candidate({ state: 'high' }), candidate({ state: 'critical' })], NOW);
    expect(ranked.map((entry) => entry.candidate.state)).toEqual(['critical', 'high']);
  });

  it('prefers a fresh mild case over a stale severe one, because time is the metric', () => {
    const ranked = rankReviewCandidates(
      [
        candidate({ state: 'high', raisedAt: at(RECENCY_HORIZON_DAYS), expiresAt: addHours(NOW, 1) }),
        candidate({ state: 'elevated', target: target('s-2') }),
      ],
      NOW,
    );
    expect(ranked.map((entry) => entry.candidate.state)).toEqual(['elevated', 'high']);
  });

  it('drops a candidate that nobody acted on before it was raised', () => {
    expect(rankReviewCandidates([candidate({ expiresAt: at(0, 1) })], NOW)).toEqual([]);
  });

  it('never produces a priority outside zero and one', () => {
    const extremes = [
      candidate({ state: 'normal', confidence: 0, independentDetectors: 0, raisedAt: at(90) }),
      candidate({ state: 'critical', confidence: 1, independentDetectors: 9 }),
    ];
    for (const entry of rankReviewCandidates(extremes, NOW)) {
      expect(entry.priority).toBeGreaterThanOrEqual(0);
      expect(entry.priority).toBeLessThanOrEqual(1);
    }
  });

  it('ranks a cluster above the same evidence about a single account', () => {
    const cluster = candidate({
      target: { kind: 'cluster', key: { kind: 'report_against', entityId: 'victim-1' }, members: [subject('r-1'), subject('r-2'), subject('r-3')] },
    });
    expect(priorityOf(cluster)).toBeGreaterThan(priorityOf(candidate()));
  });

  it('ranks a disputed case below an undetected one of the same severity', () => {
    const disputed = candidate({ origin: 'dispute', confidence: 0 });
    expect(priorityOf(disputed)).toBeLessThan(priorityOf(candidate()));
  });

  it('is independent of the order the queue arrived in', () => {
    const queue = [
      candidate({ state: 'critical', target: target('s-3'), confidence: 0.5 }),
      candidate({ state: 'high', target: target('s-1'), raisedAt: at(1) }),
      candidate({ state: 'high', target: target('s-2'), raisedAt: at(1) }),
    ];
    const forward = rankReviewCandidates(queue, NOW).map((entry) => entry.candidate.target);
    const backward = rankReviewCandidates([...queue].reverse(), NOW).map((entry) => entry.candidate.target);
    expect(backward).toEqual(forward);
    expect(forward).toEqual([target('s-3'), target('s-1'), target('s-2')]);
  });

  it('breaks an exact tie by oldest first, so every reviewer sees the same queue', () => {
    const ranked = rankReviewCandidates(
      [candidate({ target: target('s-2'), raisedAt: at(2) }), candidate({ target: target('s-1'), raisedAt: at(2) })],
      NOW,
    );
    expect(ranked.map((entry) => entry.candidate.target)).toEqual([target('s-1'), target('s-2')]);
  });
});
