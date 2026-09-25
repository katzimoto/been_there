/**
 * Coarse location (commitment 5: exact location is never exposed).
 *
 * A raw coordinate is accepted by exactly one exported function in this package
 * and leaves it as a `DistanceBand`. `RawCoordinate` is deliberately not
 * exported, so no other module — and no consumer of this package — can pass a
 * coordinate into anything except the bucketing rule below, and nothing in the
 * domain's public surface can carry one outward.
 *
 * Precision decision (rationale in docs/architecture/dating-core.md):
 *  - `< 5 km` is deliberately wider than walking distance, so "nearby" cannot
 *    be used to narrow a person to a neighbourhood.
 *  - 25 km steps above that. A 25 km band is roughly the radius inside which
 *    two people can actually meet for a date in one metro area; finer buckets
 *    add inference risk (repeated observations triangulate) without changing
 *    a single product decision.
 *  - Nothing above 100 km is distinguished: 100 km is already "would you
 *    travel this far for a first date".
 */

export type DistanceBand = 'lt_5_km' | '5_25_km' | '25_50_km' | '50_100_km' | 'gt_100_km' | 'unknown';

/**
 * Raw coordinate. Intentionally not exported: see the module comment. It is
 * still nameable by the compiler so the bucketing function has a signature,
 * but it cannot be imported, so it cannot appear in any exported type.
 */
interface RawCoordinate {
  readonly latitude: number;
  readonly longitude: number;
}

interface BandBounds {
  readonly minKm: number;
  readonly maxKm: number;
}

/** Upper-inclusive bound of each band, in km. `unknown` has no numeric band. */
export const DISTANCE_BAND_BOUNDS: Readonly<Record<Exclude<DistanceBand, 'unknown'>, BandBounds>> = {
  lt_5_km: { minKm: 0, maxKm: 5 },
  '5_25_km': { minKm: 5, maxKm: 25 },
  '25_50_km': { minKm: 25, maxKm: 50 },
  '50_100_km': { minKm: 50, maxKm: 100 },
  gt_100_km: { minKm: 100, maxKm: Number.POSITIVE_INFINITY },
};

const EARTH_MEAN_RADIUS_KM = 6371.0088;

function assertValidCoordinate(coordinate: RawCoordinate): void {
  if (
    !Number.isFinite(coordinate.latitude) ||
    !Number.isFinite(coordinate.longitude) ||
    Math.abs(coordinate.latitude) > 90 ||
    Math.abs(coordinate.longitude) > 180
  ) {
    // A malformed coordinate is a defect at the platform boundary, not an
    // expected domain outcome, so it is not modelled as a DomainError.
    throw new RangeError('coordinate out of range');
  }
}

/**
 * Great-circle distance in km on a mean-radius sphere. The spherical
 * approximation is accurate to ~0.3%, which is two orders of magnitude finer
 * than the bucket width it feeds.
 */
function greatCircleKm(a: RawCoordinate, b: RawCoordinate): number {
  const toRad = (degrees: number): number => (degrees * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const latA = toRad(a.latitude);
  const latB = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(latA) * Math.cos(latB);
  return 2 * EARTH_MEAN_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Pure: metres of separation collapse to one named band. */
export function distanceBand(km: number): DistanceBand {
  if (!Number.isFinite(km) || km < 0) {
    throw new RangeError(`distance must be a non-negative finite number, got ${km}`);
  }
  if (km < 5) {
    return 'lt_5_km';
  }
  if (km < 25) {
    return '5_25_km';
  }
  if (km < 50) {
    return '25_50_km';
  }
  if (km < 100) {
    return '50_100_km';
  }
  return 'gt_100_km';
}

/**
 * The one place a raw coordinate may enter this domain. Both arguments are
 * consumed here and never stored, returned or logged by this package.
 */
export function coarseDistanceBand(origin: RawCoordinate, subject: RawCoordinate): DistanceBand {
  assertValidCoordinate(origin);
  assertValidCoordinate(subject);
  return distanceBand(greatCircleKm(origin, subject));
}

/**
 * Conservative distance filter. A band is treated as *possibly within* the
 * limit whenever its lower bound fits, so bucketing can only ever widen a
 * result set, never silently hide someone who is actually close enough. An
 * unresolvable location (`unknown`) is never treated as too far: the platform
 * could not prove distance, and the product must not punish an unproven fact.
 */
export function isWithinDistanceLimit(band: DistanceBand, maxKm: number | null): boolean {
  if (maxKm === null || band === 'unknown') {
    return true;
  }
  if (!Number.isFinite(maxKm) || maxKm < 0) {
    throw new RangeError(`maxKm must be a non-negative finite number or null, got ${maxKm}`);
  }
  return DISTANCE_BAND_BOUNDS[band].minKm <= maxKm;
}

