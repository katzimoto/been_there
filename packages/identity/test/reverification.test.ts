import { describe, expect, it } from 'vitest';
import {
  type ActorId,
  type DomainError,
  type IdentityState,
  type Result,
  type RiskAssessmentId,
  type VerificationId,
  castId,
} from '@been-there/core';
import {
  REVERIFICATION_AUTHORITIES,
  REVERIFICATION_POLICY,
  type ReverificationHistoryEntry,
  type ReverificationReason,
  type ReverificationRequester,
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
  subject: { kind: 'subject', actorId: MOD },
  trust_safety: { kind: 'trust_safety', actorId: MOD, riskAssessmentId: RISK },
  moderation: { kind: 'moderation', actorId: MOD, caseId: 'case-1' },
  dating_core: { kind: 'dating_core', actorId: castId<'ActorId'>('svc-dating') },
};

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

function ask(
  reason: ReverificationReason,
  requester: ReverificationRequester['kind'],
  identityState: IdentityState,
  history: readonly ReverificationHistoryEntry[] = [],
) {
  return requestReVerification(
    { subjectId: SUBJECT, reason, requester: requesters[requester]!, now: T0 },
    { identityState, history },
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
          requestedAt: daysLater(-40 + index * 12),
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
      'reason',
      'reVerification',
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
