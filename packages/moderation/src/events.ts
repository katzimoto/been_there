import {
  type ActorId,
  type AccountState,
  type CorrelationId,
  type DataSensitivity,
  type DomainEvent,
  type EventId,
  type UserId,
  castId,
  type SubjectId,
} from '@been-there/core';
import { type AuditLog, createAuditLog } from './audit.js';

/**
 * Every event this domain publishes. Two families, and the split is the point:
 *
 *  - `moderation.*` and `moderation.evidence.*` are `restricted`. Nobody outside
 *    a moderator role with the matching clearance may observe them, so a product
 *    domain can never learn that an account was reported, reviewed or actioned.
 *  - `account_state.changed` is the single outward-facing enforcement event and
 *    is `public`. Its payload carries the new standing and the capability set,
 *    and nothing else — no case, no decision, no moderator, no reason.
 */
export type ModerationEventType =
  | 'moderation.report_submitted'
  | 'moderation.report_status_changed'
  | 'moderation.case_opened'
  | 'moderation.case_assigned'
  | 'moderation.case_escalated'
  | 'moderation.case_reports_merged'
  | 'moderation.case_resolved'
  | 'moderation.evidence_captured'
  | 'moderation.evidence_read'
  | 'moderation.decision_recorded'
  | 'moderation.decision_reversed'
  | 'account_state.changed';

export const OUTWARD_ENFORCEMENT_EVENT: ModerationEventType = 'account_state.changed';

/** The whole outward enforcement payload. A reviewer diffing this file can see
 *  there is no second field and nothing to leak. */
export interface AccountStateChangedPayload extends Readonly<Record<string, unknown>> {
  readonly accountState: AccountState;
  readonly capabilities: readonly string[];
}

export interface EmitSpec<P> {
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
  emit<P>(spec: EmitSpec<P>): DomainEvent<P>;
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
}

export function createContext(options: ContextOptions = {}): ModerationContext {
  const ids = options.ids ?? createIdSource('mod');
  const now = options.now ?? (() => new Date());
  const audit = options.audit ?? createAuditLog();
  let counter = 0;

  return {
    audit,
    ids,
    now,
    events: {
      emit<P>(spec: EmitSpec<P>): DomainEvent<P> {
        return {
          eventId: castId<'EventId'>(ids.next()),
          type: spec.type,
          version: 1,
          occurredAt: now(),
          actorId: spec.actorId,
          ...(spec.subjectId === undefined
            ? {}
            : { subjectId: castId<'SubjectId'>(spec.subjectId) }),
          correlationId: spec.correlationId,
          ...(spec.causationId === undefined ? {} : { causationId: spec.causationId }),
          sensitivity: spec.sensitivity,
          payload: spec.payload,
        };
      },
    },
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
