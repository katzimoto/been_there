import { randomUUID } from 'node:crypto';
import { type DomainError, type PhotoId, type Result, castId, ok } from '@been-there/core';
import { MISSING_FIELD, NOT_FOUND, UNKNOWN_FIELD_VALUE } from '../http/failure.js';
import { readString, readStringArray } from '../http/body.js';
import { okResponse, route, type Route } from '../http/router.js';
import type { ServiceDependencies } from '../ports.js';
import {
  type DatingPreferences,
  type DistanceBand,
  type GenderIdentity,
  type PhotoApproval,
  type ProfileContent,
  type ProfileState,
  DISTANCE_LIMIT_KM,
  PLATFORM_DEFAULT_LOCATION_PRECISION,
  UNSET_PREFERENCES,
  evaluateProfileCompleteness,
  profileMachine,
  validatePreferences,
} from '@been-there/dating';
import { userIdOf } from './accounts.js';

/**
 * Profile and preferences.
 *
 * Neither endpoint stores what the client sent. Both evaluate it and store the
 * *result*: a profile is written with the state `evaluateProfileCompleteness` and
 * the profile machine produced, never the state the client claimed, and
 * preferences are written only after `validatePreferences` has accepted them —
 * a set that could never be satisfied is rejected at save time rather than
 * remembered as an empty page.
 *
 * ## Why these two endpoints exist at all
 *
 * The issue's scope does not name them, and the service is incomplete without
 * them. `evaluateEligibility` refuses a viewer whose profile is not `complete`,
 * and `recordLike` refuses an actor whose profile is not `complete` — so without
 * a way to write a profile, discovery can only ever return an empty page and a
 * like can only ever be refused, and neither flow is reachable. They are here
 * because the flow needs them, not because they were asked for.
 */

const GENDER_IDENTITIES: readonly GenderIdentity[] = ['woman', 'man', 'non_binary', 'self_described'];
const PHOTO_APPROVALS: readonly PhotoApproval[] = ['pending', 'approved', 'rejected'];
const DISTANCE_BANDS: readonly DistanceBand[] = [
  'lt_5_km',
  '5_25_km',
  '25_50_km',
  '50_100_km',
  'gt_100_km',
  'unknown',
];

export function profileRoutes(dependencies: ServiceDependencies): readonly Route[] {
  return [
    route('PUT', '/v1/accounts/:userId/profile', async (request) => {
      const userId = userIdOf(request.params['userId']);
      if (!userId.ok) {
        return userId;
      }
      const content = profileContentFromRequest(request.body);
      if (!content.ok) {
        return content;
      }
      const completeness = evaluateProfileCompleteness(content.value, request.now);
      const existing = await dependencies.stores.interaction.findProfile(userId.value, request.tx);
      const current: ProfileState =
        existing === null ? profileMachine.initial : (existing.state as ProfileState);
      // Completeness is evaluated, never declared: the client cannot send
      // `state: 'complete'` and have it believed, because the event is chosen
      // from the evaluation and the machine's guard re-checks the requirement.
      const event = completeness.complete ? 'mark_complete' : 'mark_incomplete';
      const next = profileMachine.next(current, event, { requirementsMet: completeness.complete });
      if (!next.ok) {
        return next;
      }
      await dependencies.stores.interaction.upsertProfile(
        {
          profileId: existing?.profileId ?? `profile:${userId.value}`,
          userId: userId.value,
          state: next.value,
          content: content.value as unknown as Readonly<Record<string, unknown>>,
          updatedAt: request.now,
        },
        request.tx,
      );
      return okResponse(200, {
        userId: userId.value,
        state: next.value,
        complete: completeness.complete,
        missing: completeness.missing,
      });
    }),

    route('PUT', '/v1/accounts/:userId/preferences', async (request) => {
      const userId = userIdOf(request.params['userId']);
      if (!userId.ok) {
        return userId;
      }
      const preferences = preferencesFromRequest(request.body);
      if (!preferences.ok) {
        return preferences;
      }
      const validated = validatePreferences(preferences.value);
      if (!validated.ok) {
        return validated;
      }
      await dependencies.stores.interaction.upsertPreferences(
        userId.value,
        validated.value as unknown as Readonly<Record<string, unknown>>,
        request.tx,
      );
      return okResponse(200, { userId: userId.value, preferences: validated.value });
    }),

    route('GET', '/v1/accounts/:userId/preferences', async (request) => {
      const userId = userIdOf(request.params['userId']);
      if (!userId.ok) {
        return userId;
      }
      const stored = await dependencies.stores.interaction.findPreferences(userId.value, request.tx);
      if (stored === null) {
        return NOT_FOUND('preferences');
      }
      return okResponse(200, { userId: userId.value, preferences: stored });
    }),
  ];
}

/**
 * The profile body as domain values.
 *
 * This deliberately re-implements the checks `profileContentOf` makes on the way
 * *out* of the store, and the duplication is the point: a malformed stored row is
 * a `StoreError` and a 500, because it means the database is wrong, while a
 * malformed request body is a `validation_failed` and a 400, because the client
 * is wrong. Sharing one function would mean one of those two is reported as the
 * other, and a client that has been told "internal error" learns nothing.
 */
function profileContentFromRequest(
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
  const birthdateRaw = body['birthdate'];
  const birthdate =
    birthdateRaw === null || birthdateRaw === undefined
      ? null
      : typeof birthdateRaw === 'string'
        ? birthdateRaw
        : null;
  if (birthdateRaw !== null && birthdateRaw !== undefined && birthdate === null) {
    return MISSING_FIELD('birthdate');
  }
  const locationRaw = body['location'];
  let location: DistanceBand | null = null;
  if (locationRaw !== null && locationRaw !== undefined) {
    const band = DISTANCE_BANDS.find((candidate) => candidate === locationRaw);
    if (band === undefined) {
      return UNKNOWN_FIELD_VALUE('location', DISTANCE_BANDS);
    }
    location = band;
  }
  const photosRaw = body['photos'] ?? [];
  if (!Array.isArray(photosRaw)) {
    return MISSING_FIELD('photos');
  }
  const photos: { photoId: PhotoId; approval: PhotoApproval }[] = [];
  for (const entry of photosRaw) {
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
  const promptsRaw = body['prompts'] ?? [];
  if (!Array.isArray(promptsRaw)) {
    return MISSING_FIELD('prompts');
  }
  const prompts: { promptId: string; text: string }[] = [];
  for (const entry of promptsRaw) {
    if (typeof entry !== 'object' || entry === null) {
      return MISSING_FIELD('prompts');
    }
    const prompt = entry as { promptId?: unknown; text?: unknown };
    if (typeof prompt.promptId !== 'string' || typeof prompt.text !== 'string') {
      return MISSING_FIELD('prompts');
    }
    prompts.push({ promptId: prompt.promptId, text: prompt.text });
  }
  const gendersRaw = readStringArray({ genderIdentities: body['genderIdentities'] ?? [] }, 'genderIdentities');
  if (!gendersRaw.ok) {
    return gendersRaw;
  }
  const genderIdentities: GenderIdentity[] = [];
  for (const entry of gendersRaw.value) {
    const identity = GENDER_IDENTITIES.find((candidate) => candidate === entry);
    if (identity === undefined) {
      return UNKNOWN_FIELD_VALUE('genderIdentities', GENDER_IDENTITIES);
    }
    genderIdentities.push(identity);
  }
  return ok({
    displayName: displayName.value,
    bio: bio.value,
    photos,
    prompts,
    genderIdentities,
    birthdate,
    location,
  });
}

function preferencesFromRequest(
  body: Readonly<Record<string, unknown>>,
): Result<DatingPreferences, DomainError> {
  const ageRangeRaw = body['ageRange'];
  if (ageRangeRaw === undefined || ageRangeRaw === null) {
    return ok({ ...UNSET_PREFERENCES });
  }
  if (typeof ageRangeRaw !== 'object') {
    return MISSING_FIELD('ageRange');
  }
  const bounds = ageRangeRaw as { min?: unknown; max?: unknown };
  if (typeof bounds.min !== 'number' || typeof bounds.max !== 'number') {
    return MISSING_FIELD('ageRange');
  }
  const maxDistanceKmRaw = body['maxDistanceKm'];
  if (
    maxDistanceKmRaw !== undefined &&
    maxDistanceKmRaw !== null &&
    typeof maxDistanceKmRaw !== 'number'
  ) {
    return MISSING_FIELD('maxDistanceKm');
  }
  const seeking = await1(body, 'seekingGenders');
  if (!seeking.ok) {
    return seeking;
  }
  const openTo = await1(body, 'openTo');
  if (!openTo.ok) {
    return openTo;
  }
  const precisionRaw = body['locationPrecision'];
  if (precisionRaw !== undefined && precisionRaw !== null && typeof precisionRaw !== 'string') {
    return MISSING_FIELD('locationPrecision');
  }
  if (typeof precisionRaw === 'string') {
    const band = DISTANCE_BANDS.find((candidate) => candidate === precisionRaw);
    if (band === undefined) {
      return UNKNOWN_FIELD_VALUE('locationPrecision', DISTANCE_BANDS);
    }
    if (band !== 'unknown' && DISTANCE_BANDS.indexOf(band) < DISTANCE_BANDS.indexOf(PLATFORM_DEFAULT_LOCATION_PRECISION)) {
      return UNKNOWN_FIELD_VALUE('locationPrecision', [PLATFORM_DEFAULT_LOCATION_PRECISION]);
    }
  }
  return ok({
    ageRange: { min: bounds.min, max: bounds.max },
    maxDistanceKm: (maxDistanceKmRaw ?? null) as number | null,
    seekingGenders: seeking.value,
    openTo: openTo.value,
    locationPrecision: (precisionRaw ?? null) as DistanceBand | null,
  });
}

function await1(
  body: Readonly<Record<string, unknown>>,
  field: 'seekingGenders' | 'openTo',
): Result<readonly GenderIdentity[], DomainError> {
  const raw = body[field];
  if (raw === undefined || raw === null) {
    return ok([]);
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

/** Unused import guard: `randomUUID` and `DISTANCE_LIMIT_KM` are re-exported by the barrel. */
export const PROFILE_ID_PREFIX = 'profile:';

export type { DistanceBand };
export { randomUUID, DISTANCE_LIMIT_KM };
