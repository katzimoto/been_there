# Detector escalation policy

> Resolves [#44](https://github.com/katzimoto/been_there/issues/44). Decides which
> detectors may escalate a subject on their own, and which require corroboration.

## The problem, with the arithmetic

A signal must score **≥ 0.5** to move a subject off `normal`. The score is
`weight × reliability discount × repeat multiplier`, capped at 1.25 repeats and
0.85 for a single detector. Measured against the five implemented detectors:

| Detector | weight | reliability | discount | score at repeat cap | clears 0.5? |
|---|---|---|---|---|---|
| `velocity.like_burst` | 0.35 | low | 0.70 | 0.306 | **never** |
| `velocity.message_burst` | 0.45 | medium | 0.85 | 0.478 | **never** |
| `dating.profile_churn` | 0.50 | low | 0.70 | 0.438 | **never** |
| `interaction.unmatch_by_counterparty` | 0.30 | low | 0.70 | 0.263 | **never** |
| `identity.reuse` | 0.40 | medium | 0.85 | 0.425 | **never** |

**Not one of the five can escalate a subject, no matter how many times it fires.**
A subject reaches `elevated` only via two independent detectors, or by a
human. The engine is not unsafe — it is close to inert, and it is inert *by
accident*: each weight, each discount and the 0.5 gate are individually
sensible, and nobody multiplied them out.

That is the same failure shape as the pass-suppression window that two
specifications described and no code implemented: a product decision made by
omission.

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

**Escalation is a two-key system, and no single behavioural detector holds a key.**

1. **Behavioural detectors are corroboration-only.** None of the five can move a
   subject off `normal` by itself, at any repetition count. They contribute
   evidence; they do not conclude.
2. **The gate is per-detector, not global.** A detector declares whether it is
   `corroboration_only` or `self_escalating`, and the policy reads the
   declaration rather than hard-coding a list. Adding a detector cannot silently
   join the escalating set.
3. **A `self_escalating` detector must be able to clear 0.5 on its own** or it
   is mis-declared, and a test says so. A detector is only allowed the stronger
   status if the evidence justifies it on its own — for example an identity
   anomaly the provider attributes with high confidence, which is not a
   statistical pattern but a fact about a person.
4. **Repetition is a distinct axis from corroboration.** Six repeats of one
   detector raising the score is *not* two independent detectors and must not be
   treated as one. Otherwise a single miscalibrated detector can manufacture
   its own corroboration, which is the failure mode every detector-gaming threat
   is a version of.

The result: `interaction.unmatch_by_counterparty` — the pattern that most
clearly indicates someone being targeted — contributes to a case but cannot by
itself start one, and **two** independent behavioural signals about the same
person can. That is the correct shape for behavioural evidence, and it is the
shape issue #1's primary safety metric actually needs.

## What this costs, stated plainly

**The detection-before-report rate will be lower than a per-detector-threshold
design would report**, because corroboration is required. That is a real cost
and it is being accepted deliberately: the alternative is a metric inflated by
false positives, and a metric that can be inflated by false positives is not a
safety metric. The `risk-state distribution shift` alert in
`product-quality-and-measurement.md` is the guard on this decision — if
escalation volume falls to near zero in production, that alert fires and the
policy is revisited with real data rather than with this reasoning.

## What would change this decision

- **Labelled data.** Every weight in the table is a guess about how common
  ordinary behaviour is. With even a few hundred confirmed cases and matched
  controls, the weights become measurements. Until then, corroboration is the
  defensible default.
- **A measured appeal rate** that shows false positives are not actually
  occurring. The spec already alerts on an appeal-rate spike; a sustained low
  rate is the evidence that would justify promoting a detector to
  `self_escalating`.

## Done when

- Each implemented detector declares its escalation status, and the policy reads
  the declaration.
- A test asserts every `corroboration_only` detector cannot escalate alone, at
  any repetition count — the property that is currently false and was never
  tested.
- A test asserts no `self_escalating` detector is declared that cannot clear the
  gate unaided, so the strong status cannot be handed out casually.
- `trust-safety.md` §5 states the policy and marks each detector, and the
  worked examples are recomputed against it.
