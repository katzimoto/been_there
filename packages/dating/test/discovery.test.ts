import { describe, expect, it } from 'vitest';
import type { IdentityState } from '@been-there/core';
import {
  BROWSE_DISCOVERY_CAPABILITY,
  DATING_READ_MODEL_VERSION,
  DISCOVERABLE_IDENTITY_STATE,
  type CandidateCardProjection,
  type DatingReadModel,
  type DiscoverySnapshot,
  type EligibilityReason,
  ELIGIBILITY_RULES,
  type EligibilityRule,
  PASS_SUPPRESSION_DAYS,
  STANDING_PROJECTION_VERSION,
  type SubjectStandingProjection,
  evaluateEligibility,
  selectEligibleCards,
} from '../src/index.js';
import {
  A,
  AT,
  B,
  C,
  DAYS,
  block,
  like,
  matchRecord,
  pass,
  relationship,
  standing,
} from './fixtures.js';

function reasonOf(snapshot: DiscoverySnapshot, rules?: readonly EligibilityRule[]): EligibilityReason {
  const decision = evaluateEligibility(snapshot, rules);
  if (decision.eligible) {
    throw new Error('expected the candidate to be excluded');
  }
  return decision.reason;
}

/** The baseline: two verified, complete, active users with no history. */
function snapshotWith(
  viewer = standing(A),
  candidate = standing(B),
  relationshipView = relationship(),
  now: Date = AT,
): DiscoverySnapshot {
  return { viewer, candidate, relationship: relationshipView, distance: 'lt_5_km', now };
}

describe('discovery eligibility', () => {
  it('admits two verified, complete, compatible users with no history', () => {
    expect(evaluateEligibility(snapshotWith())).toEqual({ eligible: true });
  });

  it('refuses a non-verified viewer', () => {
    const viewer = standing(A, { identityState: 'unverified' });
    expect(reasonOf(snapshotWith(viewer))).toBe<EligibilityReason>('viewer_identity_not_verified');
  });

  it('refuses a viewer without the discovery capability', () => {
    const viewer = standing(A, { accountState: 'suspended', capabilities: ['report', 'block'] });
    expect(reasonOf(snapshotWith(viewer))).toBe<EligibilityReason>('viewer_lacks_discovery_capability');
  });

  it('refuses a viewer whose profile is not complete', () => {
    for (const state of ['draft', 'incomplete', 'paused', 'hidden', 'deleted'] as const) {
      const viewer = standing(A, { profileState: state });
      expect(reasonOf(snapshotWith(viewer))).toBe<EligibilityReason>('viewer_profile_not_complete');
    }
  });

  it('refuses a candidate who is not verified, in every non-verified identity state', () => {
    const nonDiscoverable: readonly IdentityState[] = [
      'unverified',
      'pending',
      'review_required',
      'verification_failed',
      'expired',
    ];
    for (const state of nonDiscoverable) {
      const candidate = standing(B, { identityState: state });
      expect(reasonOf(snapshotWith(standing(A), candidate))).toBe<EligibilityReason>(
        'candidate_identity_not_verified',
      );
    }
  });

  it('can never return eligible for a non-verified candidate, even with an empty rule table', () => {
    const candidate = standing(B, { identityState: 'expired' });
    expect(evaluateEligibility(snapshotWith(standing(A), candidate), [])).toEqual({
      eligible: false,
      reason: 'candidate_identity_not_verified',
    });
  });

  it('checks the candidate identity before any other candidate-side rule', () => {
    const candidateRules = ELIGIBILITY_RULES.filter((rule) => rule.reason.startsWith('candidate'));
    expect(candidateRules[0]?.reason).toBe<EligibilityReason>('candidate_identity_not_verified');
  });

  it('treats verified as the only discoverable identity state', () => {
    expect(DISCOVERABLE_IDENTITY_STATE).toBe<IdentityState>('verified');
  });

  it('refuses a candidate whose profile is not complete', () => {
    const candidate = standing(B, { profileState: 'paused' });
    expect(reasonOf(snapshotWith(standing(A), candidate))).toBe<EligibilityReason>(
      'candidate_profile_not_complete',
    );
  });

  it('refuses a candidate the product must not show', () => {
    expect(reasonOf(snapshotWith(standing(A), standing(B, { accountState: 'banned' })))).toBe<EligibilityReason>(
      'candidate_account_not_visible',
    );
    expect(
      reasonOf(snapshotWith(standing(A), standing(B, { accountState: 'suspended', capabilities: ['report'] }))),
    ).toBe<EligibilityReason>('candidate_account_not_visible');
  });

  it('refuses a candidate who can appear but cannot reciprocate', () => {
    // A card the candidate is not allowed to act on is a page slot spent for
    // nothing, so it is denied rather than served.
    const cannotLike = standing(B, { capabilities: [BROWSE_DISCOVERY_CAPABILITY] });
    expect(reasonOf(snapshotWith(standing(A), cannotLike))).toBe<EligibilityReason>(
      'candidate_cannot_reciprocate',
    );
  });

  it('denies an account-standing failure before a block, as R3 and R4 are ordered', () => {
    // R3 (cannot appear, or cannot reciprocate) precedes R4 (block) in the
    // specification, so a blocked candidate who also cannot reciprocate is
    // reported as such. Both deny and neither reason is ever rendered, so the
    // order cannot leak; it is pinned here so the choice is visible.
    const view = relationship({ blocks: [block(B, A)] });
    const cannotLike = standing(B, { capabilities: [BROWSE_DISCOVERY_CAPABILITY] });
    expect(reasonOf(snapshotWith(standing(A), cannotLike, view))).toBe<EligibilityReason>(
      'candidate_cannot_reciprocate',
    );
  });

  it('refuses both directions of a block', () => {
    expect(reasonOf(snapshotWith(standing(A), standing(B), relationship({ blocks: [block(A, B)] })))).toBe(
      'blocked',
    );
    expect(reasonOf(snapshotWith(standing(A), standing(B), relationship({ blocks: [block(B, A)] })))).toBe(
      'blocked',
    );
  });

  it('lets a block win over an active match', () => {
    const view = relationship({ blocks: [block(B, A)], match: matchRecord() });
    expect(reasonOf(snapshotWith(standing(A), standing(B), view))).toBe<EligibilityReason>('blocked');
  });

  it('refuses the viewer’s own profile', () => {
    const viewer = standing(A);
    expect(reasonOf(snapshotWith(viewer, standing(A)))).toBe<EligibilityReason>('self_view');
  });

  it('refuses a candidate the viewer has already decided on', () => {
    expect(reasonOf(snapshotWith(standing(A), standing(B), relationship({ likes: [like(A, B)] })))).toBe(
      'already_liked',
    );
    expect(reasonOf(snapshotWith(standing(A), standing(B), relationship({ passes: [pass(A, B)] })))).toBe(
      'already_passed',
    );
  });

  it('ignores a pass the candidate made on the viewer', () => {
    const view = relationship({ passes: [pass(B, A)] });
    expect(evaluateEligibility(snapshotWith(standing(A), standing(B), view))).toEqual({ eligible: true });
  });

  it('lets a pass lapse, and refuses a superseded one', () => {
    // A pass is a 30-day window, not a tombstone: the day after it ends the
    // candidate is eligible again, and a like that overrode the pass never
    // suppressed them in the first place.
    const view = relationship({ passes: [pass(A, B, 'pass-a-b', AT)] });
    const onDay29 = { ...snapshotWith(standing(A), standing(B), view), now: DAYS(PASS_SUPPRESSION_DAYS - 1) };
    const onDay30 = { ...snapshotWith(standing(A), standing(B), view), now: DAYS(PASS_SUPPRESSION_DAYS) };
    const onDay31 = { ...snapshotWith(standing(A), standing(B), view), now: DAYS(PASS_SUPPRESSION_DAYS + 1) };
    expect(reasonOf(onDay29)).toBe<EligibilityReason>('already_passed');
    expect(evaluateEligibility(onDay30)).toEqual({ eligible: true });
    expect(evaluateEligibility(onDay31)).toEqual({ eligible: true });
    const superseded = relationship({ passes: [pass(A, B, 'pass-a-b', AT, 'superseded')] });
    expect(evaluateEligibility(snapshotWith(standing(A), standing(B), superseded))).toEqual({ eligible: true });
  });

  it('re-shows a pair whose like was withdrawn', () => {
    const withdrawn = { ...like(A, B), state: 'withdrawn' as const };
    const view = relationship({ likes: [withdrawn] });
    expect(evaluateEligibility(snapshotWith(standing(A), standing(B), view))).toEqual({ eligible: true });
  });

  it('refuses an already matched candidate but re-shows an unmatched one', () => {
    expect(reasonOf(snapshotWith(standing(A), standing(B), relationship({ match: matchRecord() })))).toBe(
      'already_matched',
    );
    const ended = matchRecord({
      standings: ['closed_by_actor', 'closed_by_actor'],
      ended: { cause: 'unmatched', actorId: A, at: AT, idempotencyKey: null },
    });
    expect(evaluateEligibility(snapshotWith(standing(A), standing(B), relationship({ match: ended })))).toEqual({
      eligible: true,
    });
  });

  it('still shows a candidate who has already liked the viewer', () => {
    // A pending like is a decision the viewer has not made yet: hiding the
    // person would strand it. Liking them completes the match instead.
    const view = relationship({ likes: [like(B, A, 'like-b-a')] });
    expect(evaluateEligibility(snapshotWith(standing(A), standing(B), view))).toEqual({ eligible: true });
  });

  it('applies the viewer’s own age range, but not an unknown age', () => {
    const viewer = standing(A, { preferences: { ageRange: { min: 30, max: 40 } } });
    expect(reasonOf(snapshotWith(viewer, standing(B, { age: 22 })))).toBe<EligibilityReason>('age_out_of_range');
    expect(evaluateEligibility(snapshotWith(viewer, standing(B, { age: 35 })))).toEqual({ eligible: true });
    expect(evaluateEligibility(snapshotWith(viewer, standing(B, { age: null })))).toEqual({ eligible: true });
  });

  it('applies the viewer’s distance limit to the coarse band', () => {
    const viewer = standing(A, { preferences: { maxDistanceKm: 25 } });
    const snapshot = { ...snapshotWith(viewer, standing(B, { location: '50_100_km' })), distance: '50_100_km' as const };
    expect(reasonOf(snapshot)).toBe<EligibilityReason>('beyond_distance_limit');
  });

  it('applies the viewer’s own interest list to their own page', () => {
    const viewer = standing(A, { preferences: { seekingGenders: ['man'] } });
    const candidate = standing(B, { genderIdentities: ['woman', 'non_binary'] });
    expect(reasonOf(snapshotWith(viewer, candidate))).toBe<EligibilityReason>('gender_out_of_scope');
  });

  it('keeps the page filter and the pair test on separate axes', () => {
    // The two axes answer different questions. A viewer who seeks only men but
    // is open to being matched with anyone must not have their openness
    // narrowed to their own page filter, which is what one conflated field did.
    const viewer = standing(A, {
      genderIdentities: ['woman'],
      preferences: { seekingGenders: ['man'], openTo: ['man', 'woman'] },
    });
    const sought = standing(B, { genderIdentities: ['man'], preferences: { openTo: ['woman'] } });
    expect(evaluateEligibility(snapshotWith(viewer, sought))).toEqual({ eligible: true });
    // Someone outside the seeking list is off this page even when the pair itself
    // is compatible.
    const unsought = standing(C, { genderIdentities: ['non_binary'], preferences: { openTo: ['woman'] } });
    expect(reasonOf(snapshotWith(viewer, unsought))).toBe<EligibilityReason>('gender_out_of_scope');
  });

  it('refuses a pair that fails the mutual test in the candidate’s own direction', () => {
    const viewer = standing(A, { genderIdentities: ['woman'], preferences: { openTo: ['man'] } });
    const candidate = standing(B, { genderIdentities: ['man'], preferences: { openTo: ['man'] } });
    expect(reasonOf(snapshotWith(viewer, candidate))).toBe<EligibilityReason>('not_mutually_compatible');
  });

  it('reports gender before distance when a candidate fails both', () => {
    // The order is normative in both specifications: age, then gender, then
    // distance, then the mutual test. A candidate who is out of the viewer's
    // scope *and* too far has one answer, not whichever check ran first.
    const viewer = standing(A, { preferences: { seekingGenders: ['man'], maxDistanceKm: 25 } });
    const candidate = standing(B, { genderIdentities: ['woman'], location: '50_100_km' });
    const snapshot = { ...snapshotWith(viewer, candidate), distance: '50_100_km' as const };
    expect(reasonOf(snapshot)).toBe<EligibilityReason>('gender_out_of_scope');
  });

  it('reports the first failing rule in priority order', () => {
    // Unverified candidate *and* blocked: the identity rule is earlier, and the
    // answer must be deterministic, not whichever check happened to run first.
    const view = relationship({ blocks: [block(A, B)] });
    const candidate = standing(B, { identityState: 'unverified' });
    expect(reasonOf(snapshotWith(standing(A), candidate, view))).toBe<EligibilityReason>(
      'candidate_identity_not_verified',
    );
  });

  it('has a unique reason per rule', () => {
    const reasons = ELIGIBILITY_RULES.map((rule) => rule.reason);
    expect(new Set(reasons).size).toBe(reasons.length);
  });
});

describe('selectEligibleCards', () => {
  const cardFor = (user: typeof B | typeof C): CandidateCardProjection => ({
    projectionVersion: STANDING_PROJECTION_VERSION,
    userId: user,
    displayName: 'Card',
    age: 30,
    genderIdentities: ['woman'],
    bio: 'bio',
    photoIds: [],
    distance: 'lt_5_km',
  });

  function model(overrides: Partial<DatingReadModel>): DatingReadModel {
    const standings: Record<string, SubjectStandingProjection> = {
      [A]: standing(A),
      [B]: standing(B),
      [C]: standing(C, { identityState: 'pending' }),
    };
    return {
      version: DATING_READ_MODEL_VERSION,
      standingFor: (user) => standings[user] ?? null,
      cardFor: (_viewer, candidate) =>
        candidate === B ? cardFor(B) : candidate === C ? cardFor(C) : null,
      relationshipFor: () => relationship(),
      ...overrides,
    };
  }

  it('serves only cards whose candidate passes the gate, in store order', () => {
    const served = selectEligibleCards(A, model({}), [A, B, C], AT);
    expect(served.map((entry) => entry.userId)).toEqual([B]);
  });

  it('serves nothing when the viewer has no standing projection', () => {
    const served = selectEligibleCards(C, model({ standingFor: () => null }), [B], AT);
    expect(served).toEqual([]);
  });

  it('serves nothing when the viewer is not eligible to browse at all', () => {
    const unverified = standing(A, { identityState: 'unverified' });
    const served = selectEligibleCards(
      A,
      model({ standingFor: (user) => (user === A ? unverified : standing(B)) }),
      [B],
      AT,
    );
    expect(served).toEqual([]);
  });

  it('serves nothing from a read model whose version it cannot read', () => {
    const served = selectEligibleCards(A, model({ version: DATING_READ_MODEL_VERSION + 1 }), [B], AT);
    expect(served).toEqual([]);
  });

  it('is read against the clock it is given, not the wall clock', () => {
    const passed = model({ relationshipFor: () => relationship({ passes: [pass(A, B)] }) });
    expect(selectEligibleCards(A, passed, [B], AT)).toEqual([]);
    expect(selectEligibleCards(A, passed, [B], DAYS(PASS_SUPPRESSION_DAYS)).map((entry) => entry.userId)).toEqual([B]);
  });
});
