import { describe, expect, it } from 'vitest';
import { classify, redact, serializeForSink } from '../src/index.js';

const LIFENESS_SCORE = 0.9137;
const LOCATION_COORDINATE = '52.5200,13.4050';
const MODERATOR_NOTE = 'appears to be the same person as u-42';

const record = [
  classify('display_name', 'public', 'Robin'),
  classify('notification_settings', 'user', { push: false }),
  classify('risk_state', 'internal', 'elevated'),
  classify('liveness_score', 'sensitive', LIFENESS_SCORE),
  classify('exact_location', 'sensitive', LOCATION_COORDINATE),
  classify('moderator_note', 'restricted', MODERATOR_NOTE),
];

describe('redaction at the sink', () => {
  it('drops every field above the sink clearance from the serialised bytes', () => {
    const body = serializeForSink(record, { upTo: 'internal' });

    // The requirement, stated as the test: a `sensitive` field cannot reach a
    // log with `internal` clearance. Not "is not readable" — is not in the string.
    expect(body).not.toContain('liveness_score');
    expect(body).not.toContain(String(LIFENESS_SCORE));
    expect(body).not.toContain(LOCATION_COORDINATE);
    expect(body).not.toContain(MODERATOR_NOTE);
  });

  it('keeps fields at or below the sink clearance', () => {
    const body = JSON.parse(serializeForSink(record, { upTo: 'internal' })) as Record<string, unknown>;

    expect(body).toEqual({
      display_name: 'Robin',
      notification_settings: { push: false },
      risk_state: 'elevated',
    });
  });

  it('delivers nothing above a `public` sink, and everything to a `restricted` one', () => {
    const publicBody = JSON.parse(serializeForSink(record, { upTo: 'public' })) as Record<string, unknown>;
    const moderationBody = JSON.parse(serializeForSink(record, { upTo: 'restricted' })) as Record<string, unknown>;

    expect(Object.keys(publicBody)).toEqual(['display_name']);
    expect(Object.keys(moderationBody)).toHaveLength(record.length);
    expect(moderationBody['moderator_note']).toBe(MODERATOR_NOTE);
  });

  it('reports the fate of every field so the filter itself is observable', () => {
    const result = redact(record, { upTo: 'internal' });

    expect(result.fields.filter((field) => field.delivered).map((field) => field.name)).toEqual([
      'display_name',
      'notification_settings',
      'risk_state',
    ]);
    expect(result.fields.filter((field) => !field.delivered).map((field) => field.name)).toEqual([
      'liveness_score',
      'exact_location',
      'moderator_note',
    ]);
  });

  it('refuses a record that names the same field twice', () => {
    // A duplicate is the shape of a shadowing bug: one copy classified public,
    // one classified sensitive, and whichever survives is a naming accident.
    expect(() =>
      redact(
        [classify('liveness_score', 'public', 0.1), classify('liveness_score', 'sensitive', 0.9)],
        { upTo: 'internal' },
      ),
    ).toThrow(TypeError);
  });

  it('recurses into a nested record so a sensitive value cannot ride inside a public one', () => {
    const nested = [
      classify('profile', 'public', [
        classify('display_name', 'public', 'Robin'),
        classify('liveness_score', 'sensitive', LIFENESS_SCORE),
        classify('exact_location', 'sensitive', LOCATION_COORDINATE),
      ]),
    ];

    const result = redact(nested, { upTo: 'internal' });

    expect(result.visible['profile']).toEqual({ display_name: 'Robin' });
    expect(JSON.stringify(result.visible)).not.toContain(String(LIFENESS_SCORE));
    // Dropped nested fields are reported by their dotted path, so a sink can
    // show that its filter fired without logging what it filtered.
    expect(result.fields.filter((field) => !field.delivered).map((field) => field.name)).toEqual([
      'profile.liveness_score',
      'profile.exact_location',
    ]);
  });
});
