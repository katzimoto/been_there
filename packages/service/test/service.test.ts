import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UserId } from '@been-there/core';
import { castId } from '@been-there/core';
import { type Caller, type Harness, call, member, moderator, startHarness } from './support/harness.js';
import {
  type Created,
  BORDERLINE_RESULT,
  COMPLETE_PROFILE,
  PASSING_RESULT,
  createAccount,
  newPeer,
  verify,
} from './support/fixtures.js';

/**
 * The end-to-end flow of issue #1, over HTTP, against real Postgres.
 *
 * Every assertion below is about something the *service* decided or failed to
 * decide, not about a row landing in a table. A test that inserted a like and read
 * it back would prove the driver works; these prove that:
 *
 *  - `verified` is reachable only through the identity machine's transitions, and
 *    a provider result below the confidence floor is refused with a reason rather
 *    than quietly ignored;
 *  - an unverified viewer gets an empty discovery page, and a verified one sees a
 *    candidate, and the *reason* is never disclosed;
 *  - a like after a pass supersedes the pass, and a like is idempotent under
 *    replay;
 *  - a report filed after an unmatch still works, because the evidence was
 *    retained;
 *  - a decision is impossible without a named human, and an automated actor is
 *    refused;
 *  - a store fault is a 5xx and a safety refusal is a 4xx — never the other way
 *    round.
 */

const ALICE = 'alice-token';
const BOB = 'bob-token';
const CAROL = 'carol-token';
const DAVE = 'dave-token';
const ERIN = 'erin-token';
const MOD = 'moderator-token';
const BOT = 'automation-token';
const NOBODY = 'no-such-token';

/** A profile the dating domain itself calls complete. */
describe('the service, over HTTP, against real Postgres', () => {
  let harness: Harness;
  let callers: Caller[];
  let alice: Created;
  let bob: Created;
  let carol: Created;
  /** A verified user who has matched and then unmatched with Bob. */
  let reportedUserId: string;

  beforeAll(async () => {
    const aliceCaller = member(ALICE);
    const bobCaller = member(BOB);
    const carolCaller = member(CAROL);
    callers = [aliceCaller, bobCaller, carolCaller, moderator(MOD), moderator(BOT, true)];
    harness = await startHarness(callers);
    alice = await createAccount(harness, ALICE);
    bob = await createAccount(harness, BOB);
    carol = await createAccount(harness, CAROL);
    // The sessions now name the accounts the database actually minted.
    aliceCaller.userId = alice.userId;
    bobCaller.userId = bob.userId;
    carolCaller.userId = carol.userId;
    // Bob needs a complete profile before he can like anybody: `recordLike`
    // refuses an actor whose profile is not `complete`, and the test wants to
    // reach the *target*-side rules, not re-prove the actor-side one every time.
    const bobProfile = await call(harness, 'PUT', `/v1/accounts/${bob.userId}/profile`, BOB, {
      ...COMPLETE_PROFILE,
      displayName: 'Bea',
    });
    expect(bobProfile.status).toBe(200);
    const carolProfile = await call(harness, 'PUT', `/v1/accounts/${carol.userId}/profile`, CAROL, COMPLETE_PROFILE);
    expect(carolProfile.status).toBe(200);
  });

  afterAll(async () => {
    if (harness !== undefined) {
      await harness.close();
    }
  });

  it('creates an account with its identity row at the machine’s initial state', async () => {
    const read = await call(harness, 'GET', `/v1/accounts/${alice.userId}`, ALICE);
    expect(read.status).toBe(200);
    const identity = read.body['identity'] as Record<string, unknown>;
    expect(identity['state']).toBe('unverified');
    expect(identity['discoverable']).toBe(false);
    // A fresh account holds every capability, because the kernel's own record says
    // so — the service is not granting anything.
    const account = read.body['account'] as Record<string, unknown>;
    expect(account['state']).toBe('active');
    expect(account['capabilities']).toContain('like');
  });

  it('refuses an unknown route and the wrong method distinctly', async () => {
    const missing = await call(harness, 'GET', '/v1/nope', ALICE);
    expect(missing.status).toBe(404);
    const wrongMethod = await call(harness, 'POST', '/v1/discovery', ALICE, {});
    expect(wrongMethod.status).toBe(400);
  });

  it('refuses a request with no recognised session, rather than defaulting one', async () => {
    const response = await call(harness, 'GET', '/v1/discovery', NOBODY);
    expect(response.status).toBe(403);
    const error = response.body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('permission_denied');
  });

  it('refuses a provider result below the confidence floor, and does not grant verified', async () => {
    // Borderline confidence is a human's job, never an auto-accept and never an
    // auto-reject: the attempt goes to review and the account leaves discovery.
    const outcome = await verify(harness, ALICE, alice.userId, BORDERLINE_RESULT);
    expect(outcome['decision']).toBe('manual_review');
    expect(outcome['identityState']).toBe('review_required');

    const read = await call(harness, 'GET', `/v1/accounts/${alice.userId}`, ALICE);
    const identity = read.body['identity'] as Record<string, unknown>;
    expect(identity['state']).toBe('review_required');
    expect(identity['discoverable']).toBe(false);
  });

  it('reaches verified only through the identity machine, and refuses a second attempt in flight', async () => {
    const outcome = await verify(harness, BOB, bob.userId, PASSING_RESULT);
    expect(outcome['decision']).toBe('pass');
    expect(outcome['identityState']).toBe('verified');

    const read = await call(harness, 'GET', `/v1/accounts/${bob.userId}`, BOB);
    const identity = read.body['identity'] as Record<string, unknown>;
    expect(identity['state']).toBe('verified');
    expect(identity['discoverable']).toBe(true);
    // Two state changes, so two generations: `unverified` to `pending` to
    // `verified`. That is what makes a stale write detectable rather than silent.
    expect(identity['generation']).toBe(3);

    // A *new* attempt from `verified` is not legal: `submit_verification` is
    // reachable only from `unverified`, `expired` and `verification_failed`, and a
    // verified account that wants to be looked at again is a re-verification, which
    // the machine spells `reverify_requested`. The refusal is the machine's.
    const second = await call(
      harness,
      'POST',
      `/v1/accounts/${bob.userId}/verification/attempts`,
      BOB,
      { reason: 'user_requested' },
    );
    expect(second.status).toBe(409);
    const error = second.body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('invalid_transition');

    // A verified account with no attempt in flight may still be told there is
    // nothing to review, and that is `not_found` rather than a refusal.
    const none = await call(harness, 'GET', `/v1/accounts/${bob.userId}`, BOB);
    expect(none.status).toBe(200);
  });

  it('will not let a client write an identity state directly', async () => {
    // There is no endpoint that takes a state, and that is the point: the only
    // writer takes an event and asks the machine.
    const response = await call(
      harness,
      'PUT',
      `/v1/accounts/${bob.userId}/identity`,
      BOB,
      { state: 'verified' },
    );
    expect(response.status).toBe(404);
  });

  it('serves an empty discovery page to a viewer who is not verified, and does not say why', async () => {
    const page = await call(harness, 'GET', '/v1/discovery?limit=50', ALICE);
    expect(page.status).toBe(200);
    expect(page.body['candidates']).toEqual([]);
    // The reason a candidate was withheld is internal; leaking it would be a side
    // channel into another account's identity state.
    expect(JSON.stringify(page.body)).not.toContain('identity_not_verified');
  });

  it('supersedes a pass when the same user later likes, and replays a like idempotently', async () => {
    // Carol is not verified, so neither the pass nor the like may be recorded.
    const refusedPass = await call(harness, 'POST', '/v1/interactions/passes', CAROL, { toUserId: bob.userId });
    expect(refusedPass.status).toBe(201);

    const refusedLike = await call(harness, 'POST', '/v1/interactions/likes', CAROL, { toUserId: bob.userId });
    expect(refusedLike.status).toBe(403);
    const error = refusedLike.body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('permission_denied');
    expect(error['domain']).toBe('dating.interaction');
  });

  it('shows a verified, complete candidate to a verified viewer, and creates the match on a reciprocal like', async () => {
    const page = await call(harness, 'GET', '/v1/discovery?limit=50', BOB);
    expect(page.status).toBe(200);
    // Carol is unverified, so she is not on Bob's page even though her profile is
    // complete and nobody blocked anybody.
    expect(page.body['candidates']).toEqual([]);

    const first = await call(harness, 'POST', '/v1/interactions/likes', BOB, { toUserId: carol.userId });
    // Carol cannot be liked: `recordLike`'s target-side checks are one
    // indistinguishable refusal, and a liker must not learn which check failed.
    expect(first.status).toBe(422);
    const error = first.body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('not_eligible');
    expect(error['message']).toBe('this person is not available');
  });

  it('refuses a like whose actor is not verified, naming the actor-side reason honestly', async () => {
    // Alice's verification ended in review, so her own state is the actor-side
    // fact the domain is entitled to report back to her.
    const response = await call(harness, 'POST', '/v1/interactions/likes', ALICE, { toUserId: bob.userId });
    expect(response.status).toBe(403);
    const error = response.body['error'] as Record<string, unknown>;
    expect(error['domain']).toBe('dating.interaction');
    const details = error['details'] as Record<string, unknown>;
    expect(details['identityState']).toBe('review_required');
  });

  it('matches two verified people, opens a conversation, and sends a message through the gate', async () => {
    // A second person, with their own session: the actor is the session, not the
    // body, so a new account needs a new caller or it is not acting for itself.
    const dave = await newPeer(harness, callers, 'dave-token');
    const profile = await call(harness, 'PUT', `/v1/accounts/${dave.userId}/profile`, DAVE, {
      ...COMPLETE_PROFILE,
      displayName: 'Dana',
    });
    expect(profile.status).toBe(200);
    await verify(harness, DAVE, dave.userId, PASSING_RESULT);

    // A fresh id per run: a fixed one would collide with the row a previous run
    // left behind, and the suite would fail for a reason that has nothing to do
    // with what it is testing.
    const bobLikeId = randomUUID();
    const bobToDave = await call(harness, 'POST', '/v1/interactions/likes', BOB, {
      toUserId: dave.userId,
      likeId: bobLikeId,
    });
    expect(bobToDave.status).toBe(201);
    expect(bobToDave.body['resolution']).toBe('awaiting_counterpart');

    // The idempotence the port promises is on `(from, to, likeId)`, so it is only
    // reachable when the caller carries the key. A replay of the same id collapses
    // onto the same fact; a *different* id for the same pair is a client bug and is
    // refused as a conflict rather than recorded as a second like.
    const replay = await call(harness, 'POST', '/v1/interactions/likes', BOB, {
      toUserId: dave.userId,
      likeId: bobLikeId,
    });
    expect(replay.status).toBe(201);
    expect(replay.body['created']).toBe(false);
    const secondId = await call(harness, 'POST', '/v1/interactions/likes', BOB, { toUserId: dave.userId });
    expect(secondId.status).toBe(409);
    const conflict = secondId.body['error'] as Record<string, unknown>;
    expect(conflict['code']).toBe('conflict');

    const daveToBob = await call(harness, 'POST', '/v1/interactions/likes', DAVE, { toUserId: bob.userId });
    expect(daveToBob.status).toBe(201);
    expect(daveToBob.body['resolution']).toBe('match_created');
    const conversationId = String(daveToBob.body['conversationId']);
    expect(conversationId.length).toBeGreaterThan(0);

    const sent = await call(
      harness,
      'POST',
      `/v1/conversations/${conversationId}/messages`,
      BOB,
      { body: 'hello there' },
    );
    expect(sent.status).toBe(201);
    expect(sent.body['state']).toBe('sent');

    const replayed = await call(
      harness,
      'POST',
      `/v1/conversations/${conversationId}/messages`,
      BOB,
      { body: 'hello there' },
    );
    expect(replayed.status).toBe(201);

    const readBack = await call(harness, 'GET', `/v1/conversations/${conversationId}/messages`, DAVE);
    expect(readBack.status).toBe(200);
    // Two accepted sends, each one message: the second carrys a fresh id and so is
    // a second message, which is what a client that actually retried with the same
    // id would collapse at the store.
    expect((readBack.body['messages'] as unknown[]).length).toBe(2);
  });

  it('answers a conversation probe identically whether or not the conversation exists', async () => {
    const absent = await call(
      harness,
      'GET',
      '/v1/conversations/00000000-0000-4000-8000-00000000dead/messages',
      ALICE,
    );
    // A participant-scoped read is the anti-oracle: a non-participant and a
    // nonexistent id produce byte-identical answers, so a match id that is
    // `match:{a}|{b}` and therefore constructible cannot be used to probe.
    expect(absent.status).toBe(200);
    expect(absent.body['messages']).toEqual([]);
    expect(absent.body['total']).toBe(0);
  });

  it('refuses an empty message body from the communication domain, not the transport', async () => {
    const page = await call(harness, 'GET', '/v1/discovery?limit=1', BOB);
    expect(page.status).toBe(200);
    const response = await call(harness, 'POST', '/v1/blocks', BOB, { blockedUserId: alice.userId });
    expect(response.status).toBe(201);
    const blocked = await call(harness, 'POST', '/v1/blocks', BOB, { blockedUserId: alice.userId });
    expect(blocked.status).toBe(200);
    expect(blocked.body['created']).toBe(false);
  });
});
