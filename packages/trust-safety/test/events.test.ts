import { describe, expect, it } from 'vitest';
import { NOW, subject } from './support.js';
import {
  TRUST_SAFETY_EVENT_SENSITIVITY,
  TRUST_SAFETY_EVENT_TYPES,
  type EventEnvelope,
  type ReviewCandidate,
  frictionProposed,
  type TrustSafetyEvent,
  proposeFriction,
  reviewCandidateRaised,
  riskChanged,
} from '../src/index.js';
import { castId, isClearedToConsume, type DomainEvent } from '@been-there/core';

const envelope: EventEnvelope = {
  eventId: castId<'EventId'>('evt-1'),
  occurredAt: NOW,
  correlationId: castId<'CorrelationId'>('corr-1'),
  causationId: castId<'EventId'>('evt-0'),
};
/** The kernel's clearance gate is payload-generic; safety payloads are specific. */
const asKernelEvent = (event: TrustSafetyEvent): DomainEvent => event as unknown as DomainEvent;

const accountCandidate: ReviewCandidate = {
  target: { kind: 'account', subjectId: subject('s-1') },
  state: 'high',
  origin: 'detection',
  raisedAt: NOW,
  expiresAt: NOW,
  independentDetectors: 2,
  confidence: 0.72,
  detectors: ['interaction.unmatch_report', 'network.device_cluster'],
};

const clusterCandidate: ReviewCandidate = {
  ...accountCandidate,
  target: {
    kind: 'cluster',
    key: { kind: 'report_against', entityId: 'victim-1' },
    members: [subject('r-1'), subject('r-2'), subject('r-3')],
  },
  origin: 'mass_report_attack',
};

const everyEvent = () => [
  riskChanged(envelope, {
    subjectId: subject('s-1'),
    assessmentId: castId<'RiskAssessmentId'>('risk-1'),
    from: 'elevated',
    to: 'high',
    reason: 'signal',
    detectors: ['interaction.unmatch_report'],
    effectiveScore: 0.75,
  }),
  reviewCandidateRaised(envelope, accountCandidate),
  reviewCandidateRaised(envelope, clusterCandidate),
  frictionProposed(envelope, proposeFriction('rate_limit', subject('s-1'), 'interaction.unmatch_report', NOW)),
];

describe('published events', () => {
  it('covers exactly the three documented types', () => {
    expect([...TRUST_SAFETY_EVENT_TYPES]).toEqual([
      'risk.changed',
      'review_candidate.raised',
      'friction.proposed',
    ]);
  });

  it('is internal for every type, and never public', () => {
    for (const event of everyEvent()) {
      expect(event.sensitivity).toBe('internal');
      expect(isClearedToConsume({ upTo: 'public' }, asKernelEvent(event))).toBe(false);
      expect(isClearedToConsume({ upTo: 'internal' }, asKernelEvent(event))).toBe(true);
    }
    expect(Object.values(TRUST_SAFETY_EVENT_SENSITIVITY).every((level) => level === 'internal')).toBe(true);
  });

  it('carries the risk move and the evidence behind it', () => {
    const event = everyEvent()[0]!;
    expect(event).toMatchObject({
      type: 'risk.changed',
      version: 1,
      subjectId: subject('s-1'),
      causationId: castId<'EventId'>('evt-0'),
      payload: { from: 'elevated', to: 'high', reason: 'signal', effectiveScore: 0.75 },
    });
  });

  it('leaves the envelope subject unset for a cluster, because there is no single subject', () => {
    expect(reviewCandidateRaised(envelope, clusterCandidate).subjectId).toBeUndefined();
    expect(reviewCandidateRaised(envelope, accountCandidate).subjectId).toBe(subject('s-1'));
  });

  it('marks every friction proposal as reversible on the wire, not only in the type', () => {
    const event = frictionProposed(
      envelope,
      proposeFriction('reverification_request', subject('s-1'), 'interaction.unmatch_report', NOW),
    );
    expect(event.payload.reversible).toBe(true);
    expect(event.payload.expiresAt.getTime()).toBeGreaterThan(NOW.getTime());
  });
});
