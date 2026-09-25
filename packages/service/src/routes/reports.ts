import { createHash, randomUUID } from 'node:crypto';
import {
  type CorrelationId,
  type DomainError,
  type MatchId,
  type ReportId,
  type Result,
  castId,
  ok,
} from '@been-there/core';
import { evidenceForReport } from '@been-there/dating';
import {
  type ReportEvidenceInput,
  type ReportReason,
  type RelationshipSnapshot,
  REPORT_REASON_POLICY,
  submitReport,
} from '@been-there/moderation';
import { MISSING_FIELD } from '../http/failure.js';
import { readEnum, readString } from '../http/body.js';
import { okResponse, route, type HttpResponse, type Route, type RouteRequest } from '../http/router.js';
import type { ServiceDependencies } from '../ports.js';
import { blocksBetween, ledgersFor, matchRecordOf } from '../wiring/dating.js';
import { auditAppender, flushAudit, reportRowOf, requestModerationContext } from '../wiring/moderation.js';
import { userIdOf } from './accounts.js';

/**
 * Submitting a report.
 *
 * ## A report outlives the relationship
 *
 * The right to report is `evidenceForReport`'s, not this route's: it reads the
 * *retained* records, so a withdrawn like, a superseded pass and an ended match
 * all still yield a reportable subject with each record's state attached. The only
 * thing it refuses is a pair with no recorded interaction at all. That is why a
 * report filed after an unmatch works, and adding an "is the relationship still
 * current" check here would be the one line that broke it.
 *
 * ## The evidence is frozen at the moment of the report
 *
 * `submitReport` hashes what it is given, so the digest is taken over the evidence
 * the dating domain just resolved — the like and pass states and the match id —
 * rather than over anything this route decides. A digest of "a report exists"
 * would let two different reports share one fingerprint, and the appeal record is
 * exactly where that would bite.
 */

const REPORT_REASONS: readonly ReportReason[] = Object.keys(REPORT_REASON_POLICY) as ReportReason[];

export function reportRoutes(dependencies: ServiceDependencies): readonly Route[] {
  return [
    route('POST', '/v1/reports', async (request) => submitReportFor(dependencies, request)),
  ];
}

async function submitReportFor(
  dependencies: ServiceDependencies,
  request: RouteRequest,
): Promise<Result<HttpResponse, DomainError>> {
  const reporterId = request.actor.userId;
  if (reporterId === null) {
    return MISSING_FIELD('userId');
  }
  const subjectRaw = readString(request.body, 'subjectUserId');
  if (!subjectRaw.ok) {
    return subjectRaw;
  }
  const subject = userIdOf(subjectRaw.value);
  if (!subject.ok) {
    return subject;
  }
  const reason = readEnum(request.body, 'reason', REPORT_REASONS, 'other');
  if (!reason.ok) {
    return reason;
  }
  const statementRaw = request.body['statement'];
  if (statementRaw !== undefined && statementRaw !== null && typeof statementRaw !== 'string') {
    return MISSING_FIELD('statement');
  }
  const matchRow = await dependencies.stores.interaction.findMatchByPair(
    reporterId,
    subject.value,
    request.tx,
  );
  const conversation =
    matchRow === null
      ? null
      : await dependencies.stores.conversations.findByMatch(
          castId<'MatchId'>(String(matchRow['matchId'])),
          reporterId,
          request.tx,
        );
  const match =
    matchRow === null ? null : matchRecordOf(matchRow, conversation?.conversationId ?? null);

  // The right to report, and the frozen evidence, both come from the dating
  // domain reading the retained records. Nothing here inspects the relationship's
  // current state, which is what lets a report survive an unmatch.
  const [ledgers, blocks] = await Promise.all([
    ledgersFor(dependencies.stores, reporterId, request.tx),
    blocksBetween(dependencies.stores, reporterId, subject.value, request.tx),
  ]);
  const evidence = evidenceForReport({
    viewer: reporterId,
    subject: subject.value,
    likes: ledgers.ledger.likes,
    passes: ledgers.passes,
    match,
    blocks,
  });
  if (!evidence.ok) {
    return evidence;
  }
  const relationship: RelationshipSnapshot = {
    status: match === null ? 'never_matched' : match.ended === null ? 'matched' : 'unmatched',
    capturedAt: request.now,
    conversationId: match?.conversationId ?? null,
    messageRange: null,
  };
  const { context, pending } = requestModerationContext(request.now);
  const submitted = submitReport(context, {
    reportId: castId<'ReportId'>(randomUUID()),
    subjectId: subject.value,
    // Anonymity is the reporter's choice and never weakens the record: the
    // evidence, the relationship snapshot and the audit row are identical either
    // way, and `submitReport` still refuses a reporter reporting themselves.
    reporterId: request.body['anonymous'] === true ? null : reporterId,
    reason: reason.value,
    statement: typeof statementRaw === 'string' ? statementRaw : null,
    relationship,
    evidence: evidenceInputsOf(evidence.value, relationship),
    correlationId: castId<'CorrelationId'>(randomUUID()),
  });
  if (!submitted.ok) {
    // A refused submission still produced audit rows, and a refusal nobody can
    // read is a refusal that did not happen. They are written before the error is
    // returned; the request's transaction then rolls the *report* back and nothing
    // else, because the flush is part of this same unit of work by design.
    await flushAudit(pending, auditAppender((row, tx) => dependencies.stores.moderation.appendAudit(row, tx)), request.tx);
    return submitted;
  }
  await dependencies.stores.moderation.insertReport(
    reportRowOf(submitted.value.report),
    request.tx,
  );
  await flushAudit(pending, auditAppender((row, tx) => dependencies.stores.moderation.appendAudit(row, tx)), request.tx);
  return okResponse(201, {
    reportId: submitted.value.report.reportId,
    state: submitted.value.report.state,
    reason: reason.value,
    evidence: submitted.value.evidence.length,
    relationship: relationship.status,
    submittedAt: submitted.value.report.submittedAt.toISOString(),
  });
}

/**
 * The evidence a report freezes.
 *
 * `submitReport` requires at least one artefact and hashes whatever it is given,
 * so the digest is taken over the evidence the *dating domain* just resolved — the
 * like and pass states and the match id — rather than over anything this route
 * decides. A digest of "a report exists" would let two different reports share
 * one fingerprint, and the appeal record is exactly where that would bite.
 */
function evidenceInputsOf(
  evidence: {
    readonly likes: readonly { readonly likeId: string; readonly state: string }[];
    readonly passes: readonly { readonly passId: string; readonly state: string }[];
    readonly matchId: string | null;
  },
  relationship: RelationshipSnapshot,
): readonly ReportEvidenceInput[] {
  const digest = createHash('sha256')
    .update(JSON.stringify({ likes: evidence.likes, passes: evidence.passes, matchId: evidence.matchId }))
    .digest('hex');
  return [
    {
      kind: 'report_statement',
      sourceDomain: 'moderation',
      artefactReference: `dating-relationship:${digest.slice(0, 32)}`,
      digest,
      redactedSummary:
        `Relationship at report time: ${relationship.status}; ` +
        `${evidence.likes.length} like(s), ${evidence.passes.length} pass(es)`,
    },
  ];
}
