#!/usr/bin/env node
/**
 * Loads the development dataset into the local database.
 *
 *   node packages/seed/scripts/load.mjs
 *
 * ## Why this file exists at all
 *
 * `scripts/seed/development-dataset.mjs` builds eight people, a block, a match
 * with a conversation, a report, two cases and an audit log by *running* the
 * domain — the identity machine, the risk machine, the like/match/block rules,
 * the send path, and the report → triage → case → review walk. Until now that
 * work ended in memory, so `make seed` pointed at a file that did not exist and
 * `make setup` — the first command a newcomer runs — failed.
 *
 * ## The rule this loader is built to keep
 *
 * Every row below is written by a store, and every value in it is an answer the
 * domain gave. There is no INSERT here. That is not stylistic: the dataset's
 * value is that it *proves* the domain can produce this state, and a hand-written
 * row would prove nothing while making the codebase's central claim untrue in the
 * one place a developer goes to look. A seeded `verified` account has to be one
 * the identity machine verified; a seeded ban has to name a case that exists.
 *
 * Three encodings are reused rather than rewritten: `attemptRowOf`,
 * `reportRowOf` and `caseRowOf` from `@been-there/service` are the definitions
 * the HTTP routes persist with, so a seeded row and a posted one are shaped by
 * one function.
 *
 * ## Two things the dataset cannot honestly supply
 *
 * Both are printed by `make seed` rather than papered over:
 *
 *  * **Risk signals.** The dataset records risk as a replayed *machine trail* —
 *    `signal_observed` with a score and a corroboration count. It has no
 *    `RiskSignal` records: the detector each individual observation came from
 *    was never part of the input, so writing `app.risk_signals` rows would mean
 *    inventing evidence. The *assessment* is the machine's fold over that trail
 *    and is loaded as-is; the signal ledger is not, because there is nothing to
 *    load that the domain produced. A fold replayed from the database will
 *    therefore reach a different answer than the seeded one, and that is a
 *    property of the dataset, not of this loader.
 *
 *  * **Platform audit clearance.** `app.audit_log` has no classification column,
 *    so the platform log's central property — that the *reader's* clearance
 *    decides what they see — is not representable as columns. The records are
 *    loaded with each field's classification intact inside `detail`, which keeps
 *    the gate reproducible against the stored row, but a reader that filtered on
 *    a column would have nothing to filter on.
 *
 * ## Ids
 *
 * The dataset names things the way a person reads them (`u-avery`,
 * `like-u-avery-u-blair`); much of the schema keys on `uuid`. Every identifier is
 * derived from its name into a uuid under one fixed namespace — RFC 4122 v5 —
 * so the same dataset produces the same ids on every machine and every run,
 * which is what lets the idempotence check recognise its own work. Text-keyed
 * columns (`matches.match_id`, `verification_attempts.attempt_id`,
 * `profiles.profile_id`) keep the readable name, because the schema deliberately
 * holds the domain's own derivation there.
 *
 * ## Idempotence: skip, not upsert
 *
 * Running this twice must not duplicate accounts, and it does not — the second
 * run writes nothing at all and says so. **Skip**, not upsert, and the reason is
 * that an upsert is not available without breaking something: `audit_log` is
 * append-only with no update path at all, `identity_state` and
 * `account_standing` guard writes with a generation the caller must have read
 * first, and `verification_attempts_one_open` refuses a second open attempt. A
 * real upsert would have to re-derive those generations and reconcile records the
 * stores deliberately refuse to reconcile — a second program, written by this
 * file, that could disagree with the domain about what the dataset is. Skipping
 * cannot disagree with anything.
 *
 * A database holding *part* of the dataset is a different thing again, and it is
 * refused by name rather than merged: something else wrote here, or an earlier run
 * failed partway, and choosing which rows to trust is not a decision this file
 * should make on the developer's behalf.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exit } from 'node:process';
import pg from 'pg';

import {
  PgAccountStandingStore,
  PgConversationStore,
  PgRiskStore,
  PgVerificationAttemptStore,
  PostgresIdentityStore,
  PostgresInteractionStore,
  PostgresUserStore,
  createModerationStore,
  createTransaction,
} from '@been-there/database';
import { attemptRowOf, caseRowOf, reportRowOf } from '@been-there/service';
import { loadDevelopmentDataset } from '../../../scripts/seed/development-dataset.mjs';
import { verifyDataset } from '../../../scripts/seed/dataset-invariants.mjs';
import { SEED_EPOCH } from '../../../scripts/seed/dataset-steps.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

/**
 * The packages this script loads on top of the six the dataset itself imports.
 * Named so a missing build says which package, rather than surfacing as a module
 * resolution failure pointing into node_modules.
 */
const ALSO_REQUIRED = ['database', 'service'];

/**
 * One fixed namespace, so `u-avery` is the same uuid on every machine and every
 * run. Anything else would make the idempotence check unable to recognise its
 * own rows, and would give every developer a different development database.
 */
const NAMESPACE = '9f1c2b7e-4a3d-5c6e-8b9a-0d1e2f3a4b5c';

/** RFC 4122 version 5: SHA-1 over the namespace and the name, versioned and varianted. */
function seedUuid(name) {
  const digest = createHash('sha1')
    .update(Buffer.from(NAMESPACE.replace(/-/g, ''), 'hex'))
    .update(name, 'utf8')
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The account id a user holds: derived from the same namespace, so it is stable. */
const accountIdOf = (userId) => seedUuid(`account:${userId}`);

/** The instant every seeded timestamp the dataset does not itself date comes from. */
const EPOCH = new Date(SEED_EPOCH);

// ---------------------------------------------------------------- the target --

/**
 * The connection string, resolved exactly as `packages/database/test/support/database.ts`
 * resolves it: the environment first, then `.env`, with no fallback. `localhost`
 * becomes `127.0.0.1` because it resolves to `::1` first on macOS and the compose
 * file publishes Postgres on IPv4 only, so an untouched `.env` would otherwise
 * fail with `ECONNREFUSED ::1:5432` — a confusing error for a correct setup.
 */
function databaseUrl() {
  const configured = readEnv('DATABASE_URL');
  if (configured === undefined) {
    throw new Error(
      'DATABASE_URL is not set, in the environment or in .env, so there is no database to load the ' +
        'dataset into. Run `cp .env.example .env` and then `make setup`, which starts the database ' +
        'and applies the migrations before seeding it.',
    );
  }
  return configured.replace('@localhost:', '@127.0.0.1:');
}

function readEnv(name) {
  if (process.env[name] !== undefined && process.env[name] !== '') {
    return process.env[name];
  }
  const envFile = join(REPO_ROOT, '.env');
  if (!existsSync(envFile)) {
    return undefined;
  }
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const match = new RegExp(`^\\s*${name}\\s*=\\s*(.*?)\\s*$`).exec(line);
    if (match !== null && match[1] !== '') {
      return match[1];
    }
  }
  return undefined;
}

function requireBuilt() {
  const missing = ALSO_REQUIRED.filter(
    (name) => !existsSync(resolve(REPO_ROOT, 'packages', name, 'dist', 'index.js')),
  );
  if (missing.length > 0) {
    throw new Error(
      `this loader persists through @been-there/${missing.join(' and @been-there/')}, and they are ` +
        'not built. Run `make build`, or `make setup`, which builds before it seeds.',
    );
  }
}

// -------------------------------------------------------------------- the ids --

/**
 * Every identifier the dataset produced, as a namespace to read them out of.
 * Collected in one place so a name is never renamed in one payload and left
 * alone in another.
 *
 * `uuid` is the strict lookup and `get` the permissive one: `wire` needs the
 * permissive form because it walks a whole document and must leave everything
 * that is not an identifier alone.
 */
function datasetIds(dataset) {
  const names = [];
  for (const person of dataset.users) {
    names.push(person.userId, person.verificationId, `photo-${person.userId}-primary`);
  }
  for (const attempt of dataset.attempts) {
    names.push(attempt.verificationId);
  }
  for (const like of dataset.likes) {
    names.push(like.likeId);
  }
  for (const pass of dataset.passes) {
    names.push(pass.passId);
  }
  for (const block of dataset.blocks) {
    names.push(block.blockId);
  }
  for (const record of dataset.report.capturedEvidence) {
    names.push(record.evidenceId);
  }
  for (const moderationCase of dataset.cases) {
    names.push(moderationCase.caseId, ...moderationCase.evidenceIds);
  }
  for (const entry of dataset.moderationAuditEntries) {
    names.push(...entry.evidenceIds);
  }
  for (const assessment of dataset.riskAssessments) {
    names.push(assessment.assessmentId);
  }
  names.push(dataset.report.reportId);
  for (const conversation of dataset.conversations) {
    names.push(conversation.conversationId);
    for (const message of conversation.messages) {
      names.push(message.messageId);
    }
  }
  const uuids = new Map(names.map((name) => [name, seedUuid(name)]));
  return {
    get: (name) => uuids.get(name),
    uuid: (name) => uuidFor(uuids, name),
  };
}


/**
 * The uuid for an identifier that is about to be written to a `uuid` column.
 *
 * Strict on purpose. `Map.get` returns `undefined` for an id this file failed to
 * collect, and `undefined` bound to a `uuid` parameter is a store error about
 * types rather than about the dataset — while `Map.get(x) ?? x` would write the
 * readable name beside a uuid that means the same thing and be joinable with
 * nothing. The Trust & Safety case's evidence (`mod-11`) is the one that proves
 * the strictness earns its place: it is not in the report's evidence, so
 * collecting only that would miss it.
 */
function uuidFor(ids, name) {
  const uuid = ids.get(name);
  if (uuid === undefined) {
    throw new Error(
      `no uuid is mapped for "${name}". datasetIds() collects the dataset's identifiers and this ` +
        'one is not among them; a `uuid` column cannot hold the readable name, so add the ' +
        'collection that missed it rather than writing the name.',
    );
  }
  return uuid;
}

/**
 * Replaces every identifier in a payload with its uuid, at any depth.
 *
 * Applied to the `jsonb` documents as well as to the columns: a report's frozen
 * `captured_evidence` and the case's `evidence_ids` name the same artefacts, and
 * if one held `ev-…` while the other held a uuid they would no longer be
 * joinable — so the same id has to be the same value in both. Substitution is by
 * exact match against the dataset's own identifiers, so it cannot rewrite a
 * string that merely resembles one: `sha256:riley-frankie-1-4` and
 * `provider_session_seed_0.97` both pass through untouched.
 */
function wire(ids, value) {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === 'string') {
    return ids.get(value) ?? value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => wire(ids, entry));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, wire(ids, entry)]));
  }
  return value;
}

/** Every platform audit record, including the ones above any single clearance. */
const platformRecords = (dataset) => dataset.platformAuditLog.read({ upTo: 'restricted' });

// --------------------------------------------------------------- what is there --

/**
 * Every row the loader intends to write, described as what to look for. The same
 * list decides whether the load is needed, so "is it loaded?" and "what does it
 * write?" cannot answer differently.
 */
function presenceChecks(dataset, ids) {
  const everyone = dataset.users.map((person) => ids.uuid(person.userId));
  return [
    { unit: 'accounts', table: 'app.users', column: 'user_id', cast: 'uuid', keys: everyone },
    { unit: 'accounts', table: 'app.identity_state', column: 'user_id', cast: 'uuid', keys: everyone },
    { unit: 'accounts', table: 'app.profiles', column: 'user_id', cast: 'uuid', keys: everyone },
    {
      unit: 'enforcement',
      table: 'app.account_standing',
      column: 'user_id',
      cast: 'uuid',
      keys: everyone,
    },
    {
      unit: 'verification attempts',
      table: 'app.verification_attempts',
      column: 'attempt_id',
      cast: 'text',
      keys: dataset.attempts.map((attempt) => attempt.verificationId),
    },
    {
      unit: 'dating',
      table: 'app.likes',
      column: 'like_id',
      cast: 'uuid',
      keys: dataset.likes.map((like) => ids.uuid(like.likeId)),
    },
    {
      unit: 'dating',
      table: 'app.passes',
      column: 'pass_id',
      cast: 'uuid',
      keys: dataset.passes.map((pass) => ids.uuid(pass.passId)),
    },
    {
      unit: 'dating',
      table: 'app.blocks',
      column: 'block_id',
      cast: 'uuid',
      keys: dataset.blocks.map((block) => ids.uuid(block.blockId)),
    },
    {
      unit: 'dating',
      table: 'app.matches',
      column: 'match_id',
      cast: 'text',
      keys: dataset.matches.map((match) => match.matchId),
    },
    {
      unit: 'conversations',
      table: 'app.conversations',
      column: 'conversation_id',
      cast: 'uuid',
      keys: dataset.conversations.map((conversation) => ids.uuid(conversation.conversationId)),
    },
    {
      unit: 'conversations',
      table: 'app.messages',
      column: 'message_id',
      cast: 'uuid',
      keys: dataset.conversations.flatMap((conversation) =>
        conversation.messages.map((message) => ids.uuid(message.messageId)),
      ),
    },
    {
      unit: 'risk',
      table: 'app.risk_assessments',
      column: 'assessment_id',
      cast: 'uuid',
      keys: dataset.riskAssessments.map((assessment) => ids.uuid(assessment.assessmentId)),
    },
    {
      unit: 'moderation',
      table: 'app.reports',
      column: 'report_id',
      cast: 'uuid',
      keys: [ids.uuid(dataset.report.reportId)],
    },
    {
      unit: 'moderation',
      table: 'app.cases',
      column: 'case_id',
      cast: 'uuid',
      keys: dataset.cases.map((moderationCase) => ids.uuid(moderationCase.caseId)),
    },
    {
      unit: 'audit',
      table: 'app.audit_log',
      column: 'dedupe_key',
      cast: 'text',
      keys: [
        ...dataset.moderationAuditEntries.map((entry) => `moderation:${entry.sequence}`),
        ...platformRecords(dataset).map((record) => `platform:${record.auditId}`),
      ],
    },
  ];
}

// ------------------------------------------------------------- the load units --

/**
 * Each unit is one transaction. The order is the schema's, not the narrative's:
 * accounts exist before anything may point at them, and enforcement comes after
 * the cases it attributes itself to — `account_standing.case_id` is a foreign key,
 * so a ban loaded before its case would be refused by the database rather than by
 * the domain, which is the wrong order to discover it in.
 */
const units = [
  {
    name: 'accounts',
    run: async (tx, dataset, ids) => {
      const users = new PostgresUserStore();
      const identity = new PostgresIdentityStore();
      const interaction = new PostgresInteractionStore();
      for (const person of dataset.users) {
        const userId = ids.uuid(person.userId);
        await users.create({ userId, accountId: accountIdOf(person.userId), createdAt: EPOCH }, tx);
        await identity.insert(
          {
            userId,
            state: person.identityState,
            generation: 1,
            latestVerificationId: ids.uuid(person.verificationId),
            updatedAt: EPOCH,
          },
          tx,
        );
        // The published photo set, written as a row the way a member's own
        // upload writes one: `media_asset_id` opaque, alt text present, and
        // approval and position moved together as the schema ties them. Content
        // then carries that row rather than an invented photo — `saveProfile`
        // reads the same rows through `photosFor`, so a seeded profile and a
        // posted one disagree about nothing.
        const photoId = ids.uuid(`photo-${person.userId}-primary`);
        await interaction.insertProfilePhoto(
          {
            photoId,
            userId,
            mediaAssetId: `seed-${person.userId}-primary`,
            altText: `${person.displayName}'s profile photo`,
            state: 'approved',
            position: 0,
            reasonCode: null,
          },
          tx,
        );
        // The content is the dataset's, verbatim: bio, prompt, gender identities,
        // birthdate and the coarse band, plus the photo above. Writing
        // `{ displayName }` alone instead produced rows the standing projection
        // refuses to decode — a 500 (`store_failure`) on every discovery
        // request, which is how this line was found.
        //
        // `profile_id` is the profile's own id, which the dataset does not model
        // as a separate entity; it is named after its owner so it is stable and
        // says whose profile it is.
        await interaction.upsertProfile(
          {
            profileId: `profile-${person.userId}`,
            userId,
            state: person.standing.profile.state,
            content: {
              displayName: person.displayName,
              bio: person.profileContent.bio,
              photos: [{ photoId, approval: 'approved' }],
              prompts: [{ promptId: `${person.userId}-prompt-1`, text: person.profileContent.prompt }],
              genderIdentities: person.profileContent.genderIdentities,
              birthdate: person.profileContent.birthdate,
              location: person.profileContent.location,
            },
            updatedAt: EPOCH,
          },
          tx,
        );
      }
    },
  },
  {
    name: 'verification attempts',
    run: async (tx, dataset, ids) => {
      const attempts = new PgVerificationAttemptStore();
      for (const attempt of dataset.attempts) {
        // `attemptRowOf` is the encoding the verification routes persist with, so
        // a seeded attempt and a posted one are the same shape.
        const row = attemptRowOf(attempt);
        // Only the subject is mapped. `attempt_id` is `text` and holds the
        // domain's own `VerificationId`, and the same id appears inside the
        // stored evidence document; rewriting one and not the other would split
        // an attempt from the artefacts captured for it. `identity_state`'s
        // `latest_verification_id` is a `uuid` column and does take the mapped
        // form — the schema's choice, not this file's.
        await attempts.insert({ ...row, subjectId: ids.uuid(row.subjectId) }, tx);
      }
    },
  },
  {
    name: 'dating',
    run: async (tx, dataset, ids) => {
      const interaction = new PostgresInteractionStore();
      // Passes first: `appendLike` records which pass it overrode by reading the
      // live one, so a like written before its pass would silently not supersede.
      for (const pass of dataset.passes) {
        await interaction.appendPass(
          {
            passId: ids.uuid(pass.passId),
            from: ids.uuid(pass.from),
            to: ids.uuid(pass.to),
            createdAt: pass.createdAt,
          },
          tx,
        );
      }
      for (const like of dataset.likes) {
        await interaction.appendLike(
          {
            likeId: ids.uuid(like.likeId),
            from: ids.uuid(like.from),
            to: ids.uuid(like.to),
            createdAt: like.createdAt,
          },
          tx,
        );
        // The ledger's own state, which the matcher and then the block already
        // moved: two likes over an ended match are still two likes.
        if (like.state !== 'live') {
          await interaction.updateLike(ids.uuid(like.likeId), like.state, tx);
        }
      }
      for (const pass of dataset.passes) {
        if (pass.state === 'superseded') {
          await interaction.supersedePass(ids.uuid(pass.from), ids.uuid(pass.to), pass.createdAt, tx);
        }
      }
      for (const block of dataset.blocks) {
        await interaction.createBlock(
          {
            blockId: ids.uuid(block.blockId),
            blocker: ids.uuid(block.blocker),
            blocked: ids.uuid(block.blocked),
            createdAt: block.createdAt,
          },
          tx,
        );
        if (!block.active) {
          await interaction.releaseBlock(ids.uuid(block.blocker), ids.uuid(block.blocked), EPOCH, tx);
        }
      }
      for (const match of dataset.matches) {
        // The domain's canonical order is over the readable names; the store's is
        // over uuids, and `upsertMatch` refuses a pair that is not sorted the way
        // *it* sorts. Re-sorted here, carrying each participant's standing with
        // them, because a standing belongs to a person and not to a slot.
        const uuids = match.participants.map((participant) => ids.uuid(participant));
        const order = uuids[0] <= uuids[1] ? [0, 1] : [1, 0];
        await interaction.upsertMatch(
          {
            matchId: match.matchId,
            participants: order.map((index) => uuids[index]),
            likeIds: match.likeIds.map((likeId) => ids.uuid(likeId)),
            standings: order.map((index) => match.standings[index]),
            createdAt: match.createdAt,
            endedAt: match.ended === null ? null : match.ended.at,
            endedCause: match.ended === null ? null : match.ended.cause,
          },
          tx,
        );
      }
    },
  },
  {
    name: 'conversations',
    run: async (tx, dataset, ids) => {
      const conversations = new PgConversationStore();
      for (const conversation of dataset.conversations) {
        // Created with no `lastMessageAt`: the store moves it as each message
        // lands, which is the same path a real send takes.
        await conversations.create(
          {
            conversationId: ids.uuid(conversation.conversationId),
            matchId: conversation.matchId,
            participants: conversation.participants.map((participant) => ids.uuid(participant)),
            state: conversation.state,
            openedAt: conversation.openedAt,
            stateChangedAt: conversation.stateChangedAt,
            lastMessageAt: null,
          },
          tx,
        );
        for (const message of conversation.messages) {
          await conversations.appendMessage(
            {
              messageId: ids.uuid(message.messageId),
              conversationId: ids.uuid(message.conversationId),
              senderId: ids.uuid(message.senderId),
              body: message.body,
              createdAt: message.createdAt,
              state: message.state,
            },
            tx,
          );
        }
      }
    },
  },
  {
    name: 'risk',
    run: async (tx, dataset, ids) => {
      const risk = new PgRiskStore();
      for (const assessment of dataset.riskAssessments) {
        // The fold over the replayed trail, which is the machine's answer. The
        // signals themselves are not written: see the note at the top of this
        // file for why there is nothing here to write that the domain produced.
        await risk.upsertAssessment(
          ids.uuid(assessment.subjectId),
          ids.uuid(assessment.assessmentId),
          assessment.state,
          assessment.lastSignalAt,
          assessment.contributingDetectors,
          null,
          tx,
        );
      }
    },
  },
  {
    name: 'moderation',
    run: async (tx, dataset, ids) => {
      const moderation = createModerationStore();
      const report = reportRowOf(dataset.report);
      await moderation.insertReport(
        {
          ...report,
          reportId: ids.uuid(report.reportId),
          subjectId: ids.uuid(report.subjectId),
          reporterId: report.reporterId === null ? null : ids.uuid(report.reporterId),
          // The evidence is mapped, because its ids are also on the case's
          // `evidence_ids` and the two have to be the same value to be joinable.
          capturedEvidence: wire(ids, report.capturedEvidence),
          // `relationship` is left as the dataset wrote it, and that is a
          // decision rather than an omission: it names Riley and Frankie's
          // conversation and two messages from it, and the dataset never opened
          // or stored either — the block ended that match first. Rewriting
          // those references to uuids would dress a frozen recollection up as a
          // join against rows that do not exist.
        },
        tx,
      );
      for (const moderationCase of dataset.cases) {
        await moderation.insertCase(
          {
            ...caseRowOf(moderationCase),
            caseId: ids.uuid(moderationCase.caseId),
            subjectId: ids.uuid(moderationCase.subjectId),
            reportIds: moderationCase.reportIds.map((reportId) => ids.uuid(reportId)),
            evidenceIds: moderationCase.evidenceIds.map((evidenceId) => ids.uuid(evidenceId)),
          },
          tx,
        );
      }
    },
  },
  {
    name: 'enforcement',
    run: async (tx, dataset, ids) => {
      const standing = new PgAccountStandingStore();
      for (const person of dataset.users) {
        const userId = ids.uuid(person.userId);
        // After the cases, because a sanction that names a case which is not here
        // yet is a sanction with nothing behind it, and the foreign key would say
        // so for the wrong reason.
        await standing.upsert(
          {
            userId,
            state: person.accountState,
            capabilities: person.standing.account.capabilities,
            visibleInProduct: person.standing.account.visibleInProduct,
            caseId: person.accountContext === undefined ? null : ids.uuid(person.accountContext.caseId),
            // The dataset reaches the ban and the restriction through the account
            // machine with the case attached; it carries no `Decision`, so there is
            // no decision id to record. The case is what makes the standing
            // attributable, which is why it is written at all.
            decisionId: null,
            generation: 1,
            updatedAt: EPOCH,
          },
          null,
          tx,
        );
      }
    },
  },
  {
    name: 'audit',
    run: async (tx, dataset, ids) => {
      const moderation = createModerationStore();
      for (const entry of dataset.moderationAuditEntries) {
        await moderation.appendAudit(
          {
            occurredAt: entry.occurredAt,
            actorId: entry.actorId,
            action: entry.action,
            entityType: entry.entityType,
            entityId: entry.entityId,
            subjectId: entry.subjectId === null ? null : ids.uuid(entry.subjectId),
            caseId: entry.caseId === null ? null : ids.uuid(entry.caseId),
            evidenceIds: entry.evidenceIds.map((evidenceId) => ids.uuid(evidenceId)),
            decisionId: entry.decisionId,
            outcome: entry.outcome,
            reversal: entry.reversal,
            detail: entry.detail,
            // The dataset's sequence is unique and gap-free within the run, so a
            // replay of the same entry collapses onto the same row. That is what
            // `dedupe_key` is for, and it is the audit log's own idempotence.
            dedupeKey: `moderation:${entry.sequence}`,
          },
          tx,
        );
      }
      for (const record of platformRecords(dataset)) {
        await moderation.appendAudit(
          {
            occurredAt: record.occurredAt,
            actorId: record.actorId,
            action: record.action,
            // The platform log keys its records by the account they concern, and
            // the table has no entity of its own for one; the account is the fact
            // every reader of an audit record asks about first.
            entityType: 'account',
            entityId: ids.uuid(record.subjectId),
            subjectId: ids.uuid(record.subjectId),
            caseId: record.caseId === undefined ? null : ids.uuid(record.caseId),
            // There is no classification column, so each field travels with its
            // own. `readAuditRecord` can then be re-run against the stored row
            // and reach the same answer it reaches in memory.
            detail: {
              sensitivity: record.sensitivity,
              correlationId: record.correlationId,
              fields: record.fields,
            },
            dedupeKey: `platform:${record.auditId}`,
          },
          tx,
        );
      }
    },
  },
];

// ----------------------------------------------------------------- the survey --

/** Reads, and only reads: the question being asked is what is already there. */
async function survey(client, checks) {
  const found = [];
  const missing = [];
  for (const check of checks) {
    const result = await client.query(
      `SELECT ${check.column} FROM ${check.table} WHERE ${check.column} = ANY($1::${check.cast}[])`,
      [[...check.keys]],
    );
    const present = new Set(result.rows.map((row) => row[check.column]));
    for (const key of check.keys) {
      (present.has(key) ? found : missing).push({ table: check.table, key });
    }
  }
  return { found, missing };
}

function groupBy(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const bucket = groups.get(key(row));
    if (bucket === undefined) {
      groups.set(key(row), [row]);
    } else {
      bucket.push(row);
    }
  }
  return groups;
}

function partialReport(found, missing) {
  const tables = (rows) => new Set(rows.map((row) => row.table)).size;
  const lines = [
    'This database holds part of the development dataset, so loading the rest of it would leave a',
    'dataset that is neither the one the domain produced nor the one that is here. Refusing rather',
    'than merging: which rows to trust is a decision this script should not make for you.',
    '',
    `  already present: ${found.length} row(s) across ${tables(found)} table(s)`,
    `  absent:         ${missing.length} row(s) across ${tables(missing)} table(s)`,
    '',
  ];
  for (const [table, rows] of groupBy(missing, (row) => row.table)) {
    const shown = rows.slice(0, 3).map((row) => row.key);
    const rest = rows.length - shown.length;
    lines.push(`  missing from ${table}: ${shown.join(', ')}${rest > 0 ? `, and ${rest} more` : ''}`);
  }
  lines.push(
    '',
    'To load the dataset into an empty database: `make db-reset`, then `make setup`.',
    'To keep what is here, do nothing: this script has left it exactly as it found it.',
  );
  return lines.join('\n');
}

function summarise(dataset) {
  const messages = dataset.conversations.reduce((total, entry) => total + entry.messages.length, 0);
  const audit = dataset.moderationAuditEntries.length + platformRecords(dataset).length;
  console.log(
    `  ${dataset.users.length} accounts, ${dataset.attempts.length} verification attempts, ` +
      `${dataset.matches.length} matches, ${dataset.passes.length} pass(es), ` +
      `${dataset.blocks.length} block(s), ${dataset.conversations.length} conversation(s) with ` +
      `${messages} message(s), ${dataset.riskAssessments.length} risk assessment(s), 1 report, ` +
      `${dataset.cases.length} cases, ${audit} audit rows.`,
  );
  console.log(
    "  Not loaded: the risk signal ledger, and the platform audit log's clearance gate, which has " +
      'no column to hold it. Both are named at the top of load.mjs.',
  );
  console.log('  `make seed-print` prints the dataset; `make audit-log` shows who may read its log.');
}

// ----------------------------------------------------------------- the entry --

async function main() {
  requireBuilt();
  const connectionString = databaseUrl();
  const pool = new pg.Pool({ connectionString });
  const transaction = createTransaction(pool);

  try {
    const client = await pool.connect();
    try {
      const schema = await client.query("SELECT to_regclass('app.users') AS relation");
      if (schema.rows[0].relation === null) {
        throw new Error(
          'the database has no schema: `app.users` does not exist. `make migrate` applies the ' +
            'migrations, and `make setup` runs it before seeding. Loading into an unmigrated ' +
            'database would fail at the first row anyway; saying so here names what is missing.',
        );
      }
    } finally {
      client.release();
    }

    const dataset = loadDevelopmentDataset();
    const problems = verifyDataset(dataset);
    if (problems.length > 0) {
      throw new Error(
        `the dataset violates ${problems.length} invariant(s), so it was not loaded:\n  - ` +
          problems.join('\n  - '),
      );
    }

    const ids = datasetIds(dataset);
    const { found, missing } = await transaction.run((tx) => survey(tx.client, presenceChecks(dataset, ids)));

    if (missing.length === 0) {
      console.log(
        `Already loaded: all ${found.length} row(s) this dataset writes are here, so nothing was ` +
          'written. `make seed` skips rather than upserts — see load.mjs for why.',
      );
      summarise(dataset);
      return;
    }
    if (found.length > 0) {
      throw new Error(partialReport(found, missing));
    }

    for (const unit of units) {
      await transaction.run((tx) => unit.run(tx, dataset, ids));
      console.log(`  loaded  ${unit.name}`);
    }
    console.log('\nLoaded the development dataset through the domain transitions and the stores.');
    summarise(dataset);
  } finally {
    await pool.end();
  }
}

try {
  await main();
} catch (error) {
  console.error(`seed: ${error.message}`);
  exit(1);
}
