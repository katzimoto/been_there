import {
  type ActorId,
  type CaseId,
  type Clearance,
  type CorrelationId,
  type DataSensitivity,
  type DomainError,
  type DomainEvent,
  type Result,
  type SubjectId,
  castId,
  domainError,
  ok,
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
 * purpose: an action nobody has classified is an action whose record can be
 * read by the wrong person, and a `Record<AuditAction, AuditPolicy>` below
 * means the compiler refuses to let the union and the catalogue disagree.
 *
 * The moderation families are spelled the way `packages/moderation` spells
 * them. Two vocabulararies for one fact is the defect this file used to carry:
 * `case.evidence_read` and `evidence.read` were the same row under two names,
 * and a caller holding the moderation string got a `TypeError` instead of a
 * record. A domain that names an action owns that spelling; the sink accepts
 * the name rather than asking the caller to translate it.
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
  | 'report.submitted'
  | 'report.triaged'
  | 'report.merged'
  | 'report.status_changed'
  | 'case.opened'
  | 'case.assigned'
  | 'case.review_started'
  | 'case.escalated'
  | 'case.reports_merged'
  | 'case.resolved'
  | 'case.reopened'
  | 'evidence.captured'
  | 'evidence.read'
  | 'evidence.read_denied'
  | 'decision.recorded'
  | 'decision.reversed'
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

/**
 * The classification of every action above. Total by construction: the type
 * makes a missing entry a compile error, and `append` refuses an unclassified
 * name at runtime with a `validation_failed` domain error rather than reading
 * a property off `undefined`.
 *
 * All sixteen moderation actions are `restricted`. Not as a default: each one
 * is a fact about an identified person under safety investigation, and the
 * record's sensitivity is what decides who may read it. A lower
 * classification would let an `internal` clearance enumerate "who was
 * reported" — the query the overview forbids the product from being able to
 * ask. Only the two evidence-read actions are individually logged, because
 * those are the appeal record, and a denied read is the interesting row.
 */
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
  'report.submitted': { sensitivity: 'restricted', readsAreIndividuallyLogged: false, complete: true, rationale: 'A report names a person; the record is the intake fact and it outlives the case.' },
  'report.triaged': { sensitivity: 'restricted', readsAreIndividuallyLogged: false, complete: true, rationale: 'Triage is where an allegation becomes a named human judgement about a person.' },
  'report.merged': { sensitivity: 'restricted', readsAreIndividuallyLogged: false, complete: true, rationale: 'Merging hides one report inside another; the link is the only trace of the first reporter.' },
  'report.status_changed': { sensitivity: 'restricted', readsAreIndividuallyLogged: false, complete: true, rationale: 'A report withdrawn or closed is a fact about a safety history, not a queue entry.' },
  'case.opened': { sensitivity: 'restricted', readsAreIndividuallyLogged: false, complete: true, rationale: 'The case is the unit of enforcement authority.' },
  'case.assigned': { sensitivity: 'restricted', readsAreIndividuallyLogged: false, complete: true, rationale: 'Commitment 2 is "a human on a recorded case"; the assignment is the human.' },
  'case.review_started': { sensitivity: 'restricted', readsAreIndividuallyLogged: false, complete: true, rationale: 'When review began bounds every later "we did not look" answer.' },
  'case.escalated': { sensitivity: 'restricted', readsAreIndividuallyLogged: false, complete: true, rationale: 'Escalation is the moment severity crossed a human threshold.' },
  'case.reports_merged': { sensitivity: 'restricted', readsAreIndividuallyLogged: false, complete: true, rationale: 'One case standing for several reports is why the reporters must stay individually traceable.' },
  'case.resolved': { sensitivity: 'restricted', readsAreIndividuallyLogged: false, complete: true, rationale: 'Resolution closes the appeal window; the record is what an appeal is answered from.' },
  'case.reopened': { sensitivity: 'restricted', readsAreIndividuallyLogged: false, complete: true, rationale: 'A reopen says a completed judgement was wrong, and is treated as auditable as the judgement.' },
  'evidence.captured': { sensitivity: 'restricted', readsAreIndividuallyLogged: false, complete: true, rationale: 'Captured evidence may later become the only account of what a person did.' },
  'evidence.read': { sensitivity: 'restricted', readsAreIndividuallyLogged: true, complete: true, rationale: 'Evidence reads are logged individually because they are the appeal record.' },
  'evidence.read_denied': { sensitivity: 'restricted', readsAreIndividuallyLogged: true, complete: true, rationale: 'A refused evidence read is the probe worth keeping; the refusal is the row.' },
  'decision.recorded': { sensitivity: 'restricted', readsAreIndividuallyLogged: false, complete: true, rationale: 'The decision and its justification are the appeal answer.' },
  'decision.reversed': { sensitivity: 'restricted', readsAreIndividuallyLogged: false, complete: true, rationale: 'A reversal undoes a judgement about a person and is as auditable as the judgement.' },
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
 *
 * `append` answers with a `Result` because the one failure here is not
 * exceptional and must never be silent: an action with no policy entry cannot
 * be classified, so it cannot be stored. Reporting it as a `validation_failed`
 * domain error is what tells the caller to fix the catalogue; reading
 * `policy.sensitivity` off `undefined` is what turned a naming disagreement
 * between two packages into a `TypeError` and a lost moderation record.
 */
export interface AuditSink {
  append(request: AuditAppendRequest): Result<AuditRecord, DomainError>;
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

  append(request: AuditAppendRequest): Result<AuditRecord, DomainError> {
    // The union and the catalogue are kept in step by the compiler, so a miss
    // here is a name that never belonged to this vocabulary at all.
    if (!Object.hasOwn(AUDIT_ACTIONS, request.action)) {
      return domainError(
        'validation_failed',
        'platform',
        `audit action "${request.action}" has no sensitivity policy and cannot be recorded`,
        { action: request.action },
      );
    }
    const policy: AuditPolicy = AUDIT_ACTIONS[request.action];
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
    return ok(record);
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
  // Moderation publishes under its own prefix (`moderation.case_opened`, not
  // `case.opened`). Without this row the router found no audit prefix, fell
  // through to the clearance check, and withheld the event from both sinks —
  // the entire moderation safety record, dropped without an error.
  'moderation.',
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

/**
 * True when a published event is also an audit fact, whatever its sensitivity.
 * The prefixes are the domain convention, not a registry: a domain that names
 * a family `<domain>.` and publishes a safety fact is covered by naming it
 * once here, rather than by remembering to add every event type individually.
 */
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

