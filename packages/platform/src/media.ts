import {
  type ActorId,
  type CaseId,
  type CorrelationId,
  type DomainError,
  type Result,
  type UserId,
  domainError,
  ok,
  type StateMachine,
  defineStateMachine,
} from '@been-there/core';
import { type MediaAccessId, type MediaAssetId, asActorId, asSubjectId } from './ids.js';
import { type ProtectedAction, type Principal, authorize } from './authz.js';
import { type AuditAction, type AuditAppendRequest } from './audit.js';
import { type ClassifiedRecord, classify } from './redaction.js';

/**
 * Media lifecycle. Nothing is servable until a scanner has cleared it, and the
 * table makes "who can put this asset back into the pipeline" a reviewable line
 * rather than an `if` somewhere in a service.
 */
/**
 * `needs_human` is not servable and is not the user's problem: the asset is held
 * out of the live set while a person answers, and the owner is told it is "being
 * checked" rather than that it failed. Without the state, a borderline photo
 * would be auto-rejected by a scanner that was not confident — an enforcement
 * decision a machine made about a stranger's face, with no case and nobody to
 * appeal to.
 */
export type MediaState = 'initiated' | 'scanning' | 'needs_human' | 'approved' | 'rejected';

export type MediaEvent = 'begin_scan' | 'escalate' | 'approve' | 'reject' | 'reprocess';

/**
 * `inconclusive` is the verdict a scanner returns when it could not decide, as
 * distinct from one it decided. The distinction is the difference between "this
 * photo breaks a rule" — which the machine may say, because the rule is a
 * published list and the user is told which one — and "this photo might break a
 * rule" — which nobody but a person should say, because a wrong guess about a
 * stranger's face is not recoverable by an appeal the user never knew to make.
 */
export type ScanVerdict = 'clean' | 'malware' | 'sexual_content' | 'unreadable' | 'inconclusive';

export interface MediaContext {
  readonly verdict?: ScanVerdict;
  readonly reasonCode?: string;
  /** Required to requeue a rejection, and to release or refuse a held asset. */
  readonly reviewerId?: ActorId;
}

export const mediaMachine: StateMachine<MediaState, MediaEvent, MediaContext> =
  defineStateMachine<MediaState, MediaEvent, MediaContext>({
    domain: 'media',
    initial: 'initiated',
    transitions: [
      { event: 'begin_scan', from: ['initiated'], to: 'scanning' },
      {
        event: 'escalate',
        from: ['scanning'],
        to: 'needs_human',
        guard: (ctx) => ctx?.verdict === 'inconclusive',
        note: 'An undecidable scan is a decision for a person. No other verdict may take this edge.',
      },
      {
        event: 'approve',
        from: ['scanning'],
        to: 'approved',
        guard: (ctx) => ctx?.verdict === 'clean',
        note: 'Only a clean verdict produces servable media.',
      },
      {
        event: 'approve',
        from: ['needs_human'],
        to: 'approved',
        guard: (ctx) => ctx?.reviewerId !== undefined,
        note: 'A held asset is released by a named person, never by a retry.',
      },
      {
        event: 'reject',
        from: ['scanning'],
        to: 'rejected',
        guard: (ctx) =>
          ctx?.verdict !== undefined &&
          ctx?.verdict !== 'clean' &&
          ctx?.verdict !== 'inconclusive' &&
          ctx?.reasonCode !== undefined,
        note: 'A rejection always carries a machine-readable reason, and never a verdict of "clean" or of "could not tell".',
      },
      {
        event: 'reject',
        from: ['needs_human'],
        to: 'rejected',
        guard: (ctx) => ctx?.reviewerId !== undefined && ctx?.reasonCode !== undefined,
        note: 'Refusing a held asset is a moderation decision and is recorded as one.',
      },
      {
        event: 'reprocess',
        from: ['rejected'],
        to: 'initiated',
        guard: (ctx) => ctx?.reviewerId !== undefined,
        note: 'Requeueing a rejected asset is a moderator decision, not a user retry.',
      },
    ],
  });

export const MEDIA_POLICY = {
  /** 10 MB. Large enough for a modern phone photo, small enough that a scan is cheap. */
  maxBytes: 10 * 1024 * 1024,
  allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp'] as const,
  /** Purpose-specific maxima: evidence review never needs the original. */
  maxBytesByPurpose: {
    profile_display: 10 * 1024 * 1024,
    conversation_attachment: 10 * 1024 * 1024,
    moderation_review: 10 * 1024 * 1024,
  } as const,
} as const;

export type MediaPurpose = keyof typeof MEDIA_POLICY.maxBytesByPurpose;

export function validateUpload(
  candidate: { readonly contentType: string; readonly bytes: number },
  purpose: MediaPurpose,
): Result<{ readonly contentType: string; readonly bytes: number }, DomainError> {
  if (!(MEDIA_POLICY.allowedContentTypes as readonly string[]).includes(candidate.contentType)) {
    return domainError('validation_failed', 'platform', 'content type is not accepted', {
      contentType: candidate.contentType,
    });
  }
  const limit = MEDIA_POLICY.maxBytesByPurpose[purpose];
  if (candidate.bytes <= 0) {
    return domainError('validation_failed', 'platform', 'upload is empty', { bytes: candidate.bytes });
  }
  if (candidate.bytes > limit) {
    return domainError('validation_failed', 'platform', 'upload exceeds the size limit', {
      bytes: candidate.bytes,
      limit,
    });
  }
  return ok(candidate);
}

export interface MediaAsset {
  readonly assetId: MediaAssetId;
  readonly ownerId: UserId;
  readonly state: MediaState;
  readonly contentType: string;
  readonly bytes: number;
  readonly createdAt: Date;
  readonly verdict?: ScanVerdict;
  readonly scanProviderRequestId?: string;
}

/**
 * A time-boxed, requester-bound grant to read one asset. There is no other way
 * to obtain a URL for media: the asset record itself carries no address, so a
 * public bucket URL cannot be constructed from stored state even by mistake.
 */
export interface MediaAccessGrant {
  readonly grantId: MediaAccessId;
  readonly assetId: MediaAssetId;
  readonly requesterId: UserId;
  readonly purpose: MediaPurpose;
  readonly token: string;
  readonly url: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly caseId?: CaseId;
}

export const MEDIA_GRANT_TTL_SECONDS = 120;

/**
 * Signing is injected rather than imported. The platform owns the claim format
 * and the authorisation decision; the key and the MAC live in the deployment's
 * key management, and no domain should be able to mint a URL by reaching for a
 * crypto helper.
 */
export interface MediaSigner {
  sign(claim: string): string;
  /** Constant-time comparison; the interface says so because `!==` is not. */
  verify(claim: string, token: string): boolean;
}

const GRANT_ORIGIN = 'https://media.been-there.invalid';

/**
 * The canonical claim. Exported so an adapter can recompute it during
 * verification, and so the string a key signs is reviewable in one place.
 */
export function mediaAccessClaim(
  asset: Pick<MediaAsset, 'assetId' | 'ownerId'>,
  request: { readonly requesterId: UserId; readonly purpose: MediaPurpose; readonly expiresAt: Date },
): string {
  return [
    asset.assetId,
    asset.ownerId,
    request.requesterId,
    request.purpose,
    request.expiresAt.toISOString(),
  ].join('.');
}

/**
 * Issues a signed, expiring URL — the single choke point for media reads.
 *
 * A non-owner gets nothing. The only non-owner path is `moderation_review`,
 * which requires both a named case and the `media.read_any` permission, so a
 * moderator can look at reported material and a curious colleague cannot look at
 * anything else.
 */
export function issueMediaAccess(
  asset: MediaAsset,
  requester: { readonly userId: UserId; readonly principal?: Principal },
  purpose: MediaPurpose,
  deps: {
    readonly now: Date;
    readonly grantId: MediaAccessId;
    readonly signer: MediaSigner;
    readonly ttlSeconds?: number;
    readonly caseId?: CaseId;
  },
): Result<MediaAccessGrant, DomainError> {
  if (asset.ownerId === requester.userId) {
    if (purpose === 'moderation_review') {
      // An owner has no business reviewing their own evidence: that would be a
      // way to see a restricted asset through an unmoderated door.
      return domainError('permission_denied', 'platform', 'owners cannot use the review path', {
        purpose,
      });
    }
    if (asset.state !== 'approved') {
      return domainError('not_eligible', 'platform', 'media is not approved', {
        state: asset.state,
      });
    }
  } else {
    if (purpose !== 'moderation_review') {
      return domainError('permission_denied', 'platform', 'media belongs to another user', {
        purpose,
      });
    }
    if (requester.principal === undefined) {
      return domainError('permission_denied', 'platform', 'review requires a role', { purpose });
    }
    const decision = authorize(requester.principal, 'media.read_any', {
      ...(deps.caseId === undefined ? {} : { caseId: deps.caseId }),
    });
    if (!decision.ok) {
      return decision;
    }
  }

  const ttl = deps.ttlSeconds ?? MEDIA_GRANT_TTL_SECONDS;
  if (ttl <= 0 || ttl > MEDIA_GRANT_TTL_SECONDS) {
    return domainError('validation_failed', 'platform', 'grant ttl out of range', { ttlSeconds: ttl });
  }

  const expiresAt = new Date(deps.now.getTime() + ttl * 1000);
  const claim = mediaAccessClaim(asset, { requesterId: requester.userId, purpose, expiresAt });
  const token = deps.signer.sign(claim);
  return ok({
    grantId: deps.grantId,
    assetId: asset.assetId,
    requesterId: requester.userId,
    purpose,
    token,
    url: `${GRANT_ORIGIN}/${asset.assetId}?purpose=${purpose}&grant=${token}`,
    issuedAt: deps.now,
    expiresAt,
    ...(deps.caseId === undefined ? {} : { caseId: deps.caseId }),
  });
}

/**
 * The serve path. A request is answered only when the token is intact, the
 * claim matches this asset and this requester, and the grant has not expired —
 * re-authorising at serve time is what makes a leaked URL stop working when the
 * asset is later rejected.
 */
export function verifyMediaAccess(
  token: string,
  asset: MediaAsset,
  request: {
    readonly requesterId: UserId;
    readonly purpose: MediaPurpose;
    readonly expiresAt: Date;
    readonly now: Date;
  },
  signer: MediaSigner,
): Result<true, DomainError> {
  if (!signer.verify(mediaAccessClaim(asset, request), token)) {
    return domainError('permission_denied', 'platform', 'media grant is not valid for this request', {
      assetId: asset.assetId,
    });
  }
  if (request.now.getTime() >= request.expiresAt.getTime()) {
    return domainError('permission_denied', 'platform', 'media grant expired', {
      assetId: asset.assetId,
    });
  }
  return ok(true);
}

/**
 * The audit facts around a media decision. `issued` and `denied` are separate
 * actions because "who tried to read this and was refused" is the signal worth
 * keeping, and it is invisible if the log only records successes.
 */
export function mediaAccessAuditRequest(
  action: Extract<AuditAction, `media.${string}`>,
  detail: {
    readonly assetId: MediaAssetId;
    readonly ownerId: UserId;
    readonly requesterId: UserId;
    readonly purpose: MediaPurpose;
    readonly state?: MediaState;
    readonly caseId?: CaseId;
  },
  occurredAt: Date,
  correlationId: CorrelationId,
): AuditAppendRequest {
  const fields: ClassifiedRecord = [
    classify('asset_id', 'internal', detail.assetId),
    classify('owner_id', 'user', detail.ownerId),
    classify('requester_id', 'user', detail.requesterId),
    classify('purpose', 'internal', detail.purpose),
    ...(detail.state === undefined ? [] : [classify('media_state', 'internal', detail.state)]),
    ...(detail.caseId === undefined ? [] : [classify('case_id', 'restricted', detail.caseId)]),
  ];
  return {
    action,
    actorId: asActorId(detail.requesterId),
    subjectId: asSubjectId(detail.ownerId),
    ...(detail.caseId === undefined ? {} : { caseId: detail.caseId }),
    occurredAt,
    correlationId,
    fields,
  };
}
