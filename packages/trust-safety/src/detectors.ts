import { type Detector, MAX_SIGNALS_PER_RUN, type SignalDraft } from './detector.js';
import { type Observation, type ObservationKind } from './observation.js';
import type { PairingMatcher } from './pairing.js';

/**
 * The detectors that exist, as code rather than as a table in a document.
 *
 * Every detector here is built from observations the reduction can actually
 * produce: each kind it reads has a row in `OBSERVATION_REDUCTION`, and that
 * row is total over a `ReducibleEventType`, so a detector cannot name an input
 * with no producer. The reverse is also checked by hand, in
 * `docs/architecture/trust-safety.md` §5, which lists the catalogue entries that
 * are still unimplemented and why.
 *
 * Weights, reliabilities and behaviour keys are the ones the architecture
 * document publishes. The window thresholds below are not: they are the
 * unvalidated guesses the document's open questions admit to, declared here so
 * that a number a reviewer disputes has exactly one place to change.
 */

/** A seven-day observation window, the widest a `SignalFacts.windowMinutes` may be. */
const WIDE_WINDOW_MINUTES = 10_080;

/** The most recent evidence in a batch, which is a signal's `occurredAt`. */
function evidenceAt(entries: readonly Observation[], now: Date): Date {
  return entries.reduce<Date>(
    (latest, entry) => (entry.occurredAt.getTime() > latest.getTime() ? entry.occurredAt : latest),
    now,
  );
}

/**
 * The observations of one kind, inside one window, in which the subject is the
 * performer or the account it happened to. Every detector looks through this,
 * so what "the subject's recent behaviour" means is decided once.
 */
function withinWindow(
  observations: readonly Observation[],
  kind: ObservationKind,
  subjectId: Observation['subjectId'],
  now: Date,
  windowMinutes: number,
): readonly Observation[] {
  const since = now.getTime() - windowMinutes * 60 * 1000;
  return observations.filter(
    (entry) =>
      entry.kind === kind &&
      entry.occurredAt.getTime() >= since &&
      (entry.actorId === subjectId || entry.subjectId === subjectId),
  );
}

/** Outbound likes in an hour that count as a burst rather than enthusiasm. */
export const LIKE_BURST_THRESHOLD = 25;
const LIKE_BURST_WINDOW_MINUTES = 60;

/** Messages in an hour in one conversation that count as a burst. */
export const MESSAGE_BURST_THRESHOLD = 30;

/** Profile rewrites in a week that count as churn rather than filling in a profile. */
export const PROFILE_CHURN_THRESHOLD = 10;

/**
 * How long after a verification attempt a state change still counts as that
 * attempt's consequence. Long enough to cover a review cycle, short enough that
 * a later, unrelated change is not attributed to it.
 */
const IDENTITY_REUSE_WINDOW_MINUTES = WIDE_WINDOW_MINUTES;

const likeBurst: Detector = {
  detector: 'velocity.like_burst',
  reliability: 'low',
  category: 'velocity',
  escalation: 'corroboration_only',
  detect: (input, context) => {
    const outbound = withinWindow(
      context.observations,
      'like.recorded',
      input.subjectId,
      input.now,
      LIKE_BURST_WINDOW_MINUTES,
    ).filter((entry) => entry.actorId === input.subjectId);
    if (outbound.length < LIKE_BURST_THRESHOLD) {
      return [];
    }
    return [
      {
        subjectId: input.subjectId,
        actorId: input.subjectId,
        behaviour: { kind: 'like_velocity', entityId: input.subjectId },
        occurredAt: evidenceAt(outbound, input.now),
        weight: 0.35,
        facts: {
          occurrences: outbound.length,
          windowMinutes: LIKE_BURST_WINDOW_MINUTES,
          direction: 'outbound',
        },
      },
    ];
  },
};

const messageBurst: Detector = {
  detector: 'velocity.message_burst',
  reliability: 'medium',
  category: 'velocity',
  escalation: 'corroboration_only',
  detect: (input, context) => {
    const bursts = withinWindow(
      context.observations,
      'communication.message_sent',
      input.subjectId,
      input.now,
      WIDE_WINDOW_MINUTES,
    ).filter(
      (entry) =>
        entry.actorId === input.subjectId && (entry.count ?? 0) >= MESSAGE_BURST_THRESHOLD,
    );
    if (bursts.length === 0) {
      return [];
    }
    return [
      {
        subjectId: input.subjectId,
        actorId: input.subjectId,
        behaviour: { kind: 'message_velocity', entityId: bursts[0]?.entityId ?? input.subjectId },
        occurredAt: evidenceAt(bursts, input.now),
        weight: 0.4,
        facts: {
          occurrences: Math.max(...bursts.map((entry) => entry.count ?? 0)),
          windowMinutes: 60,
          direction: 'outbound',
        },
      },
    ];
  },
};

const profileChurn: Detector = {
  detector: 'dating.profile_churn',
  reliability: 'low',
  category: 'velocity',
  escalation: 'corroboration_only',
  detect: (input, context) => {
    const edits = withinWindow(
      context.observations,
      'profile.state_changed',
      input.subjectId,
      input.now,
      WIDE_WINDOW_MINUTES,
    );
    if (edits.length < PROFILE_CHURN_THRESHOLD) {
      return [];
    }
    return [
      {
        subjectId: input.subjectId,
        actorId: input.subjectId,
        behaviour: { kind: 'profile_churn', entityId: input.subjectId },
        occurredAt: evidenceAt(edits, input.now),
        weight: 0.3,
        facts: {
          occurrences: edits.length,
          windowMinutes: WIDE_WINDOW_MINUTES,
          direction: 'outbound',
        },
      },
    ];
  },
};

/**
 * Being unmatched is not evidence about you, and this detector is the reason
 * the architecture can say so with a number attached rather than a promise: at
 * weight 0.5 and `low` reliability the score is 0.35, and each unmatch is a
 * different match, so the repeat counter never accumulates. A hundred accounts
 * unmatching one subject is a hundred separate 0.35s and reaches `normal`'s
 * 0.5 gate not at all.
 *
 * The observation names the account that was unmatched as its subject, taken
 * from the envelope the producer published. A producer that put the performer
 * there instead produces an observation whose performer and subject are the
 * same account, and the filter below leaves this detector silent — which is the
 * right answer to an unmatch whose other account is unknown.
 */
const unmatchByCounterparty: Detector = {
  detector: 'interaction.unmatch_by_counterparty',
  reliability: 'low',
  category: 'interaction',
  escalation: 'corroboration_only',
  detect: (input, context) => {
    const received = withinWindow(
      context.observations,
      'unmatch.performed',
      input.subjectId,
      input.now,
      WIDE_WINDOW_MINUTES,
    ).filter((entry) => entry.subjectId === input.subjectId && entry.actorId !== input.subjectId);
    return received
      // A busy account must not be able to make its own run fail: the cap is a
      // bound on one account's output, not a threshold it can trip.
      .slice(0, MAX_SIGNALS_PER_RUN)
      .map<SignalDraft>((entry) => ({
        subjectId: input.subjectId,
        actorId: input.subjectId,
        behaviour: { kind: 'unmatch_by_counterparty', entityId: entry.entityId ?? input.subjectId },
        occurredAt: entry.occurredAt,
        weight: 0.5,
        facts: { occurrences: 1, direction: 'inbound' },
      }));
  },
};

/**
 * Identity churn: an attempt, and a state change that followed it. The
 * behaviour is keyed on the attempt's opaque verification id, so two attempts
 * are two behaviours and the repeat counter only counts a genuine retry of the
 * same attempt. Nothing about the evidence is here, because nothing about the
 * evidence was reduced.
 */
const identityReuse: Detector = {
  detector: 'identity.reuse',
  reliability: 'medium',
  category: 'identity',
  escalation: 'corroboration_only',
  detect: (input, context) => {
    const attempts = withinWindow(
      context.observations,
      'verification.attempt.started',
      input.subjectId,
      input.now,
      IDENTITY_REUSE_WINDOW_MINUTES,
    );
    const changes = withinWindow(
      context.observations,
      'identity.status_changed',
      input.subjectId,
      input.now,
      IDENTITY_REUSE_WINDOW_MINUTES,
    );
    const followed = attempts.filter((attempt) =>
      changes.some(
        (change) =>
          change.occurredAt.getTime() >= attempt.occurredAt.getTime() &&
          change.occurredAt.getTime() - attempt.occurredAt.getTime() <=
            IDENTITY_REUSE_WINDOW_MINUTES * 60 * 1000,
      ),
    );
    const first = followed[0];
    if (first === undefined) {
      return [];
    }
    return [
      {
        subjectId: input.subjectId,
        actorId: input.subjectId,
        behaviour: { kind: 'identity_reuse', entityId: first.entityId ?? input.subjectId },
        occurredAt: evidenceAt(followed, input.now),
        weight: 0.45,
        facts: {
          occurrences: followed.length,
          windowMinutes: IDENTITY_REUSE_WINDOW_MINUTES,
          direction: 'outbound',
        },
      },
    ];
  },
};

/**
 * The implemented catalogue. Order is irrelevant: detectors never see each
 * other's output within a cycle, and one that fails does not stop the rest.
 */
export const SAFETY_DETECTORS: readonly Detector[] = [
  likeBurst,
  messageBurst,
  profileChurn,
  unmatchByCounterparty,
  identityReuse,
];

/**
 * Unmatch, then a report about the same account, on the same match.
 *
 * This is the one pattern in the catalogue a person can only produce
 * deliberately: nobody unmatches a stranger and then files a report against
 * them by accident. It was also, until issue #45, the one detector with no
 * producer at all — the report leg is `restricted` and named no match, so the
 * pairing was not derivable at any clearance. It is now a join on a keyed
 * token, and the detector is built around one rule: **an unmatch pairs with a
 * report only when the token on the report is the token derived from that
 * unmatch's match.** Every other fact is already in hand, so a detector that
 * paired on "an unmatch and a report exist" would answer once per pair
 * regardless of whether the two describe the same two accounts — which is the
 * failure a wider clearance would have invited, and the reason the join is a
 * token and not the report.
 *
 * The unmatch must come first. A report filed while the match was still live is
 * the ordinary case of a user reporting someone they are talking to, and
 * reading it as retaliation is exactly the false positive §5 records.
 *
 * `corroboration_only` at 0.6 and `high`: the loudest evidence in the
 * catalogue, and still not allowed to move a subject on its own. Two accounts
 * behaving like this is a pattern; one is an anecdote.
 */
function unmatchReport(pairing: PairingMatcher): Detector {
  return {
    detector: 'interaction.unmatch_report',
    reliability: 'high',
    category: 'interaction',
    escalation: 'corroboration_only',
    detect: (input, context) => {
      const reports = withinWindow(
        context.observations,
        'moderation.report_pairing',
        input.subjectId,
        input.now,
        WIDE_WINDOW_MINUTES,
      );
      if (reports.length === 0) {
        return [];
      }
      // The account that was unmatched has to be the subject, and the account
      // that did the unmatching has to be somebody else. A producer that put
      // the performer in the envelope's place produces an observation that
      // fails both, and this detector stays silent about an unmatch it cannot
      // place — the same answer `unmatch_by_counterparty` gives.
      const unmatchs = withinWindow(
        context.observations,
        'unmatch.performed',
        input.subjectId,
        input.now,
        WIDE_WINDOW_MINUTES,
      ).filter((entry) => entry.subjectId === input.subjectId && entry.actorId !== input.subjectId);

      const drafts: SignalDraft[] = [];
      for (const report of reports) {
        const { pairingToken, entityId: reportId } = report;
        if (pairingToken === undefined || reportId === undefined) {
          continue;
        }
        for (const unmatch of unmatchs) {
          const matchId = unmatch.entityId;
          if (matchId === undefined || unmatch.occurredAt.getTime() > report.occurredAt.getTime()) {
            continue;
          }
          const paired = pairing.matches(pairingToken, {
            reportId,
            matchId,
            subjectId: input.subjectId,
          });
          if (!paired) {
            continue;
          }
          drafts.push({
            subjectId: input.subjectId,
            // The reported account. A token cannot name who reported, so this
            // signal cannot either, and the alternative — attributing the
            // behaviour to a reporter the reduction never carried — is a
            // subject a detector may not implicate.
            actorId: input.subjectId,
            behaviour: { kind: 'unmatch_then_report', entityId: matchId },
            occurredAt: report.occurredAt,
            weight: 0.6,
            facts: { occurrences: 1, windowMinutes: WIDE_WINDOW_MINUTES, direction: 'inbound' },
          });
          if (drafts.length === MAX_SIGNALS_PER_RUN) {
            return drafts;
          }
        }
      }
      return drafts;
    },
  };
}

/**
 * The full catalogue, for a deployment that has a pairing secret.
 *
 * The pairing detector is not in `SAFETY_DETECTORS` because it cannot exist
 * without a secret, and a detector that cannot verify a token must not be
 * constructible — a seam that silently ran a detector which could never fire
 * would report a healthy cycle and produce nothing. Bringing your own detector
 * list is the other way to say what you are running; `createSafetySeam` accepts
 * one or the other, never neither.
 */
export function createSafetyDetectors(pairing: PairingMatcher): readonly Detector[] {
  return [...SAFETY_DETECTORS, unmatchReport(pairing)];
}
