import { type CorrelationId, type SubjectId, type UserId } from '@been-there/core';
import { type AuditAppendRequest } from './audit.js';
import { type LocationAnchorId } from './ids.js';
import { type ClassifiedRecord, classify } from './redaction.js';

/**
 * Location is the clearest case of "sensitive per field, not per table". A user
 * has a city, a distance to other people, and a home address, and the first is
 * public while the third is evidence. So the platform stores the coordinate
 * once, classified `sensitive`, and hands out a band.
 */

/** The only shape that may cross a boundary. No latitude, no longitude. */
export type DistanceBand = 'same_area' | 'nearby' | 'regional' | 'distant' | 'unknown';

export interface BandDefinition {
  readonly band: DistanceBand;
  /** Lower bound, inclusive. `unknown` has no bounds: it is the no-answer case. */
  readonly minKm: number;
  readonly maxKm: number;
  /** The coarsest honest description a client may render for this band. */
  readonly label: string;
}

/**
 * Bands, not radii. A number like "12 km" is a coordinate difference and a
 * stable one; a band is stable only up to its own width, so a client cannot
 * narrow a position by intersecting two observations. `same_area` is 8 km
 * rather than "same city" on purpose: a city boundary is published, and two
 * coordinates inside one city can still be kilometres apart.
 */
export const DISTANCE_BANDS: readonly BandDefinition[] = [
  { band: 'same_area', minKm: 0, maxKm: 8, label: 'Nearby' },
  { band: 'nearby', minKm: 8, maxKm: 40, label: 'In the area' },
  { band: 'regional', minKm: 40, maxKm: 160, label: 'Somewhere nearby' },
  { band: 'distant', minKm: 160, maxKm: Number.POSITIVE_INFINITY, label: 'Far away' },
];

export const UNKNOWN_BAND: BandDefinition = {
  band: 'unknown',
  minKm: Number.POSITIVE_INFINITY,
  maxKm: Number.POSITIVE_INFINITY,
  label: '',
};

export function bandFor(distanceKm: number): DistanceBand {
  if (!Number.isFinite(distanceKm)) {
    return 'unknown';
  }
  const matched = DISTANCE_BANDS.find(
    (definition) => distanceKm >= definition.minKm && distanceKm < definition.maxKm,
  );
  return matched?.band ?? 'unknown';
}

/**
 * What a stored anchor contains. The coordinate is present because the platform
 * has to compute a band from something, and it is classified rather than
 * hidden: `sensitivity: 'sensitive'` is what stops it reaching a log, an
 * analytics property, or a moderation read below identity clearance.
 */
export interface StoredAnchor {
  readonly anchorId: LocationAnchorId;
  readonly ownerId: UserId;
  readonly coordinate: Coordinate;
  readonly observedAt: Date;
  readonly sensitivity: 'sensitive';
  /** Retained so a band can be recomputed if the banding is ever revised. */
  readonly accuracyMetres: number;
}

export interface Coordinate {
  readonly latitude: number;
  readonly longitude: number;
}

/** The projection clients and other domains read. Structurally coordinate-free. */
export interface CoarseLocation {
  readonly ownerId: UserId;
  readonly band: DistanceBand;
  /** Client-facing copy for the band, e.g. "Somewhere nearby". Never a number. */
  readonly label: string;
  readonly observedAt: Date;
}

const EARTH_RADIUS_KM = 6371;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function distanceKm(from: Coordinate, to: Coordinate): number {
  const deltaLat = toRadians(to.latitude - from.latitude);
  const deltaLon = toRadians(to.longitude - from.longitude);
  const latFrom = toRadians(from.latitude);
  const latTo = toRadians(to.latitude);
  const haversine =
    Math.sin(deltaLat / 2) ** 2 + Math.cos(latFrom) * Math.cos(latTo) * Math.sin(deltaLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(haversine)));
}


/**
 * Reduces a coordinate to a band against a viewer's own coordinate. The
 * viewer's coordinate is a parameter and is not returned, logged, or retained;
 * the only output is the band.
 */
export function coarseDistance(
  viewer: { readonly userId: UserId; readonly coordinate: Coordinate },
  anchor: StoredAnchor,
): CoarseLocation {
  const km = distanceKm(viewer.coordinate, anchor.coordinate);
  const band = bandFor(km);
  const definition = DISTANCE_BANDS.find((candidate) => candidate.band === band);
  return {
    ownerId: anchor.ownerId,
    band,
    label: definition?.label ?? UNKNOWN_BAND.label,
    observedAt: anchor.observedAt,
  };
}

/**
 * Quantised anchor. A user who does not move is a user whose exact position
 * over time is a track, and a track is a home address. The stored point is
 * therefore snapped to a coarse grid whose cell is a function of the account,
 * so the same user is represented consistently while two nearby users are not
 * represented identically, and the residual error is one grid cell rather than
 * a GPS fix.
 */
export function quantiseAnchor(coordinate: Coordinate, userId: UserId, gridDegrees = 0.08): Coordinate {
  let hash = 2166136261;
  for (let index = 0; index < userId.length; index += 1) {
    hash ^= userId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const offset = (Math.abs(hash) % 1000) / 1000 - 0.5;
  const cell = gridDegrees * offset;
  return {
    latitude: Math.round((coordinate.latitude + cell) / gridDegrees) * gridDegrees,
    longitude: Math.round((coordinate.longitude - cell) / gridDegrees) * gridDegrees,
  };
}

export function storeAnchor(request: {
  readonly anchorId: LocationAnchorId;
  readonly ownerId: UserId;
  readonly precise: Coordinate;
  readonly accuracyMetres: number;
  readonly now: Date;
}): StoredAnchor {
  return {
    anchorId: request.anchorId,
    ownerId: request.ownerId,
    coordinate: quantiseAnchor(request.precise, request.ownerId),
    observedAt: request.now,
    sensitivity: 'sensitive',
    accuracyMetres: request.accuracyMetres,
  };
}

/** The audit fact for a location write. Stores the anchor id, never the point. */
export function anchorStoredAuditRequest(
  anchor: StoredAnchor,
  occurredAt: Date,
  correlationId: CorrelationId,
  subjectId: SubjectId,
): AuditAppendRequest {
  const fields: ClassifiedRecord = [
    classify('anchor_id', 'internal', anchor.anchorId),
    classify('accuracy_metres', 'internal', anchor.accuracyMetres),
    // The coordinate is deliberately not among the fields: there is no
    // classification that lets it into a log, so it is not offered one.
    classify('quantised', 'internal', true),
  ];
  return {
    action: 'location.anchor_stored',
    actorId: 'system',
    subjectId,
    occurredAt,
    correlationId,
    fields,
  };
}
