/**
 * `InteractionStore` against Postgres: profiles, preferences, likes, passes,
 * blocks and matches.
 *
 * Three methods are load-bearing, each for a different reason:
 *
 *  * `appendLike` supersedes the pass it overrides *in the same call*. The
 *    domain decided a like and its supersession are one fact; a store that
 *    made the caller remember a second call would put that fact back in
 *    pieces. The atomicity is the caller's transaction; this method only has
 *    to refuse to be separable.
 *  * `upsertMatch` converges. Two concurrent reciprocal likes collide on
 *    `matches.pair_key`, the loser's `ON CONFLICT DO UPDATE ... RETURNING`
 *    hands back the winner's row, and "exactly one match" is true *after* a
 *    race rather than merely likely.
 *  * `createBlock` is stored one direction and applied in two. `releaseBlock`
 *    is unilateral and sets `lifted_at` rather than deleting, because the
 *    block is evidence of what happened.
 *
 * Every method takes the caller's transaction and issues its statements on the
 * client that transaction already holds, via the one `clientOf` in
 * `./transaction.js`. It never opens a transaction and never touches a pool.
 *
 * `StoreError` means "the answer is unknown"; `InteractionConflictError` means
 * "the answer is no, and here is what already occupies the space". A conflict
 * is a fact the service handles, and it is raised without aborting the
 * caller's transaction, because the inserts below are `ON CONFLICT DO NOTHING`
 * rather than inserts that kill the transaction. A duplicate like therefore
 * never reaches the caller as a 25P02.
 */
import type { PoolClient, QueryResultRow } from 'pg';
import type { MatchId, UserId } from '@been-there/core';
import type { InteractionStore, Page, PageResult, ProfileRow, Transaction } from '@been-there/contracts';
import { StoreError } from '@been-there/contracts';
import { pairKey } from './pair-key.js';
import { clientOf } from './transaction.js';

/**
 * A duplicate the caller must resolve, kept distinct from a fault so a caller
 * can answer "you have already liked them" instead of "something broke".
 *
 * Not a `Result`: the port returns `{ created: boolean }` with no channel for a
 * refusal, and a result type the port does not mention would push the decision
 * into every caller's signature.
 */
export class InteractionConflictError extends StoreError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, { retryable: false, cause: options.cause });
    this.name = 'InteractionConflictError';
  }
}

// ---------------------------------------------------------------- row shapes --

type ProfileDbRow = {
  readonly user_id: string;
  readonly state: string;
  readonly content: unknown;
  readonly updated_at: Date;
};
type LikeDbRow = {
  readonly like_id: string;
  readonly from_user_id: string;
  readonly to_user_id: string;
  readonly created_at: Date;
  readonly state: string;
  readonly superseded_pass_id: string | null;
};
type PassDbRow = {
  readonly pass_id: string;
  readonly from_user_id: string;
  readonly to_user_id: string;
  readonly created_at: Date;
  readonly state: string;
};
type BlockDbRow = {
  readonly block_id: string;
  readonly blocker_id: string;
  readonly blocked_id: string;
  readonly created_at: Date;
  readonly lifted_at: Date | null;
};
type MatchDbRow = {
  readonly match_id: string;
  readonly pair_key: string;
  readonly participants: string[];
  readonly like_ids: string[];
  readonly standings: string[];
  readonly created_at: Date;
  readonly ended_at: Date | null;
  readonly ended_cause: string | null;
};
type CountRow = { readonly total: string };

/** The `likes` states `isCurrentLike` counts, and so the only ones a read keeps. */
const CURRENT_LIKE_STATES = "('live', 'matched')";

// ------------------------------------------------------------------- queries --

/**
 * The one live pass the liker placed over the person they are now liking, and
 * only that one: the counterpart's pass is never theirs to supersede.
 *
 * `created_at <= $3` is the `at` guard, and `supersedePass` applies the same
 * one: an event cannot supersede a pass that had not been recorded yet, so a
 * replayed command carrying an old clock leaves the pass alone instead of
 * overriding something that happened after it.
 */
const LIVE_PASS_OWNED = `
  SELECT * FROM app.passes
   WHERE from_user_id = $1 AND to_user_id = $2 AND state = 'live' AND created_at <= $3`;

const INSERT_LIKE = `
  INSERT INTO app.likes (like_id, from_user_id, to_user_id, created_at, state, superseded_pass_id)
  VALUES ($1, $2, $3, $4, 'live', $5)
  ON CONFLICT DO NOTHING
  RETURNING *`;

const INSERT_PASS = `
  INSERT INTO app.passes (pass_id, from_user_id, to_user_id, created_at, state)
  VALUES ($1, $2, $3, $4, 'live')
  ON CONFLICT DO NOTHING
  RETURNING *`;

const INSERT_BLOCK = `
  INSERT INTO app.blocks (block_id, blocker_id, blocked_id, created_at)
  VALUES ($1, $2, $3, $4)
  ON CONFLICT DO NOTHING
  RETURNING *`;

/**
 * The convergence. The `like_ids` union is the only thing a losing writer adds:
 * its like is a real fact, and the match already on record is the truth about
 * when the match happened, who is in it and whether it has ended. An ended
 * match must not be revived by a like that raced its ending, so `ended_at` and
 * `ended_cause` are left alone rather than overwritten.
 */
const UPSERT_MATCH = `
  INSERT INTO app.matches (match_id, pair_key, participants, like_ids, standings, created_at, ended_at, ended_cause)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  ON CONFLICT (pair_key) DO UPDATE
     SET like_ids = matches.like_ids || (
           SELECT coalesce(array_agg(fresh.like_id), '{}'::uuid[])
             FROM unnest(EXCLUDED.like_ids) AS fresh (like_id)
            WHERE NOT (fresh.like_id = ANY (matches.like_ids))
         )
  RETURNING *`;

/** One direction, `live` only: the only rows a supersession may move. */
const SUPERSEDE_PASS_BY_ID = `
  UPDATE app.passes SET state = 'superseded'
   WHERE pass_id = $1 AND state = 'live' AND created_at <= $2
  RETURNING *`;

/** The same move addressed by pair, which is the address the port gives. */
const SUPERSEDE_PASS_BY_PAIR = `
  UPDATE app.passes SET state = 'superseded'
   WHERE from_user_id = $1 AND to_user_id = $2 AND state = 'live' AND created_at <= $3
  RETURNING *`;

/** The patch columns, so an unknown key is a fault rather than a dropped write. */
const PATCH_COLUMNS: Readonly<Record<string, string>> = {
  standings: 'standings',
  endedAt: 'ended_at',
  endedCause: 'ended_cause',
};

// ------------------------------------------------------------------ plumbing --

/**
 * Sends one statement and turns anything that is not already a `StoreError`
 * into one, so "the query failed" can never look like "no rows".
 *
 * No retry here, deliberately: a serialization failure has already poisoned
 * the caller's transaction, so re-sending the statement would fail for a
 * different reason. Retrying a unit of work belongs to the transaction that
 * owns it, the only layer that knows whether the work so far — the like, the
 * match, the events — may be redone together.
 */
async function query<Row extends QueryResultRow>(
  client: PoolClient,
  text: string,
  values: unknown[],
): Promise<{ rows: Row[]; rowCount: number }> {
  try {
    const result = await client.query<Row>(text, values);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  } catch (error) {
    if (error instanceof StoreError) {
      throw error;
    }
    throw new StoreError(error instanceof Error ? error.message : 'query failed', { cause: error });
  }
}

/** A caller wrote a row the store cannot store. Never swallowed, never defaulted. */
function fault(message: string): StoreError {
  return new StoreError(message, { retryable: false });
}

function requiredString(bag: Readonly<Record<string, unknown>>, key: string, where: string): string {
  const value = bag[key];
  if (typeof value !== 'string' || value === '') {
    throw fault(`${where}: '${key}' must be a non-empty string`);
  }
  return value;
}

function optionalString(bag: Readonly<Record<string, unknown>>, key: string, where: string): string | null {
  const value = bag[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string' || value === '') {
    throw fault(`${where}: '${key}' must be a non-empty string or null`);
  }
  return value;
}

/** A Date from the domain, or a string from an HTTP boundary. Never an epoch. */
function toDate(value: unknown, key: string, where: string): Date {
  const parsed = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  if (parsed === null || Number.isNaN(parsed.getTime())) {
    throw fault(`${where}: '${key}' must be a Date or an ISO-8601 string`);
  }
  return parsed;
}

function requiredDate(bag: Readonly<Record<string, unknown>>, key: string, where: string): Date {
  return toDate(bag[key], key, where);
}

function optionalDate(bag: Readonly<Record<string, unknown>>, key: string, where: string): Date | null {
  const value = bag[key];
  return value === undefined || value === null ? null : toDate(value, key, where);
}

function stringArray(bag: Readonly<Record<string, unknown>>, key: string, where: string): string[] {
  const value = bag[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry === '')) {
    throw fault(`${where}: '${key}' must be an array of non-empty strings`);
  }
  return [...(value as string[])];
}

/** The two-entry arrays the schema CHECKs, as a tuple so no cast is needed. */
function stringPair(bag: Readonly<Record<string, unknown>>, key: string, where: string): [string, string] {
  const entries = stringArray(bag, key, where);
  if (entries.length !== 2) {
    throw fault(`${where}: '${key}' must hold exactly 2 entries, got ${entries.length}`);
  }
  return [entries[0] as string, entries[1] as string];
}

/** A `jsonb` column arrives parsed; a value that is not an object is a broken row. */
function jsonObject(value: unknown, what: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw fault(`${what} is not a jsonb object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function patchValue(key: string, patch: Readonly<Record<string, unknown>>): unknown {
  const where = `updateMatch('${key}')`;
  switch (key) {
    case 'standings':
      return stringPair(patch, key, where);
    case 'endedAt':
      return optionalDate(patch, key, where);
    default:
      return optionalString(patch, key, where);
  }
}

function likeView(row: LikeDbRow): Readonly<Record<string, unknown>> {
  return {
    likeId: row.like_id,
    from: row.from_user_id,
    to: row.to_user_id,
    createdAt: row.created_at,
    state: row.state,
    supersededPassId: row.superseded_pass_id,
  };
}

function passView(row: PassDbRow): Readonly<Record<string, unknown>> {
  return {
    passId: row.pass_id,
    from: row.from_user_id,
    to: row.to_user_id,
    createdAt: row.created_at,
    state: row.state,
  };
}

function blockView(row: BlockDbRow): Readonly<Record<string, unknown>> {
  return {
    blockId: row.block_id,
    blocker: row.blocker_id,
    blocked: row.blocked_id,
    createdAt: row.created_at,
    liftedAt: row.lifted_at,
    active: row.lifted_at === null,
  };
}

function matchView(row: MatchDbRow): Readonly<Record<string, unknown>> {
  return {
    matchId: row.match_id,
    pairKey: row.pair_key,
    participants: row.participants,
    likeIds: row.like_ids,
    standings: row.standings,
    createdAt: row.created_at,
    endedAt: row.ended_at,
    endedCause: row.ended_cause,
  };
}

// --------------------------------------------------------------------- store --

/**
 * The concrete store. It holds no pool and opens no transaction: every
 * statement it issues goes to the connection the caller's transaction already
 * holds, so its writes are in the caller's unit of work and roll back with it.
 */
export class PostgresInteractionStore implements InteractionStore {
  // -------------------------------------------------------------- profiles --

  async upsertProfile(row: ProfileRow, tx: Transaction): Promise<void> {
    const client = clientOf(tx);
    await query<ProfileDbRow>(
      client,
      `INSERT INTO app.profiles (user_id, state, content, updated_at)
            VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (user_id) DO UPDATE
              SET state = EXCLUDED.state, content = EXCLUDED.content, updated_at = EXCLUDED.updated_at`,
      [row.userId, row.state, JSON.stringify(row.content), row.updatedAt],
    );
  }

  async findProfile(userId: UserId, tx: Transaction): Promise<ProfileRow | null> {
    const client = clientOf(tx);
    const found = await query<ProfileDbRow>(client, 'SELECT * FROM app.profiles WHERE user_id = $1', [userId]);
    const row = found.rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      // The schema keys a profile by its user and has no `profile_id` column,
      // so the domain's ProfileId has nowhere to live. Reporting the user id
      // is the honest placeholder until the port and the schema agree.
      profileId: row.user_id,
      userId: row.user_id as UserId,
      state: row.state,
      content: jsonObject(row.content, `profiles.content for user ${row.user_id}`),
      updatedAt: row.updated_at,
    };
  }

  async upsertPreferences(
    userId: UserId,
    preferences: Readonly<Record<string, unknown>>,
    tx: Transaction,
  ): Promise<void> {
    const client = clientOf(tx);
    await query<{ user_id: string }>(
      client,
      `INSERT INTO app.preferences (user_id, value, updated_at)
            VALUES ($1, $2::jsonb, now())
       ON CONFLICT (user_id) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [userId, JSON.stringify(preferences)],
    );
  }

  async findPreferences(userId: UserId, tx: Transaction): Promise<Readonly<Record<string, unknown>> | null> {
    const client = clientOf(tx);
    const found = await query<{ value: unknown }>(client, 'SELECT value FROM app.preferences WHERE user_id = $1', [
      userId,
    ]);
    const row = found.rows[0];
    return row === undefined ? null : jsonObject(row.value, `preferences.value for user ${userId}`);
  }

  // ----------------------------------------------------------------- likes --

  /**
   * The live like ledger for one user, oldest first, then by id so two rows
   * created in the same millisecond still have exactly one order.
   *
   * Both directions come back on purpose: `isMutualLike` needs the counterpart
   * as well as the liker's own row, and a store that pre-filtered would leave
   * the matching flow with nothing to pass. Withdrawn likes are not in the
   * ledger at all, which is what `isCurrentLike` means.
   */
  async findLikesFor(userId: UserId, tx: Transaction): Promise<readonly Readonly<Record<string, unknown>>[]> {
    const client = clientOf(tx);
    const found = await query<LikeDbRow>(
      client,
      `SELECT * FROM app.likes
        WHERE (from_user_id = $1 OR to_user_id = $1) AND state IN ${CURRENT_LIKE_STATES}
        ORDER BY created_at, like_id`,
      [userId],
    );
    return found.rows.map(likeView);
  }

  /**
   * Moves a like to its decided state, and reports whether the like is there
   * and now in that state.
   *
   * Already-in-that-state counts as success, because a retried command has
   * achieved what it asked for and calling that a failure is how a retried
   * request ends up reported as an error the user saw. A withdrawn like is
   * final, so it is never revived by a second decision.
   */
  async updateLike(likeId: string, state: 'matched' | 'withdrawn', tx: Transaction): Promise<boolean> {
    const client = clientOf(tx);
    const moved = await query<LikeDbRow>(
      client,
      `UPDATE app.likes SET state = $2
        WHERE like_id = $1 AND (state IN ${CURRENT_LIKE_STATES} OR state = $2)
        RETURNING *`,
      [likeId, state],
    );
    return moved.rowCount > 0;
  }

  /**
   * Appends a like and supersedes the pass it overrides, in this call.
   *
   * The order is the design. The live pass is *read* first, the like is
   * inserted with `ON CONFLICT DO NOTHING`, and only an insert that actually
   * created a row goes on to move the pass. A replayed like, or one that
   * conflicts with somebody else's live like, therefore leaves the pass exactly
   * as it was — there is no moment in which the pass is gone and the like is
   * not, even if a caller catches the conflict and commits.
   *
   * Idempotence is per *ordered* pair, matching `likes_live_pair`: two people
   * liking each other is two likes, and both are what a match is made of.
   */
  async appendLike(row: Readonly<Record<string, unknown>>, tx: Transaction): Promise<{ readonly created: boolean }> {
    const client = clientOf(tx);
    const likeId = requiredString(row, 'likeId', 'appendLike');
    const from = requiredString(row, 'from', 'appendLike');
    const to = requiredString(row, 'to', 'appendLike');
    const createdAt = requiredDate(row, 'createdAt', 'appendLike');

    const livePass = await query<PassDbRow>(client, LIVE_PASS_OWNED, [from, to, createdAt]);
    const supersededPassId = livePass.rows[0]?.pass_id ?? null;

    const inserted = await query<LikeDbRow>(client, INSERT_LIKE, [likeId, from, to, createdAt, supersededPassId]);
    if (inserted.rowCount === 0) {
      // Either the very same like arriving twice, or a different like for a
      // pair that already has one. The first is a fact; the second is a
      // conflict the caller must see, raised without poisoning the caller's
      // transaction.
      const replay = await query<LikeDbRow>(client, 'SELECT * FROM app.likes WHERE like_id = $1', [likeId]);
      const existing = replay.rows[0];
      if (existing !== undefined) {
        if (existing.from_user_id !== from || existing.to_user_id !== to) {
          throw fault(`appendLike: like ${likeId} already exists for a different pair`);
        }
        return { created: false };
      }
      throw new InteractionConflictError(`a live like already exists from ${from} to ${to}`);
    }
    if (supersededPassId !== null) {
      await query<PassDbRow>(client, SUPERSEDE_PASS_BY_ID, [supersededPassId, createdAt]);
    }
    return { created: true };
  }

  // ---------------------------------------------------------------- passes --

  async appendPass(row: Readonly<Record<string, unknown>>, tx: Transaction): Promise<{ readonly created: boolean }> {
    const client = clientOf(tx);
    const passId = requiredString(row, 'passId', 'appendPass');
    const from = requiredString(row, 'from', 'appendPass');
    const to = requiredString(row, 'to', 'appendPass');
    const createdAt = requiredDate(row, 'createdAt', 'appendPass');

    const inserted = await query<PassDbRow>(client, INSERT_PASS, [passId, from, to, createdAt]);
    if (inserted.rowCount === 0) {
      const replay = await query<PassDbRow>(client, 'SELECT * FROM app.passes WHERE pass_id = $1', [passId]);
      const existing = replay.rows[0];
      if (existing !== undefined) {
        if (existing.from_user_id !== from || existing.to_user_id !== to) {
          throw fault(`appendPass: pass ${passId} already exists for a different pair`);
        }
        return { created: false };
      }
      throw new InteractionConflictError(`a live pass already exists from ${from} to ${to}`);
    }
    return { created: true };
  }

  /**
   * Moves the `(from, to)` pass to `superseded` and reports how many rows
   * moved, so a caller can tell whether anything changed: 1 when a live pass
   * was there, 0 when there was none or it was already superseded. The row is
   * kept — it is the evidence that the pair was passed and later liked.
   */
  async supersedePass(from: UserId, to: UserId, at: Date, tx: Transaction): Promise<number> {
    const client = clientOf(tx);
    const moved = await query<PassDbRow>(client, SUPERSEDE_PASS_BY_PAIR, [from, to, at]);
    return moved.rowCount;
  }

  /**
   * Every pass the user is party to, oldest first, then by id so two rows
   * created in the same millisecond still have exactly one order.
   *
   * Both directions come back on purpose: callers filter by direction
   * themselves — a liker may only supersede their own pass — and a store that
   * pre-filtered would make that check impossible to express. The order is
   * stable because `isPassInEffect` walks the list.
   */
  async findPassesFor(userId: UserId, tx: Transaction): Promise<readonly Readonly<Record<string, unknown>>[]> {
    const client = clientOf(tx);
    const found = await query<PassDbRow>(
      client,
      `SELECT * FROM app.passes WHERE from_user_id = $1 OR to_user_id = $1 ORDER BY created_at, pass_id`,
      [userId],
    );
    return found.rows.map(passView);
  }

  // ---------------------------------------------------------------- blocks --

  async createBlock(row: Readonly<Record<string, unknown>>, tx: Transaction): Promise<{ readonly created: boolean }> {
    const client = clientOf(tx);
    const blockId = requiredString(row, 'blockId', 'createBlock');
    const blocker = requiredString(row, 'blocker', 'createBlock');
    const blocked = requiredString(row, 'blocked', 'createBlock');
    const createdAt = requiredDate(row, 'createdAt', 'createBlock');

    const inserted = await query<BlockDbRow>(client, INSERT_BLOCK, [blockId, blocker, blocked, createdAt]);
    if (inserted.rowCount === 0) {
      const replay = await query<BlockDbRow>(client, 'SELECT * FROM app.blocks WHERE block_id = $1', [blockId]);
      const existing = replay.rows[0];
      if (existing !== undefined) {
        if (existing.blocker_id !== blocker || existing.blocked_id !== blocked) {
          throw fault(`createBlock: block ${blockId} already exists for a different pair`);
        }
        return { created: false };
      }
      throw new InteractionConflictError(
        `a block already exists between ${blocker} and ${blocked}: blocks are stored once per pair`,
      );
    }
    return { created: true };
  }

  /**
   * Lifts one direction of a block and nothing else: the row is updated where
   * `blocker_id` and `blocked_id` are exactly as given, so the blocked party
   * cannot release a block they did not place, and a reverse block is a
   * different row with its own release. `lifted_at` is set and the row stays:
   * the block is what happened between these two people, and a report about
   * the pair months later has to be able to see it.
   */
  async releaseBlock(blocker: UserId, blocked: UserId, at: Date, tx: Transaction): Promise<number> {
    const client = clientOf(tx);
    const lifted = await query<BlockDbRow>(
      client,
      `UPDATE app.blocks SET lifted_at = $3
        WHERE blocker_id = $1 AND blocked_id = $2 AND lifted_at IS NULL
        RETURNING *`,
      [blocker, blocked, at],
    );
    return lifted.rowCount;
  }

  /**
   * Both directions, because a block is applied in two: either party being
   * blocked is the same fact to the reader. One statement over the canonical
   * pair rather than two, so there is no moment in which the answer is half a
   * list.
   */
  async findBlocksBetween(a: UserId, b: UserId, tx: Transaction): Promise<readonly Readonly<Record<string, unknown>>[]> {
    const client = clientOf(tx);
    const found = await query<BlockDbRow>(
      client,
      `SELECT * FROM app.blocks
        WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)
        ORDER BY created_at, block_id`,
      [a, b],
    );
    return found.rows.map(blockView);
  }

  // --------------------------------------------------------------- matches --

  async findMatch(matchId: MatchId, tx: Transaction): Promise<Readonly<Record<string, unknown>> | null> {
    const client = clientOf(tx);
    const found = await query<MatchDbRow>(client, 'SELECT * FROM app.matches WHERE match_id = $1', [matchId]);
    const row = found.rows[0];
    return row === undefined ? null : matchView(row);
  }

  async findMatchByPair(a: UserId, b: UserId, tx: Transaction): Promise<Readonly<Record<string, unknown>> | null> {
    const client = clientOf(tx);
    const found = await query<MatchDbRow>(client, 'SELECT * FROM app.matches WHERE pair_key = $1', [pairKey(a, b)]);
    const row = found.rows[0];
    return row === undefined ? null : matchView(row);
  }

  /**
   * A user's matches, newest first, with a total that does not depend on the
   * page. The count is a second statement rather than a window function
   * because a window returns no rows — and so no total — for a page past the
   * end, which is the one page where a caller needs the total most.
   */
  async findMatchesFor(
    userId: UserId,
    page: Page,
    tx: Transaction,
  ): Promise<PageResult<Readonly<Record<string, unknown>>>> {
    const client = clientOf(tx);
    for (const [value, name] of [
      [page.limit, 'limit'],
      [page.offset, 'offset'],
    ] as const) {
      if (!Number.isInteger(value) || value < 0) {
        throw fault(`findMatchesFor: '${name}' must be a non-negative integer, got ${String(value)}`);
      }
    }
    const counted = await query<CountRow>(
      client,
      'SELECT count(*)::text AS total FROM app.matches WHERE $1 = ANY (participants)',
      [userId],
    );
    const page2 = await query<MatchDbRow>(
      client,
      `SELECT * FROM app.matches
        WHERE $1 = ANY (participants)
        ORDER BY created_at DESC, match_id DESC
        LIMIT $2 OFFSET $3`,
      [userId, page.limit, page.offset],
    );
    return { items: page2.rows.map(matchView), total: Number(counted.rows[0]?.total ?? '0') };
  }

  /**
   * Creates the match for a pair, or converges on the one already there and
   * returns it.
   *
   * The `pair_key` unique index is what makes two concurrent reciprocal likes
   * converge: one writer waits, the other's `ON CONFLICT DO UPDATE` merges the
   * like id and `RETURNING` hands back the row that exists — which may carry
   * the *other* transaction's `match_id`. That is not a defect of this method,
   * it is the answer: there is one match for this pair and this is it.
   */
  async upsertMatch(row: Readonly<Record<string, unknown>>, tx: Transaction): Promise<Readonly<Record<string, unknown>>> {
    const client = clientOf(tx);
    const matchId = requiredString(row, 'matchId', 'upsertMatch');
    const [first, second] = stringPair(row, 'participants', 'upsertMatch');
    if (first > second) {
      throw fault('upsertMatch: participants must be in canonical (sorted) order');
    }
    const likeIds = stringArray(row, 'likeIds', 'upsertMatch');
    const standings = stringPair(row, 'standings', 'upsertMatch');
    const createdAt = requiredDate(row, 'createdAt', 'upsertMatch');
    const endedAt = optionalDate(row, 'endedAt', 'upsertMatch');
    const endedCause = optionalString(row, 'endedCause', 'upsertMatch');

    const stored = await query<MatchDbRow>(client, UPSERT_MATCH, [
      matchId,
      pairKey(first as UserId, second as UserId),
      [first, second],
      likeIds,
      standings,
      createdAt,
      endedAt,
      endedCause,
    ]);
    const storedRow = stored.rows[0];
    if (storedRow === undefined) {
      throw fault('upsertMatch: the insert neither created a match nor returned the existing one');
    }
    return matchView(storedRow);
  }

  /**
   * Patches a match's per-party standings and its shared end state, and
   * reports whether the match is there.
   *
   * `standings` and `endedCause` are not one column because they are not one
   * fact: the cause of an end is the same for both parties and the standing is
   * per party, so a patch sets them separately. An unknown key is a fault, not
   * a no-op — a typo that silently dropped the end of a match is exactly the
   * kind of quiet write this schema exists to prevent.
   */
  async updateMatch(matchId: MatchId, patch: Readonly<Record<string, unknown>>, tx: Transaction): Promise<boolean> {
    const client = clientOf(tx);
    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const key of Object.keys(patch)) {
      const column = PATCH_COLUMNS[key];
      if (column === undefined) {
        throw fault(`updateMatch: unknown patch key '${key}'; expected one of ${Object.keys(PATCH_COLUMNS).join(', ')}`);
      }
      values.push(patchValue(key, patch));
      assignments.push(`${column} = $${values.length}`);
    }
    if (assignments.length === 0) {
      const present = await query<MatchDbRow>(client, 'SELECT * FROM app.matches WHERE match_id = $1', [matchId]);
      return present.rowCount > 0;
    }
    values.push(matchId);
    const patched = await query<MatchDbRow>(
      client,
      `UPDATE app.matches SET ${assignments.join(', ')} WHERE match_id = $${values.length} RETURNING *`,
      values,
    );
    return patched.rowCount > 0;
  }
}
