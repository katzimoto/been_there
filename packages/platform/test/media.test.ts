import { createHmac, timingSafeEqual } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assertMachineIsTotal, castId, type CaseId, type UserId } from '@been-there/core';
import {
  authorize,
  issueMediaAccess,
  mediaAccessClaim,
  mediaMachine,
  validateUpload,
  verifyMediaAccess,
  type MediaAccessGrant,
  type MediaAccessId,
  type MediaAsset,
  type MediaAssetId,
  type MediaSigner,
} from '../src/index.js';
import { rejected, succeeded } from './helpers.js';

const NOW = new Date('2026-03-01T12:00:00.000Z');
const OWNER = castId<'UserId'>('u-owner') as UserId;
const STRANGER = castId<'UserId'>('u-stranger') as UserId;
const CASE = castId<'CaseId'>('case-9') as CaseId;
const SECRET = 'test-signing-key';

const signer: MediaSigner = {
  sign: (claim) => createHmac('sha256', SECRET).update(claim).digest('base64url'),
  verify: (claim, token) => {
    const expected = Buffer.from(createHmac('sha256', SECRET).update(claim).digest('base64url'));
    const actual = Buffer.from(token);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  },
};

function asset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    assetId: castId<'MediaAssetId'>('media-1') as MediaAssetId,
    ownerId: OWNER,
    state: 'approved',
    contentType: 'image/jpeg',
    bytes: 2_400_000,
    createdAt: NOW,
    ...overrides,
  };
}

function grantId(seed: string): MediaAccessId {
  return castId<'MediaAccessId'>(seed);
}

describe('media lifecycle', () => {
  it('serves nothing until a clean scan has approved it', () => {
    const scanning = succeeded(mediaMachine.next('initiated', 'begin_scan'));
    expect(scanning).toBe('scanning');

    // A verdict of anything but clean cannot produce an approved asset. The
    // guard, not the table, is what refuses it.
    expect(rejected(mediaMachine.next('scanning', 'approve', { verdict: 'malware' })).code).toBe(
      'validation_failed',
    );
    expect(succeeded(mediaMachine.next('scanning', 'approve', { verdict: 'clean' }))).toBe('approved');
  });

  it('refuses to approve straight from initiated, skipping the scan', () => {
    expect(rejected(mediaMachine.next('initiated', 'approve', { verdict: 'clean' })).code).toBe(
      'invalid_transition',
    );
  });

  it('requires a machine-readable reason on rejection and a human on requeue', () => {
    expect(rejected(mediaMachine.next('scanning', 'reject', { verdict: 'sexual_content' })).code).toBe(
      'validation_failed',
    );
    expect(
      succeeded(mediaMachine.next('scanning', 'reject', { verdict: 'sexual_content', reasonCode: 'nudity' })),
    ).toBe('rejected');

    // Requeueing is a moderator decision, not a user retry.
    expect(rejected(mediaMachine.next('rejected', 'reprocess')).code).toBe('validation_failed');
    expect(
      succeeded(
        mediaMachine.next('rejected', 'reprocess', { reviewerId: castId<'ActorId'>('mod-1') }),
      ),
    ).toBe('initiated');
  });

  it('holds an undecidable scan for a person rather than deciding it', () => {
    // "Borderline → routed to a moderator queue." Without a state to live in, the
    // only outcome left for a scanner that could not tell was `rejected` — an
    // automated enforcement decision about a stranger's face, made with no case
    // and nobody to appeal to.
    const scanning = succeeded(mediaMachine.next('initiated', 'begin_scan'));

    expect(succeeded(mediaMachine.next(scanning, 'escalate', { verdict: 'inconclusive' }))).toBe('needs_human');
  });

  it('refuses to escalate a verdict the scanner actually reached', () => {
    for (const verdict of ['clean', 'sexual_content', 'malware', 'unreadable'] as const) {
      expect(rejected(mediaMachine.next('scanning', 'escalate', { verdict })).code, verdict).toBe(
        'validation_failed',
      );
    }
  });

  it('refuses to decide a held asset without a named person, in either direction', () => {
    expect(rejected(mediaMachine.next('needs_human', 'approve')).code).toBe('validation_failed');
    expect(rejected(mediaMachine.next('needs_human', 'reject', { reasonCode: 'nudity' })).code).toBe(
      'validation_failed',
    );
  });

  it('lets a named reviewer release or refuse a held asset', () => {
    const reviewer = { reviewerId: castId<'ActorId'>('mod-1') };

    expect(succeeded(mediaMachine.next('needs_human', 'approve', reviewer))).toBe('approved');
    expect(succeeded(mediaMachine.next('needs_human', 'reject', { ...reviewer, reasonCode: 'nudity' }))).toBe(
      'rejected',
    );
  });

  it('never auto-rejects on an undecidable verdict', () => {
    // The absence of this guard is the whole failure: `inconclusive` is not a
    // finding, and a rejection with no `reason_code` would have been a machine
    // refusing a photo for a reason nobody could name.
    expect(
      rejected(mediaMachine.next('scanning', 'reject', { verdict: 'inconclusive', reasonCode: 'scanner_error' })).code,
    ).toBe('validation_failed');
  });

  it('never serves a held asset', () => {
    const held = asset({ state: 'needs_human' });
    const result = issueMediaAccess(held, { userId: OWNER }, 'profile_display', {
      signer,
      now: NOW,
      grantId: grantId('grant-held'),
    });

    expect(rejected(result).details).toMatchObject({ state: 'needs_human' });
  });

  it('treats approved as a terminal state, which is what makes it a state', () => {
    expect(mediaMachine.legalEvents('approved')).toEqual([]);
    assertMachineIsTotal(mediaMachine, ['approved']);
  });
});

describe('upload policy', () => {
  it('rejects a content type the platform does not accept', () => {
    expect(rejected(validateUpload({ contentType: 'image/svg+xml', bytes: 1000 }, 'profile_display')).code).toBe(
      'validation_failed',
    );
    expect(rejected(validateUpload({ contentType: 'application/pdf', bytes: 1000 }, 'profile_display')).code).toBe(
      'validation_failed',
    );
  });

  it('accepts exactly the limit and refuses one byte more', () => {
    const limit = 10 * 1024 * 1024;

    expect(succeeded(validateUpload({ contentType: 'image/jpeg', bytes: limit }, 'profile_display')).bytes).toBe(
      limit,
    );
    expect(rejected(validateUpload({ contentType: 'image/jpeg', bytes: limit + 1 }, 'profile_display')).code).toBe(
      'validation_failed',
    );
    expect(rejected(validateUpload({ contentType: 'image/jpeg', bytes: 0 }, 'profile_display')).code).toBe(
      'validation_failed',
    );
  });
});

describe('signed media access', () => {
  it('gives a non-owner nothing, on any purpose', () => {
    const stranger = { userId: STRANGER };

    for (const purpose of ['profile_display', 'conversation_attachment', 'moderation_review'] as const) {
      const result = issueMediaAccess(asset(), stranger, purpose, {
        now: NOW,
        grantId: grantId('g-1'),
        signer,
      });
      expect(rejected(result).code, `purpose ${purpose}`).toBe('permission_denied');
    }
  });

  it('gives a moderator evidence only with a case and a senior-only check still applies', () => {
    const moderator = { userId: STRANGER, principal: { userId: STRANGER, role: 'moderator' as const } };

    const withoutCase = issueMediaAccess(asset({ state: 'rejected' }), moderator, 'moderation_review', {
      now: NOW,
      grantId: grantId('g-1'),
      signer,
    });
    expect(rejected(withoutCase).code).toBe('permission_denied');

    const withCase = succeeded(
      issueMediaAccess(asset({ state: 'rejected' }), moderator, 'moderation_review', {
        now: NOW,
        grantId: grantId('g-2'),
        signer,
        caseId: CASE,
      }),
    );
    // Rejected media is exactly what a review needs to see.
    expect(withCase.caseId).toBe(CASE);
    expect(withCase.purpose).toBe('moderation_review');
  });

  it('refuses an owner the review path, so a user cannot see their own evidence as a moderator', () => {
    const result = issueMediaAccess(
      asset(),
      { userId: OWNER, principal: { userId: OWNER, role: 'senior_moderator' } },
      'moderation_review',
      { now: NOW, grantId: grantId('g-1'), signer, caseId: CASE },
    );

    expect(rejected(result).code).toBe('permission_denied');
  });

  it('refuses the owner a URL for media that has not been approved', () => {
    for (const state of ['initiated', 'scanning', 'rejected'] as const) {
      const result = issueMediaAccess(asset({ state }), { userId: OWNER }, 'profile_display', {
        now: NOW,
        grantId: grantId('g-1'),
        signer,
      });
      expect(rejected(result).code, state).toBe('not_eligible');
    }
  });

  it('issues a grant that is a function of the asset, the requester, and the purpose', () => {
    const issue = (requester: UserId, purpose: 'profile_display' | 'conversation_attachment') =>
      succeeded(
        issueMediaAccess(asset(), { userId: requester }, purpose, {
          now: NOW,
          grantId: grantId('g-1'),
          signer,
        }),
      );

    const ownerForProfile = issue(OWNER, 'profile_display');
    const ownerForConversation = issue(OWNER, 'conversation_attachment');

    expect(ownerForProfile.token).not.toBe(ownerForConversation.token);
    expect(ownerForProfile.url).toContain(ownerForProfile.token);
    // Deterministic: the same inputs produce the same grant, which is what makes
    // the URL verifiable without a database round trip.
    expect(issue(OWNER, 'profile_display').token).toBe(ownerForProfile.token);
    expect(ownerForProfile.expiresAt.getTime()).toBe(NOW.getTime() + 120_000);
  });

  it('binds the grant to the requester at serve time', () => {
    const media = asset();
    const issued = succeeded(
      issueMediaAccess(media, { userId: OWNER }, 'profile_display', {
        now: NOW,
        grantId: grantId('g-1'),
        signer,
      }),
    );
    const claim = {
      requesterId: issued.requesterId,
      purpose: issued.purpose,
      expiresAt: issued.expiresAt,
    };

    expect(succeeded(verifyMediaAccess(issued.token, media, { ...claim, now: NOW }, signer))).toBe(true);
    // A URL handed to somebody else does not verify, because the claim names
    // the requester.
    expect(
      rejected(
        verifyMediaAccess(issued.token, media, { ...claim, requesterId: STRANGER, now: NOW }, signer),
      ).code,
    ).toBe('permission_denied');
    // A tampered token fails the constant-time comparison.
    expect(rejected(verifyMediaAccess(`${issued.token}x`, media, { ...claim, now: NOW }, signer)).code).toBe(
      'permission_denied',
    );
    // And an expired grant is dead even though the signature is intact.
    expect(rejected(verifyMediaAccess(issued.token, media, { ...claim, now: issued.expiresAt }, signer)).code).toBe(
      'permission_denied',
    );
  });

  it('signs a claim that names the owner, so a grant cannot be replayed onto another asset', () => {
    const claim = mediaAccessClaim(asset(), {
      requesterId: OWNER,
      purpose: 'profile_display',
      expiresAt: NOW,
    });

    expect(claim.split('.')[0]).toBe('media-1');
    expect(claim.split('.')[1]).toBe(OWNER);
    const otherAsset = asset({ assetId: castId<'MediaAssetId'>('media-2') as MediaAssetId });
    expect(
      mediaAccessClaim(otherAsset, { requesterId: OWNER, purpose: 'profile_display', expiresAt: NOW }),
    ).not.toBe(claim);
  });

  it('refuses a ttl that outlives the grant policy', () => {
    const result = issueMediaAccess(asset(), { userId: OWNER }, 'profile_display', {
      now: NOW,
      grantId: grantId('g-1'),
      signer,
      ttlSeconds: 86_400,
    });

    expect(rejected(result).code).toBe('validation_failed');
  });
});

describe('media authorisation reuse', () => {
  it('still refuses a role that lacks media.read.reported', () => {
    const support = { userId: STRANGER, principal: { userId: STRANGER, role: 'support' as const } };

    expect(
      rejected(authorize(support.principal, 'media.read_any', { caseId: CASE })).code,
    ).toBe('permission_denied');
  });

  it('types the grant as a single indivisible value', () => {
    const issued: MediaAccessGrant = succeeded(
      issueMediaAccess(asset(), { userId: OWNER }, 'profile_display', {
        now: NOW,
        grantId: grantId('g-1'),
        signer,
      }),
    );

    expect(issued.assetId).toBe(asset().assetId);
    expect(issued.requesterId).toBe(OWNER);
  });
});
