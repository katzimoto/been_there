import { createHash, randomUUID } from 'node:crypto';
import {
  type AccountState,
  type ActorId,
  type CaseId,
  type CorrelationId,
  type DomainError,
  type MatchId,
  type ReportId,
  type Result,
  capabilitiesFor,
  castId,
  domainError,
  isVisibleInProduct,
  ok,
} from '@been-there/core';
import type { Transaction } from '@been-there/contracts';
import { evidenceForReport } from '@been-there/dating';
import {
  type DecisionAction,
  type ModeratorActor,
  type ReportEvidenceInput,
  type ReportReason,
  type RelationshipSnapshot,
  REPORT_REASON_POLICY,
  assignCase,
  decide,
  openCase,
  startCaseReview,
  submitReport,
  triageReport,
} from '@been-there/moderation';
import { authorize } from '@been-there/platform';
import { MISSING_FIELD, NOT_FOUND } from '../http/failure.js';
import { readEnum, readString, readStringArray } from '../http/body.js';
import { okResponse, route, type HttpResponse, type Route, type RouteRequest } from '../http/router.js';
import type { ServiceDependencies } from '../ports.js';
import { blocksBetween, ledgersFor, matchRecordOf } from '../wiring/dating.js';
import {
  auditAppender,
  caseOf,
  caseRowOf,
  decisionRowOf,
  flushAudit,
  reportOf,
  reportRowOf,
  requestModerationContext,
} from '../wiring/moderation.js';
import { userIdOf } from './accounts.js';
import { subjectStandingFor } from '../wiring/standing.js';

/**
 * Reports, the moderator queue, and decisions.
 *
 * ## A decision is impossible to make without a human
 *
 * Four things have to line up, each checked by a different owner:
 *
 *  1. The body must carry `moderatorId`. Refused at the edge, so the failure is a
 *     400 with a field name rather than a domain refusal discovered three layers
 *     in.
 *  2. `authorize(principal, 'case.decide', { caseId, moderatorId })` — the
 *     platform's least-privilege gate: the role must hold `case.decide.ban`, its
 *     clearance must cover `restricted`, and both a case and a moderator must be
 *     named.
 *  3. `canWorkCase`, inside `assignCase`, `startCaseReview` and `decide`, refuses
 *     an `automated` actor outright. That claim comes from the actor resolver,
 *     not from the request, because a request cannot be trusted to say it is not
 *     a machine.
 *  4. `validateAuthority`, inside `decide`, refuses `automated !== false` and a
 *     null moderator id, and turns the id into the `HumanActorId` brand that
 *     `packages/moderation` mints nowhere else.
 *
 * There is no request shape that produces a decision without a named person
 * behind it.
 *
 * ## The audit rows commit with the decision
 *
 * The domain's `AuditLog` is synchronous, so entries land in a buffer while the
 * domain runs and `flushAudit` writes them inside the same transaction. A
 * decision that commits without its audit rows is the one outcome the audit
 * table exists to make impossible.
 *
 * ## A report outlives the relationship
 *
 * The right to report is `evidenceForReport`'s, not this route's: it reads the
 * *retained* records, so a withdrawn like, a superseded pass and an ended match
 * all still yield a reportable subject with each record's state attached. The
 * only thing it refuses is a pair with no recorded interaction at all. That is
 * why a report filed after an unmatch works, and adding an "is the relationship
 * still current" check here would be the one line that broke it.
 */

const REPORT_REASONS: readonly ReportReason[] = Object.keys(REPORT_REASON_POLICY) as ReportReason[];

const DECISION_ACTIONS: readonly DecisionAction[] = ['warn', 'restrict', 'suspend', 'ban', 'clear'];

const CASE_PAGE_LIMIT = 50;

export function moderationRoutes(dependencies: ServiceDependencies): readonly Route[] {
  return [
    route('GET', '/v1/moderation/cases', async (request) => {
      // `case.read` is a `Permission` but not a `ProtectedAction`, so `authorize`
      // has no member for "see the queue" — the closest is `case.open`, which is
      // also `moderatorRequired` and therefore still refuses a caller with no named
      // moderator. Reported rather than papered over: adding
      // `'case.read': { permission: 'case.read', requiredClearance: 'restricted', ... }`
      // to `PROTECTED_ACTIONS` is the exact fix, and it matters because seeing the
      // queue and acting on a case are different authorities.
      const gate = authorize(request.actor.principal, 'case.open', {
        moderatorId: request.actor.actorId,
      });
      if (!gate.ok) {
        return gate;
      }
      const page = await dependencies.stores.moderation.listOpenCases(
        { limit: CASE_PAGE_LIMIT, offset: 0 },
        request.tx,
      );
      return okResponse(200, {
        total: page.total,
        cases: page.items.map((row) => ({
          caseId: row.caseId,
          subjectId: row.subjectId,
          origin: row.origin,
          state: row.state,
          priority: row.priority,
          queue: row.queue,
          openedAt: row.openedAt.toISOString(),
          dueAt: row.dueAt.toISOString(),
          openedBy: row.openedBy,
          assignedModeratorId: row.assignedModeratorId,
          reportIds: row.reportIds,
          evidenceIds: row.evidenceIds,
          resolutionDecisionId: row.resolutionDecisionId,
        })),
      });
    }),

    route('POST', '/v1/moderation/cases', async (request) => openCaseFor(dependencies, request)),

    route('POST', '/v1/moderation/cases/:caseId/decisions', async (request) =>
      recordDecision(dependencies, request),
    ),
  ];
}

/**
 * Opening a case from a report.
 *
 * Both steps are the moderation domain's and in its order: a report must be
 * `triaged` before it opens a case, and triage is a moderator's move, so the
 * moderator id is required here for the same reason it is on the decision
 * endpoint. A report whose relationship has since ended opens a case exactly as
 * one whose relationship is live — `openFromReport` ignores the relationship by
 * design, and that is commitment 4 expressed as a parameter.
 */
async function openCaseFor(
  dependencies: ServiceDependencies,
  request: RouteRequest,
): Promise<Result<HttpResponse, DomainError>> {
  const reportRaw = readString(request.body, 'reportId');
  if (!reportRaw.ok) {
    return reportRaw;
  }
  const moderatorRaw = readString(request.body, 'moderatorId');
  if (!moderatorRaw.ok) {
    return domainError(
      'validation_failed',
      'service.http',
      'opening a case requires the moderator who opened it',
      { field: 'moderatorId' },
    );
  }
  const permitted = authorize(request.actor.principal, 'case.open', {
    moderatorId: castId<'ActorId'>(moderatorRaw.value),
  });
  if (!permitted.ok) {
    return permitted;
  }
  if (request.actor.automated) {
    return domainError(
      'permission_denied',
      'moderation.case',
      'automation may not open a case: a person must own it',
      { reportId: reportRaw.value },
    );
  }
  const reportId = castId<'ReportId'>(reportRaw.value);
  const row = await dependencies.stores.moderation.findReport(reportId, request.tx);
  if (row === null) {
    return NOT_FOUND('report');
  }
  const report = reportOf(row);
  const moderatorId = castId<'ActorId'>(moderatorRaw.value);
  const actor: ModeratorActor = { actorId: moderatorId, isLead: false, identityPrivacyRole: false, automated: request.actor.automated };
  const correlationId = castId<'CorrelationId'>(randomUUID());
  const { context, pending } = requestModerationContext(request.now);
  const triaged = triageReport(context, { report, moderatorId, correlationId });
  if (!triaged.ok) {
    await flushAudit(pending, auditAppender((row, tx) => dependencies.stores.moderation.appendAudit(row, tx)), request.tx);
    return triaged;
  }
  const opened = openCase(context, {
    source: 'user_report',
    report: triaged.value,
    openedBy: moderatorId,
    correlationId,
  });
  if (!opened.ok) {
    await flushAudit(pending, auditAppender((row, tx) => dependencies.stores.moderation.appendAudit(row, tx)), request.tx);
    return opened;
  }
  // `ModerationStore` has no `updateReport`, so the report's move to `triaged` is
  // not persisted: the stored row keeps saying `submitted` while the case records
  // the report id. Reported rather than worked around — writing the report row
  // again through `insertReport` would either fail on the primary key or silently
  // reset a state a moderator set, and both are worse than a stale column.
  await dependencies.stores.moderation.insertCase(
    caseRowOf(opened.value.moderationCase),
    request.tx,
  );
  await flushAudit(pending, auditAppender((row, tx) => dependencies.stores.moderation.appendAudit(row, tx)), request.tx);
  return okResponse(201, {
    caseId: opened.value.moderationCase.caseId,
    subjectId: opened.value.moderationCase.subjectId,
    priority: opened.value.moderationCase.priority,
    queue: opened.value.moderationCase.queue,
    state: opened.value.moderationCase.state,
    dueAt: opened.value.moderationCase.dueAt.toISOString(),
    reportIds: opened.value.moderationCase.reportIds,
    evidenceIds: opened.value.moderationCase.evidenceIds,
  });
}

async function recordDecision(
  dependencies: ServiceDependencies,
  request: RouteRequest,
): Promise<Result<HttpResponse, DomainError>> {
  const moderatorRaw = readString(request.body, 'moderatorId');
  if (!moderatorRaw.ok) {
    return domainError(
      'validation_failed',
      'service.http',
      'a moderation decision must name the moderator who took it',
      { field: 'moderatorId' },
    );
  }
  const action = readEnum(request.body, 'action', DECISION_ACTIONS, 'warn');
  if (!action.ok) {
    return action;
  }
  const rationale = readString(request.body, 'rationale');
  if (!rationale.ok) {
    return rationale;
  }
  // Absent means no removals. `DecisionCommand.removedCapabilities` is optional
  // and `applyDecision` reads an absent list as empty, so requiring the field
  // here would have turned every `warn`, `suspend` and `ban` — none of which names
  // a capability — into a 400 about a field the caller was right to leave out.
  const removedRaw = request.body['removedCapabilities'];
  const removed =
    removedRaw === undefined || removedRaw === null
      ? ok([] as string[])
      : readStringArray(request.body, 'removedCapabilities');
  if (!removed.ok) {
    return removed;
  }
  const caseId = castId<'CaseId'>(request.params['caseId'] ?? '');
  if (caseId.length === 0) {
    return MISSING_FIELD('caseId');
  }
  const moderatorId = castId<'ActorId'>(moderatorRaw.value);

  const permitted = authorize(request.actor.principal, 'case.decide', { caseId, moderatorId });
  if (!permitted.ok) {
    return permitted;
  }
  if (request.actor.automated) {
    return domainError(
      'permission_denied',
      'moderation.case',
      'automation may not work a case: only a human moderator acts on one',
      { caseId },
    );
  }
  const row = await dependencies.stores.moderation.findCase(caseId, request.tx);
  if (row === null) {
    return NOT_FOUND('case');
  }
  const moderationCase = caseOf(row);
  const actor: ModeratorActor = {
    actorId: moderatorId,
    isLead: request.body['isLead'] === true,
    identityPrivacyRole: request.body['identityPrivacyRole'] === true,
    automated: request.actor.automated,
  };
  const subjectStanding = await subjectStandingFor(
    dependencies.stores,
    moderationCase.subjectId,
    request.now,
    request.tx,
  );
  // No standing row means the account machine's declared initial state, which is
  // what the same projection reports to every product surface.
  const currentAccountState: AccountState = subjectStanding?.standing.account.state ?? 'active';
  const correlationId = castId<'CorrelationId'>(randomUUID());
  const { context, pending } = requestModerationContext(request.now);

  // A decision is taken from a review, never straight off a queue item, and the
  // case table is what says so. Assigning and opening the review here is the
  // service driving the transitions the moderator's own action implies, under
  // their id — it is not the service deciding that a review may begin.
  const assigned = assignCase(context, { moderationCase, actor, correlationId });
  if (!assigned.ok) {
    return assigned;
  }
  const reviewing = startCaseReview(context, {
    moderationCase: assigned.value,
    actor,
    correlationId,
  });
  if (!reviewing.ok) {
    return reviewing;
  }
  const outcome = decide(context, {
    moderationCase: reviewing.value,
    actor,
    action: action.value,
    rationale: rationale.value,
    currentAccountState,
    removedCapabilities: removed.value,
    correlationId,
  });
  if (!outcome.ok) {
    return outcome;
  }

  // Decision, case, standing and audit rows: one transaction, or none of them.
  await dependencies.stores.moderation.insertDecision(
    decisionRowOf(outcome.value.decision),
    request.tx,
  );
  await dependencies.stores.moderation.updateCase(
    caseId,
    {
      state: outcome.value.moderationCase.state,
      resolutionDecisionId: outcome.value.decision.decisionId,
      assignedModeratorId: moderatorId,
    },
    request.tx,
  );
  if (outcome.value.decision.accountEvent !== null) {
    // The sanction only takes effect once the standing is persisted, because the
    // standing is what every product surface reads. `capabilitiesFor` is the
    // kernel's own grant computation, so the floor on unrestrictable
    // capabilities is applied where the grant is computed rather than trusted to
    // have been applied upstream.
    const previousStanding = await dependencies.stores.accountStanding.find(
      moderationCase.subjectId,
      request.tx,
    );
    // `null` means "no row was read, so this inserts". A standing that has never
    // been written is not generation 0; passing 0 would claim a row exists and
    // has been written zero times, which the store rightly refuses.
    const expectedGeneration = previousStanding?.generation ?? null;
    const applied = await dependencies.stores.accountStanding.upsert(
      {
        userId: moderationCase.subjectId,
        state: outcome.value.accountState,
        capabilities: capabilitiesFor(outcome.value.accountState, {
          removedCapabilities: outcome.value.decision.removedCapabilities,
        }),
        visibleInProduct: isVisibleInProduct(outcome.value.accountState),
        caseId,
        decisionId: outcome.value.decision.decisionId,
        generation: (expectedGeneration ?? 0) + 1,
        updatedAt: request.now,
      },
      expectedGeneration,
      request.tx,
    );
    if (!applied) {
      return domainError(
        'conflict',
        'moderation',
        'the account standing moved while the decision was being applied',
        { caseId },
      );
    }
  }
  await flushAudit(pending, auditAppender((row, tx) => dependencies.stores.moderation.appendAudit(row, tx)), request.tx);
  return okResponse(201, {
    decisionId: outcome.value.decision.decisionId,
    caseId: outcome.value.moderationCase.caseId,
    action: outcome.value.decision.action,
    moderatorId: outcome.value.decision.moderatorId,
    removedCapabilities: outcome.value.decision.removedCapabilities,
    accountState: outcome.value.accountState,
    caseState: outcome.value.moderationCase.state,
    auditEntries: pending.length,
  });
}

