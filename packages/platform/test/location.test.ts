import { describe, expect, it } from 'vitest';
import { expectTypeOf } from 'vitest';
import { castId, type UserId } from '@been-there/core';
import {
  DISTANCE_BANDS,
  anchorStoredAuditRequest,
  bandFor,
  coarseDistance,
  distanceKm,
  quantiseAnchor,
  storeAnchor,
  type CoarseLocation,
  type Coordinate,
  type LocationAnchorId,
} from '../src/index.js';
import { correlationId, subjectId } from './helpers.js';

const BERLIN = { latitude: 52.52, longitude: 13.405 } as const;
const ALICE = castId<'UserId'>('u-alice') as UserId;
const BOB = castId<'UserId'>('u-bob') as UserId;
const NOW = new Date('2026-03-01T12:00:00.000Z');

function anchorFor(ownerId: UserId, precise: Coordinate = BERLIN) {
  return storeAnchor({
    anchorId: castId<'LocationAnchorId'>('anchor-1') as LocationAnchorId,
    ownerId,
    precise,
    accuracyMetres: 12,
    now: NOW,
  });
}

describe('distance banding', () => {
  it('assigns every distance to exactly one band, at the boundaries', () => {
    expect(bandFor(0)).toBe('same_area');
    expect(bandFor(7.999)).toBe('same_area');
    expect(bandFor(8)).toBe('nearby');
    expect(bandFor(40)).toBe('regional');
    expect(bandFor(159.999)).toBe('regional');
    expect(bandFor(160)).toBe('distant');
    expect(bandFor(9_000)).toBe('distant');
  });

  it('answers unknown rather than guessing when the distance is not computable', () => {
    expect(bandFor(Number.NaN)).toBe('unknown');
    expect(bandFor(Number.POSITIVE_INFINITY)).toBe('unknown');
  });

  it('covers the whole positive range with no gap between bands', () => {
    const covered = DISTANCE_BANDS.every(
      (definition, index) => index === 0 || definition.minKm === DISTANCE_BANDS[index - 1]?.maxKm,
    );
    expect(covered).toBe(true);
    expect(bandFor(-5)).toBe('unknown');
  });

  it('measures distance correctly enough to band it', () => {
    // One degree of latitude is ~111 km.
    const oneDegreeNorth = distanceKm(BERLIN, { latitude: BERLIN.latitude + 1, longitude: BERLIN.longitude });
    expect(oneDegreeNorth).toBeGreaterThan(110);
    expect(oneDegreeNorth).toBeLessThan(112);
    expect(distanceKm(BERLIN, BERLIN)).toBe(0);
  });
});

describe('the coarse location contract', () => {
  it('has no field a coordinate could hide in', () => {
    // The requirement, as a type: the projection is structurally incapable of
    // carrying a latitude or a longitude.
    expectTypeOf<keyof CoarseLocation>().toEqualTypeOf<
      'ownerId' | 'band' | 'label' | 'observedAt'
    >();
  });

  it('returns a band and a label, and neither is a number that could be reversed', () => {
    const anchor = anchorFor(BOB);
    const nearby = coarseDistance({ userId: ALICE, coordinate: BERLIN }, anchor);
    const far = coarseDistance(
      { userId: ALICE, coordinate: { latitude: BERLIN.latitude + 3, longitude: BERLIN.longitude } },
      anchor,
    );

    expect(nearby).toEqual({ ownerId: BOB, band: 'same_area', label: 'Nearby', observedAt: NOW });
    expect(far.band).toBe('distant');
    expect(Object.values(nearby).filter((value) => typeof value === 'number')).toEqual([]);
  });

  it('does not leak the coordinate into the serialised projection', () => {
    const anchor = anchorFor(BOB);
    const projection = coarseDistance({ userId: ALICE, coordinate: BERLIN }, anchor);
    const serialised = JSON.stringify(projection);

    expect(serialised).not.toContain('latitude');
    expect(serialised).not.toContain('longitude');
    expect(serialised).not.toContain('52.5');
    expect(serialised).not.toContain('13.4');
  });
});

describe('stored anchors', () => {
  it('classifies the stored point as sensitive, so the sink can drop it', () => {
    const anchor = anchorFor(BOB);

    expect(anchor.sensitivity).toBe('sensitive');
    expect(Object.keys(anchor)).toContain('coordinate');
  });

  it('quantises to a grid cell, so a stationary user does not produce a track', () => {
    const precise = { latitude: 52.520_11, longitude: 13.405_04 };

    const first = quantiseAnchor(precise, ALICE);
    const again = quantiseAnchor(precise, ALICE);
    const otherUser = quantiseAnchor(precise, BOB);

    // Stable for the same account, so the user does not jitter between bands.
    expect(first).toEqual(again);
    // Not the raw fix: the residual error is up to one grid cell.
    expect(Math.abs(first.latitude - precise.latitude)).toBeLessThanOrEqual(0.08);
    // Not the same point for two accounts either, so a grid cannot be inverted
    // into a map of who lives where.
    expect(first).not.toEqual(otherUser);
  });

  it('keeps a stored anchor inside the band it would have had unquantised', () => {
    const precise = { latitude: 52.520_11, longitude: 13.405_04 };
    const viewer = { userId: ALICE, coordinate: { latitude: 52.6, longitude: 13.405 } };

    const exactBand = bandFor(distanceKm(viewer.coordinate, precise));
    const quantisedBand = coarseDistance(
      viewer,
      storeAnchor({
        anchorId: castId<'LocationAnchorId'>('a-1') as LocationAnchorId,
        ownerId: BOB,
        precise,
        accuracyMetres: 5,
        now: NOW,
      }),
    ).band;

    // Quantisation may move a borderline point by a cell; it may not move it
    // across the width of a band.
    const exactIndex = DISTANCE_BANDS.findIndex((definition) => definition.band === exactBand);
    const quantisedIndex = DISTANCE_BANDS.findIndex(
      (definition) => definition.band === quantisedBand,
    );
    expect(Math.abs(exactIndex - quantisedIndex)).toBeLessThanOrEqual(1);
  });

  it('audits a location write without offering the coordinate a classification', () => {
    const anchor = anchorFor(BOB, { latitude: 52.520_11, longitude: 13.405_04 });

    const request = anchorStoredAuditRequest(anchor, NOW, correlationId('loc-1'), subjectId(BOB));

    expect(request.action).toBe('location.anchor_stored');
    expect(request.fields.map((field) => field.name)).toEqual([
      'anchor_id',
      'accuracy_metres',
      'quantised',
    ]);
    const serialised = JSON.stringify(request.fields);
    expect(serialised).not.toContain('52.5');
    expect(serialised).not.toContain('13.4');
  });
});
