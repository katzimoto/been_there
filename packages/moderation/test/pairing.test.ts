import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type DomainError, type ReportId, type Result, castId } from '@been-there/core';
import {
  MODERATION_EVENT_TYPES,
  type PairingKey,
  type ReportSubmission,
  createPairingMatcher,
  pairingToken,
  submitReport,
  triageReport,
} from '../src/index.js';
import * as pairingSurface from '../src/pairing.js';
import {
  CORRELATION,
  MODERATOR,
  REPORTER,
  SUBJECT,
  type Harness,
  harness,
  messageEvidence,
  rejected,
  succeeded,
  unmatchedRelationship,
} from './support.js';

/**
 * The pairing token (issue #45).
 *
 * Two things are being defended here, and they pull in opposite directions: a
 * join that works, and a join that reveals nothing. So the positive cases and
 * the negative ones are the same tests — a detector that could pair on anything
 * would pass the first group and fail the second.
 */

const SECRET: PairingKey = { secret: 'deployment-secret-for-this-test' };
const TRIPLE = { reportId: 'rep-1', matchId: 'match-1', subjectId: 'u-subject' };

/** A context with the deployment secret, unless a test is about its absence. */
function paired(options: { pairingKey?: PairingKey } = {}): Harness {
  return harness('pairingKey' in options ? { pairingKey: options.pairingKey } : { pairingKey: SECRET });
}

function submit(
  h: Harness,
  overrides: { relationshipMatchId?: string | null } = {},
): Result<ReportSubmission, DomainError> {
  return submitReport(h.ctx, {
    reportId: castId<'ReportId'>('rep-1'),
    subjectId: SUBJECT,
    reporterId: REPORTER,
    reason: 'harassment',
    statement: 'He kept messaging after I said no.',
    relationship: {
      ...unmatchedRelationship(),
      matchId: overrides.relationshipMatchId === undefined ? 'match-1' : overrides.relationshipMatchId,
    },
    evidence: [messageEvidence()],
    correlationId: CORRELATION,
  });
}

/** One published event, or a failure that names what was published instead. */
function eventOfType(h: Harness, type: string) {
  const [event] = h.published.filter((entry) => entry.type === type);
  if (event === undefined) {
    throw new Error(`expected a ${type}; published ${h.typesPublished().join(', ')}`);
  }
  return event;
}

describe('the token itself', () => {
  it('is the same for the same triple and different for every part of it', () => {
    expect(pairingToken(SECRET, TRIPLE)).toBe(pairingToken(SECRET, TRIPLE));

    expect(pairingToken(SECRET, { ...TRIPLE, matchId: 'match-2' })).not.toBe(
      pairingToken(SECRET, TRIPLE),
    );
    expect(pairingToken(SECRET, { ...TRIPLE, reportId: 'rep-2' })).not.toBe(
      pairingToken(SECRET, TRIPLE),
    );
    expect(pairingToken(SECRET, { ...TRIPLE, subjectId: 'u-other' })).not.toBe(
      pairingToken(SECRET, TRIPLE),
    );
  });

  it('cannot be made to collide by shifting a boundary between two ids', () => {
    // These two triples concatenate to the same bytes, so any framing that
    // simply joins the parts — with a separator or without — gives them one
    // token, and a detector would pair a report with the wrong match. Ids are
    // opaque and nothing constrains their length, so the framing has to carry
    // the boundaries itself.
    const left = { reportId: 'a', matchId: 'bc', subjectId: 'd' };
    const right = { reportId: 'ab', matchId: 'c', subjectId: 'd' };

    expect(left.reportId + left.matchId + left.subjectId).toBe(
      right.reportId + right.matchId + right.subjectId,
    );
    expect(pairingToken(SECRET, left)).not.toBe(pairingToken(SECRET, right));
  });

  it('is the same derivation in every deployment that shares the secret, and none that do not', () => {
    // The pin that stands in for an agreement test neither package is allowed to
    // write: Trust & Safety never hashes anything, so the two sides meet at a
    // matcher, and the only thing tying this literal to the other package's
    // stand-in is that both are pinned to it.
    expect(pairingToken(SECRET, TRIPLE)).toBe(
      '0ab1b8c05074e5e31fd24e25055127be81cc6e73b781ce025a018ac3aee541a4',
    );

    // Not correlatable across deployments: the same report about the same match
    // joins nothing once it has been copied somewhere else.
    expect(pairingToken({ secret: 'a-different-deployment' }, TRIPLE)).not.toBe(
      pairingToken(SECRET, TRIPLE),
    );
  });

  it('exposes nothing that reads a token back', () => {
    // Enumerating the module's exports is the assertion. Nothing here maps a
    // token to a match, a report or an account, and the derivation is keyed, so
    // recovering the inputs needs the secret; a `matchIdFor` or a `resolve`
    // added later fails here rather than becoming a quiet reversal.
    expect(Object.keys(pairingSurface).sort()).toEqual([
      'PAIRING_TOKEN_VERSION',
      'createPairingMatcher',
      'pairingToken',
    ]);
  });

  it('refuses to derive a token from an incomplete triple', () => {
    expect(() => pairingToken(SECRET, { ...TRIPLE, matchId: '' })).toThrow();
    expect(() => pairingToken({ secret: '' }, TRIPLE)).toThrow();
  });
});

describe('the matcher a detector is given', () => {
  const matches = createPairingMatcher(SECRET);
  const token = pairingToken(SECRET, TRIPLE);

  it('accepts the triple the token was derived from and refuses every other', () => {
    expect(matches.matches(token, TRIPLE)).toBe(true);
    expect(matches.matches(token, { ...TRIPLE, matchId: 'match-2' })).toBe(false);
    expect(matches.matches(token, { ...TRIPLE, subjectId: 'u-other' })).toBe(false);
  });

  it('refuses a token it did not mint, without throwing', () => {
    // A detector that probes candidate matches must get `false`, not a
    // `RangeError` out of a constant-time comparison: a throw inside a detector
    // is a refused cycle, which is how a probe becomes an outage.
    expect(matches.matches('not-a-token', TRIPLE)).toBe(false);
    expect(matches.matches('', TRIPLE)).toBe(false);
    expect(matches.matches(randomBytes(32).toString('hex'), TRIPLE)).toBe(false);
  });

  it('is bound to its own deployment key', () => {
    expect(createPairingMatcher({ secret: 'elsewhere' }).matches(token, TRIPLE)).toBe(false);
  });
});

describe('what submitReport publishes', () => {
  it('publishes the join on its own event, at the clearance that names nobody', () => {
    const h = paired();
    succeeded(submit(h));

    const event = eventOfType(h, 'moderation.report_pairing');
    expect(event.sensitivity).toBe('user');
    expect(event.subjectId).toBe(SUBJECT);
    // `system`, not the reporter: an envelope that named who reported would hand
    // over the one fact the `restricted` event beside it withholds.
    expect(event.actorId).toBe('system');
    expect(Object.keys(event.payload).sort()).toEqual(['pairingToken', 'reportId']);
    expect(event.payload).toEqual({ reportId: 'rep-1', pairingToken: pairingToken(SECRET, TRIPLE) });
  });

  it('publishes no join at all when the report has no match behind it', () => {
    const h = paired();
    succeeded(submit(h, { relationshipMatchId: null }));

    expect(h.typesPublished()).toContain('moderation.report_submitted');
    expect(h.typesPublished()).not.toContain('moderation.report_pairing');
  });

  it('publishes no join when the deployment has not configured a secret', () => {
    // Absent a secret there is no token keyed to anything, and a token derived
    // from a default anybody could guess would be worse than no token at all.
    const h = harness();
    succeeded(submit(h));

    expect(h.typesPublished()).toContain('moderation.report_submitted');
    expect(h.typesPublished()).not.toContain('moderation.report_pairing');
  });
});

describe('where the token is not', () => {
  it('appears on exactly one surface, and that surface is the `user` event', () => {
    const h = paired();
    const token = pairingToken(SECRET, TRIPLE);
    const submission = succeeded(submit(h));
    const surfaces = [
      ...h.published.map((event) => JSON.stringify(event)),
      JSON.stringify(h.audit.entries),
      JSON.stringify(submission),
    ];

    const carrying = surfaces.filter((surface) => surface.includes(token));
    expect(carrying).toHaveLength(1);
    expect(carrying[0]).toContain('"moderation.report_pairing"');
  });

  it('is absent from the restricted record, which still names no counterparty', () => {
    const h = paired();
    succeeded(submit(h));

    const record = eventOfType(h, 'moderation.report_submitted');
    expect(record.sensitivity).toBe('restricted');
    expect(Object.keys(record.payload).sort()).toEqual(['anonymous', 'reason', 'reportId']);
    // No counterparty, no reporter, no match, no conversation: the payload a
    // `restricted` class exists to withhold has not grown a field.
    expect(JSON.stringify(record.payload)).not.toContain('match-1');
    expect(JSON.stringify(record.payload)).not.toContain(REPORTER);
  });

  it('is absent from the audit log, which is the durable appeal record', () => {
    const h = paired();
    succeeded(submit(h));

    expect(h.audit.entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(h.audit.entries)).not.toContain(pairingToken(SECRET, TRIPLE));
    expect(JSON.stringify(h.audit.entries)).not.toContain('pairing');
  });

  it('is absent from every error the submission path can return', () => {
    // A token in an error message is a token in whatever renders it: a log
    // line, a 500 body, an operator's terminal. Every rejection below is driven
    // for real, not described.
    const h = paired();
    const relationship = unmatchedRelationship();
    const command = {
      subjectId: SUBJECT,
      reporterId: REPORTER,
      reason: 'harassment' as const,
      statement: 'He kept messaging after I said no.',
      relationship,
      evidence: [messageEvidence()],
      correlationId: CORRELATION,
    };
    const failures = [
      rejected(submitReport(h.ctx, { ...command, reportId: castId<'ReportId'>('rep-self'), subjectId: REPORTER })),
      rejected(submitReport(h.ctx, { ...command, reportId: castId<'ReportId'>('rep-long'), statement: 'x'.repeat(2001) })),
      rejected(submitReport(h.ctx, { ...command, reportId: castId<'ReportId'>('rep-no-evidence'), evidence: [] })),
    ];

    expect(failures.map((error) => error.code)).toEqual([
      'validation_failed',
      'validation_failed',
      'validation_failed',
    ]);
    expect(JSON.stringify(failures)).not.toContain(pairingToken(SECRET, TRIPLE));
  });

  it('is on no clearance above `user`, and on no event type but the one', () => {
    const h = paired();
    succeeded(submit(h));
    const token = pairingToken(SECRET, TRIPLE);
    const carrying = h.published.filter((event) => JSON.stringify(event).includes(token));

    expect(carrying.map((event) => event.type)).toEqual(['moderation.report_pairing']);
    expect(MODERATION_EVENT_TYPES.filter((type) => type === 'moderation.report_pairing')).toHaveLength(1);
  });
});

describe('the rest of the report lifecycle', () => {
  it('publishes the join once, and the join does not travel with the case', () => {
    // Triage, and everything a case does afterwards, moves the *record*. The
    // token is a property of the pairing, so it is published once and the case
    // that later reads the report finds nothing on the record to read it from.
    const h = paired();
    const submission = succeeded(submit(h));
    const report = succeeded(
      triageReport(h.ctx, {
        report: submission.report,
        moderatorId: MODERATOR.actorId,
        correlationId: CORRELATION,
      }),
    );

    expect(h.published.filter((event) => event.type === 'moderation.report_pairing')).toHaveLength(1);
    expect(
      h.published.filter((event) =>
        JSON.stringify(event).includes(
          pairingToken(SECRET, { reportId: report.reportId, matchId: 'match-1', subjectId: report.subjectId }),
        ),
      ),
    ).toHaveLength(1);
  });
});
