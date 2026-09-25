import {
  type AccountState,
  type IdentityState,
  type UserId,
  accountMachine,
  capabilitiesFor,
  castId,
  identityMachine,
  isVisibleInProduct,
  type SubjectId,
} from '@been-there/core';
import type { AccountStandingRow, IdentityRecordRow, ProfileRow, Stores, Transaction } from '@been-there/contracts';
import { StoreError } from '@been-there/contracts';
import { type IdentityStatusProjection, projectIdentityStatus } from '@been-there/identity';
import {
  type AccountStandingProjection,
  type DatingPreferences,
  type DistanceBand,
  type GenderIdentity,
  type ProfileContent,
  type ProfileSnapshot,
  type ProfileState,
  type SubjectStandingProjection,
  STANDING_PROJECTION_VERSION,
  UNSET_PREFERENCES,
  ageFromBirthdate,
  profileMachine,
} from '@been-there/dating';

/**
 * Turning stored rows into the projections the domains read.
 *
 * Every value a domain function is given comes from here, and this file is where
 * a malformed row becomes a loud failure. The rule is absolute: a row that does
 * not decode is a `StoreError`, never a `null`, never a default. A `null` here
 * would be indistinguishable from "this user has no such record", and the second
 * reading is the one that gets shown to a person as an answer.
 */

function corrupt(what: string, detail: string): StoreError {
  return new StoreError(`stored ${what} is malformed: ${detail}`, { retryable: false });
}

/** The identity states the schema's CHECK constraint permits, from the machine. */
const IDENTITY_STATES: readonly IdentityState[] = identityMachine.states;

export function identityStateOf(value: string, userId: UserId): IdentityState {
  const state = IDENTITY_STATES.find((candidate) => candidate === value);
  if (state === undefined) {
    throw corrupt('identity state', `'${value}' is not a state the identity machine declares (user ${userId})`);
  }
  return state;
}

/**
 * The one place an identity state becomes a projection other domains read.
 *
 * The projection is built by the identity package's own constructor from a
 * record rebuilt by its own inverse, so `discoverable` is the kernel's predicate
 * rather than a comparison the service wrote.
 */
export function identityProjectionFor(row: IdentityRecordRow, userId: UserId): IdentityStatusProjection {
  return projectIdentityStatus(
    {
      state: identityStateOf(row.state, userId),
      latestVerificationId: row.latestVerificationId,
      generation: row.generation,
    },
    castId<'SubjectId'>(userId),
    row.updatedAt,
  );
}

const ACCOUNT_STATES: readonly AccountState[] = accountMachine.states;

/**
 * The account machine's own states, and nothing else. A row carrying a state the
 * kernel does not declare is a store/schema disagreement, not user input, and it
 * is reported as one rather than coerced to the nearest legal value.
 */
export function accountStateOf(value: string, userId: UserId): AccountState {
  const state = ACCOUNT_STATES.find((candidate) => candidate === value);
  if (state === undefined) {
    throw corrupt(
      'account standing',
      `'${value}' is not a state the account machine declares (user ${userId})`,
    );
  }
  return state;
}

/**
 * The moderation-owned standing, as the product is allowed to read it.
 *
 * A user with no `account_standing` row is at the account machine's declared
 * initial state. That is not the service deciding anybody is unrestricted: it is
 * the kernel naming what a fresh account is, and the standing is *persisted* the
 * moment anything acts on it — the decision handler writes the row inside the
 * same transaction as the decision, so there is no window in which a sanctioned
 * account reads as `active`.
 */
export function accountProjectionFor(row: AccountStandingRow | null, userId: UserId): AccountStandingProjection {
  if (row === null) {
    return {
      projectionVersion: STANDING_PROJECTION_VERSION,
      state: accountMachine.initial,
      capabilities: capabilitiesFor(accountMachine.initial),
      visibleInProduct: isVisibleInProduct(accountMachine.initial),
    };
  }
  const state = accountStateOf(row.state, userId);
  return {
    projectionVersion: STANDING_PROJECTION_VERSION,
    state,
    capabilities: [...row.capabilities],
    visibleInProduct: row.visibleInProduct,
  };
}

const PROFILE_STATES: readonly ProfileState[] = [
  'draft',
  'incomplete',
  'complete',
  'paused',
  'hidden',
  'deleted',
];

const GENDER_IDENTITIES: readonly GenderIdentity[] = ['woman', 'man', 'non_binary', 'self_described'];

const DISTANCE_BANDS: readonly DistanceBand[] = [
  'lt_5_km',
  '5_25_km',
  '25_50_km',
  '50_100_km',
  'gt_100_km',
  'unknown',
];

/**
 * Decodes the `content` jsonb into a `ProfileContent`.
 *
 * Every field is checked, because every field is one discovery consumes. A
 * profile whose `genderIdentities` is a string rather than a list would be read
 * by the eligibility gate as an empty list and the account would silently vanish
 * from everyone's page — a "no results" bug that looks identical to a genuine
 * one and is reported by nobody.
 */
export function profileContentOf(raw: Readonly<Record<string, unknown>>, userId: UserId): ProfileContent {
  const displayName = raw['displayName'];
  const bio = raw['bio'];
  const birthdate = raw['birthdate'];
  const location = raw['location'];
  if (typeof displayName !== 'string' || typeof bio !== 'string') {
    throw corrupt('profile content', `displayName/bio are not strings (user ${userId})`);
  }
  if (birthdate !== null && typeof birthdate !== 'string') {
    throw corrupt('profile content', `birthdate is neither a string nor null (user ${userId})`);
  }
  if (location !== null && typeof location !== 'string') {
    throw corrupt('profile content', `location is neither a band nor null (user ${userId})`);
  }
  const band = location === null ? null : DISTANCE_BANDS.find((candidate) => candidate === location);
  if (location !== null && band === undefined) {
    throw corrupt('profile content', `'${location}' is not a distance band (user ${userId})`);
  }
  return {
    displayName,
    bio,
    photos: photoListOf(raw['photos'], userId),
    prompts: promptListOf(raw['prompts'], userId),
    genderIdentities: genderListOf(raw['genderIdentities'], userId),
    birthdate,
    location: band ?? null,
  };
}

function photoListOf(raw: unknown, userId: UserId): ProfileContent['photos'] {
  if (!Array.isArray(raw)) {
    throw corrupt('profile content', `photos is not an array (user ${userId})`);
  }
  return raw.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw corrupt('profile content', `a photo entry is not an object (user ${userId})`);
    }
    const photo = entry as { photoId?: unknown; approval?: unknown };
    if (typeof photo.photoId !== 'string') {
      throw corrupt('profile content', `a photo has no id (user ${userId})`);
    }
    if (photo.approval !== 'pending' && photo.approval !== 'approved' && photo.approval !== 'rejected') {
      throw corrupt('profile content', `a photo has approval '${String(photo.approval)}' (user ${userId})`);
    }
    return { photoId: castId<'PhotoId'>(photo.photoId), approval: photo.approval };
  });
}

function promptListOf(raw: unknown, userId: UserId): ProfileContent['prompts'] {
  if (!Array.isArray(raw)) {
    throw corrupt('profile content', `prompts is not an array (user ${userId})`);
  }
  return raw.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw corrupt('profile content', `a prompt entry is not an object (user ${userId})`);
    }
    const prompt = entry as { promptId?: unknown; text?: unknown };
    if (typeof prompt.promptId !== 'string' || typeof prompt.text !== 'string') {
      throw corrupt('profile content', `a prompt is missing promptId or text (user ${userId})`);
    }
    return { promptId: prompt.promptId, text: prompt.text };
  });
}

function genderListOf(raw: unknown, userId: UserId): readonly GenderIdentity[] {
  if (!Array.isArray(raw)) {
    throw corrupt('profile content', `genderIdentities is not an array (user ${userId})`);
  }
  return raw.map((entry) => {
    const identity = GENDER_IDENTITIES.find((candidate) => candidate === entry);
    if (identity === undefined) {
      throw corrupt('profile content', `'${String(entry)}' is not a gender identity (user ${userId})`);
    }
    return identity;
  });
}

export function profileStateOf(value: string, userId: UserId): ProfileState {
  const state = PROFILE_STATES.find((candidate) => candidate === value);
  if (state === undefined) {
    throw corrupt('profile state', `'${value}' is not a profile state (user ${userId})`);
  }
  return state;
}

/**
 * The projection discovery, matching and messaging read. Derived, never stored:
 * the age comes from the birthdate through the domain's own function, so a
 * profile that is not complete simply has no age rather than a stale one.
 */
export function profileSnapshotFor(
  row: ProfileRow,
  content: ProfileContent,
  today: Date,
): ProfileSnapshot {
  return {
    profileId: castId<'ProfileId'>(row.profileId),
    userId: row.userId,
    state: profileStateOf(row.state, row.userId),
    age: ageFromBirthdate(content.birthdate, today),
    genderIdentities: content.genderIdentities,
    location: content.location,
  };
}

const PREFERENCE_KEYS: readonly string[] = [
  'ageRange',
  'maxDistanceKm',
  'seekingGenders',
  'openTo',
  'locationPrecision',
];

/**
 * Preferences decode to `UNSET_PREFERENCES` when absent, never to an empty
 * filter.
 *
 * `null` in the dating domain means *not expressed*, and the domain's own rule is
 * that an unexpressed dimension contributes no constraint. A row that decoded to
 * an empty-but-present preference set would be the opposite — it would exclude
 * every candidate for a user who had expressed nothing, which is the cold-start
 * black hole the preferences module is written to prevent.
 */
export function preferencesOf(
  raw: Readonly<Record<string, unknown>> | null,
  userId: UserId,
): DatingPreferences {
  if (raw === null) {
    return UNSET_PREFERENCES;
  }
  const ageRange = raw['ageRange'];
  const maxDistanceKm = raw['maxDistanceKm'];
  const locationPrecision = raw['locationPrecision'];
  if (ageRange !== null && ageRange !== undefined) {
    if (typeof ageRange !== 'object' || ageRange === null) {
      throw corrupt('preferences', `ageRange is not an object (user ${userId})`);
    }
    const bounds = ageRange as { min?: unknown; max?: unknown };
    if (typeof bounds.min !== 'number' || typeof bounds.max !== 'number') {
      throw corrupt('preferences', `ageRange has non-numeric bounds (user ${userId})`);
    }
  }
  if (maxDistanceKm !== null && maxDistanceKm !== undefined && typeof maxDistanceKm !== 'number') {
    throw corrupt('preferences', `maxDistanceKm is not a number (user ${userId})`);
  }
  for (const key of ['seekingGenders', 'openTo'] as const) {
    const value = raw[key];
    if (value !== null && value !== undefined && !Array.isArray(value)) {
      throw corrupt('preferences', `${key} is neither a list nor null (user ${userId})`);
    }
  }
  if (locationPrecision !== null && locationPrecision !== undefined && typeof locationPrecision !== 'string') {
    throw corrupt('preferences', `locationPrecision is not a string (user ${userId})`);
  }
  for (const key of PREFERENCE_KEYS) {
    if (!(key in raw)) {
      throw corrupt('preferences', `the key '${key}' is absent; a stored preference set is partial (user ${userId})`);
    }
  }
  return {
    ageRange:
      ageRange === null || ageRange === undefined
        ? null
        : { min: (ageRange as { min: number }).min, max: (ageRange as { max: number }).max },
    maxDistanceKm: (maxDistanceKm ?? null) as number | null,
    seekingGenders: (raw['seekingGenders'] ?? null) as DatingPreferences['seekingGenders'],
    openTo: (raw['openTo'] ?? null) as DatingPreferences['openTo'],
    locationPrecision: (locationPrecision ?? null) as DistanceBand | null,
  };
}

/** Everything the eligibility gate and `recordLike` read about one user. */
export interface SubjectStanding {
  readonly standing: SubjectStandingProjection;
  readonly content: ProfileContent;
}

/**
 * Everything eligibility, a like and the send gate read about one user.
 *
 * `null` means **the account does not exist**, and only that. A user with no
 * profile row gets a standing whose profile is at `profileMachine.initial` and
 * whose content is empty, not a `null` — because the two are different facts and
 * collapsing them turns "you have not written a profile yet" into a 404, which
 * tells a caller the person is not on the platform. The domains then answer for
 * themselves: `recordLike` refuses an actor whose profile is not `complete`, and
 * `evaluateEligibility` refuses a viewer whose profile is not `complete`, both
 * with their own code and their own reason.
 */
export async function subjectStandingFor(
  stores: Stores,
  userId: UserId,
  today: Date,
  tx: Transaction,
): Promise<SubjectStanding | null> {
  const [user, identity, account, profile, preferences] = await Promise.all([
    stores.users.find(userId, tx),
    stores.identity.find(userId, tx),
    stores.accountStanding.find(userId, tx),
    stores.interaction.findProfile(userId, tx),
    stores.interaction.findPreferences(userId, tx),
  ]);
  if (user === null) {
    return null;
  }
  const content =
    profile === null ? EMPTY_PROFILE_CONTENT : profileContentOf(profile.content, userId);
  return {
    standing: {
      userId,
      profile:
        profile === null
          ? {
              profileId: castId<'ProfileId'>(`profile:${userId}`),
              userId,
              state: profileMachine.initial,
              age: null,
              genderIdentities: [],
              location: null,
            }
          : profileSnapshotFor(profile, content, today),
      identity: identityProjectionFor(
        identity ?? {
          userId,
          state: identityMachine.initial,
          generation: 1,
          latestVerificationId: null,
          updatedAt: today,
        },
        userId,
      ),
      account: accountProjectionFor(account, userId),
      preferences: preferencesOf(preferences, userId),
    },
    content,
  };
}

const EMPTY_PROFILE_CONTENT: ProfileContent = {
  displayName: '',
  bio: '',
  photos: [],
  prompts: [],
  genderIdentities: [],
  birthdate: null,
  location: null,
};

/** A subject id for a user, for the projections that are keyed by subject. */
export function subjectOf(userId: UserId): SubjectId {
  return castId<'SubjectId'>(userId);
}
