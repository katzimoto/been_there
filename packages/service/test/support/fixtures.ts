import type { UserId } from '@been-there/core';
import { castId } from '@been-there/core';
import { type Caller, type Harness, call, member } from './harness.js';
import { CURRENT_TERMS_VERSION } from '../../src/accounts/terms.js';

/**
 * Fixtures both suites share.
 *
 * A profile the *dating domain* calls complete, and a provider result the
 * *identity policy* is willing to act on. Neither is written by hand to suit the
 * test: the profile carries three approved photos, a prompt, a gender identity, an
 * adult birthdate and a resolvable location because `evaluateProfileCompleteness`
 * asks for exactly those, and the result clears `CONFIDENCE_THRESHOLDS.verifiedFloor`
 * because that is the floor the kernel checks.
 */
export const COMPLETE_PROFILE = {
  displayName: 'Alex',
  bio: 'Long enough bio to satisfy the minimum length requirement here.',
  photos: [
    { photoId: 'p1', approval: 'approved' },
    { photoId: 'p2', approval: 'approved' },
    { photoId: 'p3', approval: 'approved' },
  ],
  prompts: [{ promptId: 'q1', text: 'answer' }],
  genderIdentities: ['woman'],
  birthdate: '1994-04-01',
  location: '25_50_km',
};

/**
 * The scores a suite asks the harness provider for.
 *
 * These used to be request bodies posted to `/provider-result`, which is how a
 * subject could post their own score and reach `verified`. They are now the
 * *only* way a suite moves the score — by configuring the provider the service
 * is wired to, which is the same seam a vendor adapter would occupy.
 *
 * `PASSING_RESULT` clears `CONFIDENCE_THRESHOLDS.verifiedFloor` (0.9);
 * `BORDERLINE_RESULT` sits below it, which is what routes an attempt to a human
 * rather than granting or refusing it automatically.
 */
export const PASSING_RESULT = { confidence: 0.96 } as const;

/** A score the policy sends to a human rather than deciding. */
export const BORDERLINE_RESULT = { confidence: 0.72 } as const;

export interface Created {
  readonly userId: UserId;
  readonly accountId: string;
}

let signUpCounter = 0;

/**
 * A distinct peer address per account, unique to this run.
 *
 * Two layers of uniqueness, both needed. `account_rate_limit_events` is
 * append-only and nothing prunes it, so a fixed test address accumulates every
 * attempt any earlier run made against it — without the per-run octets a later
 * run would read a count of five left by an earlier one and be refused for a
 * reason that has nothing to do with the code under test. And the counter itself
 * must be in the address, because the limit counts *attempts* from one address:
 five accounts may share one, the sixth may not.
 */
const ROTATION_OCTET_A = Math.floor(Math.random() * 254) + 1;
const ROTATION_OCTET_B = Math.floor(Math.random() * 254) + 1;

function rotationFor(sequence: number): string {
  return `198.${ROTATION_OCTET_A}.${ROTATION_OCTET_B}.${sequence}`;
}

/**
 * A real sign-up, not an empty body.
 *
 * Sign-up now requires a contact, a password, a date of birth and a terms
 * version — and it answers 202 for a contact it has seen before, because
 * telling a caller "this address already exists" is an account-enumeration hole.
 * A fixed address in a shared fixture therefore worked exactly once and every
 * later run got a 202 it did not expect.
 *
 * The contact carries a per-call suffix and the date of birth an adult one, so
 * each call creates a genuinely new, genuinely eligible account. The password
 * is deliberately weak-but-valid: it must satisfy the password rule without
 * appearing in the breach seed.
 */
export async function createAccount(harness: Harness, token: string): Promise<Created> {
  signUpCounter += 1;
  const contact = `member-${signUpCounter}-${Date.now().toString(36)}@example.test`;
  // §10's `signup_per_ip` admits 5 per address per hour, and this fixture is the
  // one every suite needing several people goes through. Left on the socket
  // address, the sixth account in a run was refused — correctly, since six
  // sign-ups from one address is not a thing a person does, but the failure
  // surfaced in an unrelated suite and read like a data problem.
  //
  // Rotated here rather than at each call site because a limit that is easy to
  // forget is a limit that will be: three suites needed the same one-line change
  // before this existed. The address is presented through the trusted-hop seam,
  // which is a production path, so what those suites exercise is unchanged.
  harness.fromAddress(rotationFor(signUpCounter));
  const response = await call(harness, 'POST', '/v1/accounts', token, {
    contact,
    password: 'correct-horse-battery-staple-42',
    dateOfBirth: '1990-06-15',
    termsVersion: CURRENT_TERMS_VERSION,
  });
  if (response.status !== 201) {
    throw new Error(`creating an account returned ${response.status}: ${JSON.stringify(response.body)}`);
  }
  return {
    userId: castId<'UserId'>(String(response.body['userId'])),
    accountId: String(response.body['accountId']),
  };
}

/**
 * A brand new person with their own session.
 *
 * Every like, pass, block and report is a statement about *who is asking*, and the
 * service reads the actor from the session rather than the body. Reusing an
 * existing account's token to act on a new account's behalf would have made every
 * interaction in the suite a statement by the wrong person — and the refusals
 * would have looked like domain behaviour rather than a harness bug.
 */
export async function newPeer(harness: Harness, callers: Caller[], token: string): Promise<Created> {
  const caller = member(token);
  callers.push(caller);
  const created = await createAccount(harness, token);
  caller.userId = created.userId;
  return created;
}

/**
 * One artefact per check, each of a different *kind*. `recordCapture` refuses a
 * retake of the same kind inside the retake cooldown, which is the domain's rule
 * and not something a test should route around by inventing timestamps.
 */
const ARTEFACTS = [
  { check: 'document_authenticity', kind: 'government_id_image' },
  { check: 'liveness', kind: 'liveness_video' },
  { check: 'likeness', kind: 'selfie_image' },
] as const;

/**
 * Run an account all the way to a decided identity.
 *
 * `result` is the score the **provider** reports, not a body the client posts.
 * It is `{ confidence }` and nothing else, and it is applied to
 * `harness.verification` before the attempt is submitted — so the sequence below
 * is the one a real deployment runs: the subject captures, the service asks its
 * provider, the provider answers.
 *
 * The last call carries no body. Posting a score to `/provider-result` is now a
 * `400`, and `clientScoreIsRefused` in `verification-boundary.test.ts` asserts
 * it — that is the whole point of this helper no longer accepting one.
 */
export async function verify(
  harness: Harness,
  token: string,
  userId: UserId,
  result: { readonly confidence: number },
): Promise<Record<string, unknown>> {
  harness.verification.scoreAs(result.confidence);
  const started = await call(
    harness,
    'POST',
    `/v1/accounts/${userId}/verification/attempts`,
    token,
    { reason: 'onboarding' },
  );
  if (started.status !== 201) {
    throw new Error(`starting a verification returned ${started.status}: ${JSON.stringify(started.body)}`);
  }
  const verificationId = String(started.body['verificationId']);
  for (const artefact of ARTEFACTS) {
    const captured = await call(
      harness,
      'POST',
      `/v1/accounts/${userId}/verification/attempts/${verificationId}/captures`,
      token,
      {
        check: artefact.check,
        kind: artefact.kind,
        storageRef: `ref:${artefact.check}`,
        digest: artefact.check.padEnd(64, '0'),
      },
    );
    if (captured.status !== 200) {
      throw new Error(
        `capturing ${artefact.check} returned ${captured.status}: ${JSON.stringify(captured.body)}`,
      );
    }
  }
  const submitted = await call(
    harness,
    'POST',
    `/v1/accounts/${userId}/verification/attempts/${verificationId}/submit`,
    token,
  );
  if (submitted.status !== 200) {
    throw new Error(`submitting returned ${submitted.status}: ${JSON.stringify(submitted.body)}`);
  }
  // No body. The service asks its provider; the client cannot name a score.
  const recorded = await call(
    harness,
    'POST',
    `/v1/accounts/${userId}/verification/attempts/${verificationId}/provider-result`,
    token,
  );
  if (recorded.status !== 200) {
    throw new Error(`recording the result returned ${recorded.status}: ${JSON.stringify(recorded.body)}`);
  }
  return recorded.body;
}
