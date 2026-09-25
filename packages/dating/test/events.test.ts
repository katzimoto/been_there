import { describe, expect, it } from 'vitest';
import {
  type Clearance,
  type CorrelationId,
  type DomainEvent,
  type EventId,
  InMemoryEventBus,
  type SubjectId,
  castId,
  isClearedToConsume,
} from '@been-there/core';
import {
  CONSUMED_EVENT_CATALOGUE,
  DATING_EVENT_CATALOGUE,
  type DatingEventType,
  type EventDefinition,
} from '../src/index.js';

const ALL_DEFINITIONS: readonly EventDefinition[] = [
  ...Object.values(DATING_EVENT_CATALOGUE),
  ...Object.values(CONSUMED_EVENT_CATALOGUE),
];

function envelope(type: string, definition: EventDefinition): DomainEvent {
  return {
    eventId: castId<'EventId'>(`evt-${type}`),
    type,
    version: definition.version,
    occurredAt: new Date('2026-01-01T00:00:00Z'),
    actorId: 'system',
    subjectId: castId<'SubjectId'>('user-a'),
    correlationId: castId<'CorrelationId'>('corr-1'),
    sensitivity: definition.sensitivity,
    payload: {},
  };
}

describe('event catalogue', () => {
  it('keys every entry by its own type, so a lookup cannot lie', () => {
    for (const [key, definition] of Object.entries(DATING_EVENT_CATALOGUE)) {
      expect(definition.type).toBe(key);
    }
    for (const [key, definition] of Object.entries(CONSUMED_EVENT_CATALOGUE)) {
      expect(definition.type).toBe(key);
    }
  });

  it('declares a version and a sensitivity for every event', () => {
    for (const definition of ALL_DEFINITIONS) {
      expect(definition.version).toBeGreaterThan(0);
      expect(definition.sensitivity).toMatch(/^(public|user|internal|sensitive|restricted)$/);
      expect(definition.description.length).toBeGreaterThan(0);
    }
  });

  it('never publishes a block, pass or like at public sensitivity', () => {
    const privateTypes: readonly DatingEventType[] = [
      'like.recorded',
      'like.withdrawn',
      'pass.recorded',
      'match.created',
      'unmatch.performed',
      'match.ended',
      'block.created',
      'block.released',
    ];
    for (const type of privateTypes) {
      expect(DATING_EVENT_CATALOGUE[type].sensitivity).toBe('internal');
    }
  });

  it('publishes a profile state change at public, and a deletion at user', () => {
    // The eligibility gate depends on a profile's state, so a consumer
    // invalidating cached eligibility needs every transition announced, not just
    // the one that makes somebody discoverable. A deletion is different: it is
    // content removal, not a discoverability fact.
    expect(DATING_EVENT_CATALOGUE['profile.state_changed'].sensitivity).toBe('public');
    expect(DATING_EVENT_CATALOGUE['profile.completed'].sensitivity).toBe('public');
    expect(DATING_EVENT_CATALOGUE['profile.deleted'].sensitivity).toBe('user');
  });

  it('keeps another person’s private intent off the public clearance', async () => {
    const seen: string[] = [];
    const bus = new InMemoryEventBus();
    bus.subscribe({ upTo: 'public' } satisfies Clearance, (event) => {
      seen.push(event.type);
    });
    await bus.publish(envelope('like.recorded', DATING_EVENT_CATALOGUE['like.recorded']));
    await bus.publish(envelope('block.created', DATING_EVENT_CATALOGUE['block.created']));
    await bus.publish(envelope('account_state.changed', CONSUMED_EVENT_CATALOGUE['account_state.changed']));
    expect(seen).toEqual(['account_state.changed']);
  });

  it('lets a safety subscriber observe every interaction signal', () => {
    for (const definition of ALL_DEFINITIONS) {
      expect(isClearedToConsume({ upTo: 'internal' }, envelope(definition.type, definition))).toBe(true);
    }
  });

  it('is readable only by a subscriber whose clearance covers it', () => {
    const blockEvent = envelope('block.created', DATING_EVENT_CATALOGUE['block.created']);
    expect(isClearedToConsume({ upTo: 'user' }, blockEvent)).toBe(false);
    expect(isClearedToConsume({ upTo: 'internal' }, blockEvent)).toBe(true);
  });
});
