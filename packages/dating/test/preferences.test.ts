import { describe, expect, it } from 'vitest';
import type { Result } from '@been-there/core';
import {
  type CompatibilitySide,
  DISTANCE_LIMIT_KM,
  PREFERENCE_LIMITS,
  PLATFORM_DEFAULT_LOCATION_PRECISION,
  type DatingPreferences,
  UNSET_PREFERENCES,
  areMutuallyCompatible,
  hasExpressedPreferences,
  validatePreferences,
} from '../src/index.js';

function rejected<T, E extends { code: string }>(result: Result<T, E>): E | undefined {
  return result.ok ? undefined : result.error;
}

function side(overrides: Partial<CompatibilitySide> = {}): CompatibilitySide {
  return {
    age: 30,
    genderIdentities: ['woman'],
    preferences: UNSET_PREFERENCES,
    ...overrides,
  };
}

const withPreferences = (overrides: Partial<DatingPreferences>): DatingPreferences => ({
  ...UNSET_PREFERENCES,
  ...overrides,
});

describe('validatePreferences', () => {
  it('accepts an entirely unset preference set', () => {
    expect(validatePreferences(UNSET_PREFERENCES).ok).toBe(true);
  });

  it('rejects an inverted or out-of-bounds age range', () => {
    expect(rejected(validatePreferences(withPreferences({ ageRange: { min: 50, max: 30 } })))?.code).toBe(
      'validation_failed',
    );
    expect(rejected(validatePreferences(withPreferences({ ageRange: { min: 16, max: 30 } })))?.code).toBe(
      'validation_failed',
    );
    expect(
      rejected(
        validatePreferences(withPreferences({ ageRange: { min: 20, max: PREFERENCE_LIMITS.maxAge + 1 } })),
      )?.code,
    ).toBe('validation_failed');
  });

  it('rejects an age range narrower than the minimum width', () => {
    // The width floor exists so that a save cannot produce a page that is empty
    // for a reason the user was never shown.
    const tooNarrow = withPreferences({ ageRange: { min: 30, max: 30 + PREFERENCE_LIMITS.minAgeRangeWidth - 1 } });
    expect(rejected(validatePreferences(tooNarrow))?.code).toBe('validation_failed');
    const atWidth = withPreferences({ ageRange: { min: 30, max: 30 + PREFERENCE_LIMITS.minAgeRangeWidth } });
    expect(validatePreferences(atWidth).ok).toBe(true);
  });

  it('rejects a fractional age bound', () => {
    expect(rejected(validatePreferences(withPreferences({ ageRange: { min: 20.5, max: 30 } })))?.code).toBe(
      'validation_failed',
    );
  });

  it('accepts only the published bucket edges as a distance limit', () => {
    // A limit that is not a band edge cannot be compared against a band, so it
    // would be stored as a number no query can honour.
    expect(DISTANCE_LIMIT_KM).toEqual([5, 25, 50, 100]);
    for (const edge of DISTANCE_LIMIT_KM) {
      expect(validatePreferences(withPreferences({ maxDistanceKm: edge })).ok).toBe(true);
    }
    for (const free of [0, 7, 15, 499, 1000]) {
      expect(rejected(validatePreferences(withPreferences({ maxDistanceKm: free })))?.code).toBe(
        'validation_failed',
      );
    }
  });

  it('rejects a gender list that is empty, unknown or duplicated, on either axis', () => {
    for (const axis of ['seekingGenders', 'openTo'] as const) {
      expect(rejected(validatePreferences(withPreferences({ [axis]: [] })))?.code).toBe('validation_failed');
      expect(rejected(validatePreferences(withPreferences({ [axis]: ['alien' as never] })))?.code).toBe(
        'validation_failed',
      );
      expect(rejected(validatePreferences(withPreferences({ [axis]: ['woman', 'woman'] })))?.code).toBe(
        'validation_failed',
      );
      expect(validatePreferences(withPreferences({ [axis]: ['woman'] })).ok).toBe(true);
    }
  });

  it('refuses a location precision finer than the platform default', () => {
    expect(validatePreferences(withPreferences({ locationPrecision: null })).ok).toBe(true);
    expect(validatePreferences(withPreferences({ locationPrecision: PLATFORM_DEFAULT_LOCATION_PRECISION })).ok).toBe(
      true,
    );
    expect(validatePreferences(withPreferences({ locationPrecision: 'gt_100_km' })).ok).toBe(true);
    expect(rejected(validatePreferences(withPreferences({ locationPrecision: 'lt_5_km' })))?.code).toBe(
      'validation_failed',
    );
    expect(rejected(validatePreferences(withPreferences({ locationPrecision: 'unknown' as never })))?.code).toBe(
      'validation_failed',
    );
  });

  it('knows when nothing has been expressed', () => {
    expect(hasExpressedPreferences(UNSET_PREFERENCES)).toBe(false);
    expect(hasExpressedPreferences(withPreferences({ maxDistanceKm: 50 }))).toBe(false);
    expect(
      hasExpressedPreferences(
        withPreferences({
          ageRange: { min: 20, max: 40 },
          maxDistanceKm: 50,
          seekingGenders: ['man'],
          openTo: ['woman'],
        }),
      ),
    ).toBe(true);
  });
});

describe('areMutuallyCompatible', () => {
  it('treats an unexpressed dimension as no constraint on either side', () => {
    expect(areMutuallyCompatible(side(), side(), '25_50_km')).toEqual({ compatible: true });
  });

  it('never excludes on a dimension only one side expressed', () => {
    const openToMen = side({ preferences: withPreferences({ openTo: ['man'] }) });
    const woman = side({ genderIdentities: ['woman'] });
    expect(areMutuallyCompatible(openToMen, woman, null)).toEqual({ compatible: true });
    expect(areMutuallyCompatible(woman, openToMen, null)).toEqual({ compatible: true });
  });

  it('excludes on age only when both expressed a range and one is outside it', () => {
    const wantsYoung = side({ preferences: withPreferences({ ageRange: { min: 20, max: 30 } }) });
    const older = side({ age: 45, preferences: withPreferences({ ageRange: { min: 40, max: 60 } }) });
    expect(areMutuallyCompatible(wantsYoung, older, null)).toEqual({
      compatible: false,
      excludedBy: ['age'],
    });
  });

  it('excludes when the candidate is outside the viewer range even if the viewer is inside theirs', () => {
    const viewer = side({ age: 26, preferences: withPreferences({ ageRange: { min: 20, max: 30 } }) });
    const candidate = side({ age: 26, preferences: withPreferences({ ageRange: { min: 40, max: 50 } }) });
    expect(areMutuallyCompatible(viewer, candidate, null)).toEqual({
      compatible: false,
      excludedBy: ['age'],
    });
  });

  it('does not exclude on an unknown age', () => {
    const wantsYoung = side({ preferences: withPreferences({ ageRange: { min: 20, max: 30 } }) });
    expect(areMutuallyCompatible(wantsYoung, side({ age: null }), null)).toEqual({ compatible: true });
  });

  it('excludes on distance only when both expressed a limit that the band fails', () => {
    const nearOnly = side({ preferences: withPreferences({ maxDistanceKm: 5 }) });
    const farOnly = side({ preferences: withPreferences({ maxDistanceKm: 100 }) });
    expect(areMutuallyCompatible(nearOnly, farOnly, '25_50_km')).toEqual({
      compatible: false,
      excludedBy: ['distance'],
    });
    expect(areMutuallyCompatible(nearOnly, farOnly, 'lt_5_km')).toEqual({ compatible: true });
  });

  it('does not exclude on an unresolvable distance', () => {
    const nearOnly = side({ preferences: withPreferences({ maxDistanceKm: 5 }) });
    expect(areMutuallyCompatible(nearOnly, side(), 'unknown')).toEqual({ compatible: true });
  });

  it('excludes on openness only when both expressed a list with no overlap', () => {
    const openToMen = side({ preferences: withPreferences({ openTo: ['man'] }) });
    const openToWomen = side({ genderIdentities: ['woman'], preferences: withPreferences({ openTo: ['woman'] }) });
    expect(areMutuallyCompatible(openToMen, openToWomen, null)).toEqual({
      compatible: false,
      excludedBy: ['gender'],
    });
  });

  it('keeps a non-binary counterpart in view for a list that includes non_binary', () => {
    const openToNonBinary = side({ preferences: withPreferences({ openTo: ['non_binary'] }) });
    expect(areMutuallyCompatible(openToNonBinary, side({ genderIdentities: ['non_binary'] }), null)).toEqual({
      compatible: true,
    });
  });

  it('excludes when the counterpart’s own openness does not cover the viewer', () => {
    const womanOpenToMen = side({ genderIdentities: ['woman'], preferences: withPreferences({ openTo: ['man'] }) });
    const manOpenToMen = side({ genderIdentities: ['man'], preferences: withPreferences({ openTo: ['man'] }) });
    expect(areMutuallyCompatible(womanOpenToMen, manOpenToMen, null)).toEqual({
      compatible: false,
      excludedBy: ['gender'],
    });
  });

  it('ignores the one-sided seeking list, which is a page filter and not a match test', () => {
    // A viewer who seeks only men is not thereby narrowed to men as a *match*:
    // openness is a separate declaration, and conflating the two made the two
    // settings inexpressible.
    const womanSeeksMen = side({
      genderIdentities: ['woman'],
      preferences: withPreferences({ seekingGenders: ['man'], openTo: ['man', 'woman'] }),
    });
    const manOpenToAnyone = side({
      genderIdentities: ['man'],
      preferences: withPreferences({ seekingGenders: ['man'], openTo: ['man', 'woman'] }),
    });
    expect(areMutuallyCompatible(womanSeeksMen, manOpenToAnyone, null)).toEqual({ compatible: true });
  });

  it('is symmetric, including which dimensions it names', () => {
    const viewer = side({
      age: 45,
      genderIdentities: ['woman'],
      preferences: withPreferences({
        ageRange: { min: 20, max: 30 },
        maxDistanceKm: 5,
        openTo: ['man'],
      }),
    });
    const candidate = side({
      age: 25,
      genderIdentities: ['man'],
      preferences: withPreferences({
        ageRange: { min: 40, max: 60 },
        maxDistanceKm: 100,
        openTo: ['woman'],
      }),
    });
    expect(areMutuallyCompatible(viewer, candidate, '25_50_km')).toEqual(
      areMutuallyCompatible(candidate, viewer, '25_50_km'),
    );
    expect(areMutuallyCompatible(viewer, candidate, '25_50_km').compatible).toBe(false);
  });
});
