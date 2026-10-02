# Trust & Safety Engine

> Issue [#6](https://github.com/katzimoto/been_there/issues/6). Contract:
> [System domains & boundaries](./00-overview.md). Package: `packages/trust-safety`.
> Decision: [ADR 0004 — automation never enforces](./adr/0004-automation-never-enforces.md).

## 1. What this domain is for

Issue #1's primary safety metric is **confirmed malicious accounts detected
before another user reports them**. That single sentence decides most of this
document:

- detection must be early, cheap and automatic, because the alternative is
  waiting for a victim;
- it must not be able to end anybody's access, because being wrong is
  guaranteed and being wrong irreversibly is not survivable;
- the output has to be something a human can act on in under a minute.

The engine converts *observed behaviour* into *risk information*. It never
converts risk into a decision about an account, and it never has the vocabulary
to do so.

**Done when** (issue #6): observed behaviour converts into risk information
through a pure, tested function, and no detector can make an irreversible
moderation decision — the type system enforces it, not a review convention.

## 2. Owns / never owns

| Owns | Never owns |
|------|-------------|
| The `Signal` value object: detector, subject, actor, time, bounded weight, corroboration key, declared escalation status, derived facts | Any account state. `AccountState` is moderation's; this package cannot write it even by accident |
| The detector port: what a detector may observe, and the vetting of what it emits | Detector implementations' internal logic, and the storage they read |
| The reduction seam (`observation.ts`, `pipeline.ts`): which published events become observations, at what clearance, reduced to which fields | Any domain's internals. The seam reads delivered events at `internal` clearance and nothing else; a field it does not name cannot cross |
| The signal ledger: bounded retention, corroboration counting, repeat counting | Signal storage technology, retention *policy* (see open questions) |
| The risk assessment: `Signal` + current state → next state, via the shared `riskMachine` | The risk *state machine* itself — that is `packages/core/src/states/risk.ts` |
| Escalation policy: the declared escalation status, reliability discount, repeat multiplier, single-detector ceiling | Account capabilities, enforcement, appeals |
| The reversible friction catalogue — the complete list of what automation may ever propose | Applying friction: every kind is a proposal consumed by the owning domain |
| Review-candidate selection and queue ranking | The review queue itself, case creation, or moderator decisions |
| The false-positive policy: dispute intake, fail-open on friction, notice suppression | The wording of user-facing copy, and any statement about a user's risk |
| Publishing `risk.changed`, `review_candidate.raised`, `friction.proposed` (all `internal`) | User-facing copy, profile content, discovery eligibility, identity evidence |

## 3. Detection → policy → enforcement

Three layers, three directories, three failure modes. The split is structural:
the enforcement layer **is not in this package**, and no type in this package can
name an account state, a case, or a moderator.

```
 Published events, delivered on the bus
 (identity.status_changed, unmatch.performed, communication.message_sent, …)
        │
        │  observation.ts — the reduction seam, at `internal` clearance:
        │  OBSERVATION_REDUCTION names the event, its kind and its fields;
        │  toObservation() refuses what is above the clearance, and returns
        │  null for what it has no rule for. The result is metadata only:
        │  { kind, occurredAt, actorId, subjectId, counterpartyId?, entityId?, count? }
        ▼
 ┌──────────────────────────── DETECTION ─────────────────────────────┐
 │  signal.ts     Signal value object — bounded weight, no content     │
 │  detector.ts   Detector { name, reliability, category, detect() }   │
 │                runDetector() builds the context and vets the output │
 │  detectors.ts  the implemented catalogue; pipeline.ts subscribes,   │
 │                reduces, indexes per account and runs them          │
 │  ⇒ Signal[]   evidence about a behaviour, attributed to one detector│
 └────────────────────────────────┬───────────────────────────────────┘
                                  ▼
 ┌────────────────────────────── POLICY ──────────────────────────────┐
 │  correlation.ts  ledger → independent detectors, repeats, campaigns │
 │  policy.ts        score → event + context → riskMachine.next()     │
 │  friction.ts      risk state → reversible proposals                │
 │  review.ts        which subjects are worth a human's minutes        │
 │  ⇒ risk state, at most three expiring proposals, a queue entry      │
 └────────────────────────────────┬───────────────────────────────────┘
                                  ▼   risk.changed / review_candidate.raised
 ┌───────────────── ENFORCEMENT — not this package ──────────────────┐  friction.proposed   (internal)
 │  packages/moderation: a Case, a named moderator, accountMachine.  │
 └──────────────────────────────────────────────────────────────────┘
```

**Why the absence is structural.** A detector's entire input is
`DetectorContext`, which is three fields — `now`, `observations`,
`priorSignals` — asserted exhaustively at compile time in
`test/type-guarantees.test.ts`. There is no account state to read, no
repository handle, no clock. `SignalInput`, the only thing a detector may
return, has no field a decision could hide in, and `createSignal` rejects any
fact outside the closed `SignalFacts` vocabulary. The word "ban" does not appear
in this package's types.

Four further checks sit on a seam rather than in a convention, and each of them
is a test:

- `toObservation` refuses an event classified above `internal`, so a restricted
  record cannot be laundered into a detector's input by a transport that hands
  over everything it is given;
- `runDetector` may only implicate an account that appears in the detector's own
  input, so a detector bug cannot aim risk at an arbitrary user;
- `applySignal` refuses a signal whose subject is not the record's subject, so a
  wiring bug cannot write one account's evidence onto another's risk state;
- `createSignal` enforces the attribution rule in §4, so "who did this" cannot
  drift between the ledger and the policy, and refuses a `self_escalating`
  declaration that its own weight and reliability cannot clear 0.5 with, so a
  detector cannot hold the strong status and never fire;

### The reduction seam

`toObservation(event, now)` in `observation.ts` is the only way a published
event becomes something a detector can see, and its three outcomes are
deliberately different things:

- **an observation** — the event has a row in `OBSERVATION_REDUCTION`. A row
  names the kind, why a detector needs the fact, and the exact fields the
  observation is built from: `actor`, `subject`, and where they exist
  `counterparty`, `entity`, `count`. A payload field that no row names cannot
  reach an observation, so a message body, a report statement or a provider
  label has no path across even if a producer puts one in its payload. What a
  producer already derived is taken as published — `messagesLastHour` is
  Communication's own count — rather than re-derived here.
- **`null`** — the event is within the clearance and no row covers it. Unmapped
  is not refused: a match created, a block recorded, a profile deleted. Not
  this domain's business, and nothing is retained about it.
- **an `Err`** — the event is above `REDUCTION_CLEARANCE`, is dated after the
  moment it was observed, or has lost a field its row names. Refused loudly,
  because the alternative is a fact quietly changing tier.

The mapping is a `Record<ReducibleEventType, ReductionRule>` rather than a
switch, so a new published event either maps — visibly, as a row a reviewer
reads — or reduces to nothing. `ReducibleEventType` is a hand-written union and
the table is annotated `Readonly<Record<ReducibleEventType, ReductionRule>>`,
so a row for a type nobody subscribed to, and a subscribed type with no row, are
both build failures rather than drift.

`pipeline.ts` is the rest of it. `createSafetySeam` subscribes to a transport at
`internal`, reduces what arrives, indexes each observation under the two
accounts it is about (bounded at 256 per account, oldest dropped), and runs the
catalogue. It holds no risk record, no ledger and no account state: `detect`
returns evidence, and what evidence is worth is §6's decision. A detector that
fails is reported in `DetectionRun.failures` rather than thrown, because a cycle
that stops is a cycle that sees nothing. The seam consumes whatever a transport
delivers; whether a domain has wired its catalogue to one is that domain's
business, and the seam does not care — it decides on the event in front of it.

One consequence of where the clearance sits is worth stating plainly, because it
is why a report needs a second event rather than a second clearance: **a report
is not an observation.** `moderation.report_submitted` is `restricted`, so it is
refused here. What crosses instead is the join below, and it crosses without the
record.

### The report leg: a join key, not a wider clearance

`interaction.unmatch_report` is the one catalogue entry that needed the report
leg, and `moderation.report_submitted` could not supply it for two independent
reasons. It is `restricted`, so the seam refuses it — correct, because reducing
a record into an internal fact is the move a sensitivity class exists to
prevent. And its payload named no match, no conversation and no counterparty, so
the pairing was not derivable *at* `restricted` either. The second is the
serious one: a clearance can be changed by a decision, missing data cannot.

The fix is a second event, not a second clearance. Moderation publishes
`moderation.report_pairing` at `user`, carrying a **keyed join token** and
nothing else: an HMAC over the report id, the match the report came from and the
account it is about, under a secret that belongs to one deployment. The
restricted record is unchanged — `{reportId, reason, anonymous}`, no
counterparty, no match, no reason code a detector can read.

The detector never sees the identity. It holds an unmatch (which names a match
it may already see) and a report observation (which carries a token), and pairs
them only when the token is the one derived from that unmatch's match. Trust &
Safety never hashes anything: it is given a `PairingMatcher`, built by the
deployment from its secret, and asks one question.

**What the token still leaks.** It is a join key, and a join key is not free. A
token is stable for a given (report, match, subject) triple, so two events
carrying the same token are the same triple; anyone holding many tokens and a
small enough user population can still correlate, and anyone holding the secret
can test a candidate match id against a token — which is exactly what the
matcher does. What the arrangement buys is narrower and worth stating precisely:
no party learns *who reported whom*, and a detector author cannot learn it
later by writing a new row. The accountability question — who answers for a
detector whose input is a report about an identifiable person — is **not**
settled by this design and is recorded in §13.

The token appears on that one event and nowhere else: not on the restricted
record, not in the audit log, not in an error. The reduction is the other half
of the guarantee — `moderation.report_pairing` is the only row that names
`pairingToken`, and the seam still refuses it at `sensitive` and `restricted`.

Two consequences worth naming. The pairing event's performer is the *reported*
account, so `report.coordinated_target` still has no producer: the token cannot
express "somebody else reported this", and §8's rule that reports are
accusations and never evidence is untouched. And a seam is built with either a
detector list or a pairing secret, never neither and never both — a detector
that cannot verify a token must not be silently constructible and silently
inert.

One producer-side assumption is worth naming, because the reduction does not
paper over it: `unmatch.performed` carries the performer in its payload and
reaches the other account through the envelope's `subjectId`. A producer that
puts the performer there as well — or leaves it off — produces an observation
whose performer and subject are the same account, and
`interaction.unmatch_by_counterparty` stays silent rather than attributing an
unmatch to the account that did it. A detector that cannot tell who was
unmatched does not guess.

**The one thing automation may do to a user** is listed in §7, and every entry
expires. That is the entire authority surface.

## 4. Signal model

A `Signal` is a claim about a behaviour, made by one named detector, at one
time, with a bounded weight.

| Field | Why it exists |
|-------|----------------|
| `detector` | Every piece of evidence names its author. Nothing is anonymous. |
| `reliability` | `low`/`medium`/`high`, declared by the port and discounted in policy, never self-assessed by a draft |
| `escalation` | `corroboration_only` or `self_escalating`, declared by the port and read by policy. Required, so a new detector has to choose; a `self_escalating` signal that cannot clear 0.5 unaided is refused at construction (§6) |
| `subjectId` | The account whose risk may move |
| `actorId` | Whose behaviour it is. Equal to `subjectId` except for `report_against`, and `createSignal` rejects any other mismatch |
| `behaviour: { kind, entityId }` | The **corroboration key**: two detectors that see the same behaviour emit the same key, without knowing each other exists |
| `occurredAt` | Evidence time, not detection time — a replayed backlog must not look fresh |
| `weight` | `0 < w ≤ 1`, checked. Never a probability of guilt, never a score out of 100 |
| `facts` | The closed vocabulary: `occurrences`, `windowMinutes`, `distinctCounterparties`, `cluster`, `direction`, `humanPaced`. No content can be attached, because no content field exists |

`entityId` is always an opaque platform id (a match, a conversation, a target
subject). Exact location, verification artefacts, message bodies and photos
cannot enter this package: they are `sensitive` elsewhere and have no field here.

## 5. Signal catalogue

Base weights are what the detector declares; the effective score is that weight
after the reliability discount and the repeat multiplier (§6).

**Escalation** is the detector's own declaration of whether it may move a
subject on its own evidence, read by the policy layer from the signal and never
from a list of names: `SignalAuthor.escalation` is required, so a detector that
does not choose does not compile. `—` means there is no detector to declare.
Every detector in the catalogue is `corroboration_only` and none is
`self_escalating`, because none of the declared weights clears 0.5 unaided. The
reasoning, the arithmetic and the accepted cost are in
[`detector-escalation-policy.md`](detector-escalation-policy.md); §6 says what
the policy does with the declaration.

The input column names `ObservationKind`s, and a kind is spelled the way the
domain that publishes it spells the event — `unmatch.performed`, not
`unmatch_initiated`. The vocabulary used to be a parallel snake_case scheme
that shared no spelling with any catalogue, which is how §5 could describe
detectors reading inputs that no domain emitted. Status says what exists today:
**implemented** means the detector is in `detectors.ts` and every kind it reads
has a row in `OBSERVATION_REDUCTION`.

| Detector | Inputs (`ObservationKind`) | Behaviour key | Base weight | Reliability | Escalation | Status | Known false positives |
|----------|---------------------------|---------------|-------------|-------------|------------|--------|-----------------------|
| `interaction.unmatch_report` | `unmatch.performed` + `moderation.report_pairing`, paired on the token | `unmatch_then_report:<matchId>` | 0.6 | high | `corroboration_only` | implemented — the report leg is the pairing token, not the record (§3) | A user unmatching and then reporting a genuine scammer; one action producing both events; a match ending during a report flow. The ordering requirement (unmatch first) is what excludes a report filed while the match was still live |
| `report.coordinated_target` | `moderation.report_submitted` where actor ≠ subject | `report_against:<subjectId>` | 0.9 | high | `corroboration_only` | **no producer** — `restricted` (§3) | **Never risk-bearing** (§8). Its only output is campaign detection, so the cost of its false positives is paid by reviewers, not by users |
| `velocity.message_burst` | Batched `communication.message_sent` counts | `message_velocity:<conversationId>` | 0.4 | medium | `corroboration_only` | implemented | New matches, replies after a long gap, emoji-heavy chat, a user with a very talkative partner |
| `velocity.like_burst` | Batched `like.recorded` counts | `like_velocity:<subjectId>` | 0.35 | low | `corroboration_only` | implemented | Power users, a user returning after a break, anyone on a bad phone |
| `interaction.unmatch_by_counterparty` | `unmatch.performed` where the subject is the other account | `unmatch_by_counterparty:<matchId>` | 0.5 | low | `corroboration_only` | implemented | Popularity. Deliberately low: "many people unmatched me" is the *opposite* of evidence about me |
| `identity.reuse` | `verification.attempt.started` + `identity.status_changed` | `identity_reuse:<verificationId>` | 0.45 | medium | `corroboration_only` | implemented | Re-verification after a long absence, shared family devices, provider misreads, an appeals flow that re-submits |
| `network.device_cluster` | `*` batched into a coarse `cluster` label | `device_cluster:<clusterId>` | 0.5 | medium | — | **not implemented** — no domain publishes a cluster label; `SignalFacts.cluster` has no producer for it | Shared wifi, carrier NAT, a household, an office, a single popular handset model |
| `dating.profile_churn` | Batched `profile.state_changed` | `profile_churn:<subjectId>` | 0.3 | low | `corroboration_only` | implemented | Someone still filling in their profile; an experiment; an accessibility tool rewriting a bio |
| `communication.external_links` | `communication.message_sent` metadata carrying a link count, never a URL | `external_link_sharing:<conversationId>` | 0.4 | low | — | **not implemented** — Communication publishes no link count, and a URL is not a fact this layer may reduce | Ordinary link sharing, which in a dating product is often an Instagram handle |

The window thresholds the implemented detectors use are in `detectors.ts` and
are the unvalidated guesses §13 admits to: 25 outbound likes in an hour, 30
messages in an hour in one conversation, 10 profile rewrites in a week, and a
7-day window between a verification attempt and the state change behind it.

Five catalogue rules, and they are the reason the table looks the way it does:

- **No detector reads identity evidence.** It reads `identity.status_changed`
  and `verification.attempt.started` — that a thing happened, not what the
  selfie was. A likeness score is `sensitive` and belongs to Identity, and the
  reduction drops the state name as well as the reason: the observation is the
  account id, not `pending`.
- **Every low-reliability detector is a volume detector.** They fire often, so
  the discount is what stops "frequently observed" from being confused with
  "strongly observed".
- **Every implemented detector is corroboration-only.** Not because of what it
  weighs — because of what kind of evidence it is. A statistical pattern in
  ordinary behaviour cannot put a real user in front of a moderator on its own,
  and no weight in the catalogue clears 0.5 unaided anyway, so the declaration
  costs nothing today and buys the guarantee that a future weight change cannot
  quietly make one loud detector decisive.
- **A catalogue entry with no producer is a design, not a capability.** Three of
  the nine have no implemented detector — two of them because the input they
  need is not published at any clearance, and one because its only possible
  input is a restricted record — so §8's mass-reporting defence is *specified
  but unreachable* until a producer exists. The rest of the catalogue is
  reachable, and the re-verification friction in §7 is not hypothetical:
  `test/pipeline.test.ts` reaches `critical` from two corroborating detectors.
  The corollary is stated in §6's arithmetic: every implemented detector is
  below `normal`'s 0.5 gate even with the maximum repeat multiplier, and every
  one of them declares `corroboration_only`, so on today's evidence no single
  detector can move an account off `normal` at all — not because the arithmetic
  happens to fall short, but because the policy will not ask. Risk rises only
  where a record is already raised, or when two independent detectors
  corroborate.
- **A kind with no consumer is not a hole.** `match.ended`,
  `communication.conversation_state_changed` and `block.created` are declared,
  reconciled to the events that would produce them, and left unmapped: no
  detector reads them, so mapping them would mean storing facts nothing looks
  at. `communication.conversation_state_changed` in particular is not
  "conversation opened" — a fixed kind cannot express *which* transition — and
  nothing in the catalogue wants one. They are the vocabulary's honest margin,
  not its payload.

## 6. Escalation, corroboration, decay

### The score

```
base              = weight × reliabilityDiscount      low 0.7 · medium 0.85 · high 1
repeatMultiplier  = min(1 + 0.05 × repetitions, 1.25)
effectiveScore    = min(base × repeatMultiplier × (corroborated ? 1.15 : 1), 1)
                  and, when fewer than two detectors have spoken, capped at 0.85
```

`repetitions` counts only the same detector, the same subject, the same
behaviour, within 24 hours. `corroborated` means two or more distinct detectors
have spoken about this subject within 168 hours. The score is the weight of the
evidence, reported as found — it is never adjusted to express a refusal,
because a moderator is shown it and a clamped number would be a fiction.

### Who may act alone

The score above decides *how far* a signal reaches. It does not decide *whether
it is allowed to try*, and that is a separate question with a separate answer:
`signal.escalation`.

```
mayActAlone = escalation = 'self_escalating'  or  independentDetectors ≥ 2
```

A `corroboration_only` signal that fails that test is not asked about at all —
the policy does not call the shared machine, so no transition is available to it
and the state is untouched. The decision says so in words, as
`reason: 'corroboration_required'`, which is a different statement from
`below_threshold`: the evidence is worth something, and what it is waiting for is
a second source. The signal is still kept. It enters the ledger, it counts as a
contributing detector, it resets nothing, and it is exactly what a second
detector will be corroborated against.

The declaration is on the detector, required, and read from the signal. The
policy layer contains no list of detector names, so adding a detector to the
catalogue cannot put it in the escalating set by accident, and a detector that
does not declare anything does not compile.

`self_escalating` is checked rather than trusted: `createSignal` refuses a
signal whose own weight and reliability cannot clear `ESCALATION_GATE` (0.5) on
their own, and returns the shortfall and the gate in the error details. Without
that check the strong status would be a label a detector could hold while never
firing, which is indistinguishable from a detector that is broken. With it, a
`self_escalating` signal always escalates on its own from `normal`, and
`test/escalation.test.ts` says so.

The 0.5 guard on `normal → elevated` in the shared table is therefore no longer
reachable through this policy: a `corroboration_only` signal is held whatever it
weighs, and a `self_escalating` one is refused below 0.5 before it exists. The
guard stays — it is the kernel's invariant and this domain does not get to
remove it — but the declaration is what enforces the gate here, and it enforces
it at every level rather than only the first.

### The single-detector ceiling

The shared machine escalates `high → critical` on `score ≥ 0.9` **or**
`corroboratingDetectors ≥ 2`. Taken alone, the first branch lets one loud
detector reach `critical` alone. The policy layer closes that by capping a
single detector's effective score at **0.85** — a ceiling, not a reimplementation.
The machine still owns every transition; the policy only bounds what one source
is allowed to claim. Corroboration is therefore genuinely required for the
highest escalation, and the test says so directly.

The ceiling and the declaration are not the same rule and neither replaces the
other. The ceiling bounds how high a `self_escalating` detector — the only kind
that can act alone — may reach: 0.85 is above `high` and below `critical`, so
even a declared detector that weighs 1.0 stops at `high` without corroboration.

### Event selection

| From | Event | Guard in the shared machine |
|------|-------|-----------------------------|
| `normal` | `signal_observed` | `score ≥ 0.5` → `elevated` |
| `normal`, `elevated` | `threshold_crossed` when corroborated and `score ≥ 0.7` | `score ≥ 0.7` → `high` (the corroborated fast path) |
| `elevated` | `signal_observed` | `score ≥ 0.7` → `high` |
| `high` | `signal_observed` **always** | `score ≥ 0.9` or `corroboratingDetectors ≥ 2` → `critical` |
| `critical` | none | Nothing is legal; more evidence raises the review priority, not the state |

`threshold_crossed` is never requested from `high`, and the reason is that the
edge is available and unguarded: the shared table declares
`threshold_crossed` from `high` to `critical` with no guard at all, so taking it
would skip the corroboration requirement entirely. The policy layer therefore
treats `signal_observed` as the only escalation out of `high`, and a caller that
"simplified" it to `threshold_crossed` would reach `critical` on no evidence at
all.

That is only true because the guarded `threshold_crossed → high` row is declared
from `normal` and `elevated` only. An earlier version of the table also listed
`high` there, which made the two rows overlap on `(event, from)`: the resolver
takes the **first** matching row, so the guarded row shadowed the unguarded one
and `high + threshold_crossed` returned `high` — a self-transition that is
indistinguishable at the call site from a guard refusing the move, so the
corroboration check a caller believes it is relying on is not what fired.
`defineStateMachine` does not report a shadowed row, so the invariant is pinned
in `packages/core/test/states.test.ts` instead: `high + threshold_crossed` must
reach `critical` with no context at all, and no state of any machine in the
kernel may offer the same event twice — the only externally visible symptom of
a shadowed row. Keep `high` out of the guarded row and keep the unguarded row
first; if either changes, the escalation silently stops escalating.

### Worked numbers — one account, one loud detector

**A `corroboration_only` detector, `identity.reuse` (0.45, medium), the same
verification attempt, forty times in a day.** This is the shape of all five
implemented detectors, and the number that used to be an accident is now a rule:

| Signal | Repetitions | Effective score | From | To | Reason |
|--------|-------------|-----------------|------|-----|--------|
| 1 | 0 | 0.383 | `normal` | `normal` | `corroboration_required` |
| 5 | 4 | 0.459 | `normal` | `normal` | `corroboration_required` |
| 6 | 5 | 0.478 (multiplier capped) | `normal` | `normal` | `corroboration_required` |
| 40 | 39 | 0.478 | `normal` | `normal` | `corroboration_required` |

Nothing happens, and the arithmetic explains only the first two rows: even
capped, 0.478 is under the 0.5 that `normal` needs. The declaration is what
holds the rest. A detector held here is not silenced — the score is reported,
the signal is in the ledger, the detector is a contributing detector — it is
waiting for a second source, and the decision says that rather than claiming
the evidence was too weak.

**A `self_escalating` detector at 0.6, high, the same behaviour, six times in a
day.** The arithmetic is the policy layer's and stays true whatever produces the
signal; no detector in the catalogue declares this status today, which is the
honest reason this example is a worked number and not a trace from the pipeline:

| Signal | Repetitions | Effective score | From | To |
|--------|-------------|-----------------|------|-----|
| 1 | 0 | 0.60 | `normal` | `elevated` |
| 2 | 1 | 0.63 | `elevated` | `elevated` |
| 3 | 2 | 0.66 | `elevated` | `elevated` |
| 4 | 3 | 0.69 | `elevated` | `elevated` |
| 5 | 4 | 0.72 | `elevated` | `high` — friction: rate limit + review candidate |
| 6 | 5 | 0.75 (capped by the 1.25 multiplier) | `high` | `high` |

Six repeats reach `high` and stop. Not `critical`, however long the campaign
runs, because one detector is not two — and the single-detector ceiling caps
the score at 0.85 whatever the repeats do. Friction stops growing at `high` too.

**The same account, plus one independent detector** — in the implemented
catalogue, `identity.reuse` (0.45, medium) alongside `dating.profile_churn`
(0.3, low) — arriving while the subject is at `high`: two independent detectors,
so the machine's corroboration branch is satisfied and the state moves to
`critical`. That is the moment friction widens to a re-verification request and
a human is asked to look. The difference between the two rows is not the
account's behaviour — it is whether a second source saw it. This is the path
`test/pipeline.test.ts` drives end to end, from a published event to the
transition.

**The same two detectors, from `normal`, on the first pass:** `identity.reuse`
at 0.383 plus the 1.15 corroboration multiplier is 0.440, still under 0.5, so
the subject stays at `normal` with both signals in the ledger. Four earlier
repeats of the identity behaviour take it to 0.528 and the pair escalates to
`elevated`. Corroboration is necessary and not sufficient, and the distance
between "two detectors agree" and "the subject moves" is a real, small number —
which is the honest cost of this policy, not a rounding error: the
detection-before-report rate will read lower than a per-detector-threshold design
would report, deliberately, and the `risk-state distribution shift` and appeal
rate alerts in `product-quality-and-measurement.md` are the guard on the
decision.

### Decay

Decay is a question about the clock. The thresholds belong to the shared
machine and are not restated here: `elevated → normal` after 7 quiet days,
`high → elevated` after 14, `critical → high` after 30, **one step at most, ever**
— a subject at `critical` after a year of silence is at `high`, and only another
decay cycle takes them lower.

Decay releases what the raised state justified. As the state falls, the friction
that state justified is withdrawn and the review queue entry closes, so a user
who misbehaved once is not still paying for it a month later.

## 7. Reversible friction catalogue

The complete list of what automation may ever propose. It lives in one record,
`REVERSIBLE_FRICTION`, and `ReversibleFriction.reversible` is typed as the
literal `true` — an irreversible proposal does not typecheck in this package.

| Kind | From | TTL | Effect | User notice | Rationale |
|------|------|-----|--------|-------------|-----------|
| `rate_limit` | `elevated` | 24 h | Caps `like` and `send_message` throughput | `generic_rate_limit` | Stops a flood while a human looks; nobody loses the ability to talk or to leave |
| `human_review_candidate` | `high` | 72 h | Queues the subject for a moderator | none | The primary metric of issue #1. The moderator sees behaviour metadata, never a verdict |
| `reverification_request` | `critical` | 168 h | *Asks* Identity to re-verify; Identity decides | `generic_reverification` | The only friction with a real cost to a legitimate user, so it is reserved for the state that requires two independent detectors |

Notes that matter operationally:

- A rate limit at `elevated` is deliberately cheap and generous. It is the
  earliest, cheapest possible intervention, which is what the metric asks for.
- `reverification_request` is a **request to another domain**, not an action. The
  identity machine moves `verified → pending` on its own authority, and `pending`
  is not discoverable — which is why this friction is gated at `critical` and why
  the mass-reporting defence in §8 exists.
- Nothing here removes a capability the way `limited` does. Only an account
  state does that, and only a moderator with a case can set one.

## 8. Combined behaviour

### Repeats versus independence

| | Same detector, same behaviour | Different detectors, same subject |
|---|---|---|
| What it means | The pattern is getting worse, or the detector is being spammed | Two sources saw something, neither knowing about the other |
| Contribution | `+0.05` per repeat, capped at `1.25×` | `×1.15` **and** unlocks the fast path, the `critical` branch, and the right of a `corroboration_only` signal to move a subject at all |
| Can it reach `critical`? | Never — one source is capped at 0.85 | Yes, from `high` |
| Can it leave `normal` on its own? | Only if the detector declared `self_escalating` | Yes, once the pair is worth 0.5 |
| Gaming cost | Free to produce, worth almost nothing | Requires genuinely independent observation |

This is the asymmetry the whole design rests on: **a detector can be spammed
without buying anything that matters.** `corroborate` counts distinct detector
names and repeats separately and never adds one to the other, and the policy's
unaided test reads only the count of names — so the two axes cannot be traded
against each other by a detector that has found its own level. Thirty signals
from one detector is one detector, and `test/correlation.test.ts` says so
against a ledger built out of exactly that.

### The mass-reporting attack

Retaliation is the attack this engine is most exposed to. An attacker with
three accounts files three reports against a competitor, and a naive engine
escalates the victim to `critical`, rate-limits them, and puts them in front of
a moderator for something they did not do.

The rule is blunt: **a report is an accusation, not evidence.** A
`report_against` signal never moves the target's risk state — not by one
report, not by twenty. Its entire output is campaign detection:

- `createSignal` enforces that only `report_against` may be attributed to
  somebody other than its subject, so the confusion cannot be expressed;
- the policy discards the signal entirely: no state, no contributing detector,
  no reset of the decay clock, no friction;
- the ledger keeps it, because a *pattern* of them is real evidence — about the
  reporters;
- at `MASS_REPORT_CLUSTER_SIZE` (3) distinct reporters inside 168 hours, the
  campaign becomes one **cluster** review candidate naming the reporters. One
  human call covers every member, and reviewing members individually would
  review the victim first.

The cost of this rule, stated plainly: when three users gang up on a genuinely
dangerous account, that account's risk does not rise because of the reports. It
rises because of what its own detectors observe, and the reporters' cluster
reaches a human. A system that punishes the victim is a system that can be
weaponised, so the cluster is the compromise — and it is a compromise, not a
victory.

### One unmatch by many accounts

Popularity looks structurally like attack: dozens of `unmatch.performed`
observations about one subject, in a short window, from unrelated accounts. The
engine answers it with weight rather than with a special case.
`interaction.unmatch_by_counterparty` carries weight 0.5 at `low` reliability,
so a base of `0.5 × 0.7 = 0.35`, and its repeat counter only accumulates within
a single match — a hundred different people unmatching you is a hundred
*different* behaviours, not one behaviour repeated. Even if every one of them
had been the same match, the maximum repeat multiplier of 1.25 reaches 0.4375.
**Being unmatched by the entire platform cannot, on this evidence alone, move a
user off `normal`.** "Many people unmatched me" is a fact about the platform's
taste, not about me.

That was once an accident of arithmetic, and the detector also declares
`corroboration_only`, so it is now a rule that holds at 0.9 as well: the pattern
that most clearly indicates somebody being targeted contributes to a case and
cannot start one. A subject needs a second, independent signal — and then the
pair is often not worth 0.5 either, which §6's arithmetic shows with a real
catalogue pair.

## 9. Review queue ranking

One pure function, `rankReviewCandidates`, is the only place queue order is
decided.

```
priority = 0.50 × stateWeight          normal 0 · elevated 0.3 · high 0.7 · critical 1
         + 0.25 × recency              1.0 at the moment of raise, 0 at 30 days
         + 0.15 × corroboration        min(detectors / 2, 1)
         + 0.10 × confidence           effective score at raise time
         + 0.10 if the target is a cluster        (one decision protects many)
         − 0.35 if the origin is a dispute         (their friction is already lifted)
```

and the result is clamped to `[0, 1]`. Expired candidates are dropped, not
ranked. Ties break oldest-first, then by target, so two moderators on different
shifts see the same queue.

Why this order, given the metric:

- **Severity first.** A `critical` account is still messaging people.
- **Recency second, above corroboration.** This is the ranking's most
  opinionated choice and it follows directly from "detected before another user
  reports them". A detection raised three weeks ago has had three weeks of
  friction, three weeks of decay and, probably, a resolution. The human's
  marginal value is lowest on the oldest entries, and the freshest entries are
  the ones where a decision prevents the most harm.
- **Corroboration third.** Two detectors make a case cheaper to review, not more
  urgent.
- **Cluster bonus.** One decision covering three accounts beats three decisions.
- **Dispute discount.** A disputed subject has already had their friction
  withdrawn — the system has failed open for them — so their case must not
  outrank an account we may still be actively harming.

Every subject at `high` or above has an open candidate, so "who is in the queue"
is a property of the risk record rather than a separate bookkeeping decision.

## 10. False positives and the user's view

A risk state is a judgement about a person made by a machine. A user who could
see it would be told a verdict no human made and no evidence can support, and
the product would be making a claim it cannot defend. So:

- **Risk is never user-visible.** `userNoticeFor` takes the *friction list*, not
  the risk state. There is no code path from a risk state to a user-facing
  string, and the whole notice vocabulary is three entries
  (`none`, `generic_rate_limit`, `generic_reverification`) with no synonym of
  "risk" in it. A `critical` subject with no active proposal is told nothing.
- **A user disputes; the system fails open.** On a dispute: every reversible
  proposal is withdrawn immediately, the case is queued for a human, and no new
  friction is proposed while the dispute is open. The user is not left sitting
  behind a rate limit waiting for a queue to be worked.
- **A dispute never lowers risk.** `handleDispute` returns `stateChange: 'none'`
  as a literal type. Only a named human (`manual_reassess`) or the clock (decay)
  lowers risk. If disputing cleared the risk, "dispute until clear" would be a
  cheaper attack than the one we are defending against.
- **Nobody waits behind a queue to be found innocent.** The dispute candidate is
  discounted in the ranking rather than jumping it, because the friction — the
  only thing that actually reaches the user — is already gone.

## 11. Events published

| Event | Sensitivity | Payload | Consumer |
|-------|-------------|---------|----------|
| `risk.changed` | `internal` | subject, assessment, from, to, reason, contributing detectors, effective score | Moderation, analytics, audit |
| `review_candidate.raised` | `internal` | target (account or cluster), state, origin, detectors, confidence, expiry | Moderation queue |
| `friction.proposed` | `internal` | subject, kind, reason, expiry, `reversible: true` | Identity (re-verification), Communication (rate limits) |

All three are `internal` by construction: `TrustSafetyEventSensitivity` is the
literal `'internal'`, so widening it is a compile error at every builder rather
than a payload change. A `public` clearance cannot consume any of them, and a
cluster candidate leaves the envelope's `subjectId` unset because there is no
single subject.

## 12. Threat model

| Threat | Response | Residual risk |
|--------|----------|---------------|
| **Gaming a detector** — behaving just under a threshold, or repeating one signal forever | Thresholds are on the *effective* score after discount, repeats and the single-detector ceiling; repetition is counted separately from independence and never trades against it; and a `corroboration_only` detector cannot move a subject at all, however loudly it repeats itself | A patient attacker who stays under every threshold is never caught by automation, and a corroborated pair that is worth 0.44 does not escalate either. Accepted: this is the price of never being wrong irreversibly, and it is a price paid in recall |
| **Retaliatory mass reporting** | §8: reports are accusations, never evidence; the victim is untouched and the campaign is queued as a cluster | A genuinely dangerous account reported by three users gains no risk from it. Its own detectors still apply |
| **Weaponising friction** — a false positive that re-verifies an honest user | `reverification_request` is gated at `critical`, requires two independent detectors, and is a request Identity may refuse | A determined attacker can still cost an honest user visibility for a week. The alternative — re-verifying nobody — is worse |
| **Detergent drift** — a detector slowly starts firing on normal behaviour | Repeats are cheap and capped, so a drifting detector accumulates slowly rather than sharply; the review queue shows the detector names, so drift is visible as a queue full of one detector; and a `corroboration_only` detector cannot escalate on its own however far it drifts, so drift shows up as corroboration rather than as friction | Drift is only visible once humans look, and a detector that drifts *together with* a second one is not slowed by any of this. The queue is the detector |
| **Queue flooding** — an attacker raising candidates faster than humans work | Candidates expire (72 h) and ranking favours fresh, severe, corroborated cases; a dispute is discounted so it cannot be used to flood | A determined flood degrades the queue for everyone. Rate of arrival per subject is an open question (§13) |
| **Attacking the reviewers** — a subject who knows they are queued | They are told nothing about risk, and the only thing they can observe is friction they can dispute and reverse | A user can infer that *something* happened. That is unavoidable and acceptable: friction must be perceptible to be disputable |
| **Cross-domain leakage** | Events are `internal`; the read-model a client sees has no risk field; the engine has no import of another domain's internals; the reduction refuses anything above `internal` and copies only the fields a rule names | A producer that puts free text in a field the rules *do* name — an `entityId`, say — would cross verbatim. The rules name ids, counts and instants, and a test asserts that a mapped observation's serialised form contains no value from the source payload |

## 13. Open questions

Recorded rather than guessed, because guessing is worse than writing the gap.
- **How much of a report record may be read by a system that is not allowed to
  act on it.** *Partly answered in §3, partly not.* The answer given is: a
  non-reversible, non-identifying join token on its own `user`-clearance event,
  and no wider clearance — so `interaction.unmatch_report` now has a producer
  and `report.coordinated_target` still does not, because a token cannot express
  "somebody other than the subject reported this".
  What is **not** answered, and needs a person rather than a design: who is
  accountable when a detector's input is itself a report about an identifiable
  person. A join key removes the identity from the *data*; it does not name an
  owner for the decision to run that detector at all, and it does not say what
  a user is told when a signal derived from a report about them moves their
  risk state. The engineering answer — a token, no identity, no clearance
  change — is settled and implemented. The governance half is a decision this
  document cannot make for itself.
- **What the pairing token still permits.** Recorded rather than waved at, in
  §3: a token is stable per (report, match, subject), so a holder of many tokens
  and a small user population can still correlate, and the deployment secret can
  test candidate match ids. Whether the correlation residual is acceptable at a
  given user base needs a real number, not an argument.
- **Whether risk may ever leave `normal` on today's evidence.** The arithmetic
  in §6 is unforgiving and, with the implemented catalogue, one-way: every
  detector is below the 0.5 gate even at the maximum repeat multiplier, and
  every one of them declares `corroboration_only`, so a record moves only where
  it is already raised, or where two independent detectors corroborate. **That is
  now a decision rather than an accident** — see
  [`detector-escalation-policy.md`](detector-escalation-policy.md) — but the
  consequence is still open: a two-key system that almost never opens is close to
  a useless engine, and what would tell us so is the
  `risk-state distribution shift` alert, not a test. Either a high-reliability
  behaviour observation becomes producible at `internal` and can be declared
  `self_escalating`, or this stays a corroboration layer over another domain's
  decisions. Labelled data, not more arithmetic, is what would settle it.

- **Automated decision-making law, per market.** Several regimes require a
  person to be able to contest an automated judgement, and some require
  disclosure that one was made at all. The design here assumes a *reversible*
  proposal plus a human review is enough. Whether that satisfies the EU AI Act's
  transparency obligations, or equivalents in Brazil, California or elsewhere, is
  a legal question this document cannot answer. It may force a user-facing
  statement that "we are checking something", which is still not the same as
  telling a user they are risky.
- **Detector calibration without labelled data.** There is no ground truth for
  "this account is malicious", and the first labels will come from moderators
  reviewing the queue — which means the initial weights are guesses defended by
  the reliability discount rather than measured precision. Whether to backfill
  weights from reviewer outcomes, and how to avoid training a detector to please
  its own reviewers, is unresolved.
- **Signal retention.** The ledger holds 256 entries and corroboration looks
  back 168 hours, but how long raw signals may be kept — and whether they
  constitute profiling under GDPR — needs a legal answer per market, not a
  technical one. The friction TTLs (24 h / 72 h / 168 h) are also unvalidated
  guesses about how long a review queue actually takes.
- **Queue arrival rate per subject.** Nothing currently caps how many candidates
  one account can have open, which matters both for queue flooding and for the
  experience of a user who trips several detectors at once.
- **Whether a cluster candidate should ever resolve into per-account cases.**
  Today one decision covers the whole cluster. If a moderator can only clear
  some members, the cluster model has to be split, and the ranking has to learn
  about partial coverage.
