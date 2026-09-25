import { describe, expect, it } from 'vitest';
import { type Result, assertMachineIsTotal } from '@been-there/core';
import {
  EMPTY_LEDGER,
  type MatchResolution,
  applyBlockToMatch,
  canonicalPair,
  deriveMatchId,
  evidenceForReport,
  interactionMachine,
  isMutualLike,
  recordLike,
  resolveMatch,
  unmatch,
  withdrawLike,
} from '../src/index.js';
import { A, AT, B, C, LATER, block, like, likeId, matchRecord, pass, passId } from './fixtures.js';

function succeeded<T, E extends { code: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.error.code}`);
  }
  return result.value;
}

function failureCode<T, E extends { code: string }>(result: Result<T, E>): string {
  if (result.ok) {
    throw new Error('expected a failure');
  }
  return result.error.code;
}

function resolution(attempt: Parameters<typeof resolveMatch>[0]): MatchResolution {
  return succeeded(resolveMatch(attempt));
}

describe('like ledger', () => {
  it('records a like once and treats a replay as a no-op', () => {
    const first = succeeded(recordLike(EMPTY_LEDGER, like(A, B, 'like-a-b')));
    const replayed = succeeded(recordLike(first, like(A, B, 'like-a-b')));
    expect(replayed).toBe(first);
    expect(replayed.likes).toHaveLength(1);
  });

  it('refuses a second, differently identified like for the same pair', () => {
    const first = succeeded(recordLike(EMPTY_LEDGER, like(A, B, 'like-a-b')));
    const second = recordLike(first, like(A, B, 'like-a-b-retry'));
    expect(failureCode(second)).toBe('conflict');
    expect(first.likes).toHaveLength(1);
  });

  it('keeps likes in both directions of a pair as distinct facts', () => {
    const oneWay = succeeded(recordLike(EMPTY_LEDGER, like(A, B, 'like-a-b')));
    const bothWays = succeeded(recordLike(oneWay, like(B, A, 'like-b-a')));
    expect(bothWays.likes).toHaveLength(2);
  });

  it('refuses a self-like', () => {
    expect(failureCode(recordLike(EMPTY_LEDGER, like(A, A)))).toBe('validation_failed');
  });

  it('withdraws a one-sided like without touching the other direction', () => {
    const ledger = succeeded(recordLike(EMPTY_LEDGER, like(A, B, 'like-a-b')));
    const bothWays = succeeded(recordLike(ledger, like(B, A, 'like-b-a')));
    const after = withdrawLike(bothWays, likeId('like-a-b'));
    expect(after.likes.map((entry) => entry.likeId)).toEqual([likeId('like-b-a')]);
    expect(withdrawLike(after, likeId('like-a-b'))).toBe(after);
  });
});

describe('match identity', () => {
  it('is the same for both orders of the same two people', () => {
    expect(deriveMatchId(A, B)).toBe(deriveMatchId(B, A));
    expect(canonicalPair(B, A)).toEqual([A, B]);
  });

  it('is different for a different pair', () => {
    expect(deriveMatchId(A, B)).not.toBe(deriveMatchId(A, C));
  });
});

describe('resolveMatch', () => {
  const withLikes = succeeded(recordLike(EMPTY_LEDGER, like(A, B, 'like-a-b')));
  const mutual = succeeded(recordLike(withLikes, like(B, A, 'like-b-a')));

  it('waits when only one side has liked', () => {
    expect(resolution({ actor: A, counterpart: B, like: mutual.likes[0]!, ledger: withLikes, blocks: [], passes: [] })).toEqual({
      outcome: 'awaiting_counterpart',
    });
  });

  it('produces exactly one match from two reciprocal likes, whichever side commits second', () => {
    // Two racers: each has just inserted their own like into a ledger that now
    // contains both, and each resolves the pair independently.
    const aSecond = resolution({ actor: A, counterpart: B, like: like(A, B, 'like-a-b'), ledger: mutual, blocks: [], passes: [] });
    const bSecond = resolution({ actor: B, counterpart: A, like: like(B, A, 'like-b-a'), ledger: mutual, blocks: [], passes: [] });
    expect(aSecond.outcome).toBe('match_created');
    expect(aSecond).toEqual(bSecond);
    if (aSecond.outcome !== 'match_created' || bSecond.outcome !== 'match_created') {
      throw new Error('expected a match');
    }
    expect(aSecond.match.matchId).toBe(deriveMatchId(A, B));
    expect([...aSecond.match.likeIds].sort()).toEqual([likeId('like-a-b'), likeId('like-b-a')]);
    expect(aSecond.match.participants).toEqual([A, B]);
    expect(aSecond.match.status).toBe('active');
  });

  it('derives the same match when the two likes were recorded in the opposite order', () => {
    const bFirst = succeeded(recordLike(EMPTY_LEDGER, like(B, A, 'like-b-a')));
    const ledger = succeeded(recordLike(bFirst, like(A, B, 'like-a-b')));
    const result = resolution({ actor: A, counterpart: B, like: like(A, B, 'like-a-b'), ledger, blocks: [], passes: [] });
    if (result.outcome !== 'match_created') {
      throw new Error('expected a match');
    }
    expect(result.match.matchId).toBe(deriveMatchId(B, A));
  });

  it('refuses a match when either party has blocked the other', () => {
    expect(resolution({ actor: A, counterpart: B, like: like(A, B, 'like-a-b'), ledger: mutual, blocks: [block(B, A)], passes: [] })).toEqual({
      outcome: 'match_refused',
      reason: 'blocked',
    });
  });

  it('refuses a match across an active pass in either direction', () => {
    expect(resolution({ actor: A, counterpart: B, like: like(A, B, 'like-a-b'), ledger: mutual, blocks: [], passes: [pass(A, B)] })).toEqual({
      outcome: 'match_refused',
      reason: 'passed',
    });
    expect(resolution({ actor: A, counterpart: B, like: like(A, B, 'like-a-b'), ledger: mutual, blocks: [], passes: [pass(B, A)] })).toEqual({
      outcome: 'match_refused',
      reason: 'passed',
    });
  });

  it('refuses to match a user with themselves and an unrecorded like', () => {
    expect(failureCode(resolveMatch({ actor: A, counterpart: A, like: like(A, B), ledger: mutual, blocks: [], passes: [] }))).toBe(
      'validation_failed',
    );
    expect(
      failureCode(resolveMatch({ actor: A, counterpart: B, like: like(A, C, 'like-a-c'), ledger: mutual, blocks: [], passes: [] })),
    ).toBe('validation_failed');
  });
});

describe('interaction machine', () => {
  const mutualContext = {
    self: false,
    blocked: false,
    passActive: false,
    like: like(A, B, 'like-a-b'),
    counterpartLike: like(B, A, 'like-b-a'),
  };

  it('starts with no decision and can be liked or passed', () => {
    expect(interactionMachine.initial).toBe('none');
    expect(interactionMachine.allowedEvents('none', mutualContext)).toEqual(['like', 'pass']);
  });

  it('matches only on two distinct reciprocal likes', () => {
    const liked = succeeded(interactionMachine.next('none', 'like', mutualContext));
    expect(liked).toBe('liked');
    expect(interactionMachine.can('liked', 'match', mutualContext)).toBe(true);
    expect(interactionMachine.can('liked', 'match', { ...mutualContext, counterpartLike: null })).toBe(false);
    expect(
      interactionMachine.can('liked', 'match', { ...mutualContext, like: like(A, B, 'same') , counterpartLike: like(A, B, 'same') }),
    ).toBe(false);
  });

  it('refuses to like across a block or a self-view', () => {
    expect(interactionMachine.can('none', 'like', { ...mutualContext, blocked: true })).toBe(false);
    expect(interactionMachine.can('none', 'like', { ...mutualContext, self: true })).toBe(false);
  });

  it('allows liking again after a pass and after an unmatch', () => {
    expect(succeeded(interactionMachine.next('passed', 'like', mutualContext))).toBe('liked');
    expect(succeeded(interactionMachine.next('unmatched', 'like', mutualContext))).toBe('liked');
  });

  it('refuses to match while a pass is active', () => {
    expect(interactionMachine.can('liked', 'match', { ...mutualContext, passActive: true })).toBe(false);
  });

  it('has no dead end', () => {
    expect(() => assertMachineIsTotal(interactionMachine)).not.toThrow();
    for (const state of ['none', 'liked', 'passed', 'matched', 'unmatched'] as const) {
      expect(interactionMachine.legalEvents(state).length).toBeGreaterThan(0);
    }
  });

  it('detects reciprocity only between opposite directed likes', () => {
    expect(isMutualLike(like(A, B, 'x'), like(B, A, 'y'))).toBe(true);
    expect(isMutualLike(like(A, B, 'x'), like(A, B, 'y'))).toBe(false);
    expect(isMutualLike(like(A, B, 'x'), null)).toBe(false);
    expect(isMutualLike(like(A, B, 'x'), like(A, B, 'x'))).toBe(false);
  });
});

describe('unmatch', () => {
  it('lets either participant end a live match and keeps the record', () => {
    const outcome = succeeded(unmatch(matchRecord(), B, LATER));
    expect(outcome.match.status).toBe('unmatched');
    expect(outcome.match.endedAt).toBe(LATER);
    expect(outcome.match.matchId).toBe(matchRecord().matchId);
    expect(outcome.conversation).toEqual({
      conversationId: matchRecord().conversationId,
      state: 'closed',
      retainedForEvidence: true,
    });
  });

  it('refuses an outsider and an already ended match', () => {
    expect(failureCode(unmatch(matchRecord(), C, LATER))).toBe('permission_denied');
    const ended = matchRecord({ status: 'unmatched', endedAt: AT });
    expect(failureCode(unmatch(ended, A, LATER))).toBe('invalid_transition');
  });

  it('closes a match that had no conversation yet without inventing one', () => {
    const outcome = succeeded(unmatch(matchRecord({ conversationId: null }), A, LATER));
    expect(outcome.conversation).toBeNull();
  });

  it('ends a match when either party blocks the other', () => {
    const ended = succeeded(applyBlockToMatch(block(B, A), matchRecord(), LATER));
    expect(ended.status).toBe('ended_by_block');
    expect(ended.endedAt).toBe(LATER);
    expect(failureCode(applyBlockToMatch(block(B, A), ended, LATER))).toBe('invalid_transition');
    expect(failureCode(applyBlockToMatch(block(B, C), matchRecord(), LATER))).toBe('validation_failed');
  });
});

describe('the right to report', () => {
  it('survives an unmatch, with the match and conversation handles intact', () => {
    const ended = succeeded(unmatch(matchRecord(), B, LATER)).match;
    const evidence = succeeded(
      evidenceForReport({
        viewer: A,
        subject: B,
        likes: [like(A, B, 'like-a-b'), like(B, A, 'like-b-a')],
        passes: [],
        match: ended,
        blocks: [],
      }),
    );
    expect(evidence.matchId).toBe(matchRecord().matchId);
    expect(evidence.conversationId).toBe(matchRecord().conversationId);
    expect(evidence.likeIds).toHaveLength(2);
  });

  it('survives a match that a block ended', () => {
    const ended = succeeded(applyBlockToMatch(block(B, A), matchRecord(), LATER));
    const evidence = succeeded(
      evidenceForReport({ viewer: A, subject: B, likes: [], passes: [], match: ended, blocks: [] }),
    );
    expect(evidence.matchId).toBe(matchRecord().matchId);
  });

  it('survives a relationship that was only a pass or a released block', () => {
    const passed = succeeded(evidenceForReport({ viewer: A, subject: B, likes: [], passes: [pass(A, B)], match: null, blocks: [] }));
    expect(passed.passIds).toEqual([passId('pass-1')]);
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
