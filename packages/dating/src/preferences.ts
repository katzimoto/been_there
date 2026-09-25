import { type DomainError, type Result, domainError, ok } from '@been-there/core';
import type { GenderIdentity } from './profile.js';
import { type DistanceBand, isWithinDistanceLimit } from './location.js';

/**
 * Dating preferences (issue #4, #11).
 *
 * Every dimension is nullable, and `null` means *not expressed* — never
 * "no one". A new account with no preferences expressed must still be able to
 * see people and be seen, otherwise the product's cold start is a black hole:
 * the first session would have to be configured before it could do anything,
 * and a half-configured filter would silently exclude the entire population.
 * The rule is therefore asymmetric on purpose: an unexpressed dimension
 * contributes no constraint, and exclusion requires *both* sides to have
 * expressed a constraint on that dimension.
 */

export const PREFERENCE_LIMITS = {
  minAge: 18,
  maxAge: 120,
  minDistanceKm: 1,
  maxDistanceKm: 500,
} as const;

export interface AgeRange {
  readonly min: number;
  readonly max: number;
}

export interface DatingPreferences {
  readonly ageRange: AgeRange | null;
  readonly maxDistanceKm: number | null;
  readonly interestedIn: readonly GenderIdentity[] | null;
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
	interestedIn: null,
};

/** Rejects a preference set that could never be satisfied, rather than storing it. */
export function validatePreferences(candidate: DatingPreferences): Result<DatingPreferences, DomainError> {
  const { ageRange, maxDistanceKm, interestedIn } = candidate;
  if (ageRange !== null) {
    if (
      !Number.isInteger(ageRange.min) ||
      !Number.isInteger(ageRange.max) ||
      ageRange.min < PREFERENCE_LIMITS.minAge ||
      ageRange.max > PREFERENCE_LIMITS.maxAge ||
      ageRange.min > ageRange.max
    ) {
      return domainError('validation_failed', 'dating.preferences', 'age range is out of bounds', {
        min: ageRange.min,
        max: ageRange.max,
      });
    }
  }
  if (maxDistanceKm !== null) {
    if (
      !Number.isFinite(maxDistanceKm) ||
      maxDistanceKm < PREFERENCE_LIMITS.minDistanceKm ||
      maxDistanceKm > PREFERENCE_LIMITS.maxDistanceKm
    ) {
      return domainError('validation_failed', 'dating.preferences', 'distance limit is out of bounds', {
        maxDistanceKm,
      });
    }
  }
  if (interestedIn !== null) {
    if (interestedIn.length === 0) {
      return domainError('validation_failed', 'dating.preferences', 'an empty interest list would exclude everyone');
    }
    const accepted: Partial<Record<GenderIdentity, true>> = {};
    for (const identity of interestedIn) {
      if (KNOWN_GENDER_IDENTITIES[identity] !== true) {
        return domainError('validation_failed', 'dating.preferences', 'unknown gender identity', {
          value: identity,
        });
      }
      if (accepted[identity] === true) {
        return domainError('validation_failed', 'dating.preferences', 'duplicate gender identity', {
          value: identity,
        });
      }
      accepted[identity] = true;
    }
  }
  return ok(candidate);
}

/**
 * True only when every dimension is expressed. Drives the product prompt to
 * finish setting preferences up; it never gates discovery on its own.
 */
export function hasExpressedPreferences(preferences: DatingPreferences): boolean {
  return (
    preferences.ageRange !== null &&
    preferences.maxDistanceKm !== null &&
    preferences.interestedIn !== null
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

function genderBreaks(viewer: CompatibilitySide, candidate: CompatibilitySide): boolean {
  const viewerInterestedIn = viewer.preferences.interestedIn;
  const candidateInterestedIn = candidate.preferences.interestedIn;
  if (viewerInterestedIn === null || candidateInterestedIn === null) {
    return false;
  }
  return !candidate.genderIdentities.some((identity) => viewerInterestedIn.includes(identity));
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
