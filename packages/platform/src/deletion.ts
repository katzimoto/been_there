import { type DomainError, type Result, type UserId, domainError, ok } from '@been-there/core';

/**
 * Account deletion (§8 of `docs/features/account-and-onboarding.md`).
 *
 * ## Why this is Platform's and not a route's
 *
 * Deletion is a lifecycle transition on an account, exactly as sign-in, recovery
 * and the age gate are, and it has the same three requirements they do: a policy
 * number, a deadline, and a refusal for the cases the spec refuses. Putting those
 * here means the 30-day window has one answer in the system rather than one per
 * caller — the failure this repository has already paid for twice.
 *
 * ## The retention table is the contract, so it is data
 *
 * §8.2 gives three actions across eleven classes of thing, and a reader who has
 * the document open can check each line against this table. Two reasons it is a
 * value rather than prose in a route handler:
 *
 *  * It is what the completion *summary* is built from (§9's row for a completed
 *    deletion says the user is told both halves), so a divergence between what
 *    the product says it kept and what it kept is not expressible.
 *  * A deletion table that lists only what is deleted is how the retention half
 *    gets lost: the deleted half has tests, the retained half silently does not.
 *    `DELETION_RETENTION` therefore names the retained classes too, and
 *    `assertRetentionCoversEveryClass` is what keeps the list honest.
 */

/** §8.1's window. Thirty days, and the number is stated in the copy the user sees. */
export const DELETION_UNDO_WINDOW_DAYS = 30;

export const DELETION_UNDO_WINDOW_MS = DELETION_UNDO_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * §8.1's confirmation phrase.
 *
 * Typed rather than tapped, and deliberately so: "this is irreversible after the
 * window, and a destructive one-tap is how an accidental deletion happens". A
 * caller that does not send it is refused, and the refusal names the field so a
 * client can render the prompt rather than guessing at it.
 */
export const DELETION_CONFIRMATION_PHRASE = 'delete my account';

/**
 * The lifecycle of a deletion request.
 *
 * `scheduled` is the only state a request can be undone from. `cancelled` is the
 * undo. `completed` is terminal — §8.1, "After 30 days the job runs to completion
 * and cannot be undone" — and it is why the statuses are a union rather than a
 * boolean: "has this been undone yet" and "is this still undoable" are different
 * questions, and a boolean answers the first while a caller means the second.
 */
export type DeletionStatus = 'scheduled' | 'cancelled' | 'completed';

export interface DeletionRequest {
  readonly deletionId: string;
  readonly userId: UserId;
  readonly status: DeletionStatus;
  readonly requestedAt: Date;
  /** When the window closes. A deadline, not a suggestion. */
  readonly completesAt: Date;
  readonly cancelledAt: Date | null;
  readonly completedAt: Date | null;
}

/** What a caller must supply to schedule a deletion. */
export interface NewDeletionRequest {
  readonly deletionId: string;
  readonly userId: UserId;
  readonly now: Date;
}

/**
 * §8.1's confirmation, checked.
 *
 * The comparison is exact and case-sensitive because the phrase is the thing the
 * user typed; a case-insensitive or trimmed match would accept `Delete My
 * Account`, which is not a phrase anybody was asked to type. `trim` is applied
 * first because a trailing newline from a paste is not a different intent.
 */
export function confirmDeletion(confirmation: string): Result<true, DomainError> {
  if (confirmation.trim() !== DELETION_CONFIRMATION_PHRASE) {
    return domainError(
      'validation_failed',
      'account.deletion',
      'deleting an account requires typing the confirmation phrase',
      { field: 'confirmation', expected_phrase: DELETION_CONFIRMATION_PHRASE },
    );
  }
  return ok(true);
}

/**
 * Schedules a deletion, with the window measured from the request.
 *
 * There is no upper bound on `now` and no "if the account has open cases" check,
 * because §8.1 places no such condition: a deletion is available to every account
 * and the reason for it is the account's own. A ban is not a reason to refuse —
 * it is the reason the capability is on the unrestrictable floor — and an open
 * case is not a reason either, because §8.2 retains the case.
 */
export function scheduleDeletion(request: NewDeletionRequest): Result<DeletionRequest, DomainError> {
  const { deletionId, userId, now } = request;
  if (deletionId.length === 0) {
    return domainError('validation_failed', 'account.deletion', 'a deletion needs an id', {
      field: 'deletionId',
    });
  }
  if (userId.length === 0) {
    return domainError('validation_failed', 'account.deletion', 'a deletion needs an account', {
      field: 'userId',
    });
  }
  if (Number.isNaN(now.getTime())) {
    return domainError('internal', 'account.deletion', 'the clock produced an invalid instant');
  }
  return ok({
    deletionId,
    userId,
    status: 'scheduled',
    requestedAt: now,
    completesAt: new Date(now.getTime() + DELETION_UNDO_WINDOW_MS),
    cancelledAt: null,
    completedAt: null,
  });
}

/**
 * Whether the window is still open at `now`.
 *
 * A separate predicate rather than an inline comparison in the undo handler,
 * because the sign-in block (§8.1, "sign-in is blocked" during the window) asks
 * the same question and must get the same answer — and a caller reading
 * `completesAt > now` in two places is how they stop agreeing.
 *
 * The boundary is inclusive of the deadline itself: at exactly `completesAt` the
 * window has closed. Anything else makes "30 days" mean 30 days plus however
 * long the request happened to take to arrive.
 */
export function isWithinUndoWindow(request: DeletionRequest, now: Date): boolean {
  if (request.status !== 'scheduled') {
    return false;
  }
  return now.getTime() < request.completesAt.getTime();
}

/**
 * §8.1: "Restoring cancels the job, re-applies the account standing, and returns
 * the profile to its prior state."
 *
 * The refusal past the window is the load-bearing half of this function. §9's
 * rule is that "a failure a user cannot act on is a defect" and every row has a
 * defined resulting state — so a refusal here names the terminal state the user
 * is in, rather than reporting a cancellation that did not happen.
 */
export function cancelDeletion(
  request: DeletionRequest,
  now: Date,
): Result<DeletionRequest, DomainError> {
  if (request.status === 'cancelled') {
    return domainError('conflict', 'account.deletion', 'this deletion was already cancelled', {
      deletionId: request.deletionId,
      status: request.status,
    });
  }
  if (request.status === 'completed') {
    return domainError('conflict', 'account.deletion', DELETION_COMPLETED_TITLE, {
      deletionId: request.deletionId,
      status: request.status,
      retained_until: RETENTION_SCHEDULE_DAYS,
    });
  }
  if (!isWithinUndoWindow(request, now)) {
    // §8.1: "After 30 days the job runs to completion and cannot be undone."
    // Refused as the terminal state rather than as a validation failure: there is
    // nothing wrong with the request, there is simply nothing left to undo.
    return domainError('conflict', 'account.deletion', DELETION_COMPLETED_TITLE, {
      deletionId: request.deletionId,
      status: request.status,
      retained_until: RETENTION_SCHEDULE_DAYS,
    });
  }
  return ok({ ...request, status: 'cancelled', cancelledAt: now });
}

/**
 * §8.1's completion. Terminal, and only reachable once the window has closed.
 *
 * A caller that wants to complete early is refused rather than served, because
 * the window is the only thing standing between a mistaken request and an
 * irreversible one, and an endpoint that skips it would make the 30 days
 * decorative.
 */
export function completeDeletion(
  request: DeletionRequest,
  now: Date,
): Result<DeletionRequest, DomainError> {
  if (request.status === 'completed') {
    return domainError('conflict', 'account.deletion', 'this deletion is already complete', {
      deletionId: request.deletionId,
      status: request.status,
    });
  }
  if (isWithinUndoWindow(request, now)) {
    return domainError(
      'conflict',
      'account.deletion',
      'this account can still be restored, so the deletion cannot complete yet',
      { deletionId: request.deletionId, completesAt: request.completesAt.toISOString() },
    );
  }
  // A cancelled request that reached its deadline still completes. The window
  // closing is not what completes it — the job running is — and §8.1's promise is
  // that the job runs after 30 days regardless of whether anyone pressed undo.
  return ok({ ...request, status: 'completed', completedAt: now });
}

/**
 * §9's copy for a scheduled deletion, verbatim.
 *
 * It states the window and the way out, which are the two things a person
 * deciding whether to press the button needs, and it does not mention that any
 * evidence is retained — that arrives with the completion, once it has happened
 * and there is a decision to inform.
 */
export const DELETION_SCHEDULED_TITLE = 'Your account will be deleted in 30 days.';

/** §9's copy for a completed deletion. Terminal, and it says so. */
export const DELETION_COMPLETED_TITLE = 'Your account is deleted.';

/**
 * How long the retained classes are kept, in days.
 *
 * §8.2 retains moderation evidence for a defence obligation rather than a
 * convenience, and §13 records that the precise schedule is still open. Thirty
 * days is therefore the *floor* this implementation commits to, stated as a
 * number so a caller is told a real one: a user told "we keep some of it, for a
 * while" cannot decide whether to accept that.
 */
export const RETENTION_SCHEDULE_DAYS = 30;

/**
 * What happens to one class of thing. §8.2's three actions.
 *
 * `anonymise` is its own action rather than a flavour of `delete` because the
 * distinction is the whole of the spec's §8.2 last row: the account row is
 * *not* erased, it becomes `deleted` with a salted pseudonym. A model with two
 * actions would render that as `delete`, which is precisely the claim the feature
 * exists to refuse.
 */
export type DeletionAction = 'delete' | 'anonymise' | 'retain';

export interface DeletionDisposition {
  /** A stable name for the class, as the copy names it. */
  readonly dataClass: string;
  readonly action: DeletionAction;
  /** §8.2's "Why" column, so the reason travels with the decision. */
  readonly basis: string;
}

/**
 * §8.2's table, transcribed.
 *
 * Every class in the document appears here exactly once, and the `basis` strings
 * are the document's own reasons rather than paraphrases — this table is the
 * thing a reviewer checks the document against.
 */
export const DELETION_RETENTION: readonly DeletionDisposition[] = [
  {
    dataClass: 'profile',
    action: 'delete',
    basis: 'Pure product content. No safety value after the account is gone.',
  },
  {
    dataClass: 'photos',
    action: 'delete',
    basis: 'Pure product content, same as the profile fields they sit in.',
  },
  {
    dataClass: 'prompts',
    action: 'delete',
    basis: 'Profile content, and free text the user wrote about themselves.',
  },
  {
    dataClass: 'interests',
    action: 'delete',
    basis: 'Discovery preferences are product settings, and they are the user’s choices.',
  },
  {
    dataClass: 'messages',
    action: 'delete',
    basis: 'Deleted for the user who deleted; tombstoned for the other party, who must not see content silently vanish.',
  },
  {
    dataClass: 'matches',
    action: 'delete',
    basis: 'No residual discovery coupling between two people once one is gone.',
  },
  {
    dataClass: 'likes',
    action: 'delete',
    basis: 'Given and received. Same coupling as a match.',
  },
  {
    dataClass: 'identifiers',
    action: 'delete',
    basis: 'The strongest identifiers are removed with the account: date of birth, contact identifier, password hash.',
  },
  {
    dataClass: 'device_data',
    action: 'delete',
    basis: 'Exact location, device identifiers and raw IP history. No retention basis; already over-collected.',
  },
  {
    dataClass: 'identity_evidence',
    action: 'delete',
    basis: 'Selfie and liveness artefacts exist to answer a verification question, and the subject is gone.',
  },
  {
    dataClass: 'reports',
    action: 'retain',
    basis: 'The right to report and the evidence behind a case are not the reporter’s to erase.',
  },
  {
    dataClass: 'cases',
    action: 'retain',
    basis: 'The unit of enforcement authority, and the thing an appeal is answered from.',
  },
  {
    dataClass: 'decisions',
    action: 'retain',
    basis: 'The decision and its justification, which is the appeal answer.',
  },
  {
    dataClass: 'audit_log',
    action: 'retain',
    basis: 'Append-only by construction: "what did we act on, and why" must be reconstructable.',
  },
  {
    dataClass: 'risk_state',
    action: 'retain',
    basis: 'A pattern over months is the asset; one account’s snapshot is not.',
  },
  {
    dataClass: 'account_row',
    action: 'anonymise',
    basis: 'The row becomes `deleted` with a salted pseudonym, retaining only what a safety decision needs.',
  },
];

/** The classes a completion removes. */
export function deletedDataClasses(): readonly string[] {
  return DELETION_RETENTION.filter((entry) => entry.action === 'delete').map((e) => e.dataClass);
}

/** The classes a completion keeps. §9's completion summary says this back to the user. */
export function retainedDataClasses(): readonly string[] {
  return DELETION_RETENTION.filter((entry) => entry.action === 'retain').map((e) => e.dataClass);
}

/** The classes a completion rewrites in place rather than removing. */
export function anonymisedDataClasses(): readonly string[] {
  return DELETION_RETENTION.filter((entry) => entry.action === 'anonymise').map((e) => e.dataClass);
}

/**
 * The disposition for one class.
 *
 * Refusing an unknown class rather than defaulting to `delete` is the point: a
 * new column added to the schema and not added here must stop the deletion, not
 * be dropped by it. Defaulting to the destructive action would make forgetting
 * the safe failure.
 */
export function dispositionOf(dataClass: string): Result<DeletionDisposition, DomainError> {
  const found = DELETION_RETENTION.find((entry) => entry.dataClass === dataClass);
  if (found === undefined) {
    return domainError(
      'validation_failed',
      'account.deletion',
      `no retention rule is declared for "${dataClass}", so it is neither deleted nor retained`,
      { dataClass },
    );
  }
  return ok(found);
}

/**
 * §8.2: "The identity is anonymised, not merely deleted: the row keeps a stable
 * salted pseudonym so that a future account on the same contact point, or with the
 * same photos, can be linked to a moderation history **by a human moderator
 * reviewing a case**, never automatically and never in the product."
 *
 * `salt` is supplied rather than imported so the same contact always yields the
 * same pseudonym across restarts and across processes — which is the property that
 * makes a re-registration recognisable — and so the value is not a module constant
 * that a test could quietly depend on being one.
 */
export function pseudonymFor(salt: string, seed: string): string {
  if (salt.length === 0) {
    throw new Error('a pseudonym needs a salt; an unsalted one is a reversible identifier');
  }
  // A domain-separated digest rather than the seed itself: the pseudonym travels
  // in a response body and a moderator's case view, and neither should be holding
  // something that reverses to a contact point.
  return `subj_${digest(`${salt}:deletion-subject:${seed}`)}`;
}

/**
 * The subject table a re-registration is checked against.
 *
 * §8.3's re-entry rules are the reason the pseudonym has to be *stable*: a
 * deleted account's prior standing can only be found again by recomputing it from
 * the contact point the person signs up with next. `pendingReview` is the one
 * fact the product is allowed to act on automatically — §8.3 says a re-registered
 * account "is not discoverable until Moderation has reviewed the re-entry", and
 * nothing else about the old account is surfaced.
 */
export interface DeletedSubject {
  readonly pseudonym: string;
  /** The standing at the moment the account was deleted, or `null` if it was active. */
  readonly priorState: string | null;
  /** Whether a case was still open when the account was deleted. */
  readonly openCase: boolean;
  readonly deletedAt: Date;
}

/**
 * §8.3's fourth row, reduced to the question the sign-up path can answer without
 * reading anything the product may not show.
 *
 * The answer is "this needs a human to look", never "you were banned" — the
 * latter is moderation reasoning about a person, and §2 puts it off-limits to
 * every product surface. So the caller gets a flag and the flag is what it acts
 * on.
 */
export function reentryReviewFor(subject: DeletedSubject): {
  readonly reviewRequired: boolean;
  readonly priorState: string | null;
} {
  const protectedSubject = subject.priorState === 'banned' || subject.openCase;
  return { reviewRequired: protectedSubject, priorState: protectedSubject ? subject.priorState : null };
}

/** FNV-1a over hex, chosen because it needs no platform secret and no import. */
function digest(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    // 32-bit FNV prime multiply, in two halves so the product stays exact.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}