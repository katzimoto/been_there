import { describe, expect, it } from 'vitest';
import {
  type ActorId,
  type CorrelationId,
  type DataSensitivity,
  type DomainEvent,
  type EventId,
  type SubjectId,
  castId,
} from '@been-there/core';
import { type Observation, REDUCTION_CLEARANCE, toObservation } from '../src/index.js';
import { NOW, at, errorCode, subject } from './support.js';

/**
 * The reduction seam, exercised through `toObservation` — the one function a
 * delivered event has to reach a detector through.
 */

interface EventOverrides {
  readonly type?: string;
  readonly occurredAt?: Date;
  readonly subjectId?: SubjectId;
  readonly sensitivity?: DataSensitivity;
  readonly payload?: Readonly<Record<string, unknown>>;
}

/** An event as a transport would deliver it, shaped like Dating's catalogue. */
function delivered(overrides: EventOverrides = {}): DomainEvent {
  return {
    eventId: castId<'EventId'>('evt-1'),
    type: 'unmatch.performed',
    version: 1,
    occurredAt: at(0, 1),
    actorId: castId<'ActorId'>('u-matcher'),
    correlationId: castId<'CorrelationId'>('corr-1'),
    sensitivity: 'internal',
    payload: { actorId: 'u-matcher', matchId: 'match-1' },
    ...overrides,
  };
}

function messageSent(overrides: Readonly<Record<string, unknown>> = {}): DomainEvent {
  return delivered({
    type: 'communication.message_sent',
    subjectId: subject('u-sender'),
    payload: {
      conversationId: 'conv-1',
      matchId: 'match-1',
      senderId: 'u-sender',
      peerId: 'u-peer',
      messageId: 'msg-1',
      messageState: 'sent',
      sentAt: at(0, 1).toISOString(),
      secondsSincePreviousMessage: 4,
      messagesInConversation: 31,
      messagesLastHour: 30,
      bodyLength: 42,
      ...overrides,
    },
  });
}

const reduced = (event: DomainEvent): Observation | null => {
  const result = toObservation(event, NOW);
  if (!result.ok) {
    throw new Error(`expected an observation, got ${result.error.code}`);
  }
  return result.value;
};

describe('reduced on arrival', () => {
  it('turns a delivered event into the metadata a detector is allowed to see', () => {
    expect(
      reduced(delivered({ subjectId: subject('u-partner') })),
    ).toEqual({
      kind: 'unmatch.performed',
      occurredAt: at(0, 1),
      actorId: subject('u-matcher'),
      subjectId: subject('u-partner'),
      entityId: 'match-1',
    });
  });

  it('keeps the rate the producer derived and none of what the payload also carried', () => {
    const observation = reduced(messageSent({ body: 'meet me at the marina at midnight' }));

    expect(observation).toEqual({
      kind: 'communication.message_sent',
      occurredAt: at(0, 1),
      actorId: subject('u-sender'),
      subjectId: subject('u-sender'),
      counterpartyId: subject('u-peer'),
      entityId: 'conv-1',
      count: 30,
    });
    // Nothing a user wrote, and nothing else, survives the crossing.
    expect(JSON.stringify(observation)).not.toContain('marina');
    expect(Object.keys(observation ?? {}).sort()).toEqual([
      'actorId',
      'count',
      'counterpartyId',
      'entityId',
      'kind',
      'occurredAt',
      'subjectId',
    ]);
  });

  it('reduces an identity status change to the fact that it happened, not to why', () => {
    const observation = reduced(
      delivered({
        type: 'identity.status_changed',
        sensitivity: 'public',
        payload: {
          identity: {
            projectionVersion: 1,
            subjectId: 'u-1',
            state: 'rejected',
            generation: 4,
            discoverable: false,
            updatedAt: at(0, 1).toISOString(),
          },
        },
      }),
    );

    expect(observation).toEqual({
      kind: 'identity.status_changed',
      occurredAt: at(0, 1),
      actorId: subject('u-1'),
      subjectId: subject('u-1'),
    });
    expect(JSON.stringify(observation)).not.toContain('rejected');
  });

  it('is unmapped, not refused, for an event no detector consumes', () => {
    expect(reduced(delivered({ type: 'block.created', payload: { blocker: 'u-1' } }))).toBeNull();
    expect(
      reduced(delivered({ type: 'communication.conversation_state_changed', payload: {} })),
    ).toBeNull();
  });
});

describe('what the seam refuses', () => {
  it('refuses an event classified above the reduction clearance', () => {
    const refused = toObservation(
      delivered({
        type: 'moderation.report_submitted',
        sensitivity: 'restricted',
        subjectId: subject('u-reported'),
        payload: { reportId: 'rep-1', reason: 'harassment', anonymous: false },
      }),
      NOW,
    );

    expect(errorCode(refused)).toBe('permission_denied');
    expect(refused.ok ? null : refused.error.details).toMatchObject({
      type: 'moderation.report_submitted',
      sensitivity: 'restricted',
    });
    expect(REDUCTION_CLEARANCE.upTo).toBe('internal');
  });

  it('refuses a mapped event that does not name the account it happened to', () => {
    // `unmatch.performed` carries the performer in its payload and the other
    // account on the envelope. A producer that drops the second leaves the
    // reduction with nobody to attribute the behaviour to.
    const { subjectId: _omitted, ...withoutSubject } = delivered();
    const refused = toObservation(withoutSubject, NOW);

    expect(errorCode(refused)).toBe('validation_failed');
    expect(refused.ok ? null : refused.error.details).toMatchObject({ field: 'envelope:subjectId' });
  });

  it('refuses a mapped event whose payload lost a field the rule names', () => {
    const refused = toObservation(
      delivered({ type: 'like.recorded', payload: { to: 'u-peer' } }),
      NOW,
    );

    expect(errorCode(refused)).toBe('validation_failed');
    expect(refused.ok ? null : refused.error.details).toMatchObject({ field: 'payload:from' });
  });

  it('refuses an event dated after the moment it was observed', () => {
    const refused = toObservation(
      delivered({ occurredAt: new Date(NOW.getTime() + 60_000) }),
      NOW,
    );

    expect(errorCode(refused)).toBe('validation_failed');
  });

  it('refuses a rate that is not a whole count', () => {
    const refused = toObservation(messageSent({ messagesLastHour: 'thirty' }), NOW);

    expect(errorCode(refused)).toBe('validation_failed');
    expect(refused.ok ? null : refused.error.details).toMatchObject({ field: 'payload:messagesLastHour' });
  });
});
