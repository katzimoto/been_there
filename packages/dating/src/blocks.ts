import { type DomainError, type Result, type UserId, domainError, ok } from '@been-there/core';
import type { BlockId } from './ids.js';

/**
 * Blocks (issue #4, #13).
 *
 * A block is a first-class relationship in this domain, not a filter bolted
 * onto discovery. It is stored in one direction and *applied* in both: if A
 * blocks B, then A does not see B in discovery, B does not see A, and B
 * cannot open or continue a conversation with A. Storing one direction and
 * evaluating both is what makes the effect symmetric without duplicating the
 * record.
 *
 * Precedence is absolute and is expressed in the data, not only in prose: a
 * block is evaluated before match state, before like state and before
 * preference compatibility, so a block always wins over an existing match.
 */

export interface BlockRecord {
  readonly blockId: BlockId;
  /** Who pressed the button. Never equal to `blocked`. */
  readonly blocker: UserId;
  readonly blocked: UserId;
  readonly createdAt: Date;
  /** Releasing a block keeps the record for audit; it is not deleted. */
  readonly active: boolean;
}

export type BlockEffect =
  | 'hidden_from_discovery'
  | 'cannot_send_message'
  | 'cannot_like'
  | 'cannot_create_match'
  | 'ends_open_match';

/**
 * Ordered by the layer that must consult it: the block is checked before the
 * relationship, and the relationship before preferences.
 */
export const BLOCK_EFFECTS: readonly BlockEffect[] = [
  'hidden_from_discovery',
  'cannot_send_message',
  'cannot_like',
  'cannot_create_match',
  'ends_open_match',
];

export function createBlock(
  blocker: UserId,
  blocked: UserId,
  blockId: BlockId,
  at: Date,
): Result<BlockRecord, DomainError> {
  if (blocker === blocked) {
    return domainError('validation_failed', 'dating.block', 'a user cannot block themselves');
  }
  return ok({ blockId, blocker, blocked, createdAt: at, active: true });
}

/** Idempotent: releasing an already-released block is not an error. */
export function releaseBlock(block: BlockRecord): BlockRecord {
  return block.active ? { ...block, active: false } : block;
}

/** The active block between the pair, in either direction, or `null`. */
export function activeBlockBetween(
  a: UserId,
  b: UserId,
  blocks: readonly BlockRecord[],
): BlockRecord | null {
  for (const block of blocks) {
    if (!block.active || a === b) {
      continue;
    }
    const touchesPair =
      (block.blocker === a && block.blocked === b) || (block.blocker === b && block.blocked === a);
    if (touchesPair) {
      return block;
    }
  }
  return null;
}

export type ContactPermission =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: 'blocked' | 'no_match' };

/**
 * Whether B may message A. Consumed by Communication through a projection, not
 * by calling into this module at send time. The block check comes first and is
 * unconditional: a live match never survives an active block.
 */
export function contactPermission(
  block: BlockRecord | null,
  matchIsActive: boolean,
): ContactPermission {
  if (block !== null && block.active) {
    return { allowed: false, reason: 'blocked' };
  }
  return matchIsActive ? { allowed: true } : { allowed: false, reason: 'no_match' };
}
