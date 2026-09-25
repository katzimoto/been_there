import { describe, expect, it } from 'vitest';
import {
  type ActorId,
  type DomainError,
  type IdentityState,
  type Result,
  type RiskAssessmentId,
  type SubjectId,
  type VerificationId,
  castId,
} from '@been-there/core';
import {
  REVERIFICATION_AUTHORITIES,
  REVERIFICATION_POLICY,
  type ReverificationHistoryEntry,
  type ReverificationReason,
  type ReverificationRefusal,
  type ReverificationRefusalLog,
  type ReverificationRequester,
  detectReverificationAbuse,
  proposeReview,
  requestReVerification,
} from '../src/index.js';
import { SUBJECT, T0, daysLater, hoursLater } from './support.js';

function succeeded<T, E extends { code: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.error.code}`);
  }
  return result.value;
}

function errorOf<T, E extends DomainError>(result: Result<T, E>): DomainError {
  if (result.ok) {
    throw new Error('expected a rejection');
  }
  return result.error;
}

const MOD = castId<'ActorId'>('mod-1');
const RISK = castId<'RiskAssessmentId'>('risk-1');

const requesters: Readonly<Record<string, ReverificationRequester>> = {
  // The same account as `SUBJECT`, under the actor id brand: a subject demands
  // a re-verification of themselves.
  subject: { kind: 'subject', actorId: castId<'ActorId'>('user-1') },
  trust_safety: { kind: 'trust_safety', actorId: MOD, riskAssessmentId: RISK },
  moderation: { kind: 'moderation', actorId: MOD, caseId: 'case-1' },
  dating_core: { kind: 'dating_core', actorId: castId<'ActorId'>('svc-dating') },
};

/** A user with their own account, reaching into someone else's. */
const ATTACKER = castId<'ActorId'>('user-2');

const ATTACKER_DEMAND: ReverificationRequester = { kind: 'subject', actorId: ATTACKER };

const reasons: readonly ReverificationReason[] = [
  'identity_expired',
  'user_requested',
  'risk_signal',
  'case_linked',
  'anomaly_findings',
];

function historyEntry(
  overrides: Partial<ReverificationHistoryEntry> = {},
): ReverificationHistoryEntry {
  return {
    verificationId: castId<'VerificationId'>('vrf-old'),
    requestedAt: daysLater(-1),
    reVerification: true,
    attemptState: 'passed',
    ...overrides,
  };
}

function collectingLog(): ReverificationRefusalLog & {
  readonly refusals: ReverificationRefusal[];
} {
  const refusals: ReverificationRefusal[] = [];
  return {
    refusals,
    append: (refusal: ReverificationRefusal): void => {
      refusals.push(refusal);
    },
  };
}

function ask(
  reason: ReverificationReason,
  requester: ReverificationRequester['kind'],
  identityState: IdentityState,
  history: readonly ReverificationHistoryEntry[] = [],
  refusals: ReverificationRefusalLog = collectingLog(),
) {
  return requestReVerification(
    { subjectId: SUBJECT, reason, requester: requesters[requester]!, now: T0 },
    { identityState, history },
    refusals,
  );
}

function askAs(
  requester: ReverificationRequester,
  reason: ReverificationReason,
  identityState: IdentityState,
  history: readonly ReverificationHistoryEntry[] = [],
  refusals: ReverificationRefusalLog = collectingLog(),
) {
  return requestReVerification(
    { subjectId: SUBJECT, reason, requester, now: T0 },
    { identityState, history },
    refusals,
  );
}

describe('who may demand a re-verification', () => {
  it('refuses the dating core for every reason, always first', () => {
    for (const reason of reasons) {
      const error = errorOf(ask(reason, 'dating_core', 'verified'));
      expect(error.code).toBe('permission_denied');
      expect(error.details?.requester).toBe('dating_core');
    }
  });

  it("does not leak a subject's state to an unauthorised caller", () => {
    // Authority is checked before the open-attempt check and the rate limit, so
    // a rejected caller learns nothing about what is on file.
    const error = errorOf(
      ask('risk_signal', 'dating_core', 'verified', [
        historyEntry({ attemptState: 'awaiting_provider' }),
      ]),
    );
    expect(error.code).toBe('permission_denied');
    expect(error.message).not.toMatch(/in flight|cooldown|limit/);
  });

  it('refuses a reason the requester has no authority for', () => {
    // A trust & safety signal must arrive from trust & safety. A subject may
    // not reframe their own request as a risk signal to skip the rules.
    expect(errorOf(ask('risk_signal', 'subject', 'expired')).code).toBe('permission_denied');
    expect(errorOf(ask('case_linked', 'trust_safety', 'expired')).code).toBe('permission_denied');
    expect(errorOf(ask('user_requested', 'moderation', 'expired')).code).toBe('permission_denied');
  });

  it('lets trust & safety re-verify a verified subject', () => {
    const plan = succeeded(ask('risk_signal', 'trust_safety', 'verified'));
    expect(plan.requestedBy).toBe('trust_safety');
    expect(plan.reVerification).toBe(true);
    expect(plan.viaEvent).toBe('reverify_requested');
    expect(plan.nextIdentityState).toBe('pending');
  });

  it('refuses a verified subject a self-service re-verification', () => {
    expect(errorOf(ask('user_requested', 'subject', 'verified')).code).toBe('not_eligible');
  });

  it('lets a subject refresh an expired verification', () => {
    expect(succeeded(ask('identity_expired', 'subject', 'expired')).nextIdentityState).toBe(
      'pending',
    );
  });
});

describe('anti-abuse limits on re-verification', () => {
  it('refuses to stack a second attempt on a live one', () => {
    const error = errorOf(
      ask('risk_signal', 'trust_safety', 'verified', [
        historyEntry({ attemptState: 'awaiting_provider' }),
      ]),
    );
    expect(error.code).toBe('conflict');
  });

  it('counts a manual review as an attempt already in flight', () => {
    expect(
      errorOf(
        ask('risk_signal', 'trust_safety', 'verified', [
          historyEntry({ attemptState: 'manual_review' }),
        ]),
      ).code,
    ).toBe('conflict');
  });

  it('holds a subject to a minimum gap between re-verifications', () => {
    const history = [historyEntry({ requestedAt: hoursLater(-2) })];
    const error = errorOf(ask('risk_signal', 'trust_safety', 'verified', history));
    expect(error.code).toBe('rate_limited');
    expect(error.details?.cooldownHours).toBe(REVERIFICATION_POLICY.cooldownHours);
  });

  it('allows a re-verification once the gap has passed', () => {
    const history = [
      historyEntry({ requestedAt: hoursLater(-(REVERIFICATION_POLICY.cooldownHours + 1)) }),
    ];
    expect(
      succeeded(ask('risk_signal', 'trust_safety', 'verified', history)).nextIdentityState,
    ).toBe('pending');
  });

  it('stops a caller from hiding someone from the product indefinitely', () => {
    const history = Array.from(
      { length: REVERIFICATION_POLICY.maxPerSubjectPer30Days },
      (_, index) =>
        historyEntry({
          verificationId: castId<'VerificationId'>(`vrf-${index}`),
          requestedAt: daysLater(-(index * 9) - 1),
        }),
    );
    const error = errorOf(ask('case_linked', 'moderation', 'verified', history));
    expect(error.code).toBe('rate_limited');
    expect(error.details?.limit).toBe(REVERIFICATION_POLICY.maxPerSubjectPer30Days);
  });

  it('does not count first verifications against the re-verification limit', () => {
    const history = Array.from({ length: 10 }, (_, index) =>
      historyEntry({
        verificationId: castId<'VerificationId'>(`vrf-first-${index}`),
        reVerification: false,
        requestedAt: daysLater(-1),
      }),
    );
    expect(
      succeeded(ask('risk_signal', 'trust_safety', 'verified', history)).nextIdentityState,
    ).toBe('pending');
  });

  it('ignores re-verifications older than the window', () => {
    const history = Array.from(
      { length: REVERIFICATION_POLICY.maxPerSubjectPer30Days },
      (_, index) =>
        historyEntry({
          verificationId: castId<'VerificationId'>(`vrf-old-${index}`),
          requestedAt: daysLater(-31 - index),
        }),
    );
    expect(
      succeeded(ask('risk_signal', 'trust_safety', 'verified', history)).nextIdentityState,
    ).toBe('pending');
  });
});

describe('what a re-verification plan may contain', () => {
  it('carries an identity move and nothing that could touch account standing', () => {
    const plan = succeeded(ask('anomaly_findings', 'moderation', 'verified'));
    expect(Object.keys(plan).sort()).toEqual([
      'nextIdentityState',
      'reVerification',
      'reason',
      'requestedBy',
      'subjectId',
      'viaEvent',
    ]);
    expect(JSON.stringify(plan)).not.toMatch(/suspend|ban|restrict|case_state|account_state/);
  });

  it('declares its authority table for every reason', () => {
    for (const reason of reasons) {
      expect(REVERIFICATION_AUTHORITIES[reason].length).toBeGreaterThan(0);
      expect(REVERIFICATION_AUTHORITIES[reason]).not.toContain('dating_core');
    }
  });
});

describe("a user cannot demand another user's re-verification", () => {
  it('refuses a demand for someone else, for every reason', () => {
    for (const reason of reasons) {
      const error = errorOf(askAs(ATTACKER_DEMAND, reason, 'expired'));
      expect(error.code, `reason ${reason}`).toBe('permission_denied');
    }
  });

  it('still lets a subject re-verify themselves', () => {
    // The two reasons the table grants a subject, from a state they may act in.
    expect(succeeded(askAs(requesters.subject!, 'user_requested', 'expired')).requestedBy).toBe(
      'subject',
    );
    expect(succeeded(askAs(requesters.subject!, 'identity_expired', 'expired')).viaEvent).toBe(
      'reverify_requested',
    );
  });

  it('cannot tell an attacker anything about the account it reached for', () => {
    // Authority is the first check, so the refusal is byte-identical whatever
    // is on file. Without that, the open-attempt / cap / cooldown refusals
    // would tell a stranger whether their target is mid-verification and how
    // many times they have already been pulled out of discovery.
    const atCap = Array.from({ length: REVERIFICATION_POLICY.maxPerSubjectPer30Days }, (_, index) =>
      historyEntry({
        verificationId: castId<'VerificationId'>(`vrf-cap-${index}`),
        requestedAt: daysLater(-(index * 9) - 1),
      }),
    );
    const contexts: Readonly<
      Record<string, [IdentityState, readonly ReverificationHistoryEntry[]]>
    > = {
      verified: ['verified', []],
      expired: ['expired', []],
      review_required: ['review_required', []],
      verification_failed: ['verification_failed', []],
      attempt_in_flight: ['expired', [historyEntry({ attemptState: 'awaiting_provider' })]],
      cap_reached: ['expired', atCap],
      cooling_down: ['expired', [historyEntry({ requestedAt: hoursLater(-2) })]],
    };

    const seen = new Set<string>();
    for (const [state, history] of Object.values(contexts)) {
      const error = errorOf(askAs(ATTACKER_DEMAND, 'user_requested', state, history));
      expect(error.code).toBe('permission_denied');
      seen.add(
        JSON.stringify({ code: error.code, message: error.message, details: error.details }),
      );
    }
    expect([...seen]).toHaveLength(1);
    // And it says nothing at all about the account it was aimed at.
    const error = errorOf(askAs(ATTACKER_DEMAND, 'user_requested', 'expired', atCap));
    expect(JSON.stringify(error)).not.toContain(SUBJECT);
    expect(error.message).not.toMatch(/in flight|cooldown|limit|verified|pending/i);
  });

  it('records the attempt against the account that made it', () => {
    const log = collectingLog();
    expect(askAs(ATTACKER_DEMAND, 'user_requested', 'expired', [], log).ok).toBe(false);

    expect(log.refusals).toEqual([
      {
        at: T0,
        actorId: ATTACKER,
        intendedSubjectId: SUBJECT,
        requesterKind: 'subject',
        reason: 'user_requested',
        code: 'permission_denied',
      },
    ]);
  });

  it('records a dating-core demand too, so the refusal is not silent', () => {
    const log = collectingLog();
    expect(ask('case_linked', 'dating_core', 'verified', [], log).ok).toBe(false);
    expect(log.refusals).toEqual([
      {
        at: T0,
        actorId: castId<'ActorId'>('svc-dating'),
        intendedSubjectId: SUBJECT,
        requesterKind: 'dating_core',
        reason: 'case_linked',
        code: 'permission_denied',
      },
    ]);
  });

  it('writes nothing when the demand is legitimate', () => {
    const log = collectingLog();
    expect(askAs(requesters.subject!, 'identity_expired', 'expired', [], log).ok).toBe(true);
    expect(log.refusals).toEqual([]);
  });

  it('surfaces a repeat offender to a human, and only the offender', () => {
    const log = collectingLog();
    for (let day = 0; day < 4; day += 1) {
      // Four demands across a month: the 3-per-30-days cap would not have
      // stopped them, which is the whole point of refusing them at all.
      requestReVerification(
        {
          subjectId: SUBJECT,
          reason: 'user_requested',
          requester: ATTACKER_DEMAND,
          now: daysLater(-day * 7),
        },
        { identityState: 'expired', history: [] },
        log,
      );
    }
    const findings = detectReverificationAbuse(log.refusals, T0);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: 'cross_subject_reverification_demand',
      severity: 'review',
      subjectId: castId<'SubjectId'>('user-2'),
      observations: { demands: 4, windowDays: 30, distinctTargets: 1 },
    });
    // A repeat offender is a review, never an automatic consequence.
    expect(proposeReview(findings)?.identityEvent).toBe('flag_for_review');
  });

  it('raises no finding for a subject re-verifying themselves', () => {
    const log = collectingLog();
    askAs(requesters.subject!, 'user_requested', 'expired', [], log);
    expect(detectReverificationAbuse(log.refusals, T0)).toEqual([]);
  });
});

describe('a subject is still limited when re-verifying themselves', () => {
  it('holds a self-service demand to the cooldown', () => {
    const error = errorOf(
      askAs(requesters.subject!, 'user_requested', 'expired', [
        historyEntry({ requestedAt: hoursLater(-2) }),
      ]),
    );
    expect(error.code).toBe('rate_limited');
  });

  it('holds a self-service demand to the 30-day cap', () => {
    const history = Array.from(
      { length: REVERIFICATION_POLICY.maxPerSubjectPer30Days },
      (_, index) =>
        historyEntry({
          verificationId: castId<'VerificationId'>(`vrf-self-${index}`),
          requestedAt: daysLater(-(index * 9) - 1),
        }),
    );
    expect(errorOf(askAs(requesters.subject!, 'user_requested', 'expired', history)).code).toBe(
      'rate_limited',
    );
  });
});
