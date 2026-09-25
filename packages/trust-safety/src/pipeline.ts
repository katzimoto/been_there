import {
  type DomainError,
  type EventSubscriber,
  type SubjectId,
  type Unsubscribe,
} from '@been-there/core';
import { type Detector, runDetector } from './detector.js';
import { SAFETY_DETECTORS } from './detectors.js';
import { type Observation, REDUCTION_CLEARANCE, toObservation } from './observation.js';
import type { Signal } from './signal.js';

/**
 * The only stateful thing in this package, and it holds only reduced facts.
 *
 * Everything else here is a pure function of (state, evidence, now). The seam
 * exists because two pure functions need something to join them: an event
 * arrives on a transport nobody in this package owns, and a detector needs the
 * observations that event reduced to. It subscribes, it reduces, it indexes by
 * the two accounts in the fact, and it runs detectors — in that order, and
 * nowhere else.
 *
 * It holds no risk record, no ledger and no account state. Those belong to a
 * repository the domain does not own, and a detector still cannot reach them:
 * `detect` hands back evidence, and what a piece of evidence is *worth* stays
 * the policy layer's decision.
 */

/** How many reduced facts are kept per account. The oldest are dropped. */
export const OBSERVATIONS_PER_SUBJECT = 256;

/** How many refusals are retained for inspection. The oldest are dropped. */
export const REFUSALS_RETAINED = 64;

export interface SafetySeamOptions {
  /** The one clock. Every `occurredAt` and every window is measured against it. */
  readonly now: () => Date;
  /** Defaults to the implemented catalogue; a test may pass one detector. */
  readonly detectors?: readonly Detector[];
}

export interface DetectionRun {
  readonly signals: readonly Signal[];
  /**
   * Detectors that failed this cycle, with their errors. One misbehaving
   * detector must not stop the others, so a failure is reported rather than
   * thrown and the run continues.
   */
  readonly failures: readonly DomainError[];
}

export interface SafetySeam {
  /**
   * Subscribe to a transport at `REDUCTION_CLEARANCE` and reduce everything it
   * delivers. Returns the transport's own unsubscribe.
   */
  subscribe(source: EventSubscriber): Unsubscribe;
  /** The reduced facts held for one account, in arrival order. */
  observationsFor(subjectId: SubjectId): readonly Observation[];
  /**
   * Everything the seam refused, oldest first. A refusal is a producer's bug or
   * a classification problem, never a reason to observe less: it is retained
   * so an operator can see which events the seam is turning away.
   */
  refusals(): readonly DomainError[];
  /** Run every detector over one account's reduced facts. */
  detect(subjectId: SubjectId, priorSignals: readonly Signal[]): DetectionRun;
}

export function createSafetySeam(options: SafetySeamOptions): SafetySeam {
  const detectors = options.detectors ?? SAFETY_DETECTORS;
  const bySubject = new Map<SubjectId, readonly Observation[]>();
  const refused: DomainError[] = [];

  /**
   * Indexes one observation under the two accounts it is about. `counterpartyId`
   * is deliberately not a key: `runDetector` shows a detector only what the
   * subject performed or received, so indexing it would store a fact no
   * detector could read.
   */
  function record(observation: Observation): void {
    for (const id of new Set([observation.actorId, observation.subjectId])) {
      const held = [...(bySubject.get(id) ?? []), observation];
      bySubject.set(
        id,
        held.length > OBSERVATIONS_PER_SUBJECT
          ? held.slice(held.length - OBSERVATIONS_PER_SUBJECT)
          : held,
      );
    }
  }

  return {
    subscribe(source: EventSubscriber): Unsubscribe {
      return source.subscribe(REDUCTION_CLEARANCE, (event) => {
        const reduced = toObservation(event, options.now());
        if (!reduced.ok) {
          refused.push(reduced.error);
          if (refused.length > REFUSALS_RETAINED) {
            refused.shift();
          }
          return;
        }
        if (reduced.value !== null) {
          record(reduced.value);
        }
      });
    },

    observationsFor(subjectId: SubjectId): readonly Observation[] {
      return bySubject.get(subjectId) ?? [];
    },

    refusals(): readonly DomainError[] {
      return refused;
    },

    detect(subjectId: SubjectId, priorSignals: readonly Signal[]): DetectionRun {
      const at = options.now();
      const observations = bySubject.get(subjectId) ?? [];
      const signals: Signal[] = [];
      const failures: DomainError[] = [];
      for (const detector of detectors) {
        // Detectors are run one at a time against the same evidence and never
        // see each other's output, so their order cannot matter and a broken
        // one costs its own signals rather than the cycle's.
        const run = runDetector(detector, { subjectId, now: at, observations }, priorSignals);
        if (run.ok) {
          signals.push(...run.value);
        } else {
          failures.push(run.error);
        }
      }
      return { signals, failures };
    },
  };
}

