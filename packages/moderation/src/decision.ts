import {
  type AccountEvent,
  type AccountState,
  type ActorId,
  type CaseId,
  type CorrelationId,
  type DomainError,
  type DomainEvent,
  type Result,
  type UserId,
  accountMachine,
  UNRESTRICTABLE_CAPABILITIES,
  capabilitiesFor,
  castId,
  domainError,
  ok,
} from '@been-there/core';
import { type Case, canWorkCase, caseMachine } from './case.js';
import { type ModeratorActor } from './evidence.js';
import {
  type AccountStateChangedPayload,
  type ModerationContext,
  OUTWARD_ENFORCEMENT_EVENT,
  type RestrictionAppliedPayload,
} from './events.js';
import { type DecisionId, type HumanActorId, asHumanActor } from './ids.js';
import { type Report, reportMachine } from './report.js';

/**
 * Decisions (issue #7).
 *
 * A `Decision` is a value object, not a log line: it names the case it was
 * taken on, the human who took it, the account standing it produced and the
 * capability set it removed. It is immutable, and nothing ever overwrites one —
 * a reversal is a *new* decision that references the old one. That single rule
 * is what makes an appeal answerable later (issue #1 lists appeals as P1):
 * the full chain of decisions for an account is still there to be read.
 *
 * `applyDecision` is a thin adapter over the shared `accountMachine`: the
 * kernel's guards decide whether a restriction, suspension or ban is legal at
 * all, so there is one place where "on what authority" is answered. The two
 * things the kernel deliberately does not hold — the capability floor and the
 * fact that a person, not a service, is behind the decision — are checked here
 * rather than left to the orchestrator, because this is the function that
 * produces the `Decision` an appeal is answered from and it is exported.
 */
export type DecisionAction = 'warn' | 'restrict' | 'suspend' | 'ban' | 'clear';

export const ACCOUNT_EVENT_BY_ACTION: Readonly<Record<DecisionAction, AccountEvent | null>> = {
  warn: null,
  clear: null,
  restrict: 'restrict',
  suspend: 'suspend',
  ban: 'ban',
};

/**
 * A reversal is a decision too: its action is `clear` (the account carries no
 * sanction from this case) and `accountEvent` records the lift that was driven.
 * `warn` has no reversal — a warning is a recorded conversation, not a sanction.
 */
export const ACCOUNT_EVENT_BY_REVERSIBLE_ACTION: Readonly<
  Partial<Record<DecisionAction, AccountEvent>>
> = {
  restrict: 'lift_restriction',
  suspend: 'reinstate',
  ban: 'lift_ban',
};

const MIN_RATIONALE_LENGTH = 20;

export interface Decision {
  readonly decisionId: DecisionId;
  readonly caseId: CaseId;
  readonly moderatorId: ActorId;
  readonly subjectId: UserId;
  readonly action: DecisionAction;
  /** Always named for `restrict`; empty otherwise. */
  readonly removedCapabilities: readonly string[];
  /** The sentence an appeal reviewer will read first, and the one we defend. */
  readonly rationale: string;
  readonly decidedAt: Date;
  /** The decision this one answers, or null. Decisions are never overwritten. */
  readonly reverses: DecisionId | null;
  readonly accountEvent: AccountEvent | null;
  /** Standing after the decision. Equals the previous standing for warn/clear. */
  readonly resultingAccountState: AccountState;
}

export interface DecisionCommand {
  readonly decisionId: DecisionId;
  /** Nullable at the boundary: an enforcement decision with no case is invalid. */
  readonly caseId: CaseId | null;
  /**
   * Not nullable for want of an id, and not an `ActorId`: `HumanActorId` is an
   * id only a human-facing entry point can mint, so the id a service already
   * holds is not assignable and the call does not compile (commitment #2).
   */
  readonly moderatorId: HumanActorId | null;
  /**
   * The runtime half of the same claim, and required rather than defaulted: a
   * caller that states nothing about its own provenance has not earned
   * enforcement, and an absent claim is refused rather than assumed human.
   * The id above is a type the domain cannot verify, so this is where a forged
   * one is caught — inside the function, for every caller.
   */
  readonly automated: boolean;
  readonly subjectId: UserId;
  readonly action: DecisionAction;
  readonly rationale: string;
  readonly currentAccountState: AccountState;
  readonly removedCapabilities?: readonly string[] | undefined;
  readonly reverses?: DecisionId | null;
  readonly decidedAt: Date;
}

/** Returns the narrowed ids, so callers never re-check authority themselves. */
function validateAuthority(
  command: Pick<DecisionCommand, 'caseId' | 'moderatorId' | 'rationale' | 'automated'>,
): Result<{ readonly caseId: CaseId; readonly moderatorId: ActorId }, DomainError> {
  if (command.caseId === null) {
    return domainError(
      'validation_failed',
      'moderation.decision',
      'every decision must reference the case it was taken on',
      { action: 'enforcement' },
    );
  }
  // Compared against `false`, not tested for truth: the claim has to be made
  // to be believed, so a caller that omits it — an untyped caller, or a new
  // field someone forgot — is refused rather than assumed human.
  if (command.automated !== false) {
    return domainError(
      'permission_denied',
      'moderation.decision',
      'automation never enforces: a decision requires a caller that states a human took it',
      { caseId: command.caseId, automated: command.automated },
    );
  }
  if (command.moderatorId === null) {
    return domainError(
      'validation_failed',
      'moderation.decision',
      'automation never enforces: a decision requires a named moderator',
      { caseId: command.caseId },
    );
  }
  if (command.rationale.trim().length < MIN_RATIONALE_LENGTH) {
    return domainError(
      'validation_failed',
      'moderation.decision',
      `a decision must carry a rationale of at least ${MIN_RATIONALE_LENGTH} characters`,
      { caseId: command.caseId, length: command.rationale.trim().length },
    );
  }
  return ok({ caseId: command.caseId, moderatorId: command.moderatorId });
}

export function applyDecision(
  command: DecisionCommand,
): Result<Decision, DomainError> {
  const authority = validateAuthority(command);
  if (!authority.ok) {
    return authority;
  }
  const { caseId, moderatorId } = authority.value;

  const accountEvent = ACCOUNT_EVENT_BY_ACTION[command.action];
  const removed = command.removedCapabilities ?? [];
  let resultingAccountState = command.currentAccountState;

  if (accountEvent !== null) {
    // The intake valve, and the first of the two capability checks.
    // `capabilitiesFor` also refuses to strip these, but a moderator who types
    // `report` into a restriction must be told no rather than have the name
    // silently dropped: a decision that records fewer removals than the one
    // taken is a decision nobody made. Ahead of the not-held check so a
    // capability the account does not hold *and* may never lose —
    // `delete_account`, granted only by `banned` — is reported for the reason
    // that actually matters rather than as a capability the account lacks.
    const unrestrictable = removed.filter((capability) =>
      UNRESTRICTABLE_CAPABILITIES.includes(capability),
    );
    if (unrestrictable.length > 0) {
      return domainError(
        'validation_failed',
        'moderation.decision',
        `a restriction may never remove ${unrestrictable.join(', ')}: reporting and blocking must survive every sanction, and every state keeps a way out`,
        { caseId, unrestrictable: unrestrictable.join(',') },
      );
    }
    const held = capabilitiesFor(command.currentAccountState);
    const unknown = removed.filter((capability) => !held.includes(capability));
    if (unknown.length > 0) {
      return domainError(
        'validation_failed',
        'moderation.decision',
        `a restriction may only name capabilities the account actually holds: ${unknown.join(', ')}`,
        { caseId, unknown: unknown.length },
      );
    }
    // The kernel decides whether this transition is legal. We only pass the
    // authority along; we do not re-check it.
    const next = accountMachine.next(command.currentAccountState, accountEvent, {
      caseId,
      moderatorId,
      removedCapabilities: removed,
    });
    if (!next.ok) {
      return next;
    }
    resultingAccountState = next.value;
  }

  return ok({
    decisionId: command.decisionId,
    caseId,
    moderatorId,
    subjectId: command.subjectId,
    action: command.action,
    removedCapabilities: accountEvent === null ? [] : removed,
    rationale: command.rationale.trim(),
    decidedAt: command.decidedAt,
    reverses: command.reverses ?? null,
    accountEvent,
    resultingAccountState,
  });
}

export interface ReversalCommand {
  readonly decisionId: DecisionId;
  readonly caseId: CaseId | null;
  /** A reversal is a decision, so it carries the same human authority. */
  readonly moderatorId: HumanActorId | null;
  /** See `DecisionCommand.automated`: a machine may not lift a sanction either. */
  readonly automated: boolean;
  readonly subjectId: UserId;
  /** The decision being answered. Never mutated, never removed. */
  readonly reverses: Decision;
  readonly rationale: string;
  readonly currentAccountState: AccountState;
  readonly decidedAt: Date;
}

/**
 * Reversal. The account is moved back by the kernel's lift transitions; the
 * original decision stays exactly as it was taken, and the audit gains a second
 * row pointing at it.
 */
export function applyReversal(
  command: ReversalCommand,
): Result<Decision, DomainError> {
  const authority = validateAuthority(command);
  if (!authority.ok) {
    return authority;
  }
  const { caseId, moderatorId } = authority.value;
  const accountEvent = ACCOUNT_EVENT_BY_REVERSIBLE_ACTION[command.reverses.action];
  if (accountEvent === undefined) {
    return domainError(
      'validation_failed',
      'moderation.decision',
      `a '${command.reverses.action}' decision carries no sanction and has nothing to reverse`,
      { caseId, action: command.reverses.action },
    );
  }

  const next = accountMachine.next(command.currentAccountState, accountEvent, {
    caseId,
    moderatorId,
  });
  if (!next.ok) {
    return next;
  }

  return ok({
    decisionId: command.decisionId,
    caseId,
    moderatorId,
    subjectId: command.subjectId,
    action: 'clear',
    removedCapabilities: [],
    rationale: command.rationale.trim(),
    decidedAt: command.decidedAt,
    reverses: command.reverses.decisionId,
    accountEvent,
    resultingAccountState: next.value,
  });
}

export interface DecideCommand {
  readonly moderationCase: Case;
  readonly actor: ModeratorActor;
  readonly action: DecisionAction;
  readonly rationale: string;
  readonly currentAccountState: AccountState;
  readonly removedCapabilities?: readonly string[] | undefined;
  readonly correlationId: CorrelationId;
}

export interface DecisionOutcome {
  readonly decision: Decision;
  /** The case, now resolved, with `resolutionDecisionId` pointing at the decision. */
  readonly moderationCase: Case;
  readonly accountState: AccountState;
  readonly events: readonly DomainEvent[];
}

/** Decisions are taken from a review, never straight off a queue item. */
const REVIEW_STATES: readonly Case['state'][] = ['in_review', 'escalated'];

export function decide(
  ctx: ModerationContext,
  command: DecideCommand,
): Result<DecisionOutcome, DomainError> {
  if (!REVIEW_STATES.includes(command.moderationCase.state)) {
    return domainError(
      'not_eligible',
      'moderation.decision',
      `a decision is recorded from a review; case is '${command.moderationCase.state}'`,
      { caseId: command.moderationCase.caseId, state: command.moderationCase.state },
    );
  }
  const permitted = canWorkCase(command.moderationCase, command.actor);
  if (!permitted.ok) {
    return permitted;
  }

  const decisionId = castId<'DecisionId'>(ctx.ids.next());
  const decided = applyDecision({
    decisionId,
    caseId: command.moderationCase.caseId,
    // `canWorkCase` has just refused an automated actor, so the narrowing the
    // brand stands for is true here rather than asserted here.
    moderatorId: asHumanActor(command.actor.actorId),
    automated: command.actor.automated,
    subjectId: command.moderationCase.subjectId,
    action: command.action,
    rationale: command.rationale,
    currentAccountState: command.currentAccountState,
    removedCapabilities: command.removedCapabilities,
    decidedAt: ctx.now(),
  });
  if (!decided.ok) {
    return decided;
  }
  const decision = decided.value;

  const resolved = caseMachine.next(command.moderationCase.state, 'resolve', {
    moderatorId: command.actor.actorId,
    decisionId,
  });
  if (!resolved.ok) {
    return resolved;
  }
  const updatedAt = ctx.now();
  const moderationCase: Case = {
    ...command.moderationCase,
    state: resolved.value,
    resolutionDecisionId: decisionId,
    updatedAt,
  };

  const events: DomainEvent[] = [
    ctx.events.emit({
      type: 'moderation.decision_recorded',
      actorId: command.actor.actorId,
      subjectId: decision.subjectId,
      correlationId: command.correlationId,
      sensitivity: 'restricted',
      payload: { decisionId, caseId: decision.caseId, action: decision.action },
    }),
    ctx.events.emit({
      type: 'moderation.case_resolved',
      actorId: command.actor.actorId,
      subjectId: decision.subjectId,
      correlationId: command.correlationId,
      sensitivity: 'restricted',
      payload: { caseId: moderationCase.caseId, decisionId },
    }),
  ];

  if (decision.accountEvent !== null) {
    const removedCapabilities = decision.removedCapabilities;
    const payload: AccountStateChangedPayload = {
      accountState: decision.resultingAccountState,
      capabilities: capabilitiesFor(decision.resultingAccountState, { removedCapabilities }),
      removedCapabilities,
    };
    const toSubject: RestrictionAppliedPayload = {
      caseId: decision.caseId,
      decisionId: decision.decisionId,
      accountState: decision.resultingAccountState,
      removedCapabilities,
    };
    events.push(
      // Public: any surface enforcing the capability set needs it, and it carries
      // no reason.
      ctx.events.emit<AccountStateChangedPayload>({
        type: OUTWARD_ENFORCEMENT_EVENT,
        actorId: command.actor.actorId,
        subjectId: decision.subjectId,
        correlationId: command.correlationId,
        sensitivity: 'public',
        payload,
      }),
      // User: the same decision, addressed to the person it was taken against,
      // and the only place a case id leaves the restricted record.
      ctx.events.emit<RestrictionAppliedPayload>({
        type: 'moderation.restriction_applied',
        actorId: command.actor.actorId,
        subjectId: decision.subjectId,
        correlationId: command.correlationId,
        sensitivity: 'user',
        payload: toSubject,
      }),
    );
  }

  ctx.audit.append({
    occurredAt: decision.decidedAt,
    actorId: command.actor.actorId,
    action: 'decision.recorded',
    entityType: 'decision',
    entityId: decision.decisionId,
    subjectId: decision.subjectId,
    caseId: decision.caseId,
    evidenceIds: moderationCase.evidenceIds,
    decisionId: decision.decisionId,
    outcome: 'allowed',
    reversal:
      ACCOUNT_EVENT_BY_REVERSIBLE_ACTION[decision.action] === undefined
        ? null
        : {
            via: 'account_state',
            accountEvent: ACCOUNT_EVENT_BY_REVERSIBLE_ACTION[decision.action] ?? 'lift_restriction',
          },
    detail: {
      action: decision.action,
      fromState: command.currentAccountState,
      toState: decision.resultingAccountState,
      removed: decision.removedCapabilities.join(','),
    },
  });
  ctx.audit.append({
    occurredAt: updatedAt,
    actorId: command.actor.actorId,
    action: 'case.resolved',
    entityType: 'case',
    entityId: moderationCase.caseId,
    subjectId: moderationCase.subjectId,
    caseId: moderationCase.caseId,
    evidenceIds: [],
    decisionId: decision.decisionId,
    outcome: 'allowed',
    reversal: { via: 'new_decision', decisionId: decision.decisionId },
    detail: { state: moderationCase.state, action: decision.action },
  });

  return ok({ decision, moderationCase, accountState: decision.resultingAccountState, events });
}


export interface ReverseCommand {
  readonly moderationCase: Case;
  readonly actor: ModeratorActor;
  /** The decision being answered. Read, never written. */
  readonly reverses: Decision;
  readonly rationale: string;
  readonly currentAccountState: AccountState;
  readonly correlationId: CorrelationId;
}

export interface ReversalOutcome {
  readonly decision: Decision;
  readonly accountState: AccountState;
  readonly events: readonly DomainEvent[];
}

/**
 * A reversal does not rewrite the past. The case stays `resolved` — that review
 * really did happen and really did produce that decision — and a second
 * decision is recorded against it with `reverses` set. The audit log then reads
 * as the honest sequence: decision, then answer to that decision.
 */
export function reverseDecision(
  ctx: ModerationContext,
  command: ReverseCommand,
): Result<ReversalOutcome, DomainError> {
  const permitted = canWorkCase(command.moderationCase, command.actor);
  if (!permitted.ok) {
    return permitted;
  }
  const decisionId = castId<'DecisionId'>(ctx.ids.next());
  const reversed = applyReversal({
    decisionId,
    caseId: command.moderationCase.caseId,
    moderatorId: asHumanActor(command.actor.actorId),
    automated: command.actor.automated,
    subjectId: command.reverses.subjectId,
    reverses: command.reverses,
    rationale: command.rationale,
    currentAccountState: command.currentAccountState,
    decidedAt: ctx.now(),
  });
  if (!reversed.ok) {
    return reversed;
  }
  const decision = reversed.value;

  const events: DomainEvent[] = [
    ctx.events.emit({
      type: 'moderation.decision_reversed',
      actorId: command.actor.actorId,
      subjectId: decision.subjectId,
      correlationId: command.correlationId,
      sensitivity: 'restricted',
      payload: { decisionId, reverses: command.reverses.decisionId },
    }),
    // A reversal restores exactly what the reversed decision removed, so the
    // subject is told the same four things about the lift that they were told
    // about the restriction. The public event carries an empty removed set: a
    // lift takes nothing away, whatever the sanctioned decision named.
    ctx.events.emit<AccountStateChangedPayload>({
      type: OUTWARD_ENFORCEMENT_EVENT,
      actorId: command.actor.actorId,
      subjectId: decision.subjectId,
      correlationId: command.correlationId,
      sensitivity: 'public',
      payload: {
        accountState: decision.resultingAccountState,
        capabilities: capabilitiesFor(decision.resultingAccountState),
        removedCapabilities: [],
      },
    }),
    ctx.events.emit<RestrictionAppliedPayload>({
      type: 'moderation.restriction_lifted',
      actorId: command.actor.actorId,
      subjectId: decision.subjectId,
      correlationId: command.correlationId,
      sensitivity: 'user',
      payload: {
        caseId: decision.caseId,
        decisionId: decision.decisionId,
        accountState: decision.resultingAccountState,
        removedCapabilities: command.reverses.removedCapabilities,
      },
    }),
  ];

  ctx.audit.append({
    occurredAt: decision.decidedAt,
    actorId: command.actor.actorId,
    action: 'decision.reversed',
    entityType: 'decision',
    entityId: decision.decisionId,
    subjectId: decision.subjectId,
    caseId: decision.caseId,
    evidenceIds: command.moderationCase.evidenceIds,
    decisionId: decision.decisionId,
    outcome: 'allowed',
    reversal: null,
    detail: { reverses: command.reverses.decisionId, toState: decision.resultingAccountState },
  });

  return ok({ decision, accountState: decision.resultingAccountState, events });
}

/**
 * Appeal readiness (issue #7 "future appeal support"; the flow itself is P1 and
 * out of scope for v0.1).
 *
 * Two things are true by construction here, and they are the only things an
 * appeal process needs:
 *  - a decision is never edited or removed, so the account's full sanction
 *    history stays readable through `AuditLog.bySubject`;
 *  - an appeal is answerable by pointing at decisions, and a granted appeal is
 *    recorded as a *new* decision with `reverses` set — never as an edit of the
 *    original.
 * `isAppealable` encodes the first half of that contract: a sanction that is
 * still in force and has not already been reversed.
 */
export function isAppealable(
  decision: Decision,
  history: readonly Decision[],
): boolean {
  if (decision.action === 'clear') {
    return false;
  }
  return !history.some((entry) => entry.reverses === decision.decisionId);
}

export interface ReportClosure {
  readonly reports: readonly Report[];
  readonly closedReportIds: readonly string[];
}

/**
 * Tie the report lifecycle to the decision. A report is never silently closed
 * by "the case is done" — it is moved to `actioned` or `dismissed` by the same
 * decision that resolved the case, under the same moderator and case ids.
 */
export function closeReportsWithDecision(
  ctx: ModerationContext,
  reports: readonly Report[],
  decision: Decision,
  correlationId: CorrelationId,
): Result<ReportClosure, DomainError> {
  const closed: Report[] = [];
  const closedReportIds: string[] = [];

  for (const report of reports) {
    const event = decision.action === 'clear' ? 'dismiss' : 'action';
    const next = reportMachine.next(report.state, event, {
      caseId: decision.caseId,
      moderatorId: decision.moderatorId,
      decisionId: decision.decisionId,
    });
    if (!next.ok) {
      continue;
    }
    const updatedAt = ctx.now();
    const updated: Report = { ...report, state: next.value, updatedAt };
    closed.push(updated);
    closedReportIds.push(report.reportId);
    ctx.audit.append({
      occurredAt: updatedAt,
      actorId: decision.moderatorId,
      action: 'report.status_changed',
      entityType: 'report',
      entityId: report.reportId,
      subjectId: report.subjectId,
      caseId: decision.caseId,
      evidenceIds: [],
      decisionId: decision.decisionId,
      outcome: 'allowed',
      reversal: null,
      detail: { state: updated.state },
    });
  }

  ctx.events.emit({
    type: 'moderation.report_status_changed',
    actorId: decision.moderatorId,
    subjectId: decision.subjectId,
    correlationId,
    sensitivity: 'restricted',
    payload: { caseId: decision.caseId, reportIds: closedReportIds },
  });

  return ok({ reports: closed, closedReportIds });
}
