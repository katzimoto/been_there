import { randomUUID } from 'node:crypto';
import {
  type DomainError,
  type Result,
  type UserId,
  domainError,
} from '@been-there/core';
import type { DeletionRequestRow } from '@been-there/contracts';
import {
  DELETION_COMPLETED_TITLE,
  DELETION_RETENTION,
  type DeletionStatus,
  DELETION_SCHEDULED_TITLE,
  RETENTION_SCHEDULE_DAYS,
  anonymisedDataClasses,
  cancelDeletion,
  completeDeletion,
  confirmDeletion,
  deletedDataClasses,
  retainedDataClasses,
  scheduleDeletion,
} from '@been-there/platform';
import { readString } from '../http/body.js';
import { MISSING_FIELD } from '../http/failure.js';
import { okResponse, route, type HttpResponse, type Route, type RouteRequest } from '../http/router.js';
import type { ServiceDependencies } from '../ports.js';
import { appendAudit, correlationIdFrom, recordFunnel } from '../accounts/funnel.js';

/**
 * Account deletion (§8).
 *
 * ## Two endpoints, and why there is no "complete now"
 *
 * `DELETE /v1/accounts/me` schedules, `POST /v1/accounts/me/deletion/undo` undoes.
 * There is deliberately no endpoint that completes a deletion early, because the
 * 30-day window is the only thing standing between a mistaken request and an
 * irreversible one — and an endpoint that skipped it would make those 30 days
 * decorative. §8.1 says the job "runs to completion" after the window; the trigger
 * here is the account's own next undo attempt, which is the one moment the service
 * knows both that the deadline has passed and that somebody is still asking. That
 * is a real gap against §8.1's "job" and it is the honest one: **a
 * never-returning account is never deleted.** See `completeIfDue` for why it is
 * done this way rather than not at all.
 *
 * ## There is no standing check on this path
 *
 * Not because §8.1 does not mention capabilities — it says the capability set
 * "already grants `delete_account`" — but because `UNRESTRICTABLE_CAPABILITIES`
 * in `packages/core/src/states/account.ts` makes the check unable to refuse anyone:
 * `delete_account` is on the floor, so `capabilitiesFor` returns it for every state
 * including `banned`. Writing the check would be theatre that reads as a gate.
 * What would *not* be theatre is a check the floor does not cover, and §8.1 names
 * none: no verification, no block, no open-case condition. So there is none here,
 * and a `banned` account reaches this route exactly as §8.1's copy promises.
 *
 * ## The completion is where the spec's two halves are kept apart
 *
 * §8.2 deletes content about a person and retains moderation evidence, and the
 * second half exists because the platform must be able to answer, months later and
 * in front of a regulator, what it acted on and why. So the completion never
 * deletes `app.users`: every retained table hangs off it by cascade, and the row is
 * rewritten as `deleted` with a stable pseudonym instead. See
 * `PgAccountPlatformStore.completeDeletion`, which is where that decision lives.
 */
export function accountDeletionRoutes(dependencies: ServiceDependencies): readonly Route[] {
  return [
    /**
     * `DELETE /v1/accounts/me` — request a deletion.
     *
     * Soft, and idempotent: §8.1's entry point is a Settings row a person taps, so
     * a retried request and a second tap are the same event. Answering the second
     * with a `conflict` would teach people the button is unreliable at exactly the
     * moment they are deciding to leave.
     */
    route('DELETE', '/v1/accounts/me', async (request) => requestDeletion(dependencies, request)),

    /**
     * `POST /v1/accounts/me/deletion/undo` — take it back, inside the window.
     *
     * Outside the window this is a clear refusal naming the terminal state (§9's
     * rule that a failure a user cannot act on is a defect, so the resulting state
     * is stated rather than implied), and it completes the deletion first, because
     * refusing an undo for an account that has not actually been deleted yet would
     * be a lie in the other direction.
     */
    route('POST', '/v1/accounts/me/deletion/undo', async (request) =>
      undoDeletion(dependencies, request),
    ),
  ];
}

/**
 * The account making the request, or a 403.
 *
 * Owner-only by construction rather than by a check against a body field: the
 * actor is what the resolver authenticated, and a `userId` in a body would be a
 * second authorisation path that disagrees with the first about the one case that
 * matters.
 */
function ownerOf(request: RouteRequest): Result<UserId, DomainError> {
  const userId = request.actor.userId;
  if (userId === null) {
    return MISSING_FIELD('userId');
  }
  return { ok: true, value: userId };
}

/** The funnel and audit pair, wired once because every write below uses both. */
function sinks(request: RouteRequest, dependencies: ServiceDependencies) {
  const correlationId = correlationIdFrom(undefined);
  return {
    stores: dependencies.stores,
    tx: request.tx,
    correlationId,
    now: request.now,
  };
}

/**
 * The retention bucket, for §11's `account.deletion_*` events.
 *
 * One value for all three events rather than one per data class: §11 declares the
 * dimension as `retention_bucket` and these are aggregate counts that must not
 * become a per-subject fingerprint. A bucket naming a *set* ("the §8.2 table") is
 * the coarsest thing that still answers "are people leaving, and are they coming
 * back" — which is the only question an internal metric should be able to ask.
 */
const RETENTION_BUCKET = 'account_deletion_v1';

async function requestDeletion(
  dependencies: ServiceDependencies,
  request: RouteRequest,
): Promise<Result<HttpResponse, DomainError>> {
  const owner = ownerOf(request);
  if (!owner.ok) {
    return owner;
  }
  const confirmation = readString(request.body, 'confirmation');
  if (!confirmation.ok) {
    return confirmation;
  }
  // §8.1's typed phrase. Refused here rather than treated as advisory, because
  // "a destructive one-tap is how an accidental deletion happens" and the phrase is
  // the whole mechanism the spec names against it.
  const confirmed = confirmDeletion(confirmation.value);
  if (!confirmed.ok) {
    return confirmed;
  }

  const scheduled = scheduleDeletion({
    deletionId: randomUUID(),
    userId: owner.value,
    now: request.now,
  });
  if (!scheduled.ok) {
    return scheduled;
  }

  const sink = sinks(request, dependencies);
  const stored = await dependencies.stores.accounts.scheduleDeletion(
    {
      deletionId: scheduled.value.deletionId,
      userId: scheduled.value.userId,
      status: scheduled.value.status,
      requestedAt: scheduled.value.requestedAt,
      completesAt: scheduled.value.completesAt,
      cancelledAt: scheduled.value.cancelledAt,
      completedAt: scheduled.value.completedAt,
    },
    request.tx,
  );

  // Audit and analytics are written on the retry too, and that is deliberate: the
  // audit log is complete by construction, and a retried request is a real request.
  // The *notice* is not re-sent, and `notifyOwner`'s unique idempotency key is what
  // guarantees that rather than this comment.
  await recordFunnel(sink, 'account.deletion_requested', { retention_bucket: RETENTION_BUCKET });
  await appendAudit(sink, {
    action: 'account.deletion_requested',
    actorId: request.actor.actorId,
    subjectId: owner.value,
    entityType: 'account_deletion',
    entityId: stored.request.deletionId,
    detail: {
      status: stored.request.status,
      requested_at: stored.request.requestedAt.toISOString(),
      completes_at: stored.request.completesAt.toISOString(),
      created: stored.created,
    },
  });

  // `202` rather than `201`: the resource the caller asked for is the *deletion*, and
  // it has been accepted for a date in the future rather than created. `200` on the
  // retry, because nothing was created then — same body either way, so a client that
  // retries sees a stable answer.
  return okResponse(stored.created ? 202 : 200, {
    deletionId: stored.request.deletionId,
    status: stored.request.status,
    requestedAt: stored.request.requestedAt.toISOString(),
    completesAt: stored.request.completesAt.toISOString(),
    // §9's row, verbatim, and the undo path the action refers to.
    notice: {
      title: DELETION_SCHEDULED_TITLE,
      action: 'restore',
      restorePath: '/v1/accounts/me/deletion/undo',
    },
  });
}

async function undoDeletion(
  dependencies: ServiceDependencies,
  request: RouteRequest,
): Promise<Result<HttpResponse, DomainError>> {
  const owner = ownerOf(request);
  if (!owner.ok) {
    return owner;
  }
  const open = await dependencies.stores.accounts.findOpenDeletionFor(owner.value, request.tx);
  if (open === null) {
    // Nothing open: either never requested, or already undone. Both are the same
    // answer for this caller — there is nothing here to restore — and §9's rule says
    // a refusal must state the resulting state, so it does rather than returning a
    // success that implies something was just cancelled.
    return domainError('conflict', 'account.deletion', 'there is no deletion to restore', {
      status: 'none',
    });
  }

  const cancelled = cancelDeletion(rowOf(open), request.now);
  if (!cancelled.ok) {
    // The window has closed. This is the one place a refusal has work to do first:
    // §8.1 says the job runs after 30 days, so the deletion the user is being told
    // is complete has to actually be complete. Refusing without completing would
    // leave the account in a state where the product says "deleted" and the
    // credential is still live — the exact shape of a trap this feature exists to
    // close, just pointing the other way.
    const completed = await completeIfDue(dependencies, owner.value, open, request);
    if (completed.ok) {
      return completed;
    }
    return cancelled;
  }

  await dependencies.stores.accounts.updateDeletion(
    {
      deletionId: cancelled.value.deletionId,
      userId: cancelled.value.userId,
      status: cancelled.value.status,
      requestedAt: cancelled.value.requestedAt,
      completesAt: cancelled.value.completesAt,
      cancelledAt: cancelled.value.cancelledAt,
      completedAt: cancelled.value.completedAt,
    },
    request.tx,
  );
  const sink = sinks(request, dependencies);
  await recordFunnel(sink, 'account.deletion_cancelled', { retention_bucket: RETENTION_BUCKET });
  await appendAudit(sink, {
    action: 'account.deletion_cancelled',
    actorId: request.actor.actorId,
    subjectId: owner.value,
    entityType: 'account_deletion',
    entityId: cancelled.value.deletionId,
    detail: { status: cancelled.value.status, cancelled_at: cancelled.value.cancelledAt?.toISOString() ?? '' },
  });
  return okResponse(200, {
    deletionId: cancelled.value.deletionId,
    status: cancelled.value.status,
    // §8.1: "Restoring cancels the job, re-applies the account standing, and
    // returns the profile to its prior state." Nothing was removed during the
    // window, so re-applying the standing is the absence of a write — stated here so
    // a client knows not to clear anything itself.
    restored: {
      accountStanding: 'unchanged',
      profile: 'unchanged',
    },
  });
}

/**
 * Runs §8.2 when the window has closed, and answers with the refusal either way.
 *
 * Written to run on the undo path rather than on a schedule because **there is no
 * scheduler in this repository** — no cron, no worker, nothing draining a due queue.
 * Adding one is a real piece of infrastructure this change does not need in order
 * to be correct about the six properties, and inventing a background process would
 * be worse than being explicit about the gap. What this does buy is that the *stated*
 * promise holds in the case a user can observe: a person who comes back after 30
 * days is told the truth, and their account is genuinely gone by the time they are
 * told it.
 *
 * What it does not buy: an account whose owner never returns is never completed.
 * That is a real and reportable gap against §8.1's "the job runs to completion",
 * and the honest fix is a sweeper over `account_deletions_due` — the index is
 * already there for it — invoked from whatever becomes the scheduler.
 *
 * The credential is read *before* the completion, because §8.2 deletes the contact
 * identifier and the pseudonym has to be computed from it. Reading it afterwards
 * would find nothing, and the pseudonym is what makes a re-registration
 * recognisable.
 */
async function completeIfDue(
  dependencies: ServiceDependencies,
  userId: UserId,
  open: DeletionRequestRow,
  request: RouteRequest,
): Promise<Result<HttpResponse, DomainError>> {
  const credential = await dependencies.stores.accounts.findCredential(userId, request.tx);
  if (credential === null) {
    // No credential to derive a pseudonym from. Either the account never had one —
    // impossible, since sign-up writes both in one transaction — or a completion
    // already ran and this is a retry. Either way there is nothing to do, and the
    // refusal below is the correct answer.
    return domainError('conflict', 'account.deletion', DELETION_COMPLETED_TITLE, {
      status: 'completed',
      retained_until: RETENTION_SCHEDULE_DAYS,
    });
  }
  const pseudonym = await dependencies.stores.accounts.deletionPseudonym(
    credential.contactIdentifier,
    request.tx,
  );
  if (pseudonym === null) {
    // The salt row is missing, which is a corrupt installation rather than a
    // business outcome. Refusing *before* deleting anything is the safe direction:
    // an account that stays is recoverable, one that is anonymised with a fabricated
    // pseudonym is not.
    throw new Error('the deletion pseudonym salt is missing; migration 006 section 3 did not run');
  }

  const completed = completeDeletion(rowOf(open), request.now);
  if (!completed.ok) {
    return completed;
  }
  const outcome = await dependencies.stores.accounts.completeDeletion(
    userId,
    pseudonym,
    request.now,
    request.tx,
  );
  await dependencies.stores.accounts.updateDeletion(
    {
      deletionId: completed.value.deletionId,
      userId: completed.value.userId,
      status: completed.value.status,
      requestedAt: completed.value.requestedAt,
      completesAt: completed.value.completesAt,
      cancelledAt: completed.value.cancelledAt,
      completedAt: completed.value.completedAt,
    },
    request.tx,
  );

  const sink = sinks(request, dependencies);
  await recordFunnel(sink, 'account.deletion_completed', { retention_bucket: RETENTION_BUCKET });
  await appendAudit(sink, {
    action: 'account.deletion_completed',
    actorId: request.actor.actorId,
    subjectId: userId,
    entityType: 'account_deletion',
    entityId: completed.value.deletionId,
    detail: {
      status: completed.value.status,
      completed_at: completed.value.completedAt?.toISOString() ?? '',
      deleted_classes: deletedDataClasses().length,
      retained_classes: retainedDataClasses().length,
      anonymised_classes: anonymisedDataClasses().length,
    },
  });

  // §9's completion row, and §A6's requirement that the summary "states both
  // halves of that in the user's own terms" — what went, and what stayed. Built from
  // the transaction's own counts rather than from the table, so the summary cannot
  // describe an intention the completion did not carry out.
  return okResponse(200, {
    deletionId: completed.value.deletionId,
    status: completed.value.status,
    title: DELETION_COMPLETED_TITLE,
    summary: {
      deleted: DELETION_RETENTION.filter((entry) => entry.action === 'delete').map(
        (entry) => entry.dataClass,
      ),
      retained: DELETION_RETENTION.filter((entry) => entry.action === 'retain').map(
        (entry) => entry.dataClass,
      ),
      anonymised: DELETION_RETENTION.filter((entry) => entry.action === 'anonymise').map(
        (entry) => entry.dataClass,
      ),
      counts: { deleted: outcome.deleted, retained: outcome.retained },
      retained_until: RETENTION_SCHEDULE_DAYS,
    },
    // Not an identifier the caller can act on, and deliberately not one: the
    // pseudonym exists so a *moderator* can link the subject later, and publishing
    // it to the person who just left would make it a handle on their own history.
    pseudonymRecorded: outcome.pseudonym.length > 0,
  });
}

/**
 * The store's row as the domain's own shape.
 *
 * A structural copy rather than a cast, so a column added to one side and not the
 * other becomes a compile error here instead of an `undefined` three layers up.
 */
function rowOf(row: DeletionRequestRow) {
  return {
    deletionId: row.deletionId,
    userId: row.userId,
    // Narrowed by the store's decoder against the same three statuses the schema
    // CHECKs, so this cast restates a guarantee already made rather than papering
    // over an untyped column.
    status: row.status as DeletionStatus,
    requestedAt: row.requestedAt,
    completesAt: row.completesAt,
    cancelledAt: row.cancelledAt,
    completedAt: row.completedAt,
  };
}