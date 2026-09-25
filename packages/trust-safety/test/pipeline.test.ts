import { describe, expect, it } from 'vitest';
import {
  type ActorId,
  type CorrelationId,
  type DataSensitivity,
  type DomainEvent,
  type EventHandler,
  type EventId,
  type EventSubscriber,
  type SubjectId,
  type Unsubscribe,
  InMemoryEventBus,
  castId,
} from '@been-there/core';
import {
  EMPTY_LEDGER,
  type RiskRecord,
  type SafetySeam,
  type Signal,
  type SignalLedger,
  applySignal,
  createSafetySeam,
} from '../src/index.js';
import { NOW, assessmentContext, at, recordAt, subject, succeeded } from './support.js';

/**
 * The whole path, with no seam skipped: an event published on a bus, reduced by
 * the seam at its declared clearance, indexed per account, read by a detector
 * from the implemented catalogue, and handed to the policy layer as evidence —
 * which is the only way risk moves in this package.
 */

interface EventOverrides {
  readonly type?: string;
  readonly occurredAt?: Date;
  readonly subjectId?: SubjectId;
  readonly sensitivity?: DataSensitivity;
  readonly payload?: Readonly<Record<string, unknown>>;
}

let sequence = 0;

function published(overrides: EventOverrides = {}): DomainEvent {
  sequence += 1;
  return {
    eventId: castId<'EventId'>(`evt-${sequence}`),
    type: 'profile.state_changed',
    version: 1,
    occurredAt: at(0, 1),
    actorId: castId<'ActorId'>('system'),
    correlationId: castId<'CorrelationId'>('corr-1'),
    sensitivity: 'public',
    payload: { userId: 'u-1' },
    ...overrides,
  };
}

const attemptAndStatusChange = (): readonly DomainEvent[] => [
  published({
    type: 'verification.attempt.started',
    sensitivity: 'internal',
    subjectId: subject('u-1'),
    occurredAt: at(0, 5),
    payload: { verificationId: 'ver-1', reVerification: true, reasonCode: 'periodic' },
  }),
  published({
    type: 'identity.status_changed',
    occurredAt: at(0, 1),
    payload: {
      identity: {
        projectionVersion: 1,
        subjectId: 'u-1',
        state: 'pending',
        generation: 3,
        discoverable: false,
      },
    },
  }),
];

/** One cycle of evidence, applied the way a repository would apply it. */
function assess(
  record: RiskRecord,
  signals: readonly Signal[],
  ledger: SignalLedger,
): { readonly record: RiskRecord; readonly events: readonly { type: string }[]; readonly ledger: SignalLedger } {
  let current = record;
  let currentLedger = ledger;
  const events: { type: string }[] = [];
  for (const signal of signals) {
    const transition = succeeded(applySignal(current, signal, currentLedger, assessmentContext()));
    current = transition.record;
    currentLedger = transition.ledger ?? currentLedger;
    events.push(...transition.events);
  }
  return { record: current, events, ledger: currentLedger };
}

describe('from a delivered event to a risk transition', () => {
  it('observes an identity attempt, corroborates it with profile churn, and reaches critical', async () => {
    const bus = new InMemoryEventBus();
    const seam: SafetySeam = createSafetySeam({ now: () => NOW });
    seam.subscribe(bus);
    const subjectId = subject('u-1');

    for (const event of attemptAndStatusChange()) {
      await bus.publish(event);
    }
    expect(seam.observationsFor(subjectId)).toHaveLength(2);

    const first = seam.detect(subjectId, []);
    expect(first.failures).toEqual([]);
    expect(first.signals.map((signal) => signal.detector)).toEqual(['identity.reuse']);

    // A record a previous cycle left at `high`, raised by the same detector
    // this cycle re-derives: one detector alone cannot take it further, which
    // is the property the corroboration branch depends on.
    const prior = recordAt('high', at(1), [], subjectId);
    const starting: RiskRecord = {
      ...prior,
      assessment: { ...prior.assessment, contributingDetectors: ['identity.reuse'] },
    };
    const firstPass = assess(starting, first.signals, EMPTY_LEDGER);
    expect(firstPass.record.assessment.state).toBe('high');

    for (let edit = 0; edit < 10; edit += 1) {
      await bus.publish(published({ payload: { userId: 'u-1', state: 'complete' } }));
    }
    const second = seam.detect(subjectId, firstPass.ledger.entries);
    // The same window is re-read, so the earlier attempt is still in it: a
    // cycle re-derives what the evidence says, it does not remember a verdict.
    expect(second.signals.map((signal) => signal.detector)).toEqual([
      'dating.profile_churn',
      'identity.reuse',
    ]);

    const secondPass = assess(firstPass.record, second.signals, firstPass.ledger);

    expect(secondPass.record.assessment.state).toBe('critical');
    expect(secondPass.record.assessment.contributingDetectors).toEqual([
      'dating.profile_churn',
      'identity.reuse',
    ]);
    expect(secondPass.events.map((event) => event.type)).toContain('risk.changed');
    expect(secondPass.record.friction.map((entry) => entry.kind)).toEqual([
      'rate_limit',
      'reverification_request',
      'human_review_candidate',
    ]);
  });

  it('never observes a restricted record, even when the transport does not filter', () => {
    const handlers: EventHandler[] = [];
    const unfiltered: EventSubscriber = {
      subscribe(_clearance: { readonly upTo: 'public' }, handler: EventHandler): Unsubscribe {
        handlers.push(handler);
        return () => {
          handlers.splice(handlers.indexOf(handler), 1);
        };
      },
    };
    const seam = createSafetySeam({ now: () => NOW });
    seam.subscribe(unfiltered);

    for (const event of [
      published({
        type: 'moderation.report_submitted',
        sensitivity: 'restricted',
        subjectId: subject('u-1'),
        payload: {
          reportId: 'rep-1',
          reason: 'harassment',
          anonymous: false,
          statement: 'he would not take no for an answer',
        },
      }),
      ...attemptAndStatusChange(),
    ]) {
      for (const handler of [...handlers]) {
        handler(event);
      }
    }

    // Only the two internal-or-public facts were reduced; the report is a
    // record, and a record is not a behaviour.
    expect(seam.observationsFor(subject('u-1'))).toHaveLength(2);
    expect(seam.refusals().map((error) => error.details?.type)).toEqual([
      'moderation.report_submitted',
    ]);
    expect(seam.detect(subject('u-1'), []).signals.map((signal) => signal.detector)).toEqual([
      'identity.reuse',
    ]);
  });
});
