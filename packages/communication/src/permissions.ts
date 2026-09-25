import {
  type DomainError,
  type DomainErrorCode,
  type Err,
  type Result,
  type UserId,
  domainError,
  ok,
} from '@been-there/core';
import { type Conversation, isMessagingOpen, peerOf } from './conversation.js';
import type { BlockingReadModel, CommunicationDependencies } from './read-models.js';

/**
 * The central gate (issue #5, issue #26).
 *
 * `SEND_CHECKS` is an ordered table, not a chain of `if`s scattered through
 * handlers, so the precedence of a safety fact over a product fact is data and
 * therefore reviewable. The order is the policy:
 *
 *   1. `blocked`                       — a block dominates everything below it.
 *   2. `not_a_participant`             — structural access, before product rules.
 *   3. `match_not_for_conversation`    — the match projection must be this one.
 *   4. `match_not_active`              — the relationship still exists.
 *   5. `conversation_not_open`         — frozen, blocked, un-matched, or ended.
 *   6. `standing_unidentifiable`       — a projection that cannot be read.
 *   7. `missing_send_message_capability` — **both** participants, not one.
 *
 * A block is checked first on purpose. If it were fourth, a restricted user
 * who blocked someone would be told the conversation is unavailable "because of
 * your restriction", which both leaks the enforcement reason into a product
 * surface and makes the strongest fact the weakest one. That reasoning now
 * covers the counterpart's restriction as well, which is the point of rules 6
 * and 7 sitting below it: where a block and a peer restriction both apply, the
 * answer is `blocked` and the peer restriction is never mentioned.
 *
 * **Rules 6 and 7 are what make the refusal symmetric.** §8.4 of
 * `account-restrictions-and-reverification.md` promises that a restriction
 * disables the composer for the restricted account *and for every counterpart*,
 * so that a restriction cannot be probed and cannot be used to make a
 * counterpart look unreliable. Rule 7 therefore evaluates the two parties
 * under one rule, one code, one message and one detail set, and the verdict is
 * byte-identical whichever party is at fault — a sender who is restricted and
 * a sender whose counterpart is restricted cannot tell the difference, and
 * neither can a counterpart trying the same. That is the whole mechanism, and
 * it only works if the two branches are never allowed to drift apart: they
 * share the single `denial(...)` call below, not two similar ones.
 *
 * The parties being in different states is not a special case. "One limited,
 * one active" is the ordinary state of the world, and the answer is the same
 * one: neither can message, and the reason given is the same for both.
 *
 * Rule 6 sits above rule 7 because an unidentifiable projection is a wiring
 * fault, and a wiring fault must not be laundered into an ordinary product
 * refusal where nobody would ever page anyone about it. It fails closed: a
 * projection that is absent, or that describes somebody other than the party it
 * is being consulted for, refuses the send. Degrading to "allowed" when the
 * gate cannot see would look like the feature working.
 */

export const SEND_MESSAGE_CAPABILITY = 'send_message';

export type SendDenialRule =
  | 'blocked'
  | 'not_a_participant'
  | 'match_not_for_conversation'
  | 'match_not_active'
  | 'conversation_not_open'
  | 'standing_unidentifiable'
  | 'missing_send_message_capability';

interface SendCheckInput {
  readonly conversation: Conversation;
  readonly senderId: UserId;
  readonly dependencies: CommunicationDependencies;
}

export interface SendCheck {
  readonly rule: SendDenialRule;
  readonly evaluate: (input: SendCheckInput) => Result<void, DomainError>;
}

function denial(
  rule: SendDenialRule,
  code: DomainErrorCode,
  message: string,
  details: Record<string, string> = {},
): Err<DomainError> {
  return domainError(code, 'communication', message, { rule, ...details });
}

export const SEND_CHECKS: readonly SendCheck[] = [
  {
    rule: 'blocked',
    evaluate: ({ conversation, dependencies }) =>
      dependencies.blocking.isBlockedEitherWay(
        conversation.participants[0],
        conversation.participants[1],
      )
        ? denial('blocked', 'permission_denied', 'a block is in force between these participants')
        : ok(undefined),
  },
  {
    rule: 'not_a_participant',
    evaluate: ({ conversation, senderId }) =>
      peerOf(conversation, senderId) === null
        ? denial('not_a_participant', 'permission_denied', 'the sender is not a participant', {
            senderId,
          })
        : ok(undefined),
  },
  {
    rule: 'match_not_for_conversation',
    evaluate: ({ conversation, dependencies }) =>
      dependencies.match.conversationId !== conversation.conversationId
        ? denial(
            'match_not_for_conversation',
            'conflict',
            'the match projection describes a different conversation',
          )
        : ok(undefined),
  },
  {
    rule: 'match_not_active',
    evaluate: ({ dependencies }) =>
      dependencies.match.state !== 'active'
        ? denial('match_not_active', 'not_eligible', 'the match is no longer active', {
            matchState: dependencies.match.state,
          })
        : ok(undefined),
  },
  {
    rule: 'conversation_not_open',
    evaluate: ({ conversation }) =>
      isMessagingOpen(conversation.state)
        ? ok(undefined)
        : denial('conversation_not_open', 'not_eligible', 'the conversation is not open for messaging', {
            conversationState: conversation.state,
          }),
  },
  /*
   * The two entries below are the only place in this package that looks at a
   * standing, and they exist as two entries rather than one because a wiring
   * fault and a product refusal are different events: one is an operator's
   * problem and the other is a user's, and collapsing them would make a
   * mis-wired projection look like a restriction to whoever reads the logs.
   *
   * A standing arrives from another domain's store, so *absent* and
   * *describing somebody else* are both real states of the world: a read that
   * failed, a cache that was never warmed, a caller that wired the wrong user
   * in. Both refuse the send. The `typeof` guards turn a projection that never
   * loaded into a denial rather than a `TypeError`, and the equality tests are
   * what stop the gate reading the sender's standing twice and calling the
   * result symmetric.
   */
  {
    rule: 'standing_unidentifiable',
    evaluate: ({ conversation, senderId, dependencies }) => {
      const { senderStanding, peerStanding } = dependencies;
      // `undefined` only when the sender is not a participant, which rule 2
      // has already denied by the time this runs.
      const counterparty = conversation.participants.find((id) => id !== senderId);
      const senderIdentified =
        typeof senderStanding === 'object' &&
        senderStanding !== null &&
        senderStanding.userId === senderId;
      const peerIdentified =
        typeof peerStanding === 'object' &&
        peerStanding !== null &&
        peerStanding.userId === counterparty;
      return senderIdentified && peerIdentified
        ? ok(undefined)
        : denial(
            'standing_unidentifiable',
            'external_dependency_failed',
            'an account standing could not be evaluated',
            { party: senderIdentified ? 'counterpart' : 'sender' },
          );
    },
  },
  {
    // One rule, one code, one message and one detail set, evaluated over both
    // participants — so a sender who is restricted and a sender whose
    // counterpart is restricted receive the same error and neither can tell
    // which it was about. The branches stay inside this single `denial` call:
    // two similar ones would be free to drift, and the drift is the leak.
    rule: 'missing_send_message_capability',
    evaluate: ({ dependencies }) => {
      const { senderStanding, peerStanding } = dependencies;
      const senderMaySend = senderStanding.capabilities.includes(SEND_MESSAGE_CAPABILITY);
      // `=== true` rather than `!canSendMessages`: a projection carrying
      // something other than the boolean it is declared to carry is malformed,
      // and malformed fails closed here as well.
      const peerMaySend = peerStanding.canSendMessages === true;
      return senderMaySend && peerMaySend
        ? ok(undefined)
        : denial(
            'missing_send_message_capability',
            'permission_denied',
            'messaging is not available on this conversation',
            { capability: SEND_MESSAGE_CAPABILITY },
          );
    },
  },
];

/**
 * Pure authorisation. It reads projections and a conversation snapshot; it
 * mutates nothing, publishes nothing, and never decides that a message is
 * unacceptable — that judgement does not exist anywhere in this package.
 */
export function canSend(
  conversation: Conversation,
  senderId: UserId,
  dependencies: CommunicationDependencies,
): Result<void, DomainError> {
  for (const check of SEND_CHECKS) {
    const verdict = check.evaluate({ conversation, senderId, dependencies });
    if (!verdict.ok) {
      return verdict;
    }
  }
  return ok(undefined);
}

/**
 * Reading is asymmetric, and that asymmetry is the whole point of a block. The
 * blocker keeps their history — they may need it to report later. The blocked
 * party loses read access immediately and unconditionally, including while the
 * conversation is still formally `active` on this side of the projection.
 * Ended and frozen conversations keep both parties' read access, because the
 * history is evidence.
 */
export function canView(
  conversation: Conversation,
  viewerId: UserId,
  blocking: BlockingReadModel,
): Result<void, DomainError> {
  const peer = peerOf(conversation, viewerId);
  if (peer === null) {
    return denial('not_a_participant', 'permission_denied', 'the viewer is not a participant', {
      viewerId,
    });
  }
  if (blocking.isBlockedBy(peer, viewerId)) {
    return denial('blocked', 'permission_denied', 'this participant has blocked the viewer');
  }
  return ok(undefined);
}
