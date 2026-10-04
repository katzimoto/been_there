import { StoreError } from './result.js';
import type { Page, PageResult, Transaction } from './result.js';
import type {
  AccountId,
  CaseId,
  ConversationId,
  MatchId,
  MessageId,
  ReportId,
  RiskAssessmentId,
  SubjectId,
  UserId,
  VerificationId,
} from '@been-there/core';

/**
 * The stores the end-to-end flow needs. Each is an interface the database
 * package implements and the service composes; neither is imported by a domain
 * package.
 *
 * Records are plain readonly data rather than domain class instances. A store
 * that returned a live aggregate would let a caller mutate it outside the
 * state machine, which is the one thing the transition tables exist to prevent.
 */

/** What the service holds for a user, spanning the domains that own it. */
export interface UserRecord {
  readonly userId: UserId;
  readonly accountId: AccountId;
  readonly createdAt: Date;
}

export interface UserStore {
  create(record: UserRecord, tx: Transaction): Promise<void>;
  find(userId: UserId, tx: Transaction): Promise<UserRecord | null>;
  findByAccount(accountId: AccountId, tx: Transaction): Promise<UserRecord | null>;
  /**
   * A page of candidate ids for discovery. Exists so discovery pages the
   * population rather than filtering whatever the request happened to supply —
   * a candidate set taken from the request is a filtered list wearing a page's
   * name. Eligibility is the domain's call, not this one's.
   */
  listCandidateIds(page: Page, tx: Transaction): Promise<readonly UserId[]>;
}

/**
 * Identity. The service stores the *state* the identity machine produced; the
 * machine is never bypassed, and there is deliberately no `setState` here.
 * A store that can write an identity state directly can hand out `verified` to
 * anyone, which is the whole product claim.
 */
export interface IdentityRecordRow {
  readonly userId: UserId;
  readonly state: string;
  readonly generation: number;
  readonly latestVerificationId: VerificationId | null;
  readonly updatedAt: Date;
}

export interface IdentityStore {
  /**
   * Creates the row. This is the one write with no generation check, and the
   * port does not pretend otherwise: a store cannot tell a state the machine
   * produced from one a caller hand-wrote, and adding a state list here would
   * be a second definition of the six states sitting next to the CHECK
   * constraint. The gate belongs in the service that calls this. Until it is
   * enforced there, this is a path by which a caller could write `verified`,
   * and the port says so rather than claiming a guarantee it does not provide.
   */
  insert(row: IdentityRecordRow, tx: Transaction): Promise<void>;
  /**
   * The current state and generation, or `null` for a user who has never
   * started verification.
   *
   * Not optional and not a convenience. `evaluateEligibility` reads the
   * viewer's and the candidate's identity state, and `recordLike` refuses a
   * like from anyone who is not `verified` — with no read there is no
   * standing, both of those rules are dead, and an unverified account becomes
   * indistinguishable from a verified one. That is the "verified for
   * everyone" failure the identity machine exists to prevent.
   *
   * The generation it returns is also what makes `update` a compare-and-set
   * rather than an unconditional write.
   */
  find(userId: UserId, tx: Transaction): Promise<IdentityRecordRow | null>;
  /**
   * Write-through of a state the identity machine produced. The generation is
   * part of the row so a stale write is detectable rather than silent.
   */
  update(row: IdentityRecordRow, expectedGeneration: number, tx: Transaction): Promise<boolean>;
}

/**
 * A verification attempt is a first-class aggregate with its own lifecycle, not
 * a transient flag on the identity row. It has to survive between "submit" and
 * "record the provider's result", which means it has to survive a restart: a
 * user who starts verification and loses the process would otherwise start over
 * at the gate into the product.
 */
export interface VerificationAttemptStore {
  insert(attempt: Readonly<Record<string, unknown>>, tx: Transaction): Promise<void>;
  find(attemptId: string, tx: Transaction): Promise<Readonly<Record<string, unknown>> | null>;
  findOpenFor(userId: UserId, tx: Transaction): Promise<Readonly<Record<string, unknown>> | null>;
  update(attemptId: string, patch: Readonly<Record<string, unknown>>, tx: Transaction): Promise<boolean>;
}

/**
 * Account standing: what the product surfaces read to decide what an account
 * may do, and whether it is visible in the product at all.
 *
 * Without it a ban has no effect on the product — the decision is recorded in
 * moderation and the account keeps its capabilities.
 */
export interface AccountStandingStore {
  find(userId: UserId, tx: Transaction): Promise<AccountStandingRow | null>;
  /**
   * Writes the standing a decision produced. `generation` is checked, as in
   * `IdentityStore.update`, so two concurrent writers cannot silently
   * last-write-wins over a sanction.
   *
   * `expectedGeneration: null` means "no row was read", so this inserts. It has
   * to: `generation` is NOT NULL in the schema, so before the first sanction
   * there is nothing to read and nothing to pass. Without the null the first
   * write would either be impossible or skip the check — and two concurrent
   * *first* sanctions would both take the skipping path, which is precisely
   * the silent last-write-wins this comment denies. Same shape as
   * `RiskStore.upsertAssessment`.
   */
  upsert(
    row: AccountStandingRow,
    expectedGeneration: number | null,
    tx: Transaction,
  ): Promise<boolean>;
}

export interface AccountStandingRow {
  readonly userId: UserId;
  readonly state: string;
  readonly capabilities: readonly string[];
  readonly visibleInProduct: boolean;
  readonly caseId: string | null;
  readonly decisionId: string | null;
  readonly generation: number;
  readonly updatedAt: Date;
}

/**
 * Platform account state. The credential, the date of birth, the terms version,
 * the sessions, the recovery requests and the contact verifications — the six
 * things an account is before it is a person who can be shown to anybody.
 *
 * It is one port rather than six because they are one transaction: a sign-up
 * writes a credential, an onboarding row and a session together, and splitting
 * them would let a caller commit two thirds of a sign-up.
 */
export interface CredentialRow {
  readonly userId: UserId;
  readonly contactKind: string;
  /** Already normalised at the edge. No other form is ever stored. */
  readonly contactIdentifier: string;
  readonly contactVerified: boolean;
  readonly passwordHash: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OnboardingRow {
  readonly userId: UserId;
  /** ISO `YYYY-MM-DD`. The age and the band are derived from it at read time. */
  readonly dateOfBirth: string;
  /** The recorded fact that the user was told the 18+ rule and agreed to it. */
  readonly ageAttested: boolean;
  readonly termsVersion: string;
  readonly termsAcceptedAt: Date;
  /** A city area. Never a coordinate; the column cannot hold one. */
  readonly coarseArea: string | null;
  readonly updatedAt: Date;
}

/**
 * One row of `account_sessions`.
 *
 * The row's subject is *discriminated*: `subjectKind` says which of `userId` and
 * `staffId` is the subject, and exactly one of them is set. A nullable `userId`
 * on its own is not enough, and that is the whole reason for the extra columns —
 * "there is no user" and "there is a moderator" are different facts, and a
 * reader given only `user_id IS NULL` cannot tell a moderator's session from a
 * row that was written by something that never resolved a subject at all. Every
 * "whose session is this" question would then have two answers, which is the
 * hazard the `account_sessions_one_subject` CHECK exists to remove at the
 * storage layer rather than in each reader.
 */
export interface SessionRow {
  readonly sessionId: string;
  /** The member subject, or `null` when `subjectKind` is `'staff'`. */
  readonly userId: UserId | null;
  /** `'member'` or `'staff'` — the discriminator the two columns below agree with. */
  readonly subjectKind: string;
  /** The staff subject, or `null` when `subjectKind` is `'member'`. */
  readonly staffId: string | null;
  /**
   * Whether the holder is a machine. Stored rather than carried on the in-memory
   * session, because `moderation.decision` refuses an automated actor and that
   * refusal reads this value on a *later* request. A flag that existed only at
   * issue time would read back as `false` and switch the guard off, which is the
   * one direction this column must never fail in.
   */
  readonly automated: boolean;
  readonly authMethod: string;
  readonly status: string;
  readonly tokenHash: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly refreshableUntil: Date;
  readonly lastActiveAt: Date;
  readonly revokedReason: string | null;
  readonly supersededBy: string | null;
  readonly deviceLabel: string | null;
  readonly coarseCity: string | null;
}

/**
 * A staff identity: a named human who may hold a moderation session, and the
 * credential that lets them sign in as one.
 *
 * `role` and `status` live here rather than on the session on purpose — see
 * migration 008. A demotion that only reached live sessions would take effect
 * one refresh window late, which is exactly when it is needed. The resolver
 * reads them on every request.
 */
export interface StaffIdentityRow {
  readonly staffId: string;
  /** `'email'` or `'phone'`, normalised by the edge, never stored in another form. */
  readonly contactKind: string;
  readonly contactIdentifier: string;
  /** `scrypt:N:r:p$salt$digest`, the same shape and verifier as a member's. */
  readonly passwordHash: string;
  /** The name that lands in `decisions.moderator_id` and every audit row. */
  readonly displayName: string;
  /** One of the four staff roles; the schema's CHECK refuses `'user'` and `'system'`. */
  readonly role: string;
  /** `'active'` or `'suspended'`. Suspension is the off switch. */
  readonly status: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * `StaffIdentityStore`: the directory, and the sessions a named moderator holds.
 *
 * It is deliberately a separate port from `AccountPlatformStore` rather than
 * more methods on it. A moderator is not a member — the migration says so and
 * the schema refuses to write one as the other — so a caller that reaches for
 * this port is a caller that has already decided it is acting as staff.
 */
export interface StaffIdentityStore {
  /**
   * Writes one identity. A second identity for the same contact is refused by
   * the unique index rather than resolved here: two staff sharing an address
   * would leave a session naming whichever row the store returned first.
   */
  insertStaff(row: StaffIdentityRow, tx: Transaction): Promise<void>;

  /** Sign-in's first read: the identity this contact belongs to, if any. */
  findStaffByContact(contactIdentifier: string, tx: Transaction): Promise<StaffIdentityRow | null>;

  /** The identity behind a live session, read on every authenticated request. */
  findStaff(staffId: string, tx: Transaction): Promise<StaffIdentityRow | null>;

  /**
   * Moves an identity in or out of `'suspended'`, stamping `updated_at`. The
   * boolean is the affected-row count, so a suspension of an identity that does
   * not exist says so instead of reading as success.
   */
  updateStaffStatus(staffId: string, status: string, at: Date, tx: Transaction): Promise<boolean>;

  /**
   * Revocation by identity: every session one named moderator holds.
   *
   * This is what signs a moderator out *everywhere* at once, which a member's
   * sign-out cannot do — a member owns exactly the sessions `listSessionsFor`
   * returns. The hazard this whole table exists to close is that the two queries
   * must not overlap: a member's sign-out that could see a moderator's session
   * would revoke a moderator's access because the member pressed a button, and
   * `listSessionsFor` filters on `user_id = $1`, which a staff row cannot match.
   */
  listSessionsForStaff(staffId: string, tx: Transaction): Promise<readonly SessionRow[]>;
}

export interface RecoveryRow {
  readonly recoveryId: string;
  readonly userId: UserId;
  readonly method: string;
  readonly status: string;
  /** A salted digest. The code or the link token is never stored. */
  readonly secretHash: string;
  readonly requestedAt: Date;
  readonly expiresAt: Date;
  readonly attempts: number;
  readonly consumedAt: Date | null;
  readonly revokedSessionIds: readonly string[];
}

export interface ContactVerificationRow {
  readonly verificationId: string;
  readonly userId: UserId;
  readonly channel: string;
  readonly status: string;
  readonly secretHash: string;
  readonly attempts: number;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface AnalyticsEventRow {
  readonly eventId: string;
  readonly type: string;
  readonly occurredAt: Date;
  readonly correlationId: string;
  /** Declared dimensions only, all scalar. `recordAnalyticsEvent` enforced it. */
  readonly properties: Readonly<Record<string, unknown>>;
}

export interface NoticeRow {
  readonly notificationId: string;
  readonly userId: UserId;
  readonly kind: string;
  readonly channel: string;
  readonly status: string;
  readonly suppressionReason: string | null;
  readonly idempotencyKey: string;
  readonly deliverAt: Date;
  readonly createdAt: Date;
}

/**
 * One account-deletion request (§8), with the 30-day window already resolved.
 *
 * `completesAt` is stored rather than recomputed from `requestedAt` on read, and
 * that is the load-bearing decision of the whole table: raising the window from 30
 * days to 45 must not retroactively extend the deadline of every request already
 * in flight. A computed column would, silently, for exactly the accounts that
 * asked to leave first.
 */
export interface DeletionRequestRow {
  readonly deletionId: string;
  readonly userId: UserId;
  /** `scheduled` | `cancelled` | `completed`, from `DELETION_RETENTION`'s domain. */
  readonly status: string;
  readonly requestedAt: Date;
  readonly completesAt: Date;
  readonly cancelledAt: Date | null;
  readonly completedAt: Date | null;
}

/**
 * What a deletion removed and what it kept, per §8.2.
 *
 * Counted rather than booleaned because "the profile was deleted" and "the profile
 * had nothing in it" are the same answer at the level of a flag, and only the
 * counts tell a caller whether the completion did what it said. `retained` is
 * deliberately present: a user told their account was deleted and nothing about
 * what survived has been told a half-truth (§9's completion row is honest about
 * both halves precisely because the retained set is real).
 */
export interface DeletionOutcome {
  readonly pseudonym: string;
  readonly deleted: Readonly<Record<string, number>>;
  readonly retained: Readonly<Record<string, number>>;
}

/**
 * The pseudonymous subject a completed deletion leaves behind, for §8.3's
 * re-registration check.
 *
 * `priorState` is the standing at deletion and `openCase` whether a case was
 * unresolved. Together they are the two conditions §8.3 names for holding a
 * re-registered account out of discovery. What is deliberately *not* here is the
 * pseudonym's derivation or the moderation history behind it — this row exists to
 * answer "does this contact point need a human to look at it", and §2 puts
 * moderation reasoning off limits to every product surface.
 */
export interface DeletedSubjectRow {
  readonly pseudonym: string;
  readonly priorState: string | null;
  readonly openCase: boolean;
  readonly deletedAt: Date;
}

/**
 * The rate-limit buckets Platform enforces, named so that a caller cannot invent
 * one. §10 gives the numbers; this names the things they are counted over.
 */
export type RateLimitBucket =
  | 'signup_per_ip'
  | 'signup_per_contact'
  | 'login_per_account'
  | 'recovery_per_account'
  | 'recovery_per_source'
  | 'contact_code_per_issued'
  | 'contact_link_reissue';

export interface AccountPlatformStore {
  findCredentialByContact(contactIdentifier: string, tx: Transaction): Promise<CredentialRow | null>;
  findCredential(userId: UserId, tx: Transaction): Promise<CredentialRow | null>;
  /**
   * Serialises concurrent sign-ups on the same contact identifier, so the
   * duplicate rules' read-then-write cannot interleave with another sign-up's.
   * Released when the transaction ends.
   */
  lockContact(contactIdentifier: string, tx: Transaction): Promise<void>;
  /**
   * Serialises rate-limit work for one subject within the current transaction.
   *
   * A count-then-record needs this to be a lock rather than a counter. Without
   * it, two concurrent sign-ups from one address can each read count=4 and each
   * pass a limit that admits one more — the limit would hold against a
   * sequential test and fail under real concurrency.
   *
   * A transaction-scoped advisory lock, keyed on (bucket, subjectKey), which is
   * why it belongs in the store: the service has no business issuing SQL, and a
   * `pg_advisory_xact_lock` inside a route would be a second place that knows
   * the store's dialect.
   */
  lockRateLimitSubject(bucket: string, subjectKey: string, tx: Transaction): Promise<void>;
  insertCredential(row: CredentialRow, tx: Transaction): Promise<void>;
  markContactVerified(userId: UserId, at: Date, tx: Transaction): Promise<boolean>;
  updatePasswordHash(userId: UserId, passwordHash: string, at: Date, tx: Transaction): Promise<boolean>;

  findOnboarding(userId: UserId, tx: Transaction): Promise<OnboardingRow | null>;
  insertOnboarding(row: OnboardingRow, tx: Transaction): Promise<void>;
  /** Terms acceptance is the only write here: a version and a timestamp. */
  acceptTerms(userId: UserId, termsVersion: string, at: Date, tx: Transaction): Promise<boolean>;
  recordCoarseArea(userId: UserId, coarseArea: string, at: Date, tx: Transaction): Promise<boolean>;

  insertSession(row: SessionRow, tx: Transaction): Promise<void>;
  /** Resolves a bearer token. The token is a digest; the row is the session. */
  findSessionByToken(tokenHash: string, tx: Transaction): Promise<SessionRow | null>;
  findSession(sessionId: string, tx: Transaction): Promise<SessionRow | null>;
  /** Every session an account holds, most recently active first. */
  listSessionsFor(userId: UserId, tx: Transaction): Promise<readonly SessionRow[]>;
  updateSession(row: SessionRow, tx: Transaction): Promise<boolean>;
  touchSession(sessionId: string, lastActiveAt: Date, tx: Transaction): Promise<boolean>;

  insertRecovery(row: RecoveryRow, tx: Transaction): Promise<void>;
  findRecovery(recoveryId: string, tx: Transaction): Promise<RecoveryRow | null>;
  findOpenRecoveryFor(userId: UserId, tx: Transaction): Promise<RecoveryRow | null>;
  updateRecovery(row: RecoveryRow, tx: Transaction): Promise<boolean>;

  /**
   * Expires every open verification for an account and returns how many it
   * expired, so a new link can be issued without violating the one-open-per-
   * account index and the caller can log what it superseded.
   */
  expireOpenContactVerifications(userId: UserId, at: Date, tx: Transaction): Promise<number>;
  insertContactVerification(row: ContactVerificationRow, tx: Transaction): Promise<void>;
  findOpenContactVerification(userId: UserId, tx: Transaction): Promise<ContactVerificationRow | null>;
  updateContactVerification(row: ContactVerificationRow, tx: Transaction): Promise<boolean>;

  recordRateLimitEvent(bucket: RateLimitBucket, subjectKey: string, at: Date, tx: Transaction): Promise<void>;
  countRateLimitEvents(bucket: RateLimitBucket, subjectKey: string, since: Date, tx: Transaction): Promise<number>;

  /** The metrics sink. Every row has been through `recordAnalyticsEvent`. */
  insertAnalyticsEvent(row: AnalyticsEventRow, tx: Transaction): Promise<void>;
  listAnalyticsEvents(type: string, since: Date, tx: Transaction): Promise<readonly AnalyticsEventRow[]>;

  /**
   * The notice ledger. The unique `idempotency_key` is what makes "the owner
   * learns once" structural rather than a rule someone has to remember, so a
   * duplicate raises the store's conflict error instead of sending twice.
   */
  insertNotice(row: NoticeRow, tx: Transaction): Promise<void>;
  listNoticesFor(userId: UserId, tx: Transaction): Promise<readonly NoticeRow[]>;

  // --- Account deletion (§8). The request is soft; the completion is not. ---

  /**
   * Schedules a deletion, or returns the one already scheduled.
   *
   * §8.1's idempotence, and it is enforced here rather than by the caller reading
   * first and writing second: a retried request and a double-tapped button are the
   * same event by the time they arrive, and two of them racing past a
   * read-then-write would produce two open requests with two deadlines. The
   * partial unique index decides it, and the *first* request's deadline is the one
   * returned — so a retry cannot extend the window, which is the failure a caller
   * reading `findOpenDeletion` first could still produce under concurrency.
   *
   * Returns the row that is now open, and `created: false` when this call found an
   * existing one rather than writing.
   */
  scheduleDeletion(
    row: DeletionRequestRow,
    tx: Transaction,
  ): Promise<{ readonly request: DeletionRequestRow; readonly created: boolean }>;

  /** The open request for an account, or `null`. Cancelled and completed are history. */
  findOpenDeletionFor(userId: UserId, tx: Transaction): Promise<DeletionRequestRow | null>;

  /**
   * A deletion by id.
 *
   * Separate from `findOpenDeletionFor` because "this request" and "this account's
   * current request" are different questions, and a caller that wanted the former
   * would otherwise have to search every row it could see to find it.
   */
  findDeletion(deletionId: string, tx: Transaction): Promise<DeletionRequestRow | null>;

  /** Moves a request to a terminal state. The CHECK constraints own what is legal. */
  updateDeletion(row: DeletionRequestRow, tx: Transaction): Promise<boolean>;

  /**
   * Performs the completion: removes §8.2's deleted classes, rewrites the account
   * row as `deleted` with a stable pseudonym, and returns what went.
   *
   * **The users row is never deleted**, and that is the whole design. Every table
   * in §8.2's retained column — reports, cases, decisions, the audit log, risk
   * signals, the standing — hangs off `app.users` by `ON DELETE CASCADE`, so
   * `DELETE FROM app.users` would take the moderation history with it. The row is
   * rewritten instead: no credential, no date of birth, no contact identifier, and
   * a pseudonym in place of the identity. That is §8.2's "Anonymized, not erased"
   * taken literally, and it is why nothing in the retained set needs this method to
   * remember to spare it.
   *
   * Counting what went rather than returning a boolean is what lets the caller
   * build §9's completion summary from the transaction's own result instead of
   * from a list of intentions.
   */
  completeDeletion(
    userId: UserId,
    pseudonym: string,
    at: Date,
    tx: Transaction,
  ): Promise<DeletionOutcome>;

  /**
   * The pseudonym for a contact point, computed from the stored salt.
   *
   * In the store rather than in the service because it must be byte-identical to
   * the one `completeDeletion` writes, and §8.2's promise that "a future account on
   * the same contact point ... can be linked" is a promise about *one* function.
   * Two implementations of "stable" is how it stops being stable.
   */
  deletionPseudonym(contactIdentifier: string, tx: Transaction): Promise<string | null>;

  /**
   * The pseudonymous subject for a contact point, if that contact point has been
   * deleted before. §8.3's re-entry check reads this and nothing else.
   */
  findDeletedSubject(contactIdentifier: string, tx: Transaction): Promise<DeletedSubjectRow | null>;
}

/** Dating: profiles, preferences, likes, passes, blocks, matches. */
export interface ProfileRow {
  readonly profileId: string;
  readonly userId: UserId;
  readonly state: string;
  readonly content: Readonly<Record<string, unknown>>;
  readonly updatedAt: Date;
}


/**
 * The per-photo state of a profile photo, which is the media machine's own
 * vocabulary rather than a second one. `initiated` and `scanning` are the
 * screening window; `needs_human` is a hold, not a refusal; `approved` is the
 * only state a photo counts in, because only an approved photo is published.
 */
export type ProfilePhotoState = 'initiated' | 'scanning' | 'needs_human' | 'approved' | 'rejected';

/**
 * One row of a profile's photo set.
 *
 * There is no field here a byte or an original could hide in, and no address:
 * `mediaAssetId` is the opaque handle the media service resolves, and the
 * column's CHECK constraints refuse a URI scheme or a leading slash so that a
 * URL to the original cannot be stored even by accident. Everything else here is
 * a fact *about* the photo — its order, its state, the owner's alt text — and
 * all of it is derived, never the artefact.
 */
export interface ProfilePhotoRow {
  readonly photoId: string;
  readonly userId: UserId;
  readonly mediaAssetId: string;
  readonly altText: string;
  readonly state: ProfilePhotoState;
  /** Position in the published set. Index 0 is the primary. Null while unpublished. */
  readonly position: number | null;
  /** Machine-readable refusal code. Present only on `rejected`. */
  readonly reasonCode: string | null;
  readonly createdAt: Date;
}

/**
 * A stored location anchor: the precise point, classified `sensitive`.
 *
 * This is the only shape in the system that carries a coordinate, and it never
 * leaves the service. What crosses a boundary is a `DistanceBand` computed from
 * two of these by the dating domain's bucketing rule, which consumes both
 * arguments and returns only the band.
 */
export interface LocationAnchorRow {
  readonly userId: UserId;
  readonly latitude: number;
  readonly longitude: number;
  readonly sensitivity: 'sensitive';
  readonly observedAt: Date;
}

export interface InteractionStore {
  upsertProfile(row: ProfileRow, tx: Transaction): Promise<void>;
  findProfile(userId: UserId, tx: Transaction): Promise<ProfileRow | null>;
  upsertPreferences(userId: UserId, preferences: Readonly<Record<string, unknown>>, tx: Transaction): Promise<void>;
  findPreferences(userId: UserId, tx: Transaction): Promise<Readonly<Record<string, unknown>> | null>;

  /**
   * Every photo the owner holds, whatever its state, oldest first. The owner's
   * audit trail is the whole set: a photo awaiting a verdict is as much theirs
 * as an approved one, and a route that returned only the published set would
 * make "being checked" indistinguishable from "never arrived".
 */
  listProfilePhotos(userId: UserId, tx: Transaction): Promise<readonly ProfilePhotoRow[]>;
  insertProfilePhoto(row: Omit<ProfilePhotoRow, 'createdAt'>, tx: Transaction): Promise<void>;
  /**
   * The screening verdict, as one write. State and position move together
   * because the schema ties them: a photo is in the ordered set exactly when it
 * is approved, so a route that could write one without the other could create
 * a primary that does not exist or an approved photo with nowhere to sit.
   */
  applyPhotoDecision(
    photoId: string,
    decision: { readonly state: ProfilePhotoState; readonly position: number | null; readonly reasonCode: string | null },
    at: Date,
    tx: Transaction,
  ): Promise<boolean>;
  /**
   * Renumbers the published set to the given order. Returns how many rows moved,
   * and refuses a list that is not exactly the published set, so a reorder can
   * never silently drop a photo from the set.
   */
  reorderProfilePhotos(userId: UserId, orderedPhotoIds: readonly string[], at: Date, tx: Transaction): Promise<number>;
  deleteProfilePhoto(photoId: string, userId: UserId, tx: Transaction): Promise<boolean>;

  /** Writes the owner's precise anchor, classified `sensitive`. Never returned by a route. */
  upsertLocationAnchor(row: LocationAnchorRow, tx: Transaction): Promise<void>;
  findLocationAnchor(userId: UserId, tx: Transaction): Promise<LocationAnchorRow | null>;

  /**
   * The live like ledger for one user, ordered by creation. Every like-taking
   * domain function — `recordLike`, `resolveMatch`, `relationshipView`,
   * `evidenceForReport` — takes the ledger as an argument, so a store that
   * cannot read it leaves the whole matching flow with nothing to pass.
   */
  findLikesFor(userId: UserId, tx: Transaction): Promise<readonly Readonly<Record<string, unknown>>[]>;
  /**
   * Moves a like to its decided state. `isCurrentLike` counts both states so
   * behaviour is unchanged either way, but a stored state that disagrees with
   * what the domain decided is a trap for the next reader.
   */
  updateLike(likeId: string, state: 'matched' | 'withdrawn', tx: Transaction): Promise<boolean>;

  /**
   * Appends a like, or returns the existing row unchanged when the same
   * `(from, to, likeId)` is replayed. Idempotence is the store's job because
   * a duplicate tap and a retried request are indistinguishable at this layer.
   */
  appendLike(row: Readonly<Record<string, unknown>>, tx: Transaction): Promise<{ readonly created: boolean }>;
  appendPass(row: Readonly<Record<string, unknown>>, tx: Transaction): Promise<{ readonly created: boolean }>;
  /**
   * Marks the `(from, to)` pass superseded. Part of the same transaction as the
   * like, because a like and the supersession it causes must not be separable.
   */
  supersedePass(from: UserId, to: UserId, at: Date, tx: Transaction): Promise<number>;
  findPassesFor(userId: UserId, tx: Transaction): Promise<readonly Readonly<Record<string, unknown>>[]>;

  /** Idempotent: a pair has at most one active block in either direction. */
  createBlock(row: Readonly<Record<string, unknown>>, tx: Transaction): Promise<{ readonly created: boolean }>;
  releaseBlock(blocker: UserId, blocked: UserId, at: Date, tx: Transaction): Promise<number>;
  findBlocksBetween(a: UserId, b: UserId, tx: Transaction): Promise<readonly Readonly<Record<string, unknown>>[]>;

  findMatch(matchId: MatchId, tx: Transaction): Promise<Readonly<Record<string, unknown>> | null>;
  findMatchByPair(a: UserId, b: UserId, tx: Transaction): Promise<Readonly<Record<string, unknown>> | null>;
  findMatchesFor(userId: UserId, page: Page, tx: Transaction): Promise<PageResult<Readonly<Record<string, unknown>>>>;
  /** Creates once per ordered pair; a concurrent caller gets the existing row. */
  upsertMatch(row: Readonly<Record<string, unknown>>, tx: Transaction): Promise<Readonly<Record<string, unknown>>>;
  updateMatch(matchId: MatchId, patch: Readonly<Record<string, unknown>>, tx: Transaction): Promise<boolean>;
}

/** Communication: conversations and messages. */
/**
 * Every read takes the reader. Not an optional convenience and not a filter the
 * caller can forget: a conversation id is guessable, and so is a match id now
 * that it is the domain's own `match:{a}|{b}` derivation rather than a uuid —
 * anyone who knows two user ids can construct one. Participation is therefore
 * checked in SQL, and a non-participant gets `null`, identical to an id that
 * does not exist, so a probe cannot tell the two apart.
 */
export interface ConversationRow {
  readonly conversationId: ConversationId;
  readonly matchId: MatchId;
  readonly participants: readonly [UserId, UserId];
  readonly state: string;
  readonly openedAt: Date;
  /** The instant the state last changed; the domain's `Conversation` has one. */
  readonly stateChangedAt: Date | null;
  readonly lastMessageAt: Date | null;
}

export interface MessageRow {
  readonly messageId: MessageId;
  readonly conversationId: ConversationId;
  readonly senderId: UserId;
  readonly body: string;
  readonly createdAt: Date;
  /** `sent` is the only state a newly created message can be in. */
  readonly state: 'sent' | 'delivered' | 'read' | 'failed' | 'deleted';
}

/**
 * A store that must report a *refusal* — a duplicate conversation, a body
 * outside the allowed length — throws this rather than returning a `Result`.
 * The reasoning: these are integrity outcomes the database enforced, not
 * business decisions the domain made, and a service that caught them as domain
 * errors would have to enumerate constraint names to tell them apart. The
 * `reason` is a closed vocabulary so a caller branches on it without parsing a
 * message.
 */
export type ConversationConflictReason =
  | 'conversation_id_taken'
  | 'match_already_has_conversation'
  | 'match_does_not_exist'
  | 'message_body_out_of_range';

export class ConversationStoreError extends StoreError {
  readonly reason: ConversationConflictReason;
  constructor(reason: ConversationConflictReason, message: string) {
    super(message, { retryable: false });
    this.name = 'ConversationStoreError';
    this.reason = reason;
  }
}

export interface ConversationStore {
  /** Throws `ConversationStoreError` on a duplicate id or a missing match. */
  create(row: ConversationRow, tx: Transaction): Promise<void>;
  find(conversationId: ConversationId, reader: UserId, tx: Transaction): Promise<ConversationRow | null>;
  /**
   * Participant-scoped, and this one matters most: a match id is derived from
   * two user ids, so it is *more* guessable than a conversation uuid.
   */
  findByMatch(matchId: MatchId, reader: UserId, tx: Transaction): Promise<ConversationRow | null>;
  updateState(conversationId: ConversationId, state: string, at: Date, tx: Transaction): Promise<boolean>;
  listFor(userId: UserId, page: Page, tx: Transaction): Promise<PageResult<ConversationRow>>;
  /**
   * Appends, or returns the existing row for a replayed `messageId`. Delivery
   * is at-least-once on the wire, so a duplicate must collapse here rather
   * than showing the same message twice. Also advances the conversation's
   * activity instant monotonically, because `listFor` orders by it and nothing
   * else in this port writes it.
   */
  appendMessage(row: MessageRow, tx: Transaction): Promise<{ readonly created: boolean }>;
  findMessages(
    conversationId: ConversationId,
    page: Page,
    reader: UserId,
    tx: Transaction,
  ): Promise<PageResult<MessageRow>>;
}

/** Trust & Safety: signals and the current risk record. */
/**
 * Trust & Safety: signals and the current risk record.
 *
 * The assessment carries a `generation` for the same reason identity's does.
 * It is a pure fold over `risk_signals`, so a lost update is a lost fold
 * *step* rather than lost evidence — but until the next signal the subject is
 * under-scored, and under-scoring is the direction that hurts. The writer set
 * is wider than "two signals at once": decay, dispute and human reassessment
 * all rewrite the row.
 */
export interface RiskStore {
  /** First delivery of a `signalId` wins; a replay is ignored, never merged. */
  appendSignal(signal: Readonly<Record<string, unknown>>, tx: Transaction): Promise<void>;
  /**
   * The newest `limit`, returned oldest-first, in the same order the domain's
   * `compareSignals` uses — so a replayed ledger folds to the same result as an
   * in-memory one. Taking the *oldest* N and truncating would hide the most
   * recent behaviour, which is the opposite of what a safety system should do.
   *
   * **Rows are returned as stored, including ones no replay can use.** A row
   * written before migration 007 carries no author and no actor; a row whose
   * detector this build no longer runs cannot be re-declared at all. Neither is
   * filtered here, because a store that silently dropped them would make the
   * evidence log disagree with itself — and a caller could not tell a short
   * history from a hidden one. `replaySignals` in `@been-there/trust-safety`
   * skips those rows, counts them, and reports the per-reason tally; that is
   * where the decision belongs, because only the domain knows what a `Signal`
   * requires.
   *
   * `limit` bounds rows **read**, so a window containing skipped rows yields a
   * ledger shorter than `limit`. A caller that needs the full history has to
   * read the skips, not infer the shortfall from the result's length.
   */
  findSignalsFor(subjectId: SubjectId, limit: number, tx: Transaction): Promise<readonly Readonly<Record<string, unknown>>[]>;
  /** Includes `generation`, so a stale write is detectable. */
  findAssessment(subjectId: SubjectId, tx: Transaction): Promise<Readonly<Record<string, unknown>> | null>;
  /**
   * Writes the assessment, or returns `{ applied: false }` when the generation
   * it read has been superseded. `expectedGeneration: null` means "no row was
   * read", so this inserts. The service re-runs the fold on `false`, which is
   * safe precisely because the fold is pure.
   */
  upsertAssessment(
    subjectId: SubjectId,
    assessmentId: RiskAssessmentId,
    state: string,
    lastSignalAt: Date | null,
    detectors: readonly string[],
    expectedGeneration: number | null,
    tx: Transaction,
  ): Promise<{ applied: boolean }>;
}

/** Moderation: reports, cases, decisions, and the append-only audit. */
export interface ModerationStore {
  insertReport(row: Readonly<Record<string, unknown>>, tx: Transaction): Promise<void>;
  findReport(reportId: ReportId, tx: Transaction): Promise<Readonly<Record<string, unknown>> | null>;
  insertCase(row: Readonly<Record<string, unknown>>, tx: Transaction): Promise<CaseRow>;
  findCase(caseId: CaseId, tx: Transaction): Promise<CaseRow | null>;
  updateCase(caseId: CaseId, patch: Readonly<Record<string, unknown>>, tx: Transaction): Promise<boolean>;
  /** Moderator queue, highest priority first then oldest first. */
  listOpenCases(page: Page, tx: Transaction): Promise<PageResult<CaseRow>>;

  insertDecision(row: Readonly<Record<string, unknown>>, tx: Transaction): Promise<void>;
  findDecisionsFor(caseId: CaseId, tx: Transaction): Promise<readonly Readonly<Record<string, unknown>>[]>;

  /**
   * Append-only. There is deliberately no update or delete on the audit, and
   * the type has no method that could become one — it is the appeal record.
   */
  appendAudit(row: Readonly<Record<string, unknown>>, tx: Transaction): Promise<void>;
  findAuditForActor(actorId: ActorId, page: Page, tx: Transaction): Promise<PageResult<Readonly<Record<string, unknown>>>>;
  findAuditForSubject(subjectId: SubjectId, page: Page, tx: Transaction): Promise<PageResult<Readonly<Record<string, unknown>>>>;
  findAuditForEntity(entityType: string, entityId: string, tx: Transaction): Promise<readonly Readonly<Record<string, unknown>>[]>;
}

export interface CaseRow {
  readonly caseId: CaseId;
  readonly subjectId: UserId;
  readonly origin: string;
  readonly state: string;
  readonly priority: string;
  readonly queue: string;
  readonly openedAt: Date;
  readonly dueAt: Date;
  readonly openedBy: ActorId | 'system';
  readonly assignedModeratorId: ActorId | null;
  readonly reportIds: readonly ReportId[];
  readonly evidenceIds: readonly string[];
  readonly resolutionDecisionId: string | null;
  readonly updatedAt: Date;
}

/** Dating: the owner's personal goal, and the dates they have been on. */
/**
 * The persisted shape of `DatingGoal`. A row is a target and an instant, and
 * there is no count column here either — the port repeats the domain's shape so
 * a store cannot be handed a count to overwrite.
 */
export interface DatingGoalRow {
  readonly profileId: string;
  readonly ownerId: UserId;
  readonly target: number;
  readonly updatedAt: Date;
}

/**
 * One persisted completed date. `entryId` is the caller's retry token rather
 * than an id of anything, and the store's uniqueness on it is what makes a
 * retried record count once rather than twice.
 */
export interface CompletedDateRow {
  readonly entryId: string;
  /** `null` for a date with someone met outside the product. */
  readonly counterpartId: UserId | null;
  /** The effective day, ISO `YYYY-MM-DD`. */
  readonly occurredOn: string;
  readonly recordedAt: Date;
}

/**
 * One appended correction. Never updated and never deleted: the `supersededOn`
 * column is what a restatement preserved, and dropping the row would drop the
 * answer to "what did this entry say before".
 */
export interface DateCorrectionRow {
  readonly entryId: string;
  readonly key: string;
  readonly kind: 'withdrawn' | 'restated';
  readonly at: Date;
  /** Only on `restated`: the day the entry now says. */
  readonly occurredOn: string | null;
  /** Only on `restated`: the day it said before, kept so the log is a history. */
  readonly supersededOn: string | null;
}

/**
 * A completed date and everything appended to it, which is the unit the domain
 * folds: `isCounted` is a question about `corrections`, so corrections have to
 * arrive with the record or the count would be computed over a lie.
 */
export interface CompletedDateEntryRow extends CompletedDateRow {
  readonly corrections: readonly DateCorrectionRow[];
}

/**
 * `GoalStore`: the goal is keyed by **profile**, the ledger by **user**.
 *
 * Two aggregates with two lifetimes, and the port is where that is visible. A
 * profile is a card that can be deleted and recreated; a date is a fact about a
 * person's life. So `findGoal` takes a `profileId`, `findLedger` takes a
 * `userId`, and no method on this port can reach from one to the other — which
 * is what makes "changing the target cannot touch the count" and "deleting a
 * profile cannot take the history with it" properties of the interface rather
 * than of a migration somebody has to remember.
 */
export interface GoalStore {
  findGoal(profileId: string, tx: Transaction): Promise<DatingGoalRow | null>;
  upsertGoal(row: DatingGoalRow, tx: Transaction): Promise<void>;

  /** The owner's whole history, oldest first, each entry with its corrections. */
  findLedger(ownerId: UserId, tx: Transaction): Promise<readonly CompletedDateEntryRow[]>;

  /**
   * Appends a date, or returns the existing row untouched when the same
   * `entryId` is replayed. Idempotence is the store's job for the same reason it
   * is the like store's: a double-tap and a transport retry are
   * indistinguishable here.
   */
  appendCompletedDate(row: CompletedDateRow, ownerId: UserId, tx: Transaction): Promise<{ created: boolean }>;

  /**
   * Appends a correction. There is no update and no delete on this port, which
   * is the append-only rule as a type rather than as a convention.
   *
   * Returns `{ applied: false }` for a replayed key — a retry is a no-op, and
   * `ON CONFLICT DO NOTHING` is what makes that true without aborting the
   * caller's transaction.
   */
  appendDateCorrection(row: DateCorrectionRow, ownerId: UserId, tx: Transaction): Promise<{ applied: boolean }>;
}

/** Everything the service needs, in one object so wiring is explicit. */
export interface Stores {
  readonly users: UserStore;
  readonly identity: IdentityStore;
  readonly interaction: InteractionStore;
  readonly conversations: ConversationStore;
  readonly risk: RiskStore;
  readonly moderation: ModerationStore;
  /** What the product reads to enforce a sanction. */
  readonly accountStanding: AccountStandingStore;
  /** Verification attempts, so the flow survives a restart. */
  readonly verificationAttempts: VerificationAttemptStore;
  /** Credentials, the age gate, terms, sessions, recovery, contact verification. */
  readonly accounts: AccountPlatformStore;
  /** The personal dating goal and the completed-date history (#48, #49). */
  readonly goals: GoalStore;
  /** The staff directory and the sessions a named moderator holds. */
  readonly staff: StaffIdentityStore;
}

import type { ActorId } from '@been-there/core';
