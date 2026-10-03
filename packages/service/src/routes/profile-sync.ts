import { type DomainError, type PhotoId, type Result, type UserId, castId, ok } from '@been-there/core';
import type { ProfilePhotoRow, ProfileRow, Transaction } from '@been-there/contracts';
import {
  type PhotoApproval,
  type ProfileCompleteness,
  type ProfileContent,
  type ProfileState,
  evaluateProfileCompleteness,
  profileMachine,
} from '@been-there/dating';
import type { ServiceDependencies } from '../ports.js';
import { profileContentOf, profileStateOf } from '../wiring/standing.js';
import { createServiceSafety } from '../wiring/safety.js';

/**
 * The one place a profile row is written.
 *
 * Every path that can change a profile's completeness — a field edit, a photo
 * verdict, a photo removal — ends here, and here the state is *computed* from
 * `evaluateProfileCompleteness` and then fed to `profileMachine` as an event.
 * A route cannot write a state, which is what makes "the client cannot declare
 * itself complete" structural rather than a rule each route has to remember.
 */

/**
 * How a stored photo state reads in the profile content.
 *
 * `evaluateProfileCompleteness` counts only `approved`, so this projection is
 * load-bearing: a photo in `scanning` or `needs_human` arrives here as `pending`
 * and therefore does not count, which is the behaviour the profile spec asks for
 * without the service having to compute anything about counting. The two
 * vocabularies differ because the media machine also has `initiated` and
 * `needs_human`, and collapsing them to `pending` loses nothing a reader of the
 * profile needs — the exact state is on the photo route, which is where the
 * owner's audit trail lives.
 */
const APPROVAL_BY_PHOTO_STATE: Readonly<Record<ProfilePhotoRow['state'], PhotoApproval>> = {
  initiated: 'pending',
  scanning: 'pending',
  needs_human: 'pending',
  approved: 'approved',
  rejected: 'rejected',
};

/** The content a profile has before anything has been written to it. */
function emptyContent(): ProfileContent {
  return {
    displayName: '',
    bio: '',
    photos: [],
    prompts: [],
    genderIdentities: [],
    birthdate: null,
    location: null,
  };
}

/** The stored row's content, or an empty one for an owner who has never saved. */
function contentOf(row: ProfileRow | null, userId: UserId): ProfileContent {
  return row === null ? emptyContent() : profileContentOf(row.content, userId);
}

/** The state a row carries, or the machine's own initial state for a new profile. */
function stateOf(row: ProfileRow | null, userId: UserId): ProfileState {
  return row === null ? profileMachine.initial : profileStateOf(row.state, userId);
}

/** What a profile write produced: the stored row, and the completeness it earned. */
export interface SavedProfile {
  readonly row: ProfileRow;
  readonly completeness: ProfileCompleteness;
}

/**
 * The photo list as the domain reads it, from the photo table and never from the
 * request. The client's word about which of its photos are approved is not
 * evidence; the verdict is.
 */
async function photosFor(
  dependencies: ServiceDependencies,
  userId: UserId,
  tx: Transaction,
): Promise<ProfileContent['photos']> {
  const rows = await dependencies.stores.interaction.listProfilePhotos(userId, tx);
  return rows
    .filter((row) => row.state === 'approved')
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((row) => ({ photoId: castId<'PhotoId'>(row.photoId), approval: APPROVAL_BY_PHOTO_STATE[row.state] }));
}

/**
 * Writes the profile, with the photo list taken from the photo table and the
 * state derived from the result.
 *
 * `fields` is the partial the caller is changing; `photos` is supplied from the
 * table so a content write cannot silently drop somebody's photo, which is the
 * failure mode an edit-by-replacement would have.
 */
export async function saveProfile(
  dependencies: ServiceDependencies,
  userId: UserId,
  fields: Readonly<Partial<ProfileContent>>,
  at: Date,
  tx: Transaction,
): Promise<Result<SavedProfile, DomainError>> {
  const existing = await dependencies.stores.interaction.findProfile(userId, tx);
  const content: ProfileContent = {
    ...contentOf(existing, userId),
    ...fields,
    photos: await photosFor(dependencies, userId, tx),
  };
  const completeness = evaluateProfileCompleteness(content, at);
  const event = completeness.complete ? 'mark_complete' : 'mark_incomplete';
  const next = profileMachine.next(stateOf(existing, userId), event, {
    requirementsMet: completeness.complete,
  });
  if (!next.ok) {
    return next;
  }
  const row: ProfileRow = {
    // The id is derived from the user rather than minted per save, so a profile
    // that is edited a hundred times keeps the identity every photo and prompt
    // already points at.
    profileId: existing?.profileId ?? `profile:${userId}`,
    userId,
    state: next.value,
    content: { ...content },
    updatedAt: at,
  };
  await dependencies.stores.interaction.upsertProfile(row, tx);
  // Every profile write funnels through here — the content route and all three
  // photo routes — so this is the one place a profile change can be observed.
  // Without it `dating.profile_churn` is a detector the service can never fire,
  // and a detector in the catalogue the service cannot reach is a claim the
  // catalogue makes that the service contradicts.
  //
  // Only the fact that it changed crosses. Not `state`: the reduction row for
  // this kind deliberately keeps no account state, because a detector that could
  // read `limited`/`suspended`/`banned` would be one refactor from being an
  // enforcement engine.
  await createServiceSafety(dependencies).recorder.observe(
    { kind: 'profile.state_changed', userId, at },
    tx,
  );
  return ok({ row, completeness });
}
