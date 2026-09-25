/**
 * `VerificationAttemptStore` against Postgres.
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
 * document. If a third column is ever added, those two are the ones to add.
 *
 * The rest are nested *by the domain*: `evidence` is a list `recordCapture`
 * rewrites wholesale, `decision` a record `completeFromProvider` produces in
 * one piece, `reason` a discriminated union the domain owns. Narrow columns
 * for those would be three places to keep in step with a type that changes as
 * one unit, and a partial column set is the shape of bug where an `UPDATE`
 * naming two of the four leaves the other two stale — which for `decision` is
 * the stored outcome of a verification and must never disagree with the state
 * in the same row. As one value it is also written atomically, and a patch
 * merges with `checks || $patch::jsonb`: no read-modify-write, so two writers
 * cannot interleave into a half-merged attempt.
 *
 * The envelope is keyed by the aggregate's own field names, which is what makes
 * an omitted field visible rather than quiet, and versioned so a reshape is
 * detectable. It is also closed — a key outside it is refused rather than
 * stored, which is what keeps a provider payload or a biometric artefact out of
 * a table with no business holding either. `provider_reference` is the one
 * handle that belongs here: an opaque identifier for the vendor's stored
 * artefacts, never the artefacts, and never a locator that resolves without the
 * access path in the domain's evidence store.
 *
 * ## The one lifecycle fact this store carries
 *
 * Which states are *closed*, because the partial unique index
 * `verification_attempts_one_open` is defined in terms of it: a row is open
 * exactly when it is not terminal, and `closed_at` is written from that. The
 * state *vocabulary* is not repeated here at all — the `CHECK` on `state` is
 * the definition, and a second list would be a second thing to keep in step
 * with it, the same argument `IdentityStore` makes about `setState`.
 */
import type { PoolClient, QueryResultRow } from 'pg';
import { StoreError } from '@been-there/contracts';
import type { Transaction, VerificationAttemptStore } from '@been-there/contracts';
import { castId } from '@been-there/core';
import type { UserId } from '@been-there/core';
import { isConflict, isRetryable } from './errors.js';
import { clientOf } from './transaction.js';

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
 *
 * `subjectId` carries the `UserId` brand though the domain calls the same fact
 * `SubjectId`, because the column is `user_id` and the port's `findOpenFor`
 * takes a `UserId`. The cast belongs here, not two names for one column.
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

/**
 * The refusals a caller has to tell apart: the user already has an open
 * attempt, or this id was used before. Both are facts about the request rather
 * than outages, so both are not retryable.
 */
export type AttemptConflictReason = 'attempt_id_taken' | 'open_attempt_exists';

export class VerificationAttemptStoreError extends StoreError {
  readonly reason: AttemptConflictReason;
  constructor(reason: AttemptConflictReason, message: string) {
    super(message, { retryable: false });
    this.name = 'VerificationAttemptStoreError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------- envelope --

/** Bumped if the envelope's shape ever changes; a mismatched read then throws. */
const ENVELOPE_VERSION = 1;
const VERSION_KEY = 'schemaVersion';

/**
 * The keys `checks` carries, named as the aggregate names them. Read and
 * written through one table of codecs, so the two directions cannot disagree
 * about which fields exist.
 */
const ENVELOPE_KEYS = [
  'updatedAt',
  'reVerification',
  'reason',
  'expiresAt',
  'submittedAt',
  'completedChecks',
  'evidence',
  'confidence',
  'decision',
  'reviewerId',
] as const;

type EnvelopeKey = (typeof ENVELOPE_KEYS)[number];

/** The decoded envelope: the aggregate minus the fields that are columns. */
type EnvelopeFields = Pick<
  AttemptRecord,
  | 'updatedAt'
  | 'reVerification'
  | 'reason'
  | 'expiresAt'
  | 'submittedAt'
  | 'completedChecks'
  | 'evidence'
  | 'confidence'
  | 'decision'
  | 'reviewerId'
>;

function isEnvelopeKey(key: string): key is EnvelopeKey {
  return ENVELOPE_KEYS.some((candidate) => candidate === key);
}

// ----------------------------------------------------------------- readers --

function fault(message: string): StoreError {
  return new StoreError(message, { retryable: false });
}

function asJsonObject(value: unknown, context: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw fault(`${context} is not a JSON object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function readText(value: unknown, context: string): string {
  if (typeof value !== 'string' || value === '') {
    throw fault(`${context} is not a non-empty string`);
  }
  return value;
}

function readBoolean(value: unknown, context: string): boolean {
  if (typeof value !== 'boolean') {
    throw fault(`${context} is not true or false`);
  }
  return value;
}

function readNumber(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw fault(`${context} is not a finite number`);
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
 * by something other than this store, and the attempt's ordering and the
 * retake cooldown would then be arithmetic on a string.
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
function readNullableText(value: unknown, context: string): string | null {
  return value === null || value === undefined ? null : readText(value, context);
}

/**
 * Why the attempt exists. Only the discriminant is checked: the union of
 * reasons is the domain's, and it grows by adding a variant this store has no
 * business knowing. A missing or non-string `code` is refused, because that
 * would make the row unreadable as a *reason* at all.
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
 * What is checked is that the shape survives the round trip.
 */
function readConfidence(value: unknown, context: string): AttemptConfidence {
  const confidence = asJsonObject(value, context);
  return {
    value: readNumber(confidence['value'], `${context}.value`),
    band: readText(confidence['band'], `${context}.band`),
  };
}

/**
 * The decision, or null. A decision with no confidence inside it is a corrupt
 * row, not an unusable one: a fabricated `{ value: 0, band: 'unusable' }` here
 * would be read as the domain's own verdict that a provider returned nothing,
 * which is the one conclusion this store must never invent.
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
 * The captured artefacts — the aggregate's `evidence` entries. This list is the
 * only place the evidence shape is written down, in both directions.
 *
 * `sensitivity` is checked as text and not against the domain's `'restricted'`
 * literal. That literal is the domain's pin, deliberately placed there so the
 * classification cannot drift per record; repeating it here would put a second
 * copy of a retention decision in the persistence layer, where nobody reviews
 * it when the policy changes.
 */
function readEvidence(value: unknown, context: string): readonly AttemptEvidence[] {
  if (!Array.isArray(value)) {
    throw fault(`${context} is not a list`);
  }
  return value.map((entry, index) => {
    const item = asJsonObject(entry, `${context}[${index}]`);
    return {
      kind: readText(item['kind'], `${context}[${index}].kind`),
      verificationId: readText(item['verificationId'], `${context}[${index}].verificationId`),
      capturedAt: readInstant(item['capturedAt'], `${context}[${index}].capturedAt`),
      storageRef: readText(item['storageRef'], `${context}[${index}].storageRef`),
      sensitivity: readText(item['sensitivity'], `${context}[${index}].sensitivity`),
      digest: readText(item['digest'], `${context}[${index}].digest`),
      expiresAt: readInstant(item['expiresAt'], `${context}[${index}].expiresAt`),
    };
  });
}

/**
 * One codec per envelope field, used for writing and for reading alike. Each
 * accepts the two forms a field legitimately arrives in — a `Date` from a
 * caller or a driver, an ISO string out of jsonb — and returns the decoded
 * form, with real `Date`s. One definition is what makes the round trip faithful
 * by construction: a field cannot be written and not read, because there is a
 * single place that knows it exists.
 */
type EnvelopeCodecs = {
  readonly [K in EnvelopeKey]: (value: unknown, context: string) => EnvelopeFields[K];
};

const ENVELOPE_CODECS: EnvelopeCodecs = {
  updatedAt: (value, context) => readInstant(value, context),
  reVerification: (value, context) => readBoolean(value, context),
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
  return {
    updatedAt: ENVELOPE_CODECS.updatedAt(source['updatedAt'], `${context}.updatedAt`),
    reVerification: ENVELOPE_CODECS.reVerification(
      source['reVerification'],
      `${context}.reVerification`,
    ),
    reason: ENVELOPE_CODECS.reason(source['reason'], `${context}.reason`),
    expiresAt: ENVELOPE_CODECS.expiresAt(source['expiresAt'], `${context}.expiresAt`),
    submittedAt: ENVELOPE_CODECS.submittedAt(source['submittedAt'], `${context}.submittedAt`),
    completedChecks: ENVELOPE_CODECS.completedChecks(
      source['completedChecks'],
      `${context}.completedChecks`,
    ),
    evidence: ENVELOPE_CODECS.evidence(source['evidence'], `${context}.evidence`),
    confidence: ENVELOPE_CODECS.confidence(source['confidence'], `${context}.confidence`),
    decision: ENVELOPE_CODECS.decision(source['decision'], `${context}.decision`),
    reviewerId: ENVELOPE_CODECS.reviewerId(source['reviewerId'], `${context}.reviewerId`),
  };
}

/** The stored document, serialised whole: a `Date` becomes an ISO string. */
function toEnvelope(fields: EnvelopeFields): string {
  return JSON.stringify({ [VERSION_KEY]: ENVELOPE_VERSION, ...fields });
}

/**
 * The inverse, and the only gate a stored document passes through.
 *
 * Three things are refused rather than guessed at: a column that is not a jsonb
 * object at all (the schema's `'[]'::jsonb` default, and any row written by
 * hand), a version this file cannot read, and a key outside the envelope. That
 * last one matters more than it looks — it is the difference between a column
 * that holds the aggregate and a column anything can be quietly stuffed into.
 */
function decodeEnvelope(value: unknown, context: string): EnvelopeFields {
  const document = asJsonObject(value, context);
  for (const key of Object.keys(document)) {
    if (key !== VERSION_KEY && !isEnvelopeKey(key)) {
      throw fault(
        `${context} carries '${key}', which is not part of the attempt envelope; this column holds the aggregate and nothing else`,
      );
    }
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

const ATTEMPT_COLUMNS =
  'attempt_id, user_id, state, checks, provider_reference, opened_at, closed_at';

/**
 * Facts fixed when the attempt is opened. A patch naming one is refused rather
 * than ignored: silently dropping `startedAt` would move an attempt out of the
 * daily-attempt window `planVerificationStart` counts, and dropping `subjectId`
 * would re-point the attempt at somebody else.
 */
const FIXED_FIELDS: readonly string[] = ['verificationId', 'subjectId', 'startedAt'];

/** Every field a caller supplies, minus the one it may omit. */
const SUPPLIED_FIELDS: readonly string[] = [...FIXED_FIELDS, 'state'];

/** Patch keys that name a column, and the column each one writes. */
const PATCH_COLUMNS: Readonly<Record<string, string>> = {
  state: 'state',
  providerReference: 'provider_reference',
};

/**
 * The states an attempt rests in: the mirror of the domain's terminal set and of
 * nothing else. This file does not decide which state an attempt moves to, only
 * which of them close it, because that is the fact the open-attempt index is
 * written in terms of.
 */
const TERMINAL_STATES = ['passed', 'failed', 'expired'] as const;

function isTerminal(state: string): boolean {
  return TERMINAL_STATES.some((terminal) => terminal === state);
}

// ---------------------------------------------------------------- plumbing --

function constraintOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const value = (error as Readonly<Record<string, unknown>>)['constraint'];
  return typeof value === 'string' ? value : null;
}

/**
 * Sends one statement and turns anything that is not already a `StoreError`
 * into one, so "the query failed" can never look like "no row". No retry here: a
 * failed statement has already poisoned the caller's transaction, so re-sending
 * it would fail for a different reason. Retrying a unit of work belongs to the
 * transaction that owns it.
 */
async function query<Row extends QueryResultRow>(
  client: PoolClient,
  text: string,
  values: readonly unknown[],
): Promise<{ rows: Row[]; rowCount: number }> {
  try {
    const result = await client.query<Row>(text, values as unknown[]);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  } catch (error) {
    if (error instanceof StoreError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : 'query failed';
    const detail = isConflict(error) ? `constraint violation: ${message}` : message;
    throw new StoreError(detail, {
      retryable: isRetryable(error),
      cause: error,
    });
  }
}

/**
 * Turns the schema's refusals into ones a caller can act on. A foreign-key
 * violation means the user does not exist, and a check violation means a state
 * outside the vocabulary — the `CHECK` is that list's definition, so it is the
 * only place that needs to enforce it. Both are `isConflict`, not an outage.
 */
function translateInsertFailure(error: unknown, record: AttemptRecord): unknown {
  if (error instanceof StoreError) {
    return error;
  }
  const constraint = constraintOf(error);
  if (constraint === 'verification_attempts_one_open') {
    return new VerificationAttemptStoreError(
      'open_attempt_exists',
      `insert: user ${record.subjectId} already has an open verification attempt`,
    );
  }
  if (constraint === 'verification_attempts_pkey') {
    return new VerificationAttemptStoreError(
      'attempt_id_taken',
      `insert: attempt ${record.verificationId} already exists`,
    );
  }
  return new StoreError(`insert: ${error instanceof Error ? error.message : 'failed'}`, {
    retryable: isRetryable(error),
    cause: error,
  });
}

/**
 * A caller's aggregate, validated whole.
 *
 * Presence is checked as well as shape: an omitted `decision` and an explicit
 * `decision: null` are different inputs, and the first is a caller that forgot
 * a field the aggregate has always had. Only `providerReference` may be absent,
 * because it is not on the aggregate — it is a fact about the provider's copy
 * of the artefacts, which the aggregate has no field for.
 */
function readAttempt(source: Readonly<Record<string, unknown>>, context: string): AttemptRecord {
  for (const key of [...SUPPLIED_FIELDS, ...ENVELOPE_KEYS]) {
    if (!(key in source)) {
      throw fault(`${context} is missing '${key}'`);
    }
  }
  for (const key of Object.keys(source)) {
    if (
      key !== 'providerReference' &&
      !SUPPLIED_FIELDS.some((supplied) => supplied === key) &&
      !isEnvelopeKey(key)
    ) {
      throw fault(
        `${context} carries '${key}', which is not a field of an attempt; this store persists the aggregate and nothing else`,
      );
    }
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

function toAttemptRecord(raw: QueryResultRow, context: string): AttemptRecord {
  const state = readText(raw['state'], `${context}.state`);
  const closedAt = readNullableInstant(raw['closed_at'], `${context}.closed_at`);
  // The row and the index have to agree about open or closed. A row that
  // disagrees is one this file did not write, and reading half of it is how the
  // stored outcome and the domain's guard start telling different stories.
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

// -------------------------------------------------------------------- store --

/**
 * `VerificationAttemptStore` on Postgres. The constructor takes nothing: a
 * store holding a pool could reach around the caller's transaction, and the
 * only defence against that is not having one.
 */
export class PgVerificationAttemptStore implements VerificationAttemptStore {
  /**
   * Opens an attempt, or refuses.
   *
   * The refusal is the interesting part. `verification_attempts_one_open` is
   * partial on `closed_at IS NULL`, so two devices starting a verification for
   * one user race for it and exactly one wins; the loser's insert fails on that
   * index and is reported as `open_attempt_exists` rather than as a generic
   * fault. A caller can then tell "you already have one open" from "this id was
   * used before" from a genuine outage, and answer the first by returning the
   * attempt the user already has.
   *
   * `closed_at` is not an input. It is derived from the state the caller wrote,
   * because the store does not get a second say in when an attempt ends while
   * the index is defined in terms of `closed_at`.
   */
  async insert(attempt: Readonly<Record<string, unknown>>, tx: Transaction): Promise<void> {
    const record = readAttempt(attempt, 'insert');
    try {
      await clientOf(tx).query(
        `INSERT INTO app.verification_attempts
           (attempt_id, user_id, state, checks, provider_reference, opened_at, closed_at)
         VALUES ($1, $2::uuid, $3, $4::jsonb, $5, $6::timestamptz, $7::timestamptz)`,
        [
          record.verificationId,
          record.subjectId,
          record.state,
          toEnvelope(envelopeFields(record, 'insert')),
          record.providerReference,
          record.startedAt,
          isTerminal(record.state) ? record.updatedAt : null,
        ],
      );
    } catch (error) {
      throw translateInsertFailure(error, record);
    }
  }

  /**
   * One attempt by id, or `null`. `null` means no such attempt and is a normal
   * answer. It never covers a corrupt row: an unreadable `checks` document, or
   * a row whose `closed_at` disagrees with its state, throws. A caller handed a
   * half-read attempt would feed it to `submitToProvider`, which re-derives the
   * decision from what it is given.
   */
  async find(attemptId: string, tx: Transaction): Promise<AttemptRecord | null> {
    const result = await query<QueryResultRow>(
      clientOf(tx),
      `SELECT ${ATTEMPT_COLUMNS} FROM app.verification_attempts WHERE attempt_id = $1`,
      [attemptId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toAttemptRecord(row, 'find');
  }

  /**
   * The user's open attempt, or `null` if they have none. The predicate is the
   * index's own, so this is a lookup rather than a scan that has to be trusted.
   * More than one row is impossible while `verification_attempts_one_open`
   * exists, and if it happens anyway — the index dropped, a migration
   * half-applied — it throws rather than picking one: which of two open
   * attempts a user "has" is not a question this store answers by coin toss.
   */
  async findOpenFor(userId: UserId, tx: Transaction): Promise<AttemptRecord | null> {
    const result = await query<QueryResultRow>(
      clientOf(tx),
      `SELECT ${ATTEMPT_COLUMNS}
         FROM app.verification_attempts
        WHERE user_id = $1 AND closed_at IS NULL`,
      [userId],
    );
    if (result.rows.length > 1) {
      throw fault(
        `findOpenFor: user ${userId} has ${result.rows.length} open attempts; verification_attempts_one_open is not doing its job`,
      );
    }
    const row = result.rows[0];
    return row === undefined ? null : toAttemptRecord(row, 'findOpenFor');
  }

  /**
   * Patches an attempt and reports whether a row was there to patch.
   *
   * Three rules, each of them something a caller would otherwise get wrong
   * silently. A patch may not move a closed attempt back to open: the `WHERE`
   * clause refuses it, so a stale client replaying a `capturing` event against
   * an attempt that has since passed cannot undo the outcome, and cannot reopen
   * the user's gate to the product either. `false` answers both "refused" and
   * "no such row"; the caller re-reads to learn which, and neither is a silent
   * success. A patch may not rewrite a fixed field — see `FIXED_FIELDS`. And an
   * unknown key is a fault, not a no-op: a typo that dropped `decision` would
   * leave the stored outcome of a verification disagreeing with the state in
   * the same row.
   *
   * Envelope keys merge with `checks || $patch::jsonb`, so patching `state`
   * leaves the evidence, decision and confidence exactly as they were and
   * patching one of them replaces only that one. The merge happens inside the
   * statement, so there is no window for a second writer to slip a value in.
   * An empty patch is legal and answers whether the attempt exists; that is
   * what `SET closed_at = closed_at` costs.
   */
  async update(
    attemptId: string,
    patch: Readonly<Record<string, unknown>>,
    tx: Transaction,
  ): Promise<boolean> {
    const assignments: string[] = [];
    const values: unknown[] = [];
    const document: Record<string, unknown> = {};
    let state: string | null = null;
    let updatedAt: Date | null = null;

    for (const key of Object.keys(patch)) {
      if (FIXED_FIELDS.some((fixed) => fixed === key)) {
        throw fault(`update: '${key}' is fixed when the attempt is opened and cannot be patched`);
      }
      if (isEnvelopeKey(key)) {
        document[key] = ENVELOPE_CODECS[key](patch[key], `update.${key}`);
        if (key === 'updatedAt') {
          // The only codec that yields a Date, and this branch is only reached
          // for that key, so the narrowed type is the real one.
          updatedAt = document['updatedAt'] as Date;
        }
        continue;
      }
      const column = PATCH_COLUMNS[key];
      if (column === undefined) {
        throw fault(
          `update: unknown patch key '${key}'; expected one of ${[...SUPPLIED_FIELDS, ...ENVELOPE_KEYS, ...Object.keys(PATCH_COLUMNS)].join(', ')}`,
        );
      }
      if (key === 'state') {
        state = readText(patch[key], `update.${key}`);
      }
      values.push(key === 'state' ? state : readNullableText(patch[key], `update.${key}`));
      // Four parameters lead — the id, the patched state, the close instant and
      // the terminal states — so an assignment's placeholder follows its value.
      assignments.push(`${column} = $${values.length + 4}`);
    }

    if (Object.keys(document).length > 0) {
      // The patch half carries no version: a merge into a stored document that
      // has one leaves it in place, and a document without a version is refused
      // on read before a merge can reach it.
      values.push(JSON.stringify(document));
      assignments.push(`checks = checks || $${values.length + 4}::jsonb`);
    }

    const patched = await query<QueryResultRow>(
      clientOf(tx),
      `UPDATE app.verification_attempts
          SET ${assignments.join(', ')},
              closed_at = CASE
                            WHEN $2::text = ANY ($4::text[])
                              THEN COALESCE(closed_at, COALESCE($3::timestamptz, now()))
                            ELSE closed_at
                          END
        WHERE attempt_id = $1
          AND NOT (closed_at IS NOT NULL
                   AND $2::text IS NOT NULL
                   AND $2::text <> ALL ($4::text[]))`,
      [attemptId, state, updatedAt, [...TERMINAL_STATES], ...values],
    );
    return patched.rowCount === 1;
  }
}
