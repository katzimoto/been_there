import {
  type DomainError,
  type ProfileId,
  type Result,
  type UserId,
  domainError,
  ok,
} from '@been-there/core';
import type { CompletedDateEntryRow, Transaction } from '@been-there/contracts';
import {
  type CompletedDateLedger,
  type CompletedDateRecord,
  type DateCorrection,
  type DatingGoal,
  type GoalProgress,
  DATING_GOAL_LIMITS,
  castDatingId,
  completedDateCount,
  correctCompletedDate,
  defaultDatingGoal,
  goalProgress,
  isCounted,
  recordCompletedDate,
  setDatingGoal,
} from '@been-there/dating';
import { readNumber, readOptionalString, readString } from '../http/body.js';
import { MISSING_FIELD, UNKNOWN_FIELD_VALUE } from '../http/failure.js';
import { okResponse, route, type HttpResponse, type Route, type RouteRequest } from '../http/router.js';
import type { ServiceDependencies } from '../ports.js';
import { userIdOf } from './accounts.js';

/**
 * The dating goal and the completed-date counter (#48, #49).
 *
 * The domain in `packages/dating/src/goal.ts` decided almost everything before
 * this file existed, and the decisions are enforced here by *not writing the
 * code that would undo them*. Each of the three that matter most has a note at
 * the place where its absence is load-bearing, because an absence has no
 * compiler error when somebody eventually adds to it.
 *
 * ## Recording a date requires nothing of the other person
 *
 * The handler below reads a session, reads a body, and writes. It does not read
 * an account standing, a block list, a match, a verification state, or even
 * check that the counterpart exists. That is not an oversight and there is a
 * comment at the handler saying so, because the omission is the feature:
 * `recordCompletedDate` takes no such parameter, which is what makes a
 * mandatory-review requirement unreachable rather than merely discouraged. Adding
 * a standing read here would not be "extra safety" — it would be a requirement
 * the domain was deliberately shaped to make inexpressible, re-introduced through
 * the one seam the type system cannot close. `counterpartId` is optional and
 * checked only for being a uuid: a date with someone met outside the product is
 * a real date, and requiring the other person to be a member would refuse a
 * large part of what people actually do.
 *
 * ## The count is derived, and the goal cannot reach it
 *
 * `goalProgress` is called with the ledger reloaded from the store on every read,
 * so a figure cannot go stale against either aggregate. Nothing stores a count,
 * so nothing can decrement one below zero — `completedDateCount` counts entries,
 * and there is no number in this file or in the schema that a withdrawal pushes
 * down. `PUT` of a goal touches `dating_goals` and nothing else, so changing the
 * target cannot lose the history: that is the store's two-key design rather than
 * a rule this handler remembers.
 *
 * ## Corrections are appended, and the log is retained
 *
 * A withdrawal decrements nothing; it appends a `withdrawn` correction and the
 * fold stops counting that entry. A restatement moves the day and keeps the
 * entry counted. Both are handed to `correctCompletedDate`, which owns which of
 * the two a request is, and both are persisted through `appendDateCorrection`,
 * which has no update and no delete to become an edit. Restating a withdrawn
 * date is the domain's `conflict` and is surfaced as a 409 by the dispatcher.
 *
 * ## What the response will never carry
 *
 * No ratio, no percentage and no score. `goalProgress` returns integers and a
 * boolean, and the domain's note on it says the cheapest way to refuse a future
 * client's ranking ring is never to publish a value that fits in one. There is
 * no field here a ring could be drawn around.
 */

/** The two kinds of correction, as a lookup so an unknown value cannot be stored. */
const CORRECTION_KIND: Readonly<Record<string, 'withdrawn' | 'restated'>> = {
  withdrawn: 'withdrawn',
  restated: 'restated',
};

export function goalRoutes(dependencies: ServiceDependencies): readonly Route[] {
  return [
    // ------------------------------------------------------------------ goal --

    route('GET', '/v1/profiles/me/goal', async (request) => {
      const owner = ownerOf(request);
      if (!owner.ok) {
        return owner;
      }
      const goal = await goalOf(dependencies, owner.value, request.now, request.tx);
      if (goal === null) {
        // A member with no profile yet. The default target is a real answer even
        // so — there is nothing to set it on yet, but "what is my goal" still has
        // one — and the profile id is the one `saveProfile` will derive, so the
        // answer does not change when they write one.
        const ledger = await ledgerFor(dependencies, owner.value, request.tx);
        const absent = defaultDatingGoal(`profile:${owner.value}` as ProfileId, owner.value, request.now);
        return okResponse(200, goalBody(absent, goalProgress(ledger, absent)));
      }
      const ledger = await ledgerFor(dependencies, owner.value, request.tx);
      return okResponse(200, goalBody(goal, goalProgress(ledger, goal)));
    }),

    route('PUT', '/v1/profiles/me/goal', async (request) => {
      const owner = ownerOf(request);
      if (!owner.ok) {
        return owner;
      }
      const target = readNumber(request.body, 'target');
      if (!target.ok) {
        return target;
      }
      // `setDatingGoal` takes and returns a `DatingGoal`. The ledger is not a
      // parameter and not a return value, so "changing the target preserves the
      // count" is not this handler being careful — it is a call that cannot be
      // written to reach the count. Do not add a count parameter here.
      const current = await goalOf(dependencies, owner.value, request.now, request.tx);
      if (current === null) {
        return NO_PROFILE();
      }
      const changed = setDatingGoal(current, target.value, request.now);
      if (!changed.ok) {
        return changed;
      }
      await dependencies.stores.goals.upsertGoal(
        {
          profileId: String(changed.value.profileId),
          ownerId: changed.value.ownerId,
          target: changed.value.target,
          updatedAt: changed.value.updatedAt,
        },
        request.tx,
      );
      // Reloaded rather than reused, so the answer is about the ledger as it is
      // after this request's writes and not about the aggregate as it was before.
      const ledger = await ledgerFor(dependencies, owner.value, request.tx);
      return okResponse(200, goalBody(changed.value, goalProgress(ledger, changed.value)));
    }),

    // ---------------------------------------------------------------- ledger --

    route('GET', '/v1/profiles/me/completed-dates', async (request) => {
      const owner = ownerOf(request);
      if (!owner.ok) {
        return owner;
      }
      const [goal, ledger] = await Promise.all([
        goalOf(dependencies, owner.value, request.now, request.tx),
        ledgerFor(dependencies, owner.value, request.tx),
      ]);
      // The history is keyed by **user**, so it exists whether or not there is a
      // profile — and that is the whole of the two-key design, visible from here:
      // an owner with no profile still has a counter, and a profile that is
      // deleted does not take it away.
      const against = goal ?? defaultDatingGoal(`profile:${owner.value}` as ProfileId, owner.value, request.now);
      return okResponse(200, {
        completed: completedDateCount(ledger),
        progress: goalProgress(ledger, against),
        // Every entry the owner holds, including withdrawn ones. A correction the
        // owner cannot see is one they cannot explain, and the count is the fold —
        // so the fold's inputs are published with it.
        records: ledger.records.map(recordBody),
      });
    }),

    // ------------------------------------------------------------ a new date --

    route('POST', '/v1/profiles/me/completed-dates', async (request) => {
      const owner = ownerOf(request);
      if (!owner.ok) {
        return owner;
      }
      const entryId = readString(request.body, 'entryId');
      if (!entryId.ok) {
        return entryId;
      }
      const counterpartRaw = readOptionalString(request.body, 'counterpartId');
      if (!counterpartRaw.ok) {
        return counterpartRaw;
      }
      // The only validation on the counterpart is that the caller wrote a uuid.
      // Not that the account exists, not that it is in good standing, not that
      // it is verified, and not that the two of you ever matched. See the header:
      // a handler that fetched a standing here would be reintroducing the review
      // requirement `recordCompletedDate` was shaped to make unreachable.
      let counterpartId: UserId | null = null;
      if (counterpartRaw.value !== null) {
        const parsed = userIdOf(counterpartRaw.value);
        if (!parsed.ok) {
          return parsed;
        }
        counterpartId = parsed.value;
      }
      const occurredOn = readString(request.body, 'occurredOn');
      if (!occurredOn.ok) {
        return occurredOn;
      }
      const ledger = await ledgerFor(dependencies, owner.value, request.tx);
      const recorded = recordCompletedDate(ledger, {
        entryId: castDatingId<'IdempotencyKey'>(entryId.value),
        counterpartId,
        occurredOn: occurredOn.value,
        recordedAt: request.now,
      });
      if (!recorded.ok) {
        return recorded;
      }
      const appended = await dependencies.stores.goals.appendCompletedDate(
        {
          entryId: entryId.value,
          counterpartId,
          occurredOn: occurredOn.value,
          recordedAt: request.now,
        },
        owner.value,
        request.tx,
      );
      // `recordCompletedDate` returned the ledger unchanged for a replayed
      // `entryId`, and the store agrees by refusing the duplicate. Both halves
      // are reported so a retrying client can tell "your first write landed" from
      // "this was already there", and 201 is only for the former — a retry is not
      // a second date, so it is not a second creation.
      return okResponse(appended.created ? 201 : 200, {
        entryId: entryId.value,
        created: appended.created,
        completed: completedDateCount(recorded.value),
      });
    }),

    // ------------------------------------------------------------ correction --

    route('POST', '/v1/profiles/me/completed-dates/:entryId/corrections', async (request) => {
      const owner = ownerOf(request);
      if (!owner.ok) {
        return owner;
      }
      const entryId = request.params['entryId'];
      if (entryId === undefined || entryId === '') {
        return MISSING_FIELD('entryId');
      }
      const key = readString(request.body, 'key');
      if (!key.ok) {
        return key;
      }
      const kindRaw = request.body['kind'];
      const kind = typeof kindRaw === 'string' ? CORRECTION_KIND[kindRaw] : undefined;
      if (kind === undefined) {
        return UNKNOWN_FIELD_VALUE('kind', Object.keys(CORRECTION_KIND));
      }
      const occurredOnRaw = readOptionalString(request.body, 'occurredOn');
      if (!occurredOnRaw.ok) {
        return occurredOnRaw;
      }
      // A `restated` correction must carry a day and a `withdrawn` one must not,
      // but which day is valid is the domain's call: `correctCompletedDate`
      // checks it against the calendar and the clock. So a restatement with no
      // day is handed over as an empty one and comes back as the domain's own
      // `validation_failed`, rather than being refused here with a second answer
      // to the same question.
      const correction: DateCorrection =
        kind === 'restated'
          ? {
              kind: 'restated',
              key: castDatingId<'IdempotencyKey'>(key.value),
              at: request.now,
              occurredOn: occurredOnRaw.value ?? '',
            }
          : {
              kind: 'withdrawn',
              key: castDatingId<'IdempotencyKey'>(key.value),
              at: request.now,
            };
      const ledger = await ledgerFor(dependencies, owner.value, request.tx);
      const corrected = correctCompletedDate(
        ledger,
        castDatingId<'IdempotencyKey'>(entryId),
        correction,
      );
      if (!corrected.ok) {
        // `not_found` for an unknown entry, `conflict` for restating one that has
        // been withdrawn. Both are the domain's answers, carried to the client by
        // the dispatcher rather than re-decided into a status here.
        return corrected;
      }
      const before = ledger.records.find((record) => record.entryId === entryId)?.corrections.length ?? 0;
      const after = corrected.value.records.find((record) => record.entryId === entryId)?.corrections.length ?? 0;
      const applied = after > before;
      if (applied) {
        // Only when the domain actually appended. A replayed key and a second
        // withdrawal both leave the aggregate unchanged, and writing anyway would
        // put a row in the log that the domain never decided on.
        await dependencies.stores.goals.appendDateCorrection(
          {
            entryId,
            key: key.value,
            kind,
            at: request.now,
            occurredOn: kind === 'restated' ? occurredOnRaw.value : null,
            supersededOn: null,
          },
          owner.value,
          request.tx,
        );
      }
      const record = corrected.value.records.find((candidate) => candidate.entryId === entryId);
      return okResponse(200, {
        entryId,
        kind,
        applied,
        occurredOn: record?.occurredOn ?? null,
        counted: record === undefined ? false : isCounted(record),
        completed: completedDateCount(corrected.value),
      });
    }),
  ];
}

/**
 * A goal is a setting on a publication, and there is no publication yet.
 *
 * `not_found` rather than a `validation_failed`, because nothing about the
 * *request* is wrong: `target` was read and is well-formed. And it is stated
 * here rather than left to the store's foreign key, because the alternative is a
 * 500 for an ordinary state a brand new member is in on their first request.
 */
const NO_PROFILE = (): Result<never, DomainError> =>
  domainError('not_found', 'dating.goal', 'write a profile before setting a goal on it');

/**
 * The owner behind a session. A goal and a history are both private to them, so
 * every route here starts from the actor and never from an id in the path.
 */
function ownerOf(request: RouteRequest): Result<UserId, DomainError> {
  const actorId = request.actor.userId;
  if (actorId === null) {
    return MISSING_FIELD('userId');
  }
  return ok(actorId);
}

/**
 * The owner's goal: the stored one, or the default the domain defines — but
 * only once they have a profile to hang it on.
 *
 * `null` means "no profile yet", and it is a different answer from "the default
 * goal". That distinction is not pedantry: `dating_goals.profile_id` references
 * `app.profiles` with `ON DELETE CASCADE`, which is what makes a deleted profile
 * take its target with it and lets a new card start at the default. A profile id
 * derived rather than stored (`profile:${userId}`, exactly as `saveProfile`
 * derives one) is identical before and after the profile is written, so without
 * that reference a stale goal would silently reattach itself to the next card
 * the same person makes — the one behaviour the domain explicitly does not want.
 *
 * So a read may answer with the default once a profile exists, and a write
 * refuses before that rather than writing a row the schema would reject as a
 * foreign-key violation — which is what it would otherwise be, surfaced as a 500.
 */
async function goalOf(
  dependencies: ServiceDependencies,
  ownerId: UserId,
  at: Date,
  tx: Transaction,
): Promise<DatingGoal | null> {
  const row = await dependencies.stores.interaction.findProfile(ownerId, tx);
  if (row === null) {
    return null;
  }
  const profileId = row.profileId as ProfileId;
  const stored = await dependencies.stores.goals.findGoal(String(profileId), tx);
  // The default is produced rather than stored, so a profile nobody has set a
  // target on costs no row and has exactly one answer to "what is my goal".
  if (stored === null) {
    return defaultDatingGoal(profileId, ownerId, at);
  }
  return {
    profileId,
    ownerId: stored.ownerId,
    target: stored.target,
    updatedAt: stored.updatedAt,
  };
}

/**
 * The owner's whole ledger, reloaded from the store and folded into the shape the
 * domain speaks.
 *
 * The store's rows and the domain's records differ in exactly one place, and it
 * is the store that carries the extra: `supersededOn` is what a restatement
 * replaced, kept so the log can still be audited, and the domain's
 * `DateCorrection` has no field for it. Dropping it here rather than inventing a
 * domain field for it is why that column stays a store concern.
 */
async function ledgerFor(
  dependencies: ServiceDependencies,
  ownerId: UserId,
  tx: Transaction,
): Promise<CompletedDateLedger> {
  const rows = await dependencies.stores.goals.findLedger(ownerId, tx);
  return {
    ownerId,
    records: rows.map(ledgerRecordOf),
  };
}

function ledgerRecordOf(row: CompletedDateEntryRow): CompletedDateRecord {
  return {
    entryId: castDatingId<'IdempotencyKey'>(row.entryId),
    counterpartId: row.counterpartId,
    occurredOn: row.occurredOn,
    recordedAt: row.recordedAt,
    corrections: row.corrections.map((correction) =>
      correction.kind === 'restated'
        ? {
            kind: 'restated',
            key: castDatingId<'IdempotencyKey'>(correction.key),
            at: correction.at,
            occurredOn: correction.occurredOn ?? '',
          }
        : {
            kind: 'withdrawn',
            key: castDatingId<'IdempotencyKey'>(correction.key),
            at: correction.at,
          },
    ),
  };
}

/**
 * What the owner sees against their goal.
 *
 * `target` and `updatedAt` are here because a caller who just set a target should
 * not need a second request to see it, and both are facts already in the goal
 * rather than anything derived here. `limits` is the domain's own published
 * range, so a client can refuse a bad target before sending it without holding a
 * second copy of the numbers.
 */
function goalBody(goal: DatingGoal, progress: GoalProgress): HttpResponse['body'] {
  return {
    profileId: String(goal.profileId),
    target: goal.target,
    updatedAt: goal.updatedAt.toISOString(),
    completed: progress.completed,
    goalReached: progress.goalReached,
    beyondGoal: progress.beyondGoal,
    limits: { min: DATING_GOAL_LIMITS.min, max: DATING_GOAL_LIMITS.max },
  };
}

/**
 * One entry, with the corrections that decided whether it counts.
 *
 * `counted` is `isCounted` — the domain's own predicate over this record's
 * corrections, not a recount and not a stored flag, so it cannot say something
 * different from what `completedDateCount` counted. `corrections` carries the
 * kind, the day a restatement settled on and the instant, so the owner can see
 * why a number moved.
 */
function recordBody(record: CompletedDateRecord): HttpResponse['body'] {
  return {
    entryId: String(record.entryId),
    counterpartId: record.counterpartId,
    occurredOn: record.occurredOn,
    recordedAt: record.recordedAt.toISOString(),
    counted: isCounted(record),
    corrections: record.corrections.map((correction) => ({
      kind: correction.kind,
      key: String(correction.key),
      at: correction.at.toISOString(),
      ...(correction.kind === 'restated' ? { occurredOn: correction.occurredOn } : {}),
    })),
  };
}
