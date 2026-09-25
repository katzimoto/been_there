import { type DomainError, type Result, domainError, ok } from '@been-there/core';
import { type DistanceBand, DISTANCE_BAND_BOUNDS, isWithinDistanceLimit } from './location.js';
import type { GenderIdentity } from './profile.js';

/**
 * Dating preferences (issue #4, #11).
 *
 * Every expressible axis is nullable, and `null` means *not expressed* — never
 * "no one". A new account with no preferences expressed must still be able to
 * see people and be seen, otherwise the product's cold start is a black hole:
 * the first session would have to be configured before it could do anything,
 * and a half-configured filter would silently exclude the entire population.
 * The rule is therefore asymmetric on purpose: an unexpressed dimension
 * contributes no constraint, and exclusion requires *both* sides to have
 * expressed a constraint on that dimension.
 *
 * Two gender axes, and they are not the same question:
 *
 *  - `seekingGenders` is one-sided. It filters the viewer's own page and nothing
 *    else — "who do I want to see".
 *  - `openTo` is pair-wise. It is half of the mutual test, and it is the only
 *    gender dimension that can end a match — "who am I willing to be matched
 *    with".
 *
 * Collapsing them into one field cannot express a user who wants to *see* women
 * but is not open to being matched with women, and the two are separately
 * actionable in the product: one has a "widen this filter" action and the other
 * does not.
 */

export const PREFERENCE_LIMITS = {
  minAge: 18,
  maxAge: 120,
  /**
   * A narrower window is rejected rather than warned about: a validation
   * failure at save time is cheaper to understand than an empty page later.
   */
  minAgeRangeWidth: 5,
} as const;

/**
 * The only distance limits a preference may name, derived from the bands rather
 * than restated beside them. A limit that is not a band edge cannot be compared
 * against a band, so accepting one would store a number no query can honour.
 */
export const DISTANCE_LIMIT_KM: readonly number[] = Object.values(DISTANCE_BAND_BOUNDS)
  .filter((bounds) => Number.isFinite(bounds.maxKm))
  .map((bounds) => bounds.maxKm);

/**
 * The coarsest bucket the platform presents a location at by default. A viewer
 * may ask for something coarser and may not ask for anything finer: the finest
 * band exists for computing separation, and publishing someone's own location at
 * that resolution is the triangulation risk the banding exists to prevent.
 */
export const PLATFORM_DEFAULT_LOCATION_PRECISION: DistanceBand = '5_25_km';

/** Bands ordered from finest to coarsest, so a precision comparison is an index compare. */
const PRECISION_ORDER: readonly DistanceBand[] = [
  'lt_5_km',
  '5_25_km',
  '25_50_km',
  '50_100_km',
  'gt_100_km',
];

/**
 * The gender identities someone is open to being matched with. A separate name
 * from `seekingGenders` because it is read in a different role and is not
 * interchangeable with it. Modelling attraction as anything other than label
 * matching is unresolved and stays unresolved (see the open questions in
 * docs/architecture/dating-core.md).
 */
export type OrientationGroup = GenderIdentity;

export interface AgeRange {
  readonly min: number;
  readonly max: number;
}

export interface DatingPreferences {
  readonly ageRange: AgeRange | null;
  /** One of `DISTANCE_LIMIT_KM`. */
  readonly maxDistanceKm: number | null;
  /** One-sided: filters this viewer's page. */
  readonly seekingGenders: readonly GenderIdentity[] | null;
  /** Pair-wise: half of the mutual test. */
  readonly openTo: readonly OrientationGroup[] | null;
  /** Coarsest bucket this viewer permits their own location to be shown at. */
  readonly locationPrecision: DistanceBand | null;
}

const KNOWN_GENDER_IDENTITIES: Readonly<Record<GenderIdentity, true>> = {
  woman: true,
  man: true,
  non_binary: true,
  self_described: true,
};

/** The cold-start default: nothing expressed, so nothing excluded. */
export const UNSET_PREFERENCES: DatingPreferences = {
  ageRange: null,
  maxDistanceKm: null,
  seekingGenders: null,
  openTo: null,
  locationPrecision: null,
};

/** Rejects a preference set that could never be satisfied, rather than storing it. */
export function validatePreferences(candidate: DatingPreferences): Result<DatingPreferences, DomainError> {
  const { ageRange, maxDistanceKm, seekingGenders, openTo, locationPrecision } = candidate;
  if (ageRange !== null) {
    if (
      !Number.isInteger(ageRange.min) ||
      !Number.isInteger(ageRange.max) ||
      ageRange.min < PREFERENCE_LIMITS.minAge ||
      ageRange.max > PREFERENCE_LIMITS.maxAge ||
      ageRange.min > ageRange.max ||
      ageRange.max - ageRange.min < PREFERENCE_LIMITS.minAgeRangeWidth
    ) {
      return domainError('validation_failed', 'dating.preferences', 'age range is out of bounds', {
        min: ageRange.min,
        max: ageRange.max,
      });
    }
  }
  if (maxDistanceKm !== null && !DISTANCE_LIMIT_KM.includes(maxDistanceKm)) {
    return domainError('validation_failed', 'dating.preferences', 'distance limit is not a published bucket edge', {
      maxDistanceKm,
    });
  }
  for (const [field, identities] of [
    ['seekingGenders', seekingGenders],
    ['openTo', openTo],
  ] as const) {
    if (identities === null) {
      continue;
    }
    if (identities.length === 0) {
      return domainError('validation_failed', 'dating.preferences', 'an empty interest list would exclude everyone', {
        field,
      });
    }
    const accepted: Partial<Record<GenderIdentity, true>> = {};
    for (const identity of identities) {
      if (KNOWN_GENDER_IDENTITIES[identity] !== true) {
        return domainError('validation_failed', 'dating.preferences', 'unknown gender identity', {
          field,
          value: identity,
        });
      }
      if (accepted[identity] === true) {
        return domainError('validation_failed', 'dating.preferences', 'duplicate gender identity', {
          field,
          value: identity,
        });
      }
      accepted[identity] = true;
    }
  }
  if (locationPrecision !== null) {
    const requested = PRECISION_ORDER.indexOf(locationPrecision);
    if (
      requested < 0 ||
      requested < PRECISION_ORDER.indexOf(PLATFORM_DEFAULT_LOCATION_PRECISION)
    ) {
      return domainError('validation_failed', 'dating.preferences', 'location precision may only be coarser than the platform default', {
        requested: locationPrecision,
        platformDefault: PLATFORM_DEFAULT_LOCATION_PRECISION,
      });
    }
  }
  return ok(candidate);
}

/**
 * True when every axis that narrows a pool is expressed. Drives the product
 * prompt to finish setting preferences up; it never gates discovery on its own.
 */
export function hasExpressedPreferences(preferences: DatingPreferences): boolean {
  return (
    preferences.ageRange !== null &&
    preferences.maxDistanceKm !== null &&
    preferences.seekingGenders !== null &&
    preferences.openTo !== null
  );
}

export interface CompatibilitySide {
  /** Derived from the birthdate; `null` when unknown. */
  readonly age: number | null;
  readonly genderIdentities: readonly GenderIdentity[];
  readonly preferences: DatingPreferences;
}

export type Incompatibility = 'age' | 'distance' | 'gender';

/** Fixed evaluation order, so the verdict is byte-identical from both sides. */
export const INCOMPATIBILITIES: readonly Incompatibility[] = ['age', 'distance', 'gender'];

export type CompatibilityVerdict =
  | { readonly compatible: true }
  | { readonly compatible: false; readonly excludedBy: readonly Incompatibility[] };

function ageBreaks(viewer: CompatibilitySide, candidate: CompatibilitySide): boolean {
  const viewerRange = viewer.preferences.ageRange;
  const candidateRange = candidate.preferences.ageRange;
  if (viewerRange === null || candidateRange === null) {
    return false;
  }
  if (candidate.age !== null && (candidate.age < viewerRange.min || candidate.age > viewerRange.max)) {
    return true;
  }
  return viewer.age !== null && (viewer.age < candidateRange.min || viewer.age > candidateRange.max);
}

function distanceBreaks(
  viewer: CompatibilitySide,
  candidate: CompatibilitySide,
  distance: DistanceBand | null,
): boolean {
  const viewerMax = viewer.preferences.maxDistanceKm;
  const candidateMax = candidate.preferences.maxDistanceKm;
  if (viewerMax === null || candidateMax === null || distance === null) {
    return false;
  }
  return !isWithinDistanceLimit(distance, viewerMax) || !isWithinDistanceLimit(distance, candidateMax);
}

/**
 * The pair-wise gender test, and the only place `openTo` is read: a match needs
 * both sides to be open to each other, which is a different question from either
 * side's own page filter.
 */
function genderBreaks(viewer: CompatibilitySide, candidate: CompatibilitySide): boolean {
  const viewerOpenTo = viewer.preferences.openTo;
  const candidateOpenTo = candidate.preferences.openTo;
  if (viewerOpenTo === null || candidateOpenTo === null) {
    return false;
  }
  const viewerCoversCandidate = candidate.genderIdentities.some((identity) => viewerOpenTo.includes(identity));
  const candidateCoversViewer = viewer.genderIdentities.some((identity) => candidateOpenTo.includes(identity));
  return !viewerCoversCandidate || !candidateCoversViewer;
}

/**
 * The mutual test both sides evaluate. Pure, and symmetric: the verdict for
 * (A, B) is identical to the verdict for (B, A), including which dimensions
 * are named, so neither party can compute a "compatible" answer the other
 * would contradict. An unexpressed dimension on either side never excludes.
 *
 * An unknown age never excludes: a missing field is not evidence of
 * ineligibility, and a complete profile always carries a derived age, so the
 * unknown case is a projection gap rather than a fact about the person.
 */
export function areMutuallyCompatible(
  viewer: CompatibilitySide,
  candidate: CompatibilitySide,
  distance: DistanceBand | null,
): CompatibilityVerdict {
  const excludedBy = INCOMPATIBILITIES.filter((dimension) => {
    if (dimension === 'age') {
      return ageBreaks(viewer, candidate);
    }
    if (dimension === 'distance') {
      return distanceBreaks(viewer, candidate, distance);
    }
    return genderBreaks(viewer, candidate);
  });
  return excludedBy.length === 0 ? { compatible: true } : { compatible: false, excludedBy };
}
