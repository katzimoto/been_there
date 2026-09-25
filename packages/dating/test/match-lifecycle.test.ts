import { describe, expect, it } from 'vitest';
import {
  type MatchRecord,
  type SubjectStandingProjection,
  applyBlockToMatch,
  evidenceForReport,
  matchStandingFor,
  unmatch,
} from '../src/index.js';
import {
  A,
  AT,
  B,
  C,
  DAYS,
  LATER,
  block,
  failureCode,
  key,
  like,
  likeId,
  matchedLedger,
  matchRecord,
  pass,
  passId,
  relationship,
  standing,
  succeeded,
} from './fixtures.js';

/**
 * What a match does after it exists. Creating one is `interaction.test.ts`;
 * this file is the other half of the record's life — the two ends, the standing
 * each party sees as its counterpart changes, and the evidence both survive for.
 */

describe('unmatch', () => {
  it('lets either participant end a live match, withdraws the likes, and keeps the record', () => {
    const ledger = matchedLedger();
    const outcome = succeeded(unmatch(ledger, { match: matchRecord(), actor: B, at: LATER, key: key('k1') }));
    expect(outcome.match.standings).toEqual(['closed_by_actor', 'closed_by_actor']);
    expect(outcome.match.ended).toEqual({
      cause: 'unmatched',
      actorId: B,
      at: LATER,
      idempotencyKey: key('k1'),
    });
    expect(outcome.match.matchId).toBe(matchRecord().matchId);
    expect(outcome.conversation).toEqual({
      conversationId: matchRecord().conversationId,
      state: 'closed',
      retainedForEvidence: true,
    });
    // Withdrawn, not deleted: the likes are what a post-unmatch report attaches.
    expect(outcome.ledger.likes.map((entry) => entry.state)).toEqual(['withdrawn', 'withdrawn']);
  });

  it('replays the same outcome for a retried command and refuses a different key', () => {
    const first = succeeded(unmatch(matchedLedger(), { match: matchRecord(), actor: A, at: LATER, key: key('k1') }));
    const retry = unmatch(first.ledger, { match: first.match, actor: A, at: DAYS(2), key: key('k1') });
    expect(succeeded(retry).match.ended?.at).toBe(LATER);
    expect(
      failureCode(unmatch(first.ledger, { match: first.match, actor: A, at: LATER, key: key('k2') })),
    ).toBe('invalid_transition');
  });

  it('refuses an outsider and an already ended match', () => {
    expect(failureCode(unmatch(matchedLedger(), { match: matchRecord(), actor: C, at: LATER, key: key('k1') }))).toBe(
      'permission_denied',
    );
    const ended = matchRecord({
      standings: ['closed_by_actor', 'closed_by_actor'],
      ended: { cause: 'unmatched', actorId: A, at: AT, idempotencyKey: key('k1') },
    });
    expect(failureCode(unmatch(matchedLedger(), { match: ended, actor: A, at: LATER, key: key('k2') }))).toBe(
      'invalid_transition',
    );
  });

  it('closes a match that had no conversation yet without inventing one', () => {
    const outcome = succeeded(
      unmatch(matchedLedger(), { match: matchRecord({ conversationId: null }), actor: A, at: LATER, key: key('k1') }),
    );
    expect(outcome.conversation).toBeNull();
  });
});

describe('a match that a block ends', () => {
  it('gives the two parties different standings of the same end', () => {
    const outcome = succeeded(applyBlockToMatch(block(B, A), matchRecord(), matchedLedger(), LATER));
    expect(outcome.match.ended?.cause).toBe('ended_by_block');
    expect(outcome.match.ended?.actorId).toBe('system');
    expect(matchStandingFor(outcome.match, A)).toBe('closed_by_target');
    expect(matchStandingFor(outcome.match, B)).toBe('closed_by_actor');
    expect(outcome.ledger.likes.map((entry) => entry.state)).toEqual(['withdrawn', 'withdrawn']);
  });

  it('orders the two standings by participant, not by who blocked', () => {
    const outcome = succeeded(applyBlockToMatch(block(A, B), matchRecord(), matchedLedger(), LATER));
    expect(outcome.match.standings).toEqual(['closed_by_actor', 'closed_by_target']);
  });

  it('refuses a second end and a block that does not involve the match', () => {
    const ended = succeeded(applyBlockToMatch(block(B, A), matchRecord(), matchedLedger(), LATER)).match;
    expect(failureCode(applyBlockToMatch(block(B, A), ended, matchedLedger(), LATER))).toBe('invalid_transition');
    expect(failureCode(applyBlockToMatch(block(B, C), matchRecord(), matchedLedger(), LATER))).toBe('validation_failed');
  });

  it('answers with null for a user who is not in the match', () => {
    expect(matchStandingFor(matchRecord(), C)).toBeNull();
  });
});

describe('reading a match after its counterpart has changed standing', () => {
  // Nothing writes to the match when a counterpart is restricted or removed, so
  // these rows can only come from the read: `relationshipView` is the path a
  // reader goes through, and `matchStandingFor` is the question they ask of it.
  function readAs(match: MatchRecord, bStanding: SubjectStandingProjection) {
    const current = relationship({ match }, (user) => (user === B ? bStanding : standing(A))).match;
    if (current === null) {
      throw new Error('expected the view to carry the match');
    }
    return [matchStandingFor(current, A), matchStandingFor(current, B)];
  }

  it('degrades only the row of the party whose counterpart lost messaging', () => {
    const restricted = standing(B, { capabilities: ['browse_discovery', 'like'] });
    expect(readAs(matchRecord(), restricted)).toEqual(['restricted_by_target', 'active']);
  });

  it('dormants only the row of the party whose counterpart is no longer verified', () => {
    expect(readAs(matchRecord(), standing(B, { identityState: 'expired' }))).toEqual([
      'dormant_target_unverified',
      'active',
    ]);
  });

  it('closes only the row of the party whose counterpart cannot appear at all', () => {
    // A restricted counterpart is one capability away and comes back; a removed
    // one does not, and the row says so without ever naming the case.
    expect(readAs(matchRecord(), standing(B, { accountState: 'banned' }))).toEqual(['closed_by_target', 'active']);
  });

  it('leaves an ended match ended, whatever the counterpart’s standing is now', () => {
    const ended = succeeded(applyBlockToMatch(block(B, A), matchRecord(), matchedLedger(), LATER)).match;
    expect(readAs(ended, standing(B, { accountState: 'banned' }))).toEqual(['closed_by_target', 'closed_by_actor']);
  });
});

describe('the right to report', () => {
  it('survives an unmatch, with the match, conversation and withdrawn likes intact', () => {
    const outcome = succeeded(unmatch(matchedLedger(), { match: matchRecord(), actor: B, at: LATER, key: key('k1') }));
    const evidence = succeeded(
      evidenceForReport({
        viewer: A,
        subject: B,
        likes: outcome.ledger.likes,
        passes: [],
        match: outcome.match,
        blocks: [],
      }),
    );
    expect(evidence.matchId).toBe(matchRecord().matchId);
    expect(evidence.conversationId).toBe(matchRecord().conversationId);
    expect(evidence.likes).toEqual([
      { likeId: likeId('like-a-b'), state: 'withdrawn' },
      { likeId: likeId('like-b-a'), state: 'withdrawn' },
    ]);
  });

  it('survives a match that a block ended', () => {
    const ended = succeeded(applyBlockToMatch(block(B, A), matchRecord(), matchedLedger(), LATER)).match;
    const evidence = succeeded(
      evidenceForReport({ viewer: A, subject: B, likes: [], passes: [], match: ended, blocks: [] }),
    );
    expect(evidence.matchId).toBe(matchRecord().matchId);
  });

  it('survives a relationship that was only a pass or a released block', () => {
    const passed = succeeded(evidenceForReport({ viewer: A, subject: B, likes: [], passes: [pass(A, B)], match: null, blocks: [] }));
    expect(passed.passes).toEqual([{ passId: passId('pass-1'), state: 'live' }]);
    const blocked = succeeded(evidenceForReport({ viewer: A, subject: B, likes: [], passes: [], match: null, blocks: [block(B, A)] }));
    expect(blocked.matchId).toBeNull();
  });

  it('has nothing to attach when there was never an interaction', () => {
    expect(failureCode(evidenceForReport({ viewer: A, subject: B, likes: [], passes: [], match: null, blocks: [] }))).toBe(
      'not_found',
    );
    expect(failureCode(evidenceForReport({ viewer: A, subject: A, likes: [like(A, B)], passes: [], match: null, blocks: [] }))).toBe(
      'validation_failed',
    );
  });
});
