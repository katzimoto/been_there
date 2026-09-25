import type { SubjectId } from '@been-there/core';
import { type BehaviourKey, type Signal, sameBehaviour } from './signal.js';
import { addHours } from './time.js';

/** How recent a repeat of the *same* behaviour must be to count as repetition. */
export const REPEAT_WINDOW_HOURS = 24;

/** How long a detector's past output keeps corroborating new evidence. */
export const CORROBORATION_WINDOW_HOURS = 168;

/**
 * Distinct accounts reporting against the same target, inside the
 * corroboration window, at which point the reports stop being evidence about
 * the target and start being evidence about the reporters.
 */
export const MASS_REPORT_CLUSTER_SIZE = 3;

/** Bounded retention of raw signals. Retention period is an open question. */
export const SIGNAL_LEDGER_CAPACITY = 256;

export interface SignalLedger {
  readonly entries: readonly Signal[];
}

export const EMPTY_LEDGER: SignalLedger = { entries: [] };

function compareSignals(a: Signal, b: Signal): number {
  return (
    a.occurredAt.getTime() - b.occurredAt.getTime() ||
    a.detector.localeCompare(b.detector) ||
    a.subjectId.localeCompare(b.subjectId)
  );
}

/**
 * Appends a signal, keeping the ledger bounded and time-ordered.
 *
 * Late-arriving signals are inserted in time order rather than appended, so a
 * replayed backlog cannot make old evidence look new, and the oldest evidence is
 * dropped rather than the newest.
 */
export function appendSignal(ledger: SignalLedger, signal: Signal): SignalLedger {
  const entries = [...ledger.entries, signal].sort(compareSignals);
  return { entries: entries.slice(Math.max(0, entries.length - SIGNAL_LEDGER_CAPACITY)) };
}

/** A coordinated attack on one account, seen from the reporters' side. */
export interface MassReportCluster {
  readonly key: BehaviourKey;
  /** The account being reported at. Its risk is *not* raised by this cluster. */
  readonly targetId: SubjectId;
  /** Distinct accounts that reported, sorted. The thing actually worth a look. */
  readonly reporters: readonly SubjectId[];
}

export interface Corroboration {
  /** Distinct detectors that have spoken about this subject in the window. */
  readonly detectors: readonly string[];
  /** `detectors.length`. The number the shared `riskMachine` corroboration guard reads. */
  readonly independentDetectors: number;
  /** Prior signals from this same detector about this same behaviour. */
  readonly repetitions: number;
  /** Non-null only when this signal is part of a coordinated reporting campaign. */
  readonly massReport: MassReportCluster | null;
}

/**
 * Two detectors corroborate each other when they have independently said
 * something about the same subject inside the window. Neither knows the other
 * exists; the only thing compared is the subject and the clock.
 */
function corroboratingDetectors(recent: readonly Signal[], subjectId: SubjectId, incoming: Signal): string[] {
  const names = new Set<string>([incoming.detector]);
  for (const entry of recent) {
    if (entry.subjectId === subjectId) {
      names.add(entry.detector);
    }
  }
  return [...names].sort();
}

/**
 * Repetition is deliberately *not* corroboration: it only counts signals from
 * the same detector about the same behaviour, and it is capped as a multiplier
 * in the policy layer. A detector that spams itself buys a slightly higher
 * score and nothing else — it can never supply the second independent detector
 * that `critical` requires.
 */
function countRepetitions(recent: readonly Signal[], incoming: Signal): number {
  return recent.filter(
    (entry) =>
      entry.detector === incoming.detector &&
      entry.subjectId === incoming.subjectId &&
      sameBehaviour(entry.behaviour, incoming.behaviour),
  ).length;
}

/**
 * Detects a retaliatory mass-reporting campaign against one account.
 *
 * Only `report_against` signals participate: that is the one behaviour kind that
 * describes something done *to* a subject, so it is the only one where the
 * target and the actor can be confused. Any other kind keyed on a shared entity
 * (a busy conversation, say) must not turn ordinary popularity into an "attack".
 */
function detectMassReport(recent: readonly Signal[], incoming: Signal): MassReportCluster | null {
  if (incoming.behaviour.kind !== 'report_against') {
    return null;
  }
  const reports = [
    ...recent.filter((entry) => sameBehaviour(entry.behaviour, incoming.behaviour)),
    incoming,
  ];
  const reporters = new Set(reports.map((report) => report.actorId));
  if (reporters.size < MASS_REPORT_CLUSTER_SIZE) {
    return null;
  }
  return {
    key: incoming.behaviour,
    targetId: incoming.subjectId,
    reporters: [...reporters].sort(),
  };
}

/**
 * The whole combination rule, in one pure function: given the recent ledger and
 * an incoming signal, how much independent support does this evidence have?
 */
export function corroborate(ledger: SignalLedger, incoming: Signal): Corroboration {
  const at = incoming.occurredAt.getTime();
  const windowStart = addHours(incoming.occurredAt, -CORROBORATION_WINDOW_HOURS).getTime();
  const recent = ledger.entries.filter((entry) => {
    const occurred = entry.occurredAt.getTime();
    return occurred >= windowStart && occurred <= at;
  });
  const detectors = corroboratingDetectors(recent, incoming.subjectId, incoming);
  return {
    detectors,
    independentDetectors: detectors.length,
    repetitions: countRepetitions(recent, incoming),
    massReport: detectMassReport(recent, incoming),
  };
}
