import { describe, expect, it } from 'vitest';
import { castId, InMemoryEventBus, type UserId } from '@been-there/core';
import {
  ANALYTICS_EVENTS,
  AUDIT_ACTIONS,
  InMemoryAuditLog,
  auditRequestFromEvent,
  classify,
  isAuditRequired,
  isSampled,
  readAuditRecord,
  recordAnalyticsEvent,
  routeEvent,
  type AuditAppendRequest,
} from '../src/index.js';
import { correlationId, domainEvent, subjectId, succeeded } from './helpers.js';

const ALICE = castId<'UserId'>('u-alice') as UserId;
const NOW = new Date('2026-03-01T12:00:00.000Z');

function appendRequest(overrides: Partial<AuditAppendRequest> = {}): AuditAppendRequest {
  return {
    action: 'auth.recovery_requested',
    actorId: 'system',
    subjectId: subjectId('u-alice'),
    occurredAt: NOW,
    correlationId: correlationId('rec-1'),
    fields: [classify('method', 'internal', 'email')],
    ...overrides,
  };
}

describe('audit is complete and append-only', () => {
  it('assigns a gap-free sequence and refuses to let a record be edited', () => {
    const log = new InMemoryAuditLog();

    const first = succeeded(log.append(appendRequest()));
    const second = succeeded(log.append(appendRequest({ action: 'auth.recovery_completed' })));

    expect([first.sequence, second.sequence]).toEqual([1, 2]);
    // Frozen: the log has no update path, and the record it hands back has no
    // mutation path either. Strict-mode ESM makes the attempt throw.
    expect(() => {
      (first as { action: string }).action = 'auth.credential_changed';
    }).toThrow(TypeError);
    expect(log.read({ upTo: 'restricted' })[0]?.action).toBe('auth.recovery_requested');
  });

  it('gates a read on the reader clearance, not on the record', () => {
    const log = new InMemoryAuditLog();
    succeeded(
      log.append(
        appendRequest({
          action: 'evidence.read',
          fields: [
            classify('evidence_url', 'restricted', 's3://evidence/case-9/1.jpg'),
            classify('case_id', 'restricted', 'case-9'),
            classify('scan_state', 'internal', 'scanning'),
          ],
        }),
      ),
    );

    // A support console with `internal` clearance cannot even enumerate a
    // restricted record, let alone read one.
    expect(log.read({ upTo: 'internal' })).toHaveLength(0);
    const restricted = log.read({ upTo: 'restricted' });
    expect(restricted).toHaveLength(1);
    expect(readAuditRecord(restricted[0] as never, { upTo: 'restricted' }).visible).toMatchObject({
      evidence_url: 's3://evidence/case-9/1.jpg',
      case_id: 'case-9',
      scan_state: 'scanning',
    });
    // A moderator with `sensitive` clearance can hold the record and still not
    // see the evidence field inside it.
    expect(
      readAuditRecord(restricted[0] as never, { upTo: 'sensitive' }).visible,
    ).toEqual({ scan_state: 'scanning' });
  });

  it('classifies every audit action, so the sink is never guessing', () => {
    for (const [action, policy] of Object.entries(AUDIT_ACTIONS)) {
      expect(policy.complete, action).toBe(true);
      expect(policy.sensitivity, action).not.toBe('public');
    }
  });

  it('ties an audit record back to the envelope that caused it', () => {
    const event = domainEvent({
      type: 'auth.recovery_requested',
      sensitivity: 'user',
      id: 'evt-77',
      correlationId: correlationId('rec-1'),
    });

    const request = auditRequestFromEvent(event, {
      action: 'auth.recovery_requested',
      subjectId: subjectId('u-alice'),
      fields: [classify('method', 'internal', 'email')],
    });

    expect(request.correlationId).toBe(event.correlationId);
    expect(request.occurredAt).toBe(event.occurredAt);
  });
});

describe('which events are audit facts', () => {
  it('requires an audit record for safety, identity, case, and auth events', () => {
    expect(isAuditRequired('identity_status.changed')).toBe(true);
    expect(isAuditRequired('identity.verification_changed')).toBe(true);
    expect(isAuditRequired('case.opened')).toBe(true);
    expect(isAuditRequired('account_state.changed')).toBe(true);
    expect(isAuditRequired('auth.recovery_abuse_suspected')).toBe(true);
    expect(isAuditRequired('message.sent')).toBe(false);
  });
});

describe('routing between the two sinks', () => {
  it('sends an identity status change to audit and nowhere else', () => {
    // The bus delivers it at `public` clearance, because a client legitimately
    // needs to know whether the current user is verified. That is a product
    // fact, not a metrics input: a sliceable "who failed verification" query
    // is the thing the overview forbids.
    const route = routeEvent(
      domainEvent({ type: 'identity_status.changed', sensitivity: 'public' }),
    );

    expect(route).toEqual({ audit: true, analytics: false, rejection: 'audited_only' });
  });

  it('sends content nowhere at all', () => {
    for (const type of ['message.sent', 'profile.bio_updated']) {
      expect(routeEvent(domainEvent({ type, sensitivity: 'user' }))).toEqual({
        audit: false,
        analytics: false,
        rejection: 'content',
      });
    }
  });

  it('allows an ordinary product event to analytics but not to audit', () => {
    expect(routeEvent(domainEvent({ type: 'match.created', sensitivity: 'internal' }))).toEqual({
      audit: false,
      analytics: true,
    });
  });

  it('reports an event no sink may hold, rather than dropping it in silence', () => {
    // `sensitive` and not an audit fact: the metrics sink is cleared to
    // `internal`, so no sink may hold it. While this reported nothing, it came
    // back as `{ audit: false, analytics: false }` — the same shape a
    // successfully-decided refusal returns, which is how every moderation
    // event vanished from both sinks without leaving a trace.
    const route = routeEvent(
      domainEvent({ type: 'location.anchor_updated', sensitivity: 'sensitive' }),
    );

    expect(route).toEqual({ audit: false, analytics: false, rejection: 'unroutable' });
  });

  it('uses clearance to withhold sensitive events from ordinary subscribers', async () => {
    // Clearance is a coarse instrument and this is what it actually buys: a
    // `sensitive` event is never handed to an `internal` consumer, whatever
    // that consumer subscribed to do. Content is the other half — it is stopped
    // by the type rule below, because clearance alone would let an `internal`
    // subscriber (the metrics side) observe a `user` event.
    const seen: string[] = [];
    const bus = new InMemoryEventBus();
    bus.subscribe({ upTo: 'internal' }, (event) => {
      seen.push(`internal:${event.type}`);
    });
    bus.subscribe({ upTo: 'restricted' }, (event) => {
      seen.push(`moderation:${event.type}`);
    });

    const body = domainEvent({ type: 'message.sent', sensitivity: 'user' });
    const evidence = domainEvent({ type: 'identity.evidence_viewed', sensitivity: 'sensitive' });

    await bus.publish(body);
    await bus.publish(evidence);

    expect(seen).toEqual(['internal:message.sent', 'moderation:message.sent', 'moderation:identity.evidence_viewed']);
  });

  it('keeps a content event out of the metrics sink by type, not by hope', () => {
    const body = domainEvent({ type: 'message.sent', sensitivity: 'user' });

    expect(routeEvent(body)).toEqual({ audit: false, analytics: false, rejection: 'content' });
  });
});

describe('analytics discipline', () => {
  it('refuses an event name that is not in the catalogue', () => {
    const result = recordAnalyticsEvent({
      name: 'made.up.event',
      occurredAt: NOW,
      correlationId: correlationId('a-1'),
      properties: {},
      sampleRate: 1,
    });

    expect(result.ok).toBe(false);
  });

  it('refuses an inherited property name masquerading as a catalogue entry', () => {
    const result = recordAnalyticsEvent({
      name: 'toString',
      occurredAt: NOW,
      correlationId: correlationId('a-1'),
      properties: {},
      sampleRate: 1,
    });

    expect(result.ok).toBe(false);
  });

  it('refuses an identifier, a coordinate, or a piece of content in a property bag', () => {
    for (const property of ['userId', 'caseId', 'latitude', 'messageBody', 'bio']) {
      const result = recordAnalyticsEvent({
        name: 'account.session_started',
        occurredAt: NOW,
        correlationId: correlationId('a-1'),
        properties: { [property]: 'x' },
        sampleRate: 1,
      });
      expect(result.ok, property).toBe(false);
    }
  });

  it('refuses a dimension the event did not declare', () => {
    // Declared dimensions are the review surface: adding one is a diff, and a
    // property nobody declared is a property nobody classified.
    const result = recordAnalyticsEvent({
      name: 'account.session_started',
      occurredAt: NOW,
      correlationId: correlationId('a-1'),
      properties: { surface: 'api', something_new: 'value' },
      sampleRate: 1,
    });

    expect(result.ok).toBe(false);
    expect(ANALYTICS_EVENTS['account.session_started'].dimensions).toEqual(['surface', 'auth_method']);
  });

  it('refuses a sample rate outside [0, 1]', () => {
    const result = recordAnalyticsEvent({
      name: 'account.session_started',
      occurredAt: NOW,
      correlationId: correlationId('a-1'),
      properties: {},
      sampleRate: 1.5,
    });

    expect(result.ok).toBe(false);
  });

  it('accepts a well-formed event and records no identifier of its own', () => {
    const result = recordAnalyticsEvent({
      name: 'account.onboarding_step_completed',
      occurredAt: NOW,
      correlationId: correlationId('a-1'),
      properties: { step: 'photos', source: 'onboarding' },
      sampleRate: 1,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.properties).toEqual({ step: 'photos', source: 'onboarding' });
      expect(result.value.sampled).toBe(true);
      expect(Object.keys(result.value)).not.toContain('userId');
    }
  });
});

describe('sampling', () => {
  it('is deterministic, so a retried publish does not double-count or flip', () => {
    const id = correlationId('a-1');
    const decisions = Array.from({ length: 10 }, () => isSampled(id, 0.5));

    expect(new Set(decisions).size).toBe(1);
  });

  it('keeps or drops entirely at the extremes', () => {
    const id = correlationId('a-1');

    expect(isSampled(id, 1)).toBe(true);
    expect(isSampled(id, 0)).toBe(false);
  });

  it('splits a population roughly in proportion to the rate', () => {
    let sampled = 0;
    const population = 1000;

    for (let index = 0; index < population; index += 1) {
      if (isSampled(correlationId(`a-${index}`), 0.25)) {
        sampled += 1;
      }
    }

    expect(sampled).toBeGreaterThan(population * 0.2);
    expect(sampled).toBeLessThan(population * 0.3);
  });
});
