import type {
  ActorId,
  CaseId,
  Clearance,
  ConversationId,
  CorrelationId,
  DataSensitivity,
  DomainEvent,
  EventId,
  MatchId,
  MessageId,
  UserId,
} from '@been-there/core';
import type { ConversationState } from './conversation.js';
import type { MessageState } from './message.js';
import type { RedactionReason } from './evidence.js';
import type { RateRuleId } from './friction.js';

/**
 * What communication exposes to the safety layer (issue #5).
 *
 * The rule that shapes every type below: **this domain never judges content.**
 * There is no classifier, no keyword list, no score, and no way to attach one
 * without a type error — a signal payload is a closed record of ids, instants,
 * counts, and lengths, and none of those fields can hold a sentence. Trust &
 * Safety consumes these at `internal` clearance; message history itself stays
 * `user` and never crosses this boundary.
 *
 * The privacy direction matters as much as the safety direction. A behavioural
 * signal is enough for a detector to raise risk and for a moderator to decide
 * to open a case; it is deliberately *not* enough to read what anyone said.
 * Evidence crosses separately, at `restricted` clearance, scoped to a case.
 */

export interface MessageSentSignal {
  readonly conversationId: ConversationId;
  readonly matchId: MatchId;
  readonly senderId: UserId;
  readonly peerId: UserId;
  readonly messageId: MessageId;
  readonly messageState: MessageState;
  readonly sentAt: Date;
  readonly secondsSincePreviousMessage: number | null;
  readonly messagesInConversation: number;
  readonly messagesLastHour: number;
  readonly bodyLength: number;
  readonly secondsSinceConversationOpened: number;
}

export interface ConversationStateChangedSignal {
  readonly conversationId: ConversationId;
  readonly matchId: MatchId;
  readonly from: ConversationState;
  readonly to: ConversationState;
  readonly changedAt: Date;
  /** Pointer only, for correlating with a case. Carries no case content. */
  readonly caseId: CaseId | null;
}

export interface FrictionAppliedSignal {
  readonly ruleId: RateRuleId;
  readonly subjectId: UserId;
  readonly conversationId: ConversationId | null;
  readonly used: number;
  readonly limit: number;
  readonly windowMs: number;
  readonly at: Date;
}

export interface EvidenceCapturedSignal {
  readonly caseId: CaseId;
  readonly conversationId: ConversationId;
  readonly subjectId: UserId;
  readonly requestedByUserId: UserId;
  readonly capturedAt: Date;
  readonly scopedMessageCount: number;
  readonly redactedMessageCount: number;
  readonly redactionReasons: readonly RedactionReason[];
}

export interface SignalEnvelope {
  readonly eventId: EventId;
  readonly correlationId: CorrelationId;
  readonly actorId: ActorId | 'system';
  readonly causationId?: EventId;
  /** Authoritative instant of the fact; never taken from the transport clock. */
  readonly occurredAt: Date;
}

/**
 * The published catalogue. `containsUserContent: false` is a literal type, not
 * a boolean field: a catalogue entry that claimed to carry content would not
 * compile, so the table itself is the guarantee.
 */
export interface SignalCatalogueEntry {
  readonly type: string;
  readonly sensitivity: DataSensitivity;
  readonly containsUserContent: false;
  readonly description: string;
}

export const COMMUNICATION_SIGNALS: readonly SignalCatalogueEntry[] = [
  {
    type: 'communication.message_sent',
    sensitivity: 'internal',
    containsUserContent: false,
    description: 'A message was accepted into a conversation. Metadata only.',
  },
  {
    type: 'communication.conversation_state_changed',
    sensitivity: 'internal',
    containsUserContent: false,
    description: 'A conversation moved between lifecycle states, by user action or by case.',
  },
  {
    type: 'communication.friction_applied',
    sensitivity: 'internal',
    containsUserContent: false,
    description: 'A rate rule answered rate_limited. Pressure is observable; nothing was judged.',
  },
  {
    type: 'communication.evidence_captured',
    sensitivity: 'restricted',
    containsUserContent: false,
    description: 'A scoped, redacted evidence view was produced for a recorded case.',
  },
];

/** Trust & Safety's declared clearance: behavioural signals, never history. */
export const SAFETY_CLEARANCE: Clearance = { upTo: 'internal' };
/** Moderation's declared clearance: also the case-scoped evidence pointer. */
export const MODERATION_CLEARANCE: Clearance = { upTo: 'restricted' };

function signal<P>(
  entry: SignalCatalogueEntry,
  payload: P,
  envelope: SignalEnvelope,
): DomainEvent<P> {
  return {
    eventId: envelope.eventId,
    type: entry.type,
    version: 1,
    occurredAt: envelope.occurredAt,
    actorId: envelope.actorId,
    correlationId: envelope.correlationId,
    ...(envelope.causationId === undefined ? {} : { causationId: envelope.causationId }),
    sensitivity: entry.sensitivity,
    payload,
  };
}

function entry(type: string): SignalCatalogueEntry {
  const found = COMMUNICATION_SIGNALS.find((candidate) => candidate.type === type);
  if (found === undefined) {
    throw new Error(`communication: '${type}' is not a published signal`);
  }
  return found;
}

export function messageSentEvent(
  payload: MessageSentSignal,
  envelope: SignalEnvelope,
): DomainEvent<MessageSentSignal> {
  return signal(entry('communication.message_sent'), payload, envelope);
}

export function conversationStateChangedEvent(
  payload: ConversationStateChangedSignal,
  envelope: SignalEnvelope,
): DomainEvent<ConversationStateChangedSignal> {
  return signal(entry('communication.conversation_state_changed'), payload, envelope);
}

export function frictionAppliedEvent(
  payload: FrictionAppliedSignal,
  envelope: SignalEnvelope,
): DomainEvent<FrictionAppliedSignal> {
  return signal(entry('communication.friction_applied'), payload, envelope);
}

export function evidenceCapturedEvent(
  payload: EvidenceCapturedSignal,
  envelope: SignalEnvelope,
): DomainEvent<EvidenceCapturedSignal> {
  return signal(entry('communication.evidence_captured'), payload, envelope);
}
