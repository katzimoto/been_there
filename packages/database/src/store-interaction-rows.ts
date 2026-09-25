/**
 * The data layer of `InteractionStore`: the shape of a row as Postgres returns
 * it, the statements the store sends, and the translation back into the
 * camelCase names the dating domain uses.
 *
 * It is here rather than in the store because the SQL is the part worth
 * reading in one sitting. Every statement is parameterised, the three
 * idempotent inserts use `ON CONFLICT DO NOTHING` so a duplicate never poisons
 * the caller's transaction, and the row shapes are declared rather than
 * inferred so a renamed column is a compile error instead of an `undefined`
 * reaching the domain.
 *
 * Nothing here talks to the database on its own; `store-interaction.ts` owns
 * the behaviour and this module owns the vocabulary.
 */
import { optionalDate, optionalString, stringPair } from './store-support.js';

// ---------------------------------------------------------------- row shapes --

export type ProfileDbRow = {
  readonly user_id: string;
  readonly profile_id: string | null;
  readonly state: string;
  readonly content: unknown;
  readonly updated_at: Date;
};
export type LikeDbRow = {
  readonly like_id: string;
  readonly from_user_id: string;
  readonly to_user_id: string;
  readonly created_at: Date;
  readonly state: string;
  readonly superseded_pass_id: string | null;
};
export type PassDbRow = {
  readonly pass_id: string;
  readonly from_user_id: string;
  readonly to_user_id: string;
  readonly created_at: Date;
  readonly state: string;
};
export type BlockDbRow = {
  readonly block_id: string;
  readonly blocker_id: string;
  readonly blocked_id: string;
  readonly created_at: Date;
  readonly lifted_at: Date | null;
};
export type MatchDbRow = {
  readonly match_id: string;
  readonly pair_key: string;
  readonly participants: string[];
  readonly like_ids: string[];
  readonly standings: string[];
  readonly created_at: Date;
  readonly ended_at: Date | null;
  readonly ended_cause: string | null;
};
export type CountRow = { readonly total: string };

/** The `likes` states `isCurrentLike` counts, and so the only ones a read keeps. */
export const CURRENT_LIKE_STATES = "('live', 'matched')";

/** The patch columns, so an unknown key is a fault rather than a dropped write. */
export const PATCH_COLUMNS: Readonly<Record<string, string>> = {
  standings: 'standings',
  endedAt: 'ended_at',
  endedCause: 'ended_cause',
};

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
export const LIVE_PASS_OWNED = `
  SELECT * FROM app.passes
   WHERE from_user_id = $1 AND to_user_id = $2 AND state = 'live' AND created_at <= $3`;

export const INSERT_LIKE = `
  INSERT INTO app.likes (like_id, from_user_id, to_user_id, created_at, state, superseded_pass_id)
  VALUES ($1, $2, $3, $4, 'live', $5)
  ON CONFLICT DO NOTHING
  RETURNING *`;

export const INSERT_PASS = `
  INSERT INTO app.passes (pass_id, from_user_id, to_user_id, created_at, state)
  VALUES ($1, $2, $3, $4, 'live')
  ON CONFLICT DO NOTHING
  RETURNING *`;

export const INSERT_BLOCK = `
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
export const UPSERT_MATCH = `
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
export const SUPERSEDE_PASS_BY_ID = `
  UPDATE app.passes SET state = 'superseded'
   WHERE pass_id = $1 AND state = 'live' AND created_at <= $2
  RETURNING *`;

/** The same move addressed by pair, which is the address the port gives. */
export const SUPERSEDE_PASS_BY_PAIR = `
  UPDATE app.passes SET state = 'superseded'
   WHERE from_user_id = $1 AND to_user_id = $2 AND state = 'live' AND created_at <= $3
  RETURNING *`;

/** Per-key coercion, so a bad value is named against the key the caller wrote. */
export function patchValue(key: string, patch: Readonly<Record<string, unknown>>): unknown {
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

// -------------------------------------------------------------- row to domain --

export function likeView(row: LikeDbRow): Readonly<Record<string, unknown>> {
  return {
    likeId: row.like_id,
    from: row.from_user_id,
    to: row.to_user_id,
    createdAt: row.created_at,
    state: row.state,
    supersededPassId: row.superseded_pass_id,
  };
}

export function passView(row: PassDbRow): Readonly<Record<string, unknown>> {
  return {
    passId: row.pass_id,
    from: row.from_user_id,
    to: row.to_user_id,
    createdAt: row.created_at,
    state: row.state,
  };
}

export function blockView(row: BlockDbRow): Readonly<Record<string, unknown>> {
  return {
    blockId: row.block_id,
    blocker: row.blocker_id,
    blocked: row.blocked_id,
    createdAt: row.created_at,
    liftedAt: row.lifted_at,
    active: row.lifted_at === null,
  };
}

export function matchView(row: MatchDbRow): Readonly<Record<string, unknown>> {
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
