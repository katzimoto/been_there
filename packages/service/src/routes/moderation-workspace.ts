import { randomUUID } from 'node:crypto';
import {
  type AccountState,
  type CorrelationId,
  type DomainError,
  type Result,
  capabilitiesFor,
  castId,
  domainError,
  isVisibleInProduct,
  ok,
} from '@been-there/core';
import {
  type EvidenceRecord,
  type EvidenceView,
  type ModeratorActor,
  ACCOUNT_EVENT_BY_REVERSIBLE_ACTION,
  isAppealable,
  readEvidence,
  reverseDecision,
} from '@been-there/moderation';
import { APPOINTMENT_BY_ROLE, authorize, protectedActionForAccountEvent } from '@been-there/platform';
import { MISSING_FIELD, NOT_FOUND } from '../http/failure.js';
import { readString } from '../http/body.js';
import { okResponse, route, type HttpResponse, type Route, type RouteRequest } from '../http/router.js';
import type { ServiceDependencies } from '../ports.js';
import { subjectStandingFor } from '../wiring/standing.js';
import {
  auditAppender,
  caseOf,
  decisionRowOf,
  flushAudit,
  reportOf,
  requestModerationContext,
} from '../wiring/moderation.js';
import { loadDecisions } from '../wiring/moderation-decisions.js';
import { evidenceRecordOf } from '../wiring/moderation-evidence.js';

/**
 * The moderator workspace: one case, its evidence, and the answer to a decision.
 *
 * There is no client in this repository, so nothing here is a screen. What is
 * here is the server half that a workspace would be built on, and the half that
 * is worth having: the boundaries. Every property below is enforced on the
 * server because a moderator console is not a trust boundary — the console can be
 * closed, and a caller with a token cannot be.
 *
 * ## What the case view is allowed to omit
 *
 * The case record and the decisions taken on it are what a moderator reads to
 * work a case. The evidence is not in that response and the reporter's identity
 * is not either, because evidence has its own audited read with its own
 * clearance ladder, and a report's `reporterId` and `statement` are classified
 * `restricted` by `user-safety-controls.md` §5.2 and §8. Returning them here
 * would make the case view a side door around the gate that exists to keep
 * them out of a surface that has no business showing them.
 *
 * ## The redaction gate is the domain's, not this file's
 *
 * `readEvidence` is called once per record and its `EvidenceView` is what is
 * written to the response. A `denied` view carries an id and a kind and nothing
 * else; a `redacted` one carries the summary and never the digest or the
 * artefact reference. There is no branch here that reaches past it, and there
 * must not be one added: a `full` view is the only thing that may carry
 * `artefactReference`, and it is the domain that decides which of the three a
 * given actor gets.
 *
 * ## A reversal appends
 *
 * `reverseDecision` returns a new decision carrying `reverses`. The service
 * writes it with `insertDecision` and never touches the case row: the review
 * happened and produced the original decision, and a second decision answering
 * it is the honest record. The account standing moves because a lift is an
 * account event, and a lift restores the state's full grant rather than
 * subtracting from it.
 */

export function moderatorWorkspaceRoutes(dependencies: ServiceDependencies): readonly Route[] {
  return [
    route('GET', '/v1/moderation/cases/:caseId', async (request) => caseDetail(dependencies, request)),
    route('GET', '/v1/moderation/cases/:caseId/evidence', async (request) =>
      readCaseEvidence(dependencies, request),
    ),
    route('POST', '/v1/moderation/cases/:caseId/decisions/:decisionId/reversal', async (request) =>
      reverseADecision(dependencies, request),
    ),
  ];
}

/** The `:caseId` the pattern captured, or a 400 naming the field it did not. */
function caseIdOf(request: RouteRequest): Result<string, DomainError> {
  const caseId = request.params['caseId'] ?? '';
  return caseId.length === 0 ? MISSING_FIELD('caseId') : ok(caseId);
}

async function caseDetail(
  dependencies: ServiceDependencies,
  request: RouteRequest,
): Promise<Result<HttpResponse, DomainError>> {
  const caseId = caseIdOf(request);
  if (!caseId.ok) {
    return caseId;
  }
  // `case.read` and not `case.read_evidence`: this response carries no evidence.
  // It is the same authority the queue itself is served on, and the case record
  // is what that authority is for.
  const permitted = authorize(request.actor.principal, 'case.read');
  if (!permitted.ok) {
    return permitted;
  }
  const row = await dependencies.stores.moderation.findCase(castId<'CaseId'>(caseId.value), request.tx);
  if (row === null) {
    return NOT_FOUND('case');
  }
  const moderationCase = caseOf(row);
  // The full decision history, in the order the case took them, and every one
  // of them. A reversal is a second decision on the case, so a case view that
  // showed only the resolution would show a record the appeal process cannot
  // use.
  const history = await loadDecisions(dependencies.stores.moderation, moderationCase.caseId, request.tx);
  return okResponse(200, {
    caseId: moderationCase.caseId,
    subjectId: moderationCase.subjectId,
    origin: moderationCase.origin,
    state: moderationCase.state,
    priority: moderationCase.priority,
    queue: moderationCase.queue,
    openedAt: moderationCase.openedAt.toISOString(),
    dueAt: moderationCase.dueAt.toISOString(),
    openedBy: moderationCase.openedBy,
    assignedModeratorId: moderationCase.assignedModeratorId,
    reportIds: moderationCase.reportIds,
    evidenceIds: moderationCase.evidenceIds,
    resolutionDecisionId: moderationCase.resolutionDecisionId,
    decisions: history.map((decision) => ({
      decisionId: decision.decisionId,
      action: decision.action,
      moderatorId: decision.moderatorId,
      rationale: decision.rationale,
      removedCapabilities: decision.removedCapabilities,
      decidedAt: decision.decidedAt.toISOString(),
      // `reverses` is what makes the record answerable: a decision that has
      // already been answered is not appealable, and that is the domain's
      // judgement rather than a count the service keeps.
      reverses: decision.reverses,
      resultingAccountState: decision.resultingAccountState,
      appealable: isAppealable(decision, history),
    })),
  });
}

/**
 * Every record of evidence the case points at, each one through the redaction
 * gate, and every one audited.
 *
 * The audit is not conditional on the outcome: a denied read is the row a
 * clearance-graded consumer most wants, because it says somebody reached for
 * evidence they were not entitled to. `readEvidence` appends it, and this
 * handler flushes the buffer inside the request's transaction — a read that was
 * not written is not audited.
 */
async function readCaseEvidence(
  dependencies: ServiceDependencies,
  request: RouteRequest,
): Promise<Result<HttpResponse, DomainError>> {
  const caseId = caseIdOf(request);
  if (!caseId.ok) {
    return caseId;
  }
  const permitted = authorize(request.actor.principal, 'case.read_evidence', {
    caseId: castId<'CaseId'>(caseId.value),
  });
  if (!permitted.ok) {
    return permitted;
  }
  if (request.actor.automated) {
    return domainError(
      'permission_denied',
      'moderation.evidence',
      'automation may not read case evidence: a machine holding a case artefact is an enforcement decision nobody made',
      { caseId: caseId.value },
    );
  }
  const typed = castId<'CaseId'>(caseId.value);
  const row = await dependencies.stores.moderation.findCase(typed, request.tx);
  if (row === null) {
    return NOT_FOUND('case');
  }
  const moderationCase = caseOf(row);
  const stored = await evidenceOnCase(dependencies, request, typed, moderationCase.reportIds);
  // The actor is the identity the resolver authenticated, not a name in the
  // body: a read is a fact about who looked, and a self-declared name is not
  // that fact.
  const actor: ModeratorActor = {
    actorId: request.actor.actorId,
    ...APPOINTMENT_BY_ROLE[request.actor.principal.role],
    automated: request.actor.automated,
  };
  const correlationId = castId<'CorrelationId'>(randomUUID());
  const { context, pending } = requestModerationContext(request.now);

  const views: EvidenceView[] = [];
  const unavailable: string[] = [];
  for (const evidenceId of moderationCase.evidenceIds) {
    const record = stored.get(evidenceId);
    if (record === undefined) {
      unavailable.push(evidenceId);
      continue;
    }
    views.push(readEvidence(context, actor, record, typed, correlationId));
  }
  await flushAudit(
    pending,
    auditAppender((entry, tx) => dependencies.stores.moderation.appendAudit(entry, tx)),
    request.tx,
  );
  return okResponse(200, {
    caseId: typed,
    evidence: views.map(evidenceBody),
    // Named rather than dropped: the case points at these ids and the schema has
    // nowhere to hold the records behind them, so a console has to be able to
    // say "this one is not readable" rather than quietly showing fewer rows than
    // the case claims.
    unavailable,
    auditEntries: pending.length,
  });
}

async function reverseADecision(
  dependencies: ServiceDependencies,
  request: RouteRequest,
): Promise<Result<HttpResponse, DomainError>> {
  const caseId = caseIdOf(request);
  if (!caseId.ok) {
    return caseId;
  }
  const decisionId = request.params['decisionId'] ?? '';
  if (decisionId.length === 0) {
    return MISSING_FIELD('decisionId');
  }
  const moderatorRaw = readString(request.body, 'moderatorId');
  if (!moderatorRaw.ok) {
    return domainError(
      'validation_failed',
      'service.http',
      'a reversal must name the moderator who took it',
      { field: 'moderatorId' },
    );
  }
  const rationale = readString(request.body, 'rationale');
  if (!rationale.ok) {
    return rationale;
  }
  const typedCase = castId<'CaseId'>(caseId.value);
  const row = await dependencies.stores.moderation.findCase(typedCase, request.tx);
  if (row === null) {
    return NOT_FOUND('case');
  }
  const moderationCase = caseOf(row);
  const history = await loadDecisions(dependencies.stores.moderation, typedCase, request.tx);
  const original = history.find((decision) => decision.decisionId === decisionId);
  if (original === undefined) {
    return NOT_FOUND('decision');
  }
  const moderatorId = castId<'ActorId'>(moderatorRaw.value);

  // The authority a reversal needs is the authority of the *lift*, not of the
  // sanction it answers, and the lift is a different permission: a plain
  // moderator may lift a restriction and may not lift a ban. A decision that
  // carries no sanction has no lift, so there is no specific authority to
  // check and the general case-decision gate applies — `applyReversal` inside
  // the domain is what refuses it, and this handler does not restate that rule.
  const lift = ACCOUNT_EVENT_BY_REVERSIBLE_ACTION[original.action];
  const permitted = authorize(
    request.actor.principal,
    lift === undefined ? 'case.decide' : protectedActionForAccountEvent(lift),
    { caseId: typedCase, moderatorId },
  );
  if (!permitted.ok) {
    return permitted;
  }
  if (request.actor.automated) {
    return domainError(
      'permission_denied',
      'moderation.decision',
      'automation never lifts a sanction either: a reversal is a decision, and a decision is a person',
      { caseId: typedCase, decisionId },
    );
  }
  const standing = await subjectStandingFor(dependencies.stores, moderationCase.subjectId, request.now, request.tx);
  // No standing row means the account machine's declared initial state, which
  // is what the same projection reports to every product surface.
  const currentAccountState: AccountState = standing?.standing.account.state ?? 'active';
  const actor: ModeratorActor = {
    actorId: moderatorId,
    ...APPOINTMENT_BY_ROLE[request.actor.principal.role],
    automated: request.actor.automated,
  };
  const { context, pending } = requestModerationContext(request.now);
  const outcome = reverseDecision(context, {
    moderationCase,
    actor,
    reverses: original,
    rationale: rationale.value,
    currentAccountState,
    correlationId: castId<'CorrelationId'>(randomUUID()),
  });
  if (!outcome.ok) {
    return outcome;
  }

  // An insert and nothing else. The original row is not read for writing, and
  // there is no store method that could update one — so the original decision
  // is byte-identical afterwards by construction rather than by care.
  await dependencies.stores.moderation.insertDecision(decisionRowOf(outcome.value.decision), request.tx);
  // The case is deliberately untouched. The review happened and produced the
  // decision it produced; a reversal is an answer to that decision, not a
  // re-opening of the case.
  const previous = await dependencies.stores.accountStanding.find(moderationCase.subjectId, request.tx);
  const expectedGeneration = previous?.generation ?? null;
  const applied = await dependencies.stores.accountStanding.upsert(
    {
      userId: moderationCase.subjectId,
      state: outcome.value.accountState,
      // A lift restores the state's grant rather than subtracting from it: the
      // removed set belonged to the decision being answered, and that decision
      // is still in the record naming what it took.
      capabilities: capabilitiesFor(outcome.value.accountState),
      visibleInProduct: isVisibleInProduct(outcome.value.accountState),
      caseId: typedCase,
      decisionId: outcome.value.decision.decisionId,
      generation: (expectedGeneration ?? 0) + 1,
      updatedAt: request.now,
    },
    expectedGeneration,
    request.tx,
  );
  if (!applied) {
    return domainError('conflict', 'moderation', 'the account standing moved while the reversal was being applied', {
      caseId: typedCase,
    });
  }
  await flushAudit(
    pending,
    auditAppender((entry, tx) => dependencies.stores.moderation.appendAudit(entry, tx)),
    request.tx,
  );
  return okResponse(201, {
    decisionId: outcome.value.decision.decisionId,
    reverses: outcome.value.decision.reverses,
    caseId: outcome.value.decision.caseId,
    moderatorId: outcome.value.decision.moderatorId,
    // A reversal is recorded as `clear`: the sanction it answers is the thing
    // that carried the action, and naming it again here would be a second claim
    // about the original decision.
    action: outcome.value.decision.action,
    accountState: outcome.value.accountState,
    // Still resolved. The case's own resolution pointer still names the
    // original decision, and this response says so rather than implying the case
    // was reopened.
    caseState: moderationCase.state,
    resolutionDecisionId: moderationCase.resolutionDecisionId,
    auditEntries: pending.length,
  });
}

/**
 * The evidence a case's reports froze, by id.
 *
 * `reports.captured_evidence` is where the frozen evidence actually lives in
 * this schema — a report is the record that outlives what produced it, and the
 * case points at the ids. Evidence captured at case *intake* (a risk
 * assessment, an identity anomaly) has no table of its own, which is why a case
 * opened that way reports its ids as `unavailable` rather than pretending to
 * have read them.
 */
async function evidenceOnCase(
  dependencies: ServiceDependencies,
  request: RouteRequest,
  caseId: string,
  reportIds: readonly string[],
): Promise<ReadonlyMap<string, EvidenceRecord>> {
  const stored = new Map<string, EvidenceRecord>();
  for (const reportId of reportIds) {
    const row = await dependencies.stores.moderation.findReport(castId<'ReportId'>(reportId), request.tx);
    if (row === null) {
      continue;
    }
    // Through the strict reader rather than through `reportOf` alone: what
    // `jsonb` returns is what `JSON.stringify` wrote, and the gate reads a date
    // and an access level off this record.
    for (const entry of reportOf(row).capturedEvidence) {
      const record = evidenceRecordOf(entry, castId<'CaseId'>(caseId));
      stored.set(record.evidenceId, record);
    }
  }
  return stored;
}

/**
 * What a view is allowed to put on the wire.
 *
 * The branches are the domain's three outcomes, copied field for field: `full`
 * is the only one that carries the artefact reference and the digest, `denied`
 * carries the id and the kind and nothing that a refusal should have leaked, and
 * `redacted` carries the summary that is safe at every clearance. The date is on
 * all three, because "when was this captured" is not what the gate is about.
 */
function evidenceBody(view: EvidenceView): Readonly<Record<string, unknown>> {
  if (view.visibility === 'denied') {
    return {
      evidenceId: view.evidenceId,
      kind: view.kind,
      visibility: 'denied',
    };
  }
  if (view.visibility === 'redacted') {
    return {
      evidenceId: view.evidenceId,
      kind: view.kind,
      visibility: 'redacted',
      capturedAt: view.capturedAt.toISOString(),
      redactedSummary: view.redactedSummary,
    };
  }
  return {
    evidenceId: view.evidenceId,
    kind: view.kind,
    visibility: 'full',
    capturedAt: view.capturedAt.toISOString(),
    artefactReference: view.artefactReference,
    digest: view.digest,
    redactedSummary: view.redactedSummary,
  };
}
