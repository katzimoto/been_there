import { describe, expect, it } from 'vitest';
import {
  type IdentityState,
  type VerificationId,
  castId,
  isDiscoverableIdentity,
} from '@been-there/core';
import {
  IDENTITY_PROJECTION_VERSION,
  type IdentityStatusProjection,
  hasProjectionChanged,
  projectIdentityStatus,
  toIdentityRecord,
} from '../src/index.js';
import { SUBJECT, T0 } from './support.js';

/**
 * Type-level separation. `NotAKey` resolves to `true` only when the field is
 * absent from the projection, so declaring the constant below fails the build
 * the moment someone adds a leaky field to the public read-model — a leak
 * becomes a compile error rather than a review catch.
 */
type NotAKey<T, K extends string> = K extends keyof T ? never : true;

const noEvidenceField: NotAKey<IdentityStatusProjection, 'evidence'> = true;
const noConfidenceField: NotAKey<IdentityStatusProjection, 'confidence'> = true;
const noAnomalyField: NotAKey<IdentityStatusProjection, 'anomalies'> = true;
const noProviderField: NotAKey<IdentityStatusProjection, 'providerReference'> = true;
const noVerificationIdField: NotAKey<IdentityStatusProjection, 'latestVerificationId'> = true;
const noReviewerField: NotAKey<IdentityStatusProjection, 'reviewerId'> = true;

const ALL_STATES: readonly IdentityState[] = [
  'unverified',
  'pending',
  'verified',
  'review_required',
  'verification_failed',
  'expired',
];

const project = (
  state: IdentityState,
  generation: number,
  verificationId: VerificationId | null = null,
) =>
  projectIdentityStatus({ state, latestVerificationId: verificationId, generation }, SUBJECT, T0);

describe('public projection', () => {
  it('exposes exactly the agreed fields', () => {
    expect(Object.keys(project('verified', 2)).sort()).toEqual([
      'discoverable',
      'generation',
      'projectionVersion',
      'state',
      'subjectId',
      'updatedAt',
    ]);
    expect(project('verified', 2).projectionVersion).toBe(IDENTITY_PROJECTION_VERSION);
  });

  it('has no field that could carry identity internals', () => {
    expect([
      noEvidenceField,
      noConfidenceField,
      noAnomalyField,
      noProviderField,
      noVerificationIdField,
      noReviewerField,
    ]).toEqual([true, true, true, true, true, true]);
  });

  it('marks only verified discoverable, and agrees with the kernel predicate', () => {
    for (const state of ALL_STATES) {
      const projection = project(state, 1);
      expect(projection.discoverable).toBe(state === 'verified');
      expect(isDiscoverableIdentity(toIdentityRecord(projection))).toBe(projection.discoverable);
    }
  });

  it('drops the internal verification id when rebuilding a kernel record', () => {
    const withInternalId = projectIdentityStatus(
      {
        state: 'verified',
        latestVerificationId: castId<'VerificationId'>('vrf-internal'),
        generation: 4,
      },
      SUBJECT,
      T0,
    );
    const rebuilt = toIdentityRecord(withInternalId);
    expect(rebuilt.latestVerificationId).toBeNull();
    expect(rebuilt.generation).toBe(4);
    expect(isDiscoverableIdentity(rebuilt)).toBe(true);
  });

  it('is unprojectable from a projection — the record shape is the only way in', () => {
    // The projection has no VerificationId to rebuild an IdentityRecord from,
    // which is why consumers go through `toIdentityRecord` rather than
    // assembling one themselves.
    expect(Object.keys(toIdentityRecord(project('pending', 1))).sort()).toEqual([
      'generation',
      'latestVerificationId',
      'state',
    ]);
  });
});

describe('staleness', () => {
  it('treats a same-generation rebuild as unchanged, by contract', () => {
    // Generations are the staleness contract. A projection rebuilt with a new
    // timestamp but the same generation carries the same status, so a consumer
    // must not be woken up for it.
    const before = project('verified', 7);
    const after = projectIdentityStatus(
      { state: 'verified', latestVerificationId: null, generation: 7 },
      SUBJECT,
      new Date(T0.getTime() + 1000),
    );
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    expect(hasProjectionChanged(before, after)).toBe(false);
  });
});
