import { describe, expect, it } from 'vitest';
import {
  DISTANCE_BAND_BOUNDS,
  type DistanceBand,
  coarseDistanceBand,
  distanceBand,
  isWithinDistanceLimit,
} from '../src/index.js';

describe('distanceBand', () => {
  it('uses half-open bands so every distance lands in exactly one', () => {
    expect(distanceBand(0)).toBe<DistanceBand>('lt_5_km');
    expect(distanceBand(4.999)).toBe<DistanceBand>('lt_5_km');
    expect(distanceBand(5)).toBe<DistanceBand>('5_25_km');
    expect(distanceBand(24.999)).toBe<DistanceBand>('5_25_km');
    expect(distanceBand(25)).toBe<DistanceBand>('25_50_km');
    expect(distanceBand(50)).toBe<DistanceBand>('50_100_km');
    expect(distanceBand(99.9)).toBe<DistanceBand>('50_100_km');
    expect(distanceBand(100)).toBe<DistanceBand>('gt_100_km');
  });

  it('rejects a nonsensical distance instead of bucketing it', () => {
    expect(() => distanceBand(-1)).toThrow(RangeError);
    expect(() => distanceBand(Number.NaN)).toThrow(RangeError);
  });

  it('has contiguous, non-overlapping bounds', () => {
    const ordered: Exclude<DistanceBand, 'unknown'>[] = ['lt_5_km', '5_25_km', '25_50_km', '50_100_km'];
    for (const [index, band] of ordered.entries()) {
      expect(DISTANCE_BAND_BOUNDS[band].minKm).toBe(ordered[index - 1] === undefined ? 0 : DISTANCE_BAND_BOUNDS[ordered[index - 1]!].maxKm);
      expect(DISTANCE_BAND_BOUNDS[band].maxKm).toBeGreaterThan(DISTANCE_BAND_BOUNDS[band].minKm);
    }
  });
});

describe('coarseDistanceBand', () => {
  it('collapses a short hop into the coarsest band', () => {
    // Roughly 1.1 km apart across the river.
    expect(coarseDistanceBand({ latitude: 51.5074, longitude: -0.1278 }, { latitude: 51.5155, longitude: -0.09 })).toBe<DistanceBand>(
      'lt_5_km',
    );
  });

  it('separates a different city', () => {
    expect(coarseDistanceBand({ latitude: 51.5074, longitude: -0.1278 }, { latitude: 55.7558, longitude: 37.6173 })).toBe<DistanceBand>(
      'gt_100_km',
    );
  });

  it('is symmetric', () => {
    const london = { latitude: 51.5074, longitude: -0.1278 };
    const paris = { latitude: 48.8566, longitude: 2.3522 };
    expect(coarseDistanceBand(london, paris)).toBe(coarseDistanceBand(paris, london));
  });

  it('refuses a coordinate outside the globe', () => {
    expect(() => coarseDistanceBand({ latitude: 91, longitude: 0 }, { latitude: 0, longitude: 0 })).toThrow(
      RangeError,
    );
    expect(() => coarseDistanceBand({ latitude: 0, longitude: 181 }, { latitude: 0, longitude: 0 })).toThrow(
      RangeError,
    );
  });
});

describe('isWithinDistanceLimit', () => {
  it('admits a band whose nearest edge fits the limit', () => {
    expect(isWithinDistanceLimit('5_25_km', 5)).toBe(true);
    expect(isWithinDistanceLimit('5_25_km', 4.9)).toBe(false);
  });

  it('never excludes on an unexpressed limit or an unresolvable band', () => {
    expect(isWithinDistanceLimit('gt_100_km', null)).toBe(true);
    expect(isWithinDistanceLimit('unknown', 5)).toBe(true);
  });

  it('never rejects a band that could still contain someone within the limit', () => {
    const bands: Exclude<DistanceBand, 'unknown'>[] = ['lt_5_km', '5_25_km', '25_50_km', '50_100_km', 'gt_100_km'];
    for (const limit of [1, 10, 25, 50, 100, 500]) {
      for (const band of bands) {
        const bounds = DISTANCE_BAND_BOUNDS[band];
        if (bounds.maxKm <= limit) {
          expect(isWithinDistanceLimit(band, limit)).toBe(true);
        }
        if (bounds.minKm > limit) {
          expect(isWithinDistanceLimit(band, limit)).toBe(false);
        }
      }
    }
  });
});
