/**
 * The machinery the development dataset is built from.
 *
 * Every helper here is a thin wrapper over a real domain call, and none of them
 * decides anything: the state a person ends up in is whatever the machine says
 * the state is. What they add is bookkeeping — a fixed clock, typed id casts, a
 * recorded trail for every transition, and a failure that names the call that
 * was rejected. Split out of development-dataset.mjs so that file reads as the
 * scenario it describes rather than as plumbing.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  accountMachine,
  castId,
  capabilitiesFor,
  identityMachine,
  riskMachine,
} from '@been-there/core';
import {
  beginCapture,
  completeFromProvider,
  planVerificationStart,
  recordCapture,
  submitToProvider,
} from '@been-there/identity';
import {
  EMPTY_LEDGER,
  applyBlockToMatch,
  createBlock,
  profileMachine,
  recordLike,
  recordPass,
  resolveMatch,
} from '@been-there/dating';
import { activeBlockView, sendMessage, startConversation } from '@been-there/communication';
import { classify } from '@been-there/platform';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Packages the dataset loads, and therefore packages that must be built. */
export const BUILT_PACKAGES = ['core', 'identity', 'dating', 'communication', 'moderation', 'platform'];

/** Every instant in the dataset derives from this one, so two runs agree. */
export const SEED_EPOCH = '2026-03-02T09:00:00.000Z';

const EPOCH_MS = new Date(SEED_EPOCH).getTime();

/**
 * A clock that moves one minute per reading. A seed that called `new Date()`
 * would produce a different dataset every run, and a dataset that differs every
 * run cannot be reasoned about or diffed.
 */
export function createClock() {
  let elapsed = 0;
  return () => {
    elapsed += 60_000;
    return new Date(EPOCH_MS + elapsed);
  };
}

/**
 * Reading `.value` off a `Result` without narrowing is a compile error in
 * TypeScript on purpose, and a lie in a seed file. Every domain call goes
 * through this, so a rejected transition names itself where it happened instead
 * of surfacing as `undefined` three lines later.
 */
export function must(result, what) {
  if (!result.ok) {
    throw new Error(`${what}: ${result.error.code} — ${result.error.message}`);
  }
  return result.value;
}

export function assertPackagesBuilt() {
  const missing = BUILT_PACKAGES.filter(
    (name) => !existsSync(resolve(ROOT, 'packages', name, 'dist', 'index.js')),
  );
  if (missing.length > 0) {
    throw new Error(
      `the development dataset loads the built packages, and these are not built: ${missing.join(', ')}. ` +
        'Run `make build`, or `make seed-print`, which depends on it.',
    );
  }
}

export const asUser = (value) => castId(value);
export const asActor = (value) => castId(value);
export const asSubject = (value) => castId(value);
export const asCorrelation = (value) => castId(value);
export const asBlock = (value) => castId(value);
export const asLike = (value) => castId(value);
export const asPass = (value) => castId(value);
export const asMessage = (value) => castId(value);
export const asConversation = (value) => castId(value);
export const asReport = (value) => castId(value);
export const asVerification = (value) => castId(value);
export const asRiskAssessment = (value) => castId(value);

export const MODERATOR = {
  actorId: asActor('mod-rivera'),
  isLead: false,
  identityPrivacyRole: false,
  automated: false,
};
export const LEAD = { ...MODERATOR, actorId: asActor('mod-okonkwo'), isLead: true };
export const PRIVACY_OFFICER = {
  actorId: asActor('privacy-alvarez'),
  isLead: false,
  identityPrivacyRole: true,
  automated: false,
};

/** One recorded step through a state machine: what went in, what came out. */
export function trailEntry(from, event, to, context) {
  return context === undefined ? { from, event, to } : { from, event, to, context };
}

/**
 * Applies one event and records it. The recorded `to` is the machine's own
 * answer, never a value passed in, so a trail cannot claim a state the machine
 * would not produce.
 */
export function step(machine, from, event, context, trail) {
  const state = must(machine.next(from, event, context), `${machine.domain}: ${event} from ${from}`);
  trail.push(trailEntry(from, event, state, context));
  return state;
}

/**
 * Records an identity move the identity domain proposed. The proposal is checked
 * against the machine rather than trusted, so a seed file cannot smuggle in a
 * state the domain and the kernel disagree about.
 */
export function identityStep(from, proposal, context, trail) {
  const state = must(
    identityMachine.next(from, proposal.viaEvent, context),
    `identity: ${proposal.viaEvent} from ${from}`,
  );
  if (state !== proposal.state) {
    throw new Error(
      `identity: the domain proposed ${proposal.state} via ${proposal.viaEvent} from ${from}, ` +
        `but the machine says ${state}`,
    );
  }
  trail.push(trailEntry(from, proposal.viaEvent, state, context));
  return state;
}

const passed = (check, score) => ({ check, outcome: 'passed', score, reason: null });

export function providerResult(confidence, liveness = passed('liveness', 0.95)) {
  return {
    providerReference: `provider_session_seed_${confidence}`,
    confidence,
    checks: [passed('document_authenticity', 0.98), liveness, passed('likeness', 0.96)],
    completedAt: new Date(SEED_EPOCH),
  };
}

/** Plans an attempt and captures both artefacts. Stops before the provider answers. */
export function startVerification(userId, now) {
  const start = must(
    planVerificationStart({
      verificationId: asVerification(`ver-${userId}`),
      subjectId: asSubject(userId),
      identityState: identityMachine.initial,
      now,
      reVerification: false,
      reason: { code: 'onboarding' },
      existing: [],
    }),
    `plan verification for ${userId}`,
  );
  let attempt = must(beginCapture(start.attempt, now), `begin capture for ${userId}`);
  attempt = must(
    recordCapture(
      attempt,
      {
        check: 'document_authenticity',
        kind: 'government_id_image',
        storageRef: `s3://local-seed/${userId}/id-front.jpg`,
        digest: `sha256:${userId}-id-front`,
      },
      now,
    ),
    `record the id capture for ${userId}`,
  );
  attempt = must(
    recordCapture(
      attempt,
      {
        check: 'liveness',
        kind: 'liveness_video',
        storageRef: `s3://local-seed/${userId}/liveness.webm`,
        digest: `sha256:${userId}-liveness`,
      },
      now,
    ),
    `record the liveness capture for ${userId}`,
  );
  // The attempt machine refuses to call a vendor with a half-captured
  // verification, and the required set is all three checks, not the two that
  // happen to be biometric.
  attempt = must(
    recordCapture(
      attempt,
      {
        check: 'likeness',
        kind: 'selfie_image',
        storageRef: `s3://local-seed/${userId}/selfie.jpg`,
        digest: `sha256:${userId}-selfie`,
      },
      now,
    ),
    `record the likeness capture for ${userId}`,
  );
  return {
    start,
    attempt: must(submitToProvider(attempt, now), `submit ${userId} to the provider`),
  };
}

/**
 * The whole provider round trip. Confidence and the per-check outcomes are the
 * only inputs, and they are the inputs a real vendor adapter would supply.
 */
export function verificationThroughProvider(person, now) {
  const { start, attempt } = startVerification(person.userId, now);
  const completed = must(
    completeFromProvider(attempt, start.identity.state, person.providerResult, [], now),
    `complete the provider result for ${person.userId}`,
  );
  const trail = [];
  let state = identityStep(identityMachine.initial, start.identity, undefined, trail);
  state = identityStep(
    state,
    completed.identity,
    { confidence: person.providerResult.confidence },
    trail,
  );
  return { state, attempt: completed.attempt, decision: completed.decision, trail };
}

/** A complete profile, reached through the profile machine like any other state. */
export function standingFor(person) {
  const profile = must(
    profileMachine.next(profileMachine.initial, 'mark_complete', { requirementsMet: true }),
    `complete the profile for ${person.userId}`,
  );
  return {
    identity: { state: person.identityState },
    profile: { state: profile },
    account: {
      capabilities: capabilitiesFor(person.accountState, person.accountContext),
      visibleInProduct: person.accountState !== 'banned',
    },
  };
}

/** Risk is evidence, so it is built by replaying signals, never by assigning a level. */
export function riskTrail(subjectId, signals) {
  const trail = [];
  let state = riskMachine.initial;
  for (const [event, context] of signals) {
    state = step(riskMachine, state, event, context, trail);
  }
  return {
    subjectId: asSubject(subjectId),
    assessmentId: asRiskAssessment(`risk-${subjectId}`),
    state,
    lastSignalAt: trail.length === 0 ? null : new Date(EPOCH_MS + trail.length * 60_000),
    contributingDetectors: signals.length === 0 ? [] : ['message_volume', 'report_velocity'],
    trail,
  };
}

/**
 * Two reciprocal likes, each checked against both parties' real standings, and
 * the pass list they leave behind.
 *
 * Both ledgers come back because a like may supersede a pass: keeping only the
 * likes would let the dataset describe a live pass and a match that crossed it,
 * which is exactly the state a seed must never be in.
 *
 * `passer` records a pass from that user to the other one *before* the like, so
 * the dataset walks the sequence the product makes when somebody changes their
 * mind: pass, then like the same person, and match anyway.
 */
export function mutualLikes(standings, a, b, now, { passer } = {}) {
  const at = now();
  const like = (from, to) => ({
    likeId: asLike(`like-${from}-${to}`),
    from: asUser(from),
    to: asUser(to),
    createdAt: at,
  });
  const passedOver = passer === undefined ? null : passer === a ? b : a;
  const passed =
    passedOver === null
      ? { ledger: EMPTY_LEDGER, passes: [] }
      : must(
          recordPass(EMPTY_LEDGER, [], {
            passId: asPass(`pass-${passer}-${passedOver}`),
            from: asUser(passer),
            to: asUser(passedOver),
            createdAt: at,
          }),
          `${passer} passes on ${passedOver}`,
        );
  const first = must(
    recordLike(passed.ledger, like(a, b), {
      actor: standings.get(a),
      target: standings.get(b),
      blocks: [],
      passes: passed.passes,
      at,
    }),
    `${a} likes ${b}`,
  );
  const second = must(
    recordLike(first.ledger, like(b, a), {
      actor: standings.get(b),
      target: standings.get(a),
      blocks: [],
      passes: first.passes,
      at,
    }),
    `${b} likes ${a}`,
  );
  return { ledger: second.ledger, passes: second.passes };
}
/** An account standing of `active`, before any enforcement is applied. */
export function activeUser(userId, displayName, identity) {
  return {
    userId,
    displayName,
    ...identity,
    accountState: 'active',
    accountContext: undefined,
    accountTrail: [],
  };
}


/**
 * Resolves the pair through the matcher, with the pass list the likes actually
 * produced. The passes cannot be an empty literal here: a like may have
 * superseded one, and a matcher handed a list that does not know that would
 * refuse a match the dataset has every reason to allow.
 *
 * `blocks` is empty because it genuinely is: the dataset's one block is created
 * *after* this match, and `blockAndEnd` carries it to the end it causes.
 */
export function matchFromLedger(likes, actorId, counterpartId, conversation) {
  const resolution = must(
    resolveMatch({
      actor: asUser(actorId),
      counterpart: asUser(counterpartId),
      like: likes.ledger.likes.find((entry) => entry.from === asUser(actorId)),
      ledger: likes.ledger,
      blocks: [],
      passes: likes.passes,
      conversationId: conversation,
    }),
    `resolve the ${actorId}/${counterpartId} match`,
  );
  if (resolution.outcome !== 'match_created') {
    throw new Error(`${actorId}/${counterpartId} should have matched, got ${resolution.outcome}`);
  }
  return resolution.match;
}

/** A live conversation, opened and messaged through the real send path. */
export function conversationWithMessages(projection, entries, now) {
  const conversation = startConversation(projection, projection.matchedAt);
  const blocking = activeBlockView([]);
  const messages = entries.map(([id, sender, body], index) =>
    must(
      sendMessage(
        { conversation, senderId: asUser(sender), messageId: asMessage(id), body, at: now() },
        {
          match: projection,
          blocking,
          senderStanding: { userId: sender, capabilities: capabilitiesFor('active') },
          recentSendTimestamps: [],
          recentConversationStarts: [],
          previousMessageAt: null,
          messagesInConversation: index,
          messagesLastHour: index,
        },
      ),
      `send ${id}`,
    ),
  );
  return { conversation, messages: messages.map((sent) => sent.message) };
}

/** A user safety action: unilateral, immediate, and it ends the match. */
export function blockAndEnd(blockerId, blockedId, blockIdentifier, match, ledger, now) {
  const block = must(
    createBlock(asUser(blockerId), asUser(blockedId), asBlock(blockIdentifier), now()),
    `${blockerId} blocks ${blockedId}`,
  );
  const outcome = must(
    applyBlockToMatch(block, match, ledger, now()),
    `apply the ${blockerId}/${blockedId} block to the open match`,
  );
  return { block, match: outcome.match, ledger: outcome.ledger };
}

/**
 * The platform audit log is append-only and its reads are clearance-gated, so
 * the seed writes through one recorder rather than reaching into the log.
 */
export function createAuditRecorder(log, now) {
  return (action, actorId, subjectId, fields, options = {}) =>
    must(
      log.append({
        action,
        actorId,
        subjectId,
        occurredAt: now(),
        correlationId: asCorrelation(options.correlation ?? 'corr-seed'),
        ...(options.caseId === undefined ? {} : { caseId: options.caseId }),
        fields,
      }),
      `append the ${action} audit record`,
    );
}

export { accountMachine, capabilitiesFor, classify, identityMachine, riskMachine };
