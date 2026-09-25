import { describe, expect, it } from 'vitest';
import { type Result, assertMachineIsTotal } from '@been-there/core';
import {
  EMPTY_LEDGER,
  type LikeActionContext,
  type MatchResolution,
  PASS_SUPPRESSION_DAYS,
  applyBlockToMatch,
  canonicalPair,
  currentLikeBetween,
  deriveMatchId,
  evidenceForReport,
  interactionMachine,
  isMutualLike,
  matchStandingFor,
  recordLike,
  recordPass,
  resolveMatch,
  supersedePasses,
  unmatch,
  withdrawLike,
} from '../src/index.js';
import {
  A,
  AT,
  B,
  C,
  DAYS,
  LATER,
  block,
  key,
  like,
  likeId,
  matchedLedger,
  matchRecord,
  pass,
  passId,
  standing,
} from './fixtures.js';

function succeeded<T, E extends { code: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.error.code}`);
  }
  return result.value;
}

function failure<T, E extends { code: string }>(result: Result<T, E>): E {
  if (result.ok) {
    throw new Error('expected a failure');
  }
  return result.error;
}

function failureCode<T, E extends { code: string }>(result: Result<T, E>): string {
  return failure(result).code;
}

function resolution(attempt: Parameters<typeof resolveMatch>[0]): MatchResolution {
  return succeeded(resolveMatch(attempt));
}

/** Two eligible, verified, unblocked parties and an empty ledger. */
function context(overrides: Partial<LikeActionContext> = {}): LikeActionContext {
  return {
    actor: standing(A),
    target: standing(B),
    blocks: [],
    passes: [],
    at: LATER,
    ...overrides,
  };
}

describe('like ledger', () => {
  it('records a like once and treats a replay as a no-op', () => {
    const first = succeeded(recordLike(EMPTY_LEDGER, like(A, B, 'like-a-b'), context()));
    const replayed = succeeded(recordLike(first, like(A, B, 'like-a-b'), context()));
    expect(replayed).toBe(first);
    expect(replayed.likes).toHaveLength(1);
    expect(replayed.likes[0]?.state).toBe('live');
  });

  it('refuses a second, differently identified like for the same pair', () => {
    const first = succeeded(recordLike(EMPTY_LEDGER, like(A, B, 'like-a-b'), context()));
    const second = recordLike(first, like(A, B, 'like-a-b-retry'), context());
    expect(failureCode(second)).toBe('conflict');
    expect(first.likes).toHaveLength(1);
  });

  it('keeps likes in both directions of a pair as distinct facts', () => {
    const oneWay = succeeded(recordLike(EMPTY_LEDGER, like(A, B, 'like-a-b'), context()));
    const bothWays = succeeded(
      recordLike(oneWay, like(B, A, 'like-b-a'), context({ actor: standing(B), target: standing(A) })),
    );
    expect(bothWays.likes).toHaveLength(2);
  });

  it('refuses a self-like', () => {
    expect(failureCode(recordLike(EMPTY_LEDGER, like(A, A), context()))).toBe('validation_failed');
  });

  it('withdraws a like without removing the record, so the pair stays reportable', () => {
    const ledger = succeeded(recordLike(EMPTY_LEDGER, like(A, B, 'like-a-b'), context()));
    const bothWays = succeeded(
      recordLike(ledger, like(B, A, 'like-b-a'), context({ actor: standing(B), target: standing(A) })),
    );
    const after = withdrawLike(bothWays, likeId('like-a-b'));
    // The row is retained, not deleted: a deleted like is a relationship that
    // can no longer be reported.
    expect(after.likes.map((entry) => [entry.likeId, entry.state])).toEqual([
      [likeId('like-a-b'), 'withdrawn'],
      [likeId('like-b-a'), 'live'],
    ]);
    expect(currentLikeBetween(after, A, B)).toBeNull();
    expect(withdrawLike(after, likeId('like-a-b'))).toBe(after);
    const evidence = succeeded(
      evidenceForReport({ viewer: B, subject: A, likes: after.likes, passes: [], match: null, blocks: [] }),
    );
    expect(evidence.likes).toEqual([
      { likeId: likeId('like-a-b'), state: 'withdrawn' },
      { likeId: likeId('like-b-a'), state: 'live' },
    ]);
  });

  it('refuses a second id while a like is current, and accepts a fresh decision once it is withdrawn', () => {
    const first = succeeded(recordLike(EMPTY_LEDGER, like(A, B, 'like-a-b'), context()));
    expect(failureCode(recordLike(first, like(A, B, 'like-a-b-again'), context()))).toBe('conflict');
    const redecided = succeeded(
      recordLike(withdrawLike(first, likeId('like-a-b')), like(A, B, 'like-a-b-again'), context()),
    );
    // Both decisions stay on record: the withdrawal did not erase the first one.
    expect(redecided.likes.map((entry) => [entry.likeId, entry.state])).toEqual([
      [likeId('like-a-b'), 'withdrawn'],
      [likeId('like-a-b-again'), 'live'],
    ]);
  });
});

describe('like preconditions at action time', () => {
  it('refuses a liker whose verification has lapsed', () => {
    const lapsed = standing(A, { identityState: 'expired' });
    const result = recordLike(EMPTY_LEDGER, like(A, B), context({ actor: lapsed }));
    expect(failureCode(result)).toBe('permission_denied');
  });

  it('refuses a liker without the like capability, or whose profile is not complete', () => {
    expect(
      failureCode(
        recordLike(EMPTY_LEDGER, like(A, B), context({ actor: standing(A, { capabilities: ['browse_discovery'] }) })),
      ),
    ).toBe('permission_denied');
    expect(
      failureCode(recordLike(EMPTY_LEDGER, like(A, B), context({ actor: standing(A, { profileState: 'paused' }) }))),
    ).toBe('permission_denied');
  });

  it('refuses a target who is not presentable, verifiable or able to reciprocate', () => {
    for (const target of [
      standing(B, { identityState: 'expired' }),
      standing(B, { profileState: 'paused' }),
      standing(B, { visibleInProduct: false }),
      standing(B, { capabilities: ['browse_discovery'] }),
    ]) {
      expect(failureCode(recordLike(EMPTY_LEDGER, like(A, B), context({ target })))).toBe('not_eligible');
    }
  });

  it('gives a liker no way to tell a block from an absence', () => {
    // Probing with a like must not reveal that a block exists, so the error a
    // block produces is the same error an unverified target produces.
    const blocked = failure(recordLike(EMPTY_LEDGER, like(A, B), context({ blocks: [block(B, A)] })));
    const lapsed = failure(
      recordLike(EMPTY_LEDGER, like(A, B), context({ target: standing(B, { identityState: 'expired' }) })),
    );
    expect(blocked.code).toBe('not_eligible');
    expect(blocked).toEqual(lapsed);
    expect(blocked.details).toBeUndefined();
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
  const withLikes = succeeded(recordLike(EMPTY_LEDGER, like(A, B, 'like-a-b'), context()));
  const mutual = succeeded(
    recordLike(withLikes, like(B, A, 'like-b-a'), context({ actor: standing(B), target: standing(A) })),
  );

  it('waits when only one side has liked', () => {
    expect(resolution({ actor: A, counterpart: B, like: mutual.likes[0]!, ledger: withLikes, blocks: [], passes: [], at: LATER })).toEqual({
      outcome: 'awaiting_counterpart',
      ledger: withLikes,
    });
  });

  it('produces exactly one match from two reciprocal likes, whichever side commits second', () => {
    // Two racers: each has just inserted their own like into a ledger that now
    // contains both, and each resolves the pair independently.
    const aSecond = resolution({ actor: A, counterpart: B, like: like(A, B, 'like-a-b'), ledger: mutual, blocks: [], passes: [], at: LATER });
    const bSecond = resolution({ actor: B, counterpart: A, like: like(B, A, 'like-b-a'), ledger: mutual, blocks: [], passes: [], at: LATER });
    expect(aSecond.outcome).toBe('match_created');
    expect(aSecond).toEqual(bSecond);
    if (aSecond.outcome !== 'match_created' || bSecond.outcome !== 'match_created') {
      throw new Error('expected a match');
    }
    expect(aSecond.match.matchId).toBe(deriveMatchId(A, B));
    expect([...aSecond.match.likeIds].sort()).toEqual([likeId('like-a-b'), likeId('like-b-a')]);
    expect(aSecond.match.participants).toEqual([A, B]);
    expect(aSecond.match.standings).toEqual(['active', 'active']);
    expect(aSecond.ledger.likes.every((entry) => entry.state === 'matched')).toBe(true);
  });

  it('derives the same match when the two likes were recorded in the opposite order', () => {
    const bFirst = succeeded(
      recordLike(EMPTY_LEDGER, like(B, A, 'like-b-a'), context({ actor: standing(B), target: standing(A) })),
    );
    const ledger = succeeded(recordLike(bFirst, like(A, B, 'like-a-b'), context()));
    const result = resolution({ actor: A, counterpart: B, like: like(A, B, 'like-a-b'), ledger, blocks: [], passes: [], at: LATER });
    if (result.outcome !== 'match_created') {
      throw new Error('expected a match');
    }
    expect(result.match.matchId).toBe(deriveMatchId(B, A));
  });

  it('refuses a match when either party has blocked the other', () => {
    expect(resolution({ actor: A, counterpart: B, like: like(A, B, 'like-a-b'), ledger: mutual, blocks: [block(B, A)], passes: [], at: LATER })).toEqual({
      outcome: 'match_refused',
      reason: 'blocked',
    });
  });

  it('refuses a match across a pass still in effect, in either direction', () => {
    for (const live of [pass(A, B), pass(B, A)]) {
      expect(
        resolution({ actor: A, counterpart: B, like: like(A, B, 'like-a-b'), ledger: mutual, blocks: [], passes: [live], at: LATER }),
      ).toEqual({ outcome: 'match_refused', reason: 'passed' });
    }
  });

  it('ignores a pass that has outlived its window, and one the liker has since overridden', () => {
    const expired = pass(A, B, 'pass-a-b', AT);
    expect(
      resolution({
        actor: A,
        counterpart: B,
        like: like(A, B, 'like-a-b'),
        ledger: mutual,
        blocks: [],
        passes: [expired],
        at: DAYS(PASS_SUPPRESSION_DAYS),
      }),
    ).toEqual(expect.objectContaining({ outcome: 'match_created' }));
    const superseded = supersedePasses([pass(B, A, 'pass-b-a')], B, A);
    expect(
      resolution({
        actor: A,
        counterpart: B,
        like: like(A, B, 'like-a-b'),
        ledger: mutual,
        blocks: [],
        passes: superseded,
        at: LATER,
      }),
    ).toEqual(expect.objectContaining({ outcome: 'match_created' }));
  });

  it('refuses to match a user with themselves, an unrecorded like, and a withdrawn one', () => {
    expect(
      failureCode(resolveMatch({ actor: A, counterpart: A, like: like(A, B), ledger: mutual, blocks: [], passes: [], at: LATER })),
    ).toBe('validation_failed');
    expect(
      failureCode(
        resolveMatch({ actor: A, counterpart: B, like: like(A, C, 'like-a-c'), ledger: mutual, blocks: [], passes: [], at: LATER }),
      ),
    ).toBe('validation_failed');
    const withdrawn = withdrawLike(matchedLedger(), likeId('like-a-b'));
    expect(
      failureCode(
        resolveMatch({ actor: A, counterpart: B, like: like(A, B, 'like-a-b'), ledger: withdrawn, blocks: [], passes: [], at: LATER }),
      ),
    ).toBe('validation_failed');
  });
});

describe('a like after a pass', () => {
  // The machine and the resolver used to disagree here, and nothing composed
  // them, which is why the disagreement survived: the machine cleared the pass
  // and the resolver still saw it. These three tests compose the two.
  const mutualLedger = matchedLedger([
    like(B, A, 'like-b-a'),
    { ...like(A, B, 'like-a-b'), createdAt: LATER, state: 'live' as const },
  ]);

  it('matches once the passer likes, because the like supersedes their own pass', () => {
    const passerPass = pass(A, B, 'pass-a-b');
    const machine = interactionMachine.next('passed', 'like', {
      self: false,
      blocked: false,
      passActive: true,
      like: like(A, B, 'like-a-b'),
      counterpartLike: like(B, A, 'like-b-a'),
    });
    expect(succeeded(machine)).toBe('liked');

    const afterLike = supersedePasses([passerPass], A, B);
    expect(afterLike[0]?.state).toBe('superseded');
    const result = resolution({
      actor: A,
      counterpart: B,
      like: like(A, B, 'like-a-b'),
      ledger: mutualLedger,
      blocks: [],
      passes: afterLike,
      at: LATER,
    });
    expect(result.outcome).toBe('match_created');
  });

  it('records which pass the like overrode', () => {
    const ledger = succeeded(
      recordLike(EMPTY_LEDGER, like(A, B, 'like-a-b'), context({ passes: [pass(A, B, 'pass-a-b')], at: LATER })),
    );
    expect(ledger.likes[0]?.supersededPassId).toEqual(passId('pass-a-b'));
  });

  it('still refuses while the counterpart’s own pass is in effect', () => {
    const result = resolution({
      actor: A,
      counterpart: B,
      like: like(A, B, 'like-a-b'),
      ledger: mutualLedger,
      blocks: [],
      // A's own pass is superseded; B's is untouched, and one person's like
      // cannot speak for the other party's pass.
      passes: [pass(B, A, 'pass-b-a')],
      at: LATER,
    });
    expect(result).toEqual({ outcome: 'match_refused', reason: 'passed' });
  });

  it('expresses the like-then-pass sequence, and the later pass is the decision that stands', () => {
    const machineContext = {
      self: false,
      blocked: false,
      passActive: false,
      like: like(A, B, 'like-a-b'),
      counterpartLike: like(B, A, 'like-b-a'),
    };
    expect(succeeded(interactionMachine.next('none', 'like', machineContext))).toBe('liked');
    // The documented sequence is expressible: a pass after a like is a decision
    // the product makes, and the machine must be able to reach it.
    expect(succeeded(interactionMachine.next('liked', 'pass', machineContext))).toBe('passed');

    // At the ledger level the pass withdraws the like it overtakes, and the pass
    // is the one that stays live.
    const liked = succeeded(recordLike(EMPTY_LEDGER, like(A, B, 'like-a-b'), context()));
    const passed = succeeded(recordPass(liked, [], pass(A, B, 'pass-a-b')));
    expect(passed.ledger.likes.map((entry) => entry.state)).toEqual(['withdrawn']);
    expect(passed.passes.map((entry) => entry.state)).toEqual(['live']);
    expect(currentLikeBetween(passed.ledger, A, B)).toBeNull();
  });

  it('records a pass once, and refuses a second id for the same pair', () => {
    const first = succeeded(recordPass(EMPTY_LEDGER, [], pass(A, B, 'pass-a-b')));
    expect(succeeded(recordPass(first.ledger, first.passes, pass(A, B, 'pass-a-b'))).passes).toHaveLength(1);
    expect(failureCode(recordPass(EMPTY_LEDGER, first.passes, pass(A, B, 'pass-a-b-again')))).toBe('conflict');
    expect(failureCode(recordPass(EMPTY_LEDGER, [], pass(A, A, 'pass-a-a')))).toBe('validation_failed');
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

  it('treats liking a matched pair as a no-op rather than an error', () => {
    expect(succeeded(interactionMachine.next('matched', 'like', mutualContext))).toBe('matched');
    // The ledger agrees: the like is already on record, so a double tap changes nothing.
    const ledger = succeeded(recordLike(matchedLedger(), like(A, B, 'like-a-b'), context()));
    expect(ledger.likes).toHaveLength(2);
  });

  it('refuses to match while a pass is in effect', () => {
    expect(interactionMachine.can('liked', 'match', { ...mutualContext, passActive: true })).toBe(false);
  });

  it('has no dead end', () => {
    expect(() => assertMachineIsTotal(interactionMachine)).not.toThrow();
    for (const state of ['none', 'liked', 'passed', 'matched', 'unmatched'] as const) {
      expect(interactionMachine.legalEvents(state).length).toBeGreaterThan(0);
    }
  });

  it('detects reciprocity only between opposite directed likes that still count', () => {
    expect(isMutualLike(like(A, B, 'x'), like(B, A, 'y'))).toBe(true);
    expect(isMutualLike({ ...like(A, B, 'x'), state: 'withdrawn' }, like(B, A, 'y'))).toBe(false);
    expect(isMutualLike(like(A, B, 'x'), null)).toBe(false);
    expect(isMutualLike(like(A, B, 'x'), like(A, B, 'y'))).toBe(false);
    expect(isMutualLike(like(A, B, 'x'), like(A, B, 'x'))).toBe(false);
  });
});

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
