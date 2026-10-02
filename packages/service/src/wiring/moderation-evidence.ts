import {
  type ActorId,
  type CaseId,
  type DataSensitivity,
  type ReportId,
  type UserId,
  castId,
} from '@been-there/core';
import {
  type EvidenceCapture,
  type EvidenceKind,
  type EvidenceRecord,
  type EvidenceSourceDomain,
  EVIDENCE_POLICY,
} from '@been-there/moderation';
import { corrupt, textOf } from './moderation.js';

/**
 * Reading frozen evidence back.
 *
 * `reports.captured_evidence` is a `jsonb` array written by `JSON.stringify`, so
 * what comes back is what was written: a date is the string the serialiser made
 * of it, and every classification is a string a stored row could disagree with.
 * The decoding is strict here — strictly more so than `reportOf`, which passes
 * the report's evidence through — because the redaction gate reads `access` off
 * this record, and a record claiming `reviewer` for a liveness artefact would be
 * served raw.
 */
const EVIDENCE_KINDS: readonly EvidenceKind[] = Object.keys(EVIDENCE_POLICY) as EvidenceKind[];
const EVIDENCE_SOURCE_DOMAINS: readonly EvidenceSourceDomain[] = [
  'moderation',
  'communication',
  'trust-safety',
  'identity',
  'dating-core',
];
const DATA_SENSITIVITIES: readonly DataSensitivity[] = ['public', 'user', 'internal', 'sensitive', 'restricted'];

/**
 * A stored evidence record, rebuilt into the aggregate the redaction gate takes.
 *
 * The decoding is strict where `reportOf` is lenient, and deliberately so. The
 * gate reads `record.access` and `record.capturedAt` and nothing else, and both
 * of those are exactly what `jsonb` does not give back: a date comes back as
 * the string `JSON.stringify` wrote, and `access` is a field a stored row could
 * disagree with. So a record whose `access` is not the one `EVIDENCE_POLICY`
 * declares for its kind is corrupt rather than merely unusual — a record that
 * claimed `reviewer` for a liveness artefact would be served raw, and a
 * StoreError is the only answer that does not depend on someone noticing.
 */
export function evidenceRecordOf(value: unknown, caseId: CaseId): EvidenceRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw corrupt('a captured evidence entry is not an object (case ' + caseId + ')');
  }
  const row = value as Readonly<Record<string, unknown>>;
  const kind = EVIDENCE_KINDS.find((candidate) => candidate === row['kind']);
  if (kind === undefined) {
    throw corrupt(`'${String(row['kind'])}' is not an evidence kind (case ${caseId})`);
  }
  const policy = EVIDENCE_POLICY[kind];
  if (row['access'] !== policy.access) {
    throw corrupt(`evidence ${String(row['evidenceId'])} claims access ${String(row['access'])}, not ${policy.access}`);
  }
  if (row['sensitivity'] !== policy.sensitivity) {
    throw corrupt(
      `evidence ${String(row['evidenceId'])} claims sensitivity ${String(row['sensitivity'])}, not ${policy.sensitivity}`,
    );
  }
  const source = EVIDENCE_SOURCE_DOMAINS.find((candidate) => candidate === row['sourceDomain']);
  if (source === undefined) {
    throw corrupt(`'${String(row['sourceDomain'])}' is not an evidence source domain (case ${caseId})`);
  }
  const sensitivity = DATA_SENSITIVITIES.find((candidate) => candidate === row['sensitivity']);
  if (sensitivity === undefined) {
    throw corrupt(`'${String(row['sensitivity'])}' is not a data sensitivity (case ${caseId})`);
  }
  const retention = row['retentionExpiresAt'];
  if (retention !== null && retention !== undefined && typeof retention !== 'string') {
    throw corrupt(`evidence ${String(row['evidenceId'])} has an unreadable retention date`);
  }
  return {
    evidenceId: textOf(row, 'evidenceId'),
    kind,
    subjectId: castId<'UserId'>(textOf(row, 'subjectId')),
    capturedAt: new Date(textOf(row, 'capturedAt')),
    capture: captureOf(row, kind, caseId),
    sourceDomain: source,
    artefactReference: textOf(row, 'artefactReference'),
    digest: textOf(row, 'digest'),
    redactedSummary: textOf(row, 'redactedSummary'),
    access: policy.access,
    sensitivity,
    retentionExpiresAt: retention === null || retention === undefined ? null : new Date(retention),
  };
}

/**
 * Where the evidence came from, which is fixed at capture and is what tells a
 * reviewer's summary from a moderator's own note.
 */
function captureOf(
  row: Readonly<Record<string, unknown>>,
  kind: EvidenceKind,
  caseId: CaseId,
): EvidenceCapture {
  const capture = row['capture'];
  if (typeof capture !== 'object' || capture === null) {
    throw corrupt(`evidence of kind ${kind} carries no capture (case ${caseId})`);
  }
  const at = (capture as Readonly<Record<string, unknown>>)['at'];
  if (at === 'report_submission') {
    return { at, reportId: castId<'ReportId'>(textOf(capture as Readonly<Record<string, unknown>>, 'reportId')) };
  }
  if (at === 'case_intake') {
    return { at, caseId: castId<'CaseId'>(textOf(capture as Readonly<Record<string, unknown>>, 'caseId')) };
  }
  if (at === 'review') {
    return {
      at,
      caseId: castId<'CaseId'>(textOf(capture as Readonly<Record<string, unknown>>, 'caseId')),
      moderatorId: castId<'ActorId'>(textOf(capture as Readonly<Record<string, unknown>>, 'moderatorId')),
    };
  }
  throw corrupt(`'${String(at)}' is not an evidence capture (case ${caseId})`);
}
