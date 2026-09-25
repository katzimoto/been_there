import {
  type CorrelationId,
  type DomainError,
  type Result,
  type RiskAssessment,
  type RiskAssessmentId,
  type SubjectId,
} from '@been-there/core';
import { type SignalLedger, appendSignal, corroborate } from './correlation.js';
import { type RiskDispute, handleDispute, isOpenDispute } from './dispute.js';
import { type TrustSafetyEvent, frictionProposed, reviewCandidateRaised, riskChanged } from './events.js';
import {
  FRICTION_KINDS,
  REVERSIBLE_FRICTION,
  type FrictionKind,
  type ReversibleFriction,
  expireFriction,
} from './friction.js';
import type { IdFactory } from './ids.js';
import { RISK_RANK, assessDecay, assessHumanReassessment, assessSignal } from './policy.js';
import type { ReviewCandidate } from './review.js';
import type { Signal } from './signal.js';

/**
 * Everything Trust & Safety knows about one subject.
 *
 * `assessment` is the shared kernel's `RiskAssessment` verbatim, so the risk
 * projection this domain publishes is the shape the kernel documents. The rest
 * is local bookkeeping: what is currently proposed, what is queued for a human,
 * and what the user has contested.
 */
export interface RiskRecord {
  readonly assessment: RiskAssessment;
  readonly friction: readonly ReversibleFriction[];
  readonly candidate: ReviewCandidate | null;
  readonly disputes: readonly RiskDispute[];
  readonly updatedAt: Date;
}

/** Clock, causation and id minting, passed in so the domain stays pure. */
export interface AssessmentContext {
  readonly now: Date;
  readonly correlationId: CorrelationId;
  readonly ids: IdFactory;
}

export interface RiskTransition {
  readonly record: RiskRecord;
  /** Present only when this transition appended evidence to the ledger. */
  readonly ledger?: SignalLedger;
  readonly events: readonly TrustSafetyEvent[];
  /** The queue entry this transition opened, if any. */
  readonly raised: ReviewCandidate | null;
}

export function emptyRiskRecord(
  subjectId: SubjectId,
  assessmentId: RiskAssessmentId,
  now: Date,
): RiskRecord {
  return {
    assessment: {
      subjectId,
      state: 'normal',
      assessmentId,
      lastSignalAt: null,
      contributingDetectors: [],
    },
    friction: [],
    candidate: null,
    disputes: [],
    updatedAt: now,
  };
}

/** Event id minting, shared by every publisher below so ids stay in lockstep. */
function envelope(context: AssessmentContext) {
  return {
    eventId: context.ids.nextEventId(),
    occurredAt: context.now,
    correlationId: context.correlationId,
  };
}

/** One entry per kind, newest wins, always in catalogue order. */
function mergeFriction(
  current: readonly ReversibleFriction[],
  incoming: readonly ReversibleFriction[],
): readonly ReversibleFriction[] {
  const byKind = new Map<FrictionKind, ReversibleFriction>();
  for (const entry of current) {
    byKind.set(entry.kind, entry);
  }
  for (const entry of incoming) {
    byKind.set(entry.kind, entry);
  }
  return FRICTION_KINDS.flatMap((kind) => {
    const entry = byKind.get(kind);
    return entry === undefined ? [] : [entry];
  });
}

function laterOf(current: Date | null, incoming: Date): Date {
  return current === null || incoming.getTime() > current.getTime() ? incoming : current;
}

/**
 * The assessment layer: one signal in, one risk record out.
 *
 * Nothing here decides an account's fate. The record it returns can only ever
 * hold `internal` risk state, expiring friction, and a queue entry — the three
 * things the architecture allows this domain to know.
 */
export function applySignal(
  record: RiskRecord,
  signal: Signal,
  ledger: SignalLedger,
  context: AssessmentContext,
): Result<RiskTransition, DomainError> {
  const corroboration = corroborate(ledger, signal);
  const decision = assessSignal(
    {
      current: record.assessment.state,
      signal,
      corroboration,
      disputeOpen: record.disputes.some(isOpenDispute),
    },
    context.now,
  );

  const events: TrustSafetyEvent[] = [];
  if (decision.changed) {
    events.push(
      riskChanged(envelope(context), {
        subjectId: record.assessment.subjectId,
        assessmentId: record.assessment.assessmentId,
        from: record.assessment.state,
        to: decision.next,
        reason: 'signal',
        detectors: corroboration.detectors,
        effectiveScore: decision.effectiveScore,
      }),
    );
  }
  for (const entry of decision.friction) {
    events.push(frictionProposed(envelope(context), entry));
  }
  if (decision.candidate !== null) {
    events.push(reviewCandidateRaised(envelope(context), decision.candidate));
  }

  // A quarantined signal leaves no trace on the record: no state, no detector,
  // no clock. It stays in the ledger precisely because that is how the campaign
  // stays visible to a human, and precisely not as evidence against the target.
  const detectors = decision.quarantined
    ? record.assessment.contributingDetectors
    : [...new Set([...record.assessment.contributingDetectors, signal.detector])].sort();

  const isAccountCandidate = decision.candidate !== null && decision.candidate.target.kind === 'account';

  return {
    ok: true,
    value: {
      record: {
        assessment: {
          ...record.assessment,
          state: decision.next,
          contributingDetectors: detectors,
          lastSignalAt: decision.quarantined
            ? record.assessment.lastSignalAt
            : laterOf(record.assessment.lastSignalAt, signal.occurredAt),
        },
        friction: mergeFriction(expireFriction(record.friction, context.now), decision.friction),
        candidate: isAccountCandidate ? decision.candidate : record.candidate,
        disputes: record.disputes,
        updatedAt: context.now,
      },
      ledger: appendSignal(ledger, signal),
      events,
      raised: decision.candidate,
    },
  };
}

/**
 * The quiet clock. Decay releases what the raised state justified: friction and
 * the queue entry both fall away as the state falls, so a user who misbehaved
 * once is not still paying for it a month later.
 */
export function applyDecay(
  record: RiskRecord,
  context: AssessmentContext,
): Result<RiskTransition, DomainError> {
  const moved = assessDecay(record.assessment.state, record.assessment.lastSignalAt, context.now);
  if (!moved.ok) {
    return moved;
  }
  const next = moved.value;
  const changed = next !== record.assessment.state;
  const events: TrustSafetyEvent[] = changed
    ? [
        riskChanged(envelope(context), {
          subjectId: record.assessment.subjectId,
          assessmentId: record.assessment.assessmentId,
          from: record.assessment.state,
          to: next,
          reason: 'decay',
          detectors: record.assessment.contributingDetectors,
          effectiveScore: 0,
        }),
      ]
    : [];

  const friction = expireFriction(record.friction, context.now).filter(
    (entry) => RISK_RANK[next] >= RISK_RANK[REVERSIBLE_FRICTION[entry.kind].minRiskState],
  );
  const candidate =
    record.candidate !== null && RISK_RANK[next] < RISK_RANK.high ? null : record.candidate;

  return {
    ok: true,
    value: {
      record: {
        ...record,
        assessment: { ...record.assessment, state: next },
        friction,
        candidate,
        updatedAt: context.now,
      },
      events,
      raised: null,
    },
  };
}

/**
 * A user disputes. Friction is withdrawn immediately, the case is queued, the
 * risk state is untouched, and no notice about risk is ever produced.
 */
export function applyDispute(
  record: RiskRecord,
  dispute: RiskDispute,
  context: AssessmentContext,
): RiskTransition {
  const outcome = handleDispute(record.friction, record.assessment, dispute, context.now);
  return {
    record: {
      ...record,
      friction: record.friction.filter((entry) => !outcome.frictionLifted.includes(entry.kind)),
      candidate: outcome.candidate,
      disputes: [...record.disputes, dispute],
      updatedAt: context.now,
    },
    events: [reviewCandidateRaised(envelope(context), outcome.candidate)],
    raised: outcome.candidate,
  };
}

/**
 * The only way risk goes down by decision rather than by silence. A named
 * assessor is required by the policy layer, the queue entry closes, the open
 * disputes are resolved, and every outstanding proposal is withdrawn.
 */
export function reassessByHuman(
  record: RiskRecord,
  assessorId: string,
  context: AssessmentContext,
): Result<RiskTransition, DomainError> {
  const moved = assessHumanReassessment(record.assessment.state, assessorId);
  if (!moved.ok) {
    return moved;
  }
  return {
    ok: true,
    value: {
      record: {
        ...record,
        assessment: { ...record.assessment, state: moved.value },
        friction: [],
        candidate: null,
        disputes: record.disputes.map((dispute) =>
          isOpenDispute(dispute) ? { ...dispute, resolvedAt: context.now } : dispute,
        ),
        updatedAt: context.now,
      },
      events: [
        riskChanged(envelope(context), {
          subjectId: record.assessment.subjectId,
          assessmentId: record.assessment.assessmentId,
          from: record.assessment.state,
          to: moved.value,
          reason: 'human_reassess',
          detectors: record.assessment.contributingDetectors,
          effectiveScore: 0,
        }),
      ],
      raised: null,
    },
  };
}
