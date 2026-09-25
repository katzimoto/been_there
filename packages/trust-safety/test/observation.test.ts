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
  readonly actorId?: ActorId;
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

/**
 * The pairing token (issue #45). The join exists, and the record behind it does
 * not: everything asserted here is about how little a detector can be given.
 */
describe('the pairing event', () => {
  const pairingPayload = {
    reportId: 'rep-1',
    pairingToken: '0ab1b8c05074e5e31fd24e25055127be81cc6e73b781ce025a018ac3aee541a4',
  };

  it('reduces to the token, the report and the account it is about', () => {
    const observation = reduced(
      delivered({
        type: 'moderation.report_pairing',
        sensitivity: 'user',
        // `system`, because the envelope must not name who reported.
        actorId: castId<'ActorId'>('system'),
        subjectId: subject('u-reported'),
        payload: pairingPayload,
      }),
    );

    expect(observation).toEqual({
      kind: 'moderation.report_pairing',
      occurredAt: at(0, 1),
      actorId: subject('u-reported'),
      subjectId: subject('u-reported'),
      entityId: 'rep-1',
      pairingToken: pairingPayload.pairingToken,
    });
    // No counterparty, so nothing a detector can read names the other account.
    expect(observation?.counterpartyId).toBeUndefined();
  });

  it('is refused at every clearance above the one it is published at', () => {
    for (const sensitivity of ['sensitive', 'restricted'] as const) {
      const refused = toObservation(
        delivered({
          type: 'moderation.report_pairing',
          sensitivity,
          subjectId: subject('u-reported'),
          payload: pairingPayload,
        }),
        NOW,
      );

      expect(errorCode(refused), sensitivity).toBe('permission_denied');
    }
  });

  it('refuses a pairing event that lost its token', () => {
    const refused = toObservation(
      delivered({
        type: 'moderation.report_pairing',
        sensitivity: 'user',
        subjectId: subject('u-reported'),
        payload: { reportId: 'rep-1' },
      }),
      NOW,
    );

    expect(errorCode(refused)).toBe('validation_failed');
    expect(refused.ok ? null : refused.error.details).toMatchObject({
      field: 'payload:pairingToken',
    });
  });

  it('cannot smuggle a token in on the restricted record', () => {
    // A producer that put the join on the record instead of on its own event
    // would be refused for the reason it always was — the clearance — and not
    // because the payload was read and judged. The refusal happens first.
    const refused = toObservation(
      delivered({
        type: 'moderation.report_submitted',
        sensitivity: 'restricted',
        subjectId: subject('u-reported'),
        payload: { reason: 'harassment', anonymous: false, ...pairingPayload },
      }),
      NOW,
    );

    expect(errorCode(refused)).toBe('permission_denied');
    expect(JSON.stringify(refused)).not.toContain(pairingPayload.pairingToken);
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
