import {
  type ActorId,
  type AccountState,
  type CaseId,
  type CorrelationId,
  type DataSensitivity,
  type DomainEvent,
  type EventId,
  type UserId,
  castId,
  type SubjectId,
} from '@been-there/core';
import { type AuditLog, createAuditLog } from './audit.js';
import type { CaseState } from './case.js';
import type { DecisionId } from './ids.js';

/**
 * Every event this domain publishes. The split is by *audience*, not by
 * prefix, and the prefix is only a namespace:
 *
 *  - `restricted` — the moderation record. Nobody outside a moderator role with
    the matching clearance may observe it, so a product domain can never learn
    that an account was reported, reviewed or actioned, or who did it.
 *  - `account_state.changed` is `public`: the standing and the capability set,
    and nothing else. A product domain enforces a capability set; it never
    learns a reason.
 *  - `moderation.restriction_applied` / `_lifted` are `user` — the *affected*
    user, and only them. They carry the case reference, because a user who
    cannot name the case cannot contest the decision, and contestability is a
    commitment here. That is exactly why they are not on the `public` event:
    a case id on a bus any visitor can read publishes the existence of an open
    case about an identifiable person, which is the first fact a `restricted`
    clearance exists to withhold. Two events, two clearances, one decision.
 */
/**
 * A runtime array, not only a type union, so a cross-domain check can
 * enumerate what this domain publishes. The drift that made this necessary was
 * invisible precisely because nothing could compare the published names against
 * the consumed ones: a type alias is erased at runtime, so a declared event
 * that nobody emits looks identical to one that is.
 */
export const MODERATION_EVENT_TYPES = [
  'moderation.report_submitted',
  'moderation.report_status_changed',
  'moderation.case_opened',
  'moderation.case_assigned',
  'moderation.case_review_started',
  'moderation.case_escalated',
  'moderation.case_reports_merged',
  'moderation.case_reopened',
  'moderation.case_resolved',
  'moderation.evidence_captured',
  'moderation.evidence_read',
  'moderation.decision_recorded',
  'moderation.decision_reversed',
  'moderation.restriction_applied',
  'moderation.restriction_lifted',
  'account_state.changed',
] as const;

export type ModerationEventType = (typeof MODERATION_EVENT_TYPES)[number];

export const OUTWARD_ENFORCEMENT_EVENT: ModerationEventType = 'account_state.changed';

/**
 * The whole outward enforcement payload. A reviewer diffing this file can see
 * there is no case, no decision, no moderator and no reason on it.
 *
 * `removedCapabilities` is here, and not only in the payload the restricted
 * user reads, because the spec's capability projection is
 * `{accountState, removedCapabilities, effectiveCapabilities}` and a client
 * that has to diff `capabilities` against a local copy of the base table to
 * work out what was taken has been given a second crossing point. The names
 * are a capability vocabulary, not content: nothing here identifies a report,
 * a case, or a person beyond the subject the envelope already names.
 */
export interface AccountStateChangedPayload extends Readonly<Record<string, unknown>> {
  readonly accountState: AccountState;
  readonly capabilities: readonly string[];
  readonly removedCapabilities: readonly string[];
}

/**
 * What the restricted user is told, and the only event that names a case
 * outside the moderation record. Four fields because four things are owed: what
 * was taken away, which case decided it, which decision, and the standing it
 * produced. The date is the envelope's `occurredAt` and the appeal route is the
 * `appeal_request` capability the state grants, so neither is duplicated here.
 */
export interface RestrictionAppliedPayload extends Readonly<Record<string, unknown>> {
  readonly caseId: CaseId;
  readonly decisionId: DecisionId;
  readonly accountState: AccountState;
  readonly removedCapabilities: readonly string[];
}

/**
 * One name, one payload. `moderation.case_assigned` used to be published by
 * both the assignment and the start of a review, with the second emission
 * swapping `assignedModeratorId` for `state`; a consumer reading
 * `payload.assignedModeratorId` then got `undefined` and could not tell an
 * assignment from a review beginning. Every name below therefore has exactly
 * one payload interface and exactly one publisher.
 */
export interface CaseAssignedPayload extends Readonly<Record<string, unknown>> {
  readonly caseId: CaseId;
  readonly assignedModeratorId: ActorId;
}

export interface CaseReviewStartedPayload extends Readonly<Record<string, unknown>> {
  readonly caseId: CaseId;
  readonly state: CaseState;
}

/**
 * A reopen is a case going back into a queue, so it is on the bus like every
 * other case transition. `clearedDecisionId` is the decision the reopen
 * detached from the case: it is not deleted, and an appeal reads the chain —
 * but a consumer that only watches cases must be able to see that the pointer
 * moved.
 */
export interface CaseReopenedPayload extends Readonly<Record<string, unknown>> {
  readonly caseId: CaseId;
  readonly state: CaseState;
  readonly clearedDecisionId: DecisionId | null;
}

export interface EmitSpec<P extends Readonly<Record<string, unknown>>> {
  readonly type: ModerationEventType;
  readonly actorId: ActorId | 'system';
  readonly subjectId?: UserId | undefined;
  readonly correlationId: CorrelationId;
  readonly causationId?: EventId | undefined;
  readonly sensitivity: DataSensitivity;
  readonly payload: P;
}

/** Monotonic id source. Production swaps in a UUID generator; tests want a
 *  deterministic one, so it is injected rather than imported. */
export interface IdSource {
  next(): string;
}

export interface EventEmitter {
  emit<P extends Readonly<Record<string, unknown>>>(spec: EmitSpec<P>): DomainEvent<P>;
}

export interface ModerationContext {
  readonly audit: AuditLog;
  readonly ids: IdSource;
  readonly now: () => Date;
  readonly events: EventEmitter;
}

export interface ContextOptions {
  readonly audit?: AuditLog;
  readonly ids?: IdSource;
  readonly now?: () => Date;
  /**
   * Where published events go. Injectable because the default is a *builder*,
   * not a publisher: `decide` hands its events back to the caller, but
   * `captureEvidence`, `assignCase`, `escalateCase` and `readEvidence` do not
   * return anything, so with the default emitter their events are constructed
   * and dropped. A deployment passes the bus here; a test passes a recorder.
   */
  readonly events?: EventEmitter;
}

export function createContext(options: ContextOptions = {}): ModerationContext {
  const ids = options.ids ?? createIdSource('mod');
  const now = options.now ?? (() => new Date());
  const audit = options.audit ?? createAuditLog();
  const events = options.events ?? {
    emit<P extends Readonly<Record<string, unknown>>>(spec: EmitSpec<P>): DomainEvent<P> {
      return {
        eventId: castId<'EventId'>(ids.next()),
        type: spec.type,
        version: 1,
        occurredAt: now(),
        actorId: spec.actorId,
        ...(spec.subjectId === undefined ? {} : { subjectId: castId<'SubjectId'>(spec.subjectId) }),
        correlationId: spec.correlationId,
        ...(spec.causationId === undefined ? {} : { causationId: spec.causationId }),
        sensitivity: spec.sensitivity,
        payload: spec.payload,
      };
    },
  };

  return {
    audit,
    ids,
    now,
    events,
  };
}

/**
 * Prefixed counter. Only a default: a real deployment injects a UUID source so
 * that ids never collide across processes.
 */
export function createIdSource(prefix: string): IdSource {
  let counter = 0;
  return {
    next(): string {
      counter += 1;
      return `${prefix}-${counter}`;
    },
  };
}
