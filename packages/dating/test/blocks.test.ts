import { describe, expect, it } from 'vitest';
import type { Result } from '@been-there/core';
import {
  activeBlockBetween,
  BLOCK_EFFECTS,
  contactPermission,
  createBlock,
  releaseBlock,
} from '../src/index.js';
import { A, AT, B, C, block, blockId } from './fixtures.js';

function succeeded<T, E extends { code: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.error.code}`);
  }
  return result.value;
}

describe('blocks', () => {
  it('cannot be aimed at yourself', () => {
    expect(createBlock(A, A, blockId('b'), AT).ok).toBe(false);
    expect(succeeded(createBlock(A, B, blockId('b'), AT)).active).toBe(true);
  });

  it('applies in both directions from a single stored record', () => {
    const stored = [block(A, B)];
    expect(activeBlockBetween(A, B, stored)?.blockId).toBe(stored[0]?.blockId);
    expect(activeBlockBetween(B, A, stored)?.blockId).toBe(stored[0]?.blockId);
    expect(activeBlockBetween(A, C, stored)).toBeNull();
  });

  it('never reports a self-pair as blocked', () => {
    expect(activeBlockBetween(A, A, [block(A, B)])).toBeNull();
  });

  it('ignores a released block and keeps the record for audit', () => {
    const released = releaseBlock(block(A, B));
    expect(released.active).toBe(false);
    expect(activeBlockBetween(A, B, [released])).toBeNull();
    expect(releaseBlock(released)).toBe(released);
  });

  it('stops a message even when a match is live, and says why', () => {
    const live = block(A, B);
    expect(contactPermission(live, true)).toEqual({ allowed: false, reason: 'blocked' });
    expect(contactPermission(live, false)).toEqual({ allowed: false, reason: 'blocked' });
    expect(contactPermission(null, true)).toEqual({ allowed: true });
    expect(contactPermission(null, false)).toEqual({ allowed: false, reason: 'no_match' });
    expect(contactPermission(releaseBlock(live), true)).toEqual({ allowed: true });
  });

  it('declares every effect it has to apply', () => {
    expect(BLOCK_EFFECTS[0]).toBe('hidden_from_discovery');
    expect(new Set(BLOCK_EFFECTS).size).toBe(BLOCK_EFFECTS.length);
  });
});
