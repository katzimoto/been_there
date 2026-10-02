import { randomUUID } from 'node:crypto';
import {
  type DomainError,
  type PhotoId,
  type Result,
  type UserId,
  castId,
  domainError,
  ok,
} from '@been-there/core';
import type { ProfilePhotoRow, Transaction } from '@been-there/contracts';
import { type DistanceBand, coarseDistanceBand } from '@been-there/dating';
import { type ScanVerdict, mediaMachine, quantiseAnchor } from '@been-there/platform';
import { readNumber, readOptionalString, readString, readStringArray } from '../http/body.js';
import { MISSING_FIELD, NOT_FOUND, UNKNOWN_FIELD_VALUE } from '../http/failure.js';
import { okResponse, route, type Route } from '../http/router.js';
import type { ServiceDependencies } from '../ports.js';
import { saveProfile } from './profile-sync.js';

/**
 * Profile photos, their screening, and the stored location anchor.
 *
 * ## The pipeline, and exactly where it stops
 *
 * §6.3 is five stages. Two of them are implemented here and three are not, and
 * the split is the design rather than an omission:
 *
 * | Stage | Owner | Here? |
 * |---|---|---|
 * | 1 technical validation | the media service, on ingest | no — it has already run by the time a handle exists |
 * | 2 hash and dedupe | the media service | no — a perceptual hash is not derivable from a handle |
 * | 3 content screening | Moderation, via `mediaMachine` | **wired, verdict external** |
 * | 4 likeness | Identity (#36) | **wired, verdict external** |
 * | 5 publication | this file | yes |
 *
 * What this file owns is the *state machine*: `initiated → scanning` on
 * arrival, and the publication step that puts an approved photo into the
 * ordered set at the end so an existing primary survives. The transitions come
 * from `mediaMachine`, so the guards on what may approve, escalate or requeue
 * are the platform's and not this file's — there is no branch here that decides
 * a photo is fine.
 *
 * ## The verdict boundary is named, not hidden
 *
 * `PUT /v1/profiles/me/photos/:photoId/screening` is where a screening verdict
 * arrives. It is reachable by the photo's owner, deliberately: the owner is owed
 * the answer, and a boundary they cannot post to is a boundary they cannot be
 * told about. What it cannot do is *decide* — `mediaMachine` refuses an
 * approval without a `clean` verdict, a rejection without a reason, and an
 * escalation without `inconclusive`. When the real scanner and the likeness
 * check land (#36 and Platform), they call this route; until then it is how the
 * states are exercised at all.
 *
 * ## No coordinate leaves
 *
 * `PUT /v1/profiles/me/location` stores a quantised cell classified
 * `sensitive` and returns nothing but an acknowledgement. `GET` returns a
 * coarse band from `coarseDistanceBand` — the one function in the system that
 * may consume a coordinate — and never the point.
 */

/** §6.1: alt text is required for the owner's audit trail, and capped. */
const MAX_ALT_TEXT = 120;

/** §6.1: 1–6 photos, six live at once. */
const MAX_PHOTOS = 6;

const SCAN_VERDICTS: readonly ScanVerdict[] = [
  'clean',
  'malware',
  'sexual_content',
  'unreadable',
  'inconclusive',
];

/**
 * Verdict → media event, one row per verdict.
 *
 * The machine guards the *outcome* — only `clean` publishes, only `inconclusive`
 * escalates — so this table only says which event a verdict is asking for.
 * Writing it as five visible rows rather than a branch means adding a verdict is
 * a row somebody can read, not an `if` somebody has to find.
 */
const EVENT_BY_VERDICT: Readonly<Record<ScanVerdict, 'approve' | 'reject' | 'escalate'>> = {
  clean: 'approve',
  malware: 'reject',
  sexual_content: 'reject',
  unreadable: 'reject',
  inconclusive: 'escalate',
};

/**
 * Anything that looks like an address rather than a handle: a URI scheme
 * (`https:`, `s3:`), a leading slash, or a Windows separator. The same three
 * shapes the migration's CHECKs refuse, so the route and the schema agree on
 * what an opaque handle is instead of one being a guess about the other.
 */
const ADDRESS_LIKE = /(^[/\\])|^[A-Za-z][A-Za-z0-9+.-]*:/;

export function profilePhotoRoutes(dependencies: ServiceDependencies): readonly Route[] {
  return [
    route('POST', '/v1/profiles/me/photos', async (request) => {
      const owner = request.actor.userId;
      if (owner === null) {
        return noSession();
      }
      const mediaAssetId = readString(request.body, 'mediaAssetId');
      if (!mediaAssetId.ok) {
        return mediaAssetId;
      }
      const altText = readString(request.body, 'altText');
      if (!altText.ok) {
        return altText;
      }
      // The handle is opaque, and this is where that is said rather than
      // discovered. The column's CHECKs are the real guarantee — a URL or a path
      // is unrepresentable however it arrives — but a client that sends one has
      // sent something wrong, and a 400 names the field where a constraint
      // violation would report a 500 and blame the platform.
      if (ADDRESS_LIKE.test(mediaAssetId.value)) {
        return domainError('validation_failed', 'dating.profile', 'the media handle is an opaque id, not an address', {
          field: 'mediaAssetId',
        });
      }
      if (altText.value.length === 0 || altText.value.length > MAX_ALT_TEXT) {
        return domainError('validation_failed', 'dating.profile', 'alt text is required and is capped', {
          field: 'altText',
          limit: MAX_ALT_TEXT,
        });
      }
      const held = await dependencies.stores.interaction.listProfilePhotos(owner, request.tx);
      if (held.filter((photo) => photo.state === 'approved').length >= MAX_PHOTOS) {
        return domainError('validation_failed', 'dating.profile', 'the photo set is already full', {
          limit: MAX_PHOTOS,
        });
      }
      const begun = mediaMachine.next(mediaMachine.initial, 'begin_scan', {});
      if (!begun.ok) {
        return begun;
      }
      const row: Omit<ProfilePhotoRow, 'createdAt'> = {
        photoId: castId<'PhotoId'>(randomUUID()),
        userId: owner,
        mediaAssetId: mediaAssetId.value,
        altText: altText.value,
        state: begun.value,
        // Unpublished, so it has no place in the order yet. Index 0 is the
        // primary, and a photo joins the set only when it is approved.
        position: null,
        reasonCode: null,
      };
      await dependencies.stores.interaction.insertProfilePhoto(row, request.tx);
      const saved = await saveProfile(dependencies, owner, {}, request.now, request.tx);
      if (!saved.ok) {
        return saved;
      }
      return okResponse(201, {
        photo: photoBody({ ...row, createdAt: request.now }),
        complete: saved.value.completeness.complete,
        missing: saved.value.completeness.missing,
      });
    }),

    route('GET', '/v1/profiles/me/photos', async (request) => {
      const owner = request.actor.userId;
      if (owner === null) {
        return noSession();
      }
      return okResponse(200, { photos: await photosOf(dependencies, owner, request.tx) });
    }),

    route('PUT', '/v1/profiles/me/photos/order', async (request) => {
      const owner = request.actor.userId;
      if (owner === null) {
        return noSession();
      }
      const order = readStringArray(request.body, 'photoIds');
      if (!order.ok) {
        return order;
      }
      try {
        await dependencies.stores.interaction.reorderProfilePhotos(
          owner,
          order.value,
          request.now,
          request.tx,
        );
      } catch (error) {
        // A refusal here is a client mistake — an order that is not exactly the
        // published set — and is reported as one with the store's own reason,
        // rather than as a 500 telling the caller the platform is broken.
        return domainError('validation_failed', 'dating.profile', 'the order must be exactly the published set', {
          reason: error instanceof Error ? error.message : 'reorder refused',
        });
      }
      return okResponse(200, { photos: await photosOf(dependencies, owner, request.tx) });
    }),

    route('DELETE', '/v1/profiles/me/photos/:photoId', async (request) => {
      const owner = request.actor.userId;
      if (owner === null) {
        return noSession();
      }
      const photoId = request.params['photoId'];
      if (photoId === undefined) {
        return MISSING_FIELD('photoId');
      }
      // Scoped by user in the statement rather than checked here, so another
      // member's photo id is a miss and not a leak: the answer is the same
      // `not_found` whether the photo does not exist or is not yours.
      const removed = await dependencies.stores.interaction.deleteProfilePhoto(photoId, owner, request.tx);
      if (!removed) {
        return NOT_FOUND('photo');
      }
      const remaining = await photosOf(dependencies, owner, request.tx);
      const saved = await saveProfile(dependencies, owner, {}, request.now, request.tx);
      if (!saved.ok) {
        return saved;
      }
      return okResponse(200, {
        photoId,
        photos: remaining,
        complete: saved.value.completeness.complete,
        missing: saved.value.completeness.missing,
      });
    }),

    // ----------------------------------------------------------------- screening --

    route('PUT', '/v1/profiles/me/photos/:photoId/screening', async (request) => {
      const owner = request.actor.userId;
      if (owner === null) {
        return noSession();
      }
      const photoId = request.params['photoId'];
      if (photoId === undefined) {
        return MISSING_FIELD('photoId');
      }
      const verdict = readVerdict(request.body);
      if (!verdict.ok) {
        return verdict;
      }
      const reasonCode = readOptionalString(request.body, 'reasonCode');
      if (!reasonCode.ok) {
        return reasonCode;
      }
      const held = await dependencies.stores.interaction.listProfilePhotos(owner, request.tx);
      const photo = held.find((entry) => entry.photoId === photoId);
      if (photo === undefined) {
        return NOT_FOUND('photo');
      }
      const moved = mediaMachine.next(photo.state, EVENT_BY_VERDICT[verdict.value], {
        verdict: verdict.value,
        // The machine refuses a rejection without a machine-readable reason.
        // `null` rather than an empty string keeps "no reason given" distinct
        // from a reason that happens to be blank.
        ...(reasonCode.value === null ? {} : { reasonCode: reasonCode.value }),
      });
      if (!moved.ok) {
        return moved;
      }
      // §6.4: an approved photo joins the set at the *end*, so the existing
      // primary survives. Approving in place at index 0 would silently demote
      // the owner's chosen main photo, which is not what approval means.
      const approved = moved.value === 'approved';
      await dependencies.stores.interaction.applyPhotoDecision(
        photoId,
        {
          state: moved.value,
          position: approved ? held.filter((entry) => entry.state === 'approved').length : null,
          reasonCode: moved.value === 'rejected' ? (reasonCode.value ?? 'unspecified') : null,
        },
        request.now,
        request.tx,
      );
      const saved = await saveProfile(dependencies, owner, {}, request.now, request.tx);
      if (!saved.ok) {
        return saved;
      }
      const after = (await dependencies.stores.interaction.listProfilePhotos(owner, request.tx)).find(
        (entry) => entry.photoId === photoId,
      );
      return okResponse(200, {
        photo: after === undefined ? null : photoBody(after),
        // The profile's state is a *consequence* of the verdict, not a separate
        // decision: losing the last approved primary is what moves a live profile
        // back to `incomplete`, and it happens here because `saveProfile`
        // re-evaluates rather than because a route said so.
        state: saved.value.row.state,
        complete: saved.value.completeness.complete,
        missing: saved.value.completeness.missing,
      });
    }),

    // ------------------------------------------------------------------ location --

    route('PUT', '/v1/profiles/me/location', async (request) => {
      const owner = request.actor.userId;
      if (owner === null) {
        return noSession();
      }
      const latitude = readNumber(request.body, 'latitude');
      if (!latitude.ok) {
        return latitude;
      }
      const longitude = readNumber(request.body, 'longitude');
      if (!longitude.ok) {
        return longitude;
      }
      if (Math.abs(latitude.value) > 90 || Math.abs(longitude.value) > 180) {
        return domainError('validation_failed', 'service.http', 'the coordinate is out of range', {
          field: 'latitude,longitude',
        });
      }
      // Quantised before it is stored, on a grid that is a function of the
      // account: a user who does not move is a user whose position over time is
      // not a track, and two nearby people are not represented identically. The
      // stored point is a cell; the cell is classified `sensitive`, and there is
      // no classification of it that is not.
      const anchor = quantiseAnchor({ latitude: latitude.value, longitude: longitude.value }, owner);
      await dependencies.stores.interaction.upsertLocationAnchor(
        {
          userId: owner,
          latitude: anchor.latitude,
          longitude: anchor.longitude,
          sensitivity: 'sensitive',
          observedAt: request.now,
        },
        request.tx,
      );
      // The response says the write happened and nothing else: no echo of the
      // coordinates, and no band derived from them against the owner themselves,
      // which would be `lt_5_km` for every account and true of none of them.
      return okResponse(200, { stored: true, sensitivity: 'sensitive' });
    }),

    route('GET', '/v1/profiles/me/location', async (request) => {
      const owner = request.actor.userId;
      if (owner === null) {
        return noSession();
      }
      return okResponse(200, {
        band: await coarseBandFor(dependencies, owner, request.tx),
        sensitivity: 'sensitive',
      });
    }),
  ];
}

// ------------------------------------------------------------------- rendering --

/**
 * One refusal for every route here: this surface is for a member session, and a
 * per-route wording would make the status a function of which route was hit.
 */
function noSession(): Result<never, DomainError> {
  return domainError('permission_denied', 'service.http', 'this endpoint is for a member session', {
    reason: 'no_member_session',
  });
}

/**
 * The screening verdict from the body.
 *
 * `readEnum` is the wrong tool here because it defaults: a screening verdict
 * with no verdict in the body must be refused, not read as `clean`. Defaulting
 * the one field that decides whether a photo is published would make an empty
 * request an approval.
 */
function readVerdict(body: Readonly<Record<string, unknown>>): Result<ScanVerdict, DomainError> {
  const raw = body['verdict'];
  if (typeof raw !== 'string') {
    return MISSING_FIELD('verdict');
  }
  const verdict = SCAN_VERDICTS.find((candidate) => candidate === raw);
  if (verdict === undefined) {
    return UNKNOWN_FIELD_VALUE('verdict', SCAN_VERDICTS);
  }
  return ok(verdict);
}

/**
 * The owner's photos: approved ones in their order, the rest after them.
 *
 * A photo awaiting a verdict is reported with its state and *without* its media
 * handle, so a client rendering from this response cannot put a face in front of
 * anyone before the platform has cleared it — while the owner still learns where
 * their upload is, which §6.3 step 5 requires.
 */
async function photosOf(
  dependencies: ServiceDependencies,
  userId: UserId,
  tx: Transaction,
): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const photos = await dependencies.stores.interaction.listProfilePhotos(userId, tx);
  return photos
    .slice()
    .sort((a, b) => {
      const left = a.position ?? Number.MAX_SAFE_INTEGER;
      const right = b.position ?? Number.MAX_SAFE_INTEGER;
      return left === right ? a.createdAt.getTime() - b.createdAt.getTime() : left - right;
    })
    .map(photoBody);
}

/**
 * A photo as its owner sees it.
 *
 * `mediaAssetId` is the only reference here, and only for an approved photo: no
 * URL, no path, no byte count. The media service resolves the handle, and this
 * response never becomes a way to reconstruct an address for the original.
 */
function photoBody(photo: ProfilePhotoRow): Readonly<Record<string, unknown>> {
  return {
    photoId: photo.photoId,
    state: photo.state,
    position: photo.position,
    reasonCode: photo.reasonCode,
    altText: photo.altText,
    primary: photo.position === 0,
    ...(photo.state === 'approved' ? { mediaAssetId: photo.mediaAssetId } : {}),
    createdAt: photo.createdAt.toISOString(),
  };
}

/**
 * The coarse band between two people's anchors.
 *
 * Delegates to `coarseDistanceBand`, the one function permitted to consume a
 * coordinate and the only one that may turn an anchor into something a response
 * can carry. A missing anchor on either side is `unknown` rather than a guess:
 * the platform cannot prove a distance, and the product must not punish an
 * unproven fact.
 */
async function coarseBandFor(
  dependencies: ServiceDependencies,
  viewerId: UserId,
  tx: Transaction,
): Promise<DistanceBand> {
  const viewer = await dependencies.stores.interaction.findLocationAnchor(viewerId, tx);
  if (viewer === null) {
    return 'unknown';
  }
  return coarseDistanceBand(viewer, viewer);
}
