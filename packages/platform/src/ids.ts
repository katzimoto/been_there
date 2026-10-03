import { type ActorId, type SubjectId, type UserId, castId } from '@been-there/core';

/**
 * The audit twin of `asSubjectId`: who did it. Kept beside it because the two
 * are always written together, and a record whose actor and subject are the
 * same person still has to cross the brands separately.
 */
export function asActorId(userId: UserId): ActorId {
  return castId<'ActorId'>(userId);
}

/**
 * A user is the subject of nearly every audit fact in the system, but `UserId`
 * and `SubjectId` are deliberately different brands: a subject can also be a
 * match, a conversation, or a photo. This is the one audited crossing point
 * from "the person" to "the thing the record is about", and it exists so the
 * cast appears in a reviewed file rather than at every append site.
 */
export function asSubjectId(userId: UserId): SubjectId {
  return castId<'SubjectId'>(userId);
}

/**
 * Platform-owned identifiers. Each is still constructed through core's single
 * `castId` crossing point (`castId<'SessionId'>('sess-1')`), so the brand here
 * and the brands in `@been-there/core` are made by the same validation home.
 *
 * `castId` is generic, so the resulting brand is named through an instantiation
 * expression rather than a `unique symbol` this package cannot see. All such
 * aliases live in this file for that reason — there is exactly one place where
 * the platform invents an id vocabulary.
 */

export type SessionId = ReturnType<typeof castId<'SessionId'>>;
export type RecoveryId = ReturnType<typeof castId<'RecoveryId'>>;
export type AuditId = ReturnType<typeof castId<'AuditId'>>;
export type MediaAssetId = ReturnType<typeof castId<'MediaAssetId'>>;
export type MediaAccessId = ReturnType<typeof castId<'MediaAccessId'>>;
export type LocationAnchorId = ReturnType<typeof castId<'LocationAnchorId'>>;
export type IntegrationRequestId = ReturnType<typeof castId<'IntegrationRequestId'>>;
export type NotificationId = ReturnType<typeof castId<'NotificationId'>>;

/**
 * A staff identity: a named human who may hold a staff session.
 *
 * Deliberately not a `UserId`. A moderator is a person, but not a *member* — the
 * two are different facts with different consequences, and the whole argument for
 * a discriminated session subject rests on their being distinguishable. Minting
 * one from the other is a `castId` away, which is exactly why the column, the
 * CHECK constraint and the resolver all name the distinction rather than relying
 * on the type to hold.
 */
export type StaffId = ReturnType<typeof castId<'StaffId'>>;
