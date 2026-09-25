import { describe, expect, it } from 'vitest';
import type { IdentityState } from '@been-there/core';
import {
  DATING_READ_MODEL_VERSION,
  DISCOVERABLE_IDENTITY_STATE,
  type DiscoverySnapshot,
  type EligibilityReason,
  ELIGIBILITY_RULES,
  type EligibilityRule,
  STANDING_PROJECTION_VERSION,
  evaluateEligibility,
  selectEligibleCards,
} from '../src/index.js';
import type { CandidateCardProjection, DatingReadModel } from '../src/index.js';
import { A, B, C, block, like, matchRecord, pass, relationship, standing } from './fixtures.js';

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
): DiscoverySnapshot {
  return { viewer, candidate, relationship: relationshipView, distance: 'lt_5_km' };
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

  it('refuses a candidate the viewer already decided on', () => {
    expect(reasonOf(snapshotWith(standing(A), standing(B), relationship({ passes: [pass(A, B)] })))).toBe(
      'already_passed',
    );
    expect(reasonOf(snapshotWith(standing(A), standing(B), relationship({ likes: [like(A, B)] })))).toBe(
      'already_liked',
    );
  });

  it('ignores a pass the candidate made on the viewer', () => {
    const view = relationship({ passes: [pass(B, A)] });
    expect(evaluateEligibility(snapshotWith(standing(A), standing(B), view))).toEqual({ eligible: true });
  });

  it('refuses an already matched candidate but re-shows an unmatched one', () => {
    expect(reasonOf(snapshotWith(standing(A), standing(B), relationship({ match: matchRecord() })))).toBe(
      'already_matched',
    );
    const ended = matchRecord({ status: 'unmatched', endedAt: new Date('2026-01-01T00:00:00Z') });
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
    const viewer = standing(A, { preferences: { interestedIn: ['man'] } });
    const candidate = standing(B, { genderIdentities: ['woman', 'non_binary'] });
    expect(reasonOf(snapshotWith(viewer, candidate))).toBe<EligibilityReason>('gender_out_of_scope');
  });

  it('refuses a pair that fails the mutual test in the candidate’s own direction', () => {
    const viewer = standing(A, { genderIdentities: ['woman'], preferences: { interestedIn: ['man'] } });
    const candidate = standing(B, { genderIdentities: ['man'], preferences: { interestedIn: ['man'] } });
    expect(reasonOf(snapshotWith(viewer, candidate))).toBe<EligibilityReason>('not_mutually_compatible');
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
    const standings: Record<string, ReturnType<typeof standing>> = {
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
    const served = selectEligibleCards(A, model({}), [A, B, C]);
    expect(served.map((entry) => entry.userId)).toEqual([B]);
  });

  it('serves nothing when the viewer has no standing projection', () => {
    const served = selectEligibleCards(C, model({ standingFor: () => null }), [B]);
    expect(served).toEqual([]);
  });

  it('serves nothing when the viewer is not eligible to browse at all', () => {
    const unverified = standing(A, { identityState: 'unverified' });
    const served = selectEligibleCards(
      A,
      model({ standingFor: (user) => (user === A ? unverified : standing(B)) }),
      [B],
    );
    expect(served).toEqual([]);
  });

  it('serves nothing from a read model whose version it cannot read', () => {
    const served = selectEligibleCards(A, model({ version: DATING_READ_MODEL_VERSION + 1 }), [B]);
    expect(served).toEqual([]);
  });
});
