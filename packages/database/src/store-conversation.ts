/**
 * `ConversationStore` against Postgres.
 *
 * Three properties of this store are the reason it is written the way it is.
 *
 * **It never opens a transaction.** Every method takes the caller's `tx` and
 * issues its statements on the client that transaction is holding, so a like,
 * the match it creates and the events it emits share one unit of work. A store
 * that quietly issued statements on a pooled connection would look identical in
 * the types and would be exactly the half-succeeded request ADR 0001 exists to
 * prevent, so a `tx` that does not expose its client is a loud `StoreError`
 * rather than a fallback to the pool.
 *
 * **`appendMessage` collapses a replay.** Delivery is at-least-once on the
 * wire, so the same `messageId` can arrive twice. The unique index on
 * `message_id` is the arbiter and the store turns a collision into
 * `{created: false}`; a duplicate is a fact the service handles, not a fault.
 *
 * **Reads are scoped to a participant.** `find` and `findMessages` take the
 * reader and check participation in SQL. A caller that guesses a conversation
 * id gets `null` — the same answer as an id that does not exist, so the read is
 * not an existence oracle either.
 */
import type { QueryResultRow } from 'pg';
import { StoreError } from '@been-there/contracts';
import type { ConversationRow, MessageRow, Page, PageResult, Transaction } from '@been-there/contracts';
import { castId } from '@been-there/core';
import type { ConversationId, MatchId, MessageId, UserId } from '@been-there/core';
import { isRetryable } from './errors.js';
import { clientOf } from './transaction.js';

/** Why a conversation could not be created. A conflict, distinct from a fault. */
export type ConversationConflict =
  | 'conversation_id_taken'
  | 'match_already_has_conversation'
  | 'match_does_not_exist';

export class ConversationConflictError extends StoreError {
  readonly reason: ConversationConflict;

  constructor(reason: ConversationConflict, cause: unknown) {
    super(conflictMessage(reason), { retryable: false, cause });
    this.name = 'ConversationConflictError';
    this.reason = reason;
  }
}

function conflictMessage(reason: ConversationConflict): string {
  switch (reason) {
    case 'conversation_id_taken':
      return 'conversation id is already in use by another conversation';
    case 'match_already_has_conversation':
      return 'this match already has a conversation; one match opens exactly one conversation';
    case 'match_does_not_exist':
      return 'no such match, so there is nothing to open a conversation for';
  }
}

const MIN_BODY = 1;
const MAX_BODY = 4000;

/**
 * A body the schema will refuse. It is a validation failure the caller can act
 * on — a message that was never sent — and it must not be reported as an
 * outage, so it never arrives as a retryable `StoreError` from a CHECK.
 */
export class InvalidMessageBodyError extends StoreError {
  readonly length: number;

  constructor(length: number) {
    super(`message body must be ${MIN_BODY} to ${MAX_BODY} characters; received ${length}`, {
      retryable: false,
    });
    this.name = 'InvalidMessageBodyError';
    this.length = length;
  }
}

/**
 * The CHECK counts characters, not bytes and not UTF-16 code units, so a body
 * of emoji is measured the way Postgres measures it rather than the way
 * `String.length` would measure it.
 */
function bodyLength(body: string): number {
  return Array.from(body).length;
}

function pgField(error: unknown, field: 'code' | 'constraint'): string | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const value: unknown = (error as Readonly<Record<string, unknown>>)[field];
  return typeof value === 'string' ? value : null;
}

function malformed(column: string, detail: string): StoreError {
  return new StoreError(`app row is not readable: ${column} ${detail}`, { retryable: false });
}

function readString(value: unknown, column: string): string {
  if (typeof value !== 'string') {
    throw malformed(column, `is ${value === null ? 'null' : typeof value}, expected text`);
  }
  return value;
}

function readTimestamp(value: unknown, column: string): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  throw malformed(column, `is ${value === null ? 'null' : typeof value}, expected a timestamp`);
}

function readParticipants(value: unknown, column: string): readonly [UserId, UserId] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw malformed(column, 'is not a two-element array of user ids');
  }
  const [first, second] = value;
  if (typeof first !== 'string' || typeof second !== 'string') {
    throw malformed(column, 'contains a value that is not a user id');
  }
  return [castId<'UserId'>(first), castId<'UserId'>(second)];
}

function toConversationRow(raw: QueryResultRow): ConversationRow {
  return {
    conversationId: castId<'ConversationId'>(readString(raw['conversation_id'], 'conversation_id')),
    matchId: castId<'MatchId'>(readString(raw['match_id'], 'match_id')),
    participants: readParticipants(raw['participants'], 'participants'),
    state: readString(raw['state'], 'state'),
    openedAt: readTimestamp(raw['opened_at'], 'opened_at'),
    lastMessageAt:
      raw['last_message_at'] === null || raw['last_message_at'] === undefined
        ? null
        : readTimestamp(raw['last_message_at'], 'last_message_at'),
  };
}

function toMessageRow(raw: QueryResultRow): MessageRow {
  return {
    messageId: castId<'MessageId'>(readString(raw['message_id'], 'message_id')),
    conversationId: castId<'ConversationId'>(readString(raw['conversation_id'], 'conversation_id')),
    senderId: castId<'UserId'>(readString(raw['sender_id'], 'sender_id')),
    body: readString(raw['body'], 'body'),
    createdAt: readTimestamp(raw['created_at'], 'created_at'),
  };
}

/**
 * The page bounds as Postgres will accept them. A negative offset is a
 * syntax-level error rather than an empty page, and an empty page would be a
 * lie about a caller's arithmetic.
 */
function readPage(page: Page): { readonly limit: number; readonly offset: number } {
  const { limit, offset } = page;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new StoreError(`page limit must be a positive integer; received ${String(limit)}`, { retryable: false });
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new StoreError(`page offset must be a non-negative integer; received ${String(offset)}`, { retryable: false });
  }
  return { limit, offset };
}

/**
 * Any fault that is not a business outcome becomes a `StoreError`, tagged with
 * whether retrying could help. Retrying is deliberately *not* done here: the
 * statements run inside a transaction the caller opened, and a failed statement
 * has already aborted it, so a second attempt on the same client would fail
 * with "current transaction is aborted". The caller retries the whole unit of
 * work, which is the only retry that is actually safe.
 */
async function storeQuery<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof StoreError) {
      throw error;
    }
    throw new StoreError(error instanceof Error ? error.message : 'query failed', {
      retryable: isRetryable(error),
      cause: error,
    });
  }
}

const CONVERSATION_COLUMNS =
  'conversation_id, match_id, participants, state, opened_at, last_message_at';

const MESSAGE_COLUMNS = 'message_id, conversation_id, sender_id, body, created_at';

/**
 * `ConversationStore` on Postgres.
 *
 * The constructor deliberately takes nothing. A store holding a pool could
 * reach around the caller's transaction, and the only defence against that is
 * not having one.
 */
export class PgConversationStore {
  async create(row: ConversationRow, tx: Transaction): Promise<void> {
    const client = clientOf(tx);
    await storeQuery(async () => {
      try {
        await client.query(
          `INSERT INTO app.conversations (${CONVERSATION_COLUMNS}, state_changed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $5)`,
          [
            row.conversationId,
            row.matchId,
            [...row.participants],
            row.state,
            row.openedAt,
            row.lastMessageAt,
          ],
        );
      } catch (error) {
        throw createConflict(error);
      }
    });
  }

  /**
   * A conversation, but only to one of its participants. A guessed id returns
   * `null` — identical to an id that does not exist, because the difference
   * between the two answers is itself information about other people's matches.
   */
  async find(
    conversationId: ConversationId,
    reader: UserId,
    tx: Transaction,
  ): Promise<ConversationRow | null> {
    const client = clientOf(tx);
    return storeQuery(async () => {
      const result = await client.query<QueryResultRow>(
        `SELECT ${CONVERSATION_COLUMNS}
           FROM app.conversations
          WHERE conversation_id = $1 AND $2 = ANY(participants)`,
        [conversationId, reader],
      );
      const raw = result.rows[0];
      return raw === undefined ? null : toConversationRow(raw);
    });
  }

  async findByMatch(matchId: MatchId, tx: Transaction): Promise<ConversationRow | null> {
    const client = clientOf(tx);
    return storeQuery(async () => {
      const result = await client.query<QueryResultRow>(
        `SELECT ${CONVERSATION_COLUMNS}
           FROM app.conversations
          WHERE match_id = $1`,
        [matchId],
      );
      const raw = result.rows[0];
      return raw === undefined ? null : toConversationRow(raw);
    });
  }

  /**
   * Moves the conversation to `state`, and records when. Returns whether it
   * moved: false means there is no such conversation, which is the only way
   * this can fail.
   *
   * `at` is the moment of the transition, stored in `state_changed_at`. It is
   * the domain's `stateChangedAt`, and it moves on the same statement as the
   * state so a conversation cannot be read back saying its state changed at a
   * moment its own state does not agree with.
   */
  async updateState(conversationId: ConversationId, state: string, at: Date, tx: Transaction): Promise<boolean> {
    const client = clientOf(tx);
    return storeQuery(async () => {
      const result = await client.query(
        'UPDATE app.conversations SET state = $2, state_changed_at = $3 WHERE conversation_id = $1',
        [conversationId, state, at],
      );
      return result.rowCount === 1;
    });
  }

  /**
   * The user's conversations, most recently active first. Activity is the last
   * message, or the opening if there has not been one, because a conversation
   * nobody has written in has had no activity since it opened.
   *
   * `conversation_id` breaks ties so that two conversations sharing a timestamp
   * keep the same order across pages instead of shuffling between requests.
   */
  async listFor(userId: UserId, page: Page, tx: Transaction): Promise<PageResult<ConversationRow>> {
    const { limit, offset } = readPage(page);
    const client = clientOf(tx);
    return storeQuery(async () => {
      const counted = await client.query<{ total: number }>(
        'SELECT count(*)::int AS total FROM app.conversations WHERE $1 = ANY(participants)',
        [userId],
      );
      const result = await client.query<QueryResultRow>(
        `SELECT ${CONVERSATION_COLUMNS}
           FROM app.conversations
          WHERE $1 = ANY(participants)
          ORDER BY COALESCE(last_message_at, opened_at) DESC, conversation_id DESC
          LIMIT $2 OFFSET $3`,
        [userId, limit, offset],
      );
      return { items: result.rows.map(toConversationRow), total: totalOf(counted.rows[0]) };
    });
  }

  /**
   * Appends a message, or reports the replay as `created: false` without
   * touching the table. The `ON CONFLICT` is the whole point: delivery is
   * at-least-once, and the alternative — catching the unique violation — leaves
   * the transaction aborted and forces the caller to replay the whole unit of
   * work to learn that their message had in fact been accepted.
   */
  async appendMessage(row: MessageRow, tx: Transaction): Promise<{ readonly created: boolean }> {
    const length = bodyLength(row.body);
    if (length < MIN_BODY || length > MAX_BODY) {
      throw new InvalidMessageBodyError(length);
    }
    const client = clientOf(tx);
    return storeQuery(async () => {
      const inserted = await client.query<{ message_id: string }>(
        `INSERT INTO app.messages (${MESSAGE_COLUMNS})
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (message_id) DO NOTHING
         RETURNING message_id`,
        [row.messageId, row.conversationId, row.senderId, row.body, row.createdAt],
      );
      const created = inserted.rowCount === 1;
      if (created) {
        // The conversation's activity moves with the message, or `listFor`
        // would order every conversation by when it was opened. GREATEST
        // because a message that arrives late must not move activity
        // backwards past a newer one.
        await client.query(
          'UPDATE app.conversations SET last_message_at = GREATEST(last_message_at, $2) WHERE conversation_id = $1',
          [row.conversationId, row.createdAt],
        );
      }
      return { created };
    });
  }

  /**
   * A page of messages, oldest first, scoped to a participant on the same terms
   * as `find`.
   *
   * `message_id` is the tie-break. Two messages can share a `created_at` to the
   * microsecond, and without a second key Postgres may return them in either
   * order — which looks, to a user reading a paginated thread, like messages
   * arriving out of order. The tie-break is arbitrary but it is total, so a
   * page boundary cannot split a tie differently on the next request.
   */
  async findMessages(
    conversationId: ConversationId,
    page: Page,
    reader: UserId,
    tx: Transaction,
  ): Promise<PageResult<MessageRow>> {
    const { limit, offset } = readPage(page);
    const client = clientOf(tx);
    return storeQuery(async () => {
      const counted = await client.query<{ total: number }>(
        `SELECT count(*)::int AS total
           FROM app.messages m
           JOIN app.conversations c ON c.conversation_id = m.conversation_id
          WHERE m.conversation_id = $1 AND $2 = ANY(c.participants)`,
        [conversationId, reader],
      );
      const result = await client.query<QueryResultRow>(
        `SELECT m.message_id, m.conversation_id, m.sender_id, m.body, m.created_at
           FROM app.messages m
           JOIN app.conversations c ON c.conversation_id = m.conversation_id
          WHERE m.conversation_id = $1 AND $2 = ANY(c.participants)
          ORDER BY m.created_at ASC, m.message_id ASC
          LIMIT $3 OFFSET $4`,
        [conversationId, reader, limit, offset],
      );
      return { items: result.rows.map(toMessageRow), total: totalOf(counted.rows[0]) };
    });
  }
}

function totalOf(row: { total: number } | undefined): number {
  if (row === undefined) {
    throw new StoreError('the count query returned no row', { retryable: false });
  }
  return row.total;
}

/**
 * The one conversation per match is a rule the index enforces, so a second
 * create is a conflict the caller can be told about precisely rather than an
 * opaque unique violation. A foreign key means the match itself is not there,
 * which is a different answer again.
 */
function createConflict(error: unknown): unknown {
  const code = pgField(error, 'code');
  if (code === '23503') {
    return new ConversationConflictError('match_does_not_exist', error);
  }
  if (code !== '23505') {
    return error;
  }
  const reason: ConversationConflict =
    pgField(error, 'constraint') === 'conversations_pkey' ? 'conversation_id_taken' : 'match_already_has_conversation';
  return new ConversationConflictError(reason, error);
}
