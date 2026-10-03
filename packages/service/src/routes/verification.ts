import { randomUUID } from 'node:crypto';
import {
  type DomainError,
  type IdentityContext,
  type IdentityEvent,
  type Result,
  type UserId,
  type VerificationId,
  castId,
  domainError,
  identityMachine,
  ok,
} from '@been-there/core';
import type { IdentityRecordRow, Transaction } from '@been-there/contracts';
import {
  type IdentityStatusProjection,
  type ProviderSession,
  hasProjectionChanged,
  projectIdentityStatus,
  BIOMETRIC_EVIDENCE_KINDS,
  REQUIRED_CHECKS,
  type CaptureInput,
  type EvidenceKind,
  type VerificationAttempt,
  type VerificationCheck,
  type VerificationStartReason,
  beginCapture,
  completeFromProvider,
  escalateAfterRepeatedFailure,
  planVerificationStart,
  recordCapture,
  submitToProvider,
} from '@been-there/identity';
import { MISSING_FIELD, NOT_FOUND, UNKNOWN_FIELD_VALUE } from '../http/failure.js';
import { readEnum, readString } from '../http/body.js';
import { okResponse, route, type Route, type RouteRequest } from '../http/router.js';
import type { ServiceDependencies } from '../ports.js';
import { attemptOf, attemptPatchOf, attemptRowOf } from '../wiring/attempts.js';
import { userIdOf } from './accounts.js';
import { identityStateOf, subjectOf } from '../wiring/standing.js';
import { createServiceSafety } from '../wiring/safety.js';

/**
 * Verification, and the only place an identity state is ever written.
 *
 * ## There is no way to write `verified` from here
 *
 * `IdentityStore.insert` writes the state column directly, so the guarantee
 * cannot live in the store — the store is precisely the layer that must not know
 * the rules. It lives in `writeIdentityState`'s *signature*: it takes an
 * `IdentityEvent`, never an `IdentityState`. A caller that wants a new state has
 * to name an event, and `identityMachine.next` decides whether that event is
 * legal from where the account actually is and what its guards say. There is no
 * request shape — no state string, no boolean, no confidence — that reaches
 * `verified` without passing the kernel's guards, and in particular
 * `provider_result_received` requires confidence at or above the floor the
 * identity package publishes.
 *
 * The domain functions below are asked what event a step implies
 * (`planVerificationStart` returns `identity.viaEvent`, `completeFromProvider`
 * returns `identity.viaEvent`, `escalateAfterRepeatedFailure` returns
 * `viaEvent`) and this file hands that event back to the machine. The machine is
 * asked twice on purpose: once inside the domain function, to decide, and once
 * here, to write. A disagreement between the two is impossible because both are
 * the same call on the same table.
 *
 * ## Anomalies are not client input
 *
 * A client may *ask* whether a provider result is ready; it may not supply one.
 * It may not submit an `AnomalyFinding` either. A finding is a detector's
 * output, and letting a request carry one would hand every caller the power to
 * route their own verification to a human — or, since a `review`-level finding
 * also blocks an otherwise clean pass, to hold up their own verification
 * indefinitely. Detectors produce findings; this file passes what it has, which
 * is currently nothing.
 *
 * ## The score is never client input
 *
 * `provider-result` used to read `confidence` and `checks` out of the request
 * body and feed them straight to `completeFromProvider`. `resolveAttempt`
 * established only that the attempt belonged to the caller, so the subject could
 * post their own passing result and reach `verified` in one request. The 0.9
 * floor was applied faithfully — to a number the subject had chosen. That is not
 * a weaker verification; it is no verification at all, and nothing in readiness,
 * metrics or logs distinguished it from a real one.
 *
 * The score now arrives from `dependencies.verification`, the port's only
 * legitimate source, and a body carrying `confidence` or `checks` is *refused*
 * rather than ignored: a caller still sending one holds a belief about how
 * verification works that this code has just made false, and dropping the field
 * quietly would leave that belief standing. What remains client input is a
 * client asking whether a result is ready, which a real vendor would ordinarily
 * have the service poll; `202` with `pending: true` is the ordinary "not
 * finished yet" answer, not a failure.
 *
 * The identity machine, the attempt lifecycle and the 0.9 floor are untouched by
 * this and remain real controls. Only the score's *source* changed, and that is
 * the whole of what a wiring fix is supposed to change.
 */

/**
 * The checks a capture may contribute.
 *
 * `REQUIRED_CHECKS` is the identity package's own list and is the whole of what
 * can move an attempt to `awaiting_provider`; capturing a check the policy does
 * not require would be a write that cannot change any outcome. Identity
 * publishes no runtime list of the wider `VerificationCheck` union, and restating
 * one here would put a second definition of that vocabulary in the codebase.
 */
const CAPTURABLE_CHECKS: readonly VerificationCheck[] = REQUIRED_CHECKS;

/**
 * The evidence kinds a capture may name. `BIOMETRIC_EVIDENCE_KINDS` is the
 * shortest-retention subset identity does publish; the other two are the
 * non-biometric kinds, needed or a document image could not be captured at all.
 */
const EVIDENCE_KINDS: readonly EvidenceKind[] = [
  ...BIOMETRIC_EVIDENCE_KINDS,
  'document_text_extract',
  'provider_response',
];

const START_REASONS: readonly VerificationStartReason['code'][] = ['onboarding', 'user_requested'];


export function verificationRoutes(dependencies: ServiceDependencies): readonly Route[] {
  return [
    route('POST', '/v1/accounts/:userId/verification/attempts', async (request) => {
      const userId = userIdOf(request.params['userId']);
      if (!userId.ok) {
        return userId;
      }
      const reason = readEnum(request.body, 'reason', START_REASONS, 'onboarding');
      if (!reason.ok) {
        return reason;
      }
      const row = await dependencies.stores.identity.find(userId.value, request.tx);
      if (row === null) {
        return NOT_FOUND('account');
      }
      const subject = subjectOf(userId.value);
      const open = await dependencies.stores.verificationAttempts.findOpenFor(userId.value, request.tx);
      const planned = planVerificationStart({
        verificationId: castId<'VerificationId'>(randomUUID()),
        subjectId: subject,
        identityState: identityStateOf(row.state, userId.value),
        now: request.now,
        reVerification: false,
        reason: { code: reason.value } as VerificationStartReason,
        // The port can only offer the *open* attempt, so this is the whole of the
        // history the policy gets to see. `ATTEMPT_POLICY.maxAttemptsPerDay`
        // therefore cannot be enforced: counting a day's attempts needs a read
        // this port does not have, and passing an empty list to make the cap
        // "pass" would be inventing a policy the domain wrote.
        existing: open === null ? [] : [attemptOf(open)],
      });
      if (!planned.ok) {
        return planned;
      }
      // A started attempt is already capturing: the user is on the capture screen
      // by the time this returns, which is the only reason the first
      // `recordCapture` is reachable at all.
      const capturing = beginCapture(planned.value.attempt, request.now);
      if (!capturing.ok) {
        return capturing;
      }
      const written = await writeIdentityState(
        dependencies,
        userId.value,
        row,
        planned.value.identity.viaEvent,
        { reVerification: false },
        capturing.value.verificationId,
        request.now,
        request.tx,
      );
      if (!written.ok) {
        return written;
      }
      await dependencies.stores.verificationAttempts.insert(
        attemptRowOf(capturing.value),
        request.tx,
      );
      // The attempt, as an opaque id. `identity.reuse` pairs an attempt with a
      // later state change to see identity churn, and it can only do that if
      // something observed the attempt — without this the detector is in the
      // catalogue and unreachable from the service. The capture, the document
      // and the reason never cross: the attempt's id is the whole of it.
      await createServiceSafety(dependencies).recorder.observe(
        {
          kind: 'verification.attempt.started',
          userId: userId.value,
          verificationId: capturing.value.verificationId,
          at: request.now,
        },
        request.tx,
      );
      return okResponse(201, {
        verificationId: capturing.value.verificationId,
        attemptState: capturing.value.state,
        identityState: written.value.state,
        generation: written.value.generation,
        expiresAt: capturing.value.expiresAt.toISOString(),
      });
    }),

    route(
      'POST',
      '/v1/accounts/:userId/verification/attempts/:verificationId/captures',
      async (request) => {
        const attempt = await resolveAttempt(dependencies, request);
        if (!attempt.ok) {
          return attempt;
        }
        const check = readEnum(request.body, 'check', CAPTURABLE_CHECKS, 'document_authenticity');
        if (!check.ok) {
          return check;
        }
        const kind = readEnum(request.body, 'kind', EVIDENCE_KINDS, 'government_id_image');
        if (!kind.ok) {
          return kind;
        }
        const storageRef = readString(request.body, 'storageRef');
        if (!storageRef.ok) {
          return storageRef;
        }
        const digest = readString(request.body, 'digest');
        if (!digest.ok) {
          return digest;
        }
        const capture: CaptureInput = {
          check: check.value,
          kind: kind.value,
          storageRef: storageRef.value,
          digest: digest.value,
        };
        const recorded = recordCapture(attempt.value.attempt, capture, request.now);
        if (!recorded.ok) {
          return recorded;
        }
        await dependencies.stores.verificationAttempts.update(
          recorded.value.verificationId,
          attemptPatchOf(recorded.value, attempt.value.providerReference),
          request.tx,
        );
        return okResponse(200, {
          verificationId: recorded.value.verificationId,
          attemptState: recorded.value.state,
          completedChecks: recorded.value.completedChecks,
        });
      },
    ),

    route(
      'POST',
      '/v1/accounts/:userId/verification/attempts/:verificationId/submit',
      async (request) => {
        const attempt = await resolveAttempt(dependencies, request);
        if (!attempt.ok) {
          return attempt;
        }
        const submitted = submitToProvider(attempt.value.attempt, request.now);
        if (!submitted.ok) {
          return submitted;
        }
        // The provider session opens here, not at capture time, and its id is
        // persisted with the outcome so `releaseSession` can reach the adapter's
        // copy of the artefacts later. Before this, the reference was a
        // hardcoded `null` and no adapter was ever consulted — the handle the
        // erasure path in `evidence.ts` depends on was never written at all.
        const session = await dependencies.verification.startSession({
          correlationId: submitted.value.verificationId,
          reVerification: submitted.value.reVerification,
          checks: submitted.value.completedChecks,
        });
        if (!session.ok) {
          return session;
        }
        await dependencies.stores.verificationAttempts.update(
          submitted.value.verificationId,
          attemptPatchOf(submitted.value, session.value.sessionId),
          request.tx,
        );
        return okResponse(200, {
          verificationId: submitted.value.verificationId,
          attemptState: submitted.value.state,
          submittedAt: submitted.value.submittedAt?.toISOString() ?? null,
          providerMode: dependencies.verification.mode,
        });
      },
    ),

    route(
      'POST',
      '/v1/accounts/:userId/verification/attempts/:verificationId/provider-result',
      async (request) => {
        const attempt = await resolveAttempt(dependencies, request);
        if (!attempt.ok) {
          return attempt;
        }
        const userId = castId<'UserId'>(attempt.value.attempt.subjectId);
        const row = await dependencies.stores.identity.find(userId, request.tx);
        if (row === null) {
          return NOT_FOUND('account');
        }
        // The score comes from the adapter, never from the request body.
        //
        // This line is the whole reason `ServiceDependencies.verification` is
        // required. The body used to be the source of `confidence` and `checks`,
        // which meant the subject could post their own passing result and reach
        // `verified` in one request — the 0.9 floor was applied faithfully, to a
        // number the subject chose. A floor applied to a subject-chosen number is
        // not a weaker verification; it is no verification at all.
        //
        // A request body carrying a score is refused rather than ignored: a
        // caller still sending one after this change is a caller whose belief
        // about how verification works is wrong, and quietly dropping it would
        // leave that belief intact.
        if ('confidence' in request.body || 'checks' in request.body) {
          return domainError(
            'validation_failed',
            'identity',
            'a provider score is not accepted from a client; it comes from the configured verification provider',
            {
              refusedFields: Object.keys(request.body)
                .filter((field) => field === 'confidence' || field === 'checks')
                .join(','),
              providerMode: dependencies.verification.mode,
            },
          );
        }
        const result = await dependencies.verification.fetchResult(
          sessionFor(attempt.value.attempt, attempt.value.providerReference, request.now),
        );
        if (!result.ok) {
          return result;
        }
        if (result.value === null) {
          // The ordinary waiting case, not a failure. A vendor that has not
          // finished yet leaves the attempt exactly where it was.
          return okResponse(202, {
            verificationId: attempt.value.attempt.verificationId,
            attemptState: attempt.value.attempt.state,
            providerMode: dependencies.verification.mode,
            pending: true,
          });
        }
        const completed = completeFromProvider(
          attempt.value.attempt,
          identityStateOf(row.state, userId),
          result.value,
          [],
          request.now,
        );
        if (!completed.ok) {
          return completed;
        }

        // Repeated failure escalates to a person and to nothing else, and *when*
        // is the identity package's decision. `null` is the ordinary "not yet"
        // answer and is not an error.
        const prior = attempt.value.attempt;
        const escalation = escalateAfterRepeatedFailure({
          identityState: completed.value.identity.state,
          attempts: [prior, completed.value.attempt],
        });
        if (!escalation.ok) {
          return escalation;
        }
        const event: IdentityEvent = escalation.value === null
          ? completed.value.identity.viaEvent
          : escalation.value.viaEvent;
        const context: IdentityContext =
          completed.value.decision.confidence.band === 'unusable'
            ? {}
            : { confidence: completed.value.decision.confidence.value };
        const written = await writeIdentityState(
          dependencies,
          userId,
          row,
          event,
          context,
          completed.value.attempt.verificationId,
          request.now,
          request.tx,
        );
        if (!written.ok) {
          return written;
        }
        // The provider's handle is recorded with the outcome. The domain's
        // `VerificationAttempt` has no field for it — it is a fact about the
        // vendor's copy of the artefacts, not about the attempt — so the service
        // supplies it from the result it just accepted.
        await dependencies.stores.verificationAttempts.update(
          completed.value.attempt.verificationId,
          attemptPatchOf(completed.value.attempt, result.value.providerReference),
          request.tx,
        );
        return okResponse(200, {
          verificationId: completed.value.attempt.verificationId,
          attemptState: completed.value.attempt.state,
          decision: completed.value.decision.decision,
          rationale: completed.value.decision.rationale,
          confidence: completed.value.decision.confidence.value,
          identityState: written.value.state,
          generation: written.value.generation,
          escalatedToReview: escalation.value !== null,
        });
      },
    ),
  ];
}

/**
 * The attempt named by the path, checked against the account named by the path.
 *
 * A miss is `not_found`, because attempts are persisted: this id either exists
 * or it never did, and there is no third reading to confuse a client with.
 */
async function resolveAttempt(
  dependencies: ServiceDependencies,
  request: RouteRequest,
): Promise<Result<{ attempt: VerificationAttempt; providerReference: string | null }, DomainError>> {
  const userId = userIdOf(request.params['userId']);
  if (!userId.ok) {
    return userId;
  }
  const verificationId = request.params['verificationId'];
  if (verificationId === undefined) {
    return MISSING_FIELD('verificationId');
  }
  const row = await dependencies.stores.verificationAttempts.find(verificationId, request.tx);
  if (row === null) {
    return NOT_FOUND('verification attempt');
  }
  const attempt = attemptOf(row);
  if (attempt.subjectId !== subjectOf(userId.value)) {
    return domainError('permission_denied', 'identity', 'this attempt belongs to another account', {
      verificationId,
    });
  }
  // The provider's session id travels alongside the attempt rather than being
  // carried on the domain type: it is a fact about the *adapter's* copy of the
  // artefacts, and putting it on `VerificationAttempt` would put vendor state
  // inside the aggregate. Reading it here is what lets the erasure path in
  // `evidence.ts` name a session to release.
  const stored = row['providerReference'];
  return ok({
    attempt,
    providerReference: typeof stored === 'string' && stored.length > 0 ? stored : null,
  });
}

/**
 * The only writer of an identity state, and it takes an **event**, never a
 * state. See the module comment: this signature is the guarantee, not a check
 * inside it.
 *
 * The generation moves exactly when the state did, decided by the identity
 * package's own `hasProjectionChanged` rather than by a string comparison here,
 * and the store's compare-and-set turns a lost race into a `conflict` rather
 * than a silently overwritten state a human may be looking at.
 */
async function writeIdentityState(
  dependencies: ServiceDependencies,
  userId: UserId,
  previous: IdentityRecordRow,
  event: IdentityEvent,
  context: IdentityContext,
  verificationId: VerificationId,
  at: Date,
  tx: Transaction,
): Promise<Result<IdentityRecordRow, DomainError>> {
  const current = identityStateOf(previous.state, userId);
  const moved = identityMachine.next(current, event, context);
  if (!moved.ok) {
    return moved;
  }
  const subject = subjectOf(userId);
  const before: IdentityStatusProjection = projectIdentityStatus(
    { state: current, latestVerificationId: previous.latestVerificationId, generation: previous.generation },
    subject,
    previous.updatedAt,
  );
  const after: IdentityStatusProjection = projectIdentityStatus(
    { state: moved.value, latestVerificationId: verificationId, generation: previous.generation },
    subject,
    at,
  );
  const generation = hasProjectionChanged(before, after) ? previous.generation + 1 : previous.generation;
  const row: IdentityRecordRow = {
    userId,
    state: moved.value,
    generation,
    latestVerificationId: verificationId,
    updatedAt: at,
  };
  const applied = await dependencies.stores.identity.update(row, previous.generation, tx);
  if (!applied) {
    return domainError('conflict', 'identity', 'the identity state moved while this was being decided', {
      expectedGeneration: previous.generation,
    });
  }
  // That the state moved, and nothing about why. This is the only writer of an
  // identity state, so it is the only place the change can be observed; the
  // `before`/`after` projections above already compute exactly what changed and
  // deliberately discard them, which is why the fact was going unobserved.
  // No likeness score, no provider label and no artefact crosses: `identity.reuse`
  // pairs this with an attempt to see churn, and the projection has none of
  // those fields to give.
  await createServiceSafety(dependencies).recorder.observe(
    { kind: 'identity.status_changed', userId, at },
    tx,
  );
  return ok(row);
}

/**
 * The provider session to poll, rebuilt from the attempt's own timeline.
 *
 * `submit` persisted the adapter's session id in the `provider_reference`
 * column, and `attemptOf` deliberately does not surface it: it is a fact about
 * the *vendor's* copy of the artefacts, not about the attempt, and widening the
 * domain type to carry it would put vendor state inside the aggregate. So the
 * service reads it back from the store rather than inventing one.
 *
 * The timestamps are ours rather than the adapter's, which is sound because the
 * port makes no promise about them beyond `expiresAt` being a deadline — an
 * adapter that needs its own clock reads its own session store by
 * `sessionId`, and `stubProvider` ignores the field entirely.
 */
function sessionFor(
  attempt: VerificationAttempt,
  providerReference: string | null,
  now: Date,
): ProviderSession {
  return {
    // An attempt with no stored reference was never submitted, and the attempt
    // machine refuses a result for one — so this is unreachable in practice and
    // exists only so the type is total. It is deliberately *not* a fabricated
    // vendor id: inventing one would let a reader believe an adapter had been
    // asked about a session that does not exist.
    sessionId: providerReference ?? `unstarted-${attempt.verificationId}`,
    startedAt: attempt.submittedAt ?? attempt.startedAt,
    expiresAt: attempt.expiresAt > now ? attempt.expiresAt : now,
  };
}

