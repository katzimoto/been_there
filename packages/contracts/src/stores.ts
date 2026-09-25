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
  insert(row: IdentityRecordRow, tx: Transaction): Promise<void>;
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
   */
  upsert(row: AccountStandingRow, expectedGeneration: number, tx: Transaction): Promise<boolean>;
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

/** Dating: profiles, preferences, likes, passes, blocks, matches. */
export interface ProfileRow {
  readonly profileId: string;
  readonly userId: UserId;
  readonly state: string;
  readonly content: Readonly<Record<string, unknown>>;
  readonly updatedAt: Date;
}

export interface InteractionStore {
  upsertProfile(row: ProfileRow, tx: Transaction): Promise<void>;
  findProfile(userId: UserId, tx: Transaction): Promise<ProfileRow | null>;
  upsertPreferences(userId: UserId, preferences: Readonly<Record<string, unknown>>, tx: Transaction): Promise<void>;
  findPreferences(userId: UserId, tx: Transaction): Promise<Readonly<Record<string, unknown>> | null>;

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
export interface ConversationRow {
  readonly conversationId: ConversationId;
  readonly matchId: MatchId;
  readonly participants: readonly [UserId, UserId];
  readonly state: string;
  readonly openedAt: Date;
  readonly lastMessageAt: Date | null;
}

export interface MessageRow {
  readonly messageId: MessageId;
  readonly conversationId: ConversationId;
  readonly senderId: UserId;
  readonly body: string;
  readonly createdAt: Date;
}

export interface ConversationStore {
  create(row: ConversationRow, tx: Transaction): Promise<void>;
  find(conversationId: ConversationId, tx: Transaction): Promise<ConversationRow | null>;
  findByMatch(matchId: MatchId, tx: Transaction): Promise<ConversationRow | null>;
  updateState(conversationId: ConversationId, state: string, at: Date, tx: Transaction): Promise<boolean>;
  listFor(userId: UserId, page: Page, tx: Transaction): Promise<PageResult<ConversationRow>>;
  /**
   * Appends, or returns the existing row for a replayed `messageId`. Delivery
   * is at-least-once on the wire, so a duplicate must collapse here rather
   * than showing the same message twice.
   */
  appendMessage(row: MessageRow, tx: Transaction): Promise<{ readonly created: boolean }>;
  findMessages(conversationId: ConversationId, page: Page, tx: Transaction): Promise<PageResult<MessageRow>>;
}

/** Trust & Safety: signals and the current risk record. */
export interface RiskStore {
  appendSignal(signal: Readonly<Record<string, unknown>>, tx: Transaction): Promise<void>;
  /** Ordered oldest-first, which is what corroboration and decay windows need. */
  findSignalsFor(subjectId: SubjectId, limit: number, tx: Transaction): Promise<readonly Readonly<Record<string, unknown>>[]>;
  findAssessment(subjectId: SubjectId, tx: Transaction): Promise<Readonly<Record<string, unknown>> | null>;
  upsertAssessment(
    subjectId: SubjectId,
    assessmentId: RiskAssessmentId,
    state: string,
    lastSignalAt: Date | null,
    detectors: readonly string[],
    tx: Transaction,
  ): Promise<void>;
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
}

import type { ActorId } from '@been-there/core';
