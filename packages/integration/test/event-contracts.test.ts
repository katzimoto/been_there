/**
 * The event spine, checked as a whole.
 *
 * There was a window where the identity spine event was spelled
 * `identity_status.changed` in ten documents and in dating's *consumed*
 * catalogue, while identity *published* `identity.status_changed`. Nothing
 * failed, because nothing compared the two lists — and the platform's audit
 * allowlist contained both spellings, which is exactly what made the drift
 * invisible rather than loud.
 *
 * A producer publishing a name no consumer subscribes to is the failure this
 * file exists to prevent. It is a cross-domain property, so it belongs here and
 * not in either domain's own tests.
 */
import { describe, expect, it } from 'vitest';
import { CONSUMED_EVENT_CATALOGUE, DATING_EVENT_CATALOGUE } from '@been-there/dating';
import { IDENTITY_EVENTS } from '@been-there/identity';
import { MODERATION_EVENT_TYPES } from '@been-there/moderation';
import { TRUST_SAFETY_EVENT_TYPES } from '@been-there/trust-safety';
import { AUDIT_REQUIRED_PREFIXES, AUDIT_REQUIRED_TYPES } from '@been-there/platform';

/**
 * Everything a domain publishes, gathered from the catalogues that own the
 * names. A name that appears in a `published` list is a promise the bus keeps.
 */
const PUBLISHED = [
  ...Object.values(DATING_EVENT_CATALOGUE).map((definition) => definition.type),
  ...Object.values(IDENTITY_EVENTS),
  ...MODERATION_EVENT_TYPES,
  ...TRUST_SAFETY_EVENT_TYPES,
];

const PUBLISHED_TYPES = new Set(PUBLISHED);
const CONSUMED_TYPES = Object.keys(CONSUMED_EVENT_CATALOGUE);

describe('the event spine', () => {
  it('has a producer for every event a consumer subscribes to', () => {
    const orphans = CONSUMED_TYPES.filter((name) => !PUBLISHED_TYPES.has(name));
    expect(orphans).toEqual([]);
  });

  it('names the identity spine event the same way everywhere', () => {
    // The spelling that caused the drift, and the belt-and-braces allowlist row
    // that hid it. Both are exactly what this file exists to prevent.
    expect(CONSUMED_TYPES).not.toContain('identity_status.changed');
    expect(AUDIT_REQUIRED_TYPES).not.toContain('identity_status.changed');
  });

  it('keeps the identity status event audit-required without naming it twice', () => {
    // The `identity.` prefix covers it, so the type list must not restate it —
    // two spellings of one event is a way for a consumer to subscribe to
    // something nobody publishes.
    const coveredByPrefix = AUDIT_REQUIRED_PREFIXES.some((prefix) =>
      IDENTITY_EVENTS.statusChanged.startsWith(prefix),
    );
    expect(coveredByPrefix).toBe(true);
    expect(AUDIT_REQUIRED_TYPES).not.toContain(IDENTITY_EVENTS.statusChanged);
  });

  it('has no duplicate event name across producers', () => {
    const counts = new Map<string, number>();
    for (const name of PUBLISHED) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const shared = [...counts.entries()].filter(([, count]) => count > 1);
    expect(shared.map(([name]) => name).sort()).toEqual([]);
  });

  it('does not declare an event type that no catalogue entry backs', () => {
    // Dating's catalogue is a total record keyed by its event union, so a union
    // member with no definition would be a declared promise nothing keeps.
    for (const name of Object.keys(DATING_EVENT_CATALOGUE)) {
      expect(CONSUMED_TYPES.includes(name) || PUBLISHED_TYPES.has(name)).toBe(true);
    }
  });
});
