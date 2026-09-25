import {
  type ActorId,
  type CaseId,
  type Clearance,
  type CorrelationId,
  type DataSensitivity,
  type DomainEvent,
  type SubjectId,
  castId,
} from '@been-there/core';
import {
  type ClassifiedRecord,
  type RedactionResult,
  isWithinClearance,
  redact,
} from './redaction.js';
import type { AuditId } from './ids.js';

/**
 * Every action that lands in the audit log. The catalogue is a closed union on
 * purpose: an append-only log is only worth its storage if nothing can write to
 * it off-list. Adding a member here is a reviewable diff, and the compiler
 * points at every call site that needs a justification.
 */
export type AuditAction =
  | 'auth.session_issued'
  | 'auth.session_refreshed'
  | 'auth.session_revoked'
  | 'auth.recovery_requested'
  | 'auth.recovery_completed'
  | 'auth.recovery_failed'
  | 'auth.credential_changed'
  | 'authz.capability_denied'
  | 'authz.permission_denied'
  | 'authz.sensitive_read'
  | 'media.upload_requested'
  | 'media.scan_completed'
  | 'media.signed_url_issued'
  | 'media.access_denied'
  | 'identity.verification_changed'
  | 'identity.evidence_read'
  | 'account.enforcement_applied'
  | 'account.restriction_lifted'
  | 'account.ban_lifted'
  | 'case.opened'
  | 'case.evidence_read'
  | 'case.decision_recorded'
  | 'location.anchor_stored'
  | 'integration.call_failed';

export interface AuditPolicy {
  /** Classification of the record as a whole; the redaction sink uses it too. */
  readonly sensitivity: DataSensitivity;
  /** `sensitive`/`restricted` reads are individually logged (overview §6.3). */
  readonly readsAreIndividuallyLogged: boolean;
  /** Audit is never sampled. Present so a reader does not have to ask. */
  readonly complete: true;
  readonly rationale: string;
}

export const AUDIT_ACTIONS: Readonly<Record<AuditAction, AuditPolicy>> = {
  'auth.session_issued': { sensitivity: 'internal', readsAreIndividuallyLogged: false, complete: true, rationale: 'A credential-bearing artefact was minted.' },
  'auth.session_refreshed': { sensitivity: 'internal', readsAreIndividuallyLogged: false, complete: true, rationale: 'Refresh without re-authentication is a session-theft surface.' },
  'auth.session_revoked': { sensitivity: 'internal', readsAreIndividuallyLogged: false, complete: true, rationale: 'Revocation must be reconstructable for incident response.' },
  'auth.recovery_requested': { sensitivity: 'user', readsAreIndividuallyLogged: false, complete: true, rationale: 'Recovery is the standard account-takeover path; the request is the evidence.' },
  'auth.recovery_completed': { sensitivity: 'user', readsAreIndividuallyLogged: false, complete: true, rationale: 'Recovery invalidates every prior session, so the takeover point is recorded.' },
  'auth.recovery_failed': { sensitivity: 'user', readsAreIndividuallyLogged: false, complete: true, rationale: 'Failed attempts are the signal that an account is being probed.' },
  'auth.credential_changed': { sensitivity: 'user', readsAreIndividuallyLogged: false, complete: true, rationale: 'Password or passkey changes revoke trust in every other factor.' },
  'authz.capability_denied': { sensitivity: 'internal', readsAreIndividuallyLogged: false, complete: true, rationale: 'A denied product capability is evidence of a routing bug or an enforcement leak.' },
  'authz.permission_denied': { sensitivity: 'internal', readsAreIndividuallyLogged: false, complete: true, rationale: 'A denied role permission is an attempted privilege boundary crossing.' },
  'authz.sensitive_read': { sensitivity: 'sensitive', readsAreIndividuallyLogged: true, complete: true, rationale: 'Every read of identity evidence or an exact coordinate is individually recorded.' },
  'media.upload_requested': { sensitivity: 'user', readsAreIndividuallyLogged: false, complete: true, rationale: 'Upload attribution must survive a later abuse report.' },
  'media.scan_completed': { sensitivity: 'internal', readsAreIndividuallyLogged: false, complete: true, rationale: 'The verdict, not the bytes, is the durable fact.' },
  'media.signed_url_issued': { sensitivity: 'internal', readsAreIndividuallyLogged: false, complete: true, rationale: 'A time-boxed grant to read a specific asset is an access decision.' },
  'media.access_denied': { sensitivity: 'internal', readsAreIndividuallyLogged: false, complete: true, rationale: 'Non-owner reads are the enumeration signal worth keeping.' },
  'identity.verification_changed': { sensitivity: 'sensitive', readsAreIndividuallyLogged: false, complete: true, rationale: 'Identity state is the product promise; its transitions are appeal evidence.' },
  'identity.evidence_read': { sensitivity: 'restricted', readsAreIndividuallyLogged: true, complete: true, rationale: 'Liveness artefacts are the highest-value target in the system.' },
  'account.enforcement_applied': { sensitivity: 'restricted', readsAreIndividuallyLogged: false, complete: true, rationale: 'Automation never enforces, so every enforcement fact is a human decision with a case.' },
  'account.restriction_lifted': { sensitivity: 'restricted', readsAreIndividuallyLogged: false, complete: true, rationale: 'Lifting is a decision about a person; it is as auditable as applying.' },
  'account.ban_lifted': { sensitivity: 'restricted', readsAreIndividuallyLogged: false, complete: true, rationale: 'Reversing an irreversible-looking action needs a named human on the record.' },
  'case.opened': { sensitivity: 'restricted', readsAreIndividuallyLogged: false, complete: true, rationale: 'The case is the unit of enforcement authority.' },
  'case.evidence_read': { sensitivity: 'restricted', readsAreIndividuallyLogged: true, complete: true, rationale: 'Evidence reads are logged individually because they are the appeal record.' },
  'case.decision_recorded': { sensitivity: 'restricted', readsAreIndividuallyLogged: false, complete: true, rationale: 'The decision and its justification are the appeal answer.' },
  'location.anchor_stored': { sensitivity: 'sensitive', readsAreIndividuallyLogged: true, complete: true, rationale: 'An exact coordinate is stored, so its storage is a logged fact.' },
  'integration.call_failed': { sensitivity: 'internal', readsAreIndividuallyLogged: false, complete: true, rationale: 'Vendor outages become user-visible failures; the boundary must be debuggable.' },
};

export interface AuditRecord {
  readonly auditId: AuditId;
  /** Monotonic, gap-free per log; the ordering evidence for incident review. */
  readonly sequence: number;
  readonly action: AuditAction;
  readonly actorId: ActorId | 'system';
  readonly subjectId: SubjectId;
  /** Present whenever the action touched moderation authority. */
  readonly caseId?: CaseId;
  readonly occurredAt: Date;
  readonly correlationId: CorrelationId;
  readonly sensitivity: DataSensitivity;
  /** Classified payload. Read through `readAuditRecord`, never straight. */
  readonly fields: ClassifiedRecord;
}

export interface AuditAppendRequest {
  readonly action: AuditAction;
  readonly actorId: ActorId | 'system';
  readonly subjectId: SubjectId;
  readonly occurredAt: Date;
  readonly correlationId: CorrelationId;
  readonly caseId?: CaseId;
  readonly fields: ClassifiedRecord;
}

/**
 * The write side of the audit log. Note what is absent: there is no update and
 * no delete, and there is no method that takes a record back. A correction is a
 * new record with a `causationId`-style explanation, which is what makes the log
 * usable as appeal evidence.
 */
export interface AuditSink {
  append(request: AuditAppendRequest): AuditRecord;
}

/**
 * Read side. `clearance` is the reader's, not the record's: an `internal`
 * clearance can never observe a `restricted` record even if it holds the
 * reference.
 */
export interface AuditReader {
  read(clearance: { readonly upTo: DataSensitivity }): readonly AuditRecord[];
}

export class InMemoryAuditLog implements AuditSink, AuditReader {
  #records: AuditRecord[] = [];
  #sequence = 0;

  append(request: AuditAppendRequest): AuditRecord {
    const policy = AUDIT_ACTIONS[request.action];
    this.#sequence += 1;
    const record: AuditRecord = Object.freeze({
      auditId: castId<'AuditId'>(`audit-${this.#sequence}`),
      sequence: this.#sequence,
      action: request.action,
      actorId: request.actorId,
      subjectId: request.subjectId,
      ...(request.caseId === undefined ? {} : { caseId: request.caseId }),
      occurredAt: request.occurredAt,
      correlationId: request.correlationId,
      sensitivity: policy.sensitivity,
      fields: request.fields,
    });
    this.#records = [...this.#records, record];
    return record;
  }

  /**
   * Visibility is decided by the reader's clearance, not by the record's own
   * sensitivity. A reference to a `restricted` record is worthless to a reader
   * below `restricted`, and the fields are redacted again on every read.
   */
  read(clearance: Clearance): readonly AuditRecord[] {
    return this.#records.filter((record) => isWithinClearance(clearance, record.sensitivity));
  }
}

/**
 * Reads one record at a given clearance, returning the redacted view rather
 * than the raw fields. The caller's clearance is the gate; the record's own
 * classification is not. This is the function a moderation console calls, and
 * the reason a record can be handed around a system without being read.
 */
export function readAuditRecord(record: AuditRecord, clearance: Clearance): RedactionResult {
  return redact(record.fields, clearance);
}

/**
 * Types that must be audited regardless of how public their payload looks. An
 * identity status flip is `public` on the bus, but the audit log is where "who
 * was verified, when, and on whose authority" is reconstructable.
 */
export const AUDIT_REQUIRED_PREFIXES: readonly string[] = [
  'identity.',
  'case.',
  'account_state.',
  // Everything crossing the authentication boundary is a security fact. This is
  // also why a recovery-abuse signal is an `auth.*` event rather than an
  // analytics name: Trust & Safety consumes it, the metrics sink never does.
  'auth.',
];

export const AUDIT_REQUIRED_TYPES: readonly string[] = [
  // The identity spine's own event name (overview §4). It is `public` on the
  // bus because a client must know whether the current user is verified — which
  // is exactly why it must not also be a metrics input.
  'identity_status.changed',
  'verification.anomaly',
  'message.reported',
  'risk.changed',
  'media.scan_result',
];

/** True when a published event is also an audit fact, whatever its sensitivity. */
export function isAuditRequired(type: string): boolean {
  if (AUDIT_REQUIRED_TYPES.includes(type)) {
    return true;
  }
  return AUDIT_REQUIRED_PREFIXES.some((prefix) => type.startsWith(prefix));
}

/**
 * Bridges a published event into an append. The event supplies the timing and
 * the correlation id, so an audit record always ties back to the envelope that
 * caused it — the link that makes "why did this happen?" a query rather than an
 * investigation.
 */
export function auditRequestFromEvent(
  event: DomainEvent,
  request: {
    readonly action: AuditAction;
    readonly subjectId: SubjectId;
    readonly caseId?: CaseId;
    readonly fields: ClassifiedRecord;
  },
): AuditAppendRequest {
  return {
    action: request.action,
    actorId: event.actorId,
    subjectId: request.subjectId,
    ...(request.caseId === undefined ? {} : { caseId: request.caseId }),
    occurredAt: event.occurredAt,
    correlationId: event.correlationId,
    fields: request.fields,
  };
}

