import { describe, expect, it } from 'vitest';
import type { Result } from '@been-there/core';
import {
  type CompatibilitySide,
  PREFERENCE_LIMITS,
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

describe('validatePreferences', () => {
  it('accepts an entirely unset preference set', () => {
    expect(validatePreferences(UNSET_PREFERENCES).ok).toBe(true);
  });

  it('rejects an inverted or out-of-bounds age range', () => {
    const inverted: DatingPreferences = { ...UNSET_PREFERENCES, ageRange: { min: 50, max: 30 } };
    expect(rejected(validatePreferences(inverted))?.code).toBe('validation_failed');
    const underage: DatingPreferences = { ...UNSET_PREFERENCES, ageRange: { min: 16, max: 30 } };
    expect(rejected(validatePreferences(underage))?.code).toBe('validation_failed');
    const tooOld: DatingPreferences = {
      ...UNSET_PREFERENCES,
      ageRange: { min: 20, max: PREFERENCE_LIMITS.maxAge + 1 },
    };
    expect(rejected(validatePreferences(tooOld))?.code).toBe('validation_failed');
  });

  it('rejects a fractional age bound', () => {
    const fractional: DatingPreferences = { ...UNSET_PREFERENCES, ageRange: { min: 20.5, max: 30 } };
    expect(rejected(validatePreferences(fractional))?.code).toBe('validation_failed');
  });

  it('rejects a distance outside the product range', () => {
    const tooClose: DatingPreferences = { ...UNSET_PREFERENCES, maxDistanceKm: 0 };
    expect(rejected(validatePreferences(tooClose))?.code).toBe('validation_failed');
    const tooFar: DatingPreferences = {
      ...UNSET_PREFERENCES,
      maxDistanceKm: PREFERENCE_LIMITS.maxDistanceKm + 1,
    };
    expect(rejected(validatePreferences(tooFar))?.code).toBe('validation_failed');
  });

  it('rejects an interest list that is empty, unknown or duplicated', () => {
    expect(rejected(validatePreferences({ ...UNSET_PREFERENCES, interestedIn: [] }))?.code).toBe(
      'validation_failed',
    );
    const unknown = { ...UNSET_PREFERENCES, interestedIn: ['alien' as never] };
    expect(rejected(validatePreferences(unknown))?.code).toBe('validation_failed');
    const duplicated: DatingPreferences = { ...UNSET_PREFERENCES, interestedIn: ['woman', 'woman'] };
    expect(rejected(validatePreferences(duplicated))?.code).toBe('validation_failed');
  });

  it('knows when nothing has been expressed', () => {
    expect(hasExpressedPreferences(UNSET_PREFERENCES)).toBe(false);
    expect(hasExpressedPreferences({ ...UNSET_PREFERENCES, maxDistanceKm: 50 })).toBe(false);
    expect(
      hasExpressedPreferences({ ageRange: { min: 20, max: 40 }, maxDistanceKm: 50, interestedIn: ['man'] }),
    ).toBe(true);
  });
});

describe('areMutuallyCompatible', () => {
  it('treats an unexpressed dimension as no constraint on either side', () => {
    const a = side();
    const b = side();
    expect(areMutuallyCompatible(a, b, '25_50_km')).toEqual({ compatible: true });
  });

  it('never excludes on a dimension only one side expressed', () => {
    const interestedInMen = side({ preferences: { ...UNSET_PREFERENCES, interestedIn: ['man'] } });
    const woman = side({ genderIdentities: ['woman'] });
    expect(areMutuallyCompatible(interestedInMen, woman, null)).toEqual({ compatible: true });
    expect(areMutuallyCompatible(woman, interestedInMen, null)).toEqual({ compatible: true });
  });

  it('excludes on age only when both expressed a range and one is outside it', () => {
    const wantsYoung = side({ preferences: { ...UNSET_PREFERENCES, ageRange: { min: 20, max: 30 } } });
    const older = side({ age: 45, preferences: { ...UNSET_PREFERENCES, ageRange: { min: 40, max: 60 } } });
    expect(areMutuallyCompatible(wantsYoung, older, null)).toEqual({
      compatible: false,
      excludedBy: ['age'],
    });
  });

  it('excludes when the candidate is outside the viewer range even if the viewer is inside theirs', () => {
    const viewer = side({ age: 26, preferences: { ...UNSET_PREFERENCES, ageRange: { min: 20, max: 30 } } });
    const candidate = side({ age: 26, preferences: { ...UNSET_PREFERENCES, ageRange: { min: 40, max: 50 } } });
    expect(areMutuallyCompatible(viewer, candidate, null)).toEqual({
      compatible: false,
      excludedBy: ['age'],
    });
  });

  it('does not exclude on an unknown age', () => {
    const wantsYoung = side({ preferences: { ...UNSET_PREFERENCES, ageRange: { min: 20, max: 30 } } });
    expect(areMutuallyCompatible(wantsYoung, side({ age: null }), null)).toEqual({ compatible: true });
  });

  it('excludes on distance only when both expressed a limit that the band fails', () => {
    const nearOnly = side({ preferences: { ...UNSET_PREFERENCES, maxDistanceKm: 10 } });
    const farOnly = side({ preferences: { ...UNSET_PREFERENCES, maxDistanceKm: 100 } });
    expect(areMutuallyCompatible(nearOnly, farOnly, '25_50_km')).toEqual({
      compatible: false,
      excludedBy: ['distance'],
    });
    expect(areMutuallyCompatible(nearOnly, farOnly, 'lt_5_km')).toEqual({ compatible: true });
  });

  it('does not exclude on an unresolvable distance', () => {
    const nearOnly = side({ preferences: { ...UNSET_PREFERENCES, maxDistanceKm: 10 } });
    expect(areMutuallyCompatible(nearOnly, side(), 'unknown')).toEqual({ compatible: true });
  });

  it('excludes on gender only when both expressed a list with no overlap', () => {
    const wantsMen = side({ preferences: { ...UNSET_PREFERENCES, interestedIn: ['man'] } });
    const wantsWomen = side({ genderIdentities: ['woman'], preferences: { ...UNSET_PREFERENCES, interestedIn: ['woman'] } });
    expect(areMutuallyCompatible(wantsMen, wantsWomen, null)).toEqual({
      compatible: false,
      excludedBy: ['gender'],
    });
  });

  it('keeps a non-binary candidate in view for a list that includes non_binary', () => {
    const wantsNonBinary = side({ preferences: { ...UNSET_PREFERENCES, interestedIn: ['non_binary'] } });
    const candidate = side({ genderIdentities: ['non_binary'] });
    expect(areMutuallyCompatible(wantsNonBinary, candidate, null)).toEqual({ compatible: true });
  });

  it('excludes when the candidate’s own list does not cover the viewer', () => {
    const wantsMen = side({ genderIdentities: ['woman'], preferences: { ...UNSET_PREFERENCES, interestedIn: ['man'] } });
    const alsoWantsMen = side({ genderIdentities: ['man'], preferences: { ...UNSET_PREFERENCES, interestedIn: ['man'] } });
    expect(areMutuallyCompatible(wantsMen, alsoWantsMen, null)).toEqual({
      compatible: false,
      excludedBy: ['gender'],
    });
  });

  it('is symmetric, including which dimensions it names', () => {
    const viewer = side({
      age: 45,
      genderIdentities: ['woman'],
      preferences: { ageRange: { min: 20, max: 30 }, maxDistanceKm: 10, interestedIn: ['man'] },
    });
    const candidate = side({
      age: 25,
      genderIdentities: ['man'],
      preferences: { ageRange: { min: 40, max: 60 }, maxDistanceKm: 100, interestedIn: ['woman'] },
    });
    expect(areMutuallyCompatible(viewer, candidate, '25_50_km')).toEqual(areMutuallyCompatible(candidate, viewer, '25_50_km'));
    expect(areMutuallyCompatible(viewer, candidate, '25_50_km').compatible).toBe(false);
  });
});
