import { type VerificationId, castId } from '@been-there/core';
import { StoreError } from '@been-there/contracts';
import {
  type EvidenceKind,
  type IdentityConfidence,
  type VerificationAttempt,
  type VerificationAttemptState,
  type VerificationCheck,
  type VerificationDecisionRecord,
  type VerificationEvidence,
  attemptMachine,
} from '@been-there/identity';

/**
 * The verification attempt, as a store row and back again.
 *
 * The port is untyped on this aggregate — `Readonly<Record<string, unknown>>` —
 * so the encoding is the service's to define and the store's to persist. The rule
 * that matters is the round trip: `submitToProvider`'s guard re-derives the
 * decision from the attempt it is given, and `completeFromProvider` re-derives it
 * a second time before applying it. An encoding that dropped `completedChecks`,
 * `evidence` or the stored decision would make those guards read a half-empty
 * attempt and either refuse a legitimate send to the provider or accept one that
 * should never have gone out. So every field is written, and a row that does not
 * decode is a `StoreError` rather than a default.
 */

const ATTEMPT_STATES: readonly VerificationAttemptState[] = [
  ...attemptMachine.states,
];

const EVIDENCE_KINDS: readonly EvidenceKind[] = [
  'government_id_image',
  'selfie_image',
  'liveness_video',
  'document_text_extract',
  'provider_response',
];

/**
 * The whole aggregate, as the store's `insert` wants it.
 *
 * `verificationId`, `subjectId` and `startedAt` are fixed at open; everything
 * else is the mutable half. The names are the store's, and they match the
 * aggregate's — there is no `attemptId` or `userId` here, and the store refuses a
 * stray key rather than ignoring it, which is the right way round: a renamed
 * field is a loud fault here and a silently dropped one in the database.
 */
export function attemptRowOf(attempt: VerificationAttempt): Readonly<Record<string, unknown>> {
  return {
    verificationId: attempt.verificationId,
    subjectId: attempt.subjectId,
    startedAt: attempt.startedAt,
    state: attempt.state,
    reVerification: attempt.reVerification,
    reason: attempt.reason,
    updatedAt: attempt.updatedAt,
    expiresAt: attempt.expiresAt,
    submittedAt: attempt.submittedAt,
    completedChecks: attempt.completedChecks,
    evidence: attempt.evidence,
    confidence: attempt.confidence,
    decision: attempt.decision,
    reviewerId: attempt.reviewerId,
  };
}

function corrupt(detail: string): StoreError {
  return new StoreError(`stored verification attempt is malformed: ${detail}`, { retryable: false });
}

function text(row: Readonly<Record<string, unknown>>, field: string): string {
  const value = row[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw corrupt(`'${field}' is not a non-empty string`);
  }
  return value;
}

function nullableText(row: Readonly<Record<string, unknown>>, field: string): string | null {
  const value = row[field];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw corrupt(`'${field}' is neither a string nor null`);
  }
  return value;
}

function instant(row: Readonly<Record<string, unknown>>, field: string): Date {
  const value = row[field];
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw corrupt(`'${field}' is not a usable instant`);
    }
    return parsed;
  }
  throw corrupt(`'${field}' is not an instant`);
}

function instantOrNull(row: Readonly<Record<string, unknown>>, field: string): Date | null {
  return row[field] === undefined || row[field] === null ? null : instant(row, field);
}

function checkListOf(raw: unknown): VerificationCheck[] {
  if (!Array.isArray(raw)) {
    throw corrupt('completedChecks is not an array');
  }
  return raw.map((entry) => {
    const check = ['document_authenticity', 'liveness', 'likeness', 'document_to_selfie_match', 'age_consistency'].find(
      (candidate) => candidate === entry,
    );
    if (check === undefined) {
      throw corrupt(`'${String(entry)}' is not a verification check`);
    }
    return check as VerificationCheck;
  });
}

function evidenceListOf(raw: unknown): VerificationEvidence[] {
  if (!Array.isArray(raw)) {
    throw corrupt('evidence is not an array');
  }
  return raw.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw corrupt('an evidence entry is not an object');
    }
    const record = entry as Readonly<Record<string, unknown>>;
    const kind = EVIDENCE_KINDS.find((candidate) => candidate === record['kind']);
    if (kind === undefined) {
      throw corrupt(`'${String(record['kind'])}' is not an evidence kind`);
    }
    return {
      kind,
      verificationId: castId<'VerificationId'>(text(record, 'verificationId')),
      capturedAt: instant(record, 'capturedAt'),
      storageRef: text(record, 'storageRef'),
      sensitivity: 'restricted' as const,
      digest: text(record, 'digest'),
      expiresAt: instant(record, 'expiresAt'),
    };
  });
}

function confidenceOf(raw: unknown): IdentityConfidence | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'object') {
    throw corrupt('confidence is neither an object nor null');
  }
  const record = raw as Readonly<Record<string, unknown>>;
  const value = record['value'];
  const band = record['band'];
  if (typeof value !== 'number' || typeof band !== 'string') {
    throw corrupt('confidence is missing its value or band');
  }
  return { value, band: band as IdentityConfidence['band'] };
}

function decisionOf(raw: unknown): VerificationDecisionRecord | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'object') {
    throw corrupt('decision is neither an object nor null');
  }
  const record = raw as Readonly<Record<string, unknown>>;
  const confidence = confidenceOf(record['confidence']);
  if (confidence === null) {
    throw corrupt('a decision carries no confidence');
  }
  return {
    decision: record['decision'] as VerificationDecisionRecord['decision'],
    confidence,
    rationale: stringListOf(record['rationale'], 'rationale'),
    missingChecks: checkListOf(record['missingChecks'] ?? []),
  };
}

function stringListOf(raw: unknown, field: string): string[] {
  if (!Array.isArray(raw)) {
    throw corrupt(`${field} is not an array`);
  }
  return raw.map((entry) => {
    if (typeof entry !== 'string') {
      throw corrupt(`${field} holds a non-string`);
    }
    return entry;
  });
}

export function attemptOf(row: Readonly<Record<string, unknown>>): VerificationAttempt {
  const state = ATTEMPT_STATES.find((candidate) => candidate === row['state']);
  if (state === undefined) {
    throw corrupt(`'${String(row['state'])}' is not an attempt state`);
  }
  const reason = row['reason'];
  if (typeof reason !== 'object' || reason === null) {
    throw corrupt('reason is not an object');
  }
  const reasonCode = (reason as Readonly<Record<string, unknown>>)['code'];
  if (typeof reasonCode !== 'string') {
    throw corrupt('reason has no code');
  }
  return {
    verificationId: castId<'VerificationId'>(text(row, 'verificationId')),
    subjectId: castId<'SubjectId'>(text(row, 'subjectId')),
    state,
    reVerification: row['reVerification'] === true,
    reason: { code: reasonCode } as VerificationAttempt['reason'],
    startedAt: instant(row, 'startedAt'),
    updatedAt: instant(row, 'updatedAt'),
    expiresAt: instant(row, 'expiresAt'),
    submittedAt: instantOrNull(row, 'submittedAt'),
    completedChecks: checkListOf(row['completedChecks'] ?? []),
    evidence: evidenceListOf(row['evidence'] ?? []),
    confidence: confidenceOf(row['confidence']),
    decision: decisionOf(row['decision']),
    reviewerId: nullableText(row, 'reviewerId'),
  };
}

/**
 * The mutable half, for `VerificationAttemptStore.update`.
 *
 * The three fields the store calls fixed — `verificationId`, `subjectId`,
 * `startedAt` — are deliberately absent: they are the attempt's identity and its
 * opening instant, and a patch that could move them would be a patch that could
 * rewrite which verification this row is.
 */
export function attemptPatchOf(
  attempt: VerificationAttempt,
  providerReference: string | null,
): Readonly<Record<string, unknown>> {
  const row = attemptRowOf(attempt);
  return {
    state: attempt.state,
    providerReference,
    updatedAt: attempt.updatedAt,
    reVerification: attempt.reVerification,
    reason: attempt.reason,
    expiresAt: attempt.expiresAt,
    submittedAt: attempt.submittedAt,
    completedChecks: attempt.completedChecks,
    evidence: attempt.evidence,
    confidence: attempt.confidence,
    decision: attempt.decision,
    reviewerId: attempt.reviewerId,
    ...(row['startedAt'] === undefined ? {} : {}),
  };
}
