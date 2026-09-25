import {
  type Clearance,
  type CorrelationId,
  type DataSensitivity,
  type DomainEvent,
  type DomainError,
  type Result,
  domainError,
  ok,
} from '@been-there/core';
import { isAuditRequired } from './audit.js';
import { isWithinClearance } from './redaction.js';

export const ANALYTICS_SINK_CLEARANCE: Clearance = { upTo: 'internal' };

/**
 * The analytics catalogue. This is the whole surface product domains may push to
 * a metrics sink, and each entry declares the classification of its own
 * dimension values — a `public` name carrying `user` dimensions is a leak with
 * a plausible-looking name on it, so the classification sits next to the name.
 */
export interface AnalyticsEventSpec {
  readonly sensitivity: DataSensitivity;
  readonly dimensions: readonly string[];
  readonly description: string;
}

export const ANALYTICS_EVENTS = {
  'account.registration_started': {
    sensitivity: 'public',
    dimensions: ['surface'],
    description: 'Onboarding entry, counted. No identity, no funnel position.',
  },
  'account.registration_completed': {
    sensitivity: 'public',
    dimensions: ['surface'],
    description: 'A verified account exists. Counted, never attributed.',
  },
  'account.onboarding_step_completed': {
    sensitivity: 'public',
    dimensions: ['step', 'source'],
    description: 'Progress through onboarding. Steps are a closed vocabulary.',
  },
  'account.recovery_started': {
    sensitivity: 'internal',
    dimensions: ['method'],
    description: 'A recovery was attempted. The completion twin is audit-only.',
  },
  'account.session_started': {
    sensitivity: 'internal',
    dimensions: ['surface', 'auth_method'],
    description: 'An authenticated session began. Session churn is a security metric.',
  },
  'account.capability_denied': {
    sensitivity: 'internal',
    dimensions: ['capability', 'reason_code'],
    description: 'A product capability was refused. Must never carry a case id.',
  },
  'profile.photo_uploaded': {
    sensitivity: 'internal',
    dimensions: ['reason_code', 'bytes_bucket'],
    description: 'A photo entered the media pipeline. Bytes are bucketed, never sized exactly.',
  },
  'profile.photo_rejected': {
    sensitivity: 'internal',
    dimensions: ['reason_code'],
    description: 'Scanning or policy refused a photo.',
  },
  'notification.delivered': {
    sensitivity: 'internal',
    dimensions: ['channel', 'category', 'critical'],
    description: 'A notification left the platform. Counts, not recipients.',
  },
  'notification.suppressed': {
    sensitivity: 'internal',
    dimensions: ['channel', 'category', 'suppression_reason'],
    description: 'A notification was deliberately not sent, and why.',
  },
  'location.resolved': {
    sensitivity: 'internal',
    dimensions: ['band'],
    description: 'A coarse distance was produced. The band only; never a coordinate.',
  },
  'media.signed_url_issued': {
    sensitivity: 'internal',
    dimensions: ['purpose'],
    description: 'A time-boxed media grant was created.',
  },
  'media.access_denied': {
    sensitivity: 'internal',
    dimensions: ['purpose'],
    description: 'A media read was refused. Enumeration attempts cluster here.',
  },
  'integration.call_failed': {
    sensitivity: 'internal',
    dimensions: ['provider', 'operation', 'failure'],
    description: 'A vendor call failed at the seam, with the uniform failure kind.',
  },
  'account.app_opened': {
    sensitivity: 'internal',
    dimensions: ['surface', 'journey_id'],
    description:
      'App opened. `journey_id` is a per-install random key, never derived from a user id and never joined to an audit event.',
  },
  'account.registration_rejected': {
    sensitivity: 'internal',
    dimensions: ['reason_code', 'age_band'],
    description: 'Onboarding could not complete. Reason codes only; no entered values.',
  },
  'account.onboarding_step_failed': {
    sensitivity: 'internal',
    dimensions: ['step', 'reason_code'],
    description: 'Failure twin of onboarding_step_completed.',
  },
  'account.session_failed': {
    sensitivity: 'internal',
    dimensions: ['reason_code', 'auth_method'],
    description: 'Failure twin of session_started. Counts failed logins, not who.',
  },
  'account.session_revoked': {
    sensitivity: 'internal',
    dimensions: ['scope'],
    description: 'Sessions were killed, by logout, password change, recovery, or enforcement.',
  },
  'account.recovery_locked': {
    sensitivity: 'internal',
    dimensions: ['reason_code', 'window_hours'],
    description: 'Recovery was locked after repeated failures. Counted; the detail is audit-only.',
  },
  'account.deletion_requested': {
    sensitivity: 'internal',
    dimensions: ['retention_bucket'],
    description: 'Erasure was requested. Retention buckets only; no identifiers of the subject.',
  },
  'account.deletion_cancelled': {
    sensitivity: 'internal',
    dimensions: ['retention_bucket'],
    description: 'Erasure was withdrawn inside the grace window.',
  },
  'account.deletion_completed': {
    sensitivity: 'internal',
    dimensions: ['retention_bucket'],
    description: 'Erasure finished. Counts only.',
  },
  'profile.published': {
    sensitivity: 'public',
    dimensions: ['surface'],
    description: 'A profile became visible in discovery. Counted, never attributed.',
  },
  'profile.state_changed': {
    sensitivity: 'internal',
    dimensions: ['from', 'to'],
    description: 'A profile lifecycle state moved. Enumerated states only.',
  },
  'profile.updated': {
    sensitivity: 'internal',
    dimensions: ['changed_field_count_bucket', 'changed_field'],
    description: 'A profile was edited. Field names and a count bucket, never the values written.',
  },
  'profile.photo_set_updated': {
    sensitivity: 'internal',
    dimensions: ['photo_count_bucket'],
    description: 'The photo set changed. A count, not the media.',
  },
} as const satisfies Readonly<Record<string, AnalyticsEventSpec>>;

export type AnalyticsEventName = keyof typeof ANALYTICS_EVENTS;

/**
 * Narrows an arbitrary string to a catalogue name. `Object.hasOwn` rather than
 * a bare index so that `"toString"` cannot resolve to something inherited from
 * `Object.prototype` and be treated as a registered event.
 */
export function isKnownAnalyticsEvent(name: string): name is AnalyticsEventName {
  return Object.hasOwn(ANALYTICS_EVENTS, name);
}

/**
 * Property names that may never appear in an analytics event, whatever the
 * event. Content and identity are the two things a metrics sink must not hold,
 * and this list is the enforcement rather than a review checklist.
 */
export const ANALYTICS_FORBIDDEN_PROPERTIES: readonly string[] = [
  'userId',
  'subjectId',
  'accountId',
  'sessionId',
  'caseId',
  'reportId',
  'email',
  'phone',
  'displayName',
  'bio',
  'messageBody',
  'latitude',
  'longitude',
  'coordinate',
  'location',
  'livenessScore',
  'idDocumentUrl',
  'moderatorNotes',
  'reason',
];

export type AnalyticsProperty = string | number | boolean | null;

export interface AnalyticsEvent {
  readonly name: AnalyticsEventName;
  readonly occurredAt: Date;
  /** Tracing only. An opaque request id, never an account. */
  readonly correlationId: CorrelationId;
  readonly properties: Readonly<Record<string, AnalyticsProperty>>;
  /** False when the event was sampled out; counts are then extrapolated. */
  readonly sampled: boolean;
}

export interface RecordAnalyticsRequest {
  readonly name: string;
  readonly occurredAt: Date;
  readonly correlationId: CorrelationId;
  readonly properties: Readonly<Record<string, AnalyticsProperty>>;
  /** 0..1. Audit has no equivalent: it is complete or it is not. */
  readonly sampleRate: number;
}

/**
 * The only way into the metrics sink. It refuses unregistered names, forbidden
 * properties, and values that are not scalars — a nested object in a property
 * bag is how a "harmless" event ends up carrying a payload.
 */
export function recordAnalyticsEvent(request: RecordAnalyticsRequest): Result<AnalyticsEvent, DomainError> {
  if (!isKnownAnalyticsEvent(request.name)) {
    return domainError('validation_failed', 'platform', `unknown analytics event "${request.name}"`, {
      name: request.name,
    });
  }
  const spec: AnalyticsEventSpec = ANALYTICS_EVENTS[request.name];
  if (request.sampleRate < 0 || request.sampleRate > 1) {
    return domainError('validation_failed', 'platform', 'sampleRate must be within [0, 1]', {
      sampleRate: request.sampleRate,
    });
  }

  const forbidden = Object.keys(request.properties).filter((key) =>
    ANALYTICS_FORBIDDEN_PROPERTIES.includes(key),
  );
  if (forbidden.length > 0) {
    return domainError('validation_failed', 'platform', 'property is not allowed in analytics', {
      property: forbidden[0] ?? '',
    });
  }

  const undeclared = Object.keys(request.properties).filter(
    (key) => !spec.dimensions.includes(key),
  );
  if (undeclared.length > 0) {
    return domainError('validation_failed', 'platform', 'property is not a declared dimension', {
      property: undeclared[0] ?? '',
    });
  }

  for (const [key, value] of Object.entries(request.properties)) {
    if (typeof value === 'object') {
      return domainError('validation_failed', 'platform', 'analytics properties must be scalars', {
        property: key,
      });
    }
  }

  return ok({
    name: request.name,
    occurredAt: request.occurredAt,
    correlationId: request.correlationId,
    properties: request.properties,
    sampled: isSampled(request.correlationId, request.sampleRate),
  });
}

/**
 * Deterministic sampling. The same event always lands on the same side of the
 * rate, so a retried publish does not double-count and an unsampled audit-
 * adjacent metric does not flicker between runs.
 */
export function isSampled(correlationId: CorrelationId, sampleRate: number): boolean {
  if (sampleRate >= 1) {
    return true;
  }
  if (sampleRate <= 0) {
    return false;
  }
  let hash = 2166136261;
  for (let index = 0; index < correlationId.length; index += 1) {
    hash ^= correlationId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const unit = (hash >>> 0) / 4294967296;
  return unit < sampleRate;
}

/** Event types that carry user-authored content: neither sink may hold them. */
export const CONTENT_BEARING_TYPES: readonly string[] = [
  'message.sent',
  'message.edited',
  'message.content_rendered',
  'profile.bio_updated',
];

export type AnalyticsRejection = 'content' | 'audited_only';

export interface SinkRoute {
  /** True when the event is also an audit fact. Audit is never sampled. */
  readonly audit: boolean;
  readonly analytics: boolean;
  readonly rejection?: AnalyticsRejection;
}

/**
 * Where a published event is allowed to go. The two rules that matter:
 *
 * 1. Content goes nowhere. Metrics sinks are aggregatable and therefore widely
 *    readable; a log of message bodies is a product-wide liability for a
 *    feature that adds no safety.
 * 2. Safety and identity events are audit-only. They are complete and
 *    case-bearing, and an aggregate sink that can be sliced by subject is one
 *    query away from a "who was reported" list, which the overview forbids the
 *    product from knowing.
 *
 * Product metrics for those journeys come from the anonymous counters above
 * (`account.registration_completed`), never from subscribing to the safety or
 * identity streams.
 */
export function routeEvent(event: DomainEvent): SinkRoute {
  if (CONTENT_BEARING_TYPES.includes(event.type)) {
    return { audit: false, analytics: false, rejection: 'content' };
  }
  if (isAuditRequired(event.type)) {
    return { audit: true, analytics: false, rejection: 'audited_only' };
  }
  return {
    audit: false,
    analytics: isWithinClearance(ANALYTICS_SINK_CLEARANCE, event.sensitivity),
  };
}
