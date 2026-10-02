import {
  type AccountEvent,
  type AccountState,
  type ActorId,
  type CaseId,
  type UserId,
  castId,
} from '@been-there/core';
import type { ModerationStore, Transaction } from '@been-there/contracts';
import type { Decision, DecisionId } from '@been-there/moderation';
import { corrupt, dateOf, textOf } from './moderation.js';

/**
 * Reading a decision back.
 *
 * `decisionRowOf` writes the aggregate into a row and this reads it out again,
 * and the asymmetry is the whole reason this is its own module: the `decisions`
 * table holds nine columns and the aggregate holds eleven fields. The two it does
 * not hold are on the decision's audit row, because the audit log is where the
 * account move was recorded — so a reversal reads them from there rather than
 * recomputing a standing it never observed.
 */
function stringListOf(row: Readonly<Record<string, unknown>>, field: string): readonly string[] {
  const value = row[field];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw corrupt(`'${field}' is not a list of strings`);
  }
  return value;
}


const DECISION_ACTIONS: readonly Decision['action'][] = ['warn', 'restrict', 'suspend', 'ban', 'clear'];
const ACCOUNT_STATES: readonly AccountState[] = ['active', 'limited', 'suspended', 'banned'];
const ACCOUNT_EVENTS: readonly AccountEvent[] = [
  'restrict',
  'lift_restriction',
  'suspend',
  'reinstate',
  'ban',
  'lift_ban',
];

/**
 * The two facts of a `Decision` the `decisions` table does not hold.
 *
 * `resultingAccountState` is `detail.toState` on the decision's own audit row,
 * and `accountEvent` is `reversal.accountEvent` on it — the audit log is where
 * the account move was recorded, so it is where a later reader takes it from.
 * The one case the audit cannot answer is a reversal: its row records the
 * `reversal` fold as null, and the event that actually moved the account is
 * the lift the decision it reverses named. The caller supplies that, because
 * there is nowhere else in the schema it was written down.
 */
export interface DecisionFacts {
  readonly resultingAccountState: AccountState;
  readonly accountEvent: AccountEvent | null;
}

/**
 * Reads those two facts off a decision's audit row. A row that does not name a
 * standing is corrupt rather than empty: a decision without one could not have
 * been taken, so a reversal that guessed it would be guessing a sanction.
 */
export function decisionFactsFrom(audit: Readonly<Record<string, unknown>>): DecisionFacts {
  const detail = audit['detail'];
  if (typeof detail !== 'object' || detail === null) {
    throw corrupt('a decision audit row carries no detail');
  }
  const toState = (detail as Readonly<Record<string, unknown>>)['toState'];
  const state = ACCOUNT_STATES.find((candidate) => candidate === toState);
  if (state === undefined) {
    throw corrupt(`'${String(toState)}' is not the standing a decision produced`);
  }
  const reversal = audit['reversal'];
  if (reversal === undefined || reversal === null) {
    return { resultingAccountState: state, accountEvent: null };
  }
  const named = (reversal as Readonly<Record<string, unknown>>)['accountEvent'];
  const event = ACCOUNT_EVENTS.find((candidate) => candidate === named);
  if (event === undefined) {
    throw corrupt(`'${String(named)}' is not an account event`);
  }
  return { resultingAccountState: state, accountEvent: event };
}

/**
 * The stored decision, rebuilt into the aggregate a reversal takes.
 *
 * The decoding is strict for the same reason `caseOf` is: a row whose action is
 * not one the domain defines is a `StoreError` rather than a `Decision` with a
 * cast on it, because the action is what decides which lift a reversal performs
 * and who is allowed to perform it.
 */
export function decisionOf(
  row: Readonly<Record<string, unknown>>,
  facts: DecisionFacts,
): Decision {
  const action = DECISION_ACTIONS.find((candidate) => candidate === row['action']);
  if (action === undefined) {
    throw corrupt(`'${String(row['action'])}' is not a decision action`);
  }
  const decisionId = textOf(row, 'decisionId');
  const caseId = castId<'CaseId'>(textOf(row, 'caseId'));
  return {
    decisionId,
    caseId,
    moderatorId: castId<'ActorId'>(textOf(row, 'moderatorId')),
    subjectId: castId<'UserId'>(textOf(row, 'subjectId')),
    action,
    removedCapabilities: stringListOf(row, 'removedCapabilities'),
    rationale: textOf(row, 'rationale'),
    decidedAt: dateOf(row, 'decidedAt', castId<'ReportId'>(decisionId)),
    reverses: typeof row['reverses'] === 'string' ? castId<'DecisionId'>(row['reverses']) : null,
    accountEvent: facts.accountEvent,
    resultingAccountState: facts.resultingAccountState,
  };
}

/**
 * Every decision a case has taken, rebuilt, in the order they were taken.
 *
 * The two facts the table does not hold are read from each decision's own audit
 * row, because the audit log is where the account move was recorded. A reversal
 * is the one case the audit cannot answer — its row records the `reversal` fold
 * as null — and it is answered by the decision it reverses, which is in this
 * same set: a reversal names a decision that already exists, on the same case.
 */
export async function loadDecisions(
  store: ModerationStore,
  caseId: CaseId,
  tx: Transaction,
): Promise<readonly Decision[]> {
  const rows = await store.findDecisionsFor(caseId, tx);
  const facts = new Map<string, DecisionFacts>();
  for (const row of rows) {
    const decisionId = textOf(row, 'decisionId');
    // The decision's own row and not any other row naming it: both the decision
    // and the case resolution it caused are recorded against the decision's
    // entity, and only one of them carries a standing.
    const audit = (await store.findAuditForEntity('decision', decisionId, tx)).find(
      (entry) => entry['action'] === 'decision.recorded' || entry['action'] === 'decision.reversed',
    );
    if (audit === undefined) {
      throw corrupt(`decision ${decisionId} has no row in the audit log`);
    }
    facts.set(decisionId, decisionFactsFrom(audit));
  }
  return rows.map((row) => {
    const decisionId = textOf(row, 'decisionId');
    const recorded = facts.get(decisionId);
    if (recorded === undefined) {
      throw corrupt(`decision ${decisionId} has no recorded account move`);
    }
    const reverses = typeof row['reverses'] === 'string' ? row['reverses'] : null;
    return decisionOf(row, {
      resultingAccountState: recorded.resultingAccountState,
      accountEvent:
        recorded.accountEvent ?? (reverses === null ? null : (facts.get(reverses)?.accountEvent ?? null)),
    });
  });
}
