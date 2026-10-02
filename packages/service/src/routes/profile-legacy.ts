import {
  type ProfileState,
  evaluateProfileCompleteness,
  profileMachine,
} from '@been-there/dating';
import { NOT_FOUND } from '../http/failure.js';
import { okResponse, route, type Route } from '../http/router.js';
import type { ServiceDependencies } from '../ports.js';
import { profileStateOf } from '../wiring/standing.js';
import { claimedOwner, profileContentFromRequest, preferencesFromRequest } from './profile-body.js';

/**
 * The id-in-path profile surface, kept because existing clients use it.
 *
 * This is the *older* shape and the weaker one. `/v1/profiles/me` addresses the
 * owner through the session and has nothing to authorise; these routes take the
 * user id from the path, so they have to check it — and that check is the whole
 * of what makes them safe rather than a detail inside a larger handler, which is
 * why it gets its own file and its own words.
 *
 * Two properties are worth naming:
 *
 *  - The refusal is `not_found`, not `permission_denied`, so the answer does not
 *    distinguish "no such account" from "an account that is not yours". A 403
 *    would confirm the id belongs to somebody, which is exactly the probe a
 *    caller guessing ids is making.
 *  - A `photos` array in the body is still accepted here, because clients predate
 *    the photo table. It is the weaker of the two surfaces, and `/v1/profiles/me`
 *    is where it goes away: there the list is read from the table, and a client's
 *    assertion about approval is inert.
 */
export function legacyProfileRoutes(dependencies: ServiceDependencies): readonly Route[] {
  return [
    // --------------------------------------------------------- the older shape --

    route('PUT', '/v1/accounts/:userId/profile', async (request) => {
      const owner = claimedOwner(request);
      if (!owner.ok) {
        return owner;
      }
      const content = profileContentFromRequest(request.body);
      if (!content.ok) {
        return content;
      }
      const completeness = evaluateProfileCompleteness(content.value, request.now);
      const existing = await dependencies.stores.interaction.findProfile(owner.value, request.tx);
      const current: ProfileState =
        existing === null ? profileMachine.initial : profileStateOf(existing.state, owner.value);
      // The event comes from the evaluation, and the machine's guard re-checks
      // the requirement. A client cannot send `state: 'complete'` and be
      // believed: this route never reads a state from the body.
      const event = completeness.complete ? 'mark_complete' : 'mark_incomplete';
      const next = profileMachine.next(current, event, { requirementsMet: completeness.complete });
      if (!next.ok) {
        return next;
      }
      await dependencies.stores.interaction.upsertProfile(
        {
          profileId: existing?.profileId ?? `profile:${owner.value}`,
          userId: owner.value,
          state: next.value,
          content: content.value as unknown as Readonly<Record<string, unknown>>,
          updatedAt: request.now,
        },
        request.tx,
      );
      return okResponse(200, {
        userId: owner.value,
        state: next.value,
        complete: completeness.complete,
        missing: completeness.missing,
      });
    }),

    route('PUT', '/v1/accounts/:userId/preferences', async (request) => {
      const owner = claimedOwner(request);
      if (!owner.ok) {
        return owner;
      }
      const preferences = preferencesFromRequest(request.body);
      if (!preferences.ok) {
        return preferences;
      }
      await dependencies.stores.interaction.upsertPreferences(
        owner.value,
        preferences.value as unknown as Readonly<Record<string, unknown>>,
        request.tx,
      );
      return okResponse(200, { userId: owner.value, preferences: preferences.value });
    }),

    route('GET', '/v1/accounts/:userId/preferences', async (request) => {
      const owner = claimedOwner(request);
      if (!owner.ok) {
        return owner;
      }
      const stored = await dependencies.stores.interaction.findPreferences(owner.value, request.tx);
      if (stored === null) {
        return NOT_FOUND('preferences');
      }
      return okResponse(200, { userId: owner.value, preferences: stored });
    }),
  ];
}
