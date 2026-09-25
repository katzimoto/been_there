import { describe, expect, it } from 'vitest';
import { type Result, assertMachineIsTotal } from '@been-there/core';
import {
  type MissingProfileField,
  PROFILE_REQUIREMENTS,
  ageFromBirthdate,
  evaluateProfileCompleteness,
  type ProfileContent,
  profileMachine,
} from '../src/index.js';
import { photo } from './fixtures.js';

function succeeded<T, E extends { code: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.error.code}`);
  }
  return result.value;
}

const TODAY = new Date('2026-09-25T00:00:00Z');

function content(overrides: Partial<ProfileContent> = {}): ProfileContent {
  return {
    displayName: 'Robin',
    bio: 'Long walks, short temper, excellent bread.',
    photos: [photo('p1'), photo('p2'), photo('p3')].map((photoId) => ({
      photoId,
      approval: 'approved' as const,
    })),
    prompts: [{ promptId: 'q1', text: 'Best weekend: a bakery.' }],
    genderIdentities: ['non_binary'],
    birthdate: '1996-04-17',
    location: 'lt_5_km',
    ...overrides,
  };
}

function missingOf(overrides: Partial<ProfileContent> = {}): readonly MissingProfileField[] {
  return evaluateProfileCompleteness(content(overrides), TODAY).missing;
}

describe('ageFromBirthdate', () => {
  it('counts whole years only, and waits for the birthday', () => {
    expect(ageFromBirthdate('1996-04-17', new Date('2026-04-16T00:00:00Z'))).toBe(29);
    expect(ageFromBirthdate('1996-04-17', new Date('2026-04-17T00:00:00Z'))).toBe(30);
  });

  it('is valid on a leap day', () => {
    expect(ageFromBirthdate('2000-02-29', new Date('2026-02-28T00:00:00Z'))).toBe(25);
  });

  it('rejects dates that do not exist and dates in the future', () => {
    expect(ageFromBirthdate('2001-02-29', TODAY)).toBeNull();
    expect(ageFromBirthdate('2030-01-01', TODAY)).toBeNull();
    expect(ageFromBirthdate('not-a-date', TODAY)).toBeNull();
    expect(ageFromBirthdate(null, TODAY)).toBeNull();
  });
});

describe('profile completeness', () => {
  it('reports a filled-in profile as complete', () => {
    expect(evaluateProfileCompleteness(content(), TODAY)).toEqual({ complete: true, missing: [] });
  });

  it('treats a profile with every field but the location as merely filled in', () => {
    expect(missingOf({ location: null })).toEqual<MissingProfileField[]>(['location']);
  });

  it('requires every missing field, not just the first', () => {
    expect(missingOf({ displayName: '  ', location: null, genderIdentities: [] })).toEqual<
      MissingProfileField[]
    >(['display_name', 'gender_identities', 'location']);
  });

  it('does not count a photo that is still in media review', () => {
    const pending = [photo('p1'), photo('p2'), photo('p3')].map((photoId, index) => ({
      photoId,
      approval: index === 2 ? ('pending' as const) : ('approved' as const),
    }));
    expect(missingOf({ photos: pending })).toEqual<MissingProfileField[]>(['photos']);
  });

  it('requires at least one answered prompt and a usable bio length', () => {
    expect(missingOf({ prompts: [{ promptId: 'q1', text: '   ' }] })).toEqual<MissingProfileField[]>(['prompt']);
    expect(missingOf({ bio: 'too short' })).toEqual<MissingProfileField[]>(['bio']);
  });

  it('refuses an age below the product minimum and an unparseable one alike', () => {
    expect(missingOf({ birthdate: '2015-01-01' })).toEqual<MissingProfileField[]>(['age']);
    expect(missingOf({ birthdate: 'nonsense' })).toEqual<MissingProfileField[]>(['age']);
    expect(missingOf({ birthdate: null })).toEqual<MissingProfileField[]>(['age']);
  });

  it('rejects a display name past the limit', () => {
    const long = 'x'.repeat(PROFILE_REQUIREMENTS.maxDisplayNameChars + 1);
    expect(missingOf({ displayName: long })).toEqual<MissingProfileField[]>(['display_name']);
  });
});

describe('profile machine', () => {
  it('starts as a draft and can be deleted from every state', () => {
    expect(profileMachine.initial).toBe('draft');
    for (const state of ['draft', 'incomplete', 'complete', 'paused', 'hidden'] as const) {
      expect(succeeded(profileMachine.next(state, 'delete', { requirementsMet: true }))).toBe('deleted');
    }
  });

  it('refuses to mark a profile complete that does not meet the requirements', () => {
    const result = profileMachine.next('draft', 'mark_complete', { requirementsMet: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('validation_failed');
    }
  });

  it('refuses to mark a qualifying profile incomplete', () => {
    const result = profileMachine.next('complete', 'mark_incomplete', { requirementsMet: true });
    expect(result.ok).toBe(false);
  });

  it('follows the content: a save that drops a requirement lands on incomplete', () => {
    expect(succeeded(profileMachine.next('draft', 'mark_complete', { requirementsMet: true }))).toBe('complete');
    expect(succeeded(profileMachine.next('draft', 'mark_incomplete', { requirementsMet: false }))).toBe('incomplete');
    expect(succeeded(profileMachine.next('complete', 'mark_incomplete', { requirementsMet: false }))).toBe('incomplete');
  });

  it('pauses and comes back only as far as the content allows', () => {
    const paused = succeeded(profileMachine.next('complete', 'pause', { requirementsMet: true }));
    expect(paused).toBe('paused');
    expect(succeeded(profileMachine.next(paused, 'mark_complete', { requirementsMet: true }))).toBe('complete');
    expect(succeeded(profileMachine.next(paused, 'mark_incomplete', { requirementsMet: false }))).toBe('incomplete');
  });

  it('only allows a hide with a reason, so a client cannot hide itself out of sight', () => {
    expect(profileMachine.can('complete', 'hide', { requirementsMet: true })).toBe(false);
    expect(succeeded(profileMachine.next('complete', 'hide', { requirementsMet: true, hiddenReason: 'account_restricted' }))).toBe(
      'hidden',
    );
  });

  it('restores a hidden profile only as far as its content allows', () => {
    expect(succeeded(profileMachine.next('hidden', 'mark_complete', { requirementsMet: true }))).toBe('complete');
    expect(succeeded(profileMachine.next('hidden', 'mark_incomplete', { requirementsMet: false }))).toBe('incomplete');
  });

  it('rejects an event that is not legal from the current state', () => {
    const result = profileMachine.next('deleted', 'mark_complete', { requirementsMet: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid_transition');
    }
  });

  it('has no dead end except deletion', () => {
    expect(() => assertMachineIsTotal(profileMachine, ['deleted'])).not.toThrow();
    for (const state of ['draft', 'incomplete', 'complete', 'paused', 'hidden'] as const) {
      expect(profileMachine.legalEvents(state).length).toBeGreaterThan(0);
    }
  });
});
