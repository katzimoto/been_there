# Decision — Avatar Introductions: the three product decisions

> Raised by [#62 — Avatar introductions: three product decisions that are
> cheaper now than after an avatar ships](https://github.com/katzimoto/been_there/issues/62).
> Specified by [`../features/avatar-introductions.md`](../features/avatar-introductions.md).
> Authority: [`../architecture/00-overview.md`](../architecture/00-overview.md). If this
> document contradicts it, that document wins.
>
> **Status: awaiting the user's decision. Nothing in §3, §4 or §5 is in force.**
> Each question is recorded with its options, what each option costs, what each
> option forecloses, and one recommendation. The recommendation is an argument,
> not a default: until the question is answered, an implementer has no rule to
> code and the feature cannot ship past #57.

## 1. What this document is

[#54](https://github.com/katzimoto/been_there/issues/54) specifies the track well
enough to build four features from, and it names its own open decisions. This
document covers only the three that #62 identifies as **load-bearing**, and it
uses #62's own framing for each, because a paraphrase of a product question is
how a product question gets answered by accident.

| Question | Where it bites | Raised in |
|---|---|---|
| 1. When, and how, is a user told they are talking to an avatar? | The introduction, the conversation it opens, and the copy on both | [#62](https://github.com/katzimoto/been_there/issues/62) |
| 2. What does "mutual human interest" mean when one party's interest was produced by their own avatar? | The gate that opens a real chat | [#62](https://github.com/katzimoto/been_there/issues/62) |
| 3. Who bears a mistake? | A user who is never introduced, and a user whose avatar misrepresented them | [#62](https://github.com/katzimoto/been_there/issues/62) |

The vocabulary is taken from the issues rather than invented: **matching-only
use**, **private simulation**, **human-facing sharing**, **introduction
candidate**, **shareable information** (from
[#54](https://github.com/katzimoto/been_there/issues/54) and
[#56](https://github.com/katzimoto/been_there/issues/56)),
**read-only after end**, **bound to its event** (from
[`../architecture/event-chat-safety.md`](../architecture/event-chat-safety.md)),
and **decisions a human still owns** (from
[`../delivery-state.md`](../delivery-state.md)).

## 2. What is not asked here

Three things are already decided and this document does not reopen them:

- **Event messaging may bypass the match gate for events**, with the rules in
  [`../architecture/event-chat-safety.md`](../architecture/event-chat-safety.md)
  §1–§3. That document is the safety model for events; it is a different track
  from avatars and answers none of the three questions below.
- **The delivery order.** #62 settles it: **#56 before #57 before #59**, because
  "human-facing sharing" has to be an enforced, versioned boundary rather than a
  field on a knowledge item, or the shareable subset gets retrofitted to whatever
  the avatar happened to need. §6 restates what that forecloses.
- **The simulation rules in #54 and #58.** Dialogue is temporary, excluded from
  routine logs, analytics, permanent avatar memory and training; a simulation's
  only product effect is an introduction candidate; an unsuccessful simulation
  leaves no lasting rejection label. Those are settled. What is not settled is
  question 3 below, which is about what the *owner* is told, not about what is
  stored about the *other* person.

## 3. Question 1 — when, and how, is a user told they are talking to an avatar?

#62 states the risk precisely, and the precision is what makes this a product
decision: *"Even with full disclosure at the introduction point, the conversation
that follows is with a representation, and that is where the deception risk lives
rather than at the introduction."* The recipient of an introduction believes a
person read their profile and chose them. They did not.

### 3.1 The options

**Option A — disclose at the introduction, and mark nothing afterwards.**
The introduction screen states that an avatar reviewed the profile and produced
this suggestion. The conversation that opens from it is rendered exactly like a
match conversation: two people, no marker.

- **Costs:** the entire honesty burden rests on one screen, which a user reads
  once and dismisses. The conversation is where the belief actually lives, so the
  disclosure is weakest exactly where it matters most. Every future "why did I
  not know?" complaint is answered by pointing at a screen the user no longer
  remembers, and the answer is still correct.
- **Forecloses:** the ability to add the marker later. A marker added after the
  fact has to be retrofitted onto conversations already stored, which is a data
  migration and a client change, and which produces exactly the "misleading after
  the fact" state option A was chosen to avoid. It also forecloses any claim that
  the feature was honest about what happens *after* the introduction.

**Option B — disclose at the introduction, and mark the conversation permanently.**
The introduction screen states it, **and** every conversation opened from an
introduction carries a non-dismissible marker saying it began with an avatar. This
is the same mechanism, used the same way, that `event-chat-safety.md` §3 already
requires for event-sourced conversations.

- **Costs:** a permanent element on a chat surface, in every client — phone and
  web — for the life of the conversation. It cannot be a one-time interstitial,
  because a thread reopened a month later is exactly the surface where the belief
  re-forms. It also constrains the introduction writer: the copy can no longer
  imply that a person read the profile, because the conversation will contradict
  it.
- **Forecloses:** the clean chat surface. A conversation that reads as two humans
  to the person who has not re-read the introduction is the product outcome this
  option declines to have.

**Option C — disclose on request only.**
No proactive disclosure. The owner may ask what an introduction was, and is told.

- **Costs:** a user is never told unless they go looking, so the feature's
  central claim rests on the recipient happening to wonder.
- **Forecloses:** nothing technically. It forecloses the product being able to
  describe itself as disclosing, which is the claim every other option in this
  table buys. Recorded because the cost of option B is real and this is the
  honest way to price it: if the marker is judged unacceptable, this is what
  rejecting it looks like, and it should be rejected deliberately rather than by
  default.

**Option D — the avatar introduces, and the conversation is human-to-human from
the first message.**
The avatar's work ends at the introduction. The introduction states that an avatar
produced it. If both people respond with interest, the conversation that opens is
between two people, and there is nothing to mark because nothing is being
represented in it.

- **Costs:** the warmth the feature sells is one message deep. The user's
  counterpart's avatar does not greet them, does not carry their tone into the
  first exchange, and cannot say the thing an avatar would have said in their
  voice. #54's promise that the avatar represents personality, communication
  style, values and boundaries faithfully is honoured in the private simulation
  and not in the product.
- **Forecloses:** the ability to add a represented voice to a real conversation
  later without changing the disclosure design, because the disclosure design
  here is "there is nothing to disclose about this conversation".

### 3.2 Recommendation

**Option B.**

The reasoning, and it is the same reasoning that produced the event-sourced
conversation rule: *a conversation's meaning is carried by the conversation, not
by the screen that created it.* An introduction is read once under time pressure;
the thread it opens is read for weeks. Disclosure that lives only at the
introduction is disclosure that decays, and the thing it decays fastest from is
the belief the recipient actually holds.

Option B is also the cheapest of the honest options, because the mechanism
already exists as a product commitment: `event-chat-safety.md` §3 requires that a
conversation bound to an event be *"labelled as event-sourced everywhere it is
rendered or reviewed"*. One labelling mechanism, used for both, is cheaper to
build correctly than two that drift.

What option B costs, stated plainly: a permanent chat-surface element in every
client, and an introduction writer whose copy may not imply a human read the
profile. Both are real. Neither is a safety property, and this document does not
trade a safety property for either.

If the user judges a permanently labelled conversation surface unacceptable, the
honest fallback is **option D**, not option C: option D keeps the disclosure
while giving up the represented voice, and option C gives up the disclosure.

**What the answer changes.** Under B, the feature specification gains a
conversation-labelling rule and a copy rule, and every client surface carries the
marker. Under D, the feature specification states that no conversation ever
contains a represented party. Under A or C, an unlabelled conversation exists and
the specification has to say, in writing, that this was chosen.

## 4. Question 2 — what "mutual human interest" means when an avatar produced one side of it

[#59](https://github.com/katzimoto/been_there/issues/59) requires that mutual
human interest open one real chat. #62 names the failure mode: *"Nothing prevents
an implementation from treating avatar-approves-avatar as mutual interest and
opening a chat between two people who have expressed none."*

### 4.1 The options

**Option A — only a person can express interest. The avatar's evaluation only
proposes.**

- **Costs:** the conversion bottleneck moves from the simulation to the recipient's
  availability. An introduction delivered at 3am waits for a person who may not
  open the app for a day, and half of all introductions may expire unopened, which
  is a product problem and a measurement problem, not a safety one.
- **Forecloses:** the asynchronous promise in #54's product journey — "automatic
  private avatar dates → immediate introductions → mutual human interest". Under
  A, the word "automatic" reaches the introduction and stops there.

**Option B — the recipient's avatar may express interest on their behalf.**
Interest is (the introducing avatar found a fit) ∧ (the recipient's avatar
approved the introducer).

- **Costs:** the recipient's avatar can open a conversation with someone who has
  expressed nothing, and that person can wake to a matched conversation with a
  stranger. This is the same structural weakening `event-chat-safety.md` §1
  accepts for a host reaching a room, applied to a person who was never in the
  room and did not know they were being addressed.
- **Forecloses:** the phrase "mutual human interest" as a description of the gate.
  The chat would open on *mutual avatar interest*, which is a different product
  and would have to be disclosed as such — which folds question 2 back into
  question 1.

**Option C — either side may be an avatar, including avatar-approves-avatar.**

- **Costs:** a chat can open between two people who have each expressed nothing,
  from two conversations neither of them can read. The failure is not a bad
  outcome, it is a conversation whose participants did not choose it.
- **Forecloses:** the match-gate invariant in its existing form. This is the
  option #62 describes as the thing an implementation would drift into, listed so
  that "we did not decide this" cannot be the reason it happened.

### 4.2 Recommendation

**Option A.**

The gate that opens a conversation with a stranger should be a person pressing a
button. Every existing conversation in this system is opened that way, through the
match gate in [`../architecture/communication.md`](../architecture/communication.md)
§4, and the reason it works is that both parties acted. An avatar acting for its
owner is the same decision made by something the owner cannot audit at the moment
they made it, which is the same weakness the introduction itself has.

Option A is also what keeps question 1 cheap. Under B or C the conversation is
between a representation and a person, and option B of question 1 — a permanent
marker on every such conversation — becomes the load-bearing disclosure rather
than a safeguard.

**What the answer changes.** Under A, the feature specification states the gate as
two `interested` actions by two people, and states that the avatar's evaluation is
a proposal that cannot open anything. Under B or C it must state which side may
be represented, and both options require an answer to question 1 before any
conversation can open.

## 5. Question 3 — who bears a mistake?

[#54](https://github.com/katzimoto/been_there/issues/54) and
[#58](https://github.com/katzimoto/been_there/issues/58) both settle the storage
question: *"an unsuccessful simulation creates no lasting rejection label"* — a
result about another person must not become a durable fact about you. That is
right, and it is settled. What #62 asks is the mirror question, about the person
the avatar speaks for: **a user who is never introduced because their avatar was
written unkindly has no recourse and no signal.**

### 5.1 The options

**Option A — nobody. The status quo, kept.**
A failed run leaves nothing the owner can see.

- **Costs:** the failure is invisible *to the person it happened to*. Someone whose
  avatar is unkind, or badly written, or activated on a day they were not
  themselves, sees nothing, can change nothing, and has no way to distinguish "my
  avatar is not working" from "the product is not working" from "nobody is
  interested in me". That last confusion is the expensive one: it is a product
  that has convinced a person it is their own fault.
- **Forecloses:** nothing technically. It forecloses the feature being able to
  answer a support question, and it leaves an invisible harm that the spec would
  be claiming to have handled.

**Option B — an owner-only record of the run's shape, never its content.**
The owner may always see that a run happened, which avatar version it used, and
whether it produced an introduction candidate. Never why about another person,
never a score, never anything another user can see, and never an input to risk or
moderation.

- **Costs:** it needs a retained record of an *outcome*, which brushes against
  #54's rule that only minimal scheduling records may be kept and which must not
  retain private conclusions. The record has to be shaped so it carries no
  conclusion: "a run happened, this version, no candidate" is a fact about the
  owner's own process; "nobody was interested in you" is a conclusion about
  someone else and is exactly what must not be stored. It also needs copy that
  does not imply a verdict — the owner is being told their avatar ran, not that
  it failed.
- **Forecloses:** nothing in the roadmap. It forecloses a support workflow that
  wants the *reason*, because the reason is about the other person and #54
  already settled that it is not ours to keep.

**Option C — a human reviews the avatar when its owner says it misrepresents
them.**

- **Costs:** human capacity, and a moderation surface that would have to read what
  the avatar said in order to judge whether it was faithful. Reading the
  simulation conclusions into moderation is in direct tension with #54's rule that
  dialogue never enters permanent memory and with the review-finding that the
  moderation queue should not become a place where unreported people are scored.
- **Forecloses:** the separation between "automation observes" and "a human
  decides". A moderator looking at an avatar to judge a complaint about it is
  close enough to enforcement that it needs a case and a retention decision, which
  is a different project.

### 5.2 Recommendation

**Option B, in the narrow shape above.**

The failure mode being fixed is a person who cannot tell the product's silence
from their own failure. Option B answers exactly that and nothing more: the owner
can see that their avatar ran, and can therefore change it, re-run it, or ask a
human "nothing happened, why" with a real fact in hand.

Two rules make it safe, and both are non-negotiable if B is chosen:

1. **The record is about the owner's process and never about the other person.**
   It holds: a run happened, the avatar version it used, whether a candidate was
   produced. It does not hold, and no future change may add, any field about why
   the candidate was not produced.
2. **An avatar outcome is never an input to Trust & Safety or Moderation.** It
   would be an automated score about a person derived from nothing a human
   reported, which is precisely the shape the detection-before-first-report metric
   is designed to be unmeasurable by
   ([`../delivery-state.md`](../delivery-state.md), "Why the safety metric is
   stuck"). It also never touches the completed-date counter
   ([#49](https://github.com/katzimoto/been_there/issues/49)), never a profile,
   never a match, and never a reputation — all four are already required by
   [#58](https://github.com/katzimoto/been_there/issues/58), and this is the rule
   that keeps the owner's view of it out of everyone else's.

**What the answer changes.** Under B, the feature specification gains an
owner-only run record with the two rules above. Under A it states, in writing,
that a failed run is invisible to its owner, which is a claim the specification
would then be making on the user's behalf.

## 6. The delivery order is decided and is not reopened here

#62 settles it and the reasoning is not a preference: **#56 (knowledge and
permissions) before #57 (the avatar) before #59 (introductions)**.

[#59](https://github.com/katzimoto/been_there/issues/59) requires the
introduction writer to receive only information approved for human-facing
sharing. If #59 lands first, that approval has no home, and the shareable subset
becomes whatever the writer needed — so every knowledge item is shareable by
default, which is the failure mode permissions exist to prevent.

Concretely: **#56 defines the four permission scopes as an enforced, versioned
boundary, not as a field on a knowledge item.** A flag on a knowledge row is not a
boundary, because nothing stops the next reader from treating "shareable" as a
default and the row as a suggestion.

## 7. If no answer arrives

Nothing in §3–§5 is implemented on the strength of the recommendations. The
recommendations are written so that a reader can disagree with them specifically.

- **Question 1 unanswered:** no conversation opens from an introduction. The
  introduction may be shown; the chat gate stays closed. This is the failure mode
  #62 is about, and it is the one thing that cannot be shipped as a default.
- **Question 2 unanswered:** the chat gate is two human `interested` actions, which
  is option A and is also the current behaviour of every conversation in the
  product. Building the stricter thing first is not wasted work; it is the
  behaviour the product already has.
- **Question 3 unanswered:** no run record, and the owner is told nothing. This is
  option A, which is what #54 and #58 already say, so the track is not blocked —
  but §5.1's cost applies and it should be a decision rather than a default.

Questions 2 and 3 have a safe direction because the existing product already has
one. Question 1 does not, which is why it is the blocking one.

## 8. Open questions about these options

Recorded rather than guessed.

- **Whether the conversation marker (question 1, option B) is one mechanism or
  two.** `event-chat-safety.md` §3 requires an event-sourced label. Whether an
  avatar-sourced label is the same label with a second value, or a separate one,
  is a rendering decision that should follow the answer to question 1 rather than
  pre-empt it.
- **Whether a saved-for-later introduction is a delivery for the purposes of
  question 1.** #59 has three recipient actions (`interested`, pass,
  save-for-later), and "save" is the one where the conversation is not open, so it
  is the one where a marker is not yet needed. Whether the marker appears when a
  saved introduction is later acted on, or when it is saved, is unanswered.
- **Whether an avatar outcome may ever be shown to a second user of the same
  account.** Nothing in this document permits it; whether a household or a shared
  account model ever needs it is not in scope.
- **What an introduction says when the avatar has nothing permitted to share.**
  #59 forbids private transcripts, reasoning, scores and compatibility
  percentages. An introduction with no shareable reason is possible under the
  permission scopes, and whether one is delivered or withheld is unanswered. It
  belongs to #59 and is recorded there too.