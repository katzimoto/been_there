# Detector escalation policy

> Resolves [#44](https://github.com/katzimoto/been_there/issues/44). Decides which
> detectors may escalate a subject on their own, and which require corroboration.
> Implemented in `packages/trust-safety/src/escalation.ts` (the declaration and
> the gate), `signal.ts` (the constructor's refusal) and `policy.ts` (the decision).

## The problem, with the arithmetic

A signal must score **≥ 0.5** to move a subject off `normal`. The score is
`weight × reliability discount × repeat multiplier`, capped at 1.25 repeats and
0.85 for a single detector. Measured against the five implemented detectors,
with the weights and reliabilities they actually declare:

| Detector | weight | reliability | discount | base | at the repeat cap (×1.25) | clears 0.5? |
|---|---|---|---|---|---|---|
| `velocity.like_burst` | 0.35 | low | 0.70 | 0.245 | 0.306 | **never** |
| `velocity.message_burst` | 0.40 | medium | 0.85 | 0.340 | 0.425 | **never** |
| `dating.profile_churn` | 0.30 | low | 0.70 | 0.210 | 0.263 | **never** |
| `interaction.unmatch_by_counterparty` | 0.50 | low | 0.70 | 0.350 | 0.438 | **never** |
| `identity.reuse` | 0.45 | medium | 0.85 | 0.383 | 0.478 | **never** |

**Not one of the five can escalate a subject, no matter how many times it fires.**
The strongest of them, `identity.reuse`, is 0.022 short of the gate with the
multiplier already capped. A subject reaches `elevated` only via two independent
detectors, or by a human. The engine is not unsafe — it is close to inert, and
it is inert *by accident*: each weight, each discount and the 0.5 gate are
individually sensible, and nobody multiplied them out.

That is the same failure shape as the pass-suppression window that two
specifications described and no code implemented: a product decision made by
omission.

**The first version of this table was wrong per detector.** It carried the right
*set* of five scores and attached them to the wrong rows — it read
`message_burst` at 0.478 and `identity.reuse` at 0.425, against 0.425 and 0.478
in the code, because it was written against an earlier weight set and never
re-multiplied. The conclusion was unaffected, since all five fall short either
way, but a table that cannot be reproduced from the code it describes is not
evidence. Every number above is now measured from the built package.

## Why not simply raise the weights

Because that is the wrong instrument, and it fails in the direction this product
cannot afford.

A low weight does not mean "this signal is weak". It means **"this signal is
common"** — most people who like fifty profiles in an hour are not bots, and
most people who send many messages are having a conversation. Raising those
weights to clear 0.5 would make the engine fire on ordinary behaviour, and the
consequence of a false positive here is not a wasted queue slot. It is a real
user made `elevated`, then given friction, and then — once the queue fills with
noise — ignored when a genuine one arrives.

The asymmetry is the whole argument. **A missed signal costs one user's safety.
A false positive costs that user's trust, and trust is the asset the
verification model is built on.** So the question is never "how do I make this
detector fire", it is "what is the weakest evidence I will act on alone".

## The decision

**Escalation is a two-key system, and no single behavioural detector holds a
key.**

1. **A detector declares its status.** `SignalAuthor.escalation` is
   `corroboration_only` or `self_escalating`, it is required rather than
   defaulted, and the policy reads the declaration on the signal. There is no
   list of names anywhere in the policy layer, so adding a detector to the
   catalogue cannot silently put it in the set that escalates on its own — a
   detector that does not choose does not compile.
2. **A `corroboration_only` detector cannot escalate a subject alone, at any
   repetition count.** This is the property that was false and untested. It is
   enforced as a refusal to ask the shared machine anything, not as a discount
   on the score: a moderator is shown the weight of the evidence that was found,
   so clamping a 0.478 to 0.4999 to express a refusal would put a fiction in
   front of a human. The decision says `corroboration_required` instead, and the
   signal is still kept — it enters the ledger, it counts as a contributing
   detector, and it is what a second detector will be corroborated against.
3. **A `self_escalating` detector must be able to clear 0.5 unaided.** If one is
   declared that cannot, it is a mis-declaration and `createSignal` refuses it,
   with the shortfall and the gate in the error details. The alternative — a
   detector holding the strong status and quietly never firing — is
   indistinguishable from a detector that is simply broken. A test asserts no
   such declaration exists, and the check is per signal, so the declaration and
   the arithmetic cannot drift apart.
4. **Repetition is a distinct axis from corroboration.** Six repeats of one
   detector is one detector. `corroborate` counts distinct names and
   `repetitions` separately, and the policy's unaided test reads only the
   former, so a single miscalibrated detector cannot manufacture its own
   corroboration — which is the failure mode every detector-gaming threat is a
   version of.

**What rule 3 does not check.** It asks whether the arithmetic works, not whether
the evidence is the kind that justifies acting alone — and the two are not the
same question. `interaction.unmatch_report` at 0.6 and `high` reliability
clears 0.5 unaided, so it *passes* rule 3 today, while being a behavioural
pattern about a match and exactly the kind of signal rule 1 says must not
conclude on its own. A reviewer who promoted the loudest behavioural detector
would find every check passing. Nothing mechanical here can settle it, because
"is this a fact about a person or a pattern in their behaviour" is a judgement
about the evidence, and the only honest guard is that promoting a detector is a
reviewed change to this document rather than a one-word edit in a detector
literal. It is stated here because a policy that reads as airtight and is not
is worse than one that names its own gap.

The per-signal form of the check is also stricter than "a detector must be able
to clear 0.5": it requires *every* signal to clear it, so a detector with
variable weights has its weak signals refused — and a refused signal never
enters the ledger, so it cannot corroborate anything later. That is the
deliberate direction of error: a mis-declared detector loses its weak evidence
rather than being trusted with it.

The result: `interaction.unmatch_by_counterparty` — the pattern that most
clearly indicates someone being targeted — contributes to a case but cannot by
itself start one, and **two** independent behavioural signals about the same
person can. That is the correct shape for behavioural evidence, and it is the
shape issue #1's primary safety metric actually needs.

## What exists today

**All five implemented detectors are `corroboration_only`, and none is
`self_escalating`** — because none can clear 0.5 unaided, so none is eligible
for the strong status. `self_escalating` is not a dormant branch: it is the
status a future provider-attributed identity anomaly would declare, and the
declaration it makes today is checked rather than trusted.

The two-key system is not inert, and the way it escalates is worth writing down,
because it is tighter than "two detectors and off it goes":

| Case | Effective score | Result |
|---|---|---|
| `interaction.unmatch_by_counterparty`, 40 repeats, no second detector | 0.438 | `normal`, `corroboration_required` |
| `identity.reuse` alone, 0 repeats | 0.383 | `normal`, `corroboration_required` |
| `identity.reuse` + any second detector, 0 repeats | 0.440 | `normal` — corroboration is necessary, not sufficient |
| `identity.reuse` (4 repeats) + `dating.profile_churn` | 0.528 | `elevated` |
| any corroborated pair, from `high` | — | `critical`, by the machine's own corroboration branch |

So a subject can sit at `normal` with two corroboration-only signals against it
in the ledger, because the pair has to be worth 0.5 and the pair most often is
not. That is the engine being quiet in the intended direction, and it is also a
real number: a two-key system that rarely opens is a system whose recall has to
be measured, not assumed.

## What this costs, stated plainly

**The detection-before-report rate will be lower than a per-detector-threshold
design would report**, because corroboration is required and because no lone
detector can act. That is a real cost and it is being accepted deliberately:
the alternative is a metric inflated by false positives, and a metric that can
be inflated by false positives is not a safety metric. Anyone reading a diff of
this change should not have to infer it — after it, **no single behavioural
detector in this system can move an account off `normal`**, for the whole life
of a campaign, however loudly it repeats itself.

The guards on that decision are the `Risk-state distribution shift` and
`Appeal rate spike` alerts in `product-quality-and-measurement.md` §2. If
escalation volume falls to near zero in production, the first alert fires and
the policy is revisited with real data rather than with this reasoning. If the
appeal rate stays flat while volume holds, that is the evidence that would
justify promoting a detector to `self_escalating`.

## What would change this decision

- **Labelled data.** Every weight in the table is a guess about how common
  ordinary behaviour is. With even a few hundred confirmed cases and matched
  controls, the weights become measurements. Until then, corroboration is the
  defensible default.
- **A measured appeal rate** that shows false positives are not actually
  occurring, sustained over enough volume to be a rate and not a rumour. That is
  the evidence that would justify promoting a detector to `self_escalating`, and
  promoting one is a declaration change, not a weight change.

## Implemented, and where the proof is

- Each detector declares its status; `policy.ts` reads the declaration and
  `test/detectors.test.ts` proves it by flipping one signal's declaration and
  watching the state change — the policy cannot be reading a name.
- `test/escalation.test.ts` drives a `corroboration_only` signal at every
  weight, reliability and repetition count, and from every state, and requires
  `normal` and `corroboration_required` each time.
- `test/escalation.test.ts` refuses a `self_escalating` declaration whose own
  evidence cannot clear the gate, both at `createSignal` and through the
  detector port, and requires the error to name the declaration.
- `test/escalation.test.ts` shows repetition never becoming corroboration: 30
  signals from one detector is `independentDetectors: 1`.
- `test/escalation.test.ts` and `test/pipeline.test.ts` show two independent
  detectors reaching `elevated` and `critical`, so the engine is not inert.
- `trust-safety.md` §5 marks every detector, and §6's worked numbers are
  recomputed against this policy.
