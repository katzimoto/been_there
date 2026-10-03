import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ONBOARDING_ORDER, outstandingSteps, type ReadinessFacts } from '../src/accounts/onboarding.js';

/**
 * The onboarding step order, stated once.
 *
 * ## Why this test exists
 *
 * `ONBOARDING_ORDER` is the order the product asks for the steps, and the Swift
 * client walks its own copy of that order to decide what to show a member. The
 * two used to disagree — the client checked identity before contact — which sent
 * a fresh sign-up to verify an identity before the contact it cannot be
 * recovered without. The drift was invisible because each side held its own
 * list and nothing compared them.
 *
 * `onboarding-order.json` is the one list. This asserts the server's constant
 * equals it; `OnboardingOrderingTests` asserts the Swift enum equals it. Neither
 * side writes the order down a second time, so the two cannot drift apart
 * without a test going red.
 *
 * The path is resolved from this file rather than `process.cwd()` because the
 * suite runs from the repo root under vitest and from the package under other
 * runners, and a fixture that resolves differently in CI is a fixture that only
 * guards local runs.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(
  HERE,
  '..',
  '..',
  '..',
  'client',
  'BeenThereKit',
  'Tests',
  'BeenThereKitTests',
  'onboarding-order.json',
);

function serverOrder(): string[] {
  const parsed: unknown = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('steps' in parsed)) {
    throw new Error(`${FIXTURE} has no "steps" array`);
  }
  const { steps } = parsed;
  if (!Array.isArray(steps) || steps.some((step) => typeof step !== 'string')) {
    throw new Error(`${FIXTURE} "steps" must be an array of strings`);
  }
  return steps;
}

describe('the onboarding step order', () => {
  it('is the order the shared fixture declares', () => {
    expect(ONBOARDING_ORDER).toEqual(serverOrder());
  });

  it('puts contact verification before identity verification', () => {
    // The one ordering the drift got wrong, and the one the spec is
    // unambiguous about: §3 lists contact verification as step 2 and blocking,
    // identity verification as step 6 and deferrable, and states the funnel
    // "may never skip 1–4". §5.2 says an unverified contact is blocking
    // because it is what makes recovery possible.
    expect(ONBOARDING_ORDER.indexOf('contact_verification')).toBeLessThan(
      ONBOARDING_ORDER.indexOf('identity_verification'),
    );
  });

  it('names every step the client mirror can carry', () => {
    // The four steps the Swift `OnboardingSnapshot` holds a fact for. The client
    // walks its enum and skips the rest, so a step added here without a client
    // fact is skipped rather than wrongly reported — but a step the client
    // *does* map must exist here or its mapping silently misses.
    for (const step of ['contact_verification', 'identity_verification', 'profile', 'preferences']) {
      expect(ONBOARDING_ORDER).toContain(step);
    }
  });

  it('answers contact first for a fresh sign-up', () => {
    // The state where the two sides used to disagree. A brand-new account has
    // confirmed nothing and verified nothing, so both contact and identity are
    // outstanding; the server answers contact and the client must match.
    const fresh: ReadinessFacts = {
      contactVerified: false,
      ageGatePassed: true,
      termsCurrent: true,
      identityState: 'unverified',
      profileState: 'draft',
      preferencesSet: false,
    };
    expect(outstandingSteps(fresh)[0]).toBe('contact_verification');
  });

  it('answers identity once contact is confirmed', () => {
    // The companion state: with contact done, identity becomes next. If the
    // client had hard-coded contact-first it would pass the fresh case and fail
    // this one, which is why both are asserted rather than only the first.
    const afterContact: ReadinessFacts = {
      contactVerified: true,
      ageGatePassed: true,
      termsCurrent: true,
      identityState: 'unverified',
      profileState: 'draft',
      preferencesSet: false,
    };
    expect(outstandingSteps(afterContact)[0]).toBe('identity_verification');
  });
});
