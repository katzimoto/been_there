/**
 * The schema codecs for the verification attempt store: what an attempt is
 * called in the database, what it is called in the domain, and what happens
 * when one of them turns out not to be there.
 *
 * Split out of `store-verification-attempts.ts` so that file holds the port and
 * its SQL and this one holds the translation, which is the part that changes
 * when the schema does. Nothing else imports it: the row shapes belong to the
 * attempt store and to no other.
 *
 * ## Where the non-tabular half of the aggregate lives
 *
 * The domain's `VerificationAttempt` is fifteen fields; the table has seven
 * columns. The other ten — `updatedAt`, `expiresAt`, `submittedAt`,
 * `reVerification`, `reason`, `completedChecks`, `evidence`, `confidence`,
 * `decision`, `reviewerId` — go in the one `jsonb` column the schema already
 * has, `checks`, under a versioned envelope. Widening the table is the
 * alternative, and for two of them it is the better answer: `expires_at` and
 * `updated_at` are plain instants, and the sweeper that expires stale attempts
 * wants `WHERE expires_at < now()` against an index, not a filter over a jsonb
 * document. If a third column is ever added, those two are the ones to add, and
 * this file would then read them from the column and keep the rest here.
 *
 * The rest are nested *by the domain*: `evidence` is a list `recordCapture`
 * rewrites wholesale, `decision` a record `completeFromProvider` produces in
 * one piece, `reason` a discriminated union the domain owns. Narrow columns for
 * those would be three places to keep in step with a type that changes as one
 * unit, and a partial column set is the shape of bug where an `UPDATE` naming
 * two of the four leaves the other two stale — which for `decision` is the
 * stored outcome of a verification and must never disagree with the state in
 * the same row. As one value it is also written atomically, and a patch merges
 * with `checks || $patch::jsonb`: no read-modify-write, so two writers cannot
 * interleave into a half-merged attempt.
 *
 * The envelope is keyed by the aggregate's own field names, which is what makes
 * an omitted field visible rather than quiet, and versioned so a reshape is
 * detectable. It is also closed — a key outside it is refused rather than
 * stored, which is what keeps a provider payload or a biometric artefact out of
 * a table with no business holding either.
 *
 * A wrong shape is a `StoreError`, because a lossy read is how the domain's
 * guard and the stored record come to disagree: `submitToProvider` re-derives
 * its decision from the attempt it is handed, so a field that quietly did not
 * survive the round trip is a field the policy no longer sees.
 */
import type { QueryResultRow } from 'pg';
import { StoreError } from '@been-there/contracts';
import { castId, type UserId } from '@been-there/core';

// ------------------------------------------------------------------ shapes --

/** A confidence reading as the attempt carries it. */
export type AttemptConfidence = {
  readonly value: number;
  readonly band: string;
};

/** The decision the domain produced, as the attempt carries it. */
export type AttemptDecision = {
  readonly decision: string;
  readonly confidence: AttemptConfidence;
  readonly rationale: readonly string[];
  readonly missingChecks: readonly string[];
};

/**
 * One captured artefact. `storageRef` is a locator and `digest` an integrity
 * check: neither is the artefact, and nothing here could rebuild an image.
 */
export type AttemptEvidence = {
  readonly kind: string;
  readonly verificationId: string;
  readonly capturedAt: Date;
  readonly storageRef: string;
  readonly sensitivity: string;
  readonly digest: string;
  readonly expiresAt: Date;
};

/**
 * A whole attempt, in the aggregate's own terms: field names match the domain's
 * `VerificationAttempt` one for one, so a read goes straight to `recordCapture`
 * or `submitToProvider` and a write needs no translation table in the service.
 * `subjectId` carries the `UserId` brand though the domain calls the same fact
 * `SubjectId`, because the column is `user_id` and the port's `findOpenFor`
 * takes a `UserId`.
 */
export type AttemptRecord = {
  readonly verificationId: string;
  readonly subjectId: UserId;
  readonly state: string;
  readonly startedAt: Date;
  readonly providerReference: string | null;
  readonly updatedAt: Date;
  readonly reVerification: boolean;
  readonly reason: Readonly<Record<string, unknown>>;
  readonly expiresAt: Date;
  readonly submittedAt: Date | null;
  readonly completedChecks: readonly string[];
  readonly evidence: readonly AttemptEvidence[];
  readonly confidence: AttemptConfidence | null;
  readonly decision: AttemptDecision | null;
  readonly reviewerId: string | null;
};

export function fault(message: string): StoreError {
  return new StoreError(message, { retryable: false });
}

// ----------------------------------------------------------------- readers --

function asJsonObject(value: unknown, context: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw fault(`${context} is not a JSON object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

export function readText(value: unknown, context: string): string {
  if (typeof value !== 'string' || value === '') {
    throw fault(`${context} is not a non-empty string`);
  }
  return value;
}

function readStringList(value: unknown, context: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw fault(`${context} is not a list`);
  }
  return value.map((entry, index) => readText(entry, `${context}[${index}]`));
}

/**
 * A `timestamptz` off the driver, or an instant out of the jsonb envelope.
 * Anything else means the driver was reconfigured or the document was written
 * by something else, and the attempt's ordering and the retake cooldown would
 * then be arithmetic on a string.
 */
function readInstant(value: unknown, context: string): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  throw fault(`${context} is not a timestamp`);
}

function readNullableInstant(value: unknown, context: string): Date | null {
  return value === null || value === undefined ? null : readInstant(value, context);
}

/** Absent and null are one fact here: no provider reference has been given. */
export function readNullableText(value: unknown, context: string): string | null {
  return value === null || value === undefined ? null : readText(value, context);
}

/**
 * Why the attempt exists. Only the discriminant is checked: the union of reasons
 * is the domain's, and it grows by adding a variant this store has no business
 * knowing. A missing or non-string `code` is refused, because that would make
 * the row unreadable as a *reason* at all.
 */
function readReason(value: unknown, context: string): Readonly<Record<string, unknown>> {
  const reason = asJsonObject(value, context);
  readText(reason['code'], `${context}.code`);
  return reason;
}

/**
 * A confidence reading. The `0..1` bound is deliberately not re-checked: it is
 * the domain's `makeConfidence` invariant, and a second copy here would be a
 * second rule that could disagree about whether a provider's answer is usable.
 */
function readConfidence(value: unknown, context: string): AttemptConfidence {
  const confidence = asJsonObject(value, context);
  const value_ = confidence['value'];
  if (typeof value_ !== 'number' || !Number.isFinite(value_)) {
    throw fault(`${context}.value is not a finite number`);
  }
  return { value: value_, band: readText(confidence['band'], `${context}.band`) };
}

/**
 * The decision, or null. A decision with no confidence inside it is a corrupt
 * row, not an unusable one: a fabricated `{ value: 0, band: 'unusable' }` here
 * would read as the domain's own verdict that a provider returned nothing, which
 * is the one conclusion this store must never invent.
 */
function readDecision(value: unknown, context: string): AttemptDecision | null {
  if (value === null || value === undefined) {
    return null;
  }
  const decision = asJsonObject(value, context);
  return {
    decision: readText(decision['decision'], `${context}.decision`),
    confidence: readConfidence(decision['confidence'], `${context}.confidence`),
    rationale: readStringList(decision['rationale'], `${context}.rationale`),
    missingChecks: readStringList(decision['missingChecks'], `${context}.missingChecks`),
  };
}

/**
 * The captured artefacts — the aggregate's `evidence` entries. This is the only
 * place the evidence shape is written down, in both directions. `sensitivity` is
 * checked as text and not against the domain's `'restricted'` literal: that
 * literal is the domain's pin, deliberately placed there so the classification
 * cannot drift per record, and a second copy of a retention decision in the
 * persistence layer is one nobody reviews when the policy changes.
 */
function readEvidence(value: unknown, context: string): readonly AttemptEvidence[] {
  if (!Array.isArray(value)) {
    throw fault(`${context} is not a list`);
  }
  return value.map((entry, index) => {
    const item = asJsonObject(entry, `${context}[${index}]`);
    const at = `${context}[${index}].`;
    return {
      kind: readText(item['kind'], `${at}kind`),
      verificationId: readText(item['verificationId'], `${at}verificationId`),
      capturedAt: readInstant(item['capturedAt'], `${at}capturedAt`),
      storageRef: readText(item['storageRef'], `${at}storageRef`),
      sensitivity: readText(item['sensitivity'], `${at}sensitivity`),
      digest: readText(item['digest'], `${at}digest`),
      expiresAt: readInstant(item['expiresAt'], `${at}expiresAt`),
    };
  });
}

// ---------------------------------------------------------------- envelope --

/** Bumped if the envelope's shape ever changes; a mismatched read then throws. */
const ENVELOPE_VERSION = 1;
const VERSION_KEY = 'schemaVersion';

/**
 * The keys `checks` carries, named as the aggregate names them. This list, the
 * codec table below and the envelope's type all derive from it, so a field
 * cannot be written and not read: the round trip is faithful by construction
 * rather than by two enumerations happening to agree.
 */
const ENVELOPE_KEYS = [
  'updatedAt', 'reVerification', 'reason', 'expiresAt', 'submittedAt',
  'completedChecks', 'evidence', 'confidence', 'decision', 'reviewerId',
] as const;

type EnvelopeKey = (typeof ENVELOPE_KEYS)[number];

/** The aggregate minus the five fields that are columns. */
type EnvelopeFields = Pick<AttemptRecord, EnvelopeKey>;

export function isEnvelopeKey(key: string): key is EnvelopeKey {
  return ENVELOPE_KEYS.some((candidate) => candidate === key);
}

/**
 * One codec per envelope field, used for writing and for reading alike. Each
 * accepts the two forms a field legitimately arrives in — a `Date` from a caller
 * or a driver, an ISO string out of jsonb — and returns the decoded form, with
 * real `Date`s. One definition is what makes a round trip faithful by
 * construction: a field cannot be written and not read, because there is a
 * single place that knows it exists.
 */
type EnvelopeCodecs = {
  readonly [K in EnvelopeKey]: (value: unknown, context: string) => EnvelopeFields[K];
};

export const ENVELOPE_CODECS: EnvelopeCodecs = {
  updatedAt: (value, context) => readInstant(value, context),
  reVerification: (value, context) => {
    if (typeof value !== 'boolean') {
      throw fault(`${context} is not true or false`);
    }
    return value;
  },
  reason: (value, context) => readReason(value, context),
  expiresAt: (value, context) => readInstant(value, context),
  submittedAt: (value, context) => readNullableInstant(value, context),
  completedChecks: (value, context) => readStringList(value, context),
  evidence: (value, context) => readEvidence(value, context),
  confidence: (value, context) =>
    value === null || value === undefined ? null : readConfidence(value, context),
  decision: (value, context) => readDecision(value, context),
  reviewerId: (value, context) => readNullableText(value, context),
};

function envelopeFields(
  source: Readonly<Record<string, unknown>>,
  context: string,
): EnvelopeFields {
  const decoded: Record<string, unknown> = {};
  for (const key of ENVELOPE_KEYS) {
    decoded[key] = ENVELOPE_CODECS[key](source[key], `${context}.${key}`);
  }
  // Safe by the loop: it writes every key of `ENVELOPE_KEYS`, and the codec
  // table and `EnvelopeFields` are both derived from that same list.
  return decoded as EnvelopeFields;
}

/** The stored document, serialised whole: a `Date` becomes an ISO string. */
export function toEnvelope(record: AttemptRecord): string {
  const document: Record<string, unknown> = { [VERSION_KEY]: ENVELOPE_VERSION };
  for (const key of ENVELOPE_KEYS) {
    document[key] = record[key];
  }
  return JSON.stringify(document);
}

/**
 * The patch half of the document. It carries no version: a merge into a stored
 * document that has one leaves that version in place, and a document without a
 * version is refused on read before a merge can reach it.
 */
export function toEnvelopePatch(document: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(document);
}

/**
 * The inverse, and the only gate a stored document passes through.
 *
 * Three things are refused rather than guessed at: a column that is not a jsonb
 * object at all (the schema's `'[]'::jsonb` default, and any row written by
 * hand), a version this file cannot read, and a key outside the envelope. That
 * last one is the difference between a column that holds the aggregate and a
 * column anything can be quietly stuffed into.
 */
function decodeEnvelope(value: unknown, context: string): EnvelopeFields {
  const document = asJsonObject(value, context);
  const stray = Object.keys(document).filter(
    (key) => key !== VERSION_KEY && !isEnvelopeKey(key),
  );
  if (stray.length > 0) {
    throw fault(`${context} carries ${stray.join(', ')}, which are not part of the attempt envelope`);
  }
  for (const key of ENVELOPE_KEYS) {
    if (!(key in document)) {
      throw fault(`${context} is missing '${key}', so the aggregate is incomplete`);
    }
  }
  const version = document[VERSION_KEY];
  if (version !== ENVELOPE_VERSION) {
    throw fault(
      `${context} has envelope version ${String(version)}; this build reads ${ENVELOPE_VERSION}`,
    );
  }
  return envelopeFields(document, context);
}

// ----------------------------------------------------------------- columns --

export const ATTEMPT_COLUMNS =
  'attempt_id, user_id, state, checks, provider_reference, opened_at, closed_at';

/**
 * Facts fixed when the attempt is opened. A patch naming one is refused rather
 * than ignored: silently dropping `startedAt` would move an attempt out of the
 * daily-attempt window `planVerificationStart` counts, and dropping `subjectId`
 * would re-point the attempt at somebody else.
 */
export const FIXED_FIELDS: Readonly<Record<string, true>> = {
  verificationId: true, subjectId: true, startedAt: true,
};

/** Every field a caller must supply. `providerReference` is the one it may omit. */
export const SUPPLIED_FIELDS: Readonly<Record<string, true>> = {
  ...FIXED_FIELDS,
  state: true,
  ...Object.fromEntries(ENVELOPE_KEYS.map((key) => [key, true])),
};

/** Patch keys that name a column, and the column each one writes. */
export const PATCH_COLUMNS: Readonly<Record<string, string>> = {
  state: 'state',
  providerReference: 'provider_reference',
};

/**
 * The states an attempt rests in: the mirror of the domain's terminal set, and of
 * nothing else. Nothing here decides which state an attempt moves to, only which
 * of them close it, because that is the fact `verification_attempts_one_open` is
 * written in terms of. The state *vocabulary* is not repeated in this file at
 * all: the `CHECK` on `state` is the definition, and a second list would be a
 * second thing to keep in step with it.
 */
export const TERMINAL_STATES = ['passed', 'failed', 'expired'] as const;

export function isTerminal(state: string): boolean {
  return TERMINAL_STATES.some((terminal) => terminal === state);
}

// ------------------------------------------------------------- the two ends --

/**
 * A caller's aggregate, validated whole.
 *
 * Presence is checked as well as shape: an omitted `decision` and an explicit
 * `decision: null` are different inputs, and the first is a caller that forgot
 * a field the aggregate has always had.
 */
export function readAttempt(
  source: Readonly<Record<string, unknown>>,
  context: string,
): AttemptRecord {
  for (const key of Object.keys(SUPPLIED_FIELDS)) {
    if (!(key in source)) {
      throw fault(`${context} is missing '${key}'`);
    }
  }
  const stray = Object.keys(source).filter(
    (key) => key !== 'providerReference' && SUPPLIED_FIELDS[key] !== true,
  );
  if (stray.length > 0) {
    throw fault(`${context} carries ${stray.join(', ')}, which are not fields of an attempt`);
  }
  return {
    verificationId: readText(source['verificationId'], `${context}.verificationId`),
    subjectId: castId<'UserId'>(readText(source['subjectId'], `${context}.subjectId`)),
    state: readText(source['state'], `${context}.state`),
    startedAt: readInstant(source['startedAt'], `${context}.startedAt`),
    providerReference: readNullableText(
      source['providerReference'],
      `${context}.providerReference`,
    ),
    ...envelopeFields(source, context),
  };
}

export function toAttemptRecord(raw: QueryResultRow, context: string): AttemptRecord {
  const state = readText(raw['state'], `${context}.state`);
  const closedAt = readNullableInstant(raw['closed_at'], `${context}.closed_at`);
  // The row and the index have to agree about open or closed. A row that
  // disagrees is one this store did not write, and reading half of it is how
  // the stored outcome and the domain's guard start telling different stories.
  if ((closedAt === null) === isTerminal(state)) {
    throw fault(
      `${context} is inconsistent: state '${state}' with ${closedAt === null ? 'no' : 'a'} closed_at`,
    );
  }
  return {
    verificationId: readText(raw['attempt_id'], `${context}.attempt_id`),
    subjectId: castId<'UserId'>(readText(raw['user_id'], `${context}.user_id`)),
    state,
    startedAt: readInstant(raw['opened_at'], `${context}.opened_at`),
    providerReference: readNullableText(
      raw['provider_reference'],
      `${context}.provider_reference`,
    ),
    ...decodeEnvelope(raw['checks'], `${context}.checks`),
  };
}
