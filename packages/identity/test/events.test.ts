import { describe, expect, it } from 'vitest';
import {
  type ActorId,
  type CorrelationId,
  type DomainEvent,
  type EventId,
  type VerificationId,
  InMemoryEventBus,
  castId,
  isClearedToConsume,
} from '@been-there/core';
import {
  type AnomalyDetectedPayload,
  type AttemptCompletedPayload,
  type AttemptStartedPayload,
  type EvidenceAccessedPayload,
  IDENTITY_EVENTS,
  IDENTITY_EVENT_CATALOGUE,
  type ReVerificationRequestedPayload,
  type ReviewProposedPayload,
  type StatusChangedPayload,
  buildIdentityEvent,
  projectIdentityStatus,
} from '../src/index.js';
import { SUBJECT, T0 } from './support.js';

const VERIFICATION = castId<'VerificationId'>('vrf-1');
const CORRELATION = castId<'CorrelationId'>('corr-1');
const MODERATOR = castId<'ActorId'>('mod-9');

const identity = projectIdentityStatus(
  { state: 'verified', latestVerificationId: VERIFICATION, generation: 3 },
  SUBJECT,
  T0,
);

const base = {
  eventId: castId<'EventId'>('evt-1'),
  actorId: 'system',
  correlationId: CORRELATION,
  occurredAt: T0,
  subjectId: SUBJECT,
} as const;

function sampleEvents(): readonly DomainEvent<never>[] {
  const statusChanged: DomainEvent<StatusChangedPayload> = buildIdentityEvent({
    ...base,
    type: IDENTITY_EVENTS.statusChanged,
    payload: { identity },
  });
  const attemptStarted: DomainEvent<AttemptStartedPayload> = buildIdentityEvent({
    ...base,
    eventId: castId<'EventId'>('evt-2'),
    type: IDENTITY_EVENTS.attemptStarted,
    payload: { verificationId: 'vrf-1', reVerification: false, reasonCode: 'onboarding' },
  });
  const attemptCompleted: DomainEvent<AttemptCompletedPayload> = buildIdentityEvent({
    ...base,
    eventId: castId<'EventId'>('evt-3'),
    type: IDENTITY_EVENTS.attemptCompleted,
    payload: {
      verificationId: 'vrf-1',
      attemptState: 'passed',
      decision: 'pass',
      confidenceBand: 'sufficient',
    },
  });
  const reviewProposed: DomainEvent<ReviewProposedPayload> = buildIdentityEvent({
    ...base,
    eventId: castId<'EventId'>('evt-4'),
    type: IDENTITY_EVENTS.reviewProposed,
    payload: { subjectId: SUBJECT, detector: 'identity.selfie_reuse', findings: [] },
  });
  const anomalyDetected: DomainEvent<AnomalyDetectedPayload> = buildIdentityEvent({
    ...base,
    eventId: castId<'EventId'>('evt-5'),
    type: IDENTITY_EVENTS.anomalyDetected,
    payload: { subjectId: SUBJECT, findings: [] },
  });
  const reVerification: DomainEvent<ReVerificationRequestedPayload> = buildIdentityEvent({
    ...base,
    eventId: castId<'EventId'>('evt-6'),
    actorId: MODERATOR,
    type: IDENTITY_EVENTS.reVerificationRequested,
    payload: { subjectId: SUBJECT, reason: 'risk_signal', requestedBy: 'trust_safety' },
  });
  const evidenceAccessed: DomainEvent<EvidenceAccessedPayload> = buildIdentityEvent({
    ...base,
    eventId: castId<'EventId'>('evt-7'),
    actorId: MODERATOR,
    type: IDENTITY_EVENTS.evidenceAccessed,
    payload: {
      entry: {
        at: T0,
        actorId: MODERATOR,
        verificationId: VERIFICATION,
        outcome: 'denied',
        denialCode: 'permission_denied',
        justification: 'unsolicited bulk read attempt',
      },
    },
  });
  return [
    statusChanged,
    attemptStarted,
    attemptCompleted,
    reviewProposed,
    anomalyDetected,
    reVerification,
    evidenceAccessed,
  ] as readonly DomainEvent<never>[];
}

describe('event catalogue', () => {
  it('classifies each event once, in a reviewable table', () => {
    expect(IDENTITY_EVENT_CATALOGUE[IDENTITY_EVENTS.statusChanged].sensitivity).toBe('public');
    expect(IDENTITY_EVENT_CATALOGUE[IDENTITY_EVENTS.attemptStarted].sensitivity).toBe('internal');
    expect(IDENTITY_EVENT_CATALOGUE[IDENTITY_EVENTS.attemptCompleted].sensitivity).toBe('internal');
    expect(IDENTITY_EVENT_CATALOGUE[IDENTITY_EVENTS.reVerificationRequested].sensitivity).toBe(
      'internal',
    );
    expect(IDENTITY_EVENT_CATALOGUE[IDENTITY_EVENTS.reviewProposed].sensitivity).toBe('sensitive');
    expect(IDENTITY_EVENT_CATALOGUE[IDENTITY_EVENTS.anomalyDetected].sensitivity).toBe('sensitive');
    expect(IDENTITY_EVENT_CATALOGUE[IDENTITY_EVENTS.evidenceAccessed].sensitivity).toBe(
      'restricted',
    );
    for (const definition of Object.values(IDENTITY_EVENT_CATALOGUE)) {
      expect(definition.version).toBe(1);
      expect(definition.description.length).toBeGreaterThan(0);
    }
  });

  it('has exactly one public event, and it is the one discovery needs', () => {
    const publicEvents = Object.entries(IDENTITY_EVENT_CATALOGUE)
      .filter(([, definition]) => definition.sensitivity === 'public')
      .map(([type]) => type);
    expect(publicEvents).toEqual([IDENTITY_EVENTS.statusChanged]);
  });

  it('takes the classification from the catalogue rather than the caller', () => {
    const event = sampleEvents()[0]!;
    expect(event.sensitivity).toBe(IDENTITY_EVENT_CATALOGUE[event.type].sensitivity);
  });

  it('publishes the public payload as the public projection and nothing else', () => {
    const event = sampleEvents()[0]! as DomainEvent<StatusChangedPayload>;
    expect(Object.keys(event.payload)).toEqual(['identity']);
    expect(Object.keys(event.payload.identity).sort()).toEqual(Object.keys(identity).sort());
  });
});

describe('who receives which event', () => {
  it('delivers nothing above a consumer clearance', async () => {
    const bus = new InMemoryEventBus();
    const seenByProduct: string[] = [];
    const seenBySafety: string[] = [];
    const seenByAudit: string[] = [];
    bus.subscribe({ upTo: 'public' }, (event) => seenByProduct.push(event.type));
    bus.subscribe({ upTo: 'sensitive' }, (event) => seenBySafety.push(event.type));
    bus.subscribe({ upTo: 'restricted' }, (event) => seenByAudit.push(event.type));

    for (const event of sampleEvents()) {
      await bus.publish(event);
    }

    // The dating product learns that a user is verified and nothing else about
    // how they got there.
    expect(seenByProduct).toEqual([IDENTITY_EVENTS.statusChanged]);
    expect(seenBySafety).toEqual([
      IDENTITY_EVENTS.statusChanged,
      IDENTITY_EVENTS.attemptStarted,
      IDENTITY_EVENTS.attemptCompleted,
      IDENTITY_EVENTS.reviewProposed,
      IDENTITY_EVENTS.anomalyDetected,
      IDENTITY_EVENTS.reVerificationRequested,
    ]);
    expect(seenByAudit).toHaveLength(7);
  });

  it('keeps evidence audit records out of reach of a safety consumer', async () => {
    const bus = new InMemoryEventBus();
    const seen: string[] = [];
    bus.subscribe({ upTo: 'sensitive' }, (event) => seen.push(event.type));
    const evidenceAccessed = sampleEvents().find(
      (event) => event.type === IDENTITY_EVENTS.evidenceAccessed,
    );
    expect(evidenceAccessed).toBeDefined();
    await bus.publish(evidenceAccessed!);
    expect(seen).toEqual([]);
  });
});

describe('clearance helper', () => {
  it('refuses a restricted event to a public consumer', () => {
    const event = sampleEvents()[6]!;
    expect(isClearedToConsume({ upTo: 'public' }, event)).toBe(false);
    expect(isClearedToConsume({ upTo: 'internal' }, event)).toBe(false);
    expect(isClearedToConsume({ upTo: 'restricted' }, event)).toBe(true);
  });
});
