import { type DomainError, type Result, domainError, ok } from '@been-there/core';
import {
  SIGN_IN_FAILED_COPY,
  hashPassword,
  isStaffRole,
  normalizeContact,
  staffIdentityMayAuthenticate,
  verifyPassword,
  type StaffId,
} from '@been-there/platform';
import { readString } from '../http/body.js';
import { okResponse, publicRoute, type Route } from '../http/router.js';
import type { ServiceDependencies } from '../ports.js';
import { applySessionLimit, issueStoredSessionFor } from '../accounts/sessions.js';
import { correlationIdFrom, recordFunnel } from '../accounts/funnel.js';

/**
 * Staff sign-in.
 *
 * ## What this route is for
 *
 * Before it existed, the only credential that could open a moderation queue was a
 * string compared in JavaScript by a composition root, with the *token itself*
 * recorded as the acting identity. A decision row therefore named a shared secret
 * rather than a person: it could not answer "which human did this", could not be
 * revoked for one person without invalidating everyone's, and left the audit log
 * with no actor to attribute an enforcement action to. In a real deployment there
 * was no way in at all.
 *
 * This is that way in. It authenticates a *named identity* and mints an ordinary
 * row in the ordinary session table — there is no staff-specific session
 * mechanism, because a second mechanism is a second answer to "who is calling"
 * and those two answers would disagree about exactly the cases that matter.
 *
 * ## The refusals, and why each is here
 *
 * The password check runs even when the contact is unknown, against a fixed hash,
 * so response latency does not disclose whether a given moderator exists. The
 * identity's role is validated against the platform's staff vocabulary rather
 * than trusted, and its status is checked *before* a session is minted so a
 * suspended moderator is never issued a credential in the first place — the
 * resolver would refuse it on the next request anyway, but a row that exists and
 * cannot be used is a row an operator has to reason about during an incident.
 *
 * A suspended identity is refused with the same body as a wrong password. Not
 * out of caution: telling a suspended moderator "you are suspended" confirms
 * that the address belongs to a real staff identity, which is precisely the
 * reconnaissance this endpoint must not perform.
 */
export function staffSessionRoutes(dependencies: ServiceDependencies): readonly Route[] {
  return [
    publicRoute('POST', '/v1/staff-sessions', async (request) => {
      const contact = readString(request.body, 'contact');
      if (!contact.ok) {
        return contact;
      }
      const password = readString(request.body, 'password');
      if (!password.ok) {
        return password;
      }
      const normalized = normalizeContact(
        contact.value.includes('@') ? 'email' : 'phone',
        contact.value,
      );
      if (!normalized.ok) {
        return signInFailed();
      }

      const identity = await dependencies.stores.staff.findStaffByContact(
        normalized.value.identifier,
        request.tx,
      );
      if (identity === null) {
        // Same wall-clock cost as a known identity. Without this, latency alone
        // answers "is this address a moderator".
        await verifyPassword(password.value, DUMMY_PASSWORD_HASH);
        return signInFailed();
      }

      const verified = await verifyPassword(password.value, identity.passwordHash);
      if (!verified) {
        return signInFailed();
      }

      // Both checks happen after the password is verified and before a session
      // exists. After, because "this password is wrong" must not depend on the
      // account's state — that ordering is what keeps the endpoint from telling a
      // caller who is suspended that their password is fine. Before, because the
      // alternative is a credential that exists and cannot be used.
      if (!isStaffRole(identity.role)) {
        return signInFailed();
      }
      if (!staffIdentityMayAuthenticate(identity.status)) {
        return signInFailed();
      }

      const issued = issueStoredSessionFor(
        { kind: 'staff', staffId: identity.staffId as StaffId, automated: false },
        'staff_password',
        request.now,
      );
      if (!issued.ok) {
        return issued;
      }

      const held = await dependencies.stores.staff.listSessionsForStaff(identity.staffId, request.tx);
      const capped = applySessionLimit([...held, issued.value.row]);
      await dependencies.stores.accounts.insertSession(issued.value.row, request.tx);
      for (const evicted of capped.evicted) {
        await dependencies.stores.accounts.updateSession(evicted, request.tx);
      }

      await recordFunnel(
        {
          stores: dependencies.stores,
          tx: request.tx,
          correlationId: correlationIdFrom(undefined),
          now: request.now,
        },
        'account.session_started',
        { surface: 'staff_sign_in', auth_method: 'staff_password' },
      );

      // `displayName` and `role` are returned so a console can render "signed in
      // as <name> (<role>)" without a second lookup — and so the UI shows the
      // human whose name is about to land in every decision they take. `userId` is
      // absent rather than null: there is no member here, and inventing an
      // all-nulls member field is what made the old token path hard to reason
      // about.
      return okResponse(201, {
        staffId: identity.staffId,
        displayName: identity.displayName,
        role: identity.role,
        token: issued.value.token,
        sessionId: issued.value.row.sessionId,
        expiresAt: issued.value.row.expiresAt.toISOString(),
        refreshableUntil: issued.value.row.refreshableUntil.toISOString(),
        evictedSessions: capped.evicted.length,
      });
    }),

    /**
     * Sign a staff identity out of every device.
     *
     * The staff counterpart to `DELETE /v1/account-sessions/all`, and it exists
     * because that route cannot serve this case: it resolves its owner from
     * `actor.userId`, which is null for a staff actor, so reusing it would either
     * refuse every moderator or tempt someone into deriving an owner from the
     * wrong column. A revocation path that guesses whose sessions to kill is the
     * hazard this whole change exists to close, so the staff path is explicit
     * about listing by `staff_id`.
     *
     * This is the switch that takes effect immediately: every session the
     * identity holds is written `revoked` here, so the next request from any of
     * them fails `validateSession` rather than running to completion.
     */
    publicRoute('DELETE', '/v1/staff-sessions/all', async (request) => {
      const staffId = readString(request.body, 'staffId');
      if (!staffId.ok) {
        return staffId;
      }
      const held = await dependencies.stores.staff.listSessionsForStaff(staffId.value, request.tx);
      let revoked = 0;
      for (const row of held) {
        if (row.status !== 'active') {
          continue;
        }
        const changed = await dependencies.stores.accounts.updateSession(
          { ...row, status: 'revoked', revokedReason: 'admin_revocation' },
          request.tx,
        );
        if (changed) {
          revoked += 1;
        }
      }
      return okResponse(200, { staffId: staffId.value, revoked, scope: 'all_devices' });
    }),
  ];
}

/**
 * The stored hash an unknown contact is verified against, so a miss costs the
 * same time as a hit.
 *
 * A real scrypt digest rather than a constant: the point is to make the unknown
 * path do the *same work*, and a literal that scrypt short-circuits would defeat
 * that while still looking like the mitigation.
 */
const DUMMY_PASSWORD_HASH =
  'scrypt:32768:8:1$00000000000000000000000000000000$' +
  '0000000000000000000000000000000000000000000000000000000000000000';

/**
 * One refusal for every failure: unknown contact, wrong password, suspended
 * identity, unrecognised role.
 *
 * §9's rule, applied to a more sensitive directory. A moderator's existence is
 * not something this endpoint may confirm to whoever guesses an address.
 */
function signInFailed(): Result<never, DomainError> {
  return domainError('permission_denied', 'service.accounts', SIGN_IN_FAILED_COPY.body, {
    title: SIGN_IN_FAILED_COPY.title,
    reason: 'sign_in_failed',
  });
}

/**
 * Re-exported for the composition root: provisioning a moderator is a bootstrap
 * concern, not a request-time one, so it is not a route. `hashPassword` is
 * re-exported rather than imported by the caller directly so the one supported way
 * to create a staff credential is the function this route verifies against.
 */
export { hashPassword };
