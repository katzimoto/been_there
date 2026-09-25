import type { UserId } from '@been-there/core';

/**
 * The canonical pair key for a set of two users: sorted, so A→B and B→A
 * produce the same string.
 *
 * This is the single definition, in one place, because it is the value three
 * separate unique indexes are built on and because two independent
 * implementations of "sort a pair" is exactly how a database ends up with two
 * rows for one relationship. The application derives the key and the index
 * enforces it; when they disagree the index is what wins, which is why the test
 * suite inserts a pair twice and expects the second to fail.
 */
export function pairKey(a: UserId, b: UserId): string {
  return [a, b].sort().join('|');
}
