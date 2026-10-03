/**
 * The capability floor, from the kernel's own side.
 *
 * `UNRESTRICTABLE_CAPABILITIES` is the last line of defence for the three
 * capabilities a person must never lose: reporting, blocking, and leaving. A
 * staff role is not a member role, and the people who hold one act on other
 * people's accounts, which is exactly the position from which a floor would be
 * convenient to relax. This file proves the floor is not merely declared but
 * *reachable* — that every name on it is a real capability and that no removal,
 * however spelled, can subtract it. The staff-facing half (a grant built by a
 * staff actor, the capability gate a product command passes through) is proved
 * in `packages/platform/test/staff-privilege.test.ts`.
 *
 * The point of asserting the names are *known* is that a filter over an unknown
 * name is not a floor, it is a no-op: `'report'.includes(guard)` passes for
 * every input, so a typo in the list would silently protect nothing while every
 * test above it kept passing.
 */
import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES_BY_ACCOUNT_STATE,
  UNRESTRICTABLE_CAPABILITIES,
  capabilitiesFor,
  type AccountState,
} from '../src/index.js';

/** Every capability name any standing grants, deduplicated. */
const VOCABULARY: ReadonlySet<string> = new Set(
  Object.values(CAPABILITIES_BY_ACCOUNT_STATE).flat(),
);

const STATES: readonly AccountState[] = ['active', 'limited', 'suspended', 'banned'];

/** The two floors that must hold everywhere, named explicitly as the brief asks. */
const NAMED_FLOORS = ['report', 'delete_account'] as const;

describe('the capability floor is not vacuous', () => {
  it('names only capabilities the vocabulary knows', () => {
    for (const capability of UNRESTRICTABLE_CAPABILITIES) {
      expect(
        VOCABULARY.has(capability),
        `"${capability}" is in UNRESTRICTABLE_CAPABILITIES but no account state grants it, so the filter over it can never match`,
      ).toBe(true);
    }
  });

  it('is granted by at least one standing, so each entry protects something', () => {
    for (const capability of UNRESTRICTABLE_CAPABILITIES) {
      const grantingStates = STATES.filter((state) =>
        CAPABILITIES_BY_ACCOUNT_STATE[state].includes(capability),
      );
      expect(
        grantingStates.length,
        `"${capability}" is unrestrictable but no standing grants it`,
      ).toBeGreaterThan(0);
    }
  });

  it('keeps each named floor in every standing that grants it', () => {
    // The floor is only as strong as the state lists: a future edit that drops
    // `report` from `banned` defeats the filter before the filter ever runs, and
    // the floor's tests would still pass because they all start from a grant.
    for (const capability of NAMED_FLOORS) {
      expect(UNRESTRICTABLE_CAPABILITIES, `${capability} is not on the floor`).toContain(capability);
      for (const state of STATES) {
        if (!CAPABILITIES_BY_ACCOUNT_STATE[state].includes(capability)) {
          continue;
        }
        expect(
          capabilitiesFor(state, { removedCapabilities: [capability] }),
          `${state} lost ${capability} to a restriction naming it`,
        ).toContain(capability);
      }
    }
  });

  it('keeps every floor entry when a restriction names the whole list at once', () => {
    // The realistic worst case: one moderation decision that names every
    // unrestrictable capability at the same time. Subtracting the list from
    // itself must still leave the list.
    for (const state of STATES) {
      const granted = capabilitiesFor(state, {
        removedCapabilities: [...UNRESTRICTABLE_CAPABILITIES],
      });
      for (const capability of UNRESTRICTABLE_CAPABILITIES) {
        if (!CAPABILITIES_BY_ACCOUNT_STATE[state].includes(capability)) {
          continue;
        }
        expect(
          granted.includes(capability),
          `${state} lost ${capability} to a blanket removal`,
        ).toBe(true);
      }
    }
  });

  it('still subtracts the capabilities that are restrictable', () => {
    // The floor must not have been bought by making the filter inert: a name
    // that is not on the list has to disappear.
    const granted = capabilitiesFor('active', { removedCapabilities: ['send_message'] });
    expect(granted).not.toContain('send_message');
    expect(granted).toContain('report');
    expect(granted).toContain('block');
  });
});