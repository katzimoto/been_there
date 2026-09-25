import {
  type CaseId,
  type ConversationId,
  type DomainError,
  type MatchId,
  type MessageId,
  type Result,
  type UserId,
  domainError,
  ok,
} from '@been-there/core';
import { type Conversation, type ConversationState } from './conversation.js';
import { type Message, type MessageState } from './message.js';

/**
 * Evidence capture (issue #5).
 *
 * Communication does not decide whether a report is valid, whether a case
 * should exist, or what anyone did. It answers exactly one question: *given a
 * recorded case, what does this conversation hold?* The answer is a scoped,
 * redacted, chronological view.
 *
 * Two rules make the view safe to hand to a moderator:
 *
 *  - **Scoped.** It is bound to one case, one conversation, and one subject. A
 *    request naming a user who is not in the conversation gets `not_found`
 *    rather than an empty or borrowed view. Every read is therefore traceable
 *    to a case id, which is what `restricted` sensitivity means.
 *  - **Redacted, never silently.** Contact details and links are replaced with
 *    a marker, and the marker is recorded. A moderator must never be able to
 *    mistake a redaction for the absence of evidence.
 */

export type RedactionReason = 'email_address' | 'external_link' | 'international_phone';

const REDACTION_PATTERNS: readonly {
  readonly reason: RedactionReason;
  readonly pattern: RegExp;
}[] = [
  { reason: 'email_address', pattern: /[\w.+-]+@[\w-]+\.[\w.]{2,}/g },
  { reason: 'external_link', pattern: /https?:\/\/\S+/gi },
  { reason: 'international_phone', pattern: /\+\d[\d\s().-]{7,}\d/g },
];

function redact(body: string): { readonly text: string; readonly redactions: readonly RedactionReason[] } {
  const applied: RedactionReason[] = [];
  const text = REDACTION_PATTERNS.reduce((current, { reason, pattern }) => {
    if (!pattern.test(current)) {
      return current;
    }
    pattern.lastIndex = 0;
    applied.push(reason);
    return current.replace(pattern, `[redacted:${reason}]`);
  }, body);
  return { text, redactions: applied };
}

export interface EvidenceMessage {
  readonly messageId: MessageId;
  readonly senderId: UserId;
  readonly state: MessageState;
  readonly sentAt: Date;
  readonly bodyLength: number;
  readonly redactedBody: string;
  readonly redactions: readonly RedactionReason[];
  /** Lets a moderator read the exchange without deciding who is at fault. */
  readonly attributedToSubject: boolean;
}

export interface EvidenceScope {
  /** Explicit message ids requested, or `null` when the whole conversation is in scope. */
  readonly messageIds: readonly MessageId[] | null;
  readonly from: Date | null;
}

export interface ConversationEvidence {
  readonly caseId: CaseId;
  readonly conversationId: ConversationId;
  readonly matchId: MatchId;
  readonly subjectId: UserId;
  readonly requestedByUserId: UserId;
  readonly capturedAt: Date;
  readonly conversationState: ConversationState;
  readonly scope: EvidenceScope;
  readonly messages: readonly EvidenceMessage[];
  readonly redactedMessageCount: number;
}

export interface EvidenceRequest {
  /** Mandatory: there is no unscoped read of message history, ever. */
  readonly caseId: CaseId;
  /** The reported user. Must be a participant in this conversation. */
  readonly subjectId: UserId;
  /** The user who reported, or a moderator acting on the case. */
  readonly requestedByUserId: UserId;
  readonly capturedAt: Date;
  /** Restrict to these message ids; omit for the whole conversation. */
  readonly messageIds?: readonly MessageId[];
  /** Restrict to messages at or after this instant; ignored when ids are given. */
  readonly since?: Date;
}

export function captureEvidence(
  conversation: Conversation,
  messages: readonly Message[],
  request: EvidenceRequest,
): Result<ConversationEvidence, DomainError> {
  if (!conversation.participants.includes(request.subjectId)) {
    return domainError(
      'not_found',
      'communication',
      'the reported user is not a participant in this conversation',
      { caseId: request.caseId, subjectId: request.subjectId },
    );
  }
  const byId = new Map<MessageId, Message>(
    messages
      .filter((message) => message.conversationId === conversation.conversationId)
      .map((message) => [message.messageId, message]),
  );
  const inScope = (
    request.messageIds === undefined
      ? [...byId.values()].filter(
          (message) =>
            request.since === undefined || message.createdAt.getTime() >= request.since.getTime(),
        )
      : request.messageIds
          .map((id) => byId.get(id))
          .filter((message): message is Message => message !== undefined)
  ).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const view = inScope.map((message) => {
    const { text, redactions } = redact(message.body);
    return {
      messageId: message.messageId,
      senderId: message.senderId,
      state: message.state,
      sentAt: message.createdAt,
      bodyLength: message.body.length,
      redactedBody: text,
      redactions,
      attributedToSubject: message.senderId === request.subjectId,
    } satisfies EvidenceMessage;
  });

  return ok({
    caseId: request.caseId,
    conversationId: conversation.conversationId,
    matchId: conversation.matchId,
    subjectId: request.subjectId,
    requestedByUserId: request.requestedByUserId,
    capturedAt: request.capturedAt,
    conversationState: conversation.state,
    scope: { messageIds: request.messageIds ?? null, from: request.since ?? null },
    messages: view,
    redactedMessageCount: view.filter((message) => message.redactions.length > 0).length,
  });
}

