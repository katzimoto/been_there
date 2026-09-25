import {
  type AccountState,
  type IdentityState,
  type PhotoId,
  type ProfileId,
  type UserId,
  castId,
} from '@been-there/core';
import type { BlockRecord } from '../src/blocks.js';
import { type BlockId, type IdempotencyKey, type LikeId, type PassId, castDatingId } from '../src/ids.js';
import type { LikeLedger, LikeRecord, MatchRecord } from '../src/interaction.js';
import type { DistanceBand } from '../src/location.js';
import type { PassRecord, PassState } from '../src/passes.js';
import { type DatingPreferences, UNSET_PREFERENCES } from '../src/preferences.js';
import type { GenderIdentity, ProfileSnapshot, ProfileState } from '../src/profile.js';
import {
  STANDING_PROJECTION_VERSION,
  type AccountStandingProjection,
  type IdentityStandingProjection,
  type RelationshipProjection,
  type SubjectStandingProjection,
  relationshipView,
} from '../src/read-models.js';

export const A: UserId = castId<'UserId'>('user-a');
export const B: UserId = castId<'UserId'>('user-b');
export const C: UserId = castId<'UserId'>('user-c');

export const likeId = (raw: string): LikeId => castDatingId<'LikeId'>(raw);
export const passId = (raw: string): PassId => castDatingId<'PassId'>(raw);
export const blockId = (raw: string): BlockId => castDatingId<'BlockId'>(raw);
export const key = (raw: string): IdempotencyKey => castDatingId<'IdempotencyKey'>(raw);

export const AT = new Date('2026-01-01T00:00:00Z');
export const LATER = new Date('2026-01-02T00:00:00Z');
export const DAYS = (n: number): Date => new Date(AT.getTime() + n * 86_400_000);

export function like(from: UserId, to: UserId, raw = 'like-1'): LikeRecord {
  return { likeId: likeId(raw), from, to, createdAt: AT, state: 'live', supersededPassId: null };
}

export function pass(
  from: UserId,
  to: UserId,
  raw = 'pass-1',
  createdAt: Date = AT,
  state: PassState = 'live',
): PassRecord {
  return { passId: passId(raw), from, to, createdAt, state };
}

export function block(blocker: UserId, blocked: UserId, raw = 'block-1'): BlockRecord {
  return { blockId: blockId(raw), blocker, blocked, createdAt: AT, active: true };
}

export function matchRecord(overrides: Partial<MatchRecord> = {}): MatchRecord {
  return {
    matchId: castId<'MatchId'>('match:user-a|user-b'),
    participants: [A, B],
    likeIds: [likeId('like-a-b'), likeId('like-b-a')],
    standings: ['active', 'active'],
    createdAt: AT,
    ended: null,
    conversationId: castId<'ConversationId'>('conversation-1'),
    ...overrides,
  };
}

/** The two likes a live match is built from, both already in `matched`. */
export function matchedLedger(entries: readonly LikeRecord[] = [like(A, B, 'like-a-b'), like(B, A, 'like-b-a')]): LikeLedger {
  return { likes: entries.map((entry) => ({ ...entry, state: 'matched' as const })) };
}

export function relationship(overrides: Partial<RelationshipProjection> = {}): RelationshipProjection {
  return relationshipView(
    { blocks: overrides.blocks ?? [] },
    { likes: overrides.likes ?? [], passes: overrides.passes ?? [] },
    { match: overrides.match ?? null },
  );
}

export interface StandingOverrides {
  readonly profileState?: ProfileState;
  readonly age?: number | null;
  readonly genderIdentities?: readonly GenderIdentity[];
  readonly location?: DistanceBand | null;
  readonly identityState?: IdentityState;
  readonly generation?: number;
  readonly accountState?: AccountState;
  readonly capabilities?: readonly string[];
  readonly visibleInProduct?: boolean;
  readonly preferences?: Partial<DatingPreferences>;
}

/** A verified, complete, active standing — the baseline every rule perturbs. */
export function standing(user: UserId, overrides: StandingOverrides = {}): SubjectStandingProjection {
  const profile: ProfileSnapshot = {
    profileId: castId<'ProfileId'>(`profile:${user}`),
    userId: user,
    state: overrides.profileState ?? 'complete',
    age: overrides.age === undefined ? 30 : overrides.age,
    genderIdentities: overrides.genderIdentities ?? ['woman', 'non_binary'],
    location: overrides.location === undefined ? 'lt_5_km' : overrides.location,
  };
  const identity: IdentityStandingProjection = {
    projectionVersion: STANDING_PROJECTION_VERSION,
    state: overrides.identityState ?? 'verified',
    generation: overrides.generation ?? 1,
  };
  const account: AccountStandingProjection = {
    projectionVersion: STANDING_PROJECTION_VERSION,
    state: overrides.accountState ?? 'active',
    capabilities:
      overrides.capabilities ?? (overrides.accountState === 'suspended' ? ['report', 'block'] : ['browse_discovery', 'like', 'send_message']),
    visibleInProduct: overrides.visibleInProduct ?? overrides.accountState !== 'banned',
  };
  const preferences: DatingPreferences = { ...UNSET_PREFERENCES, ...overrides.preferences };
  return { userId: user, profile, identity, account, preferences };
}

export function photo(raw: string): PhotoId {
  return castId<'PhotoId'>(raw);
}
