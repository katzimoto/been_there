import {
  type DomainError,
  type PhotoId,
  type Result,
  type UserId,
  castId,
  domainError,
  ok,
} from '@been-there/core';
import {
  type DatingPreferences,
  type DistanceBand,
  type GenderIdentity,
  type ProfileContent,
  type ProfileState,
  type PromptAnswer,
  DISTANCE_LIMIT_KM,
  PLATFORM_DEFAULT_LOCATION_PRECISION,
  UNSET_PREFERENCES,
  evaluateProfileCompleteness,
  profileMachine,
  validatePreferences,
} from '@been-there/dating';
import { readOptionalString, readString, readStringArray } from '../http/body.js';
import { MISSING_FIELD, NOT_FOUND, UNKNOWN_FIELD_VALUE } from '../http/failure.js';
import { okResponse, route, type Route, type RouteRequest } from '../http/router.js';
import type { ServiceDependencies } from '../ports.js';
import { profileContentOf, profileStateOf } from '../wiring/standing.js';
import { claimedOwner, preferencesFromRequest, profileFieldsFrom } from './profile-body.js';
import { legacyProfileRoutes } from './profile-legacy.js';
import { profilePhotoRoutes } from './profile-photos.js';
import { saveProfile } from './profile-sync.js';

/**
 * Profile and preferences.
 *
 * Two surfaces, and the difference between them is the point of this file.
 *
 * `/v1/profiles/me` addresses the owner through the **session**. There is no
 * identifier in the path, so there is nothing for one member to change in order
 * to reach another's profile, and the question "may this caller write this
 * body?" never has to be answered again on each new route.
 *
 * `/v1/accounts/:userId/profile` and `/v1/accounts/:userId/preferences` are the
 * older shape, kept because existing clients and suites use them. They take the
 * user id from the path, so they must check it against the session — and the
 * check they now carry is the one they were missing. Without it, any
 * authenticated member could write any other member's profile by putting their
 * id in the path, which is not a theoretical hole: it is the difference between
 * "your profile" and "somebody else's profile, chosen by you".
 *
 * ## Completeness is never declared
 *
 * A write stores the *result* of `evaluateProfileCompleteness` and the state
 * `profileMachine` produced from it — see `saveProfile`. A body carrying
 * `state: 'complete'` changes nothing, because the event is chosen from the
 * evaluation and the machine's guard re-checks the requirement. The photo list
 * is the other half: on the `/me` surface it is read from the photo table, so a
 * client cannot assert `approval: 'approved'` for a photo nobody has screened.
 */

const GENDER_IDENTITIES: readonly GenderIdentity[] = ['woman', 'man', 'non_binary', 'self_described'];

const DISTANCE_BANDS: readonly DistanceBand[] = [
  'lt_5_km',
  '5_25_km',
  '25_50_km',
  '50_100_km',
  'gt_100_km',
  'unknown',
];

/** What a profile has before anything has been written to it. */
const EMPTY_CONTENT: ProfileContent = {
  displayName: '',
  bio: '',
  photos: [],
  prompts: [],
  genderIdentities: [],
  birthdate: null,
  location: null,
};

/**
 * The owner behind a session.
 *
 * One refusal for every route here, because "this endpoint needs a member
 * session" is the same fact on all of them, and a per-route wording would make
 * the status a function of which route was hit.
 */
function ownerOf(request: RouteRequest): Result<UserId, DomainError> {
  const userId = request.actor.userId;
  if (userId === null) {
    return domainError('permission_denied', 'service.http', 'this endpoint is for a member session', {
      reason: 'no_member_session',
    });
  }
  return ok(userId);
}

export function profileRoutes(dependencies: ServiceDependencies): readonly Route[] {
  return [
    // ------------------------------------------------------------------ profile --

    route('PUT', '/v1/profiles/me', async (request) => {
      const owner = ownerOf(request);
      if (!owner.ok) {
        return owner;
      }
      const fields = await profileFieldsFrom(dependencies, owner.value, request);
      if (!fields.ok) {
        return fields;
      }
      const saved = await saveProfile(dependencies, owner.value, fields.value, request.now, request.tx);
      if (!saved.ok) {
        return saved;
      }
      return okResponse(200, {
        profileId: saved.value.row.profileId,
        state: saved.value.row.state,
        // A boolean and the unmet rules. There is no score in this response and
        // no field one could be added to: the shape is closed on purpose,
        // because a completeness percentage is a ranking signal wearing a
        // progress bar's clothes.
        complete: saved.value.completeness.complete,
        missing: saved.value.completeness.missing,
      });
    }),

    route('GET', '/v1/profiles/me', async (request) => {
      const owner = ownerOf(request);
      if (!owner.ok) {
        return owner;
      }
      const row = await dependencies.stores.interaction.findProfile(owner.value, request.tx);
      if (row === null) {
        // Not a 404. "You have not written a profile yet" and "that profile does
        // not exist" are different facts, and collapsing them would turn a new
        // member's first screen into a dead end.
        return okResponse(200, {
          profileId: `profile:${owner.value}`,
          state: 'draft',
          complete: false,
          missing: evaluateProfileCompleteness(EMPTY_CONTENT, request.now).missing,
        });
      }
      const content = profileContentOf(row.content, owner.value);
      // Recomputed rather than read off the row. A stored state of `incomplete`
      // says *that* a rule is unmet, never *which*, and answering "which" from
      // anywhere but the domain's own evaluation would be a second completeness
      // rule free to disagree with the first.
      const completeness = evaluateProfileCompleteness(content, request.now);
      return okResponse(200, {
        profileId: row.profileId,
        state: profileStateOf(row.state, owner.value),
        complete: completeness.complete,
        missing: completeness.missing,
      });
    }),

    // -------------------------------------------------------------- preferences --

    route('PUT', '/v1/profiles/me/preferences', async (request) => {
      const owner = ownerOf(request);
      if (!owner.ok) {
        return owner;
      }
      const preferences = preferencesFromRequest(request.body);
      if (!preferences.ok) {
        return preferences;
      }
      await dependencies.stores.interaction.upsertPreferences(
        owner.value,
        preferences.value as unknown as Readonly<Record<string, unknown>>,
        request.tx,
      );
      return okResponse(200, { preferences: preferences.value });
    }),

    route('GET', '/v1/profiles/me/preferences', async (request) => {
      const owner = ownerOf(request);
      if (!owner.ok) {
        return owner;
      }
      const stored = await dependencies.stores.interaction.findPreferences(owner.value, request.tx);
      // Absent is not an empty filter. A user who has expressed nothing is
      // served `UNSET_PREFERENCES`, whose every axis is `null` and therefore
      // unbounded — the distinction the preferences spec's unset rule turns on,
      // and the one a `404` would hide from the very client that needs it.
      return okResponse(200, { preferences: stored ?? UNSET_PREFERENCES });
    }),

    // -------------------------------------------------------------------- photos --

    ...profilePhotoRoutes(dependencies),

    // ------------------------------------------------ the older id-in-path shape --

    ...legacyProfileRoutes(dependencies),
  ];
}
