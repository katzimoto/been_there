import type { PhotoId, ProfileId, UserId } from '@been-there/core';
import { defineStateMachine, type StateMachine } from '@been-there/core';
import type { DistanceBand } from './location.js';

/**
 * Profile lifecycle (issue #4).
 *
 * `complete` is the only state a profile can be *shown* from, and it is not the
 * same as "filled in": a profile can hold a name, a bio and three photos and
 * still be `incomplete` if it has no age, no gender identity, no answered
 * prompt, or no resolvable location. Those are the fields discovery and mutual
 * compatibility need, and a profile that lacks them cannot be filtered
 * honestly — so it is not shown rather than shown badly.
 */

export type ProfileState =
  | 'draft'
  | 'incomplete'
  | 'complete'
  | 'paused'
  | 'hidden'
  | 'deleted';

export type ProfileEvent =
  | 'mark_complete'
  | 'mark_incomplete'
  | 'pause'
  | 'hide'
  | 'delete';

/** Why a profile left the visible pool without the owner asking. */
export type ProfileHiddenReason = 'account_restricted' | 'policy_enforced';

export interface ProfileContext {
  /** Result of `evaluateProfileCompleteness` on the content being saved. */
  readonly requirementsMet: boolean;
  /**
   * Present only for system-driven transitions. A client cannot supply a
   * reason, so `hide` is unreachable from the product surface — only the
   * `account_state.changed` handler and moderation-driven enforcement hide a
   * profile.
   */
  readonly hiddenReason?: ProfileHiddenReason;
}

export const profileMachine: StateMachine<ProfileState, ProfileEvent, ProfileContext> =
  defineStateMachine<ProfileState, ProfileEvent, ProfileContext>({
    domain: 'dating.profile',
    initial: 'draft',
    transitions: [
      { event: 'mark_complete', from: ['draft', 'incomplete', 'complete', 'paused', 'hidden'], to: 'complete', guard: (ctx) => ctx.requirementsMet, note: 'The only way in. Completeness is evaluated, not declared: a command that claims a complete profile without meeting the requirements is rejected.' },
      { event: 'mark_incomplete', from: ['draft', 'incomplete', 'complete', 'paused', 'hidden'], to: 'incomplete', guard: (ctx) => !ctx.requirementsMet, note: 'Any edit that drops a requirement lands here, including out of `hidden` and `paused` — resuming and restoring are the same domain action, and only the content decides how far the profile comes back.' },
      { event: 'pause', from: ['incomplete', 'complete'], to: 'paused', note: 'Owner-initiated: take a break without losing the profile.' },
      { event: 'hide', from: ['incomplete', 'complete', 'paused'], to: 'hidden', guard: (ctx) => ctx.hiddenReason !== undefined, note: 'System-only: an account standing or a policy action hides the profile. Never a client call.' },
      { event: 'delete', to: 'deleted', from: ['draft', 'incomplete', 'complete', 'paused', 'hidden'], note: 'Content removal. The interaction history and any moderation evidence are retained elsewhere and are not deleted with the profile.' },
    ],
  });

export const PROFILE_REQUIREMENTS = {
  maxDisplayNameChars: 50,
  minBioChars: 20,
  maxBioChars: 500,
  minPhotos: 3,
  minAnsweredPrompts: 1,
  minAge: 18,
  maxAge: 120,
} as const;

export type MissingProfileField =
  | 'display_name'
  | 'bio'
  | 'photos'
  | 'prompt'
  | 'gender_identities'
  | 'age'
  | 'location';

export type GenderIdentity = 'woman' | 'man' | 'non_binary' | 'self_described';

export type PhotoApproval = 'pending' | 'approved' | 'rejected';

export interface ProfilePhoto {
  readonly photoId: PhotoId;
  readonly approval: PhotoApproval;
}

export interface PromptAnswer {
  readonly promptId: string;
  readonly text: string;
}

export interface ProfileContent {
  readonly displayName: string;
  readonly bio: string;
  readonly photos: readonly ProfilePhoto[];
  readonly prompts: readonly PromptAnswer[];
  readonly genderIdentities: readonly GenderIdentity[];
  /** ISO `YYYY-MM-DD`; the only form of age stored. */
  readonly birthdate: string | null;
  /** Coarse bucket resolved by the platform. Never a coordinate. */
  readonly location: DistanceBand | null;
}

export interface ProfileCompleteness {
  readonly complete: boolean;
  /** Every unmet requirement, in evaluation order — not just the first. */
  readonly missing: readonly MissingProfileField[];
}

/**
 * Age from a birthdate, or `null` when the input is not a usable date. Null is
 * the "unknown" case and never a substitute for a valid age: an unknown age
 * fails the age requirement rather than passing it.
 */
export function ageFromBirthdate(birthdate: string | null, today: Date): number | null {
  if (birthdate === null) {
    return null;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthdate);
  if (match === null) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const born = new Date(Date.UTC(year, month - 1, day));
  if (
    born.getUTCFullYear() !== year ||
    born.getUTCMonth() !== month - 1 ||
    born.getUTCDate() !== day
  ) {
    return null;
  }
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  let age = today.getUTCFullYear() - year;
  const hadBirthday =
    today.getUTCMonth() > born.getUTCMonth() ||
    (today.getUTCMonth() === born.getUTCMonth() && today.getUTCDate() >= day);
  if (!hadBirthday) {
    age -= 1;
  }
  // Guards against a birthdate in the future or an implausible one.
  return todayUtc < born.getTime() ? null : age;
}

/**
 * Filled in is not complete. Every field here is one discovery or
 * compatibility actually consumes, and only `approved` photos count: a photo
 * still in media review must not put a face in front of another user.
 */
export function evaluateProfileCompleteness(
  content: ProfileContent,
  today: Date,
): ProfileCompleteness {
  const missing: MissingProfileField[] = [];
  const displayName = content.displayName.trim();
  if (displayName.length === 0 || displayName.length > PROFILE_REQUIREMENTS.maxDisplayNameChars) {
    missing.push('display_name');
  }
  const bio = content.bio.trim();
  if (bio.length < PROFILE_REQUIREMENTS.minBioChars || bio.length > PROFILE_REQUIREMENTS.maxBioChars) {
    missing.push('bio');
  }
  if (content.photos.filter((photo) => photo.approval === 'approved').length < PROFILE_REQUIREMENTS.minPhotos) {
    missing.push('photos');
  }
  if (!content.prompts.some((prompt) => prompt.text.trim().length > 0)) {
    missing.push('prompt');
  }
  if (content.genderIdentities.length === 0) {
    missing.push('gender_identities');
  }
  const age = ageFromBirthdate(content.birthdate, today);
  if (age === null || age < PROFILE_REQUIREMENTS.minAge || age > PROFILE_REQUIREMENTS.maxAge) {
    missing.push('age');
  }
  if (content.location === null) {
    missing.push('location');
  }
  return { complete: missing.length === 0, missing };
}

/**
 * The projection discovery, messaging and matching read. It carries derived,
 * non-identifying facts only — an age, a set of gender identities and a coarse
 * band. There is no field here that could reconstruct a coordinate.
 */
export interface ProfileSnapshot {
  readonly profileId: ProfileId;
  readonly userId: UserId;
  readonly state: ProfileState;
  readonly age: number | null;
  readonly genderIdentities: readonly GenderIdentity[];
  readonly location: DistanceBand | null;
}
