import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONTENT_BEARING_TYPES, isAuditRequired, routeEvent } from '../src/index.js';
import { domainEvent } from './helpers.js';

/**
 * The same contract as `moderation-audit-contract.test.ts`, for the domain whose
 * events were quietly being routed into the metrics sink.
 *
 * Communication publishes four signals, all declared `internal`, and nothing in
 * the platform's audit allowlist named any of them. So a captured evidence view,
 * a friction notice, and a conversation state change all came back
 * `{ analytics: true }` — a safety fact in an aggregatable sink — while the
 * content guard that should have caught the message stream held four event names
 * that no package emits. Both halves of that are silent: nothing errors, and the
 * guard reads as though it were covering something.
 *
 * The names are read from the source rather than the package imported, for the
 * same reason as the moderation contract: platform may not depend on another
 * domain's internals, and a test must not depend on its build state either.
 */
const COMMUNICATION_SIGNAL_SOURCE = new URL('../../communication/src/signals.ts', import.meta.url);

const PUBLISHED_SIGNALS: readonly string[] = [
  ...new Set(
    [...readFileSync(COMMUNICATION_SIGNAL_SOURCE, 'utf8').matchAll(/type: '([^']+)'/g)].map(
      (match) => match[1] ?? '',
    ),
  ),
].filter((type) => type.startsWith('communication.'));

describe('no communication signal reaches the metrics sink', () => {
  it('reads the published catalogue, so a new signal fails here rather than in production', () => {
    expect(PUBLISHED_SIGNALS.length).toBeGreaterThanOrEqual(4);
  });

  it('sends each one to audit, or to nothing at all', () => {
    for (const type of PUBLISHED_SIGNALS) {
      const contentBearing = CONTENT_BEARING_TYPES.includes(type);
      expect(
        routeEvent(domainEvent({ type, sensitivity: contentBearing ? 'internal' : 'restricted' })),
        type,
      ).toEqual(
        contentBearing
          ? { audit: false, analytics: false, rejection: 'content' }
          : { audit: true, analytics: false, rejection: 'audited_only' },
      );
    }
  });

  it('keeps the message stream out of the metrics sink at its declared sensitivity', () => {
    // `message_sent` is `internal` on the bus, so the clearance check lets it
    // through; only the content guard stops it. Before the guard named the real
    // event, this is the whole product's message stream entering a sink anyone
    // with a dashboard can read.
    expect(routeEvent(domainEvent({ type: 'communication.message_sent', sensitivity: 'internal' }))).toEqual({
      audit: false,
      analytics: false,
      rejection: 'content',
    });
  });

  it('audits an evidence capture, which is a safety fact about a recorded case', () => {
    expect(isAuditRequired('communication.evidence_captured')).toBe(true);
  });
});
