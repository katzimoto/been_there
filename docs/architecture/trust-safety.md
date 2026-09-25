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
| The `Signal` value object: detector, subject, actor, time, bounded weight, corroboration key, derived facts | Any account state. `AccountState` is moderation's; this package cannot write it even by accident |
| The detector port: what a detector may observe, and the vetting of what it emits | Detector implementations' internal logic, and the storage they read |
| The signal ledger: bounded retention, corroboration counting, repeat counting | Signal storage technology, retention *policy* (see open questions) |
| The risk assessment: `Signal` + current state → next state, via the shared `riskMachine` | The risk *state machine* itself — that is `packages/core/src/states/risk.ts` |
| Escalation scoring: reliability discount, repeat multiplier, single-detector ceiling | Account capabilities, enforcement, appeals |
| The reversible friction catalogue — the complete list of what automation may ever propose | Applying friction: every kind is a proposal consumed by the owning domain |
| Review-candidate selection and queue ranking | The review queue itself, case creation, or moderator decisions |
| The false-positive policy: dispute intake, fail-open on friction, notice suppression | The wording of user-facing copy, and any statement about a user's risk |
| Publishing `risk.changed`, `review_candidate.raised`, `friction.proposed` (all `internal`) | User-facing copy, profile content, discovery eligibility, identity evidence |

## 3. Detection → policy → enforcement

Three layers, three directories, three failure modes. The split is structural:
the enforcement layer **is not in this package**, and no type in this package can
name an account state, a case, or a moderator.

```
 Identity & Dating & Communication events
 (identity.status_changed, unmatch_initiated, message_reported, …)
        │
        │  reduced on arrival to metadata only:
        │  { kind, actorId, subjectId, counterpartyId?, entityId?, count? }
        ▼
 ┌──────────────────────────── DETECTION ─────────────────────────────┐
 │  signal.ts     Signal value object — bounded weight, no content     │
 │  detector.ts   Detector { name, reliability, category, detect() }   │
 │                runDetector() builds the context and vets the output │
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

Three further checks sit on the seam rather than in a convention, and each of
them is a test:

- `runDetector` may only implicate an account that appears in the detector's own
  input, so a detector bug cannot aim risk at an arbitrary user;
- `applySignal` refuses a signal whose subject is not the record's subject, so a
  wiring bug cannot write one account's evidence onto another's risk state;
- `createSignal` enforces the attribution rule in §4, so "who did this" cannot
  drift between the ledger and the policy.

**The one thing automation may do to a user** is listed in §7, and every entry
expires. That is the entire authority surface.

## 4. Signal model

A `Signal` is a claim about a behaviour, made by one named detector, at one
time, with a bounded weight.

| Field | Why it exists |
|-------|----------------|
| `detector` | Every piece of evidence names its author. Nothing is anonymous. |
| `reliability` | `low`/`medium`/`high`, declared by the port and discounted in policy, never self-assessed by a draft |
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

| Detector | Inputs (`ObservationKind`) | Behaviour key | Base weight | Reliability | Known false positives |
|----------|---------------------------|---------------|-------------|-------------|-----------------------|
| `interaction.unmatch_report` | `unmatch_initiated` + `message_reported` on the same entity | `unmatch_then_report:<matchId>` | 0.6 | high | A user unmatching and then reporting a genuine scammer; one action producing both events; a match ending during a report flow |
| `report.coordinated_target` | `message_reported` where actor ≠ subject | `report_against:<subjectId>` | 0.9 | high | **Never risk-bearing** (§8). Its only output is campaign detection, so the cost of its false positives is paid by reviewers, not by users |
| `velocity.message_burst` | Batched `message_sent` counts | `message_velocity:<conversationId>` | 0.4 | medium | New matches, replies after a long gap, emoji-heavy chat, a user with a very talkative partner |
| `velocity.like_burst` | Batched `like_sent` counts | `like_velocity:<subjectId>` | 0.35 | low | Power users, a user returning after a break, anyone on a bad phone |
| `interaction.unmatch_by_counterparty` | `unmatch_initiated` where the subject is the counterparty | `unmatch_by_counterparty:<matchId>` | 0.5 | low | Popularity. Deliberately low: "many people unmatched me" is the *opposite* of evidence about me |
| `identity.reuse` | `verification_attempted` + `identity_status_changed` | `identity_reuse:<verificationId>` | 0.45 | medium | Re-verification after a long absence, shared family devices, provider misreads, an appeals flow that re-submits |
| `network.device_cluster` | `*` batched into a coarse `cluster` label | `device_cluster:<clusterId>` | 0.5 | medium | Shared wifi, carrier NAT, a household, an office, a single popular handset model |
| `dating.profile_churn` | Batched `profile_edited` | `profile_churn:<subjectId>` | 0.3 | low | Someone still filling in their profile; an experiment; an accessibility tool rewriting a bio |
| `communication.external_links` | `message_sent` metadata carrying a link count, never a URL | `external_link_sharing:<conversationId>` | 0.4 | low | Ordinary link sharing, which in a dating product is often an Instagram handle |

Two catalogue rules, and they are the reason the table looks the way it does:

- **No detector reads identity evidence.** It reads `identity_status_changed`
  and `verification_attempted` — that a thing happened, not what the selfie was.
  A likeness score is `sensitive` and belongs to Identity.
- **Every low-reliability detector is a volume detector.** They fire often, so
  the discount is what stops "frequently observed" from being confused with
  "strongly observed".

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
have spoken about this subject within 168 hours.

### The single-detector ceiling

The shared machine escalates `high → critical` on `score ≥ 0.9` **or**
`corroboratingDetectors ≥ 2`. Taken alone, the first branch lets one loud
detector reach `critical` alone. The policy layer closes that by capping a
single detector's effective score at **0.85** — a ceiling, not a reimplementation.
The machine still owns every transition; the policy only bounds what one source
is allowed to claim. Corroboration is therefore genuinely required for the
highest escalation, and the test says so directly.

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

`interaction.unmatch_report` at weight 0.6, high reliability, the same match,
six times in a day:

| Signal | Repetitions | Effective score | From | To |
|--------|-------------|-----------------|------|-----|
| 1 | 0 | 0.60 | `normal` | `elevated` |
| 2 | 1 | 0.63 | `elevated` | `elevated` |
| 3 | 2 | 0.66 | `elevated` | `elevated` |
| 4 | 3 | 0.69 | `elevated` | `elevated` |
| 5 | 4 | 0.72 | `elevated` | `high` — friction: rate limit + review candidate |
| 6 | 5 | 0.75 (capped by the 1.25 multiplier) | `high` | `high` |

Six repeats reach `high` and stop. Not `critical`, however long the campaign
runs, because one detector is not two. Friction stops growing at `high` too.

**The same account, plus one independent detector** (`network.device_cluster`,
0.5, medium) arriving while the subject is at `high`: two independent detectors,
so the machine's corroboration branch is satisfied and the state moves to
`critical`. That is the moment friction widens to a re-verification request and
a human is asked to look. The difference between the two rows is not the
account's behaviour — it is whether a second source saw it.

Corroboration is necessary but not sufficient: from `normal`, two independent
detectors at an effective 0.49 stay at `normal`, because the fast path needs
0.7. Independence buys a second look, not an automatic escalation.

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
| Contribution | `+0.05` per repeat, capped at `1.25×` | `×1.15` **and** unlocks the fast path and the `critical` branch |
| Can it reach `critical`? | Never — one source is capped at 0.85 | Yes, from `high` |
| Gaming cost | Free to produce, worth almost nothing | Requires genuinely independent observation |

This is the asymmetry the whole design rests on: **a detector can be spammed
without buying anything that matters.**

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

Popularity looks structurally like attack: dozens of `unmatch_initiated`
observations about one subject, in a short window, from unrelated accounts. The
engine answers it with weight rather than with a special case.
`interaction.unmatch_by_counterparty` carries weight 0.5 at `low` reliability,
so a base of `0.5 × 0.7 = 0.35`, and its repeat counter only accumulates within
a single match — a hundred different people unmatching you is a hundred
*different* behaviours, not one behaviour repeated. Even if every one of them
had been the same match, the maximum repeat multiplier of 1.25 reaches 0.4375,
still under the 0.5 needed to leave `normal`. **Being unmatched by the entire
platform cannot, on this evidence alone, move a user off `normal`.** "Many
people unmatched me" is a fact about the platform's taste, not about me.

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
| **Gaming a detector** — behaving just under a threshold | Thresholds are on the *effective* score after discount, repeats and the single-detector ceiling; one detector cannot reach `critical` | A patient attacker who stays under every threshold is never caught by automation. Accepted: this is the price of never being wrong irreversibly |
| **Retaliatory mass reporting** | §8: reports are accusations, never evidence; the victim is untouched and the campaign is queued as a cluster | A genuinely dangerous account reported by three users gains no risk from it. Its own detectors still apply |
| **Weaponising friction** — a false positive that re-verifies an honest user | `reverification_request` is gated at `critical`, requires two independent detectors, and is a request Identity may refuse | A determined attacker can still cost an honest user visibility for a week. The alternative — re-verifying nobody — is worse |
| **Detergent drift** — a detector slowly starts firing on normal behaviour | Repeats are cheap and capped, so a drifting detector accumulates slowly rather than sharply; the review queue shows the detector names, so drift is visible as a queue full of one detector | Drift is only visible once humans look. The queue is the detector |
| **Queue flooding** — an attacker raising candidates faster than humans work | Candidates expire (72 h) and ranking favours fresh, severe, corroborated cases; a dispute is discounted so it cannot be used to flood | A determined flood degrades the queue for everyone. Rate of arrival per subject is an open question (§13) |
| **Attacking the reviewers** — a subject who knows they are queued | They are told nothing about risk, and the only thing they can observe is friction they can dispute and reverse | A user can infer that *something* happened. That is unavoidable and acceptable: friction must be perceptible to be disputable |
| **Cross-domain leakage** | Events are `internal`; the read-model a client sees has no risk field; the engine has no import of another domain's internals | None known |

## 13. Open questions

Recorded rather than guessed, because guessing is worse than writing the gap.

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
