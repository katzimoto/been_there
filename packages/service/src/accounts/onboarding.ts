import {
  type AccountState,
  type IdentityState,
  type UserId,
  accountMachine,
  identityMachine,
  isDiscoverableIdentity,
} from '@been-there/core';
import type { Stores, Transaction } from '@been-there/contracts';
import { type AgeBand, ageBandFor, ageOn, readDateOfBirth } from '@been-there/platform';
import { type ProfileState, profileMachine } from '@been-there/dating';
import { accountStateOf, identityStateOf, preferencesOf } from '../wiring/standing.js';
import { CURRENT_TERMS_VERSION } from './terms.js';

/**
 * The readiness checklist and the next-step surface.
 *
 * §3 says re-entry after a deferral is "a readiness checklist driven by the
 * projections above, not a hard-coded 'you are not verified' flag", and that
 * removing an item is driven by an event from its owner so the checklist cannot
 * drift from the truth. What that means in code is that this module holds no
 * state of its own and copies none: every field below is read from the domain
 * that owns it, in the same request, and the module's only judgement is *which
 * step comes next*.
 *
 * ## Discoverability is a predicate, not a flag
 *
 * `discoverable` is computed from four facts that live in four different domains:
 * the identity state (Identity), the account state (Moderation), the profile state
 * (Dating Core) and whether preferences are set. The kernel's own
 * `isDiscoverableIdentity` answers the identity half, and the profile and account
 * halves are read from the rows their domains wrote. There is no way to set
 * `discoverable: true` here, and there is no fixture, retry counter or support
 * override that reaches it — which is the property §3 calls out by name.
 *
 * ## What this never renders
 *
 * The date of birth is not in the projection and the exact age is not either.
 * §4.3 makes both owner-only and never displayed; the band is the only form any
 * other member ever sees, and it is public. So a user can read their own band —
 * "late 20s" — from here, and cannot read a date or a number out of it. That is
 * the whole of what the privacy spec (#17 §4) permits a user to see about their own
 * age.
 */

/** The closed vocabulary §3 sketches. A step that is not here does not exist. */
export type OnboardingStepId =
  | 'contact_verification'
  | 'age_gate'
  | 'terms'
  | 'identity_verification'
  | 'profile'
  | 'preferences'
  | 'photo_screening';

/**
 * The steps in the order §3's table lists them. An ordered array rather than a
 * record because the order *is* the product: "next step" is the first outstanding
 * one, and a step's position is the only thing that tells the client where to
 * send a user back to.
 */
export const ONBOARDING_ORDER: readonly OnboardingStepId[] = [
  'contact_verification',
  'age_gate',
  'terms',
  'identity_verification',
  'profile',
  'preferences',
  'photo_screening',
];

export interface OnboardingReadiness {
  /** Monotonic; a client holding an older one re-fetches. */
  readonly version: number;
  readonly userId: UserId;
  /** Owner: Platform. The product never sees the address behind this. */
  readonly contactVerified: boolean;
  /** Owner: Platform. Derived from a stored date of birth, never declared. */
  readonly ageGatePassed: boolean;
  /** The band, which is public. Never the date, never an exact age. */
  readonly ageBand: AgeBand | null;
  readonly termsAcceptedVersion: string | null;
  readonly termsCurrent: boolean;
  readonly identity: {
    readonly state: IdentityState;
    readonly discoverable: boolean;
  };
  readonly profileState: ProfileState;
  readonly preferencesSet: boolean;
  /** The first outstanding step, or `null` when nothing is outstanding. */
  readonly nextStep: OnboardingStepId | null;
  readonly outstanding: readonly OnboardingStepId[];
  /** True only when §3's four clauses all hold. */
  readonly discoverable: boolean;
  readonly accountState: AccountState;
}

/** Bumped when the shape changes, so a stale read is detectable. */
export const READINESS_VERSION = 1;

/**
 * Reads the checklist.
 *
 * Five reads, in parallel, each against the store that owns the fact. Nothing is
 * written: this is the surface a client re-fetches, and a read that wrote would
 * mean the checklist could change a domain's state simply by being looked at.
 */
export async function readinessFor(
  stores: Stores,
  userId: UserId,
  now: Date,
  tx: Transaction,
): Promise<OnboardingReadiness> {
  const [credential, onboarding, identity, standing, profile, preferences] = await Promise.all([
    stores.accounts.findCredential(userId, tx),
    stores.accounts.findOnboarding(userId, tx),
    stores.identity.find(userId, tx),
    stores.accountStanding.find(userId, tx),
    stores.interaction.findProfile(userId, tx),
    stores.interaction.findPreferences(userId, tx),
  ]);

  const identityState: IdentityState =
    identity === null ? identityMachine.initial : identityStateOf(identity.state, userId);
  // The kernel names what a fresh account is; the service is not deciding that
  // anybody is unrestricted.
  const accountState: AccountState =
    standing === null ? accountMachine.initial : accountStateOf(standing.state, userId);
  const profileState: ProfileState =
    profile === null ? profileMachine.initial : (profile.state as ProfileState);
  const expressed = preferencesOf(preferences, userId);
  const preferencesSet = expressed.ageRange !== null || expressed.maxDistanceKm !== null;

  const age = ageBandOn(onboarding?.dateOfBirth ?? null, now);

  const contactVerified = credential?.contactVerified === true;
  const termsAcceptedVersion = onboarding?.termsVersion ?? null;
  const termsCurrent = termsAcceptedVersion === CURRENT_TERMS_VERSION;

  const outstanding = outstandingSteps({
    contactVerified,
    ageGatePassed: age !== null,
    termsCurrent,
    identityState,
    profileState,
    preferencesSet,
  });

  const identityDiscoverable = isDiscoverableIdentity({
    state: identityState,
    latestVerificationId: identity?.latestVerificationId ?? null,
    generation: identity?.generation ?? 1,
  });

  const readiness: OnboardingReadiness = {
    version: READINESS_VERSION,
    userId,
    contactVerified,
    ageGatePassed: age !== null,
    ageBand: age,
    termsAcceptedVersion,
    termsCurrent,
    identity: { state: identityState, discoverable: identityDiscoverable },
    profileState,
    preferencesSet,
    nextStep: outstanding[0] ?? null,
    outstanding,
    // Filled in from the one predicate below rather than written out here, so the
    // answer a client reads and the answer a test asserts come from the same call.
    discoverable: false,
    accountState,
  };
  return { ...readiness, discoverable: isDiscoverable(readiness) };
}

/**
 * The band a stored date of birth falls in, or `null` when there is no date.
 *
 * `readDateOfBirth` refuses a malformed string, and its refusal here is a `null`
 * rather than an exception: an `ageGatePassed: false` is the correct answer for a
 * row that cannot be read, and the gate that wrote it already refused the value
 * that could not be read.
 */
function ageBandOn(dateOfBirth: string | null, now: Date): AgeBand | null {
  if (dateOfBirth === null) {
    return null;
  }
  const parsed = readDateOfBirth(dateOfBirth, now);
  if (!parsed.ok) {
    return null;
  }
  return ageBandFor(ageOn(parsed.value, now));
}

/** The facts the outstanding list is derived from. Every one is owned elsewhere. */
export interface ReadinessFacts {
  readonly contactVerified: boolean;
  readonly ageGatePassed: boolean;
  readonly termsCurrent: boolean;
  readonly identityState: IdentityState;
  readonly profileState: ProfileState;
  readonly preferencesSet: boolean;
}

/**
 * Which steps are outstanding, in the order §3 lists them.
 *
 * `identity_verification` is outstanding for every state that is not `verified` —
 * including `review_required` and `verification_failed`, which are states the
 * user waits on rather than acts on. The client renders a different screen for
 * those, but the *checklist* treats them alike: neither is a state the user
 * reaches discovery from, and a checklist that treated them as done would be
 * lying about the one thing it exists to report.
 *
 * `photo_screening` is never outstanding here. It is resolved by Identity and
 * Moderation after verification, and this feature never reads it (§2's ownership
 * table names the evidence as Identity's), so a checklist that claimed to know
 * whether it was outstanding would be holding a copy of a fact it may not read.
 * It appears in the vocabulary because the client's copy names it, and it drops
 * off the list the moment the identity state is `verified`.
 */
export function outstandingSteps(facts: ReadinessFacts): readonly OnboardingStepId[] {
  const outstanding: OnboardingStepId[] = [];
  if (!facts.contactVerified) {
    outstanding.push('contact_verification');
  }
  if (!facts.ageGatePassed) {
    outstanding.push('age_gate');
  }
  if (!facts.termsCurrent) {
    outstanding.push('terms');
  }
  if (facts.identityState !== 'verified') {
    outstanding.push('identity_verification');
  }
  if (facts.profileState !== 'complete') {
    outstanding.push('profile');
  }
  if (!facts.preferencesSet) {
    outstanding.push('preferences');
  }
  return ONBOARDING_ORDER.filter((step) => outstanding.includes(step));
}

/**
 * Whether this account may appear in discovery.
 *
 * §3 states the rule as a conjunction of four clauses and then insists it is "a
 * property of the identity transition table, not of this funnel". That is why the
 * identity clause is `isDiscoverableIdentity` — the kernel's predicate, not a
 * comparison written here — and why nothing above can grant it: the profile state
 * comes from the dating machine, the account state from moderation's row, and the
 * preferences from the preferences the user actually expressed.
 */
export function isDiscoverable(readiness: OnboardingReadiness): boolean {
  return (
    readiness.identity.discoverable &&
    readiness.accountState === 'active' &&
    readiness.profileState === 'complete' &&
    readiness.preferencesSet
  );
}