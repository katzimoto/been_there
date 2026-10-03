import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UserId } from '@been-there/core';
import { castId } from '@been-there/core';
import { type Harness, call, startHarness } from './support/harness.js';
import { PASSING_RESULT, verify } from './support/fixtures.js';

/**
 * Profile & preferences (#35), over real HTTP against real Postgres.
 *
 * Every assertion is about something the service *decided* — an eligibility
 * verdict, a profile state, a body that was refused — rather than about a row
 * landing in a table. A test that inserted a photo and read it back would prove
 * the driver works.
 *
 * ## Two things about the ordering here that are not incidental
 *
 * **The viewer is gated before any candidate is.** `evaluateEligibility` applies
 * the viewer's own gate at page level, so a viewer without a complete profile
 * gets a closed page rather than a filtered one. Every discovery assertion below
 * is therefore made from a viewer who is themselves finished, or it would pass
 * for the wrong reason.
 *
 * **The page a candidate is on is not the viewer's page.** Discovery pages
 * candidates by creation order, and a development database carries accounts from
 * earlier runs, so a test that asks for page one and expects to find its own
 * candidate is testing the size of the table rather than the eligibility gate.
 * `pageHolding` finds the page a specific account is on, which is what makes the
 * assertion about eligibility.
 *
 * The claims under test:
 *
 *  - **Completeness gates discovery.** Incomplete is absent; complete is
 *    present; and the step between the two is asserted from both sides, because
 *    a gate that admits a profile early is worse than one that never admits it.
 *  - **Only an approved photo counts.** A photo in `scanning` is on disk, is
 *    visible to its owner, and contributes nothing to completeness.
 *  - **The client cannot declare itself complete.** A body asserting
 *    `state: 'complete'` and `approval: 'approved'` changes nothing.
 *  - **Unset is unbounded.** A user with no preference record still sees an
 *    eligible candidate — asked while there is genuinely nothing stored.
 *  - **No coordinate escapes.** Asserted on the serialised body, including the
 *    refusal path, and on the stored row.
 *  - **One member cannot reach another's profile.** `/me` has no id in the path
 *    to guess; the older id-in-path shape refuses a mismatched id with an answer
 *    that confirms nothing.
 */

/**
 * The tokens the two primary accounts hold.
 *
 * Written to rather than registered with the harness: sign-up mints a session and
 * the resolver resolves a bearer token through the session table, so a
 * statically registered token would not authenticate. Filled in `beforeAll`.
 */
let aliceToken = '';
let bobToken = '';

/**
 * The photo count the *dating domain* asks for.
 *
 * Three, not one: §8.1 of the profile spec records this disagreement and says the
 * code is the stricter side. `evaluateProfileCompleteness` is the authority in
 * this codebase and it is not this suite's to change, so the tests are written
 * against the code rather than against the table, and the divergence is not
 * papered over.
 */
const APPROVED_PHOTOS = 3;

const ALT = 'Alex on a windy afternoon near the bridge';

/** One suffix per run, so a re-run against a persistent database still signs up. */
const RUN_ID = randomUUID().slice(0, 8);

/** Everything a profile needs except its photos, in one body. */
const CONTENT = {
  displayName: 'Alex',
  bio: 'Long enough bio to satisfy the minimum length the dating domain asks for.',
  genderIdentities: ['woman'],
  prompts: [{ promptId: 'currently_into', text: 'learning to make proper bread' }],
  location: '25_50_km',
};

/**
 * The one server the helpers talk to.
 *
 * Module-level because the suite starts a single service for its whole run and
 * threading the harness through every helper would be noise that says nothing
 * about what is under test. `beforeAll` is the only writer.
 */
let harness: Harness;
// Assigned the moment `startHarness` returns. `harness` is unassigned when it
// throws — which is where a migration failure surfaces — and an `afterAll` that
// reads it then raises a `TypeError` in place of the failure that caused it.
let closeHarness: (() => Promise<void>) | undefined;

describe('profile and preferences, over HTTP against real Postgres', () => {
  let alice: UserId;
  let bob: UserId;

  beforeAll(async () => {
    harness = await startHarness([]);
    // Assigned before any of the sign-up steps below, so a failure in one of
    // them still leaves a teardown that can reach the harness it created.
    closeHarness = harness.close;
    const aliceAccount = await signUp('alice-profile', 'alice.profile');
    alice = aliceAccount.userId;
    aliceToken = aliceAccount.token;
    const bobAccount = await signUp('bob-profile', 'bob.profile');
    bob = bobAccount.userId;
    bobToken = bobAccount.token;
    await verify(harness, bobAccount.token, bob, PASSING_RESULT);
    // Bob is the viewer for every discovery assertion, and the viewer's own gate
    // runs before any candidate is considered. Finishing him here is what makes
    // those assertions about the candidate rather than about the viewer.
    await completeProfile(bobAccount.token);
  });

  afterAll(async () => {
    await closeHarness?.();
  });

  // ------------------------------------------------- completeness gates discovery --

  it('keeps a profile with no photos out of discovery, and names the rule', async () => {
    await verify(harness, aliceToken, alice, PASSING_RESULT);
    const written = await call(harness, 'PUT', '/v1/profiles/me', aliceToken, CONTENT);
    expect(written.status).toBe(200);
    // The service names the unmet rules rather than counting them. There is no
    // number in this body, and no field one could be added to.
    expect(written.body['complete']).toBe(false);
    expect(written.body['missing']).toContain('photos');

    expect(await discoverySees(bobToken, alice)).toBe(false);
  });

  it('publishes the profile only once completeness is reached, and not one request earlier', async () => {
    // Nothing approved yet, so the profile is incomplete and invisible. With
    // `minPhotos: 1` this is now the *only* way to be unpublished on photos, so
    // it is the whole of the gate rather than one of three ways.
    const before = await call(harness, 'GET', '/v1/profiles/me', aliceToken);
    expect(before.body['complete']).toBe(false);
    expect(before.body['missing']).toContain('photos');
    expect(await discoverySees(bobToken, alice)).toBe(false);

    // A photo still screening does not count, and does not publish. This is the
    // assertion that a face cannot reach another user before the platform has
    // cleared it — approval is the gate, not presence.
    const held = await call(harness, 'POST', '/v1/profiles/me/photos', aliceToken, {
      mediaAssetId: mediaHandle('alice-last'),
      altText: ALT,
    });
    expect(held.status).toBe(201);
    const third = photoIdOf(held.body['photo']);

    const midway = await call(harness, 'GET', '/v1/profiles/me', aliceToken);
    expect(midway.body['complete']).toBe(false);
    expect(midway.body['missing']).toContain('photos');
    expect(await discoverySees(bobToken, alice)).toBe(false);

    const verdict = await call(harness, 'PUT', `/v1/profiles/me/photos/${third}/screening`, aliceToken, {
      verdict: 'clean',
    });
    expect(verdict.status).toBe(200);
    expect(verdict.body['complete']).toBe(true);
    expect(verdict.body['state']).toBe('complete');

    expect(await discoverySees(bobToken, alice)).toBe(true);
  });

  it('keeps an unapproved photo out of completeness and out of the served set', async () => {
    const grace = await signUp('grace-unapproved', 'grace.unapproved@example.test');
    await call(harness, 'PUT', '/v1/profiles/me', grace.token, CONTENT);

    const uploaded = await call(harness, 'POST', '/v1/profiles/me/photos', grace.token, {
      mediaAssetId: mediaHandle('unapproved'),
      altText: ALT,
    });
    expect(uploaded.status).toBe(201);
    const photoId = photoIdOf(uploaded.body['photo']);

    // The owner sees it and sees that it is not approved — §6.3 step 5 requires
    // the state to be visible to the owner.
    const row = await photoRow(grace.token, photoId);
    expect(row?.['state']).toBe('scanning');
    // No handle for an uncleared photo. "Not served" is a property of the
    // response rather than a rule somebody has to remember at the read site: a
    // client cannot render from what it is not given.
    expect(row).not.toHaveProperty('mediaAssetId');
    expect(row).not.toHaveProperty('url');
    expect(row).not.toHaveProperty('path');

    // And it contributes nothing to completeness.
    const profile = await call(harness, 'GET', '/v1/profiles/me', grace.token);
    expect(profile.body['complete']).toBe(false);
    expect(profile.body['missing']).toContain('photos');
  });

  it('refuses a rejection the media machine would not grant', async () => {
    const heidi = await signUp('heidi-guarded', 'heidi.guarded@example.test');
    await call(harness, 'PUT', '/v1/profiles/me', heidi.token, CONTENT);
    const uploaded = await call(harness, 'POST', '/v1/profiles/me/photos', heidi.token, {
      mediaAssetId: mediaHandle('guarded'),
      altText: ALT,
    });
    const photoId = photoIdOf(uploaded.body['photo']);

    // A rejection without a machine-readable reason is not a decision the
    // machine will record, so it is refused and the photo stays where it was.
    // The guard is the platform's; the route adds no rule beside it.
    const refused = await call(harness, 'PUT', `/v1/profiles/me/photos/${photoId}/screening`, heidi.token, {
      verdict: 'sexual_content',
    });
    // 400 rather than 409: the media machine reports a blocked precondition as
    // `validation_failed`, and the status follows the domain's code rather than
    // being second-guessed at the edge.
    expect(refused.status).toBe(400);
    const row = await photoRow(heidi.token, photoId);
    expect(row?.['state']).toBe('scanning');
    expect(row?.['reasonCode']).toBeNull();
  });

  it('holds an inconclusive verdict as needs_human rather than publishing it', async () => {
    const ivan = await signUp('ivan-inconclusive', 'ivan.inconclusive@example.test');
    await call(harness, 'PUT', '/v1/profiles/me', ivan.token, CONTENT);
    const uploaded = await call(harness, 'POST', '/v1/profiles/me/photos', ivan.token, {
      mediaAssetId: mediaHandle('inconclusive'),
      altText: ALT,
    });
    const photoId = photoIdOf(uploaded.body['photo']);
    const held = await call(harness, 'PUT', `/v1/profiles/me/photos/${photoId}/screening`, ivan.token, {
      verdict: 'inconclusive',
    });
    expect(held.status).toBe(200);
    // A hold is a queue, not a refusal: unpublished, but not a rejection, and the
    // owner is not told it failed.
    const photo = held.body['photo'] as Record<string, unknown>;
    expect(photo['state']).toBe('needs_human');
    expect(photo['reasonCode']).toBeNull();
    expect(photo).not.toHaveProperty('mediaAssetId');
  });

  it('withdraws a rejected photo from the served set without making the profile a cliff', async () => {
    const judy = await signUp('judy-rejected', 'judy.rejected@example.test');
    await call(harness, 'PUT', '/v1/profiles/me', judy.token, CONTENT);
    await verify(harness, judy.token, judy.userId, PASSING_RESULT);
    const kept = await approvePhotos(judy.token, APPROVED_PHOTOS);

    const doomed = await call(harness, 'POST', '/v1/profiles/me/photos', judy.token, {
      mediaAssetId: mediaHandle('doomed'),
      altText: ALT,
    });
    const doomedId = photoIdOf(doomed.body['photo']);
    const verdict = await call(harness, 'PUT', `/v1/profiles/me/photos/${doomedId}/screening`, judy.token, {
      verdict: 'sexual_content',
      reasonCode: 'sexual_content',
    });
    expect(verdict.status).toBe(200);
    expect((verdict.body['photo'] as Record<string, unknown>)['reasonCode']).toBe('sexual_content');

    // Removal from the live set is immediate, and the profile stays `complete`
    // because the rest of the rules still hold. §6.4: this is the common case and
    // it must not be a cliff.
    const row = await photoRow(judy.token, doomedId);
    expect(row?.['state']).toBe('rejected');
    expect(row).not.toHaveProperty('mediaAssetId');
    const listed = await call(harness, 'GET', '/v1/profiles/me/photos', judy.token);
    expect(approvedIds(listed.body)).toEqual(kept);
    const profile = await call(harness, 'GET', '/v1/profiles/me', judy.token);
    expect(profile.body['complete']).toBe(true);
  });

  // ------------------------------------------------------- editing keeps identity --

  it('preserves the profile identity and its photos across an edit', async () => {
    const before = await call(harness, 'GET', '/v1/profiles/me', aliceToken);
    const photosBefore = await call(harness, 'GET', '/v1/profiles/me/photos', aliceToken);

    const edited = await call(harness, 'PUT', '/v1/profiles/me', aliceToken, {
      ...CONTENT,
      bio: 'A different bio, still comfortably longer than the minimum length.',
    });
    expect(edited.status).toBe(200);
    expect(edited.body['profileId']).toBe(before.body['profileId']);
    const after = await call(harness, 'GET', '/v1/profiles/me', aliceToken);
    expect(after.body['profileId']).toBe(before.body['profileId']);

    // The photos survive a content edit. This is the failure mode an
    // edit-by-replacement would have: a bio change quietly emptying the set and
    // dropping a live profile back out of discovery.
    const photosAfter = await call(harness, 'GET', '/v1/profiles/me/photos', aliceToken);
    // Identity of the surviving photos is the property; a count would also pass
    // under a set that had been quietly emptied and refilled by something else.
    expect(approvedIds(photosAfter.body)).toEqual(approvedIds(photosBefore.body));
    expect(approvedIds(photosAfter.body).length).toBeGreaterThan(0);
    expect(await discoverySees(bobToken, alice)).toBe(true);
  });

  it('ignores a client that declares itself complete and its own photos approved', async () => {
    const mallory = await signUp('mallory-liar', 'mallory.liar@example.test');
    const lied = await call(harness, 'PUT', '/v1/profiles/me', mallory.token, {
      ...CONTENT,
      state: 'complete',
      photos: [{ photoId: 'forged-1', approval: 'approved' }],
    });
    expect(lied.status).toBe(200);
    // Not believed. Completeness is evaluated and the state comes from the
    // machine, so an assertion in the body is inert.
    expect(lied.body['complete']).toBe(false);
    expect(lied.body['state']).not.toBe('complete');
    expect(lied.body['missing']).toContain('photos');

    // And no forged photo was stored: the list is read from the table, where only
    // a screening verdict can put a row in.
    const photos = await call(harness, 'GET', '/v1/profiles/me/photos', mallory.token);
    expect(approvedIds(photos.body)).toEqual([]);
  });

  // ------------------------------------------------------------------ unset axes --

  it('shows an eligible candidate to a user who has expressed no preference at all', async () => {
    // Asked while there is genuinely nothing stored. The unset rule says "nobody"
    // is never the reading, so the assertion has to be made from the far side of
    // the eligibility gate, where a misread would actually bite.
    const peg = await signUp('peg-unset', 'peg.unset@example.test');
    await verify(harness, peg.token, peg.userId, PASSING_RESULT);
    await completeProfile(peg.token);

    const preferences = await call(harness, 'GET', '/v1/profiles/me/preferences', peg.token);
    expect(preferences.status).toBe(200);
    expect(preferences.body['preferences']).toEqual({
      ageRange: null,
      maxDistanceKm: null,
      seekingGenders: null,
      openTo: null,
      locationPrecision: null,
    });

    expect(await discoverySees(peg.token, bob)).toBe(true);
  });

  it('stores a preference set the domain calls satisfiable and refuses one that is not', async () => {
    const trent = await signUp('trent-prefs', 'trent.prefs@example.test');
    const good = await call(harness, 'PUT', '/v1/profiles/me/preferences', trent.token, {
      ageRange: { min: 28, max: 40 },
      maxDistanceKm: 25,
      seekingGenders: ['woman'],
      openTo: ['woman', 'non_binary'],
    });
    expect(good.status).toBe(200);

    // An empty list would mean "nobody", which is the reading the unset rule
    // exists to prevent; the domain refuses it rather than storing it.
    const empty = await call(harness, 'PUT', '/v1/profiles/me/preferences', trent.token, {
      seekingGenders: [],
    });
    expect(empty.status).toBe(400);

    // A distance limit that is not a band edge could not be compared against a
    // band, so accepting it would store a number no query can honour.
    const offEdge = await call(harness, 'PUT', '/v1/profiles/me/preferences', trent.token, {
      maxDistanceKm: 7,
    });
    expect(offEdge.status).toBe(400);

    // Refining below the platform's floor is refused rather than clamped: a
    // silent clamp is a privacy setting that looks honoured and is not.
    const tooFine = await call(harness, 'PUT', '/v1/profiles/me/preferences', trent.token, {
      locationPrecision: 'lt_5_km',
    });
    expect(tooFine.status).toBe(400);

    const read = await call(harness, 'GET', '/v1/profiles/me/preferences', trent.token);
    const stored2 = read.body['preferences'] as Record<string, unknown>;
    expect(stored2['maxDistanceKm']).toBe(25);
  });

  // ------------------------------------------------------------ no coordinate, ever --

  it('never returns a coordinate, on the write, the read, or the refusal', async () => {
    const ursula = await signUp('ursula-location', 'ursula.location@example.test');
    const latitude = 51.507351;
    const longitude = -0.127758;

    const written = await call(harness, 'PUT', '/v1/profiles/me/location', ursula.token, {
      latitude,
      longitude,
    });
    expect(written.status).toBe(200);
    // The write acknowledges and says nothing else: no echo of the point, and no
    // band derived from it against the owner themselves, which would be
    // `lt_5_km` for every account and true of none of them.
    expect(JSON.stringify(written.body)).not.toContain(String(latitude));
    expect(JSON.stringify(written.body)).not.toContain(String(longitude));

    const read = await call(harness, 'GET', '/v1/profiles/me/location', ursula.token);
    expect(read.status).toBe(200);
    // A band from `coarseDistanceBand`, and no field named after a coordinate even
    // when its value happens not to appear.
    expect(read.body['band']).toBe('lt_5_km');
    const serialised = JSON.stringify(read.body);
    expect(serialised).not.toContain('latitude');
    expect(serialised).not.toContain('longitude');
    expect(serialised).not.toContain(String(latitude));
    expect(serialised).not.toContain(String(longitude));

    // The profile read, which is what a client renders from, carries no point.
    await call(harness, 'PUT', '/v1/profiles/me', ursula.token, CONTENT);
    const profile = await call(harness, 'GET', '/v1/profiles/me', ursula.token);
    expect(JSON.stringify(profile.body)).not.toContain(String(latitude));
    expect(JSON.stringify(profile.body)).not.toContain(String(longitude));

    // A malformed coordinate is refused at the boundary, and the refusal names
    // the field rather than echoing the value it refused.
    const refused = await call(harness, 'PUT', '/v1/profiles/me/location', ursula.token, {
      latitude: 999,
      longitude: 0,
    });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).not.toContain('999');
  });

  it('stores the anchor classified sensitive and quantised rather than as a raw fix', async () => {
    const vic = await signUp('vic-location', 'vic.location@example.test');
    await call(harness, 'PUT', '/v1/profiles/me/location', vic.token, {
      latitude: 48.8566,
      longitude: 2.3522,
    });
    const stored = await harness.pool.query(
      'SELECT sensitivity, latitude FROM app.location_anchors WHERE user_id = $1',
      [vic.userId],
    );
    // The classification is a column with a CHECK, so it cannot be downgraded by
    // a later write, and it is `sensitive` because the precise point is. The
    // point is quantised onto a coarse grid first, so a stationary user is not a
    // track.
    expect(stored.rows[0]['sensitivity']).toBe('sensitive');
    expect(Math.abs(Number(stored.rows[0]['latitude']) - 48.8566)).toBeGreaterThan(0.01);
  });

  it('refuses a media handle that is a URL or a path, because the column has no address in it', async () => {
    const wendy = await signUp('wendy-assets', 'wendy.assets@example.test');
    await call(harness, 'PUT', '/v1/profiles/me', wendy.token, CONTENT);
    for (const handle of ['https://cdn.example.test/original.jpg', '/var/data/original.jpg']) {
      const uploaded = await call(harness, 'POST', '/v1/profiles/me/photos', wendy.token, {
        mediaAssetId: handle,
        altText: ALT,
      });
      // A 400 naming the field, not a constraint violation reported as a 500: the
      // caller sent something wrong, and a client told "internal error" learns
      // nothing about which field.
      expect(uploaded.status).toBe(400);
      expect(uploaded.body['error']).toMatchObject({ details: { field: 'mediaAssetId' } });
    }
    // Neither attempt left a row behind.
    const photos = await call(harness, 'GET', '/v1/profiles/me/photos', wendy.token);
    expect(photos.body['photos']).toEqual([]);
  });

  // --------------------------------------------------------- one profile, one owner --

  it('refuses to read or write another member profile by guessing an id', async () => {
    const xena = await signUp('xena-guesser', 'xena.guesser@example.test');

    // `/me` has no id in the path, so there is nothing to guess: both the read and
    // the write answer with the caller's own profile.
    const ownRead = await call(harness, 'GET', '/v1/profiles/me', xena.token);
    expect(ownRead.status).toBe(200);
    expect(ownRead.body['profileId']).toBe(`profile:${xena.userId}`);

    // The older shape takes an id from the path, so it has to check it. The
    // answer is `not_found`, not `permission_denied`: a 403 would confirm the id
    // belongs to somebody, which is the probe being made.
    const forged = await call(harness, 'PUT', `/v1/accounts/${alice}/profile`, xena.token, {
      ...CONTENT,
      displayName: 'Not Xena',
    });
    expect(forged.status).toBe(404);
    const forgedPrefs = await call(harness, 'PUT', `/v1/accounts/${alice}/preferences`, xena.token, {
      seekingGenders: ['woman'],
    });
    expect(forgedPrefs.status).toBe(404);

    // Alice's profile is untouched by either attempt.
    const aliceProfile = await call(harness, 'GET', '/v1/profiles/me', aliceToken);
    expect(aliceProfile.status).toBe(200);
    expect(aliceProfile.body['complete']).toBe(true);
  });

  it('answers identically for another member photo and for a photo that does not exist', async () => {
    const xena = await signUp('xena-photos', 'xena.photos@example.test');
    await call(harness, 'PUT', '/v1/profiles/me', xena.token, CONTENT);
    const mine = await call(harness, 'POST', '/v1/profiles/me/photos', xena.token, {
      mediaAssetId: mediaHandle('xena'),
      altText: ALT,
    });
    const mineId = photoIdOf(mine.body['photo']);
    const alicePhotos = await call(harness, 'GET', '/v1/profiles/me/photos', aliceToken);
    const theirs = String((alicePhotos.body['photos'] as Record<string, unknown>[])[0]?.['photoId']);

    const stolen = await call(harness, 'DELETE', `/v1/profiles/me/photos/${theirs}`, xena.token);
    const missing = await call(harness, 'DELETE', `/v1/profiles/me/photos/${randomUUID()}`, xena.token);
    // Indistinguishable: a photo that is not yours and a photo that does not
    // exist are the same refusal, so the answer confirms nothing.
    expect(stolen.status).toBe(404);
    expect(stolen.body).toEqual(missing.body);
    // And Xena's own photo is still there.
    expect(await photoRow(xena.token, mineId)).not.toBeNull();
  });

  // ------------------------------------------------------------ the photo pipeline --

  it('orders the set explicitly, with index 0 as the primary', async () => {
    const yuki = await signUp('yuki-order', 'yuki.order@example.test');
    await call(harness, 'PUT', '/v1/profiles/me', yuki.token, CONTENT);
    const ids = await approvePhotos(yuki.token, APPROVED_PHOTOS);

    const listed = await call(harness, 'GET', '/v1/profiles/me/photos', yuki.token);
    const rows = listed.body['photos'] as Record<string, unknown>[];
    expect(rows.find((row) => row['primary'] === true)?.['photoId']).toBe(ids[0]);
    expect(rows.filter((row) => row['position'] !== null).map((row) => row['position'])).toEqual([0, 1, 2]);

    // Reordering is explicit, and index 0 afterwards is whoever the owner put
    // there — not a "best photo" heuristic and not a separate flag that can
    // disagree with the order.
    const moved = await call(harness, 'PUT', '/v1/profiles/me/photos/order', yuki.token, {
      photoIds: [ids[2], ids[1], ids[0]],
    });
    expect(moved.status).toBe(200);
    const after = moved.body['photos'] as Record<string, unknown>[];
    expect(after.find((row) => row['primary'] === true)?.['photoId']).toBe(ids[2]);

    // An order that is not exactly the set is refused rather than quietly
    // dropping a photo out of it.
    const partial = await call(harness, 'PUT', '/v1/profiles/me/photos/order', yuki.token, {
      photoIds: [ids[0]],
    });
    expect(partial.status).toBe(400);
  });

  it('reports a photo awaiting a verdict without a handle, and with one once approved', async () => {
    const zara = await signUp('zara-audit', 'zara.audit@example.test');
    await call(harness, 'PUT', '/v1/profiles/me', zara.token, CONTENT);
    const uploaded = await call(harness, 'POST', '/v1/profiles/me/photos', zara.token, {
      mediaAssetId: mediaHandle('audit'),
      altText: ALT,
    });
    const photoId = photoIdOf(uploaded.body['photo']);

    // The owner's audit trail is the whole set: a photo whose verdict has not
    // arrived is as much theirs as an approved one.
    const before = await photoRow(zara.token, photoId);
    expect(before?.['state']).toBe('scanning');
    expect(before).not.toHaveProperty('mediaAssetId');

    const approved = await call(harness, 'PUT', `/v1/profiles/me/photos/${photoId}/screening`, zara.token, {
      verdict: 'clean',
    });
    expect(approved.status).toBe(200);
    const after = await photoRow(zara.token, photoId);
    expect(after?.['state']).toBe('approved');
    // The handle is the media service's opaque id and the only reference there is:
    // no scheme, no path separator, no byte count. It cannot be turned into an
    // address by anything reading this response.
    const handle = after?.['mediaAssetId'];
    expect(typeof handle).toBe('string');
    expect(handle).not.toContain('/');
    expect(handle).not.toContain(':');
    expect(after).not.toHaveProperty('url');
    expect(after).not.toHaveProperty('path');
    expect(after).not.toHaveProperty('bytes');
  });

  it('refuses a second approval of an already-approved photo', async () => {
    // The machine has no edge out of `approved`, so a replayed verdict is a
    // refusal rather than a second publication.
    const zoe = await signUp('zoe-replay', 'zoe.replay@example.test');
    await call(harness, 'PUT', '/v1/profiles/me', zoe.token, CONTENT);
    const uploaded = await call(harness, 'POST', '/v1/profiles/me/photos', zoe.token, {
      mediaAssetId: mediaHandle('replay'),
      altText: ALT,
    });
    const photoId = photoIdOf(uploaded.body['photo']);
    expect(
      (await call(harness, 'PUT', `/v1/profiles/me/photos/${photoId}/screening`, zoe.token, { verdict: 'clean' }))
        .status,
    ).toBe(200);
    const replay = await call(harness, 'PUT', `/v1/profiles/me/photos/${photoId}/screening`, zoe.token, {
      verdict: 'clean',
    });
    expect(replay.status).toBe(409);
  });
});

// ------------------------------------------------------------------- helpers --

/**
 * Sign-up through the real endpoint.
 *
 * Written out here rather than imported from the shared fixture because every
 * account needs an `account_onboarding` row: R8's age is read from there and
 * never from the profile body, so an account without one could never complete
 * and the suite would be testing the wrong thing.
 *
 * The contact carries a per-run suffix. Sign-up answers `202` rather than `201`
 * for a contact it has already seen — deliberately, so the endpoint cannot be
 * used to ask whether somebody has an account — so a fixed address would make
 * this suite pass exactly once against a persistent database and fail forever
 * after.
 *
 * The presented address rotates per call. §10's `signup_per_ip` admits 5 per
 * address per hour, and this suite creates eighteen accounts — every request
 * arriving from `127.0.0.1` would spend one shared bucket and the sixth would be
 * refused, which is the limit working rather than the suite being wrong. Eighteen
 * sign-ups from one address is not a thing a person does either; each account
 * here is its own connection, which is what eighteen accounts actually are. The
 * address is presented through the trusted-hop seam, so the socket path this
 * suite never exercises is unchanged.
 */

/** A per-run octet, so two runs never share a `signup_per_ip` bucket. */
const RUN_OCTET = Math.floor(Math.random() * 254) + 1;

let signUpSubject = 0;
async function signUp(
  label: string,
  contact: string,
): Promise<{ readonly userId: UserId; readonly token: string }> {
  signUpSubject += 1;
  harness.fromAddress(`198.${RUN_OCTET}.${Math.floor(Math.random() * 254) + 1}.${signUpSubject}`);
  const response = await call(harness, 'POST', '/v1/accounts', label, {
    contact: `${contact.split('@')[0]}-${RUN_ID}@example.test`,
    password: 'a-long-enough-password',
    dateOfBirth: '1994-04-01',
    termsVersion: '2026-09-01',
  });
  if (response.status !== 201) {
    throw new Error(`sign-up returned ${response.status}: ${JSON.stringify(response.body)}`);
  }
  // The session sign-up minted, not a statically registered caller: the resolver
  // resolves a bearer token through the session table, so this is the token the
  // account actually holds.
  const session = response.body['session'] as Record<string, unknown> | undefined;
  const issued = session?.['token'];
  if (typeof issued !== 'string') {
    throw new Error(`sign-up minted no session: ${JSON.stringify(response.body)}`);
  }
  return { userId: castId<'UserId'>(String(response.body['userId'])), token: issued };
}

/** Write the content and approve enough photos for the profile to be complete. */
async function completeProfile(token: string): Promise<void> {
  const written = await call(harness, 'PUT', '/v1/profiles/me', token, CONTENT);
  if (written.status !== 200) {
    throw new Error(`writing content returned ${written.status}: ${JSON.stringify(written.body)}`);
  }
  await approvePhotos(token, APPROVED_PHOTOS);
}

/**
 * Upload one photo and approve it through the screening boundary.
 *
 * The verdict is posted as the media scanner's, because that is what the
 * boundary is for: #36 and Platform own the scanner and the likeness check, and
 * this route is where their verdicts arrive.
 */
async function approvePhoto(token: string, name: string): Promise<string> {
  const uploaded = await call(harness, 'POST', '/v1/profiles/me/photos', token, {
    mediaAssetId: mediaHandle(name),
    altText: ALT,
  });
  if (uploaded.status !== 201) {
    throw new Error(`uploading ${name} returned ${uploaded.status}: ${JSON.stringify(uploaded.body)}`);
  }
  const photoId = photoIdOf(uploaded.body['photo']);
  const verdict = await call(harness, 'PUT', `/v1/profiles/me/photos/${photoId}/screening`, token, {
    verdict: 'clean',
  });
  if (verdict.status !== 200) {
    throw new Error(`approving ${name} returned ${verdict.status}: ${JSON.stringify(verdict.body)}`);
  }
  return photoId;
}

/** Upload and approve `count` photos, returning their ids in set order. */
async function approvePhotos(token: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    ids.push(await approvePhoto(token, `bulk-${index}`));
  }
  return ids;
}

/** A media-service handle: opaque, and not an address. */
function mediaHandle(name: string): string {
  return `asset-${name}-${randomUUID().slice(0, 8)}`;
}

/** One photo row as its owner sees it, or `null` when it is not in the set. */
async function photoRow(token: string, photoId: string): Promise<Record<string, unknown> | null> {
  const listed = await call(harness, 'GET', '/v1/profiles/me/photos', token);
  const rows = listed.body['photos'] as Record<string, unknown>[];
  return rows.find((row) => row['photoId'] === photoId) ?? null;
}

/** The ids a response reports as approved, in set order. */
function approvedIds(body: Record<string, unknown>): string[] {
  const rows = body['photos'] as Record<string, unknown>[];
  return rows
    .filter((row) => row['state'] === 'approved')
    .sort((a, b) => Number(a['position']) - Number(b['position']))
    .map((row) => String(row['photoId']));
}

function photoIdOf(photo: unknown): string {
  if (typeof photo !== 'object' || photo === null || !('photoId' in photo)) {
    throw new Error(`expected a photo body, got ${JSON.stringify(photo)}`);
  }
  const id: unknown = photo.photoId;
  if (typeof id !== 'string') {
    throw new Error(`the photo body carries no string id: ${JSON.stringify(photo)}`);
  }
  return id;
}

/** The user ids a discovery page shows. */
function visibleIds(body: Record<string, unknown>): string[] {
  const cards = body['candidates'] as Record<string, unknown>[];
  return cards.map((card) => String(card['userId']));
}

/**
 * Whether one user's discovery page shows another.
 *
 * Asked against the page the account is actually on rather than page one:
 * discovery pages candidates by creation order, and a shared development database
 * carries accounts from earlier runs, so a page-one request would be testing the
 * size of the table instead of the eligibility gate.
 */
async function discoverySees(viewerToken: string, subject: UserId): Promise<boolean> {
  const page = await pageHolding(subject);
  const response = await call(harness, 'GET', `/v1/discovery?limit=20&offset=${page}`, viewerToken);
  expect(response.status).toBe(200);
  return visibleIds(response.body).includes(subject);
}

/** The page offset an account appears on in discovery's candidate ordering. */
async function pageHolding(subject: UserId): Promise<number> {
  const counted = await harness.pool.query(
    `SELECT count(*)::int AS before
       FROM app.users AS earlier, app.users AS target
      WHERE target.user_id = $1
        AND (earlier.created_at, earlier.user_id) < (target.created_at, target.user_id)`,
    [subject],
  );
  return (counted.rows[0] as { before: number }).before;
}
