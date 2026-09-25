import { type DomainError, type Result, type SubjectId, domainError, ok } from '@been-there/core';
import {
  TRUST_SAFETY_DOMAIN,
  type Signal,
  type SignalAuthor,
  type SignalInput,
  createSignal,
} from './signal.js';

/**
 * Everything a detector is allowed to see, in one closed list.
 *
 * These are the reduced, metadata-only facts that arrive from other domains as
 * events or read-model projections. No message body, no photo, no verification
 * artefact, no exact location, and deliberately **no account state** — a
 * detector that could read `limited`/`suspended`/`banned` would be one refactor
 * away from being an enforcement engine, which is exactly what this package
 * must never be.
 */
export const OBSERVATION_KINDS = [
  'identity_status_changed',
  'verification_attempted',
  'profile_edited',
  'like_sent',
  'unmatch_initiated',
  'match_ended',
  'conversation_opened',
  'message_sent',
  'message_reported',
  'block_created',
] as const;

export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

/**
 * One reduced fact from another domain. `count` lets a projection batch
 * repeated events, so a detector never needs the raw event stream and the
 * platform never has to hand over message content to run safety analysis.
 */
export interface Observation {
  readonly kind: ObservationKind;
  readonly occurredAt: Date;
  /** Who performed the behaviour. */
  readonly actorId: SubjectId;
  /** Who it happened to. Differs from `actorId` for `message_reported`. */
  readonly subjectId: SubjectId;
  /** The other party, when the observation involves two accounts. */
  readonly counterpartyId?: SubjectId;
  /** Opaque id of what it happened to — a match, a conversation. */
  readonly entityId?: string;
  /** Batched count when the projection aggregated repeats. */
  readonly count?: number;
}

/** What the pipeline asks a detector about: one subject, one moment. */
export interface DetectorInput {
  readonly subjectId: SubjectId;
  readonly now: Date;
  readonly observations: readonly Observation[];
}

/**
 * The complete surface a detector runs against.
 *
 * Three fields, and the list is asserted exhaustively in
 * `test/type-guarantees.test.ts`. There is no account state, no case handle, no
 * moderator identity, no repository, no clock. A detector that wants to know
 * whether an account is suspended cannot ask, because nothing here answers it.
 */
export interface DetectorContext {
  readonly now: Date;
  /** Only observations the subject performed or received. */
  readonly observations: readonly Observation[];
  /** Only signals already raised against this subject. */
  readonly priorSignals: readonly Signal[];
}

/** A detector's only output type. There is no "decision" to return. */
export type SignalDraft = SignalInput;

/**
 * The detection port. Implementing it is a five-line object literal.
 *
 * The three-layer separation of `docs/architecture/trust-safety.md` is
 * structural, not conventional: this interface has exactly one method, it
 * returns drafts, and the drafts carry no account vocabulary.
 */
export interface Detector extends SignalAuthor {
  detect(input: DetectorInput, context: DetectorContext): readonly SignalDraft[];
}

/** A single bad detector must not be able to stall or crash the pipeline. */
export const MAX_SIGNALS_PER_RUN = 20;

const DETECTOR_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

/**
 * Runs a detector and vets everything it produced.
 *
 * The vetting is the load-bearing part of the port:
 *  - the context is assembled *here*, from three filtered slices, so no ambient
 *    state (least of all account standing) can reach a detector;
 *  - a detector may only implicate an account that appears in its own input,
 *    so a bug cannot aim risk at an arbitrary user;
 *  - a signal dated in the future, or beyond the run cap, is rejected.
 *
 * Failures are returned, never thrown: one misbehaving detector must not stop
 * the other detectors in the same cycle.
 */
export function runDetector(
  detector: Detector,
  input: DetectorInput,
  priorSignals: readonly Signal[],
): Result<readonly Signal[], DomainError> {
  if (!DETECTOR_NAME.test(detector.detector)) {
    return domainError('validation_failed', TRUST_SAFETY_DOMAIN, 'detector name must be a dotted lower_snake_case identifier', {
      detector: detector.detector,
    });
  }

  const context: DetectorContext = {
    now: input.now,
    observations: input.observations.filter(
      (observation) => observation.subjectId === input.subjectId || observation.actorId === input.subjectId,
    ),
    priorSignals: priorSignals.filter((signal) => signal.subjectId === input.subjectId),
  };

  let drafts: readonly SignalDraft[];
  try {
    drafts = detector.detect(input, context);
  } catch {
    return domainError('internal', TRUST_SAFETY_DOMAIN, 'detector threw while evaluating its input', {
      detector: detector.detector,
    });
  }

  if (!Array.isArray(drafts)) {
    return domainError('validation_failed', TRUST_SAFETY_DOMAIN, 'detector did not return a signal list', {
      detector: detector.detector,
    });
  }
  if (drafts.length > MAX_SIGNALS_PER_RUN) {
    return domainError('validation_failed', TRUST_SAFETY_DOMAIN, 'detector produced more signals than one run may emit', {
      detector: detector.detector,
      limit: MAX_SIGNALS_PER_RUN,
    });
  }

  // Anything the detector may name as a subject: the subject under evaluation,
  // plus every actor and subject in the observations it was given. Built at
  // runtime, so this is the one legitimate set here.
  const implicable = new Set<string>([
    input.subjectId,
    ...input.observations.map((observation) => observation.actorId),
    ...input.observations.map((observation) => observation.subjectId),
    ...input.observations.map((observation) => observation.counterpartyId ?? ''),
  ]);

  const signals: Signal[] = [];
  for (const draft of drafts) {
    if (!implicable.has(draft.subjectId)) {
      return domainError('validation_failed', TRUST_SAFETY_DOMAIN, 'detector emitted a signal about a subject outside its input', {
        detector: detector.detector,
      });
    }
    if (draft.occurredAt.getTime() > input.now.getTime()) {
      return domainError('validation_failed', TRUST_SAFETY_DOMAIN, 'detector emitted a signal dated after the evaluation time', {
        detector: detector.detector,
      });
    }
    const signal = createSignal(draft, detector);
    if (!signal.ok) {
      return signal;
    }
    signals.push(signal.value);
  }
  return ok(signals);
}
