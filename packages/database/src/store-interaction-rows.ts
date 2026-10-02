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
import type { UserId } from '@been-there/core';
import { castId } from '@been-there/core';
import type { ProfilePhotoState } from '@been-there/contracts';
import { StoreError } from '@been-there/contracts';
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

export type ProfilePhotoDbRow = {
  readonly photo_id: string;
  readonly user_id: string;
  readonly media_asset_id: string;
  readonly alt_text: string;
  readonly state: string;
  readonly position: number | null;
  readonly reason_code: string | null;
  readonly created_at: Date;
};

export type LocationAnchorDbRow = {
  readonly user_id: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly sensitivity: string;
  readonly observed_at: Date;
};


/** The `likes` states `isCurrentLike` counts, and so the only ones a read keeps. */
export const CURRENT_LIKE_STATES = "('live', 'matched')";

/**
 * The photo states as a lookup rather than a list, because this is the one read
 * that narrows instead of searching: an unknown state has to be distinguishable
 * from every legal one, and `includes` cannot say which value it did not
 * recognise. No `Map`/`Set` — it is static, string-keyed and built once.
 */
const PHOTO_STATE_BY_VALUE: Readonly<Record<string, ProfilePhotoState>> = {
  initiated: 'initiated',
  scanning: 'scanning',
  needs_human: 'needs_human',
  approved: 'approved',
  rejected: 'rejected',
};

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

export const INSERT_PROFILE_PHOTO = `
  INSERT INTO app.profile_photos
    (photo_id, user_id, media_asset_id, alt_text, state, position, reason_code, created_at, updated_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
  RETURNING *`;

export const FIND_PROFILE_PHOTO = 'SELECT * FROM app.profile_photos WHERE photo_id = $1';

export const FIND_PROFILE_PHOTOS_FOR = `
  SELECT * FROM app.profile_photos WHERE user_id = $1 ORDER BY created_at, photo_id`;

/**
 * The published set, in order. `state = 'approved'` rather than
 * `position IS NOT NULL` because the state is the fact and the position is the
 * order; reading the order off the order column would let a row with a
 * position but no approval be served.
 */
export const PUBLISHED_PROFILE_PHOTOS = `
  SELECT * FROM app.profile_photos
   WHERE user_id = $1 AND state = 'approved'
   ORDER BY position`;

export const APPLY_PHOTO_DECISION = `
  UPDATE app.profile_photos
     SET state = $2, position = $3, reason_code = $4, updated_at = $5
   WHERE photo_id = $1
  RETURNING *`;

export const DELETE_PROFILE_PHOTO = `
  DELETE FROM app.profile_photos WHERE photo_id = $1 AND user_id = $2 RETURNING photo_id`;

/**
 * A reorder, as two statements over the whole set.
 *
 * The offset is the point. Postgres checks a unique index row by row within a
 * statement, so mapping old positions onto new ones directly collides the
 * moment two photos swap: a swap is a permutation, and every permutation has an
 * instant where two rows hold the same number. Adding a large constant pushes
 * every target position clear of the current range for the duration of the
 * write, so the intermediate rows cannot collide with the rows they are
 * replacing; the second statement lands them back where they belong. Both run
 * inside the request's transaction, so the set has no observable half-applied
 * order.
 */
export const REORDER_PROFILE_PHOTOS = `
  UPDATE app.profile_photos p
     SET position = n.new_position + 1000, updated_at = $3
    FROM unnest($2::uuid[], $4::int[]) AS n(photo_id, new_position)
   WHERE p.photo_id = n.photo_id AND p.user_id = $1 AND p.state = 'approved'
  RETURNING p.photo_id`;

export const FINALISE_PROFILE_PHOTO_ORDER = `
  UPDATE app.profile_photos
     SET position = position - 1000
   WHERE user_id = $1 AND state = 'approved' AND position >= 1000
  RETURNING photo_id`;

export const UPSERT_LOCATION_ANCHOR = `
  INSERT INTO app.location_anchors (user_id, latitude, longitude, sensitivity, observed_at)
  VALUES ($1, $2, $3, 'sensitive', $4)
  ON CONFLICT (user_id) DO UPDATE
         SET latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
             sensitivity = 'sensitive', observed_at = EXCLUDED.observed_at
  RETURNING *`;

export const FIND_LOCATION_ANCHOR = 'SELECT * FROM app.location_anchors WHERE user_id = $1';

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

/**
 * The photo row as the port names it.
 *
 * The state is narrowed against the port's own vocabulary rather than cast: a
 * row whose state the media machine cannot produce means the CHECK constraint
 * and the port have disagreed, and reporting that beats handing the route a
 * state it would then write back into the next decision.
 */
export function photoView(row: ProfilePhotoDbRow): {
  readonly photoId: string;
  readonly userId: UserId;
  readonly mediaAssetId: string;
  readonly altText: string;
  readonly state: ProfilePhotoState;
  readonly position: number | null;
  readonly reasonCode: string | null;
  readonly createdAt: Date;
} {
  const state = PHOTO_STATE_BY_VALUE[row.state];
  if (state === undefined) {
    throw new StoreError(`profile_photos.state is '${row.state}' for photo ${row.photo_id}`, {
      retryable: false,
    });
  }
  return {
    photoId: row.photo_id,
    userId: castId<'UserId'>(row.user_id),
    mediaAssetId: row.media_asset_id,
    altText: row.alt_text,
    state,
    position: row.position,
    reasonCode: row.reason_code,
    createdAt: row.created_at,
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
