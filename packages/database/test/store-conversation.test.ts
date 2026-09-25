/**
 * `ConversationStore` against the live database.
 *
 * Each test here is one a wrong implementation would fail. A test that inserts
 * a row and reads it back proves the driver works; these prove the properties
 * the port promises — a replay collapses, a second conversation for a match is
 * a distinguishable conflict rather than a fault, a page boundary cannot
 * reorder two messages that share a timestamp, and a user who is not in a
 * conversation learns nothing about it however they came by the id.
 *
 * The connection string is read from the environment and from `.env` when it is
 * there, the same way `scripts/migrate.mjs` reads it, so the suite runs
 * against the database the developer set up rather than silently against
 * nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { PoolClient } from 'pg';
import { castId } from '@been-there/core';
import type { ConversationId, MatchId, MessageId, UserId } from '@been-there/core';
import type { ConversationRow, MessageRow, Transaction } from '@been-there/contracts';
import { pairKey } from '../src/pair-key.js';
import { createTransaction } from '../src/transaction.js';
import { PgConversationStore } from '../src/store-conversation.js';
import { ConversationStoreError, StoreError } from '@been-there/contracts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ENV_FILE = join(REPO_ROOT, '.env');
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const matched = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (matched === null) {
      continue;
    }
    const [, name, value] = matched;
    if (name !== undefined && value !== undefined && process.env[name] === undefined) {
      process.env[name] = value;
    }
  }
}

const connectionString = process.env.DATABASE_URL;
const describeIfDb = connectionString === undefined ? describe.skip : describe;

describeIfDb('ConversationStore, against Postgres', () => {
  let pool: pg.Pool;
  let client: PoolClient;
  let transaction: Transaction;
  const store = new PgConversationStore();

  beforeAll(async () => {
    if (connectionString === undefined) {
      return;
    }
    pool = new pg.Pool({ connectionString });
    client = await pool.connect();
    transaction = createTransaction(pool);
    // Connecting is not the same as reaching the schema this store reads, and
    // a suite that quietly ran against an empty database would report every
    // one of these properties as satisfied.
    const probe = await client.query<{ state_changed_at: Date | null }>(
      'SELECT state_changed_at FROM app.conversations LIMIT 0',
    );
    expect(probe.rows).toEqual([]);
  });

  afterAll(async () => {
    if (pool !== undefined) {
      client.release();
      await pool.end();
    }
  });

  async function twoUsers(): Promise<readonly [UserId, UserId]> {
    const a = castId<'UserId'>(randomUUID());
    const b = castId<'UserId'>(randomUUID());
    await client.query('INSERT INTO app.users (user_id, account_id) VALUES ($1,$2), ($3,$4)', [
      a,
      randomUUID(),
      b,
      randomUUID(),
    ]);
    return [a, b];
  }

  async function aMatch(participants: readonly [UserId, UserId]): Promise<MatchId> {
    const matchId = castId<'MatchId'>(`match:${randomUUID()}`);
    await client.query(
      'INSERT INTO app.matches (match_id, pair_key, participants, like_ids, standings) VALUES ($1,$2,$3,$4,$5)',
      [matchId, pairKey(participants[0], participants[1]), [...participants], [], ['active', 'active']],
    );
    return matchId;
  }

  function aConversation(matchId: MatchId, participants: readonly [UserId, UserId], openedAt: Date): ConversationRow {
    return {
      conversationId: castId<'ConversationId'>(randomUUID()),
      matchId,
      participants,
      state: 'active',
      openedAt,
      stateChangedAt: openedAt,
      lastMessageAt: null,
    };
  }

  function aMessage(
    conversationId: ConversationId,
    senderId: UserId,
    createdAt: Date,
    body = 'hello',
    messageId: MessageId = castId<'MessageId'>(randomUUID()),
  ): MessageRow {
    return {
      messageId,
      conversationId,
      senderId,
      body,
      createdAt,
      state: 'sent',
    };
  }

  const at = (seconds: number): Date => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds));

  it('collapses a replayed messageId instead of storing the message twice', async () => {
    const [a, b] = await twoUsers();
    const matchId = await aMatch([a, b]);
    const conversation = aConversation(matchId, [a, b], at(0));
    await transaction.run((tx) => store.create(conversation, tx));
    const message = aMessage(conversation.conversationId, a, at(1));

    const first = await transaction.run((tx) => store.appendMessage(message, tx));
    // The same wire delivery arriving twice: same id, and a body the client
    // has since re-serialised differently. It must not be stored, and it must
    // not overwrite what the first delivery wrote.
    const replayed = await transaction.run((tx) =>
      store.appendMessage({ ...message, body: 'edited in the client' }, tx),
    );

    expect(first.created).toBe(true);
    expect(replayed.created).toBe(false);

    const stored = await client.query<{ count: string; body: string }>(
      'SELECT count(*)::text AS count, min(body) AS body FROM app.messages WHERE conversation_id = $1',
      [conversation.conversationId],
    );
    expect(stored.rows[0]?.count).toBe('1');
    expect(stored.rows[0]?.body).toBe('hello');
  });

  it('reports a second conversation for one match as a conflict, not a fault', async () => {
    const [a, b] = await twoUsers();
    const matchId = await aMatch([a, b]);
    const first = aConversation(matchId, [a, b], at(0));
    await transaction.run((tx) => store.create(first, tx));

    const second = aConversation(matchId, [a, b], at(1));
    const thrown = await transaction
      .run((tx) => store.create(second, tx))
      .then(() => null)
      .catch((error: unknown) => error);

    // A conflict the caller can act on: distinguishable, and not retryable,
    // because retrying it produces the same answer every time.
    expect(thrown).toBeInstanceOf(ConversationStoreError);
    expect((thrown as ConversationStoreError).reason).toBe('match_already_has_conversation');
    expect((thrown as ConversationStoreError).retryable).toBe(false);
    // The driver's error is kept: the classification is a guess until the
    // constraint name behind it can be read.
    expect((thrown as ConversationStoreError).cause).toMatchObject({ code: '23505' });

    const rows = await client.query<{ conversation_id: string }>(
      'SELECT conversation_id FROM app.conversations WHERE match_id = $1',
      [matchId],
    );
    expect(rows.rows.map((row) => row.conversation_id)).toEqual([first.conversationId]);
  });

  it('tells a reused conversation id apart from a reused match', async () => {
    const [a, b] = await twoUsers();
    const [c, d] = await twoUsers();
    const matchId = await aMatch([a, b]);
    const other = await aMatch([c, d]);
    const conversation = aConversation(matchId, [a, b], at(0));
    await transaction.run((tx) => store.create(conversation, tx));

    const thrown = await transaction
      .run((tx) => store.create({ ...aConversation(other, [c, d], at(1)), conversationId: conversation.conversationId }, tx))
      .then(() => null)
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(ConversationStoreError);
    expect((thrown as ConversationStoreError).reason).toBe('conversation_id_taken');
  });

  it('pages messages in a stable order when two share a timestamp', async () => {
    const [a, b] = await twoUsers();
    const matchId = await aMatch([a, b]);
    const conversation = aConversation(matchId, [a, b], at(0));
    await transaction.run((tx) => store.create(conversation, tx));

    // Same microsecond, deliberately: this is the case an `ORDER BY created_at`
    // leaves to chance, and a page boundary that lands inside a tie is how a
    // thread ends up showing a message twice and skipping another. The tied
    // pair is written in the *opposite* order to their ids, so the assertion
    // below can only hold if something other than insertion order is breaking
    // the tie.
    const sameInstant = at(5);
    const [lowId = randomUUID(), highId = lowId] = [randomUUID(), randomUUID()].sort();
    const written = [
      aMessage(conversation.conversationId, a, at(1), 'first'),
      aMessage(conversation.conversationId, b, sameInstant, 'tie high id', castId<'MessageId'>(highId)),
      aMessage(conversation.conversationId, a, sameInstant, 'tie low id', castId<'MessageId'>(lowId)),
      aMessage(conversation.conversationId, b, at(9), 'last'),
    ];
    for (const message of written) {
      await transaction.run((tx) => store.appendMessage(message, tx));
    }

    const pageOne = await transaction.run((tx) => store.findMessages(conversation.conversationId, { limit: 2, offset: 0 }, a, tx));
    const pageTwo = await transaction.run((tx) => store.findMessages(conversation.conversationId, { limit: 2, offset: 2 }, a, tx));
    const pagedAgain = await transaction.run((tx) => store.findMessages(conversation.conversationId, { limit: 2, offset: 2 }, b, tx));
    const whole = await transaction.run((tx) => store.findMessages(conversation.conversationId, { limit: 10, offset: 0 }, a, tx));

    expect(pageOne.total).toBe(4);
    expect(pageTwo.total).toBe(4);
    const bodies = [...pageOne.items, ...pageTwo.items].map((message) => message.body);
    // Oldest first, the tie broken by id rather than by luck, no repeats and no
    // gaps across the boundary, and the same order when the page is asked for
    // again by the other participant.
    expect(bodies).toEqual(['first', 'tie low id', 'tie high id', 'last']);
    expect(whole.items.map((message) => message.body)).toEqual(bodies);
    expect(pagedAgain.items.map((message) => message.body)).toEqual(pageTwo.items.map((message) => message.body));
  });

  it('does not show a conversation to someone who is not in it, however they got the id', async () => {
    const [a, b] = await twoUsers();
    const [attacker] = await twoUsers();
    const matchId = await aMatch([a, b]);
    const conversation = aConversation(matchId, [a, b], at(0));
    await transaction.run((tx) => store.create(conversation, tx));
    await transaction.run((tx) =>
      store.appendMessage(aMessage(conversation.conversationId, a, at(1), 'between the two of you'), tx),
    );

    // The attacker holds a real id. It is not theirs, and the store is the
    // only place that can know that, so this is where the check belongs.
    const guessed = castId<'ConversationId'>(conversation.conversationId);
    const read = await transaction.run((tx) => store.find(guessed, attacker, tx));
    const messages = await transaction.run((tx) =>
      store.findMessages(guessed, { limit: 10, offset: 0 }, attacker, tx),
    );
    const listing = await transaction.run((tx) => store.listFor(attacker, { limit: 10, offset: 0 }, tx));

    expect(read).toBeNull();
    expect(messages.items).toEqual([]);
    expect(messages.total).toBe(0);
    expect(listing.items).toEqual([]);
    // The same answer as an id that does not exist, so the read is not an
    // existence oracle either.
    const invented = await transaction.run((tx) => store.find(castId<'ConversationId'>(randomUUID()), attacker, tx));
    expect(invented).toBeNull();

    // And the participants still see it, so the check is a scope and not a lockout.
    const asParticipant = await transaction.run((tx) => store.find(guessed, b, tx));
    expect(asParticipant?.participants).toEqual([a, b]);
    expect((await transaction.run((tx) => store.findMessages(guessed, { limit: 10, offset: 0 }, b, tx))).items).toHaveLength(1);
  });

  it('lists a user their conversations by most recent activity, and nobody else theirs', async () => {
    const [a, b] = await twoUsers();
    const [c, d] = await twoUsers();
    const older = aConversation(await aMatch([a, b]), [a, b], at(0));
    const newer = aConversation(await aMatch([a, d]), [a, d], at(10));
    const notTheirs = aConversation(await aMatch([c, d]), [c, d], at(20));
    for (const conversation of [older, newer, notTheirs]) {
      await transaction.run((tx) => store.create(conversation, tx));
    }

    // Activity, not opening: a message moves a conversation to the top even
    // though it was opened first.
    await transaction.run((tx) => store.appendMessage(aMessage(older.conversationId, b, at(30)), tx));

    const listed = await transaction.run((tx) => store.listFor(a, { limit: 10, offset: 0 }, tx));
    expect(listed.items.map((conversation) => conversation.conversationId)).toEqual([
      older.conversationId,
      newer.conversationId,
    ]);
    expect(listed.total).toBe(2);
    expect(listed.items[0]?.lastMessageAt).toEqual(at(30));
  });

  it('refuses a body the schema would reject, as a validation failure rather than a fault', async () => {
    const [a, b] = await twoUsers();
    const matchId = await aMatch([a, b]);
    const conversation = aConversation(matchId, [a, b], at(0));
    await transaction.run((tx) => store.create(conversation, tx));

    const tooLong = aMessage(conversation.conversationId, a, at(1), 'x'.repeat(4001));
    const empty = aMessage(conversation.conversationId, a, at(2), '');
    const longest = aMessage(conversation.conversationId, a, at(3), 'y'.repeat(4000));

    await expect(transaction.run((tx) => store.appendMessage(tooLong, tx))).rejects.toMatchObject({
      reason: 'message_body_out_of_range',
    });
    await expect(transaction.run((tx) => store.appendMessage(empty, tx))).rejects.toBeInstanceOf(
      ConversationStoreError,
    );
    // The boundary the CHECK states is the boundary that works, counted the way
    // Postgres counts it: characters, so a body of astral characters is not
    // rejected for being short in bytes.
    const astral = aMessage(conversation.conversationId, a, at(4), '\u{1F600}'.repeat(4000));
    expect((await transaction.run((tx) => store.appendMessage(longest, tx))).created).toBe(true);
    expect((await transaction.run((tx) => store.appendMessage(astral, tx))).created).toBe(true);

    const stored = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM app.messages WHERE conversation_id = $1',
      [conversation.conversationId],
    );
    expect(stored.rows[0]?.count).toBe('2');
  });

  it('moves a conversation to a new state and records when, and says so when there is none', async () => {
    const [a, b] = await twoUsers();
    const matchId = await aMatch([a, b]);
    const conversation = aConversation(matchId, [a, b], at(0));
    await transaction.run((tx) => store.create(conversation, tx));

    const changed = at(42);
    expect(await transaction.run((tx) => store.updateState(conversation.conversationId, 'blocked', changed, tx))).toBe(
      true,
    );
    expect(
      await transaction.run((tx) => store.updateState(castId<'ConversationId'>(randomUUID()), 'ended', changed, tx)),
    ).toBe(false);

    const row = await client.query<{ state: string; state_changed_at: Date }>(
      'SELECT state, state_changed_at FROM app.conversations WHERE conversation_id = $1',
      [conversation.conversationId],
    );
    expect(row.rows[0]?.state).toBe('blocked');
    expect(row.rows[0]?.state_changed_at).toEqual(changed);
    expect(
      (await transaction.run((tx) => store.find(conversation.conversationId, a, tx)))?.state,
    ).toBe('blocked');
  });

  it('leaves nothing behind when the caller rolls back', async () => {
    const [a, b] = await twoUsers();
    const matchId = await aMatch([a, b]);
    const conversation = aConversation(matchId, [a, b], at(0));
    const message = aMessage(conversation.conversationId, a, at(1));

    await expect(
      transaction.run(async (tx) => {
        await store.create(conversation, tx);
        await store.appendMessage(message, tx);
        throw new Error('the request failed after the writes');
      }),
    ).rejects.toThrow('the request failed after the writes');

    // Both statements joined the caller's transaction, so neither survives it.
    // A store that opened its own would leave both behind, and only a restart
    // would clear them.
    const conversations = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM app.conversations WHERE conversation_id = $1',
      [conversation.conversationId],
    );
    const messages = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM app.messages WHERE message_id = $1',
      [message.messageId],
    );
    expect(conversations.rows[0]?.count).toBe('0');
    expect(messages.rows[0]?.count).toBe('0');
    // The match is unique, so a rolled-back conversation really did leave the
    // match free for the conversation that should exist.
    await transaction.run((tx) => store.create(conversation, tx));
    const recovered = await transaction.run((tx) => store.find(conversation.conversationId, a, tx));
    expect(recovered?.matchId).toBe(matchId);
  });

  it('refuses to run on a transaction that is not carrying a client, rather than falling back to the pool', async () => {
    const [a, b] = await twoUsers();
    const matchId = await aMatch([a, b]);
    const conversation = aConversation(matchId, [a, b], at(0));
    await transaction.run((tx) => store.create(conversation, tx));

    const foreign: Transaction = { client: undefined, run: async () => undefined as never };
    await expect(transaction.run((tx) => store.find(conversation.conversationId, a, foreign))).rejects.toBeInstanceOf(
      StoreError,
    );
  });
});
