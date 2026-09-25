import { describe, expect, it } from 'vitest';
import { assertMachineIsTotal } from '@been-there/core';
import {
  EMPTY_LEDGER,
  type LikeActionContext,
  type MatchResolution,
  PASS_SUPPRESSION_DAYS,
  canonicalPair,
  currentLikeBetween,
  deriveMatchId,
  evidenceForReport,
  interactionMachine,
  isMutualLike,
  recordLike,
  recordPass,
  resolveMatch,
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
  failure,
  failureCode,
  like,
  likeId,
  matchedLedger,
  pass,
  passId,
  relationship,
  standing,
  succeeded,
} from './fixtures.js';

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
    const replayed = succeeded(recordLike(first.ledger, like(A, B, 'like-a-b'), context()));
    expect(replayed.ledger).toBe(first.ledger);
    expect(replayed.ledger.likes).toHaveLength(1);
    expect(replayed.ledger.likes[0]?.state).toBe('live');
  });

  it('refuses a second, differently identified like for the same pair', () => {
    const first = succeeded(recordLike(EMPTY_LEDGER, like(A, B, 'like-a-b'), context()));
    const second = recordLike(first.ledger, like(A, B, 'like-a-b-retry'), context());
    expect(failureCode(second)).toBe('conflict');
    expect(first.ledger.likes).toHaveLength(1);
  });

  it('keeps likes in both directions of a pair as distinct facts', () => {
    const oneWay = succeeded(recordLike(EMPTY_LEDGER, like(A, B, 'like-a-b'), context()));
    const bothWays = succeeded(
      recordLike(oneWay.ledger, like(B, A, 'like-b-a'), context({ actor: standing(B), target: standing(A) })),
    );
    expect(bothWays.ledger.likes).toHaveLength(2);
  });

  it('refuses a self-like', () => {
    expect(failureCode(recordLike(EMPTY_LEDGER, like(A, A), context()))).toBe('validation_failed');
  });

  it('withdraws a like without removing the record, so the pair stays reportable', () => {
    const ledger = succeeded(recordLike(EMPTY_LEDGER, like(A, B, 'like-a-b'), context())).ledger;
    const bothWays = succeeded(
      recordLike(ledger, like(B, A, 'like-b-a'), context({ actor: standing(B), target: standing(A) })),
    ).ledger;
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
    const first = succeeded(recordLike(EMPTY_LEDGER, like(A, B, 'like-a-b'), context())).ledger;
    expect(failureCode(recordLike(first, like(A, B, 'like-a-b-again'), context()))).toBe('conflict');
    const redecided = succeeded(
      recordLike(withdrawLike(first, likeId('like-a-b')), like(A, B, 'like-a-b-again'), context()),
    );
    // Both decisions stay on record: the withdrawal did not erase the first one.
    expect(redecided.ledger.likes.map((entry) => [entry.likeId, entry.state])).toEqual([
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
  const withLikes = succeeded(recordLike(EMPTY_LEDGER, like(A, B, 'like-a-b'), context())).ledger;
  const mutual = succeeded(
    recordLike(withLikes, like(B, A, 'like-b-a'), context({ actor: standing(B), target: standing(A) })),
  ).ledger;

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
    ).ledger;
    const ledger = succeeded(recordLike(bFirst, like(A, B, 'like-a-b'), context())).ledger;
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
    const superseded = [pass(B, A, 'pass-b-a', AT, 'superseded')];
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
  // Nothing here composes the steps by hand. A helper that supersedes a pass
  // only when a test calls it leaves a live pass beside a like claiming to have
  // overridden it, and then every rule that reads a pass refuses a match the
  // pair was always going to get. The scenario is recorded through `recordPass`
  // and `recordLike`, and asserted at each point that reads a pass.
  const passed = succeeded(recordPass(EMPTY_LEDGER, [], pass(A, B, 'pass-a-b')));
  const aLiked = succeeded(
    recordLike(passed.ledger, like(A, B, 'like-a-b'), context({ passes: passed.passes })),
  );
  const bothLiked = succeeded(
    recordLike(
      aLiked.ledger,
      like(B, A, 'like-b-a'),
      context({ actor: standing(B), target: standing(A), passes: aLiked.passes }),
    ),
  );
  const attempt = {
    actor: B,
    counterpart: A,
    like: like(B, A, 'like-b-a'),
    ledger: bothLiked.ledger,
    blocks: [],
    passes: bothLiked.passes,
    at: LATER,
  };

  it('records the like as the decision that overrode the pass', () => {
    expect(passed.passes.map((entry) => entry.state)).toEqual(['live']);
    expect(aLiked.ledger.likes[0]?.supersededPassId).toEqual(passId('pass-a-b'));
    // The record the like names, and the record that no longer suppresses, are
    // the same one: a like that claimed to override a still-live pass would
    // leave the data set saying both things at once.
    expect(aLiked.passes.map((entry) => [entry.passId, entry.state])).toEqual([
      [passId('pass-a-b'), 'superseded'],
    ]);
  });

  it('matches the pair, because neither side has a pass in effect any more', () => {
    expect(resolution(attempt).outcome).toBe('match_created');
  });

  it('still refuses while the counterpart’s own pass is in effect', () => {
    // B liked A, which says nothing about A's own decision to pass B, so that
    // pass is still in effect and the pair is still refused.
    const aPassed = succeeded(recordPass(EMPTY_LEDGER, [], pass(A, B, 'pass-a-b')));
    const bLiked = succeeded(
      recordLike(
        aPassed.ledger,
        like(B, A, 'like-b-a'),
        context({ actor: standing(B), target: standing(A), passes: aPassed.passes }),
      ),
    );
    expect(bLiked.passes.map((entry) => [entry.passId, entry.state])).toEqual([[passId('pass-a-b'), 'live']]);
    expect(
      resolution({
        actor: B,
        counterpart: A,
        like: like(B, A, 'like-b-a'),
        ledger: bLiked.ledger,
        blocks: [],
        passes: bLiked.passes,
        at: LATER,
      }),
    ).toEqual({ outcome: 'match_refused', reason: 'passed' });
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
    const liked = succeeded(recordLike(EMPTY_LEDGER, like(A, B, 'like-a-b'), context())).ledger;
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
    const outcome = succeeded(recordLike(matchedLedger(), like(A, B, 'like-a-b'), context()));
    expect(outcome.ledger.likes).toHaveLength(2);
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

