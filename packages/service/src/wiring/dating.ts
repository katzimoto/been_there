import { type UserId, castId, type ConversationId, type MatchId } from '@been-there/core';
import { StoreError, type Stores, type Transaction } from '@been-there/contracts';
import {
  type BlockRecord,
  castDatingId,
  type LikeId,
  type LikeLedger,
  type LikeRecord,
  type LikeState,
  type MatchEndCause,
  type MatchRecord,
  type MatchStanding,
  type PassId,
  type PassRecord,
  type PassState,
  type RelationshipProjection,
  type SubjectStandingProjection,
  relationshipView,
} from '@been-there/dating';

/**
 * Decoding the interaction ledgers.
 *
 * `recordLike`, `recordPass`, `resolveMatch`, `relationshipView` and
 * `evidenceForReport` are all pure functions over records the *caller* supplies.
 * That is the design — it is what lets them be tested with no database — and it
 * puts the burden on the service to read the records faithfully. A decoder that
 * quietly substituted a default would be worse than no decoder at all, because
 * the domain would then decide against a ledger that never existed. So every
 * field is checked, and a row that does not decode is a `StoreError`.
 */

function corrupt(what: string, detail: string): StoreError {
  return new StoreError(`stored ${what} is malformed: ${detail}`, { retryable: false });
}

function text(row: Readonly<Record<string, unknown>>, field: string, what: string): string {
  const value = row[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw corrupt(what, `'${field}' is not a non-empty string`);
  }
  return value;
}

function optionalText(row: Readonly<Record<string, unknown>>, field: string, what: string): string | null {
  const value = row[field];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw corrupt(what, `'${field}' is neither a string nor null`);
  }
  return value;
}

function instant(row: Readonly<Record<string, unknown>>, field: string, what: string): Date {
  const value = row[field];
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw corrupt(what, `'${field}' is not a usable instant`);
    }
    return parsed;
  }
  throw corrupt(what, `'${field}' is not an instant`);
}

const LIKE_STATES: readonly LikeState[] = ['live', 'withdrawn', 'matched'];
const PASS_STATES: readonly PassState[] = ['live', 'superseded'];
const MATCH_STANDINGS: readonly MatchStanding[] = [
  'active',
  'dormant_target_unverified',
  'restricted_by_target',
  'closed_by_target',
  'closed_by_actor',
];
const MATCH_END_CAUSES: readonly MatchEndCause[] = ['unmatched', 'ended_by_block'];

export function likeRecordOf(row: Readonly<Record<string, unknown>>): LikeRecord {
  const state = LIKE_STATES.find((candidate) => candidate === row['state']);
  if (state === undefined) {
    throw corrupt('like', `'${String(row['state'])}' is not a like state`);
  }
  const superseded = row['supersededPassId'];
  if (superseded !== null && superseded !== undefined && typeof superseded !== 'string') {
    throw corrupt('like', 'supersededPassId is neither a string nor null');
  }
  return {
    likeId: castDatingId<'LikeId'>(text(row, 'likeId', 'like')),
    from: castId<'UserId'>(text(row, 'from', 'like')),
    to: castId<'UserId'>(text(row, 'to', 'like')),
    createdAt: instant(row, 'createdAt', 'like'),
    state,
    supersededPassId: superseded === null || superseded === undefined ? null : castDatingId<'PassId'>(superseded),
  };
}

export function passRecordOf(row: Readonly<Record<string, unknown>>): PassRecord {
  const state = PASS_STATES.find((candidate) => candidate === row['state']);
  if (state === undefined) {
    throw corrupt('pass', `'${String(row['state'])}' is not a pass state`);
  }
  return {
    passId: castDatingId<'PassId'>(text(row, 'passId', 'pass')),
    from: castId<'UserId'>(text(row, 'from', 'pass')),
    to: castId<'UserId'>(text(row, 'to', 'pass')),
    createdAt: instant(row, 'createdAt', 'pass'),
    state,
  };
}

export function blockRecordOf(row: Readonly<Record<string, unknown>>): BlockRecord {
  const liftedAt = optionalText(row, 'liftedAt', 'block');
  return {
    blockId: castDatingId<'BlockId'>(text(row, 'blockId', 'block')),
    blocker: castId<'UserId'>(text(row, 'blocker', 'block')),
    blocked: castId<'UserId'>(text(row, 'blocked', 'block')),
    createdAt: instant(row, 'createdAt', 'block'),
    active: liftedAt === null,
  };
}

/**
 * The match record as the domain holds it.
 *
 * Two fields the domain carries have no column, and both are named here rather
 * than papered over:
 *
 *  - `ended.actorId` — `matches` records the *cause* of an end but not who acted,
 *    so the actor is decoded as `system`. That is wrong for an actor-initiated
 *    unmatch and is reported rather than guessed; the column does not exist.
 *  - `ended.idempotencyKey` — the token that makes a retried unmatch replay its
 *    own outcome. It is not stored, so a retry after a restart is decoded as a
 *    fresh command and refused as an invalid transition rather than silently
 *    unmatching twice. The safe direction, and still a gap.
 */
export function matchRecordOf(
  row: Readonly<Record<string, unknown>>,
  conversationId: ConversationId | null,
): MatchRecord {
  const participants = stringPairOf(row, 'participants', 'match');
  const likeIds = stringPairOf(row, 'likeIds', 'match');
  const standings = row['standings'];
  if (!Array.isArray(standings) || standings.length !== 2) {
    throw corrupt('match', '`standings` is not a two-element array');
  }
  const decoded = standings.map((entry) => {
    const standing = MATCH_STANDINGS.find((candidate) => candidate === entry);
    if (standing === undefined) {
      throw corrupt('match', `'${String(entry)}' is not a match standing`);
    }
    return standing;
  });
  const endedAtRaw = row['endedAt'];
  let ended: MatchRecord['ended'] = null;
  if (endedAtRaw !== null && endedAtRaw !== undefined) {
    const cause = MATCH_END_CAUSES.find((candidate) => candidate === row['endedCause']);
    if (cause === undefined) {
      throw corrupt('match', `'${String(row['endedCause'])}' is not a match end cause`);
    }
    ended = {
      cause,
      actorId: 'system',
      at: instant(row, 'endedAt', 'match'),
      idempotencyKey: null,
    };
  }
  const first = castId<'UserId'>(participants[0]);
  const second = castId<'UserId'>(participants[1]);
  return {
    matchId: castId<'MatchId'>(text(row, 'matchId', 'match')),
    participants: [first, second],
    likeIds: [castDatingId<'LikeId'>(likeIds[0]), castDatingId<'LikeId'>(likeIds[1])],
    standings: [decoded[0] as MatchStanding, decoded[1] as MatchStanding],
    createdAt: instant(row, 'createdAt', 'match'),
    ended,
    conversationId,
  };
}

function stringPairOf(
  row: Readonly<Record<string, unknown>>,
  field: string,
  what: string,
): readonly [string, string] {
  const value = row[field];
  if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string' || typeof value[1] !== 'string') {
    throw corrupt(what, `'${field}' is not a two-element array of strings`);
  }
  return [value[0], value[1]];
}

/** The like ledger and pass list for one user, read once per request. */
export interface Ledgers {
  readonly ledger: LikeLedger;
  readonly passes: readonly PassRecord[];
}

export async function ledgersFor(
  stores: Stores,
  userId: UserId,
  tx: Transaction,
): Promise<Ledgers> {
  const [likes, passes] = await Promise.all([
    stores.interaction.findLikesFor(userId, tx),
    stores.interaction.findPassesFor(userId, tx),
  ]);
  return {
    ledger: { likes: likes.map(likeRecordOf) },
    passes: passes.map(passRecordOf),
  };
}

export async function blocksBetween(
  stores: Stores,
  a: UserId,
  b: UserId,
  tx: Transaction,
): Promise<readonly BlockRecord[]> {
  const rows = await stores.interaction.findBlocksBetween(a, b, tx);
  return rows.map(blockRecordOf);
}

/**
 * The pairwise view the eligibility gate consumes, assembled by the domain's own
 * function so a relationship can never be built by two code paths that disagree
 * about the same pair.
 */
export async function relationshipFor(
  stores: Stores,
  viewerId: UserId,
  candidateId: UserId,
  standingOf: (user: UserId) => SubjectStandingProjection | null,
  tx: Transaction,
): Promise<RelationshipProjection> {
  const [ledgers, blocks, matchRow] = await Promise.all([
    ledgersFor(stores, viewerId, tx),
    blocksBetween(stores, viewerId, candidateId, tx),
    stores.interaction.findMatchByPair(viewerId, candidateId, tx),
  ]);
  let match: MatchRecord | null = null;
  if (matchRow !== null) {
    // `findByMatch` is participant-scoped: a match id is `match:{a}|{b}` and is
    // therefore more guessable than a uuid, so the read is scoped to somebody in
    // the pair rather than to "anyone who can construct the id".
    const conversation = await stores.conversations.findByMatch(
      castId<'MatchId'>(text(matchRow, 'matchId', 'match')),
      viewerId,
      tx,
    );
    match = matchRecordOf(
      matchRow,
      conversation === null ? null : conversation.conversationId,
    );
  }
  return relationshipView(
    { blocks },
    { likes: ledgers.ledger.likes, passes: ledgers.passes },
    { match },
    standingOf,
  );
}

