import {
  type Clearance,
  type DomainError,
  type DomainEvent,
  type Err,
  type Result,
  type SubjectId,
  castId,
  domainError,
  isClearedToConsume,
  ok,
} from '@been-there/core';
import { TRUST_SAFETY_DOMAIN } from './signal.js';

/**
 * Everything a detector is allowed to see, in one closed list.
 *
 * The names are the published event types, spelled the way their producer
 * spells them. The vocabulary used to be a parallel snake_case scheme
 * (`unmatch_initiated`, `message_reported`) that shared no spelling with any
 * catalogue, which is how `unmatch.performed` came to have no producer at all:
 * a reader comparing the detector's inputs with the domains' catalogues found
 * nothing that matched and nothing that disagreed. A kind is now either the
 * name of the event it is reduced from, or a name no producer emits — and
 * `OBSERVATION_REDUCTION` says which.
 *
 * These are reduced, metadata-only facts. No message body, no photo, no
 * verification artefact, no exact location, and deliberately **no account
 * state** — a detector that could read `limited`/`suspended`/`banned` would be
 * one refactor away from being an enforcement engine, which is exactly what
 * this package must never be.
 */
export const OBSERVATION_KINDS = [
  'identity.status_changed',
  'verification.attempt.started',
  'profile.state_changed',
  'like.recorded',
  'unmatch.performed',
  'match.ended',
  'communication.conversation_state_changed',
  'communication.message_sent',
  'moderation.report_submitted',
  'block.created',
] as const;

export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

/**
 * One reduced fact from another domain. `count` lets a projection batch
 * repeated events, so a detector never needs the raw event stream and the
 * platform never has to hand over message content to run safety analysis.
 */
export interface Observation {
  readonly kind: ObservationKind;
  readonly occurredAt: Date;
  /** Who performed the behaviour. */
  readonly actorId: SubjectId;
  /** Who it happened to. Differs from `actorId` for `moderation.report_submitted`. */
  readonly subjectId: SubjectId;
  /** The other party, when the observation involves two accounts. */
  readonly counterpartyId?: SubjectId;
  /** Opaque id of what it happened to — a match, a conversation. */
  readonly entityId?: string;
  /** Batched count when the producer already derived a rate or a total. */
  readonly count?: number;
}

/**
 * What Trust & Safety may consume, in one word.
 *
 * `internal` is the same clearance Communication publishes its behavioural
 * signals at, and it is the ceiling for the whole reduction: a `sensitive` or
 * `restricted` event is a record, not a behaviour, and reducing one would move
 * facts across the tier boundary the sensitivity exists to hold. The bus
 * already filters on this, and `toObservation` refuses the event as well, so
 * the rule holds for a durable transport whose filtering is configured
 * elsewhere.
 */
export const REDUCTION_CLEARANCE: Clearance = { upTo: 'internal' };

/**
 * Where one reduced field is read from.
 *
 * `envelope:subjectId` is the only envelope field a rule may name: the bus
 * envelope carries one account, and a rule that could reach for `actorId` would
 * let a rule invent a performer the producer never named. Everything else is a
 * dotted path into the producer's payload.
 */
export type ReductionField = 'envelope:subjectId' | `payload:${string}`;

/** One row of the reduction: a kind, why a detector needs it, and the fields it is built from. */
export interface ReductionRule {
  readonly kind: ObservationKind;
  /** Why the safety layer needs this fact at all. Read by reviewers, not by code. */
  readonly relevance: string;
  /** Who performed the behaviour. */
  readonly actor: ReductionField;
  /** Who it happened to. */
  readonly subject: ReductionField;
  readonly counterparty?: ReductionField;
  /** Opaque platform id of what it happened to. */
  readonly entity?: ReductionField;
  /** A count or rate the producer already derived. Never re-derived here. */
  readonly count?: ReductionField;
}

/**
 * The event types this seam subscribes to. A new published event either appears
 * here — where adding it is a deliberate statement about what a detector is
 * allowed to see — or it is unmapped, and `toObservation` returns `null` for it.
 */
export type ReducibleEventType =
  | 'unmatch.performed'
  | 'like.recorded'
  | 'profile.state_changed'
  | 'communication.message_sent'
  | 'identity.status_changed'
  | 'verification.attempt.started';

/**
 * The mapping, as data.
 *
 * A switch on `event.type` would put the same fact in two places — the branch
 * and the kind it returns — and the two could disagree. Here the kind, the
 * reason it exists and the fields it is built from are one reviewable row, and
 * the reducer below is the only code that reads them.
 *
 * The `Record` annotation is total: a key that is not a `ReducibleEventType` and
 * a `ReducibleEventType` with no row are both build failures, so the
 * subscription list and the table cannot drift apart.
 */
export const OBSERVATION_REDUCTION: Readonly<Record<ReducibleEventType, ReductionRule>> = {
  'unmatch.performed': {
    kind: 'unmatch.performed',
    actor: 'payload:actorId',
    subject: 'envelope:subjectId',
    entity: 'payload:matchId',
    relevance:
      'A participant ended a match. It is the only match-ending behaviour a detector can observe, and the only way a subject learns that many accounts unmatched them.',
  },
  'like.recorded': {
    kind: 'like.recorded',
    actor: 'payload:from',
    subject: 'payload:from',
    counterparty: 'payload:to',
    relevance: 'Outbound like volume. A directed like is the one interaction a bot produces at a rate a person does not.',
  },
  'profile.state_changed': {
    kind: 'profile.state_changed',
    actor: 'payload:userId',
    subject: 'payload:userId',
    relevance: 'Profile churn: repeated rewrites in a short window. Which state it moved to is not kept, because a detector may not act on discoverability.',
  },
  'communication.message_sent': {
    kind: 'communication.message_sent',
    actor: 'payload:senderId',
    subject: 'payload:senderId',
    counterparty: 'payload:peerId',
    entity: 'payload:conversationId',
    count: 'payload:messagesLastHour',
    relevance:
      'Message volume per conversation. The rate is the producer’s own count, taken as published: the reduction does not re-derive a number a domain already computed, and it keeps no body, no length and no message id.',
  },
  'identity.status_changed': {
    kind: 'identity.status_changed',
    actor: 'payload:identity.subjectId',
    subject: 'payload:identity.subjectId',
    relevance:
      'That the identity state moved, and nothing about why. Paired with an attempt it shows identity churn; it never carries a likeness score, a provider label or an artefact, because the projection does not have one.',
  },
  'verification.attempt.started': {
    kind: 'verification.attempt.started',
    actor: 'envelope:subjectId',
    subject: 'envelope:subjectId',
    entity: 'payload:verificationId',
    relevance:
      'A verification attempt, as an opaque id. The attempt is the only part of Identity a detector may see: the capture, the document and the reason never cross.',
  },
};

/**
 * Lookup by an arbitrary bus type. This is the one place the table is read with
 * a `string`; every other read is total over `ReducibleEventType`.
 */
const RULES_BY_TYPE: Readonly<Record<string, ReductionRule | undefined>> = OBSERVATION_REDUCTION;

/**
 * Reads a dotted path out of a producer's payload.
 *
 * The bus hands over `Readonly<Record<string, unknown>>`, so every field is
 * re-checked for shape below. This is the boundary where `unknown` becomes a
 * value, and nothing is trusted because the type says `unknown`.
 */
function payloadField(payload: Readonly<Record<string, unknown>>, path: string): unknown {
  let value: unknown = payload;
  for (const segment of path.split('.')) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return undefined;
    }
    // Narrowed to an object literal, so its own properties are `unknown`.
    value = (value as Readonly<Record<string, unknown>>)[segment];
  }
  return value;
}

function fieldValue(event: DomainEvent, ref: ReductionField): unknown {
  if (ref === 'envelope:subjectId') {
    return event.subjectId;
  }
  return payloadField(event.payload, ref.slice('payload:'.length));
}

function readText(event: DomainEvent, ref: ReductionField): string | null {
  const value = fieldValue(event, ref);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readSubject(event: DomainEvent, ref: ReductionField): SubjectId | null {
  const raw = readText(event, ref);
  // A branded id crossing a domain boundary: the producer declared the field as
  // an id, and the reduction re-checks that it is a non-empty string.
  return raw === null ? null : castId<'SubjectId'>(raw);
}

function readCount(event: DomainEvent, ref: ReductionField): number | null {
  const value = fieldValue(event, ref);
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : null;
}

/** A mapped event that does not carry what its rule names. Never guessed at. */
function malformed(type: string, field: ReductionField, expected: string): Err<DomainError> {
  return domainError(
    'validation_failed',
    TRUST_SAFETY_DOMAIN,
    `a mapped event must carry ${expected}; the reduction will not guess`,
    { type, field },
  );
}

/**
 * The reduction seam: one delivered event in, one reduced observation out.
 *
 * Three outcomes, and the difference between them is the point:
 *
 *  - `null` — this domain has no detector for the event. A `public` profile
 *    edit, a match created, a block: unmapped is not refused.
 *  - an `Err` — the event is *not* a behaviour observation. Above the
 *    clearance, dated after it was observed, or missing a field its rule names.
 *    Refused loudly, because the alternative is a fact quietly moving into the
 *    internal tier.
 *  - an `Observation` — derived metadata only: ids, instants, and a count the
 *    producer already computed. A payload field nobody named cannot reach it,
 *    which is why a message body never crosses here.
 */
export function toObservation(event: DomainEvent, now: Date): Result<Observation | null, DomainError> {
  if (!isClearedToConsume(REDUCTION_CLEARANCE, event)) {
    return domainError(
      'permission_denied',
      TRUST_SAFETY_DOMAIN,
      'event is classified above the reduction clearance and is not a behaviour observation',
      { type: event.type, sensitivity: event.sensitivity, clearance: REDUCTION_CLEARANCE.upTo },
    );
  }

  const rule = RULES_BY_TYPE[event.type];
  if (rule === undefined) {
    return ok(null);
  }

  if (event.occurredAt.getTime() > now.getTime()) {
    return domainError(
      'validation_failed',
      TRUST_SAFETY_DOMAIN,
      'event is dated after the moment it was observed',
      { type: event.type },
    );
  }

  const actorId = readSubject(event, rule.actor);
  if (actorId === null) {
    return malformed(event.type, rule.actor, 'the account that performed the behaviour');
  }
  const subjectId = readSubject(event, rule.subject);
  if (subjectId === null) {
    return malformed(event.type, rule.subject, 'the account it happened to');
  }
  const counterpartyId = rule.counterparty === undefined ? null : readSubject(event, rule.counterparty);
  if (rule.counterparty !== undefined && counterpartyId === null) {
    return malformed(event.type, rule.counterparty, 'the other account in the interaction');
  }
  const entityId = rule.entity === undefined ? null : readText(event, rule.entity);
  if (rule.entity !== undefined && entityId === null) {
    return malformed(event.type, rule.entity, 'an opaque id for what it happened to');
  }
  const count = rule.count === undefined ? null : readCount(event, rule.count);
  if (rule.count !== undefined && count === null) {
    return malformed(event.type, rule.count, 'a whole-number count of at least one');
  }

  return ok({
    kind: rule.kind,
    occurredAt: event.occurredAt,
    actorId,
    subjectId,
    ...(counterpartyId === null ? {} : { counterpartyId }),
    ...(entityId === null ? {} : { entityId }),
    ...(count === null ? {} : { count }),
  });
}
