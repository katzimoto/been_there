import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { castId } from '@been-there/core';
import {
  CONTENT_BEARING_TYPES,
  InMemoryAuditLog,
  classify,
  readAuditRecord,
  routeEvent,
  type AuditAction,
  type AuditAppendRequest,
} from '../src/index.js';
import { correlationId, domainEvent, rejected, subjectId, succeeded } from './helpers.js';

/**
 * The contract between the moderation domain and the platform audit sink, read
 * out of the moderation source rather than restated here.
 *
 * The two packages each declared their own `AuditAction` string union, and
 * nothing checked that the sink's catalogue covered the producing domain's
 * vocabulary. Nine of moderation's sixteen actions therefore reached `append`
 * and died on `policy.sensitivity` of `undefined` — a `TypeError`, not a
 * record, and the moderation appeal chain unwritable. Deriving the list from
 * the source means the seventeenth action fails here instead of in production.
 *
 * The source text is read rather than the package imported: platform may not
 * depend on moderation's internals, and a test must not depend on another
 * domain's build state either.
 */
const MODERATION_AUDIT_SOURCE = new URL('../../moderation/src/audit.ts', import.meta.url);
const MODERATION_EVENT_SOURCE = new URL('../../moderation/src/events.ts', import.meta.url);

/** One member of a `| 'x'` union line. Anything else means the shape moved. */
const LITERAL_UNION_LINE = /^\|?\s*'[^']+',?$/;

/**
 * Extracts the members of a union of string literals. It refuses to guess: a
 * union written any other way throws, so this test is re-read when the
 * vocabulary stops being a plain list rather than silently seeing fewer members.
 */
function unionMembers(source: URL, typeName: string): readonly string[] {
  const file = readFileSync(source, 'utf8');
  const declaration = new RegExp(`export type ${typeName} =([\\s\\S]*?);`).exec(file);
  const body = declaration?.[1];
  if (body === undefined) {
    throw new Error(`${typeName} is not a union in ${source.pathname}; update this test`);
  }
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      if (!LITERAL_UNION_LINE.test(line)) {
        throw new Error(`${typeName} is no longer a literal union in ${source.pathname}`);
      }
      return line.replace(/^\|?\s*'/, '').replace(/',?$/, '');
    });
}

const MODERATION_ACTIONS = unionMembers(MODERATION_AUDIT_SOURCE, 'AuditAction');
const MODERATION_EVENTS = unionMembers(MODERATION_EVENT_SOURCE, 'ModerationEventType');

const NOW = new Date('2026-03-01T12:00:00.000Z');

function request(action: AuditAction, overrides: Partial<AuditAppendRequest> = {}): AuditAppendRequest {
  return {
    action,
    actorId: 'system',
    subjectId: subjectId('u-reported'),
    caseId: castId<'CaseId'>('case-9'),
    occurredAt: NOW,
    correlationId: correlationId('rec-1'),
    fields: [classify('evidence_url', 'restricted', 's3://evidence/case-9/1.jpg')],
    ...overrides,
  };
}

describe('the moderation audit chain the appeal record is written from', () => {
  it('appends every action the domain can produce, each with its own sensitivity', () => {
    const log = new InMemoryAuditLog();

    const recorded = MODERATION_ACTIONS.map((action) => {
      // Unchecked cast: the name comes from the moderation source rather than
      // from this package's union, which is the condition under test.
      const record = succeeded(log.append(request(action as AuditAction)));
      return `${record.action}:${record.sensitivity}`;
    });

    // Every moderation action is `restricted`: each is a fact about an
    // identified person under safety investigation. Anything lower would let an
    // `internal` clearance enumerate "who was reported".
    expect(recorded).toEqual(MODERATION_ACTIONS.map((action) => `${action}:restricted`));
    expect(log.read({ upTo: 'restricted' })).toHaveLength(MODERATION_ACTIONS.length);
  });

  it('refuses an unclassified action with a domain error instead of a TypeError', () => {
    const log = new InMemoryAuditLog();

    // Unchecked cast: the case under test is a name the catalogue does not have.
    const error = rejected(log.append(request('case.assigned_twice' as AuditAction)));

    expect(error.code).toBe('validation_failed');
    expect(error.message).toContain('case.assigned_twice');
    expect(error.details).toEqual({ action: 'case.assigned_twice' });
    // A refused append writes nothing, and burns no sequence number.
    expect(log.read({ upTo: 'restricted' })).toEqual([]);
  });

  it('keeps a moderation record out of an uncleared reader\'s reach', () => {
    const log = new InMemoryAuditLog();
    // Unchecked cast: `evidence.read` is read from the moderation union above.
    succeeded(log.append(request('evidence.read' as AuditAction)));

    expect(log.read({ upTo: 'internal' })).toEqual([]);
    expect(log.read({ upTo: 'sensitive' })).toEqual([]);

    const [record] = log.read({ upTo: 'restricted' });
    if (record === undefined) {
      throw new Error('expected the restricted record to be readable at restricted clearance');
    }
    expect(readAuditRecord(record, { upTo: 'restricted' }).visible).toMatchObject({
      evidence_url: 's3://evidence/case-9/1.jpg',
    });
  });
});

describe('moderation events reach the sinks', () => {
  it('sends every moderation event to audit and to no metrics sink', () => {
    // `account_state.changed` is the one moderation publishes at `public`
    // clearance, because a client must see the standing it produces. It is
    // still a safety fact, and it still must not become a metrics input.
    const routed = MODERATION_EVENTS.map((type) => ({
      type,
      route: routeEvent(
        domainEvent({ type, sensitivity: type === 'account_state.changed' ? 'public' : 'restricted' }),
      ),
    }));

    expect(routed).toEqual(
      MODERATION_EVENTS.map((type) => ({
        type,
        route: { audit: true, analytics: false, rejection: 'audited_only' },
      })),
    );
  });

  it('sends content to neither sink, even for a reader cleared above it', () => {
    for (const type of CONTENT_BEARING_TYPES) {
      expect(
        routeEvent(domainEvent({ type, sensitivity: 'restricted' })),
        type,
      ).toEqual({ audit: false, analytics: false, rejection: 'content' });
    }
  });
});
