/**
 * The three operations every person in the walk goes through.
 *
 * Sign-up, a complete profile, and the four-call verification sequence. Each is
 * the same HTTP surface a client uses, in the same order, with the same request
 * shapes the suites use — `packages/service/test/support/fixtures.ts` is the
 * reference for the last one and this is deliberately its twin rather than a
 * tidier invention, because a demo that drives the product differently from its
 * own tests is a demo of the demo.
 *
 * One thing is worth saying plainly because a reader will otherwise assume
 * otherwise: the provider result is posted by *this* script. There is no
 * identity vendor in this repository and no outbound call to one. The score is
 * a fixture the walk supplies through the same endpoint the vendor's client
 * would use, and the identity machine's decision — which is the part under
 * demonstration — is made by the real domain code either way.
 */
import { at, expectStatus } from './client.mjs';

const TERMS_VERSION = '2026-09-01';
const PASSWORD = 'correct-horse-battery-staple-42';

/** The three artefacts the identity machine requires, one per required check. */
const ARTEFACTS = [
  { check: 'document_authenticity', kind: 'government_id_image' },
  { check: 'liveness', kind: 'liveness_video' },
  { check: 'likeness', kind: 'selfie_image' },
]


/** A per-run octet, so two walks never share an address and never share a bucket. */
const RUN_OCTET = Math.floor(Math.random() * 254) + 1;
let signUps = 0;

/**
 * Presents a distinct caller address for the next request.
 *
 * The walk creates four accounts against `SIGNUP_PER_IP_PER_HOUR` of five, so
 * leaving them all on the loopback socket would spend four fifths of one shared
 * bucket and leave nothing spare — which is how a fifth sign-up, added later by
 * someone extending the walk, would fail it for a reason that has nothing to do
 * with what the walk demonstrates.
 *
 * It is also what makes the limit meaningful rather than accidental: each
 * person arrives from their own network, which is what the limit is written to
 * reason about. `packages/service/test/support/fixtures.ts` does exactly this
 * and says why — "a limit that is easy to forget is a limit that will be".
 *
 * `203.0.113.0/24` is the documentation range, and distinct from the preflight's
 * addresses, so the two never contend for one bucket.
 */
export function presentAddress(client) {
  signUps += 1;
  const address = `203.0.113.${((RUN_OCTET + signUps) % 250) + 1}`;
  client.fromAddress(address);
  return address;
}

/**
 * `POST /v1/accounts`. Returns the account and the session token that
 * authenticates everything after it.
 */
export async function signUp(client, { name, contact, dateOfBirth }, say) {
  const address = presentAddress(client);
  const response = await client.call('POST', '/v1/accounts', undefined, {
    contact,
    password: PASSWORD,
    dateOfBirth,
    termsVersion: TERMS_VERSION,
  });
  say(`${name}: presented from ${address}, so no two accounts share a bucket`);
  expectStatus(response, 201, `${name}: sign-up`);
  const body = response.body;
  say(`${name}: userId ${at(body, 'userId')}`);
  say(`${name}: identity.state ${at(body, 'identity.state')}, identity.discoverable ${at(body, 'identity.discoverable')}`);
  // The age gate's other half. The date of birth went in; what comes out is a
  // band and nothing that identifies a person, because an age that is never on
  // the wire cannot be leaked off it.
  const wire = JSON.stringify(body);
  for (const forbidden of ['"age"', '"dateOfBirth"', dateOfBirth]) {
    if (wire.includes(forbidden)) {
      throw new Error(`${name}: the sign-up response carried ${forbidden}: ${wire}`);
    }
  }
  say(`${name}: ageBand ${at(body, 'ageBand')}; no age and no date of birth on the wire`);
  return {
    name,
    contact,
    token: String(at(body, 'session.token')),
    userId: String(at(body, 'userId')),
    accountId: String(at(body, 'accountId')),
    ageBand: String(at(body, 'ageBand')),
  };
}

/**
 * A profile the dating domain will call complete. Without one, discovery returns
 * nothing and every later step fails for a reason that has nothing to do with
 * what the walk is demonstrating, so it is done once per person and said out
 * loud.
 */
export async function completeProfile(client, person, say) {
  const response = await client.call(
    'PUT',
    `/v1/accounts/${person.userId}/profile`,
    person.token,
    {
      displayName: person.name,
      bio: `${person.name} has a profile long enough to satisfy the minimum length here.`,
      photos: [
        { photoId: `${person.name}-p1`, approval: 'approved' },
        { photoId: `${person.name}-p2`, approval: 'approved' },
        { photoId: `${person.name}-p3`, approval: 'approved' },
      ],
      prompts: [{ promptId: `${person.name}-q1`, text: 'an answer' }],
      genderIdentities: ['woman'],
      birthdate: '1990-06-15',
      location: '25_50_km',
    },
  );
  expectStatus(response, 200, `${person.name}: complete the profile`);
  if (at(response.body, 'complete') !== true) {
    throw new Error(
      `${person.name}: the profile did not become complete, missing ${JSON.stringify(at(response.body, 'missing'))}`,
    );
  }
  say(`${person.name}: profile state complete`);
}

/**
 * The four-call verification sequence: open an attempt, capture one artefact per
 * required check, submit, then ask whether the provider has a result.
 *
 * The last call carries no score. It used to post the client's own `confidence`
 * and check outcomes, and the service applied them faithfully — so this walk was
 * deciding who got verified, using the client's own number. It now sends no body
 * and the service asks its configured provider instead.
 *
 * The service in this walk runs the stub, so the number that comes back is the
 * stub's declared 0.95. Printing that as though it were a measurement would be
 * the exact misreading the readiness caveat exists to prevent, so the narration
 * says where it came from.
 */
export async function verify(client, person, say) {
  const base = `/v1/accounts/${person.userId}/verification/attempts`;
  const started = await client.call('POST', base, person.token, { reason: 'onboarding' });
  expectStatus(started, 201, `${person.name}: open a verification attempt`);
  const verificationId = String(at(started.body, 'verificationId'));
  say(`${person.name}: attempt ${verificationId}`);

  for (const artefact of ARTEFACTS) {
    const captured = await client.call(
      'POST',
      `${base}/${verificationId}/captures`,
      person.token,
      {
        check: artefact.check,
        kind: artefact.kind,
        storageRef: `ref:${artefact.check}`,
        digest: artefact.check.padEnd(64, '0'),
      },
    );
    expectStatus(captured, 200, `${person.name}: capture ${artefact.check}`);
  }
  say(`${person.name}: captured ${ARTEFACTS.length} artefacts, one per required check`);

  const submitted = await client.call('POST', `${base}/${verificationId}/submit`, person.token, {});
  expectStatus(submitted, 200, `${person.name}: submit the attempt`);
  say(
    `${person.name}: submitted; provider session opened, mode ` +
      `${at(submitted.body, 'providerMode')}`,
  );

  // No body. The service asks its configured provider; the client cannot name a
  // score, and posting one is refused rather than ignored.
  const recorded = await client.call(
    'POST',
    `${base}/${verificationId}/provider-result`,
    person.token,
  );
  expectStatus(recorded, 200, `${person.name}: ask the provider for a result`);
  say(
    `${person.name}: provider (stubbed) reported confidence ${at(recorded.body, 'confidence')} ` +
      `-> decision ${at(recorded.body, 'decision')}, identity.state ` +
      `${at(recorded.body, 'identityState')}, generation ${at(recorded.body, 'generation')}`,
  );
  return recorded.body;
}