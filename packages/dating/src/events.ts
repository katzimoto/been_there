import type { ConversationId, DataSensitivity, MatchId, ProfileId, UserId } from '@been-there/core';
import type { BlockRecord } from './blocks.js';
import type { BlockId, IdempotencyKey, LikeId, PassId } from './ids.js';
import type { MatchEndCause } from './interaction.js';
import type { ProfileState } from './profile.js';

/**
 * Event catalogue (issue #4).
 *
 * Every fact that leaves this domain leaves as an event, and every event
 * carries a sensitivity (commitment 7: classified per field, not per table).
 * Nothing here is published with a reason attached to another user's state:
 * a consumer that needs to know "this person is not discoverable" is a
 * platform service reading a projection, not a user-facing surface reading a
 * reason code.
 */

export interface EventDefinition {
  readonly type: string;
  readonly version: number;
  readonly sensitivity: DataSensitivity;
  readonly description: string;
}

export const DATING_EVENT_VERSION = 1;

export interface ProfileStateChangedPayload {
  readonly profileId: ProfileId;
  readonly userId: UserId;
  readonly state: ProfileState;
}

export interface PreferencesUpdatedPayload {
  readonly userId: UserId;
  /**
   * Full preference values, `user` class, owner only. The two gender axes are
   * published separately because they are separately meaningful: an analytics
   * consumer that cannot tell "wants to see" from "open to being matched with"
   * cannot read a pool-size funnel at all.
   */
  readonly ageRange: { readonly min: number; readonly max: number } | null;
  readonly maxDistanceKm: number | null;
  readonly seekingGenders: readonly string[] | null;
  readonly openTo: readonly string[] | null;
  readonly locationPrecision: string | null;
}

export interface LikeRecordedPayload {
  readonly likeId: LikeId;
  readonly from: UserId;
  readonly to: UserId;
}

export interface PassRecordedPayload {
  readonly passId: PassId;
  readonly from: UserId;
  readonly to: UserId;
}

export interface MatchCreatedPayload {
  readonly matchId: MatchId;
  readonly participants: readonly [UserId, UserId];
  readonly likeIds: readonly [LikeId, LikeId];
  readonly conversationId: ConversationId | null;
}

export interface MatchEndedPayload {
  readonly matchId: MatchId;
  readonly reason: MatchEndCause;
  readonly actorId: UserId | 'system';
  readonly endedAt: string;
  /** Retained, not deleted: the right to report outlives the match. */
  readonly conversationRetained: true;
}

/**
 * Published only for an actor-initiated end, so a match closed by a block or a
 * deletion stays distinguishable from one a person chose. The idempotency key
 * travels with it because the command does: it is the token that makes a
 * retried unmatch a no-op rather than a second attempt.
 */
export interface UnmatchPerformedPayload {
  readonly matchId: MatchId;
  readonly actorId: UserId;
  readonly idempotencyKey: IdempotencyKey;
}

export interface BlockChangedPayload {
  readonly blockId: BlockId;
  readonly blocker: UserId;
  readonly blocked: UserId;
  readonly active: boolean;
}

/** `identity_status.changed`, owned by Identity. Declared, never published here. */
export interface IdentityStatusChangedPayload {
  readonly userId: UserId;
  readonly state: string;
  readonly generation: number;
}

/** `account_state.changed`, owned by Moderation. Declared, never published here. */
export interface AccountStateChangedPayload {
  readonly userId: UserId;
  readonly state: string;
  readonly capabilities: readonly string[];
  readonly visibleInProduct: boolean;
}

export type DatingEventType =
  | 'profile.completed'
  | 'profile.state_changed'
  | 'profile.deleted'
  | 'preferences.updated'
  | 'like.recorded'
  | 'like.withdrawn'
  | 'pass.recorded'
  | 'match.created'
  | 'unmatch.performed'
  | 'match.ended'
  | 'block.created'
  | 'block.released';

export type ConsumedEventType = 'identity_status.changed' | 'account_state.changed';

export const DATING_EVENT_CATALOGUE: Readonly<Record<DatingEventType, EventDefinition>> = {
  'profile.completed': {
    type: 'profile.completed',
    version: DATING_EVENT_VERSION,
    sensitivity: 'public',
    description: 'A profile reached `complete` and may now be discovered.',
  },
  'profile.state_changed': {
    type: 'profile.state_changed',
    version: DATING_EVENT_VERSION,
    sensitivity: 'public',
    description:
      'A profile left or entered a visible state (`draft`, `incomplete`, `complete`, `paused`, `hidden`, `deleted`). The same fact `profile.completed` announces for the one transition that matters, published for every transition so a consumer invalidating cached eligibility never has to infer a state it was not told about.',
  },
  'profile.deleted': {
    type: 'profile.deleted',
    version: DATING_EVENT_VERSION,
    sensitivity: 'user',
    description: 'Profile content removed. Interaction history and moderation evidence are retained.',
  },
  'preferences.updated': {
    type: 'preferences.updated',
    version: DATING_EVENT_VERSION,
    sensitivity: 'user',
    description: 'Full preference values changed. Owner only.',
  },
  'like.recorded': {
    type: 'like.recorded',
    version: DATING_EVENT_VERSION,
    sensitivity: 'internal',
    description: 'A directed like exists. Private intent: rendered to the recipient, never to anyone else.',
  },
  'like.withdrawn': {
    type: 'like.withdrawn',
    version: DATING_EVENT_VERSION,
    sensitivity: 'internal',
    description: 'A one-sided like was retracted before it became a match.',
  },
  'pass.recorded': {
    type: 'pass.recorded',
    version: DATING_EVENT_VERSION,
    sensitivity: 'internal',
    description: 'The passer asked not to see the candidate. The most private interaction fact this domain holds.',
  },
  'match.created': {
    type: 'match.created',
    version: DATING_EVENT_VERSION,
    sensitivity: 'internal',
    description: 'Two reciprocal likes produced exactly one match for the pair.',
  },
  'unmatch.performed': {
    type: 'unmatch.performed',
    version: DATING_EVENT_VERSION,
    sensitivity: 'internal',
    description: 'A participant ended the match. The conversation is closed and retained as evidence.',
  },
  'match.ended': {
    type: 'match.ended',
    version: DATING_EVENT_VERSION,
    sensitivity: 'internal',
    description: 'Fact that a match stopped being usable, with the cause. `unmatch.performed` is the actor-initiated case.',
  },
  'block.created': {
    type: 'block.created',
    version: DATING_EVENT_VERSION,
    sensitivity: 'internal',
    description: 'A block exists. The blocked user is never told, and no event names them as the reason.',
  },
  'block.released': {
    type: 'block.released',
    version: DATING_EVENT_VERSION,
    sensitivity: 'internal',
    description: 'A block was released. The record is retained for audit.',
  },
};

/**
 * Events this domain consumes to build its standing projections. The payloads
 * are declared here so the contract is reviewable in one block; the events
 * themselves are published by their owners.
 */
export const CONSUMED_EVENT_CATALOGUE: Readonly<Record<ConsumedEventType, EventDefinition>> = {
  'identity_status.changed': {
    type: 'identity_status.changed',
    version: DATING_EVENT_VERSION,
    sensitivity: 'public',
    description: 'Source of the identity standing projection. Carries a state and a generation, never evidence.',
  },
  'account_state.changed': {
    type: 'account_state.changed',
    version: DATING_EVENT_VERSION,
    sensitivity: 'public',
    description: 'Source of the account standing projection: capabilities and product visibility, never a reason.',
  },
};
