# Trust & Safety and Identity Verification — Reference Research

> Supporting research for [`docs/architecture/00-overview.md`](../architecture/00-overview.md).
> All URLs retrieved **2026-09-25** unless stated otherwise.
> Claims are tagged: **[P]** primary/regulator/legislation text retrieved directly;
> **[V]** vendor marketing or vendor-affiliated research, not independently verified;
> **[S]** secondary source (encyclopaedic, press, or review of other work);
> **[?]** evidence thin, contested, or not retrievable — read the caveat, do not cite the claim onward.

## Method note, stated up front

General web search was unavailable throughout: every configured provider (Google,
DuckDuckGo, Ecosia, Mojeek, Startpage) returns bot-detection or throttle errors
from datacenter egress IPs. This was verified twice, independently. Research was
therefore done three ways:

- **Scholarly search** via `scripts/research/search.mjs` (OpenAlex, arXiv, HN).
  Peer-reviewed and preprint work is the backbone of sections 3, 4 and 7.
- **Direct URL fetch / `curl`** against known primary URLs, which works for many
  hosts and fails for others. A browser User-Agent materially improves success.
- **Targeted guessing at canonical URLs** for legislation and standards.

What this got us, and what it did not:

- **Retrieved**: EUR-Lex, legislation.gov.uk, legislation.gov.au, ico.org.uk,
  pewresearch.org, bumble.com, socure.com, jumio.com, sardine.ai,
  documentation.onfido.com (now Entrust — a machine-readable `llms.txt` index
  exists and is worth using), the FBI IC3 2023 and 2025 annual reports,
  arXiv, OpenAlex, Crossref.
- **Still unreachable**: ofcom.org.uk, ftc.gov, esafety.gov.au,
  supremecourt.gov opinions, capitol.texas.gov bill PDFs, matchgroup.com,
  about.fb.com, withpersona.com, veriff.com, trustable.ca.

Two consequences the reader must respect:

1. **No vendor pricing anywhere in this document.** It is sales-gated and no
   public price sheet was found. The absence of a number is not a good number.
2. **No Ofcom interpretation.** OSA s.12 is the statute and we have it; Ofcom's
   guidance on what "highly effective" means is the operative document and we do
   not have it. We do not state a UK compliance position.

---

## TL;DR — the findings most likely to change our design

1. **Romance fraud is up sharply, and the 2025 numbers are worse than the
   familiar story.** FBI IC3 recorded 23,159 Confidence/Romance complaints and
   **$929.3M in losses in 2025**, against 17,910 / $672.0M in 2024 and 17,823 /
   $652.5M in 2023 **[P]**. Complaints grew ~29% and losses ~38% in one year, and
   $929.3M is the largest in the IC3 series. Most secondary write-ups still
   quote the older "~$650M" figure. **Any sizing we do should use 2025 numbers.**

2. **The money has moved from romance to investment — and dating apps are named
   as the intake channel.** IC3 defines Confidence/Romance narrowly ("heartstrings"
   fraud) while **Investment fraud hit $8.65B in 2025**, far the largest category,
   and the FBI states crypto investment scammers "typically initiate contact
   through text messages, social media sites, advertisements, or **dating
   applications** and then quickly move the conversation to a messaging
   platform" **[P]**. Our threat model must include investment-fraud staging, not
   just the long-con romance script.

3. **AI has measurably degraded scam quality control.** IC3 received 22,364
   AI-related complaints with $893.3M adjusted losses in 2025, and specifically
   reports Confidence/Romance scammers now use "fake profiles and scripts produced
   by AI chat generators to make speech more believable" **[P]**. Text- and
   profile-based scam detection is being attacked on exactly the axis it relied
   on. **Do not build a scam detector whose primary feature is linguistic
   naturalness.**

4. **The highest-risk conversations are the ones detectors classify worst.**
   Evaluations of grooming-risk classifiers find fine-tuned models fail precisely
   on indirect and coded language, with errors concentrated at the *highest*
   grooming risk levels **[P]**. This is the strongest external justification for
   commitment #2 and should be cited by ADR 0004.

5. **A human-in-the-loop deferral pipeline is a studied system — and we are
   already building one.** "Learning to Defer in Congested Systems" formalises
   exactly our architecture: an AI making *admission* decisions (route to human
   review) separately from *classification* decisions, under reviewer capacity
   constraints and selective-label feedback, reporting a "substantial" reduction
   in misclassifications over fixed-threshold practice **[P]**. The companion
   literature warns that humans *do* change behaviour when shown scores —
   including anchoring on incorrect ones **[P]** — which argues for presenting
   detectors as evidence, never as verdicts.

6. **Vendors retain biometric data for years by default, and may train models on
   it.** Entrust's published policy: applicant data may be retained **"up to 3
   years after the applicant's last interaction"**, with a separately configurable
   retention for fraud-related data that explicitly supports "training Entrust's
   fraud prevention models" **[V — vendor's own technical documentation]**. A
   3-year biometric retention default is incompatible with our erasure
   obligations unless contracted down in writing at signature.

7. **GDPR Art. 9 does not offer "legitimate interest".** Recital 47 names fraud
   prevention as a legitimate interest for Art. 6 **[P]**, but Art. 9(2) does not
   include it. Retaining biometric verification evidence for fraud defence needs
   a different legal route. Point 6 is precisely the trap: vendors will retain on
   a "fraud prevention" rationale that does not actually reach Art. 9 processing.

8. **Australia forbids the obvious move.** s.63DB prohibits collecting
   government-issued ID or using an accredited Digital ID service for
   age-restriction compliance unless a reasonable alternative is offered, and
   s.63F makes any *other* use of the collected data a privacy interference
   **[P]**. Age assurance must be deployable with no ID, and age data must be
   firewalled from every other purpose.

9. **Appeals are a documented failure mode on real platforms.** Research on
   Instagram and TikTok appeals finds "concerning loopholes", barriers
   concentrated on transgender and sex-working users, and appeal systems
   themselves exploitable for "discrimination, fraud and scams" **[P]**. Our
   appeal path needs adversarial design, not just an endpoint.

10. **Operational evidence for fraud/traffic-safety ML is essentially absent.** A
    2026 survey of 49 sources found **none** of 18 fraud/investigation sources
    reported clean per-decision latency, per-decision cost, or calibration **[P]**.
    Adopt that survey's deployment-evidence checklist as our vendor gate.

---

## 1. Identity verification for dating apps

### 1.1 What is realistically required, and what is gold-plated

There is no legal requirement anywhere in our retrieved sources that mandates
government-ID verification for an adult dating service. The mandates that exist
target *pornography* (UK OSA s.12(3)(a) **[P]**; several US states **[S]**) or
*under-16 social media accounts* (Australia Part 4A **[P]**). Both of those
duties attach to content categories and to minors, not to "dating" as such.

A dating product that hosts user-generated profile text and photos, and permits
messaging between matched adults, is a "user-to-user service" in scope of the
OSA **[P]** and an "online platform" under the DSA **[S]**, but the age-verification
trigger in s.12(4) applies only where the provider *identifies* primary priority
content on the service, and is disapplied where the ToS prohibits that content
class for all users **[P]**.

**Design consequence**: for v0.1, an *age gate* (declare + estimate) plus a
ToS that prohibits primary priority content entirely is the minimum defensible
position in the UK, and is also the only position deployable in Australia.

**Realistically required ladder**, cheapest first:

| Tier | Mechanism | What it actually proves | Verdict |
|---|---|---|---|
| 0 | DOB entry / self-declaration | Nothing against a determined minor; useful as telemetry and as a decoy | Necessary, not sufficient |
| 1 | Liveness + selfie capture | A live face in front of a camera at that moment | Required for anything above Tier 0 |
| 2 | Photo likeness match (selfie vs profile photos) | The account holder plausibly owns the displayed photos | **Highest value per unit of friction for a dating product** |
| 3 | Document verification (ID + selfie + NFC/chip) | Linkage to a real government identity document | Gold-plated for v0.1; and the only tier Australia forecloses for *age* purposes (§6.5) |
| 4 | Source/third-party signals (device, email, phone, account age, graph) | Behavioural consistency, not identity | Cheap, high signal, low privacy cost |

Note the asymmetry in tiers 2 and 3: **tier 2 buys most of the fraud
reduction for none of the special-category exposure.** A likeness match is
biometric processing (Art. 9) but generates no identity document, creates no
cross-service identity, and — importantly — is the tier a scammer's stolen
photo *fails* against, because the person behind the stolen photo will not
match it. Tier 3 is the tier that creates a durable government-identity
linkage we would then have to protect, retain and eventually delete.

Tier 2 is the interesting one and the literature is unusually direct about it:
Sarda demonstrated a proof-of-concept bypass of face verification systems using
StarGAN v2 to generate faces with *similar embedding feature vectors* that look
qualitatively different, and reproduced it black-box against dating applications
that use such systems **[P]**. Note the direction of that finding: likeness
matching raises attacker cost substantially, but it is not a wall, and a
determined adversary with a generative image model is inside the threat model.

**How to read a vendor accuracy claim, in order** (this is the procedure the
evidence above implies, not a finding from a single paper):

1. **Ask for the confusion matrix, not the accuracy.** A single number hides
   which error the vendor optimised. The dorsal-hand age-assurance paper is
   explicit about achieving "zero minor admission" *by choosing its threshold*
   (§2.2) — that is a real and defensible engineering choice, and it is also a
   way to make a number look perfect.
2. **Ask which direction the error runs in each case.** For a dating product,
   false-*reject* (rejecting an honest user) and false-*accept* (accepting a
   fake) are not equally costly and should not be optimised to the same
   number. Our stated position: false-accept is worse for trust, false-reject is
   worse for inclusion and for the 47% of users who do not want checks at all
   (§3.1).
3. **Ask for the demographic slice, not the average.** Demographic bias in age
   estimation is an active research area (§2.2), and the deepfake-detection
   literature independently shows that trivial input degradation moves scores a
   lot (§1.2). An unsliced number is not usable.
4. **Ask how the number was measured.** Offline on a curated set is not a
   production expectation. The 2019 dating-fraud detector's 97% figure is a
   benchmark result on a labelled corpus, and the 2025 IC3 evidence says the
   linguistic advantage it exploited has since been given away to attackers
   (§3.2) **[P]**.
5. **Ask what the vendor retains and trains on.** Entrust retains applicant data
   up to three years by default and offers a retention setting that supports
   "training Entrust's fraud prevention models" (§6.3) **[V]**. A vendor whose
   business model depends on your data is not a neutral assessor of your risk.

### 1.2 The evidence that detection-at-verification-time does not hold

- **Deepfake detectors do not survive the real world.** A 2025 evaluation using
  500,000+ high-quality deepfake images found fewer than half of tested detectors
  reached AUC above 0.60, the lowest at 0.50, and that "basic image
  manipulations, such as JPEG compression or image enhancement, can significantly
  reduce model performance" **[V]**. (Vendor-affiliated — SumSub — so treat the
  absolute numbers as one firm's test; the *shape* of the result, that
  degradation is trivial to induce, is what matters.)
- **Post-capture, there is no protection.** A 2025 IJCB survey of tamper-evident
  embedding in ICAO-compliant facial images states plainly that
  Presentation Attack Detection "are limited to real-time capture and offer no
  post-capture protection" **[P]**, and that ICAO standardisation "facilitates
  practices such as morphing and deepfakes" **[P]**. The implication: the instant
  verification completes, the selfie is a reusable artefact.
- **Motion is a cheap auxiliary signal, but the reported numbers are weak.**
  CanSelfie (30 participants, 375 multi-sensor sequences) reports accelerometer-
  only spoof screening at 0.00% FRR / 43.8% FAR, and a QUANT+3-NN configuration
  reaching 32.0% FAR at 2.37% FRR **[P]**. A 32% false-accept rate is not a
  shipping-grade number; it is a direction of travel. The same paper cites
  ETSI TS 119 461 and CEN/TS 18099 as the European standards that "motivate
  evidence channels beyond camera-based presentation-attack detection" **[P]**,
  which is a useful pointer for a standards-track v0.2.

**Design consequence**: verification is a *time-stamped fact about a moment*,
not a durable property. Our `IdentityRecord` needs an explicit validity horizon
and a re-verification trigger; the `expired` state already exists in
`packages/core/src/states/identity.ts` and is currently the least-specified
state we have. This research is the argument for specifying it.

### 1.3 Mobile SDK vs server-side — now answerable from vendor docs

Entrust publishes a machine-readable documentation index at
`https://documentation.onfido.com/llms.txt` **[V]**. It settles the architecture
question, because it describes how a production vendor expects to be integrated:

- REST API (v3.6 current) plus native SDKs for Web, iOS, Android, React Native
  and Flutter, orchestrated through a no-code "Workflow Studio".
- Regional API hosts (EU / US / CA), token-based Bearer auth, versioned paths.
- The canonical flow: **create applicant → create workflow run (returns an SDK
  token) → collect captures via SDK → retrieve results via webhook or polling**.
- A "Smart Capture Link" alternative for light integration, letting a user
  complete capture on a hosted page without embedding an SDK.
- Webhook signature verification documented as a manual integration step.

So the industry shape is: **the client SDK is a capture surface; the server is
the system of record and the decision-maker.** That is the shape we should take.
It means a client compromise is not architecturally load-bearing, and it means
the hosted-link path is a real fallback for devices where the SDK will not run.

Two cautions from the same source:

1. The workflow is a **no-code visual builder**. That is a commercial benefit
   and an architectural liability: it means the evidence structure is defined in
   a vendor's UI rather than in our schema. We must export and store the
   breakdown structure ourselves, not reference theirs.
2. Their own guidance is that after a run completes you must "download the
   Evidence Folder via API and retains it in line with local laws and
   regulations" **[V]**. **The vendor does not hold the evidence for you.** Our
   `sensitive` classification is about data we hold, so the Evidence Folder is
   ours to classify, retain, and delete. This directly shapes §6.

### 1.4 What the vendor product surface actually looks like

**Entrust (formerly Onfido)** — the only vendor whose primary technical
documentation we retrieved **[V]**. Structure worth noting:

- *Facial Similarity* compares the live capture against the face on the
  identity document, with four variants keyed to the capture task: Motion,
  Video, Photo, and Photo Fully Auto. Motion adds liveness via "a simple head
  turn pattern in both directions or four randomized head movements".
- The response is a **decomposed breakdown**, not a single verdict:
  - *Visual authenticity* → spoofing detection (a 0–1 score) and liveness
    detected;
  - *Face comparison* → face match (a 0–1 score);
  - *Image integrity* → face detected, and **source integrity** ("it has not
    been digitally tampered with or was not taken from a fake webcam").
- The overall result is `clear` or `consider` — **there is no "fail"**. A
  production vendor's own schema has no binary verdict, because authenticity
  and integrity are separate axes. Our `RiskState` should look the same way.
- *Known Faces* compares an applicant against **previous applicants in your
  account database** to catch repeat-identity fraud. Entrust flags plainly that
  this "requires that Entrust maintain a database of facial biometric
  identifiers (personal data) so that individuals can be identified in future
  verifications. Always make sure you inform your users about this and obtain
  any necessary permissions." **That is a standing biometric template database,
  and it is a materially bigger commitment than a one-off check.**

**Socure** — public navigation documents a dedicated "Social & Dating" industry
vertical alongside Fintechs, Gaming, eCommerce and Public Sector, pitched at
"Prevent fake profiles and account takeovers with AI-powered online dating
identity verification" **[V]**. Its product taxonomy separates Fraud & Risk
(`Sigma Identity Fraud`, `Sigma Synthetic Fraud`, `EmailRiskScore`,
`PhoneRiskScore`, `AddressRiskScore`, `Graph Intelligence`) from "ID + Biometric"
(`Predictive DocV`, "ID document and biometric verification with liveness
detection"). Age assurance is marketed as "AI-driven age assurance and low-
friction consent workflows" for "global age verification regulations" **[V]**.

**Jumio** — homepage surfaces a reusable-identity product, "selfie.DONE™ True
reusable identity. Recognize trusted users with just a selfie", alongside
Biometrics, Identity Verification, Risk Signals and AML Screening. The claim
is the inverse of the fraud vendors': recognise **returning** users from one
selfie, i.e. a known-faces-style capability pitched as *reducing* friction
**[V]**. No pricing, no accuracy figures, no technical documentation reachable.

**Sardine** — positions as an "Agentic Financial Crime Platform for Fraud
Prevention & AML" and self-reports as "named a Leader in The Forrester Wave™:
Financial Crime Management Solutions" **[V]**. A vendor-issued analyst
recognition; treat as marketing.

**The architectural observation, now well-evidenced:** the market splits into
(a) document-and-biometric identity proof and (b) device/behaviour/graph fraud
signalling, and sells them as separate products. Our `Identity` and
`Trust & Safety` domains are already split exactly this way (00-overview §3).
The vendor landscape is corroborating a boundary we chose independently.

Not verified and must not be cited: Veriff, Persona, Trustable, AU10TIX, Yoti
(no reachable material). Their existence as market participants is not in doubt.
The secondary record of age-verification data breaches at AU10TIX (2024),
Discord/Zendesk (2025), Persona (2026) and IDScan (2026) **[S]** is also
unverified; it is noted only because vendor concentration in the most sensitive
data we would hold is a risk worth recording on its own reasoning.

---

## 2. Age assurance

### 2.1 Regulatory drivers, from the text

**United Kingdom — Online Safety Act 2023 s.12** **[P]**, in force 10 Jan 2024,
with the age-verification provisions in force by 25 July 2025 **[S]**:

- s.12(3)(a): duty to operate systems and processes designed to "prevent children
  of any age from encountering … primary priority content that is harmful to
  children".
- s.12(4): to comply, a provider "must use age verification or age estimation
  (or both)".
- s.12(5): **the requirement is disapplied where the ToS prohibits that content
  class for all users.** This is the single most useful provision in the section
  for us.
- s.12(6): where used, the measure "must be of such a kind, and used in such a
  way, that it is highly effective at correctly determining whether or not a
  particular user is a child."
- s.12(8): the duty is explicitly **design-level** and enumerates the areas it
  reaches: "design of functionalities, algorithms and other features", "policies
  on terms of use", "policies on user access", "content moderation", "user
  support measures", and "staff policies and practices". This is a statutory
  safety-by-design mandate, and it is a direct mandate for 00-overview §2.

**Australia — Online Safety Amendment (Social Media Minimum Age) Act 2024 (No.
127, 2024)**, assented 10 December 2024, inserting Part 4A into the Online Safety
Act 2021 **[P]**:

- s.63D: providers must "take reasonable steps to prevent age-restricted users
  having accounts", where an *age-restricted user* is "an Australian child who
  has not reached 16 years". Civil penalty: **30,000 penalty units**.
- s.63C(1): the definition of an age-restricted social media platform is broad —
  an electronic service whose "sole purpose, or a significant purpose" is
  enabling online social interaction between end-users, allowing linking,
  interaction, and posting. A dating app is plainly in scope. Note also s.63C(4):
  the Minister may designate a service *by class*.
- s.63DA: a provider **must not collect** specified kinds of information for the
  age-restriction purpose, where legislative rules have specified them. Civil
  penalty 30,000 penalty units.
- s.63DB: a provider **must not collect government-issued identification
  material**, or **use an accredited service under the Digital ID Act 2024**, for
  the age-restriction purpose — *unless* the provider "provides alternative
  means (not involving the material and services mentioned)" which are
  "reasonable in the circumstances". "Government-issued identification material"
  is defined to include digital IDs issued by a Commonwealth, State or Territory
  authority.
- s.63F: if an entity holds personal information collected for the age-restriction
  purpose and uses or discloses it for anything other than determining whether
  the individual is an age-restricted user (or one of the listed APP exceptions,
  or with valid consent), that use or disclosure **is taken to be an interference
  with privacy and covered by s.13 of the Privacy Act 1988**.

s.63F is a hard architectural wall: age-assurance data cannot flow into
discoverability, ranking, profiling, or analytics. That maps directly onto 00-
overview §6.3 and onto the `sensitivity` field on `DomainEvent` in
`packages/core/src/domain-event.ts`. It is an independent argument for treating
age assurance as its own class, not as an attribute of the identity record.

**United States** **[S]** — Louisiana was first (2022); a wave of state
"social media addiction" laws followed in 2023 (Arkansas, Utah) prescribing
age verification; in June 2025 the Supreme Court ruled 6–3 in *Free Speech
Coalition v. Paxton* upholding a Texas age-verification statute on the basis
that it "only incidentally burdens the protected speech of adults"; a new
instrument — the **Digital Age Assurance Act, signed into law by California in
October 2025** — shifts the duty to operating-system and app-store vendors
providing an age-attestation API, with the legal consequence that a platform
holding the returned age signal holds "actual knowledge" of the user's age.
Secondary sources only; the court opinion and the statute text were not
retrievable and must be read directly before we rely on either.

**European Union** **[S]** — the DSA requires platforms accessible to minors to
maintain a high level of privacy, safety and security; the Commission adopted
2025 guidelines on protection of minors covering age verification and privacy by
default; a proposed "EU Kids Act" was reported in September 2026 to require age
verification at account opening, still subject to negotiation. The DSA text
itself was behind an AWS WAF challenge and could not be retrieved.

### 2.2 Accepted technical approaches, and their accuracy bounds

A 2026 survey by Lueks, Dreyer, Federrath and Simon separates age assurance into
*approaches* (age verification, age estimation, age inference, parental
control/consent) and *architectures* (online, offline device-based, offline
credential-based), assesses each on effectiveness, side-effects and acceptance,
concludes that "general limitations of AAT's effectiveness stem from the
possibility of circumvention", and proposes "a graduated hierarchy of acceptable
AAT mechanisms" **[P]**. That hierarchy is the single most useful framing we
found: it says not all age assurance is equal, and licenses us to choose a
defensible rung rather than the most aggressive one.

A companion 2026 review of **85 publications on children's age assurance
(2020 – Feb 2026)** by Ma, Dumaru, Synaepa-Addison, Kropczynski and Wisniewski
finds that "shared terms such as age verification describe different processes",
that "rights, access, and privacy receive more attention than accuracy, error,
and fairness", and that "institutional actors are rarely connected to system
failures or user remedies, an accountability gap" **[P]**. Their Age-Assurance
Process Framework treats age assurance as a sociotechnical chain —
evidence → evaluation → claims → decisions — rather than a model **[P]**.

**That framework should be adopted verbatim into our design vocabulary.** Our
architecture already separates the four stages into distinct domains
(Identity owns evidence, Trust & Safety owns evaluation, the account state owns
claims, Moderation owns decisions — 00-overview §3 and §4). The external
literature is telling us that separation is correct, which is worth knowing
independently of us having arrived there.

Facial age estimation is the industry default and is documented as combining
selfie analysis with a liveness test **[S]**. On accuracy bounds, three findings
and one honest gap:

- **The reference survey is a survey, not a benchmark.** "Age estimation via face
  images: a survey" (Kühne et al., 2018; 167 citations) frames the problem as
  label-definition: age estimation is "labeling a face image with exact real age
  or age group", and asks how humans recognise faces across ages and which
  features are age-invariant **[P]**. It establishes that the underlying
  problem is ill-posed, not that a particular system is accurate.
- **Metric choice is doing the work, and vendors choose it.** The one concrete
  comparative result we retrieved is from a different modality: dorsal-hand
  morphometrics for XR age assurance, on 436 ethnodiverse participants spanning
  the minor–adult boundary, reporting a "challenge-31 operating point" achieving
  **zero minor admission** with "performance robust to skin-tone variation"
  **[P]**. Read that phrase precisely: it is a *threshold choice* that accepts
  a false-adult rate in exchange for zero false-minor admissions. **A vendor can
  always claim a near-perfect number by telling you which side of the error it
  optimised.** This is the single most important thing to insist on in vendor
  evaluation: ask for the full confusion matrix at the 18-year boundary, in both
  directions, per demographic slice.
- **Bias is a first-class concern, not a footnote.** A systematic line of work
  addresses demographic bias in age estimation models through dataset
  composition **[P]**, and the field has a dedicated literature on demographic
  fairness in face recognition generally. A model that is accurate on average
  and poor for a group is worse than useless for age assurance: it produces
  exactly the wrong error, on exactly the users least able to contest it.

**[?] The gap we could not close**: no retrieved source gives a defensible
accuracy figure for facial age estimation at the 18-year threshold, and no
vendor published one we could reach. **Do not adopt a number, and do not let
one enter a design document from a sales deck.** The metric-argument above is
the defensible position: demand the confusion matrix, both directions, sliced.

### 2.3 Privacy-preserving designs that prove 18+ without revealing DOB

These exist and are credible, but none is cheap:

- **Zero-knowledge proof over a government credential.** A 2025 zk-STARK
  framework demonstrates protocols "allowing users to prove that their
  credentials satisfy specific conditions (e.g., 'age is over 18') without
  revealing any underlying sensitive data" **[P]**, with improved prover
  efficiency and no trusted setup at the cost of larger proofs.
- **Verifiable differentially-private age queries.** A 2022 line of work
  demonstrates how practitioners "could employ our primitives to verifiably query
  individuals' age from their digitally signed ID card in a differentially
  private manner" **[P]**.
- **[V]** Federated learning with differential privacy for in-conversation
  predator detection reports only "a slight reduction in utility" **[P]** — this
  is the practical escape hatch if we ever want behavioural detection without a
  central transcript store.

### 2.4 The legal/technical gap nobody has closed

A 2026 ICML position paper asks whether an age estimator processes biometric
data, notes that the answer "triggers consent requirements under GDPR,
statutory damages under BIPA, or high-risk AI classification under the EU AI
Act", that "no regulatory guidance addresses it", and presents empirical evidence
across 14 models and 3 face-verification benchmarks that age estimators "fall
orders of magnitude short of identification thresholds" and "cannot identify
individuals" **[P]**.

This cuts both ways and we should say so honestly: it is an argument that age
estimation is *not* special-category processing, and an argument that the
distinction between transient processing and template storage is currently
unresolved. **Do not rely on it as a compliance conclusion.** It is a researcher's
position paper, and the authors themselves call for regulator guidance that does
not yet exist.

---

## 3. Content and behaviour safety

### 3.1 Baseline harm prevalence (US adults)

Pew Research Center, survey of 6,034 US adults, 5–17 July 2022 **[P]**:

| Harm experienced by people who have used a dating site/app | All users | Women under 50 |
|---|---|---|
| Unsolicited sexually explicit message or image | 38% | 56% |
| Continued contact after saying not interested | 30% | 43% |
| Called an offensive name | 24% | 37% |
| Threatened with physical harm | 6% | 11% |
| Encountered someone they thought was trying to scam them | 52% | 44% (all women) |

Also: 48% of US adults say online dating is a generally safe way to meet people,
**down from 53% in 2019**; 60% support requiring background checks before
profile creation, but only **47% of people who have actually used dating apps**
support it; 54% of women who dated in the past year felt "overwhelmed" by message
volume versus 25% of men, while 64% of men felt "insecure" about message volume
versus 40% of women **[P]**.

The support-gap between the general public (60%) and actual users (47%) is the
single most important number here for product design. **Safety mandates that
users do not want are a retention problem, not a safety problem.** Any friction
we add is paid for by the same people we are protecting.

### 3.2 Scam scale and shape — from the FBI's own data

**FBI IC3 2025 annual report** (1,008,597 complaints, $20.877B losses) **[P]**.
The three-year trend for Confidence/Romance, which is IC3's term for
"heartstrings" fraud:

| | 2021 | 2022 | 2023 | 2024 | 2025 |
|---|---|---|---|---|---|
| Complaints | 24,299 | 19,021 | 17,823 | 17,910 | **23,159** |
| Loss | $956.0M | $735.9M | $652.5M | $672.0M | **$929.3M** |

2023 showed a three-year decline, which is what most secondary write-ups
recorded. **2025 reversed it: complaints +29% and losses +38% year over year,
back to roughly the 2021 peak.** Anyone quoting a "decline in romance scams" is
two years out of date.

Two structural facts from the same report matter more than the trend:

1. **Dating apps are a named intake channel for investment fraud.** IC3:
   crypto investment scammers "typically initiate contact through text messages,
   social media sites, advertisements, or **dating applications** and then quickly
   move the conversation to a messaging platform. Often the victims are introduced
   to investment groups representing themselves to be knowledgeable industry
   insiders offering guidance on trading or investing in cryptocurrency or gold."
   Victims "are shown fake profits and offered loans to encourage larger
   investments", and at withdrawal "charged taxes and fees as a final attempt to
   exploit money" before the scammer disappears. The report further states these
   scams are "largely perpetrated by organized criminal enterprises based in
   Southeast Asia using **victims of human trafficking as forced labor** to run the
   scam operations" **[P]**.
   Total 2025 investment losses: **$8,648,617,756**, 72% of which
   (~$7.2B) was cryptocurrency-related and was "the highest source of financial
   losses to Americans in 2025" **[P]**.
2. **AI has changed the economics of the con.** IC3 received 22,364
   AI-nexus complaints with $893.3M adjusted losses in 2025, and reports for
   Confidence/Romance specifically that "Scammers are creating fake profiles and
   scripts produced by AI chat generators to make speech more believable"
   (>$19M in 2025), and for Investment that AI lets scammers "quickly generate
   thousands of conversations that appear different to each prospective victim",
   including "AI-generated videos and voices of celebrities, CEOs, or trusted
   figures". IC3's own conclusion: "AI-enabled synthetic content is becoming
   increasingly difficult to detect and easier to make" **[P]**.

**Design consequences, in order of importance:**

- **Our threat model must include investment-fraud staging, not just the
  long-con romance script.** A detector trained on "does this person want my
  money" will miss an account whose current behaviour is pure warmth and whose
  payload is an investment pitch arriving in week three.
- **The escalation primitive is what matters.** Every described funnel shares
  the same structure: contact on-platform → rapid move to an off-platform
  channel → introduce a "platform" or "group" → solicit funds. **The earliest,
  cheapest, most reliable signal is an attempt to move a conversation to a
  channel where we lose visibility and cannot moderate.** That is a behavioural
  signal we can detect without reading content, and it does not degrade when the
  attacker improves their prose.
- **Do not build a scam detector whose main feature is linguistic naturalness.**
  That feature is exactly what GenAI removed from the attacker's cost function.
  Per-message text quality is a *decaying* signal; channel-migration behaviour
  and infrastructure reuse are *durable* signals.
- **Off-platform migration is also the strongest single reason to keep contact
  inside the product**, which independently justifies in-app calling (Bumble's
  stated rationale) over exporting a phone number.

### 3.3 Scam typologies from the research literature

- **Long-horizon, human-in-the-loop, and rotated across operators.** Fake
  profiles from stolen or AI-generated photos; plausible excuses for never
  meeting; a grooming period "sometimes months or even an entire year"; run by
  "fraud factories" that rotate operators so the victim cannot detect the
  handoff **[S]**. The rotation detail is the operationally important one:
  **one account's behaviour does not carry the whole signal — the shared
  infrastructure does.** That argues for graph and device signals
  (`Sigma Identity Fraud`, `Graph Intelligence`, `Device Intelligence`) over
  per-account NLP.
- **"Traditional detection methods (e.g., those used in spam filtering) are
  ineffective"** because fraudsters "craft fake profiles and manually interact
  with their victims" — Suarez-Tangil et al., who then built the first automated
  detector and reported 97% accuracy **[P]**. Read that as a result on a
  labelled, curated corpus, not a production expectation. It is a 2019 result,
  and 2025 IC3 data says the underlying advantage has since been given away to
  the attacker by GenAI.
- **Pig butchering.** A multi-vantage study (March–October 2024) covering
  430,000+ accounts and 770,000+ posts across four platforms, 3,200+ public
  abuse-report narratives and ~1,000 news articles, covering 834 victims and
  approximating **$521M in losses**, finds these attacks "are sophisticated and
  often require multiple entities … to work together" **[P]**.
- **The lifecycle is a sequence, not an event.** Interviews with 26 victims
  describe staged trust-building, fraudulent financial platforms, fabricated
  returns, and persistent re-engagement *after* loss, plus "heightened
  vulnerability to secondary scams" **[P]**. A user who has already been scammed
  is a **higher**-priority safety subject, not a lower one — the recovery
  window is when secondary fraud lands.
- **Investigating at scale is genuinely hard**: because the crime is
  conversational and long-running, it is "extremely challenging to investigate at
  scale" **[P]**.
- **Platform design is an accomplice.** Interviews with 25 victims in China
  identify the affordances scammers weaponise: "professional-looking profile
  verification, algorithmic recommendations that reinforce contact, integrated
  payment systems, and private chat affordances" **[P]**. Read literally, our
  strongest product claims are also our adversary's toolkit. Note that
  "professional-looking profile verification" appears in the scammer's list —
  which argues that our verification UI should be informative about *what* was
  checked, not a bare badge.
- **Deception extends well beyond profile misrepresentation.** A typology from
  22 gay dating app users in China finds relational, emotional, financial and
  commercial deception, and describes trust assessment as "a multi-signal,
  provisional process rather than a binary judgment" **[P]**.
- **Older adults are a distinct risk segment** — catfishing, fraud,
  information disclosure and accessibility concerns **[P]** (n=11, small). The
  IC3 data corroborates the severity: complainants aged 60+ filed 201,266
  complaints with **$7.7B in losses** in 2025, versus $1.7B for 50–59 and
  $1.7B for 30–39 **[P]**. The over-60 cohort is ~20% of complaints and ~37% of
  losses.
- **Sextortion is a distinct and severe sub-pattern.** IC3 recorded 56,000+
  sextortion complaints in 2025 concentrated in under-20 and 20–29
  (11,316 and 22,061 respectively), and describes the mechanism: "this crime
  starts when people believe they are communicating with someone their own age
  who is interested in a relationship, or with someone who is offering something
  of value. After the criminals have one or more videos or pictures, they
  threaten to publish that content" **[P]**. It notes that shame, fear and
  confusion "often prevent users from asking for help or reporting the abuse",
  and IC3 referred 5,700+ minor-involving submissions to NCMEC in 2025 **[P]**.
  **The under-reporting is the design constraint**: a report-only pipeline is
  structurally blind to this category.

### 3.4 Grooming detection — the precision finding that decides our architecture

Three findings, consistent across independent work:

1. Fine-tuned sentence encoders **fail to tag instances where the predator uses
   indirect speech pathways and coded language**, and those instances are
   characterised by higher out-of-vocabulary content that causes misclassification
   **[P]**.
2. Evaluating across law-enforcement officers, real victims and decoys using a
   fuzzy-theoretic mapping of human risk judgement, models show **high variance
   in predictions "especially for contexts containing higher degrees of grooming
   risk"** **[P]**.
3. Chat-level risk labels produce weak supervision; a turn-level formulation
   derived from luring communication theory, with reinforcement learning over
   intervention timing, materially improves early detection — and the paper notes
   "limitations in previously used chat-level metrics" **[P]**.

Point 2 is the load-bearing one. **The detector is least reliable exactly where
the stakes are highest, and that is a measured property, not a hypothesis.** It
is the external, citable justification for commitment #2 and ADR 0004: a system
whose errors concentrate at the dangerous end cannot be permitted to enforce.

This also means the useful unit of detection is a **conversation over time**, not
a message. Our `RiskState` machine and the `allowedEvents(state, ctx)` guard
pattern in `packages/core/src/transition.ts` are a natural fit for turn-level
decay, which is commitment #3.

### 3.5 Spam, bots and evasion

- A 2024 ACL paper finds LLM-guided manipulation of user textual and structured
  information can bring down existing bot detectors "by up to 29.6%" and
  explicitly "harm the **calibration and reliability** of bot detection systems"
  **[P]**. Calibration, not accuracy, is the thing that breaks.
- TwiBot-20 (229,573 users, 33.5M tweets) finds that existing bot-detection
  measures "fail to match their previously claimed performance" on a
  representative benchmark **[P]**.
- A 2026 adversarial study on LLM-powered bot detection reports attacks that
  degrade accuracy by up to 48%, with a defensive ensemble holding 86% under
  adaptive pressure **[P]**.
- A review of 534 publications narrowed to 49 finds recurring methodological
  issues and the evolution of bot concealment techniques **[P]**.
- **[?]** Ethics of bot detection are unsettled: a FATe-framework analysis
  examines "user experiences of people being detected as bots" and argues these
  algorithms "operate within complex socio-technical systems" where
  accountability and transparency are live concerns **[P]**.

### 3.6 Harassment in private messages

Most harassment research is on public content. Three findings converge here:

- A 2026 study on **80,053 Instagram direct messages from 26 adolescents aged
  12–18** builds a context-aware cascading LLM pipeline and finds it
  **outperforms baseline toxicity classifiers trained primarily on public social
  media data** **[P]**, because "harmful interactions often unfold through
  context-dependent, multi-turn exchanges".
- Meta's own work on the same problem — "Getting Meta: A Multimodal Approach for
  Detecting Unsafe Conversations within Instagram Direct Messages of Youth" —
  investigates "which indicators are most helpful in automatically detecting
  risk in Instagram private conversations, **with an eye on high-level
  metadata**", and is motivated by the switch to end-to-end encryption limiting
  what data is available **[P]**. Note the direction: when content becomes
  unreadable, platforms lean on **metadata**.
- A systematic review of cyber-abuse detection catalogues the forms that matter
  and notes detection methods are unified only uneasily across "cyberbullying,
  online harassment, and the dissemination of offensive and hate speech" **[P]**.

The training-data problem is separable and worth naming: a systematic review of
**63 publicly available abusive-language training datasets** concludes that
creating datasets which are "large, varied, theoretically-informed and that
minimize biases is difficult, laborious and requires deep expertise" **[P]**.
There is no adequate public training set for dating-domain harassment, and we
should not pretend otherwise.

**Design consequences:**

1. Our Communication domain must emit **conversation-scoped** signal to Trust &
   Safety, not message-scoped verdicts. 00-overview §4 already routes
   `message.reported` at `restricted`; the gap is that *behavioural* signals
   from a conversation should reach safety without a report.
2. **Metadata beats content for scam and harassment detection.** If we ever move
   to encrypted-at-rest message content, the detectors that survive are
   conversation-level behavioural features — volume, timing, channel
   migration, link posting, image-forwardness. Decide this now, while content is
   available, rather than discovering it under a privacy commitment.
3. **Expect to build our own labelled set.** There is no public dating-domain
   corpus. This is a real cost line, not an assumption.

---

## 4. Moderation operations

### 4.1 What the labour research says

A 2025 study built on participatory design workshops with **33 content
moderation professionals** in industry and civil society finds that successful
moderation is understood by practitioners to be "principled, consistent,
contextual, proactive, transparent, and accountable", and that companies fail to
achieve those goals due to "exploitative labour practices, chronic
underinvestment in user safety, and pressures of global scale" **[P]**. The
paper's framing is that the pursuit of growth structurally subordinates safety
work.

The operational implication is uncomfortable and should be stated plainly: **our
queue design is the safety design.** If moderation is a low-status,
high-cognitive-load, under-resourced function, every commitment in 00-overview §2
degrades in practice regardless of what the type system guarantees.

### 4.2 SLA and evidence expectations

**[?]** We could not retrieve any primary platform SLA commitment. This is a
genuine gap. What the retrieved sources establish:

- **Redress is now a legal requirement, not a courtesy.** Under the DSA, users
  may appeal through the platform's internal complaint-handling system — with a
  duty to "promptly review" decisions — and may escalate to certified
  out-of-court dispute settlement bodies (nine certified in the EU; ADROIT was
  first, and Appeals Centre Europe covers Meta's services) **[S]**. The
  out-of-court route is free or cost-covering, and **if the body rules for the
  user, the platform bears the fees** **[S]**.
- **Non-compliance has teeth.** The Commission's first DSA non-compliance
  decision, December 2025, fined X **€120 million** across deceptive design,
  ad transparency and researcher data access; the general ceiling is 6% of
  global turnover **[S]**.
- **Researcher access is now a statutory capability.** DSA Art. 40 requires
  platforms to grant data access to researchers, and the delegated act
  specifying procedures entered into force 29 October 2025 **[S]**. This means
  our moderation decisions and their aggregate effects are inspectable by
  third parties. Write them as if that is true, because it is.

**Design consequence for appeals**: our `account_state.changed` is currently a
one-way fact. If we enforce without a recorded, human-reachable appeal path, we
will fail the DSA in the EU and we will have no defence against a wrongful ban
anywhere. This is an argument for making the case record a *bidirectional*
object: a moderator decision must be reversible by a moderator, on a recorded
basis, with the reversal itself audited.

### 4.3 "False positive is not an irreversible black box"

This phrase is a design requirement, and the retrieved evidence says it is
currently **not** what platforms do. A 2025 study of mandatory transparency
reporting for content moderation **[S]** and a companion arguing that
"Transparency ≠ Accountability? Rethinking Voluntary Vs. Mandatory Content
Moderation Reports" **[S]** both point at the same gap: reporting rates are not
reasons, and aggregate counts do not let anyone audit an individual decision.

Concretely, "not a black box" requires four things we currently do not have:

1. **The detector's score and version are on the case record.** A moderator
   reviewing a case must see *why it was queued* — which detector, which
   features, what threshold. Without this, the moderator cannot calibrate and
   cannot exercise judgement.
2. **The user-facing reason is a capability statement, not a verdict.**
   00-overview §5 already says `limited` is "capability-based, not a blanket
   mute" and that "every restriction names the capabilities it removes". That is
   the right model and it is stronger than most published practice.
3. **Reversal is a first-class transition**, not a support ticket.
4. **Aggregate false-positive measurement is reported.** See §7.

**Design consequence**: the case record must carry detector provenance as
`internal` sensitivity. This is a concrete requirement for the
Moderation & Enforcement domain that no current document in `docs/` states.

### 4.4 Appeals as an attack surface, not a feature

The published evidence on appeals is uniformly bad, and specifically bad in ways
we can design against. A 2024 study of appeals on Instagram and TikTok, drawing
on fairness and due-process literature and interviewing de-platformed users,
finds "significant barriers faced by particularly transgender and sex working
users when recovering their" content or accounts, "concerning loopholes within
these platforms' appeals, leaving room for discrimination, fraud and scams and
leading to user disempowerment" **[P]**.

Three things follow, and they are design requirements rather than observations:

1. **The appeal path is an attack surface.** If appeals exist and are reachable,
   they will be used to launder bans, to socially engineer moderators, and to
   grief the reporter. Treat appeal submission as untrusted input with the same
   controls as any other public surface.
2. **Appeals are unevenly distributed in cost.** A user with a precarious
   livelihood or an unsafe home cannot easily appeal a de-platforming; a user
   with stable circumstances can. If our enforcement is *correct*, unequal
   appeal cost still produces unequal outcomes — which is a fairness failure
   independent of accuracy. Consider an appeal path that does not require
   re-engagement with the platform the user just lost.
3. **A person banned for sex work or for trans identity is a category our
   detectors will over-flag**, for the same reasons grooming and harassment
   detectors over-flag coded language (§3.4). Whatever the population
   distribution, the *classifier* distribution will not match it.

A separate thread of evidence makes the same point from the other direction: a
2024 CHI paper records a de-platformed participant saying **"There's so much
responsibility on users right now:"** when asked how to stay safe from hate and
harassment **[P]**. Whatever the platform's intention, users experience safety
tooling as an obligation they carry. That is a copy and affordance problem as
much as a policy one.

### 4.5 What real platforms disclose

- **Bumble** publishes a safety page stating it runs "a team working around the
  clock" to remove "spam, fake profiles, and anyone who violates our community
  guidelines"; offers Photo Verification, a Private Detector that auto-blurs
  lewd images, Snooze, Block & Report; and — critically — states that **"even if
  you've unmatched a person, you can still use any information you have about
  them to file a report with our safety team"** **[P]**. Bumble does **not**
  publish rates, SLAs, or FP/FN figures on that page.
- **Tinder, Match Group, Meta, X** — no transparency report was retrievable.
  `matchgroup.com` failed DNS, `transparency.tinder.com` failed to connect,
  `transparency.meta.com` returned HTTP 400, `about.fb.com`'s Community
  Standards Enforcement Report path returned 404. **[?]**
- **Regulators are producing the disclosure that platforms are not.** Under the
  DSA the Commission runs a Transparency Database for platforms to submit
  explanations of moderation decisions, Art. 40 grants researcher data access
  (delegated act in force 29 October 2025), and the first non-compliance
  decision — December 2025, €120M against X — was public and itemised across
  deceptive design, ad transparency and researcher data access **[S]**. If
  platform disclosure stays voluntary, the audit function migrates to the
  regulator. That is the more likely long-run shape.

**The absence of publishable, dating-specific, quantitative moderation
transparency is itself the finding.** We have a §7.4 metric set that a platform
could publish today. Bumble publishes none of it. That is a genuine
differentiation opportunity for a product whose thesis is "safe by
construction" — but it is also a commitment: publishing a false-positive rate
invites the obvious response, and the 47%-support figure (§3.1) says our users
are already ambivalent about safety measures. Decide deliberately whether to
publish, and publish calibration, not a headline accuracy number.

---

## 5. Safety-by-design patterns

The UK OSA s.12(8) is the cleanest external mandate for this section: it names
"design of functionalities, algorithms and other features", "policies on terms
of use", "content moderation", "user support measures" and "staff policies and
practices" as areas the child-safety duty reaches **[P]**. Safety-by-design is a
compliance obligation, not an optional extra.

**Patterns that reduce harm with bounded friction:**

- **Default-blur, opt-in unblur.** Bumble's Private Detector blurs lewd images so
  the *recipient* decides **[P]**. This puts the decision on the person with less
  power and adds zero friction for the honest case.
- **In-app contact deferral.** Bumble ships in-app video/voice so users "meet"
  without exchanging phone numbers or email "before you're ready" **[P]**. The
  phone number is the single most useful cross-platform correlator for a fraud
  factory, and keeping it inside the platform keeps it inside our evidence and
  our enforcement.
- **Account-creation friction is cheap; interaction friction is expensive.**
  The asymmetry follows from §3.1: users already dislike message volume
  (54% of women overwhelmed) **[P]**, so penalising *sending* is far more costly
  to us than penalising *signing up*.
- **Block must be one action and must be immediate and total.** Research on
  user-enacted moderation tools finds users with vision impairments absorb
  "learning costs", "compliance costs" and "psychological costs", and quotes a
  participant: *"I thought it was my mistake, but it's really the design"*
  **[P]**. Safety affordances that are hard to find or hard to complete are not
  safety affordances for a subset of users.
- **Cross-platform block propagation is a wanted feature, not a solved one.**
  A 2025 position paper proposes unified interoperable blocking so a user
  blocks once **[P]**. For us the useful analogue is narrower and easier: a
  block must be platform-total and immediate within Been There, with no
  loophole through unmatch. Given the fraud-factory rotation finding (§3.3), a
  blocklist that only binds one account is a speed bump.
- **Friction must be designed, not sprinkled.** "The Framework of
  Security-Enhancing Friction" argues for bringing UX into usable-privacy work
  because behaviour change is a "complex interplay between user-related,
  system-related and contextual factors", including "negative experiences"
  **[P]**. The practical reading: a friction mechanism that produces a bad
  experience teaches users to route around it, and we lose both the friction
  and the trust.
- **Warnings and nudges have a measurable ceiling, and it is not high.** A
  study of misinformation warnings on TikTok and Instagram Reels (28
  participants, think-aloud) finds user interaction and perception with
  warnings is "nuanced" rather than uniformly effective **[P]**. Another
  records that content-provenance signals and verified-source labels shift
  credibility perceptions in measurable ways **[P]**. So: nudges are cheap and
  worth shipping, but they are not a substitute for a control, and we should
  not report a warning's presence as a harm reduction.
- **A verified badge is a claim we must be able to explain.** The scammer-side
  research lists "professional-looking profile verification" among the
  affordances used to build credibility **[P]**. A bare badge that a scammer
  can obtain and a user cannot interrogate is a net negative. If we ship
  verification, the UI must say *what was checked* — which is exactly the
  decomposed breakdown a production vendor already returns (§1.4).
- **Community blocklists generate the same false-positive anxiety for
  moderators as for users** — Mastodon moderators "balance proactive safety,
  reactive practices, and caution around false positives", and ask for comment
  receipts, category filters and collaborative voting **[P]**. "Comment
  receipts" — letting a moderator see the reported item as it appeared — is a
  cheap, high-value moderation UX affordance and should be in our v0.2 list.
- **Participatory design with the affected group, not about them.** Zytko and
  colleagues argue for redesigning dating-app AI interactions *with* women and
  LGBTQIA+ users to mediate consent, on the grounds that these groups face
  "disproportionate risk of sexual violence and other harms" **[P]**. This is a
  process commitment, and it belongs in the Communication feature docs.

**Supporting research for the patterns above**: "The Framework of
Security-Enhancing Friction: How UX Can Help Users Behave More Securely" (USENIX
Security 2020, https://doi.org/10.1145/3442167.3442173); "Seeing is Not
Believing: A Nuanced View of Misinformation Warning Efficacy on Video-Sharing
Social Media Platforms" (CSCW 2023, n=28, https://doi.org/10.1145/3610085);
"Examining the Impact of Provenance-Enabled Media on Trust and Accuracy
Perceptions" (https://doi.org/10.1145/3581784.3581802).

**Rate limits**: we could not retrieve primary guidance. One relevant negative
result: an NDSS 2026 study probed over 100 million phone numbers per hour
against WhatsApp "without encountering blocking or effective rate limiting" **[P]**,
and reported collaborative remediation. The lesson is that rate limits are only
as good as their observability, and a limit that is trivially farmable is worse
than no limit because it produces a false sense of control.

**Slow-down patterns**: still **[?]** as a shipped intervention — we found no
study of a dating product shipping one. But the surrounding evidence sharpens
what it would have to do. The pig-butchering and investment-fraud research both
describe a staged lifecycle whose decisive step is the *handoff* — the move to
an off-platform channel, then to a "platform" or "group", then the payment
request **[P]**. A slow-down that only throttles message *volume* does nothing
about that. A slow-down that withholds or gates **the escalation primitive** —
the off-platform handoff, the link, the payment mention — is the version the
evidence actually supports. Treat this as the most promising untested safety
idea we have, and design the experiment (interception rate at handoff, plus
appeal and reversal rates) *before* building the feature.

**One pattern the evidence argues against**: nudging users toward safety
behaviour as the primary control. The 47%-of-users support figure (§3.1) and
the "so much responsibility on users right now" finding (§4.4) both say
responsibility-shifting copy reads as blame and does not work. Intervene in
the product, not in the user.

---

## 6. Privacy law obligations

All of the following is from the retrieved text of GDPR **[P]** (EUR-Lex
CELEX 32016R0679) or from ICO guidance **[P]**, except where marked.

### 6.1 Biometrics and Art. 9

- **Recital 51 is the load-bearing sentence**: "The processing of photographs
  should **not** systematically be considered to be processing of special
  categories of personal data as they are covered by the definition of biometric
  data **only when processed through a specific technical means allowing the
  unique identification or authentication of a natural person**." A profile
  photo shown in discovery is not Art. 9. A selfie run through a liveness and
  likeness pipeline *is*.
  This validates 00-overview §6.3 exactly as written: sensitivity is
  **per field**, because whether a photo is special category depends entirely on
  the processing applied to it, not on the format.
- **Art. 9(2) conditions do not include legitimate interest.** The listed
  conditions are explicit consent, employment/social security, vital interests,
  not-for-profit legal bases, manifestly public data, establishment/exercise/
  defence of legal claims, health, and substantial public interest. Meanwhile
  **Recital 47** says "The processing of personal data strictly necessary for the
  purposes of preventing fraud also constitutes a legitimate interest of the data
  controller concerned." So the fraud-prevention argument that covers our Art. 6
  processing **does not by itself unlock Art. 9 processing of biometrics**. Any
  retention of selfie/liveness artefacts for fraud defence needs a different
  basis. **[P]** for both texts; the inference that they do not compose is ours
  and should be reviewed by counsel before we commit.
- **Art. 5(1)(e) / Recital 39 on storage limitation**: personal data "should be
  processed only if the purpose … could not reasonably be fulfilled by other
  means", "ensuring that the period for which the data are stored is limited to a
  strict minimum", and "time limits should be established by the controller for
  erasure or for a periodic review" **[P]**. Moderation evidence retention must
  therefore be a **declared, per-class, time-bounded** policy with a periodic
  review — not "we keep it".
- **Art. 35 DPIA is not optional for us.** The ICO's Art. 35(4) list requires a
  DPIA for: **"Biometrics: any processing of biometric data"** where combined with
  any European-guideline criterion; **"Denial of service: Decisions about an
  individual's access to a product, service, opportunity or benefit that is based
  to any extent on automated decision-making … or involves the processing of
  special category data"**; **"Targeting of children or other vulnerable
  individuals"**; **"Risk of physical harm"**; and **"Tracking … an individual's
  geolocation or behaviour"** **[P]**. We hit at least four of these
  simultaneously. Article 35(3)(b) — large-scale processing of Art. 9 data —
  requires one *regardless*.
  Practical reading: the "automation never enforces" commitment is what keeps us
  inside Art. 22 territory, and the DPIA is where we document that.
- **Recital 38 on children**: children "merit specific protection … as they may
  be less aware of the risks, consequences and safeguards concerned" **[P]**.

### 6.2 Right to erasure vs fraud prevention

The ICO's guidance is precise **[P]**. The right applies when data is no longer
necessary, when consent is withdrawn, on objection where there is no overriding
legitimate interest, for direct marketing objection, where processing was
unlawful, to meet a legal obligation, or where data was processed to offer
information society services to a child.

**Erasure does not apply where** processing is necessary to exercise freedom of
expression and information, comply with a legal obligation, perform a public
interest task, for archiving/research where erasure would render the processing
impossible, or — the one that matters for a moderation case —
**"for the establishment, exercise or defence of legal claims"**. The ICO's own
worked example is a healthcare provider whose liability insurance requires
retaining records in case of complaints; the organisation "can refuse the
request", because "they are processing the data for the establishment, exercise or
defence of legal claims".

That is precisely our ban-appeal scenario. **We can hold a banned user's
moderation evidence and refuse erasure, and the regulator's own example is a
near-miss for our fact pattern.** Three operational obligations follow: (a) we
must be able to *identify* which records are held under the legal-claims
exemption, which requires the retention schedule to tag them, not just to expire
them; (b) we must tell the user, within one month, that we refused, why, and
that they may complain to the ICO **[P]**; (c) backups must be put "beyond use"
even when they cannot be immediately overwritten, and the user must be told
exactly what that means **[P]**.

The interaction with commitment #4 (unmatch does not destroy the right to
report) is direct: if unmatch can orphan evidence, we can lose both the case and
the exemption.

### 6.3 The vendor default directly conflicts with all of this

This is the concrete collision, and it needs a procurement answer before it
needs a legal one. Entrust's published data-deletion policy states **[V —
vendor's own technical documentation]**:

- "Entrust may retain applicant data, including associated data for **up to 3
  years** after the applicant's last interaction."
- "the compound data retention period (including the data deletion delay and
  rolling data deletion) **cannot exceed a total of 3 years, or 1095 days**."
- "Customers can configure a dedicated retention period for **fraud-related
  applicant data** that is separate from the standard rolling deletion period.
  This provides greater flexibility for fraud investigations **and training
  Entrust's fraud prevention models**."
- Ad hoc deletion soft-deletes into an Archive for a default **20 days**
  (reducible to 24 hours); rolling deletion has a **48-hour minimum**.
- The Archive delay exists deliberately, for three stated reasons: recovery if
  internal systems are compromised, recovery from human error, and "room for
  investigation … for audit purposes".

Four conflicts with our obligations, stated plainly:

1. **A 3-year rolling default on biometric captures is far longer than we can
   justify** to a user who asks why we still hold their selfie. Storage
   limitation requires the period be "limited to a strict minimum" with
   "time limits … established by the controller" **[P]**. The vendor's default
   is the vendor's default, not ours, unless we let it become ours.
2. **Erasure is asynchronous and reversible for up to 20 days after we request
   it.** The ICO requires we tell the user what happens to their data, and that
   we put it beyond use **[P]**. A 20-day restorable window is defensible as
   fraud-evidence retention, but it must be **disclosed as such**, and the
   disclosure must distinguish the vendor's copy from ours.
3. **"Training Entrust's fraud prevention models" on our users' biometric data
   is model training on special-category data.** No part of Art. 9(2) covers
   it, and the fraud-prevention legitimate interest in Recital 47 is an Art. 6
   argument that does not reach Art. 9 **[P]**. **This must be switched off in
   the contract, or it is a lawful-basis failure with a third-party processor.**
4. **We hold the evidence, not the vendor.** Entrust's own guidance says the
   customer downloads the Evidence Folder and retains it **[V]**. So the deletion
   obligation is doubled: we must delete our copy, and separately verify the
   vendor has honoured ours. There is no API here that makes that free.

**The procurement requirement that follows**: any IDV contract must specify, in
writing, (a) maximum retention for biometric captures, (b) deletion of the
Archive without a restorable window where we request erasure, (c) an explicit
opt-out of model training on our data, and (d) a contractual right to audit
deletion. None of these are off-the-shelf. Each is a negotiation, which is why
this belongs in the vendor evaluation gate in §7.3 rather than in a later
compliance pass.

### 6.4 Machine unlearning is not a retention strategy

If we do train models, erasure does not stop at deleting the row. "Amnesiac
Machine Learning" states the problem directly: DNNs "are vulnerable to
information leaking attacks such as model inversion attacks which extract class
information from a trained model and membership inference attacks which determine
the presence of an example in a model's training data. If a malicious party can
mount an attack and learn private information that was meant to be removed, then
it implies that the model owner has not properly protected" it **[P]**. The
forgetting-personal-data literature is long-established and unsolved
**[P]**.

The practical reading for us: **if we cannot delete from a model, we should not
have trained on the data.** That argues for training on synthetic or
heavily-aggregated signals, and against ever training on verification artefacts.

### 6.5 Children's data

- UK: the ICO's **Age Appropriate Design Code** is a statutory code of 15
  standards requiring "high privacy" by default unless there is a compelling
  reason otherwise, collection and retention of only the minimum, children's
  data not usually shared, **geolocation services switched off by default**,
  and no nudge techniques to encourage children to hand over unnecessary data
  **[P]**. It applies to services likely to be accessed by children. A dating app
  is unambiguously in scope if under-18s can reach it, which is an argument for
  making 18+ a hard gate rather than a soft one.
  The geolocation-by-default rule is also, incidentally, a precise
  re-statement of our commitment #5.
- Australia: s.63F makes non-age-purposes use of age-assurance data a privacy
  interference **[P]**.
- **[?]** We have no retrieved source on EU children's-data specifics beyond
  GDPR Recital 38 and the DSA's general minor-protection duty.

---

## 7. Metrics

### 7.1 The metric that actually measures harm

Edelson, Kovba, Yershova, Botelho, McCoy and Lauchner (*Journal of Online Trust
and Safety*, 2025) propose **prevented dissemination** as the outcome metric:
model how much engagement a post would accrue, then measure how much of that
*did not* accrue because of a moderation action. On their measurement of
news-provider posts on Facebook across English, Ukrainian and Russian, they
estimate **removals prevented only 24–30% of posts' predicted engagement** **[P]**.

Translated to us: **a removal's value is the engagement it prevented, not the
count of removals.** The dating analogue is concrete: the value of acting on a
fraud profile is the number of matches and conversations it never had, plus the
downstream harm never incurred. Count-of-reports and count-of-removals are
vanity metrics by this standard.

### 7.2 What a human-in-the-loop queue should be measured on

The most useful find for our purposes formalises the architecture we already
have. **"Learning to Defer in Congested Systems: The AI-Human Interplay"**
(Lykouris & Weng, 2024) models exactly our design **[P]**:

- A typical heuristic "estimates the risk of incoming content and uses **fixed
  thresholds** to decide whether to **auto-delete** the content
  (classification) and whether to **send it for human review** (admission)".
- That is criticised because it "disregards the uncertainty in AI's estimation,
  the time-varying element of content arrivals and human review capacity, and
  the selective sampling in the online dataset (**humans only review content
  filtered by the AI**)".
- Their model separates admission from classification, lets human reviewers
  **overturn** erroneous AI decisions, and treats the delayed reviewer labels
  as new training data under queue congestion. They report a near-optimal
  learning algorithm that "can substantially reduce the number of
  misclassifications compared to existing content moderation practice", on
  "online comment datasets".

This is the external validation of 00-overview §2 commitment #2 and ADR 0004.
Three concrete implications:

1. **Admission and classification are different decisions with different
   thresholds.** Our `RiskState` should never be set by the same rule that
   decides what a human looks at. In our terms: what raises `elevated` and what
   opens a case are separate questions and deserve separate parameters.
2. **Reviewer throughput is a first-class constraint on the system, not a
   staffing detail.** If our queue outruns moderator capacity, the paper
   predicts exactly our failure mode: the backlog silently becomes the decision
   policy, and cases nobody looked at age out into a default outcome. **Whatever
   the default is for an un-reviewed case, it must be written down and it must
   be `active`, not `banned`.**
3. **Every reviewer decision is a training signal**, and reviewer overturns are
   the highest-value labels we will ever collect. Instrument the case system to
   capture them as first-class data, not as an exception path.

There is a well-established literature on the failure mode that worries us
most. **"A Case for Humans-in-the-Loop: Decisions in the Presence of Erroneous
Algorithmic Scores"** studies an algorithmic tool assisting child maltreatment
hotline screening, and finds humans "are less likely to adhere to the machine's
recommendation when the score displayed is an incorrect estimate of risk" —
i.e. **over-reliance when wrong** **[P]**. The related selective-prediction
work shows that how you *communicate* a deferral changes human behaviour
**[P]**. Both say the same thing: a moderator shown a scary number is
anchored. Present decomposed evidence (like Entrust's `clear`/`consider` +
per-breakdown scores, §1.4) rather than a single risk figure.

The mirror-image finding is worth recording too: on a 50,000-comment dataset,
LLMs reached "90% accuracy when compared to human verdicts", with the useful
patterns being pre-filtering non-violative content, **detecting potential
errors in human rating**, and surfacing critical context to support human
rating **[P]**. The second pattern is the one we want: automation used to check
the humans, not to replace them.

### 7.3 The metric nobody reports

Gabani (2026) coded **49 operationally relevant sources** on LLM use in fraud
detection, scam investigation and content moderation (18 fraud, 14 moderation,
17 cross-cutting) and reports an "evidence imbalance": **among the 18 fraud and
investigation sources, none report clean per-decision latency, per-decision
dollar cost, or calibration evidence**; most report offline task performance,
retrieval gains, or case-study accuracy instead **[P]**. The paper proposes a
role-and-evidence frame (FORTE) and a **minimum deployment-evidence checklist
covering latency budget, cost per decision, decision threshold, explanation
integrity, and adversarial pressure** **[P]**.

**Adopt the checklist as our vendor-evaluation gate.** If a vendor cannot
produce per-decision latency, per-decision cost, a documented decision
threshold, and an explanation of what the detector's output means to a
moderator, we do not deploy it — no matter what the accuracy slide says.

### 7.4 Proposed metric set, with known pitfalls

| Metric | Definition | Pitfall |
|---|---|---|
| **Detection-before-report rate** | Share of confirmed-harmful cases queued by a detector *before* a user report | Denominator is contested — "confirmed harmful" is only knowable after adjudication, so early numbers are biased toward what the detector found. Report as a *trend*, never a level. Under-reporting is documented and large for sextortion (§3.3), so this metric's denominator is itself biased low. |
| **Detection lift vs. random** | Case yield of detector-queued work ÷ case yield of random work of the same size | Without it, any detector looks good: teams review the most suspicious queue. This is the honest comparison, and it is the one almost nobody computes. |
| **Queue saturation** | Age of the oldest un-reviewed case ÷ target resolution time | This is the control variable the deferral literature says governs everything. If >1, the queue *is* the policy. Report it, and alert on it. |
| **Reviewer overturn rate** | Moderator reversals ÷ decisions, by severity tier | The highest-value number we can collect. Rising = detector drift or miscalibration. Near-zero = rubber-stamping, which is as bad and rarer. |
| **False-positive rate (at the operating threshold)** | Non-harmful actions ÷ all actions taken from detector-queued work | Only measurable through sampled human adjudication, not appeals. Appeals measure *noticed* errors and skew toward the most grievous. |
| **Calibration error** | Gap between predicted probability and observed rate, in bins | The metric that breaks first under adversarial pressure **[P]** and that nobody reports **[P]**. Bin count must be disclosed. |
| **Adversarial robustness** | Metric delta after applying the published evasion class (compression, paraphrase, LLM-guided rewriting) | If you only report the clean number, you are reporting the marketing number. Compression alone materially degrades detectors **[V]**; LLM-guided manipulation degrades bot detectors by up to 29.6% and *harms calibration* **[P]**. |
| **Channel-migration interception rate** | Conversations terminated or flagged at the first attempt to move off-platform ÷ attempts detected | Our scam-specific early-warning metric (§3.2). Content-independent, so it does not decay as the attacker improves their prose. New. |
| **Reports per 1k conversations** | User-initiated reports normalized by conversation volume | Rises with both *harm* and *user education*. A rise after a safety-feature launch is ambiguous. Segment by cohort and by exposure to the feature. |
| **Median moderation resolution time** | Case open → decision | Must be reported **by severity tier**. A single median hides a 4-hour urgent case and a six-week ban appeal. |
| **Prevented engagement** | Modelled engagement that did not occur **[P]** | Model-dependent; publish the model, or the number is unfalsifiable. |
| **Reversal rate and reversal cause** | Decisions overturned ÷ decisions made, by cause | The only FP metric with a denominator we do not control. High means the queue is mis-tuned; zero means appeals are unreachable. Both are failures. |
| **False-reject rate (identity)** | Legitimate users refused verification ÷ verification attempts | Directly harms honest users. **Report it publicly** — the gap between public safety appetite (60%) and user appetite (47%) in §3.1 means hiding it is not a viable long-term position. |
| **Vendor data age at erasure** | Age of retained biometric artefacts when an erasure is executed | Becomes a live metric the moment we integrate an IDV vendor with a multi-year default (§6.2). New. |

**The four pillars, and why reporting one is reporting none:** accuracy is the
most-reported and least informative; **calibration** is the least-reported and
the first to fail under adversarial pressure; per-decision cost and latency are
reported by almost nobody in fraud **[P]**; and **fitness claims transfer badly
across distributions** — published bot-detection performance failed to
reproduce on a representative benchmark **[P]**, and concept drift is the
standing condition of any online classifier. Report all four, or you are
reporting accuracy.

**One dataset caveat that applies to everything above**: IC3 figures are
*reported* losses and are self-selecting. The 2023 report states that when the
FBI infiltrated the Hive ransomware group, "only about 20% of Hive's victims
reported to law enforcement" **[P]**, and the 2025 report makes the same point
for fraud. Under-reporting varies enormously by category — near-total for
sextortion, where shame is the mechanism. **Every prevalence number in §3 is a
floor, not an estimate.**

---

## Implications for Been There

Mapping to [`docs/architecture/00-overview.md`](../architecture/00-overview.md).

**Notation**: `§n.m` means a section of *this* research document. Where a row
cites an architecture commitment by number only — §2.2, §3, §4, §5, §6.1, §6.3,
§7, §9 — it refers to `00-overview.md`.

| # | Finding | Our section | Design decision it forces |
|---|---|---|---|
| 1 | Grooming-risk classifiers are least reliable at the highest risk, and fail on indirect/coded language **[P]** | §2.2, ADR 0004 | Keep automation advisory. **Detector provenance must be on the case record** (§4.3) so the human calibrates rather than guesses. New requirement. |
| 2 | "Learning to Defer" formalises our architecture and shows fixed-threshold admission is the wrong default **[P]** | §2.2, §4, ADR 0004 | **Separate the threshold that raises `RiskState` from the threshold that opens a case.** They are different decisions and need different parameters. New requirement. |
| 3 | Reviewer capacity is a first-class constraint; backlog silently becomes policy **[P]** | §2.2, §4 | **The documented default outcome for an un-reviewed case must be `active`.** If the queue outruns moderators, cases age into whatever we failed to specify. Write it down and alert on queue age. New requirement. |
| 4 | Humans anchor on wrong scores; communication style changes behaviour **[P]** | §2.2, §4, §6.1 | Present decomposed evidence to moderators (vendor's own `clear`/`consider` + per-breakdown pattern), not a single risk number. Same rule for user-facing messaging. New requirement. |
| 5 | Every reviewer overturn is the highest-value training label; LLMs can flag potential *human* rating errors **[P]** | §4, §7 | Instrument the case system to capture overturns as first-class labelled data. Add a standing check for reviewer-rating errors, not only for detector misses. New requirement. |
| 6 | Romance fraud losses rose ~38% in 2025 to $929.3M; IC3 names dating apps as an investment-fraud intake channel **[P]** | §3.2 | **Extend the threat model to investment-fraud staging**, not just the long-con romance script. Any detector scope document that only models "asks for money" is out of date. |
| 7 | AI chat generators have removed linguistic naturalness as a usable signal **[P]** | §2.3, §3.2 | **Do not build a scam detector whose primary feature is text naturalness.** Prioritise durable signals: channel migration, device/graph reuse, off-platform escalation attempts. New priority. |
| 8 | Off-platform migration is the common early step in every documented funnel **[P]** | §3.2, §4 | **Channel-migration interception becomes a first-class safety signal** in the Communication → Trust & Safety path, and a named metric (§7.4). New requirement. |
| 9 | Detectors degrade under trivial transformations; calibration breaks first **[P][V]** | §2.3, §5 | `RiskState` decay must be driven by **calibrated** score movement. Add a calibration field to `RiskContext`; record detector version on every `RiskAssessment`. |
| 10 | GDPR Art. 9 has no legitimate-interest condition; fraud prevention is only an Art. 6 interest **[P]** | §2.4, §6.1 | `sensitive` biometric evidence may **not** be retained on a fraud-prevention LI basis. Add an explicit `retentionBasis`, and a legal-claims-tagged retention class. New requirement. |
| 11 | Erasure is disapplied for "establishment, exercise or defence of legal claims"; the ICO's own example is a near-miss for ours **[P]** | §2.4, §6.2 | A retention schedule that **tags** exempt records rather than merely expiring them, plus a defined refusal path with a one-month written response. New requirement. |
| 12 | IDV vendors retain biometrics up to 3 years by default, and may train fraud models on them **[V]** | §6.3, ADR 0005 | **Contract terms are a v0.1 requirement, not a later compliance pass:** cap retention, require deletion without a restorable window, **opt out of model training**, and secure an audit right. New requirement. |
| 13 | Erasure cannot be fully undone in trained models **[P]** | §6.4 | Never train on verification artefacts. Prefer synthetic or heavily-aggregated training signals. New constraint. |
| 14 | We hit four ICO DPIA triggers simultaneously, one mandatory **[P]** | §2.2, ADR 0005 | A DPIA is a v0.1 delivery artifact. Commission it before the first biometric store. |
| 15 | Australia s.63DB forbids government ID for age compliance; s.63F makes other use a privacy interference **[P]** | §3, §6.5 | **Age assurance must work with no ID at all**, and age data must be **firewalled from every other purpose**. Make it its own sensitivity class and bounded context, not a field on `IdentityRecord`. **The biggest single change this research suggests.** |
| 16 | OSA s.12(5) disapplies the age-verification trigger when ToS prohibits the content class for all users **[P]** | §2.2, §9 | Our ToS must unambiguously prohibit primary-priority content for all users. A legal artifact with architectural consequences; it belongs in a design doc, not a support page. |
| 17 | OSA s.12(8) names algorithms, user access, moderation and staff policy as in-scope design areas **[P]** | §2.1 | Safety-by-design is a UK compliance obligation. The eight commitments in §2 are a floor, not a ceiling. |
| 18 | Redress is statutory (DSA internal complaint + ODS; fees shift to platform on user success) **[S]** | §5, §6.2 | Enforcement must be **reversible by a moderator on a recorded basis**, with the reversal audited. `account_state.changed` needs a documented inverse. New requirement. |
| 19 | Appeals on real platforms have "loopholes … for discrimination, fraud and scams", with costs falling unevenly **[P]** | §4.4 | **Treat appeal submission as untrusted input.** Consider an appeal path that does not require the user to re-engage with the platform they just lost. |
| 20 | Reportability survives unmatch as baseline practice **[P]** | §2.4 | Commitment #4 is correct and will be tested. Make report-after-unmatch a first-class, separately tested path. |
| 21 | Public appetite (60%) for background checks far exceeds user appetite (47%) **[P]** | §2.1, §6 | Friction is paid for by the people we protect. Gate on account creation, not on interaction. Measure false-reject rate publicly. |
| 22 | Vendors split fraud/risk signals from document+biometric verification; their schema has no binary verdict **[V]** | §3, §5 | Corroborates the Identity / Trust & Safety split. Also: **model `RiskState` as a graded scale, not a verdict** — a production vendor does. |
| 23 | Vendor integration is server-authoritative with a replaceable client capture surface **[V]** | §1.3, §5 | Adopt server-side orchestration with a provider-agnostic capture interface, and a hosted-link fallback. Do not let a client SDK or a vendor's no-code workflow be load-bearing. New decision. |
| 24 | The vendor holds templates; the customer holds the evidence folder **[V]** | §6.1, §6.3 | Our `sensitive` classification covers the Evidence Folder **we** store. Deletion is a two-party obligation. |
| 25 | Verification is a time-stamped fact, not a durable property; PAD offers no post-capture protection **[P]** | §3, §5, §9 | Specify the `expired` identity state: validity horizon, re-verification triggers, discoverability on expiry. The largest *unwritten* area in `packages/core/src/states/identity.ts`. |
| 26 | Per-decision latency/cost/calibration are essentially unreported in fraud ML **[P]** | §7.3 | Adopt the FORTE checklist as the vendor gate. If a vendor cannot answer, we do not deploy. |
| 27 | Prevention value is engagement prevented, not actions taken **[P]** | §7.1 | Instrument prevented-engagement as the primary safety outcome. Do not report removal counts as success. |
| 28 | Report UX carries a measurable accessibility cost; users read safety tooling as their own obligation **[P]** | §6.1 | Block and report are accessibility-tested deliverables with named owners. Revisit copy that implies user-side responsibility. |
| 29 | IC3 under-reporting is large and category-dependent (only ~20% of Hive victims reported) **[P]** | §7.4 | **Every prevalence figure in this document is a floor.** Never present one as an estimate, and expect report-rate metrics to be biased low. |

---

## Open questions we could not resolve

1. **Vendor pricing.** No public price sheet exists for this category — it is
   sales-gated, and none of the reachable vendors publish one. The real question
   is not "what does it cost" but "at what volume does a committed-price
   contract beat metered", which needs a quote nobody has requested.
2. **Vendor accuracy and latency claims.** Entrust, Jumio, Socure and Sardine
   publish product and architecture claims but no independent, reproducible
   accuracy or per-decision latency figures were retrievable for any of them.
   Per §7.3, that absence is disqualifying under our own vendor gate. We must
   ask, in writing, and treat a non-answer as a "no".
3. **Ofcom's current age-assurance position.** ofcom.org.uk returned 403 to
   every request, with and without a browser User-Agent. s.12 is the statute and
   we have it; Ofcom's Children's Codes, its statement on "highly effective" age
   assurance, and its July 2025 guidance are all unread. **We should not state a
   UK compliance position until someone has read them directly.**
4. **What "highly effective" means operationally.** OSA s.12(6) demands it
   **[P]**; Ofcom's interpretation is what makes it actionable, and we could not
   read it. The single most consequential unknown in section 2.
5. **The EU position.** DSA text was behind an AWS WAF challenge throughout.
   Art. 28 (protection of minors) and the 2025 Commission guidelines are unread.
   The reported "EU Kids Act" proposal is secondary-source only and was still in
   negotiation as of September 2026.
6. **US statutory text.** Texas HB 1181, the California Digital Age Assurance
   Act, and the *Free Speech Coalition v. Paxton* opinion were all unretrievable.
   Every US claim in this document is secondary and must be verified against the
   primary text before it influences a decision.
7. **FTC primary figures.** ftc.gov and consumer.ftc.gov returned 403. IC3
   primary data **was** obtained and is used throughout §3 and §7; the FTC
   romance-scam series specifically was not, and any FTC number quoted
   elsewhere in our docs should be treated as unverified.
8. **No dating-platform transparency report was retrievable.** Bumble's public
   safety page is descriptive and publishes no rates, SLAs, or FP/FN figures.
   Match Group, Meta and Tinder report hosts were unreachable
   (DNS failure / 400). Whether any of them publish outcome data, and in what
   form, is unknown. If one does, its format is the best available template for
   the §7.4 metric set.
9. **Moderation SLA targets.** No primary source found. We must set our own
   severity-tiered targets and justify them from first principles, not copy.
10. **Evidence retention periods per market.** 00-overview §9 flags this as open
    and this research does not close it. We now have the *legal architecture*
    (storage limitation, the legal-claims exemption, Australia's
    information-must-not-be-collected rules) and a concrete vendor default to
    negotiate against (§6.3), but no jurisdiction-specific period.
11. **Whether age estimation is special-category processing.** Actively
    contested and regulatorily unaddressed **[P]**. Design so the answer does
    not change the architecture: if age estimation *is* Art. 9, our DPIA already
    covers it.
12. **Whether a "slow down" intervention is effective for pig-butchering.** The
    lifecycle structure implies it, and the channel-migration signal (§3.2) is
    the closest thing to a tested interception point we found. We found no study
    of a dating product shipping a deliberate slow-down. Untested.
13. **Whether our `limited` state should compose.** Still open in 00-overview
    §9; this research does not bear on it directly, but the appeal requirement
    (implications row 18) raises the stakes on getting the state machine right.
14. **Whether we can build a usable dating-domain abuse training set.** The
    review of 63 public abusive-language datasets found nothing adequate, and
    dating is a domain where public corpora are worst (§3.6). Cost and feasibility
    unassessed.

---

## Sources

All retrieved 2026-09-25. Grouped by type; **[P]** primary text, **[S]**
secondary, **[V]** vendor or vendor-affiliated.

### Legislation and regulator (primary)
- Regulation (EU) 2016/679 (GDPR), full text — https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32016R0679 **[P]**
- Online Safety Act 2023, s.12 "Safety duties protecting children" — https://www.legislation.gov.uk/ukpga/2023/50/section/12 **[P]**
- Online Safety Amendment (Social Media Minimum Age) Act 2024 (Cth) (No. 127, 2024), full text incl. Part 4A ss.63A–63F — https://www.legislation.gov.au/C2024A00127/asmade/2024-12-10/text/original/epub/OEBPS/document_1/document_1.html **[P]**
- Texas Legislature Online, 89(R) history for HB 1181 (passed House 2025-05-08; received in Senate) — https://capitol.texas.gov/BillLookup/History.aspx?LegSess=89R&Bill=HB1181 **[P]**
- ICO, "When do we need to do a DPIA?" (Art. 35(3)/(4) list) — https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/data-protection-impact-assessments-dpias/when-do-we-need-to-do-a-dpia/ **[P]**
- ICO, "Right to erasure" (Art. 17 and exemptions) — https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/individual-rights/right-to-erasure/ **[P]**
- ICO, "Age appropriate design: a code of practice for online services" — https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/childrens-information/childrens-code-guidance-and-resources/age-appropriate-design-a-code-of-practice-for-online-services/ **[P]**

### Law enforcement and industry measurement (primary)
- **FBI IC3, 2025 IC3 Annual Report** (1,008,597 complaints; $20.877B losses;
   full crime-type tables, three-year comparison, AI-nexus section, sextortion
   section, crypto-investment description, Appendix B definitions) —
  https://www.ic3.gov/AnnualReport/Reports/2025_IC3Report.pdf **[P]**
- FBI IC3, 2023 Internet Crime Report (three-year comparison, recovery rate,
   ~20% Hive reporting rate) —
  https://www.ic3.gov/AnnualReport/Reports/2023_IC3Report.pdf **[P]**
- Pew Research Center, "Key findings about online dating in the U.S."
   (n=6,034, fielded 2022-07-05/17) —
  https://www.pewresearch.org/short-reads/2023/02/02/key-findings-about-online-dating-in-the-u-s/ **[P]**
- Bumble, "What You Need to Know about Safety on Bumble" —
  https://bumble.com/the-buzz/safety **[P]**

### Vendor (primary technical documentation)
- Entrust (formerly Onfido), machine-readable documentation index —
  https://documentation.onfido.com/llms.txt **[V]**
- Entrust, "Facial Similarity reports" (four capture variants, breakdown tree,
   `clear`/`consider` outputs, spoof/face-match scores) —
  https://documentation.onfido.com/guide/facial-similarity-reports.md **[V]**
- Entrust, "Known Faces report" (persistent facial biometric template
   database, consent warning) —
  https://documentation.onfido.com/guide/known-faces-report.md **[V]**
- **Entrust, "Data deletion" (3-year / 1095-day maximum retention, fraud-data
   retention for model training, 20-day deletion delay, Archive rationale) —
  https://documentation.onfido.com/guide/data-deletion.md [V]**
- Entrust, "ETSI certified IDV" (ETSI TS 119 461, EN 319 401, eIDAS; Evidence
   Folder is the customer's responsibility) —
  https://documentation.onfido.com/guide/etsi-certified-idv.md **[V]**
- Socure, "Online Dating Identity Verification for Social Platforms" —
  https://www.socure.com/industries/social-and-dating **[V]**
- Socure, Socure Verify product page —
  https://www.socure.com/products/identity-verification **[V]**
- Socure, Age Assurance use case — https://www.socure.com/use-cases/age-assurance **[V]**
- Jumio homepage (selfie.DONE reusable identity; Biometrics / Risk Signals / AML) — https://www.jumio.com/ **[V]**
- Sardine homepage (agentic financial-crime platform; self-reported Forrester
   Wave Leader) — https://www.sardine.ai/ **[V]**

### Peer-reviewed and preprint research
- Lueks, Dreyer, Federrath, Simon, "Assessing Age Assurance Technologies: Effectiveness, Side-Effects, and Acceptance" — https://arxiv.org/abs/2603.25695
- Ma, Dumaru, Synaepa-Addison, Kropczynski, Wisniewski, "Reconceptualizing Age Assurance as a Sociotechnical Problem" (85 pubs, 2020–2026) — https://arxiv.org/abs/2609.13598
- Marshalkin, "Position: Age Estimation Models Do Not Process Biometric Data" (ICML 2026 position paper) — https://arxiv.org/abs/2605.17347
- Bihani & Rayz, "A Fuzzy Evaluation of Sentence Encoders on Grooming Risk Classification" — https://arxiv.org/abs/2502.12576
- Bihani, Ringenberg & Rayz, "Evaluating Language Models on Grooming Risk Estimation Using Fuzzy Theory" — https://arxiv.org/abs/2502.12563
- Street, Ihianle, Olajide, Lotfi, "Enhanced Online Grooming Detection" (Information Systems and Applications) — https://doi.org/10.1016/j.iswa.2025.200607 (preprint https://arxiv.org/abs/2409.07958)
- An et al., "Revisiting Early Detection of Sexual Predators via Turn-level Optimization" (NAACL 2025) — https://arxiv.org/abs/2503.06627
- Chehbouni et al., "Enhancing Privacy in the Early Detection of Sexual Predators Through Federated Learning and Differential Privacy" (AAAI 2025) — https://arxiv.org/abs/2501.12537
- Bilz, Shepherd, Johnson, "Tainted Love: A Systematic Review of Online Romance Fraud" (PRISMA, 44 included of 232 screened) — https://arxiv.org/abs/2303.00070
- Suarez-Tangil et al., "Automatically Dismantling Online Dating Fraud" — https://arxiv.org/abs/1905.12593
- Acharya & Holz, "An Explorative Study of Pig Butchering Scams" — https://arxiv.org/abs/2412.15423
- Oak & Shafiq, "'Hello, is this Anna?': Unpacking the Lifecycle of Pig-Butchering Scams" (USENIX SOUPS 2025) — https://arxiv.org/abs/2503.20821
- Spokoyny et al., "Victim as a Service: Designing a System for Engaging with Interactive Scammers" (CHATTERBOX) — https://arxiv.org/abs/2510.23927
- Xiao, Xiao & Shen, "'It Felt Real' Victim Perspectives on Platform Design and Longer-Running Scams" — https://arxiv.org/abs/2510.02680
- Meng et al., "'Everyone Says Them': Deception Typologies… Among Gay Dating App Users in China" (CSCW 2026 EA) — https://arxiv.org/abs/2606.27284
- Amirkhani et al., "When Suspicion Becomes Detection" (PACM HCI 2026) — https://arxiv.org/abs/2606.23241
- Fatima, Noah & Das, "Exploring Older Adults' Perceptions and Experiences with Online Dating" (IEEE BuildSEC 2024) — https://arxiv.org/abs/2410.19783
- Zytko & Furlo, "Human-AI Interaction for User Safety in Social Matching Apps" (CHI 2021 AIM workshop) — https://arxiv.org/abs/2204.00691
- Shanker & Zytko, "The Tinderverse?" (CHI 2022 XR workshop) — https://arxiv.org/abs/2203.15120

### Identity, biometrics and deepfakes
- Sarda, "Face Verification Bypass" — https://arxiv.org/abs/2203.15068
- Pirogov & Artemev, "Evaluating Deepfake Detectors in the Wild" (ICML 2025 DataWorld workshop) — https://arxiv.org/abs/2507.21905 **[V — SumSub-affiliated]**
- Rantahalvari, Silvén, Boulkenafet & Álvarez Casado, "Selfie-Capture Dynamics as an Auxiliary Signal Against Deepfakes and Injection Attacks" (CanSelfie) — https://arxiv.org/abs/2605.00218
- Chivata et al., "Deep Data Hiding for ICAO-Compliant Face Images: A Survey" (IJCB 2025) — https://arxiv.org/abs/2508.19324
- Bovo, Loukas & Davis, "Dorsal Hand Images for Privacy-preserving Age Assurance" — https://arxiv.org/abs/2608.21009
- Yuan, "Decentralized Identity and Verifiable Data Sharing based on Zero-Knowledge Proofs" (zk-STARK) — https://arxiv.org/abs/2510.09715
- Garrido, Babel & Sedlmeir, "Towards Verifiable Differentially-Private Polling" — https://arxiv.org/abs/2206.07220
- Condrey, "Privacy-Preserving Proof of Human Authorship via Zero-Knowledge Process Attestation" (ZK-PoP) — https://arxiv.org/abs/2603.00179
- Hogenhout & Wangmo, "Protecting Persona Biometric Data: The Case of Facial Privacy" — https://arxiv.org/abs/2510.03035
- Li et al., "SafeEar: Content Privacy-Preserving Audio Deepfake Detection" (ACM CCS 2024) — https://arxiv.org/abs/2409.09272
- Wu et al., "LOGER: Local–Global Ensemble for Robust Deepfake Detection in the Wild" (NTIRE 2026) — https://arxiv.org/abs/2604.03558
- Le-Phan, Do & Tran, "Robust Deepfake Detection: Mitigating Spatial Attention Drift" (NTIRE 2026) — https://arxiv.org/abs/2604.25889

### Abuse, bots and moderation operations
- Feng et al., "What Does the Bot Say? Opportunities and Risks of LLMs in Social Media Bot Detection" (ACL 2024) — https://arxiv.org/abs/2402.00371
- Feng et al., "TwiBot-20: A Comprehensive Twitter Bot Detection Benchmark" (CIKM 2021) — https://arxiv.org/abs/2106.13088
- Rodič, "Social Media Bot Detection Research: Review of Literature" (534→49 papers) — https://arxiv.org/abs/2503.22838
- Orenstein & Birman, "Breaking and Defending LLM-Powered Social Media Bot Detection Systems" — https://arxiv.org/abs/2608.15893
- Ng, Pan, Yoder & Carley, "FATe of Bots: Ethical Considerations of Social Bot Detection" — https://arxiv.org/abs/2602.05200
- Mane, Kundu & Sharma, "A Survey on Online User Aggression" (ACM Computing Surveys) — https://arxiv.org/abs/2311.09367
- Lu et al., "Context-Aware Detection and Victim-Centered Response Generation for Online Harassment in Private Messaging" — https://arxiv.org/abs/2512.14700
- Hosamane et al., "'I thought it was my mistake, but it's really the design'" (accessibility of user-enacted moderation) — https://arxiv.org/abs/2509.10789
- Zhang et al., "Understanding Community-Level Blocklists in Decentralized Social Media" — https://arxiv.org/abs/2506.05522
- Ranjan, Majumder & Podip, "Single Block On" (cross-platform blocking) — https://arxiv.org/abs/2507.06236

### Human-in-the-loop decision systems
- **Lykouris & Weng, "Learning to Defer in Congested Systems: The AI-Human Interplay" (admission vs classification thresholds, selective-label feedback) — https://arxiv.org/abs/2402.12237**
- **Bogardus et al., "A Case for Humans-in-the-Loop: Decisions in the Presence of Erroneous Algorithmic Scores" (FAccT 2020; over-reliance on wrong scores in hotline screening) — https://doi.org/10.1145/3313831.3376638**
- Mozannar et al., "Role of Human-AI Interaction in Selective Prediction" (AAAI 2022; communication of a deferral changes human behaviour) — https://doi.org/10.1609/aaai.v36i5.20465
- "Supporting Human Raters with the Detection of Harmful Content using Large Language Models" (50k comments, 90% agreement, design patterns incl. detecting human rating errors) — https://arxiv.org/abs/2406.12800
- "Getting Meta: A Multimodal Approach for Detecting Unsafe Conversations within Instagram Direct Messages of Youth" — https://doi.org/10.1145/3579608
- "Understanding the Digital Lives of Youth: … Safe Versus Unsafe Private Conversations on Instagram" — https://doi.org/10.1145/3597502
- "Sliding into My DMs: Detecting Uncomfortable or Unsafe Sexual Risk Experiences… Grounded in the Perspective of Youth" — https://doi.org/10.1145/3580308
- "Diaz-Garcia & Carvalho, "A Literature Review of Textual Cyber Abuse Detection" (WIREs DMKD 2025) — https://doi.org/10.1002/widm.70029
- Sabbagh & Rula, "Directions in Abusive Language Training Data: Garbage In, Garbage Out" (PLOS ONE 2020; review of 63 public datasets) — https://doi.org/10.1371/journal.pone.0243300
- "Handling Bias in Toxic Speech Detection: A Survey" — https://doi.org/10.1007/s10550-023-01539-1
- Gilhuber et al., "Detecting Cross-Geographic Biases in Toxicity Modeling on Social Media" — https://doi.org/10.1145/3442188.3445923
- "‘Dysfunctional’ appeals and failures of algorithmic justice in Instagram and TikTok content moderation" (2024) — https://doi.org/10.1080/1369118x.2024.2396621
- Chancellor et al., "Reconsidering Self-Moderation" (CSCW 2020) — https://doi.org/10.1145/3415178
- Seering et al., "Personalizing Content Moderation on Social Media" (CSCW 2023; n=24) — https://doi.org/10.1145/3610080
- "There's so much responsibility on users right now:" — Expert Advice for Staying Safer From Hate and Harassment — https://doi.org/10.1145/3581784.3607095
- "Doxxing: A Scoping Review and Typology" (2021) — https://doi.org/10.1177/2056305120931507
- Hancock et al., "SoK: Content Moderation for End-to-End Encryption" (PoPETs 2023) — https://doi.org/10.56553/popets-2023-0060
- "Rethinking Safety-by-Design and Techno-Solutionism for the Regulation of CSAM" (2025) — https://doi.org/10.71265/nga7v921
- "How Generative AI Empowers Attackers and Defenders Across the Trust & Safety Landscape" (n=43 T&S experts, 5 domains) — https://doi.org/10.1145/3772318.3791363
- Edelson, Kovba, Yershova, Botelho, McCoy & Lauchner, "Measurement and Metrics for Content Moderation" (*Journal of Online Trust and Safety* 2(5), prevented dissemination) — https://doi.org/10.54501/jots.v2i5.220
- Mane et al., "Toward Better Automated Content Moderation in Low-Resource Languages" (JoTS) — https://doi.org/10.54501/jots.v2i1.150
- "Future Challenges for Online, Crowdsourced Content Moderation: Evidence from Twitter's Community Notes" (JoTS) — https://doi.org/10.54501/jots.v2i1.139
- "Trust and Safety in Social XR" (JoTS 3(2), 2026) — https://doi.org/10.54501/jots.v3i2.290
- "The Three Eras of Content Moderation in the Media and What Comes Next", in *Trust, Safety, and the Internet We Share* (Routledge, 2026) — https://doi.org/10.1201/9781003621072-15
- "The End of Trust and Safety?" (CHI 2025) — https://doi.org/10.1145/3706598.3713662
- "Trust and Safety on Social Media: … Content Moderation and Platform Governance" (*Social Media + Society*, 2023) — https://doi.org/10.1177/20563051231196878
- "A Framework of Severity for Harmful Content Online" (CSCW 2021) — https://doi.org/10.1145/3479512
- "Inequalities and Content Moderation" (2023) — https://doi.org/10.1111/1758-5899.13243
- Blackwell, "Content Moderation Futures" (33 practitioners) — https://arxiv.org/abs/2509.09076
- Gabani, "Operational Evidence Gaps for LLMs in Fraud Detection and Trust-and-Safety Workflows" (49 sources; FORTE; deployment-evidence checklist) — https://arxiv.org/abs/2607.13078
- "Transparency ≠ Accountability? Rethinking Voluntary Vs. Mandatory Content Moderation Reports" (SSRN, 2025) — https://doi.org/10.2139/ssrn.5143075
- "Mandatory Transparency Reporting Regulation for Content Moderation: A Comparative Analysis" (SSRN, 2025) — https://doi.org/10.2139/ssrn.5227491

### Scam typology (peer-reviewed)
- Cross, Cunningham & Childs, "Anatomy of the online dating romance scam" (*Security Journal*, 2013) — https://doi.org/10.1057/sj.2012.57
- "The online dating romance scam: causes and consequences of victimhood" (*Psychology, Crime & Law*, 2013) — https://doi.org/10.1080/1068316x.2013.772180
- Cross, "The Scammers Persuasive Techniques Model" (*British Journal of Criminology*, 2013) — https://doi.org/10.1093/bjc/azt009
- "The online dating romance scam: The psychological impact on victims" (*Criminology & Criminal Justice*, 2015) — https://doi.org/10.1177/1748895815603773
- "A Human-Centered Review of Large Language Models for Online Scam Detection" (SSRN, 2026) — https://doi.org/10.2139/ssrn.6338838
- Bianchetti et al., "Online grooming detection: A comprehensive survey" (*Knowledge-Based Systems*, 2023) — https://doi.org/10.1016/j.knosys.2022.110039
- "Comparing machine learning models with a focus on tone in grooming chat logs" (*Frontiers in Pediatrics*, 2025) — https://doi.org/10.3389/fped.2025.1591828
- Sommerer, "Addressing Demographic Bias in Age Estimation Models through Optimized Dataset Composition" (2024) — https://doi.org/10.3390/math12152358
- Kühne et al., "Age estimation via face images: a survey" (J. Image and Video Processing, 2018; 167 citations) — https://doi.org/10.1186/s13640-018-0278-6

### Dating-specific research
- "Online Dating and Problematic Use: A Systematic Review" (Cyberpsychology 2020) — https://doi.org/10.1007/s11469-020-00318-9
- "Dating apps: a literature review" (European Journal of Cultural Studies, 2022) — https://doi.org/10.1080/23808985.2022.2069046
- Turner, "Who can spot an online romance scam?" (*Journal of Financial Crime*, 2019) — https://doi.org/10.1108/jfc-06-2018-0053
- "Online Romance Scams: Relational Dynamics and Psychological Characteristics of the Victims and Scammers. A Scoping Review" (2020) — https://doi.org/10.2174/1745017902016010024
- Scacco & Muehlenkamp, "Tainted Love: a Systematic Literature Review of Online Romance Scam Research" (*International Review of Cyber Crime*, 2023; peer-reviewed version of the arXiv review) — https://doi.org/10.1093/iwc/iwad048

### Privacy, erasure and biometrics (research)
- "Forgetting personal data and revoking consent under the GDPR: Challenges and proposed solutions" (*Cybersecurity*, 2018; 314 citations) — https://doi.org/10.1093/cybsec/tyy001
- Guo et al., "Amnesiac Machine Learning" (AAAI 2021; model inversion and membership inference against "deleted" data) — https://doi.org/10.1609/aaai.v35i13.17371
- "A Taxonomy of Challenges for Self-Sovereign Identity Systems" (2024) — https://doi.org/10.1016/j.jiec.2024.101725
- Bisztray, Gruschka, Bourlai & Fritsch, "Emerging Biometric Modalities and their Use: Loopholes in the Terminology of the GDPR" (BIOSIG 2021) — https://arxiv.org/abs/2211.12899

### Secondary / encyclopaedic (used as pointers, never load-bearing)
- Wikipedia, "Online Safety Act 2023" — https://en.wikipedia.org/wiki/Online_Safety_Act_2023
- Wikipedia, "Age verification" — https://en.wikipedia.org/wiki/Age_verification
- Wikipedia, "Romance scam" — https://en.wikipedia.org/wiki/Romance_scam
- Wikipedia, "Digital Services Act" — https://en.wikipedia.org/wiki/Digital_Services_Act

### Attempted and unavailable at time of retrieval

Retried with a browser User-Agent where noted. These remain unread, and nothing
in this document depends on them alone:

- ofcom.org.uk — 403, repeatedly, with and without a browser UA
- ftc.gov, consumer.ftc.gov — 403
- esafety.gov.au — timeout
- capitol.texas.gov bill PDFs (SB/HB 1181) — 404
- supremecourt.gov opinion PDFs — 404
- eur-lex DSA (CELEX 32022R2065), all URL forms — AWS WAF challenge
- withpersona.com — 403/404
- veriff.com — 404
- trustable.ca — timeout
- matchgroup.com — DNS failure
- transparency.meta.com — HTTP 400
- transparency.tinder.com — connection failed
- about.fb.com Community Standards Enforcement Report — 404
