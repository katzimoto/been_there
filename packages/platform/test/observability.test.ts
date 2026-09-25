import { describe, expect, it } from 'vitest';
import { castId, type ActorId, type UserId } from '@been-there/core';
import {
  classify,
  completeRequest,
  inheritEventContext,
  newRequestTrace,
  requestLogEntry,
  type RequestContext,
} from '../src/index.js';
import { correlationId, domainEvent, subjectId } from './helpers.js';

const ALICE = castId<'UserId'>('u-alice') as UserId;
const ACTOR = castId<'ActorId'>('u-alice') as ActorId;
const LIFENESS_SCORE = 0.9137;

function contextFor(overrides: Partial<RequestContext> = {}): RequestContext {
  const trace = newRequestTrace({ actorId: ACTOR, surface: 'api', operation: 'like_profile' });
  return {
    ...completeRequest(trace, { durationMs: 42, outcome: 'ok', subjectId: subjectId(ALICE) }),
    ...overrides,
  };
}

describe('correlation and causation', () => {
  it('mints one correlation id at the edge and keeps it for the whole request', () => {
    const first = newRequestTrace({ actorId: ACTOR, surface: 'api', operation: 'like_profile' });
    const second = newRequestTrace({ actorId: ACTOR, surface: 'api', operation: 'like_profile' });

    expect(first.correlationId).not.toBe(second.correlationId);
    // A caller that already has a correlation id — a worker resuming work — is
    // trusted with it rather than given a second one.
    const resumed = newRequestTrace({
      actorId: ACTOR,
      surface: 'worker',
      operation: 'send_push',
      correlationId: first.correlationId,
    });
    expect(resumed.correlationId).toBe(first.correlationId);
  });

  it('links a chain of events by causation while holding one correlation', () => {
    const context = contextFor();
    const request = domainEvent({ type: 'like.created', sensitivity: 'public', id: 'evt-like' });
    const match = inheritEventContext(request, context, {
      type: 'match.created',
      sensitivity: 'internal',
      payload: { matchId: 'm-1' },
    });
    const notification = inheritEventContext(match, context, {
      type: 'notification.queued',
      sensitivity: 'internal',
      payload: { channel: 'push' },
    });

    expect(notification.correlationId).toBe(context.correlationId);
    expect(match.causationId).toBe(request.eventId);
    expect(notification.causationId).toBe(match.eventId);
    expect(notification.actorId).toBe(ACTOR);
    expect(notification.subjectId).toBe(subjectId(ALICE));
  });
});

describe('request logs redact at serialisation time', () => {
  it('never writes a sensitive field into the line, whatever the caller assembled', () => {
    const context = contextFor();
    const entry = requestLogEntry(context, [
      classify('target_profile_id', 'public', 'u-99'),
      classify('like_id', 'internal', 'like-7'),
      classify('liveness_score', 'sensitive', LIFENESS_SCORE),
      classify('moderator_note', 'restricted', 'same person as u-42'),
    ]);

    expect(entry.body).not.toContain(String(LIFENESS_SCORE));
    expect(entry.body).not.toContain('same person as u-42');
    expect(JSON.parse(entry.body)).toEqual({
      correlation_id: context.correlationId,
      causation_id: 'none',
      surface: 'api',
      operation: 'like_profile',
      duration_ms: 42,
      outcome: 'ok',
      target_profile_id: 'u-99',
      like_id: 'like-7',
    });
  });

  it('names the fields it dropped, so the filter is observable without the values', () => {
    const entry = requestLogEntry(contextFor(), [
      classify('liveness_score', 'sensitive', LIFENESS_SCORE),
      classify('moderator_note', 'restricted', 'note'),
    ]);

    expect(entry.redactedFields).toEqual(['liveness_score', 'moderator_note']);
    expect(entry.level).toBe('info');
  });

  it('raises the level for a denial or an error without changing the content rule', () => {
    const denied = requestLogEntry(
      contextFor({ outcome: 'denied', errorCode: 'not_eligible' }),
      [classify('liveness_score', 'sensitive', LIFENESS_SCORE)],
    );
    const failed = requestLogEntry(contextFor({ outcome: 'error' }), []);

    expect(denied.level).toBe('warn');
    expect(failed.level).toBe('error');
    expect(denied.body).not.toContain(String(LIFENESS_SCORE));
  });
});
