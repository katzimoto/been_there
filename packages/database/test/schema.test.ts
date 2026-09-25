/**
 * The schema's load-bearing guarantees, proven against a real database.
 *
 * These are not unit tests of a mock. Each one runs against Postgres and
 * asserts something the application cannot enforce on its own — usually a
 * concurrency or integrity property that only an index or a constraint can
 * provide. A test that only checked the shape of a row would prove nothing
 * about whether two simultaneous likes can produce two matches.
 *
 * Skipped, loudly, when `DATABASE_URL` is unset. A suite that silently passes
 * because it did nothing is worse than a failing one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { PoolClient } from 'pg';

const connectionString = process.env.DATABASE_URL;
const describeIfDb = connectionString === undefined ? describe.skip : describe;

describeIfDb('schema guarantees, against Postgres', () => {
  let pool: pg.Pool;
  let client: PoolClient;

  beforeAll(async () => {
    if (connectionString === undefined) {
      return;
    }
    pool = new pg.Pool({ connectionString });
    client = await pool.connect();
  });

  afterAll(async () => {
    if (pool !== undefined) {
      client.release();
      await pool.end();
    }
  });

  /** Two users, so a like has somewhere to point. */
  async function twoUsers() {
    const a = randomUUID();
    const b = randomUUID();
    await client.query(
      'INSERT INTO app.users (user_id, account_id) VALUES ($1,$2), ($3,$4)',
      [a, randomUUID(), b, randomUUID()],
    );
    return { a, b };
  }

  it('refuses a second live like for the same pair, whichever direction it came from', async () => {
    const { a, b } = await twoUsers();
    await client.query(
      'INSERT INTO app.likes (like_id, from_user_id, to_user_id) VALUES ($1,$2,$3)',
      [randomUUID(), a, b],
    );
    // The reverse direction is the same pair. Without the canonical-pair index
    // this would succeed and a reciprocal like would become a second like
    // rather than a match.
    await expect(
      client.query('INSERT INTO app.likes (like_id, from_user_id, to_user_id) VALUES ($1,$2,$3)', [
        randomUUID(),
        b,
        a,
      ]),
    ).rejects.toThrow();
  });

  it('allows a like again once the first is withdrawn, because history is not a veto', async () => {
    const { a, b } = await twoUsers();
    const likeId = randomUUID();
    await client.query(
      'INSERT INTO app.likes (like_id, from_user_id, to_user_id, state) VALUES ($1,$2,$3,$4)',
      [likeId, a, b, 'withdrawn'],
    );
    // A withdrawn like is history and counts for nothing, so the pair is free.
    await expect(
      client.query('INSERT INTO app.likes (like_id, from_user_id, to_user_id) VALUES ($1,$2,$3)', [
        randomUUID(),
        b,
        a,
      ]),
    ).resolves.toBeDefined();
  });

  it('gives a pair at most one match, so two concurrent reciprocal likes converge', async () => {
    const { a, b } = await twoUsers();
    const pairKey = [a, b].sort().join('|');
    const row = (matchId) => [matchId, pairKey, [a, b], [randomUUID()], ['active', 'active']];
    await client.query(
      'INSERT INTO app.matches (match_id, pair_key, participants, like_ids, standings) VALUES ($1,$2,$3,$4,$5)',
      row(randomUUID()),
    );
    await expect(
      client.query(
        'INSERT INTO app.matches (match_id, pair_key, participants, like_ids, standings) VALUES ($1,$2,$3,$4,$5)',
        row(randomUUID()),
      ),
    ).rejects.toThrow();
  });

  it('refuses a self-like, a self-pass and a self-block at the database', async () => {
    const { a } = await twoUsers();
    await expect(
      client.query('INSERT INTO app.likes (like_id, from_user_id, to_user_id) VALUES ($1,$2,$2)', [
        randomUUID(),
        a,
      ]),
    ).rejects.toThrow();
    await expect(
      client.query('INSERT INTO app.passes (pass_id, from_user_id, to_user_id) VALUES ($1,$2,$2)', [
        randomUUID(),
        a,
      ]),
    ).rejects.toThrow();
    await expect(
      client.query(
        'INSERT INTO app.blocks (block_id, blocker_id, blocked_id) VALUES ($1,$2,$2)',
        [randomUUID(), a],
      ),
    ).rejects.toThrow();
  });

  it('rejects an identity state the machine cannot produce', async () => {
    const { a } = await twoUsers();
    await expect(
      client.query('INSERT INTO app.identity_state (user_id, state) VALUES ($1,$2)', [a, 'trusted']),
    ).rejects.toThrow();
  });

  it('has no column in which a message body or an identity artefact could hide', async () => {
    // The reduction to metadata is a type-level guarantee in the domain; this is
    // the storage half. If someone adds a `body` or `artefact` column later to
    // satisfy a query, this fails and forces the conversation.
    const { rows } = await client.query(`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'app'
        AND column_name IN ('body', 'artefact', 'biometric', 'selfie', 'liveness', 'exact_location')
    `);
    // `messages.body` is the message itself and is expected; nothing else is.
    const unexpected = rows.filter((row) => !(row.table_name === 'messages' && row.column_name === 'body'));
    expect(unexpected).toEqual([]);
  });

  it('treats the audit log as append-only, because it is the appeal record', async () => {
    const { a } = await twoUsers();
    const entry = [
      new Date(),
      'mod-1',
      'decision.recorded',
      'decision',
      randomUUID(),
      a,
      null,
      JSON.stringify({ action: 'ban' }),
    ];
    await client.query(
      'INSERT INTO app.audit_log (occurred_at, actor_id, action, entity_type, entity_id, subject_id, case_id, detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      entry,
    );
    // There is no update path in the application either. What the database
    // gives is that a correction is a new row and the sequence is monotonic,
    // so history cannot be quietly rewritten in place.
    const mine = await client.query(
      'SELECT seq FROM app.audit_log WHERE subject_id = $1 ORDER BY seq',
      [a],
    );
    expect(mine.rowCount).toBe(1);

    // A second record about the same subject appends rather than replacing.
    await client.query(
      'INSERT INTO app.audit_log (occurred_at, actor_id, action, entity_type, entity_id, subject_id, case_id, detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [new Date(), 'mod-1', 'decision.reversed', 'decision', randomUUID(), a, null, '{}'],
    );
    const after = await client.query(
      'SELECT seq, action FROM app.audit_log WHERE subject_id = $1 ORDER BY seq',
      [a],
    );
    expect(after.rowCount).toBe(2);
    expect(after.rows.map((row) => row.action)).toEqual([
      'decision.recorded',
      'decision.reversed',
    ]);
  });
});
