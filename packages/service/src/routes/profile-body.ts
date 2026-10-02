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
  type PromptAnswer,
  DISTANCE_LIMIT_KM,
  PLATFORM_DEFAULT_LOCATION_PRECISION,
  validatePreferences,
} from '@been-there/dating';
import { readOptionalString, readString, readStringArray } from '../http/body.js';
import { MISSING_FIELD, NOT_FOUND, UNKNOWN_FIELD_VALUE } from '../http/failure.js';
import type { RouteRequest } from '../http/router.js';
import type { ServiceDependencies } from '../ports.js';
import { userIdOf } from './accounts.js';

const GENDER_IDENTITIES: readonly GenderIdentity[] = ['woman', 'man', 'non_binary', 'self_described'];

const DISTANCE_BANDS: readonly DistanceBand[] = [
  'lt_5_km',
  '5_25_km',
  '25_50_km',
  '50_100_km',
  'gt_100_km',
  'unknown',
];

const PHOTO_APPROVALS: readonly ('pending' | 'approved' | 'rejected')[] = [
  'pending',
  'approved',
  'rejected',
];

/**
 * The account named in the path, checked against the session.
 *
 * `not_found` rather than `permission_denied`, because the answer must not
 * distinguish "no such account" from "an account that is not yours": a 403 here
 * would confirm the id belongs to somebody, which is exactly the probe a caller
 * guessing ids is making.
 */
export function claimedOwner(request: RouteRequest): Result<UserId, DomainError> {
  const claimed = userIdOf(request.params['userId']);
  if (!claimed.ok) {
    return claimed;
  }
  const actor = request.actor.userId;
  if (actor === null || actor !== claimed.value) {
    return NOT_FOUND('account');
  }
  return claimed;
}

/**
 * The editable profile fields.
 *
 * `photos` is absent by construction — it comes from the photo table — and so is
 * `state`. The birthdate is read from the account rather than taken from the
 * body: the profile spec makes `dateOfBirth` an account field that no profile
 * API exposes, and a body that could name its own age would let an account
 * re-answer the 18+ gate by editing a profile.
 */
export async function profileFieldsFrom(
  dependencies: ServiceDependencies,
  userId: UserId,
  request: RouteRequest,
): Promise<Result<Readonly<Partial<ProfileContent>>, DomainError>> {
  const displayName = readOptionalString(request.body, 'displayName');
  if (!displayName.ok) {
    return displayName;
  }
  const bio = readOptionalString(request.body, 'bio');
  if (!bio.ok) {
    return bio;
  }
  const genders = readStringArray(request.body, 'genderIdentities');
  if (!genders.ok) {
    return genders;
  }
  const genderIdentities: GenderIdentity[] = [];
  for (const entry of genders.value) {
    const identity = GENDER_IDENTITIES.find((candidate) => candidate === entry);
    if (identity === undefined) {
      return UNKNOWN_FIELD_VALUE('genderIdentities', GENDER_IDENTITIES);
    }
    genderIdentities.push(identity);
  }
  const prompts = promptAnswersFrom(request.body);
  if (!prompts.ok) {
    return prompts;
  }
  const band = request.body['location'];
  let location: DistanceBand | null = null;
  if (band !== null && band !== undefined) {
    const found = DISTANCE_BANDS.find((candidate) => candidate === band);
    if (found === undefined) {
      return UNKNOWN_FIELD_VALUE('location', DISTANCE_BANDS);
    }
    location = found;
  }
  const onboarding = await dependencies.stores.accounts.findOnboarding(userId, request.tx);
  return ok({
    ...(displayName.value === null ? {} : { displayName: displayName.value }),
    ...(bio.value === null ? {} : { bio: bio.value }),
    genderIdentities,
    prompts: prompts.value,
    location,
    birthdate: onboarding?.dateOfBirth ?? null,
  });
}

/**
 * The legacy shape's content reader.
 *
 * This deliberately re-implements the checks `profileContentOf` makes on the way
 * *out* of the store, and the duplication is the point: a malformed stored row
 * is a `StoreError` and a 500, because it means the database is wrong, while a
 * malformed request body is a `validation_failed` and a 400, because the client
 * is wrong. One shared function would mean one of those is reported as the
 * other, and a client told "internal error" learns nothing.
 */
export function profileContentFromRequest(
  body: Readonly<Record<string, unknown>>,
): Result<ProfileContent, DomainError> {
  const displayName = readString(body, 'displayName');
  if (!displayName.ok) {
    return displayName;
  }
  const bio = readString(body, 'bio');
  if (!bio.ok) {
    return bio;
  }
  const birthdate = readOptionalString(body, 'birthdate');
  if (!birthdate.ok) {
    return birthdate;
  }
  const bandRaw = body['location'];
  let location: DistanceBand | null = null;
  if (bandRaw !== null && bandRaw !== undefined) {
    const band = DISTANCE_BANDS.find((candidate) => candidate === bandRaw);
    if (band === undefined) {
      return UNKNOWN_FIELD_VALUE('location', DISTANCE_BANDS);
    }
    location = band;
  }
  const photos = photoListFrom(body);
  if (!photos.ok) {
    return photos;
  }
  const prompts = promptAnswersFrom(body);
  if (!prompts.ok) {
    return prompts;
  }
  const genders = readStringArray(body, 'genderIdentities');
  if (!genders.ok) {
    return genders;
  }
  const genderIdentities: GenderIdentity[] = [];
  for (const entry of genders.value) {
    const identity = GENDER_IDENTITIES.find((candidate) => candidate === entry);
    if (identity === undefined) {
      return UNKNOWN_FIELD_VALUE('genderIdentities', GENDER_IDENTITIES);
    }
    genderIdentities.push(identity);
  }
  return ok({
    displayName: displayName.value,
    bio: bio.value,
    photos: photos.value,
    prompts: prompts.value,
    genderIdentities,
    birthdate: birthdate.value,
    location,
  });
}

/**
 * The photo list, as the legacy route accepts it.
 *
 * A client asserting `approval: 'approved'` is exactly what the `/me` surface
 * refuses, and it is kept only because the older route is a compatibility
 * surface for clients that predate the photo table. It is the weaker of the two
 * and the migration target is `/me`, where the same assertion is ignored.
 */
export function photoListFrom(
  body: Readonly<Record<string, unknown>>,
): Result<ProfileContent['photos'], DomainError> {
  const raw = body['photos'] ?? [];
  if (!Array.isArray(raw)) {
    return MISSING_FIELD('photos');
  }
  const photos: ProfileContent['photos'][number][] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      return MISSING_FIELD('photos');
    }
    const photo = entry as { photoId?: unknown; approval?: unknown };
    if (typeof photo.photoId !== 'string') {
      return MISSING_FIELD('photos.photoId');
    }
    const approval = PHOTO_APPROVALS.find((candidate) => candidate === photo.approval);
    if (approval === undefined) {
      return UNKNOWN_FIELD_VALUE('photos.approval', PHOTO_APPROVALS);
    }
    photos.push({ photoId: castId<'PhotoId'>(photo.photoId), approval });
  }
  return ok(photos);
}

export function promptAnswersFrom(body: Readonly<Record<string, unknown>>): Result<readonly PromptAnswer[], DomainError> {
  const raw = body['prompts'] ?? [];
  if (!Array.isArray(raw)) {
    return MISSING_FIELD('prompts');
  }
  const answers: PromptAnswer[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      return MISSING_FIELD('prompts');
    }
    const prompt = entry as { promptId?: unknown; text?: unknown };
    if (typeof prompt.promptId !== 'string' || typeof prompt.text !== 'string') {
      return MISSING_FIELD('prompts');
    }
    answers.push({ promptId: prompt.promptId, text: prompt.text });
  }
  return ok(answers);
}

/**
 * Preferences from the body.
 *
 * An absent axis is `null`, and `null` is unbounded — the unset rule the
 * preferences spec is built on. `validatePreferences` has the last word on
 * coherence: it refuses an axis that could never be satisfied (an empty gender
 * list) and a distance limit that is not a band edge, so nothing here has to
 * decide what a coherent preference set is.
 */
export function preferencesFromRequest(body: Readonly<Record<string, unknown>>): Result<DatingPreferences, DomainError> {
  const ageRangeRaw = body['ageRange'];
  let ageRange: DatingPreferences['ageRange'] = null;
  if (ageRangeRaw !== undefined && ageRangeRaw !== null) {
    if (typeof ageRangeRaw !== 'object') {
      return MISSING_FIELD('ageRange');
    }
    const bounds = ageRangeRaw as { min?: unknown; max?: unknown };
    if (typeof bounds.min !== 'number' || typeof bounds.max !== 'number') {
      return MISSING_FIELD('ageRange');
    }
    ageRange = { min: bounds.min, max: bounds.max };
  }
  const maxDistanceKmRaw = body['maxDistanceKm'];
  if (maxDistanceKmRaw !== undefined && maxDistanceKmRaw !== null && typeof maxDistanceKmRaw !== 'number') {
    return MISSING_FIELD('maxDistanceKm');
  }
  const seekingGenders = genderAxis(body, 'seekingGenders');
  if (!seekingGenders.ok) {
    return seekingGenders;
  }
  const openTo = genderAxis(body, 'openTo');
  if (!openTo.ok) {
    return openTo;
  }
  const precisionRaw = body['locationPrecision'];
  let locationPrecision: DistanceBand | null = null;
  if (precisionRaw !== undefined && precisionRaw !== null) {
    const band = DISTANCE_BANDS.find((candidate) => candidate === precisionRaw);
    if (band === undefined) {
      return UNKNOWN_FIELD_VALUE('locationPrecision', DISTANCE_BANDS);
    }
    // Coarsening only, and the floor is the platform's own constant. The domain
    // checks it too; naming the field here means the refusal says which axis
    // was wrong instead of arriving from a function that was never asked about
    // distance. A request to *refine* is refused rather than clamped — a silent
    // clamp would be a privacy setting that looks honoured and is not.
    if (band !== 'unknown' && band < PLATFORM_DEFAULT_LOCATION_PRECISION) {
      return UNKNOWN_FIELD_VALUE('locationPrecision', [PLATFORM_DEFAULT_LOCATION_PRECISION]);
    }
    locationPrecision = band;
  }
  return validatePreferences({
    ageRange,
    maxDistanceKm: (maxDistanceKmRaw ?? null) as number | null,
    seekingGenders: seekingGenders.value,
    openTo: openTo.value,
    locationPrecision,
  });
}

/**
 * One gender axis, absent meaning unbounded.
 *
 * The `null` is preserved rather than defaulted to an empty list: an empty list
 * is "nobody", and a user who has not said anything has not said nobody. That
 * distinction is the whole of the cold-start rule and it survives only if it is
 * not smoothed over here.
 */
export function genderAxis(
  body: Readonly<Record<string, unknown>>,
  field: 'seekingGenders' | 'openTo',
): Result<DatingPreferences['seekingGenders'], DomainError> {
  const raw = body[field];
  if (raw === undefined || raw === null) {
    return ok(null);
  }
  const names = readStringArray(body, field);
  if (!names.ok) {
    return names;
  }
  const identities: GenderIdentity[] = [];
  for (const entry of names.value) {
    const identity = GENDER_IDENTITIES.find((candidate) => candidate === entry);
    if (identity === undefined) {
      return UNKNOWN_FIELD_VALUE(field, GENDER_IDENTITIES);
    }
    identities.push(identity);
  }
  return ok(identities);
}

/** The published band edges, so a refusal can name what was allowed. */
export const ALLOWED_DISTANCE_LIMITS_KM = DISTANCE_LIMIT_KM;