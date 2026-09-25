import type { UserId } from '@been-there/core';
import { castId } from '@been-there/core';
import { type Caller, type Harness, call, member } from './harness.js';

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

export const PASSING_RESULT = {
  providerReference: 'vendor-session-1',
  confidence: 0.96,
  checks: [
    { check: 'document_authenticity', outcome: 'passed', score: 0.97, reason: null },
    { check: 'liveness', outcome: 'passed', score: 0.95, reason: null },
    { check: 'likeness', outcome: 'passed', score: 0.96, reason: null },
  ],
};

/** A result the policy sends to a human rather than deciding. */
export const BORDERLINE_RESULT = { ...PASSING_RESULT, confidence: 0.72 };

export interface Created {
  readonly userId: UserId;
  readonly accountId: string;
}

export async function createAccount(harness: Harness, token: string): Promise<Created> {
  const response = await call(harness, 'POST', '/v1/accounts', token);
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

export async function verify(
  harness: Harness,
  token: string,
  userId: UserId,
  result: unknown,
): Promise<Record<string, unknown>> {
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
  const recorded = await call(
    harness,
    'POST',
    `/v1/accounts/${userId}/verification/attempts/${verificationId}/provider-result`,
    token,
    result,
  );
  if (recorded.status !== 200) {
    throw new Error(`recording the result returned ${recorded.status}: ${JSON.stringify(recorded.body)}`);
  }
  return recorded.body;
}
