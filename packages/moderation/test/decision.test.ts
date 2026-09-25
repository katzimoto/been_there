import { describe, expect, it } from 'vitest';
import { type AccountState, type ActorId, InMemoryEventBus, capabilitiesFor, castId, isClearedToConsume } from '@been-there/core';
import {
  type AccountStateChangedPayload,
  type Decision,
  type DecisionCommand,
  type RestrictionAppliedPayload,
  applyDecision,
  closeReportsWithDecision,
  decide,
  isAppealable,
  assignCase,
  escalateCase,
  reverseDecision,
} from '../src/index.js';
import {
  CORRELATION,
  HUMAN_MODERATOR,
  LEAD,
  MODERATOR,
  SUBJECT,
  caseInReview,
  harness,
  makeReport,
  openCaseFromReport,
  rejected,
  triagedCaseFromReport,
  succeeded,
} from './support.js';

const RATIONALE = 'Repeated threats after two explicit requests to stop contacting me.';

function command(overrides: Partial<Parameters<typeof applyDecision>[0]> = {}) {
  return {
    decisionId: 'd-1',
    caseId: 'case-1' as never,
    moderatorId: HUMAN_MODERATOR,
    automated: false,
    subjectId: SUBJECT,
    action: 'suspend' as const,
    rationale: RATIONALE,
    currentAccountState: 'active' as AccountState,
    decidedAt: new Date('2026-01-05T09:00:00.000Z'),
    ...overrides,
  };
}

describe('applyDecision — the adapter over the shared account machine', () => {
  it('rejects a decision that names no case', () => {
    expect(rejected(applyDecision(command({ caseId: null }))).code).toBe('validation_failed');
    for (const action of ['warn', 'clear', 'restrict', 'suspend', 'ban'] as const) {
      expect(rejected(applyDecision(command({ caseId: null, action }))).code).toBe('validation_failed');
    }
  });

  it('rejects a suspend with no named moderator', () => {
    expect(rejected(applyDecision(command({ moderatorId: null }))).code).toBe('validation_failed');
    expect(rejected(applyDecision(command({ action: 'ban', moderatorId: null }))).code).toBe(
      'validation_failed',
    );
  });

  it('refuses a command whose caller states it is a machine', () => {
    // The runtime half of commitment 2, checked on the exported function that
    // produces the `Decision` an appeal is answered from — not only on the
    // orchestrator that happens to call it. A service holding a case id and
    // saying so gets nothing.
    for (const action of ['warn', 'restrict', 'suspend', 'ban', 'clear'] as const) {
      const error = rejected(applyDecision(command({ automated: true, action })));
      expect(error.code).toBe('permission_denied');
      expect(error.message).toContain('automation never enforces');
    }
    expect(succeeded(applyDecision(command({ automated: false }))).action).toBe('suspend');
  });

  it('refuses a command that does not state who is calling', () => {
    // A claim has to be made to be believed. An untyped caller — the seed
    // script, a future service — can omit the field, and a truthiness test
    // would read that omission as consent; `undefined` is refused here.
    const unstated = { ...command(), automated: undefined } as unknown as DecisionCommand;
    expect(rejected(applyDecision(unstated)).code).toBe('permission_denied');
  });

  it('is not callable with the actor id a service minted for itself', () => {
    // The compile-time half. `@ts-expect-error` fails the test build if the
    // error stops happening, so this is what pins the brand: widen
    // `DecisionCommand.moderatorId` back to `ActorId` and the reproduction from
    // the review compiles again without a single runtime change.
    const service: ActorId = castId<'ActorId'>('system');
    // @ts-expect-error an `ActorId` a service already holds is not a `HumanActorId`
    const reproduction: DecisionCommand = { ...command(), moderatorId: service };
    expect(reproduction.moderatorId).toBe('system');
  });

  it('rejects a decision with no rationale to defend', () => {
    expect(rejected(applyDecision(command({ rationale: 'because' }))).code).toBe('validation_failed');
  });

  it('rejects a restriction that does not name a removed capability', () => {
    expect(rejected(applyDecision(command({ action: 'restrict' }))).code).toBe('validation_failed');
    expect(
      succeeded(applyDecision(command({ action: 'restrict', removedCapabilities: ['send_message'] })))
        .resultingAccountState,
    ).toBe<AccountState>('limited');
  });

  it('rejects a restriction naming a capability the account does not have', () => {
    expect(
      rejected(
        applyDecision(command({ action: 'restrict', removedCapabilities: ['teleport'] })),
      ).code,
    ).toBe('validation_failed');
    expect(
      rejected(
        applyDecision(
          command({ action: 'restrict', currentAccountState: 'limited', removedCapabilities: ['send_message'] }),
        ),
      ).message,
    ).toContain('send_message');
  });

  it('leaves the account alone for a warning or a clearance', () => {
    const warn = succeeded(applyDecision(command({ action: 'warn' })));
    const clear = succeeded(applyDecision(command({ action: 'clear' })));

    expect(warn.accountEvent).toBeNull();
    expect(warn.resultingAccountState).toBe<AccountState>('active');
    expect(clear.accountEvent).toBeNull();
    expect(clear.resultingAccountState).toBe<AccountState>('active');
  });

  it('refuses a ban that the account machine refuses, rather than second-guessing it', () => {
    expect(rejected(applyDecision(command({ action: 'ban', currentAccountState: 'banned' }))).code).toBe(
      'invalid_transition',
    );
    expect(succeeded(applyDecision(command({ action: 'ban' }))).resultingAccountState).toBe<AccountState>('banned');
  });

  it('trims the rationale it stores', () => {
    expect(succeeded(applyDecision(command({ rationale: `   ${RATIONALE}   ` }))).rationale).toBe(RATIONALE);
  });

  it('refuses a restriction naming a capability that may never be removed', () => {
    // The reproduction from the review: `report` and `block` are in every
    // state's base list, so the "does this account hold it?" check passed and
    // the removal was recorded, published on a `public` event, and applied.
    for (const capability of ['report', 'block'] as const) {
      const error = rejected(
        applyDecision(
          command({ action: 'restrict', removedCapabilities: [capability, 'send_message'] }),
        ),
      );
      expect(error.code).toBe('validation_failed');
      expect(error.message).toContain(capability);
    }
  });

  it('refuses to remove delete_account from the state that grants it', () => {
    // `banned` is the only state that grants `delete_account`, and it is also
    // the state from which `restrict` is not a legal transition. So this case
    // passes the not-held check and would otherwise be refused as
    // `invalid_transition` by the machine. Getting `validation_failed` with the
    // unrestrictable message is what proves the floor is checked at intake and
    // not merely inherited from the machine.
    const error = rejected(
      applyDecision(
        command({
          action: 'restrict',
          currentAccountState: 'banned',
          removedCapabilities: ['delete_account'],
        }),
      ),
    );
    expect(error.code).toBe('validation_failed');
    expect(error.message).toContain('delete_account');
  });

  it('reports delete_account as unrestrictable, not as a capability the account lacks', () => {
    // `banned` is the only state that grants `delete_account`, so from every
    // other state the not-held check used to win and the moderator was told the
    // account did not hold a capability that may never be removed anyway — the
    // one message explaining the floor never fired for it. The order is part
    // of what a caller can act on, so it is pinned here.
    for (const currentAccountState of ['active', 'limited'] as const) {
      const error = rejected(
        applyDecision(
          command({
            action: 'restrict',
            currentAccountState,
            removedCapabilities: ['delete_account'],
          }),
        ),
      );
      expect(error.code, currentAccountState).toBe('validation_failed');
      expect(error.message, currentAccountState).toContain('may never remove');
    }
  });

  it('still accepts a restriction naming only restrictable capabilities', () => {
    const decision = succeeded(
      applyDecision(
        command({
          action: 'restrict',
          removedCapabilities: ['send_message', 'like', 'browse_discovery'],
        }),
      ),
    );
    expect(decision.removedCapabilities).toEqual(['send_message', 'like', 'browse_discovery']);
    expect(decision.resultingAccountState).toBe<AccountState>('limited');
  });

  it('refuses a restriction that mixes a restrictable name with an unrestrictable one', () => {
    // Silently dropping the offending name would record a decision the moderator
    // did not take, so the whole request is refused instead.
    const error = rejected(
      applyDecision(
        command({ action: 'restrict', removedCapabilities: ['send_message', 'report'] }),
      ),
    );
    expect(error.code).toBe('validation_failed');
    expect(error.message).toContain('report');
  });
});

describe('decide — a decision resolves its case and publishes the one outward event', () => {
  it('refuses to decide on a case nobody has started reviewing', () => {
    const h = harness();
    const opened = openCaseFromReport(h, succeeded(makeReport(h)));
    expect(
      rejected(
        decide(h.ctx, {
          moderationCase: opened,
          actor: MODERATOR,
          action: 'suspend',
          rationale: RATIONALE,
          currentAccountState: 'active',
          correlationId: CORRELATION,
        }),
      ).code,
    ).toBe('not_eligible');
  });

  it('keeps a plain reviewer off an escalated case even at decision time', () => {
    const h = harness();
    const assigned = succeeded(assignCase(h.ctx, { moderationCase: openCaseFromReport(h, succeeded(makeReport(h))), actor: MODERATOR, correlationId: CORRELATION }));
    const escalated = succeeded(
      escalateCase(h.ctx, {
        moderationCase: assigned,
        actor: MODERATOR,
        reason: 'Child-safety indicators: needs a lead before anyone reads further.',
        correlationId: CORRELATION,
      }),
    );
    expect(
      rejected(
        decide(h.ctx, {
          moderationCase: escalated,
          actor: MODERATOR,
          action: 'suspend',
          rationale: RATIONALE,
          currentAccountState: 'active',
          correlationId: CORRELATION,
        }),
      ).code,
    ).toBe('permission_denied');
  });

  it('records the decision, resolves the case and emits exactly one public event', () => {
    const h = harness();
    const reviewed = caseInReview(h, openCaseFromReport(h, succeeded(makeReport(h))));
    const outcome = succeeded(
      decide(h.ctx, {
        moderationCase: reviewed,
        actor: MODERATOR,
        action: 'restrict',
        rationale: RATIONALE,
        currentAccountState: 'active',
        removedCapabilities: ['send_message'],
        correlationId: CORRELATION,
      }),
    );

    expect(outcome.moderationCase.state).toBe('resolved');
    expect(outcome.moderationCase.resolutionDecisionId).toBe(outcome.decision.decisionId);
    expect(outcome.decision.moderatorId).toBe(MODERATOR.actorId);
    expect(outcome.decision.caseId).toBe(outcome.moderationCase.caseId);
    expect(outcome.accountState).toBe<AccountState>('limited');

    const publicEvents = outcome.events.filter((event) => event.sensitivity === 'public');
    expect(publicEvents).toHaveLength(1);
    const payload = publicEvents[0]?.payload as AccountStateChangedPayload;
    expect(Object.keys(payload).sort()).toEqual([
      'accountState',
      'capabilities',
      'removedCapabilities',
    ]);
    expect(payload.accountState).toBe('limited');
    expect(payload.capabilities).not.toContain('send_message');
    expect(payload.capabilities).toContain('report');
  });

  it('publishes nothing public when no standing changed', () => {
    const h = harness();
    const reviewed = caseInReview(h, openCaseFromReport(h, succeeded(makeReport(h))));
    const outcome = succeeded(
      decide(h.ctx, {
        moderationCase: reviewed,
        actor: MODERATOR,
        action: 'clear',
        rationale: 'Context shows a joke between two people who knew each other.',
        currentAccountState: 'active',
        correlationId: CORRELATION,
      }),
    );

    expect(outcome.accountState).toBe<AccountState>('active');
    expect(outcome.events.filter((event) => event.sensitivity === 'public')).toHaveLength(0);
  });

  it('keeps a public-clearance consumer blind to everything but the standing', async () => {
    const h = harness();
    const bus = new InMemoryEventBus();
    const seen: string[] = [];
    bus.subscribe({ upTo: 'public' }, (event) => {
      seen.push(event.type);
    });
    const reviewed = caseInReview(h, openCaseFromReport(h, succeeded(makeReport(h))));
    const outcome = succeeded(
      decide(h.ctx, {
        moderationCase: reviewed,
        actor: MODERATOR,
        action: 'ban',
        rationale: RATIONALE,
        currentAccountState: 'active',
        correlationId: CORRELATION,
      }),
    );

    for (const event of outcome.events) {
      await bus.publish(event);
    }

    // Every moderation event is restricted and is never delivered; the product
    // sees the standing change and nothing about how it happened.
    expect(seen).toEqual(['account_state.changed']);
    const outward = outcome.events.find((event) => event.type === 'account_state.changed');
    // A `user`-clearance event is not delivered either: the case reference is
    // addressed to the restricted account, not to everyone holding the bus.
    expect(Object.keys(outward?.payload as object)).toEqual([
      'accountState',
      'capabilities',
      'removedCapabilities',
    ]);
  });

  it('publishes a restricted account that can still report and block', () => {
    // The spec claim, checked on the surface that actually leaked: the
    // `public` payload every product domain consumes. Pre-fix this named
    // send_message only, so the consumer's grant disagreed with platform's.
    const h = harness();
    const reviewed = caseInReview(h, openCaseFromReport(h, succeeded(makeReport(h))));
    const outcome = succeeded(
      decide(h.ctx, {
        moderationCase: reviewed,
        actor: MODERATOR,
        action: 'restrict',
        rationale: RATIONALE,
        currentAccountState: 'active',
        removedCapabilities: ['send_message', 'like', 'browse_discovery'],
        correlationId: CORRELATION,
      }),
    );

    const publicEvent = outcome.events.find((event) => event.sensitivity === 'public');
    const payload = publicEvent?.payload as AccountStateChangedPayload;
    expect(payload.capabilities).toContain('report');
    expect(payload.capabilities).toContain('block');
    expect(payload.capabilities).not.toContain('send_message');
  });

  it('refuses to publish a standing change that would strip report or block', () => {
    // End to end through `decide`, the only path that publishes. A moderator
    // typing `report` gets a refusal and no `public` event is emitted at all,
    // so no consumer can ever read a stripped grant.
    const h = harness();
    const reviewed = caseInReview(h, openCaseFromReport(h, succeeded(makeReport(h))));
    for (const capability of ['report', 'block'] as const) {
      const error = rejected(
        decide(h.ctx, {
          moderationCase: reviewed,
          actor: MODERATOR,
          action: 'restrict',
          rationale: RATIONALE,
          currentAccountState: 'active',
          removedCapabilities: [capability],
          correlationId: CORRELATION,
        }),
      );
      expect(error.code).toBe('validation_failed');
      expect(error.message).toContain(capability);
    }
  });

  it('keeps a banned account able to delete itself on the published payload', () => {
    // `delete_account` is the recommended action on the banned screen, so a
    // published grant without it strands the account with no way out.
    const h = harness();
    const reviewed = caseInReview(h, openCaseFromReport(h, succeeded(makeReport(h))));
    const outcome = succeeded(
      decide(h.ctx, {
        moderationCase: reviewed,
        actor: MODERATOR,
        action: 'ban',
        rationale: RATIONALE,
        currentAccountState: 'active',
        correlationId: CORRELATION,
      }),
    );

    const publicEvent = outcome.events.find((event) => event.sensitivity === 'public');
    const payload = publicEvent?.payload as AccountStateChangedPayload;
    expect(payload.capabilities).toContain('delete_account');
    expect(payload.capabilities).toContain('report');
  });

  it('closes the report with the same decision that resolved the case', () => {
    const h = harness();
    const { report, moderationCase } = triagedCaseFromReport(h);
    const reviewed = caseInReview(h, moderationCase);
    const outcome = succeeded(
      decide(h.ctx, {
        moderationCase: reviewed,
        actor: MODERATOR,
        action: 'suspend',
        rationale: RATIONALE,
        currentAccountState: 'active',
        correlationId: CORRELATION,
      }),
    );

    const closed = succeeded(closeReportsWithDecision(h.ctx, [report], outcome.decision, CORRELATION));
    expect(closed.reports[0]?.state).toBe('actioned');
    const row = h.audit.byEntity('report', report.reportId).at(-1);
    expect(row?.decisionId).toBe(outcome.decision.decisionId);
  });

  it('dismisses the report when the decision is a clearance', () => {
    const h = harness();
    const { report, moderationCase } = triagedCaseFromReport(h);
    const reviewed = caseInReview(h, moderationCase);
    const outcome = succeeded(
      decide(h.ctx, {
        moderationCase: reviewed,
        actor: MODERATOR,
        action: 'clear',
        rationale: 'The two accounts know each other; the context is playful.',
        currentAccountState: 'active',
        correlationId: CORRELATION,
      }),
    );

    const closed = succeeded(closeReportsWithDecision(h.ctx, [report], outcome.decision, CORRELATION));
    expect(closed.reports[0]?.state).toBe('dismissed');
  });
});

describe('appeal support', () => {
  function bannedCase(h: ReturnType<typeof harness>) {
    const reviewed = caseInReview(h, openCaseFromReport(h, succeeded(makeReport(h, { reason: 'threats_or_violence' }))));
    return succeeded(
      decide(h.ctx, {
        moderationCase: reviewed,
        actor: MODERATOR,
        action: 'ban',
        rationale: RATIONALE,
        currentAccountState: 'active',
        correlationId: CORRELATION,
      }),
    );
  }

  it('offers a sanction that is still in force for appeal, and not a clearance', () => {
    const h = harness();
    const outcome = bannedCase(h);

    expect(isAppealable(outcome.decision, [outcome.decision])).toBe(true);
  });

  it('records a reversal as a new decision, leaving the original intact', () => {
    const h = harness();
    const outcome = bannedCase(h);
    const original: Decision = outcome.decision;

    const reversal = succeeded(
      reverseDecision(h.ctx, {
        moderationCase: outcome.moderationCase,
        actor: LEAD,
        reverses: original,
        rationale: 'The messages were taken out of context; the account is restored.',
        currentAccountState: 'banned',
        correlationId: CORRELATION,
      }),
    );

    expect(reversal.decision.reverses).toBe(original.decisionId);
    expect(reversal.decision.action).toBe('clear');
    expect(reversal.accountState).toBe<AccountState>('active');
    expect(original.action).toBe('ban');
    expect(original.resultingAccountState).toBe<AccountState>('banned');
    expect(isAppealable(original, [original, reversal.decision])).toBe(false);
    expect(h.audit.byEntity('decision', original.decisionId)).toHaveLength(1);
    expect(h.audit.byEntity('decision', reversal.decision.decisionId)[0]?.action).toBe('decision.reversed');
  });

  it('refuses to reverse something that is not a sanction', () => {
    const h = harness();
    const reviewed = caseInReview(h, openCaseFromReport(h, succeeded(makeReport(h))));
    const cleared = succeeded(
      decide(h.ctx, {
        moderationCase: reviewed,
        actor: MODERATOR,
        action: 'warn',
        rationale: RATIONALE,
        currentAccountState: 'active',
        correlationId: CORRELATION,
      }),
    );

    expect(
      rejected(
        reverseDecision(h.ctx, {
          moderationCase: cleared.moderationCase,
          actor: LEAD,
          reverses: cleared.decision,
          rationale: 'Asking for the warning to be lifted as well.',
          currentAccountState: 'active',
          correlationId: CORRELATION,
        }),
      ).message,
    ).toContain('nothing to reverse');
  });

  it('refuses to reverse a ban that is not in force', () => {
    const h = harness();
    const outcome = bannedCase(h);
    expect(
      rejected(
        reverseDecision(h.ctx, {
          moderationCase: outcome.moderationCase,
          actor: LEAD,
          reverses: outcome.decision,
          rationale: 'Attempting to lift a ban the account does not have.',
          currentAccountState: 'active',
          correlationId: CORRELATION,
        }),
      ).code,
    ).toBe('invalid_transition');
  });
});

describe('what the restricted account is told', () => {
  function restrict(h: ReturnType<typeof harness>) {
    const reviewed = caseInReview(h, openCaseFromReport(h, succeeded(makeReport(h))));
    return succeeded(
      decide(h.ctx, {
        moderationCase: reviewed,
        actor: MODERATOR,
        action: 'restrict',
        rationale: RATIONALE,
        currentAccountState: 'active',
        removedCapabilities: ['send_message', 'like'],
        correlationId: CORRELATION,
      }),
    );
  }

  it('names the case and the removed set on an event only the subject can read', () => {
    // The notification spec requires the restricted user to be told each removed
    // capability and the case reference. Neither was on any event before, so the
    // only way to build that message was to diff the capability set against a
    // local copy of the base table.
    const h = harness();
    const outcome = restrict(h);
    const toSubject = outcome.events.find(
      (event) => event.type === 'moderation.restriction_applied',
    );

    expect(toSubject?.sensitivity).toBe('user');
    expect(toSubject?.subjectId).toBe(SUBJECT);
    const payload = toSubject?.payload as RestrictionAppliedPayload;
    expect(payload.caseId).toBe(outcome.moderationCase.caseId);
    expect(payload.decisionId).toBe(outcome.decision.decisionId);
    expect(payload.removedCapabilities).toEqual(['send_message', 'like']);
    expect(payload.accountState).toBe<AccountState>('limited');
  });

  it('delivers the case reference to the subject and to nobody else', async () => {
    const h = harness();
    const outcome = restrict(h);
    const bus = new InMemoryEventBus();
    const asPublic: string[] = [];
    const asUser: string[] = [];
    bus.subscribe({ upTo: 'public' }, (event) => {
      asPublic.push(event.type);
    });
    bus.subscribe({ upTo: 'user' }, (event) => {
      asUser.push(event.type);
    });
    for (const event of outcome.events) {
      await bus.publish(event);
    }

    expect(asPublic).toEqual(['account_state.changed']);
    expect(asUser).toEqual([
      'account_state.changed',
      'moderation.restriction_applied',
    ]);
  });

  it('keeps the case id off the event a public clearance reads', () => {
    // The whole reason this is a second event: a case reference on a `public`
    // payload would publish the existence of an open case about an identifiable
    // person to anyone holding the bus.
    const h = harness();
    const outcome = restrict(h);
    const outward = outcome.events.find((event) => event.type === 'account_state.changed');

    expect(JSON.stringify(outward?.payload)).not.toContain('case');
    expect(JSON.stringify(outward?.payload)).not.toContain(outcome.moderationCase.caseId);
  });

  it('publishes the removed set on the outward payload so no client needs the base table', () => {
    const h = harness();
    const outcome = restrict(h);
    const outward = outcome.events.find((event) => event.type === 'account_state.changed');
    const payload = outward?.payload as AccountStateChangedPayload;

    expect(payload.removedCapabilities).toEqual(['send_message', 'like']);
    // And the projection the spec names is now derivable from one payload.
    const base = capabilitiesFor('active');
    expect(payload.capabilities).toEqual(
      base.filter((capability) => !payload.removedCapabilities.includes(capability)),
    );
  });

  it('tells the subject which capabilities a reversal gave back', () => {
    const h = harness();
    const outcome = restrict(h);
    const reversal = succeeded(
      reverseDecision(h.ctx, {
        moderationCase: outcome.moderationCase,
        actor: LEAD,
        reverses: outcome.decision,
        rationale: 'Both messages were sent in a context the reporter did not describe.',
        currentAccountState: 'limited',
        correlationId: CORRELATION,
      }),
    );
    const lifted = reversal.events.find((event) => event.type === 'moderation.restriction_lifted');
    const outward = reversal.events.find((event) => event.type === 'account_state.changed');

    expect(lifted?.sensitivity).toBe('user');
    const payload = lifted?.payload as RestrictionAppliedPayload;
    expect(payload.removedCapabilities).toEqual(['send_message', 'like']);
    expect(payload.caseId).toBe(outcome.moderationCase.caseId);
    // A lift takes nothing away, so the public removed set is empty and the
    // effective set is the base set.
    expect((outward?.payload as AccountStateChangedPayload).removedCapabilities).toEqual([]);
    expect((outward?.payload as AccountStateChangedPayload).capabilities).toEqual(
      capabilitiesFor('active'),
    );
  });

  it('publishes no case-facing event at all when no sanction was taken', () => {
    const h = harness();
    const reviewed = caseInReview(h, openCaseFromReport(h, succeeded(makeReport(h))));
    const cleared = succeeded(
      decide(h.ctx, {
        moderationCase: reviewed,
        actor: MODERATOR,
        action: 'clear',
        rationale: 'Context shows a joke between two people who knew each other.',
        currentAccountState: 'active',
        correlationId: CORRELATION,
      }),
    );

    expect(cleared.events.map((event) => event.type)).not.toContain(
      'moderation.restriction_applied',
    );
  });
});
