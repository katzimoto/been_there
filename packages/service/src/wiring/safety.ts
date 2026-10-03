import { createHash, randomUUID } from 'node:crypto';
import {
  type CorrelationId,
  type EventId,
  type DomainError,
  type DomainEvent,
  type EventPublisher,
  type EventSubscriber,
  InMemoryEventBus,
  type RiskAssessmentId,
  type RiskState,
  type SubjectId,
  type UserId,
  castId,
} from '@been-there/core';
import type { Stores, Transaction } from '@been-there/contracts';
import { type PairingKey, createPairingMatcher, type PairingMatcher, openCase } from '@been-there/moderation';
import {
  type DetectionReachability,
  type IdFactory,
  SAFETY_DETECTORS,
  type ReviewCandidate,
  type RiskRecord,
  type Signal,
  type SignalLedger,
  applySignal,
  createSafetyDetectors,
  createSafetySeam,
  emptyRiskRecord,
  safetyDetectorReach,
} from '@been-there/trust-safety';
import { auditAppender, caseRowOf, corrupt, flushAudit, requestModerationContext } from './moderation.js';
import type { ServiceDependencies } from '../ports.js';
import { subjectOf } from './standing.js';

/**
 * Trust & Safety, wired to the request.
 *
 * ## What this is
 *
 * A route that has just performed a behaviour says so — `observe(likeRecorded(...))`
 * — and this module decides what it means. It builds the event, hands it to the
 * domain's own reduction seam, runs the detector catalogue over the reduced facts,
 * and persists whatever the policy layer decides through `RiskStore`.
 *
 * The boundary is deliberate. A route never constructs a `DomainEvent`, never
 * names a detector, never reads or writes the risk store, and never decides
 * whether a behaviour is evidence. Everything about *what counts as risk* lives in
 * `@been-there/trust-safety`, and nothing about it lives in a route handler.
 *
 * ## What it does not invent
 *
 * Every variant of `ObservedBehaviour` names a fact a route already had in hand at
 * the moment it wrote its row. Nothing here infers, samples or predicts: a signal
 * exists only because a request really did record a like, send a message, end a
 * match, rewrite a profile or start a verification. There is no synthetic traffic
 * path and no score the service computes for itself.
 *
 * ## Two limits worth stating rather than discovering
 *
 *  1. **The observation window and the corroboration ledger are process-local.**
 *     `createSafetySeam` holds reduced facts in memory by design, and the ledger
 *     that feeds `corroborate` is held beside it. A restart forgets both, so a
 *     subject's recent behaviour stops corroborating until it is observed again.
 *     The *evidence* is durable — every signal is appended to `risk_signals` and
 *     every fold is written to `risk_assessments` — but a faithful replay from the
 *     store is not possible today: `risk_signals` has no column for a signal's
 *     author (`reliability`, `category`, `escalation`) nor for its actor, and
 *     `corroborate` reads the actor to count a reporting campaign's distinct
 *     reporters. That is a gap in the `RiskStore` port, not a choice made here.
 *  2. **Only one detector can carry a subject to `high`.** Every detector in the
 *     catalogue is `corroboration_only`, and the weighted scores cap below the
 *     shared machine's `0.7` gate for all of them except
 *     `interaction.unmatch_report` (weight 0.6, `high` reliability). That detector
 *     needs a pairing secret and is by construction downstream of a report, so the
 *     practical consequence is that a subject already at `high` reaches `critical`
 *     on two independent detectors, while a subject at `normal` reaches `elevated`
 *     and no further.
 */

/**
 * One observed behaviour, as the route that performed it saw it.
 *
 * A closed union over six of the seven rows of `OBSERVATION_REDUCTION`: each
 * variant is one reducible event, and the field names are the ones that reduction
 * rule reads. The seventh, `moderation.report_pairing`, is produced by moderation
 * itself rather than by a route, and needs a deployment secret — see
 * `SafetyWiring.pairingKey`.
 *
 * Adding a variant here is a decision about what a detector may see, and it is
 * reviewed as such rather than being reachable from an arbitrary payload.
 */
export type ObservedBehaviour =
  | { readonly kind: 'like.recorded'; readonly from: UserId; readonly to: UserId; readonly at: Date }
  | {
      readonly kind: 'communication.message_sent';
      readonly senderId: UserId;
      readonly peerId: UserId;
      readonly conversationId: string;
      /**
       * Messages in this conversation in the last hour, *including* the one just
       * sent. The reduction refuses a count below one, so publishing the count as
       * it stood before the append would drop the very message being reported —
       * and the count is the producer's own, never re-derived here.
       */
      readonly messagesLastHour: number;
      readonly at: Date;
    }
  | {
      readonly kind: 'unmatch.performed';
      /** The participant who ended the match. */
      readonly actorId: UserId;
      /**
       * The participant who *was* unmatched. `interaction.unmatch_by_counterparty`
       * and `interaction.unmatch_report` both require the subject to be somebody
       * other than the actor, so putting the performer here would leave both
       * detectors permanently silent — which is the domain's documented answer to
       * an unmatch it cannot place.
       */
      readonly subjectId: SubjectId;
      readonly matchId: string;
      readonly at: Date;
    }
  | { readonly kind: 'profile.state_changed'; readonly userId: UserId; readonly at: Date }
  | {
      readonly kind: 'verification.attempt.started';
      readonly userId: UserId;
      readonly verificationId: string;
      readonly at: Date;
    }
  /**
   * A report was filed, naming who filed it.
   *
   * This is the one observation whose performer and subject differ, and it is
   * the only producer of `report_against`. A report is an *accusation*, so this
   * fact must never move the account it names: the policy layer discards every
   * `report_against` signal and opens a case about the reporters instead
   * (`assessSignal`, and `signal.ts`'s attribution rule, which makes
   * `actorId !== subjectId` mandatory for this kind so a detector cannot
   * self-report its way to a risk state).
   *
   * `reporterId` is null for an anonymous report, and an anonymous report has
   * no reporter to count: `corroborate` counts *distinct* actors to recognise
   * a campaign, so a null reporter is not evidence of anything and is carried
   * as such rather than being guessed at.
   */
  | {
      readonly kind: 'moderation.report_submitted';
      readonly reporterId: UserId | null;
      /** The account the report was filed *against*. */
      readonly subjectId: SubjectId;
      readonly reportId: string;
      readonly at: Date;
    }
  | { readonly kind: 'identity.status_changed'; readonly userId: UserId; readonly at: Date };

/**
 * What a route is given. One method, and it names a behaviour rather than a score:
 * the service can assert that an account did something, never that it is risky.
 */
export interface SafetyRecorder {
  observe(behaviour: ObservedBehaviour, tx: Transaction): Promise<void>;
  /**
   * What the seam refused, oldest first. A refusal means a producer published an
   * event its reduction rule could not read, which is a defect worth seeing rather
   * than a gap to paper over.
   */
  refusals(): readonly DomainError[];
}

/**
 * The deployment facts this wiring needs, and nothing about the request.
 */
export interface SafetyWiring {
  readonly stores: Stores;
  /** Where this recorder's published events go. */
  readonly events: EventPublisher;
  readonly now: () => Date;
  /**
   * The per-deployment secret the pairing token is keyed with.
   *
   * With one, the catalogue is `createSafetyDetectors(matcher)` — six detectors,
   * including `interaction.unmatch_report`, the only evidence in the catalogue
   * loud enough to carry a subject to `high`. Without one it is
   * `SAFETY_DETECTORS`: five, none of which can reach `high` on its own numbers.
   * That is the domain's own stated position — a detector that cannot verify a
   * token must not be constructible — rather than a degraded mode invented here.
   */
  readonly pairingKey?: PairingKey;
}

/** A fold that keeps losing a race is not retried forever. */
const MAX_FOLD_ATTEMPTS = 3;

/** The states the shared risk machine declares, as the schema's CHECK permits. */
const RISK_STATES: readonly RiskState[] = ['normal', 'elevated', 'high', 'critical'];

/**
 * A stored state the machine does not declare is a store disagreement, not user
 * input. Guessing the nearest legal value would silently under-score a subject,
 * and under-scoring is the direction that hurts.
 */
function riskStateOf(value: string): RiskState {
  const found = RISK_STATES.find((state) => state === value);
  if (found === undefined) {
    throw corrupt(`risk assessment carries the unknown state "${value}"`);
  }
  return found;
}

/**
 * The persisted half of a subject's fold, plus the generation the write is checked
 * against.
 */
interface FoldedAssessment {
  readonly record: RiskRecord;
  /**
   * `null` when no row was read. `RiskStore.upsertAssessment` spells that
   * distinction itself, and passing a number there would claim a row exists and has
   * been written that many times.
   */
  readonly generation: number | null;
}

/**
 * The recorder. One per running service, injected through `ServiceDependencies`.
 */
export function createSafetyRecorder(wiring: SafetyWiring): SafetyRecorder {
  const pairing: PairingMatcher | null =
    wiring.pairingKey === undefined ? null : createPairingMatcher(wiring.pairingKey);
  const seam = createSafetySeam(
    pairing === null ? { now: wiring.now, detectors: SAFETY_DETECTORS } : { now: wiring.now, detectors: createSafetyDetectors(pairing) },
  );
  // The seam subscribes to a transport rather than being handed events, so it is
  // given the smallest one that exists. Publishing into it runs the real
  // `toObservation` path, clearance check included.
  const transport = new InMemoryEventBus();
  seam.subscribe(transport);
  const ids: IdFactory = {
    nextEventId: () => castId<'EventId'>(randomUUID()),
    // `risk_assessments.assessment_id` is a `uuid` column, so the factory the
    // domain tests use — a prefixed counter — is refused by Postgres here.
    nextAssessmentId: () => castId<'RiskAssessmentId'>(randomUUID()),
  };
  /** Folded state and evidence, per subject, for this process's lifetime. */
  const ledgers = new Map<SubjectId, SignalLedger>();
  const folded = new Map<SubjectId, FoldedAssessment>();

  return {
    refusals: () => seam.refusals(),

    async observe(behaviour, tx) {
      await transport.publish(behaviourEvent(behaviour, castId<'CorrelationId'>(randomUUID())));
      for (const subject of evaluatedSubjects(behaviour)) {
        const run = seam.detect(subject, ledgers.get(subject)?.entries ?? []);
        // A detector that threw is reported rather than thrown: one miscalibrated
        // detector must not cost the request its behaviour, and the run already
        // reported the failure rather than losing it.
        for (const failure of run.failures) {
          warn(`${failure.code} ${failure.message}`, subject);
        }
        for (const signal of run.signals) {
          await foldSignal(wiring, subject, signal, ledgers, folded, ids, tx);
        }
      }
    },
  };
}

/**
 * The accounts a behaviour is evidence *about*.
 *
 * The seam indexes an observation under its actor and its subject, and a detector
 * run for the wrong one produces nothing. For an unmatch that is two accounts —
 * the participant who ended the match and the one who was unmatched — and both are
 * evaluated, because being unmatched many times over is itself the pattern
 * `interaction.unmatch_by_counterparty` exists to see.
 */
function evaluatedSubjects(behaviour: ObservedBehaviour): readonly SubjectId[] {
  switch (behaviour.kind) {
    case 'like.recorded':
      return [subjectOf(behaviour.from)];
    case 'communication.message_sent':
      return [subjectOf(behaviour.senderId)];
    case 'unmatch.performed':
      return [subjectOf(behaviour.actorId), behaviour.subjectId];
    case 'moderation.report_submitted':
      // The account reported, and the reporter when they are named. The
      // reporter is evaluated because a cluster is evidence about *them*, and
      // `corroborate` reads each subject's own ledger — a campaign is only
      // visible when the third reporter's ledger can see the other two reports
      // about the same target. An anonymous report has no reporter to run for,
      // which is why an all-anonymous campaign is not countable: there is no
      // distinct actor to count.
      return [
        behaviour.subjectId,
        ...(behaviour.reporterId === null ? [] : [subjectOf(behaviour.reporterId)]),
      ];
    case 'profile.state_changed':
    case 'verification.attempt.started':
    case 'identity.status_changed':
      return [subjectOf(behaviour.userId)];
  }
}

/**
 * The event the reduction table expects.
 *
 * The envelope's `subjectId` is the account the behaviour happened *to*, which for
 * two of these rows is the only place a rule is allowed to read it from — the
 * reduction refuses to reach for `actorId`.
 */
function behaviourEvent(
  behaviour: ObservedBehaviour,
  correlationId: CorrelationId,
): DomainEvent<Readonly<Record<string, unknown>>> {
  const at = behaviour.at;
  const envelope = (
    payload: Readonly<Record<string, unknown>>,
    subjectId?: SubjectId,
  ): DomainEvent<Readonly<Record<string, unknown>>> => ({
    eventId: castId<'EventId'>(randomUUID()),
    type: behaviour.kind,
    version: 1,
    occurredAt: at,
    actorId: 'system',
    ...(subjectId === undefined ? {} : { subjectId }),
    correlationId,
    // `internal` throughout: these are behaviour observations and the reduction
    // clearance is `internal`. Nothing here carries a message body, a name or a
    // coordinate, so there is nothing above it either.
    sensitivity: 'internal',
    payload,
  });
  switch (behaviour.kind) {
    case 'like.recorded':
      return envelope({ from: behaviour.from, to: behaviour.to });
    case 'communication.message_sent':
      return envelope({
        senderId: behaviour.senderId,
        peerId: behaviour.peerId,
        conversationId: behaviour.conversationId,
        messagesLastHour: behaviour.messagesLastHour,
      });
    case 'unmatch.performed':
      return envelope({ actorId: behaviour.actorId, matchId: behaviour.matchId }, behaviour.subjectId);
    case 'moderation.report_submitted':
      // No reason, no statement, no evidence digest: the reduction rule reads a
      // reporter, a reported account and a report id, and a payload field no
      // rule names cannot cross into an observation. That is what keeps a
      // free-text allegation out of a scoring engine.
      return envelope({
        reporterId: behaviour.reporterId ?? '',
        reportedUserId: behaviour.subjectId,
        reportId: behaviour.reportId,
      });
    case 'profile.state_changed':
      return envelope({ userId: behaviour.userId });
    case 'verification.attempt.started':
      return envelope({ verificationId: behaviour.verificationId }, subjectOf(behaviour.userId));
    case 'identity.status_changed':
      return envelope({ identity: { subjectId: subjectOf(behaviour.userId) } });
  }
}

/**
 * One signal in, one risk record out, persisted.
 *
 * `applySignal` is a pure fold, so a refused write — a generation that moved under
 * us — is retried against a freshly read row rather than against a guess. That is
 * what the `RiskStore` port's own comment describes, and it is safe precisely
 * because the fold is pure.
 *
 * The signal id is minted once, before the loop: `appendSignal` is idempotent on
 * `signalId`, so retrying with a fresh id would write the same evidence twice.
 */
async function foldSignal(
  wiring: SafetyWiring,
  subjectId: SubjectId,
  signal: Signal,
  ledgers: Map<SubjectId, SignalLedger>,
  folded: Map<SubjectId, FoldedAssessment>,
  ids: IdFactory,
  tx: Transaction,
): Promise<void> {
  const at = signal.occurredAt;
  const correlationId = castId<'CorrelationId'>(randomUUID());
  const ledger = ledgers.get(subjectId) ?? { entries: [] };
  const signalId = randomUUID();
  for (let attempt = 1; attempt <= MAX_FOLD_ATTEMPTS; attempt += 1) {
    const current = await readAssessment(wiring, subjectId, at, ids, tx);
    const transition = applySignal(current.record, signal, ledger, { now: at, correlationId, ids });
    if (!transition.ok) {
      warn(`${signal.detector} refused: ${transition.error.code} ${transition.error.message}`, subjectId);
      return;
    }
    if (attempt === 1) {
      await wiring.stores.risk.appendSignal(
        {
          signalId,
          subjectId: String(signal.subjectId),
          detector: signal.detector,
          behaviour: signal.behaviour.kind,
          entityId: signal.behaviour.entityId,
          facts: { ...signal.facts },
          weight: signal.weight,
          occurredAt: signal.occurredAt,
          // The signal's author and performer, so the log can be folded back
          // into a ledger after a restart (migration 007). Without these the row
          // is not a `Signal`: `corroborate` reads the actor to count a
          // campaign's *distinct reporters*, and the policy layer reads the
          // declaration to score it. A column nobody writes is the same false
          // claim as a detector nobody can fire.
          actorId: String(signal.actorId),
          reliability: signal.reliability,
          category: signal.category,
          escalation: signal.escalation,
        },
        tx,
      );
    }
    const written = await wiring.stores.risk.upsertAssessment(
      subjectId,
      transition.value.record.assessment.assessmentId,
      transition.value.record.assessment.state,
      transition.value.record.assessment.lastSignalAt,
      transition.value.record.assessment.contributingDetectors,
      current.generation,
      tx,
    );
    if (!written.applied) {
      continue;
    }
    folded.set(subjectId, {
      record: transition.value.record,
      generation: current.generation === null ? 1 : current.generation + 1,
    });
    ledgers.set(subjectId, transition.value.ledger ?? ledger);
    for (const event of transition.value.events) {
      // The envelope is the domain's own, unchanged. Only the payload's *static*
      // type is widened: `RiskChangedPayload` and its siblings are declared as
      // plain interfaces, so they carry no index signature and `EventPublisher`'s
      // open `payload` will not accept them as they stand.
      await wiring.events.publish({ ...event, payload: { ...event.payload } });
    }
    await raiseReviewCandidate(wiring, subjectId, transition.value.record, transition.value.raised, correlationId, tx);
    return;
  }
  warn(`gave up folding ${signal.detector} after ${MAX_FOLD_ATTEMPTS} attempts`, subjectId);
}

/**
 * The stored assessment, rebuilt into the record `applySignal` folds over.
 *
 * `RiskStore` persists the assessment and nothing else: friction proposals,
 * outstanding review candidates and open disputes are not columns, so they are
 * empty here. That is the port's shape rather than a decision made here, and the
 * consequence is that a friction proposal or a queue entry does not survive a
 * restart — the risk state itself does.
 *
 * The generation comes off the row rather than the record, because
 * `RiskAssessment` does not carry it: it belongs to the store's optimistic
 * concurrency check, not to the domain's view of a subject.
 */
async function readAssessment(
  wiring: SafetyWiring,
  subjectId: SubjectId,
  at: Date,
  ids: IdFactory,
  tx: Transaction,
): Promise<FoldedAssessment> {
  const row = await wiring.stores.risk.findAssessment(subjectId, tx);
  if (row === null) {
    return { record: emptyRiskRecord(subjectId, ids.nextAssessmentId(), at), generation: null };
  }
  return {
    record: {
      assessment: {
        subjectId,
        assessmentId: castId<'RiskAssessmentId'>(String(row['assessmentId'])),
        state: riskStateOf(String(row['state'])),
        lastSignalAt: row['lastSignalAt'] instanceof Date ? row['lastSignalAt'] : null,
        contributingDetectors: Array.isArray(row['contributingDetectors'])
          ? (row['contributingDetectors'] as readonly string[])
          : [],
      },
      friction: [],
      candidate: null,
      disputes: [],
      updatedAt: row['updatedAt'] instanceof Date ? row['updatedAt'] : at,
    },
    generation: Number(row['generation']),
  };
}

/**
 * The review candidate, opened as a moderation case.
 *
 * A risk record on its own puts nothing in front of a human. `openCase` with
 * `trust_safety_review` intake is the existing path for exactly this, and it is
 * the only way a detected account reaches a moderator — the automation enforces
 * nothing, which is commitment 2 and the reason this function exists at all.
 *
 * A cluster candidate — the mass-reporting campaign — is left alone on purpose.
 * `openCase` intakes about one account, and a campaign is about several reporters
 * at once; an intake invented for it here would be a second moderation path.
 */
async function raiseReviewCandidate(
  wiring: SafetyWiring,
  subjectId: SubjectId,
  record: RiskRecord,
  candidate: ReviewCandidate | null,
  correlationId: CorrelationId,
  tx: Transaction,
): Promise<void> {
  if (candidate === null || candidate.target.kind !== 'account') {
    return;
  }
  const { context, pending } = requestModerationContext(record.updatedAt, { publish: wiring.events });
  const assessment = record.assessment;
  const opened = openCase(context, {
    source: 'trust_safety_review',
    subjectId: castId<'UserId'>(subjectId),
    riskAssessmentId: assessment.assessmentId,
    riskState: assessment.state,
    detectors: assessment.contributingDetectors,
    digest: riskDigest(record),
    openedBy: 'system',
    correlationId,
  });
  if (!opened.ok) {
    warn(`review case refused: ${opened.error.code} ${opened.error.message}`, subjectId);
    return;
  }
  await wiring.stores.moderation.insertCase(caseRowOf(opened.value.moderationCase), tx);
  await flushAudit(pending, auditAppender((row, auditTx) => wiring.stores.moderation.appendAudit(row, auditTx)), tx);
}

/** A content hash of the assessment the case freezes, so the intake is auditable. */
function riskDigest(record: RiskRecord): string {
  const material = JSON.stringify({
    subjectId: record.assessment.subjectId,
    state: record.assessment.state,
    lastSignalAt: record.assessment.lastSignalAt?.toISOString() ?? null,
    detectors: record.assessment.contributingDetectors,
  });
  return `sha256:${createHash('sha256').update(material).digest('hex')}`;
}

/**
 * Detector and store trouble goes to stderr rather than failing the request.
 *
 * The request performed a real behaviour and its row is already written; refusing
 * the request would take that back, and a like is not evidence of anything. The
 * refusal is not swallowed — it is on stderr, and a reduction that could not read
 * an event is also visible through `SafetyRecorder.refusals()`.
 */
function warn(message: string, subjectId: SubjectId): void {
  process.stderr.write(`[safety] ${subjectId}: ${message}\n`);
}

/**
 * What the service holds for one set of dependencies: the recorder routes talk
 * to, and the stream its events leave on.
 */
export interface ServiceSafety {
  readonly recorder: SafetyRecorder;
  readonly events: EventPublisher & EventSubscriber;
  /**
   * What this deployment's detector catalogue can actually reach, computed from
   * the detectors it is really running.
   *
   * This is what lets the metrics endpoint say *why*
   * `safety.detected_before_first_report` reads zero, instead of serving a
   * plausible number that is indistinguishable from detection working. With
   * the verification provider a stub, the only detectors loud enough to reach
   * `high` are downstream of a report — so the metric's comparison
   * (`risk.changed` before the first `moderation.report_submitted`) is
   * unsatisfiable, and no wiring or configuration can change that.
   */
  readonly detectorReach: DetectionReachability;
}

const SURFACES = new WeakMap<ServiceDependencies, ServiceSafety>();

/**
 * The safety surface for these dependencies.
 *
 * Memoised on the `ServiceDependencies` identity for the same reason
 * `createServiceHealth` is: one process, one detector seam and one event stream,
 * or corroboration would count two accounts' behaviour as one subject's and the
 * metrics endpoint would serve a registry the detectors never wrote to.
 *
 * The pairing secret is read from `RISK_PAIRING_SECRET` rather than injected,
 * because it is a deployment secret in the way `contacts` is an edge decision,
 * and there is exactly one deployment to configure. An absent secret means the
 * five detectors that need none — never a default anybody could guess, because a
 * guessable secret would make the pairing token forgeable.
 */
export function createServiceSafety(dependencies: ServiceDependencies): ServiceSafety {
  const existing = SURFACES.get(dependencies);
  if (existing !== undefined) {
    return existing;
  }
  const events = new InMemoryEventBus();
  const secret = process.env['RISK_PAIRING_SECRET'];
  const pairingKey = secret === undefined || secret.length === 0 ? null : { secret };
  const created: ServiceSafety = {
    events,
    recorder: createSafetyRecorder({
      stores: dependencies.stores,
      events,
      now: dependencies.now,
      ...(pairingKey === null ? {} : { pairingKey }),
    }),
    // Computed from the same detector list the recorder was built with, so what
    // this serves can never describe a catalogue the process is not running.
    detectorReach: safetyDetectorReach(
      pairingKey === null ? SAFETY_DETECTORS : createSafetyDetectors(createPairingMatcher(pairingKey)),
    ),
  };
  SURFACES.set(dependencies, created);
  return created;
}
