import { type DomainError, type Err, type Result, type SubjectId, domainError, ok } from '@been-there/core';

/** Every `DomainError` this domain raises carries this name. */
export const TRUST_SAFETY_DOMAIN = 'trust-safety';

/**
 * How much a detector is trusted *a priori*, before any evidence is seen.
 *
 * Reliability discounts the score in the policy layer; a `low` detector can
 * still accumulate risk over time, it just cannot do it in one observation.
 */
export type DetectorReliability = 'low' | 'medium' | 'high';

/** What kind of behaviour the signal describes. Used for friction selection. */
export type SignalCategory =
  | 'velocity'
  | 'interaction'
  | 'identity'
  | 'network'
  | 'report_pattern';

export const BEHAVIOUR_KINDS = [
  'unmatch_then_report',
  'unmatch_by_counterparty',
  'report_against',
  'message_velocity',
  'like_velocity',
  'identity_reuse',
  'device_cluster',
  'profile_churn',
  'external_link_sharing',
] as const;

export type BehaviourKind = (typeof BEHAVIOUR_KINDS)[number];

/**
 * Identity of the *behaviour*, independent of who observed it. Two detectors
 * that see the same thing — the same account unmatching and then reporting the
 * same match — produce the same key, which is how corroboration is detected
 * without either detector knowing the other exists.
 *
 * `entityId` is always an opaque platform id (a match, a conversation, a target
 * subject). Never message text, a name, or a coordinate.
 */
export interface BehaviourKey {
  readonly kind: BehaviourKind;
  readonly entityId: string;
}

/**
 * The closed vocabulary of facts a signal may carry.
 *
 * Every field is derived metadata: a count, a window, a coarse cluster label.
 * The list is closed on purpose — a detector cannot attach a message body, a
 * photo, an exact location or a name to a signal even by accident, because the
 * field does not exist. This is commitments 5 and 7 of the overview applied at
 * the type level rather than in a redaction layer.
 */
export interface SignalFacts {
  /** How many times the pattern was seen inside the detector's window. */
  readonly occurrences?: number;
  /** Width of the observation window the detector looked at, in minutes. */
  readonly windowMinutes?: number;
  /** How many distinct counterparties the pattern touched. */
  readonly distinctCounterparties?: number;
  /** Coarse cluster label. Never a raw device id or IP. */
  readonly cluster?: 'device' | 'ip_prefix' | 'none';
  /** Whether the subject performed the behaviour or received it. */
  readonly direction?: 'outbound' | 'inbound';
  /** Set by pacing analysis; dampens bot inference when a human reads at human speed. */
  readonly humanPaced?: boolean;
}

/**
 * Runtime bound per fact. `satisfies` over `Required<SignalFacts>` is the
 * compile-time half of the closed vocabulary: adding a field to `SignalFacts`
 * without adding a bound here fails the build.
 */
const FACT_VALIDATORS = {
  occurrences: (value: number) => Number.isInteger(value) && value >= 1 && value <= 1_000,
  windowMinutes: (value: number) => Number.isInteger(value) && value > 0 && value <= 10_080,
  distinctCounterparties: (value: number) =>
    Number.isInteger(value) && value >= 0 && value <= 10_000,
  cluster: (value: 'device' | 'ip_prefix' | 'none') =>
    value === 'device' || value === 'ip_prefix' || value === 'none',
  direction: (value: 'outbound' | 'inbound') => value === 'outbound' || value === 'inbound',
  humanPaced: (value: boolean) => value === true || value === false,
} satisfies { [K in keyof Required<SignalFacts>]: (value: Required<SignalFacts>[K]) => boolean };

const FACT_KEYS = Object.keys(FACT_VALIDATORS) as readonly (keyof SignalFacts)[];

/**
 * The keys a signal is allowed to carry, exported so the review queue can show
 * a moderator *what* was observed rather than an opaque score.
 */
export const SIGNAL_FACT_KEYS = FACT_KEYS;

function validateFacts(facts: SignalFacts): Err<DomainError> | null {
  for (const [key, value] of Object.entries(facts)) {
    const validate = FACT_VALIDATORS[key as keyof typeof FACT_VALIDATORS];
    if (validate === undefined) {
      return domainError('validation_failed', TRUST_SAFETY_DOMAIN, `signal fact '${key}' is not part of the signal vocabulary`, { field: key });
    }
    if (value === undefined || !(validate as (raw: unknown) => boolean)(value)) {
      return domainError('validation_failed', TRUST_SAFETY_DOMAIN, `signal fact '${key}' is out of range`, { field: key });
    }
  }
  return null;
}

/**
 * Who is speaking. A `Detector` is a `SignalAuthor` plus the ability to observe;
 * nothing else may mint signals, so every signal in the system is traceable to
 * exactly one named, versioned detector.
 */
export interface SignalAuthor {
  readonly detector: string;
  readonly reliability: DetectorReliability;
  readonly category: SignalCategory;
}

/**
 * A single piece of risk evidence.
 *
 * A signal is *not* a claim about a person. It is a claim about a behaviour,
 * made by one named detector, at one time, with a bounded weight. Nothing in
 * the type can express an enforcement decision, which is the structural reason
 * detection can be fully automated (see `docs/architecture/trust-safety.md`).
 */
export interface Signal {
  readonly detector: string;
  readonly reliability: DetectorReliability;
  readonly category: SignalCategory;
  /** The account whose risk may move because of this signal. */
  readonly subjectId: SubjectId;
  /** Whose behaviour it is. Equal to `subjectId` except for `report_against`. */
  readonly actorId: SubjectId;
  readonly behaviour: BehaviourKey;
  readonly occurredAt: Date;
  /** Bounded 0 < weight <= 1. Never a probability of guilt. */
  readonly weight: number;
  readonly facts: SignalFacts;
}

/** What a detector authors. The name, reliability and category come from the port. */
export interface SignalInput {
  readonly subjectId: SubjectId;
  readonly actorId: SubjectId;
  readonly behaviour: BehaviourKey;
  readonly occurredAt: Date;
  readonly weight: number;
  readonly facts?: SignalFacts;
}

const DETECTOR_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

/**
 * Attribution rule. `report_against` is the only kind where somebody *else*
 * performed the behaviour, because it is the only kind that describes an attack
 * *on* a subject rather than a behaviour *by* one. Every other kind must be
 * self-attributed, so a detector cannot quietly shift the risk of a mass
 * reporting campaign onto its victim.
 */
function attributionIsValid(kind: BehaviourKind, subjectId: SubjectId, actorId: SubjectId): boolean {
  return kind === 'report_against' ? actorId !== subjectId : actorId === subjectId;
}

/**
 * The only constructor. Bounded weight, closed fact vocabulary, correct
 * attribution and a named author are all checked here, so a malformed signal
 * cannot reach the policy layer even from a JavaScript caller.
 */
export function createSignal(input: SignalInput, author: SignalAuthor): Result<Signal, DomainError> {
  if (!DETECTOR_NAME.test(author.detector)) {
    return domainError('validation_failed', TRUST_SAFETY_DOMAIN, 'detector name must be a dotted lower_snake_case identifier', {
      detector: author.detector,
    });
  }
  if (!Number.isFinite(input.weight) || input.weight <= 0 || input.weight > 1) {
    return domainError('validation_failed', TRUST_SAFETY_DOMAIN, 'signal weight must be greater than 0 and at most 1', {
      detector: author.detector,
    });
  }
  if (Number.isNaN(input.occurredAt.getTime())) {
    return domainError('validation_failed', TRUST_SAFETY_DOMAIN, 'signal occurredAt is not a valid date', {
      detector: author.detector,
    });
  }
  if (input.behaviour.entityId.length === 0) {
    return domainError('validation_failed', TRUST_SAFETY_DOMAIN, 'behaviour key needs an entity id', {
      detector: author.detector,
    });
  }
  if (!attributionIsValid(input.behaviour.kind, input.subjectId, input.actorId)) {
    return domainError('validation_failed', TRUST_SAFETY_DOMAIN, 'signal attribution does not match its behaviour kind', {
      detector: author.detector,
      kind: input.behaviour.kind,
    });
  }
  const facts = input.facts ?? {};
  const factError = validateFacts(facts);
  if (factError !== null) {
    return factError;
  }
  return ok({
    detector: author.detector,
    reliability: author.reliability,
    category: author.category,
    subjectId: input.subjectId,
    actorId: input.actorId,
    behaviour: input.behaviour,
    occurredAt: input.occurredAt,
    weight: input.weight,
    facts,
  });
}

/**
 * Two signals corroborate each other when they describe the same behaviour of
 * the same subject. Equality of the key is the whole rule — detectors never
 * reference each other, and neither knows the other exists.
 */
export function sameBehaviour(a: BehaviourKey, b: BehaviourKey): boolean {
  return a.kind === b.kind && a.entityId === b.entityId;
}
