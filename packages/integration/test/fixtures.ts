/**
 * Cross-domain fixtures. This package is the only place permitted to import
 * more than one domain package, because integration is a composition concern
 * rather than a domain one.
 */
import {
  type AccountState,
  type IdentityState,
  type SubjectId,
  type UserId,
  castId,
} from '@been-there/core';
import {
  type AccountStandingProjection,
  type BlockRecord,
  type IdentityStandingProjection,
  type LikeRecord,
  type MatchRecord,
  type PassRecord,
  type RelationshipProjection,
  type SubjectStandingProjection,
  STANDING_PROJECTION_VERSION,
  relationshipView,
} from '@been-there/dating';
import { castDatingId, type BlockId, type IdempotencyKey, type LikeId, type PassId } from '@been-there/dating';
import { UNSET_PREFERENCES, type DatingPreferences } from '@been-there/dating';
import type { GenderIdentity, ProfileSnapshot, ProfileState } from '@been-there/dating';

export const ALICE: UserId = castId<'UserId'>('user-alice');
export const BOB: UserId = castId<'UserId'>('user-bob');

export const aliceSubject: SubjectId = castId<'SubjectId'>('user-alice');
export const bobSubject: SubjectId = castId<'SubjectId'>('user-bob');

export const AT = new Date('2026-03-01T12:00:00Z');
export const LATER = new Date('2026-03-01T12:05:00Z');

export const likeId = (raw: string): LikeId => castDatingId<'LikeId'>(raw);
export const passId = (raw: string): PassId => castDatingId<'PassId'>(raw);
export const blockId = (raw: string): BlockId => castDatingId<'BlockId'>(raw);
export const requestKey = (raw: string): IdempotencyKey => castDatingId<'IdempotencyKey'>(raw);

export function like(from: UserId, to: UserId, raw: string): LikeRecord {
  return { likeId: likeId(raw), from, to, createdAt: AT, state: 'live', supersededPassId: null };
}

export function pass(from: UserId, to: UserId, raw: string, createdAt: Date = AT): PassRecord {
  return { passId: passId(raw), from, to, createdAt, state: 'live' };
}

/** The two likes a live match is built from. */
export function matchLikes(): LikeRecord[] {
  return [
    { ...like(ALICE, BOB, 'like-alice-bob'), state: 'matched' },
    { ...like(BOB, ALICE, 'like-bob-alice'), state: 'matched' },
  ];
}

export function block(blocker: UserId, blocked: UserId, raw: string): BlockRecord {
  return { blockId: blockId(raw), blocker, blocked, createdAt: AT, active: true };
}

export function matchRecord(overrides: Partial<MatchRecord> = {}): MatchRecord {
  return {
    matchId: castId<'MatchId'>('match:user-alice|user-bob'),
    participants: [ALICE, BOB],
    likeIds: [likeId('like-alice-bob'), likeId('like-bob-alice')],
    standings: ['active', 'active'],
    createdAt: AT,
    ended: null,
    conversationId: castId<'ConversationId'>('conversation-1'),
    ...overrides,
  };
}

export function relationship(overrides: Partial<RelationshipProjection> = {}): RelationshipProjection {
  return relationshipView(
    { blocks: overrides.blocks ?? [] },
    { likes: overrides.likes ?? [], passes: overrides.passes ?? [] },
    { match: overrides.match ?? null },
    (user) => standing(user),
  );
}

export interface StandingOverrides {
  readonly profileState?: ProfileState;
  readonly age?: number | null;
  readonly genderIdentities?: readonly GenderIdentity[];
  readonly identityState?: IdentityState;
  readonly accountState?: AccountState;
  readonly capabilities?: readonly string[];
  readonly visibleInProduct?: boolean;
  readonly preferences?: Partial<DatingPreferences>;
}

/** The baseline: verified, complete, active. Every test perturbs one field. */
export function standing(
  user: UserId,
  overrides: StandingOverrides = {},
): SubjectStandingProjection {
  const profile: ProfileSnapshot = {
    profileId: castId<'ProfileId'>(`profile:${user}`),
    userId: user,
    state: overrides.profileState ?? 'complete',
    age: overrides.age === undefined ? 30 : overrides.age,
    genderIdentities: overrides.genderIdentities ?? ['woman'],
    location: 'lt_5_km',
  };
  const identity: IdentityStandingProjection = {
    projectionVersion: STANDING_PROJECTION_VERSION,
    state: overrides.identityState ?? 'verified',
    generation: 1,
  };
  const account: AccountStandingProjection = {
    projectionVersion: STANDING_PROJECTION_VERSION,
    state: overrides.accountState ?? 'active',
    capabilities: overrides.capabilities ?? ['browse_discovery', 'like', 'send_message'],
    visibleInProduct: overrides.visibleInProduct ?? overrides.accountState !== 'banned',
  };
  return {
    userId: user,
    profile,
    identity,
    account,
    preferences: { ...UNSET_PREFERENCES, ...overrides.preferences },
  };
}
