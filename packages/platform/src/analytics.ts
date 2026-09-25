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
  /**
   * The sampling rate, chosen here and not by the caller. A rate passed in at
   * the call site is a per-site decision that drifts the moment two services
   * disagree, and a rate that drifts silently changes a metric's denominator;
   * putting it in the catalogue makes changing one a diff in the table where the
   * event is described, which is the only place a reviewer is looking.
   */
  readonly sampleRate: number;
  readonly description: string;
}

export const ANALYTICS_EVENTS = {
  'account.registration_started': {
    sensitivity: 'public',
    dimensions: ['surface'],
    sampleRate: 1,
    description: 'Onboarding entry, counted. No identity, no funnel position.',
  },
  'account.registration_completed': {
    sensitivity: 'public',
    dimensions: ['surface'],
    sampleRate: 1,
    description: 'A verified account exists. Counted, never attributed.',
  },
  'account.onboarding_step_completed': {
    sensitivity: 'public',
    dimensions: ['step', 'source'],
    sampleRate: 1,
    description: 'Progress through onboarding. Steps are a closed vocabulary.',
  },
  'account.recovery_started': {
    sensitivity: 'internal',
    dimensions: ['method'],
    sampleRate: 1,
    description:
      'A recovery was attempted. The completion carries a count here and the detail in the audit action.',
  },
  'account.session_started': {
    sensitivity: 'internal',
    dimensions: ['surface', 'auth_method'],
    sampleRate: 1,
    description: 'An authenticated session began. Session churn is a security metric.',
  },
  'account.capability_denied': {
    sensitivity: 'internal',
    dimensions: ['capability', 'reason_code'],
    sampleRate: 1,
    description: 'A product capability was refused. Must never carry a case id.',
  },
  'account.recovery_completed': {
    sensitivity: 'internal',
    dimensions: ['method', 'sessions_revoked_count'],
    sampleRate: 1,
    description:
      'Recovery succeeded and every other session was revoked. The blast radius as a count, never a session id.',
  },
  'settings.updated': {
    sensitivity: 'internal',
    dimensions: ['changed_field', 'changed_field_count_bucket'],
    sampleRate: 1,
    description: 'A non-preference settings write committed. Field names and a count, never the values written.',
  },
  'notification.failed': {
    sensitivity: 'internal',
    dimensions: ['channel', 'category', 'retry_count_bucket'],
    sampleRate: 0.25,
    description:
      'Every channel for a notice exhausted its retries. An undelivered critical notice is an incident, not a metric.',
  },
  'discovery.entered': {
    sensitivity: 'public',
    dimensions: ['surface'],
    sampleRate: 1,
    description: 'The viewer passed the discovery gate and opened the feed. The first dating-funnel step.',
  },
  'discovery.page_served': {
    sensitivity: 'internal',
    dimensions: ['pool_bucket', 'page_size_bucket'],
    sampleRate: 0.1,
    description:
      'A page of candidates was returned, full or short. The one genuinely high-volume event, and the only one sampled.',
  },
  'discovery.exhausted': {
    sensitivity: 'internal',
    dimensions: ['gate_class'],
    sampleRate: 1,
    description: 'The eligible pool is exhausted for this viewer. A sudden rise means identity expiry, not a lack of users.',
  },
  'discovery.viewer_ineligible': {
    sensitivity: 'internal',
    dimensions: ['gate_class'],
    sampleRate: 1,
    description: 'The discovery gate refused the viewer. The gate class only, never the underlying state.',
  },
  'conversation.created': {
    sensitivity: 'internal',
    dimensions: [],
    sampleRate: 1,
    description: 'A conversation opened, which is at match time. The denominator of every messaging rate.',
  },
  'message.recorded': {
    sensitivity: 'internal',
    dimensions: ['message_length_bucket'],
    sampleRate: 1,
    description: 'A message was accepted for delivery. A count and a length bucket, never a body, an excerpt, or a link.',
  },
  'message.delivered': {
    sensitivity: 'internal',
    dimensions: ['latency_bucket'],
    sampleRate: 1,
    description: "A recipient's client acknowledged the message.",
  },
  'message.read': {
    sensitivity: 'internal',
    dimensions: [],
    sampleRate: 1,
    description: "A conversation's read watermark advanced past a message.",
  },
  'message.withheld_by_system': {
    sensitivity: 'internal',
    dimensions: ['rule'],
    sampleRate: 1,
    description: 'An outbound message was refused by a system rule. The rule name and no body.',
  },
  'conversation.flagged_pattern': {
    sensitivity: 'internal',
    dimensions: ['pattern'],
    sampleRate: 1,
    description: 'A structural pattern fired. The pattern name only, never content and never a confidence value.',
  },
  'risk.assessed': {
    sensitivity: 'internal',
    dimensions: ['state', 'detector_count_bucket'],
    sampleRate: 1,
    description: 'A risk evaluation completed for the window. The state and a detector count, never a raw score.',
  },
  'slo.error_budget_exhausted': {
    sensitivity: 'internal',
    dimensions: ['slo_name', 'window'],
    sampleRate: 1,
    description: 'A service burned its error budget for the window.',
  },
  'alert.fired': {
    sensitivity: 'internal',
    dimensions: ['alert_name', 'severity'],
    sampleRate: 1,
    description: 'An alert transitioned to firing. The counter every runbook starts from.',
  },
  'provider.verification_call': {
    sensitivity: 'internal',
    dimensions: ['provider', 'outcome', 'latency_bucket'],
    sampleRate: 1,
    description: 'A verification provider call completed. The outcome and a latency bucket, never the payload.',
  },
  'profile.photo_uploaded': {
    sensitivity: 'internal',
    dimensions: ['reason_code', 'bytes_bucket'],
    sampleRate: 1,
    description: 'A photo entered the media pipeline. Bytes are bucketed, never sized exactly.',
  },
  'profile.photo_rejected': {
    sensitivity: 'internal',
    dimensions: ['reason_code'],
    sampleRate: 1,
    description: 'Scanning or policy refused a photo.',
  },
  'notification.delivered': {
    sensitivity: 'internal',
    dimensions: ['channel', 'category', 'critical'],
    sampleRate: 0.25,
    description: 'A notification left the platform. Counts, not recipients.',
  },
  'notification.suppressed': {
    sensitivity: 'internal',
    dimensions: ['channel', 'category', 'suppression_reason'],
    sampleRate: 1,
    description: 'A notification was deliberately not sent, and why.',
  },
  'location.resolved': {
    sensitivity: 'internal',
    dimensions: ['band'],
    sampleRate: 1,
    description: 'A coarse distance was produced. The band only; never a coordinate.',
  },
  'media.signed_url_issued': {
    sensitivity: 'internal',
    dimensions: ['purpose'],
    sampleRate: 1,
    description: 'A time-boxed media grant was created.',
  },
  'media.access_denied': {
    sensitivity: 'internal',
    dimensions: ['purpose'],
    sampleRate: 1,
    description: 'A media read was refused. Enumeration attempts cluster here.',
  },
  'integration.call_failed': {
    sensitivity: 'internal',
    dimensions: ['provider', 'operation', 'failure'],
    sampleRate: 1,
    description: 'A vendor call failed at the seam, with the uniform failure kind.',
  },
  'account.app_opened': {
    sensitivity: 'internal',
    dimensions: ['surface', 'journey_id'],
    sampleRate: 1,
    description:
      'App opened. `journey_id` is a per-install random key, never derived from a user id and never joined to an audit event.',
  },
  'account.registration_rejected': {
    sensitivity: 'internal',
    dimensions: ['reason_code', 'age_band'],
    sampleRate: 1,
    description: 'Onboarding could not complete. Reason codes only; no entered values.',
  },
  'account.onboarding_step_failed': {
    sensitivity: 'internal',
    dimensions: ['step', 'reason_code'],
    sampleRate: 1,
    description: 'Failure twin of onboarding_step_completed.',
  },
  'account.session_failed': {
    sensitivity: 'internal',
    dimensions: ['reason_code', 'auth_method'],
    sampleRate: 1,
    description: 'Failure twin of session_started. Counts failed logins, not who.',
  },
  'account.session_revoked': {
    sensitivity: 'internal',
    dimensions: ['scope'],
    sampleRate: 1,
    description: 'Sessions were killed, by logout, password change, recovery, or enforcement.',
  },
  'account.recovery_locked': {
    sensitivity: 'internal',
    dimensions: ['reason_code', 'window_hours'],
    sampleRate: 1,
    description: 'Recovery was locked after repeated failures. Counted; the detail is audit-only.',
  },
  'account.deletion_requested': {
    sensitivity: 'internal',
    dimensions: ['retention_bucket'],
    sampleRate: 1,
    description: 'Erasure was requested. Retention buckets only; no identifiers of the subject.',
  },
  'account.deletion_cancelled': {
    sensitivity: 'internal',
    dimensions: ['retention_bucket'],
    sampleRate: 1,
    description: 'Erasure was withdrawn inside the grace window.',
  },
  'account.deletion_completed': {
    sensitivity: 'internal',
    dimensions: ['retention_bucket'],
    sampleRate: 1,
    description: 'Erasure finished. Counts only.',
  },
  'profile.published': {
    sensitivity: 'public',
    dimensions: ['surface'],
    sampleRate: 1,
    description: 'A profile became visible in discovery. Counted, never attributed.',
  },
  'profile.state_changed': {
    sensitivity: 'internal',
    dimensions: ['from', 'to'],
    sampleRate: 1,
    description: 'A profile lifecycle state moved. Enumerated states only.',
  },
  'profile.updated': {
    sensitivity: 'internal',
    dimensions: ['changed_field_count_bucket', 'changed_field'],
    sampleRate: 1,
    description: 'A profile was edited. Field names and a count bucket, never the values written.',
  },
  'profile.photo_set_updated': {
    sensitivity: 'internal',
    dimensions: ['photo_count_bucket'],
    sampleRate: 1,
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
 *
 * `conversationId` is here for the same reason `userId` is: a conversation is a
 * pseudonym for two identified people, and a metrics sink that can be sliced by
 * one is a "who was talking to whom" list. The per-conversation aggregates the
 * messaging metrics need come from the activity rollup Communication already
 * publishes, which is built for exactly that.
 */
export const ANALYTICS_FORBIDDEN_PROPERTIES: readonly string[] = [
  'userId',
  'subjectId',
  'accountId',
  'sessionId',
  'caseId',
  'reportId',
  'conversationId',
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
    sampled: isSampled(request.correlationId, spec.sampleRate),
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

/**
 * Event types that carry user-authored content: neither sink may hold them.
 *
 * The names are the ones the packages actually publish. A list of names nobody
 * emits is a guard that protects nothing while reading as coverage, and the
 * failure is silent — an event nobody flagged goes to whichever sink its
 * sensitivity happens to allow. This list used to hold four names, not one of
 * which any package emits, so the guard protected nothing at all.
 *
 * One entry is the correct number rather than a thin one. `message_sent` is the
 * only published event about what a user wrote; everything else that could carry
 * user content is `sensitive` or `restricted` and is already refused by the
 * clearance check below, which is the second half of the same rule.
 */
export const CONTENT_BEARING_TYPES: readonly string[] = ['communication.message_sent'];

export type AnalyticsRejection = 'content' | 'audited_only' | 'unroutable';

export interface SinkRoute {
  /** True when the event is also an audit fact. Audit is never sampled. */
  readonly audit: boolean;
  readonly analytics: boolean;
  /**
   * Why an event reached no sink. Present whenever one did, so "nobody has
   * this event" is a reported outcome rather than an absence nobody notices.
   */
  readonly rejection?: AnalyticsRejection;
}

/**
 * Where a published event is allowed to go. The three rules that matter:
 *
 * 1. Content goes nowhere. Metrics sinks are aggregatable and therefore widely
 *    readable; a log of message bodies is a product-wide liability for a
 *    feature that adds no safety.
 * 2. Safety and identity events are audit-only. They are complete and
 *    case-bearing, and an aggregate sink that can be sliced by subject is one
 *    query away from a "who was reported" list, which the overview forbids the
 *    product from knowing.
 * 3. An event no sink may hold is reported, not discarded. A `sensitive` event
 *    that is not an audit fact reaches neither sink, and the caller has to be
 *    able to see that; a silent `{ audit: false, analytics: false }` is
 *    indistinguishable from a bug, and is how every moderation event was
 *    dropped from both sinks while the router looked healthy.
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
  if (!isWithinClearance(ANALYTICS_SINK_CLEARANCE, event.sensitivity)) {
    return { audit: false, analytics: false, rejection: 'unroutable' };
  }
  return { audit: false, analytics: true };
}
