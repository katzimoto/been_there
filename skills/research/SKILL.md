---
name: research
description: Evidence-backed external research in this repository, where the built-in web search is blocked. Use before asserting any external fact — verification vendor accuracy, regulatory requirements, safety research, detection rates, or industry practice.
---

# Research in this repository

## The built-in web search does not work here

`web_search` fails in this environment: all five providers (Startpage,
DuckDuckGo, Ecosia, Google, Mojeek) block datacenter egress IPs, and driving a
real Chromium hits a bot challenge. Do not spend turns on it. Use the sources
below instead.

## Use the search tool in this repo

`scripts/research/search.mjs` needs no credentials:

```bash
node scripts/research/search.mjs papers "online dating deception detection" --limit 10
node scripts/research/search.mjs cited  "child grooming detection" --min-citations 20
node scripts/research/search.mjs cited  "dating app safety" --year 2024
node scripts/research/search.mjs arxiv  "online safety classifier"
node scripts/research/search.mjs news   "trust and safety staffing"     # practitioner experience
node scripts/research/search.mjs fetch  "https://openalex.org/W2757209552"
```

- `papers` — OpenAlex, full-text search, topical precision. Default choice.
- `cited` — sorted by citation count. **Use for establishing that a finding is
  well-established, not for finding it.** It returns topically loose hits; a
  "romance scam" query surfaced a marketing paper that merely mentions it.
  Sanity-check every hit before citing.
- `arxiv` — preprints. Good for detection methods and evaluation results.
- `news` — Hacker News. Practitioner experience and tooling opinions.
- `fetch` — full record including abstract and references. Every id printed by a
  search command can be fed straight back in.

## Primary sources, read directly

For regulator texts, enforcement decisions, vendor technical docs, and platform
transparency reports, skip search and read the URL:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/
```

`read <url>` works too. Targets: ICO and CNIL guidance and enforcement
registers, the EU Digital Services Act and AVMSD, Australian eSafety
age-restricted rules, platform transparency reports, vendor technical docs.

## Evidence rules

1. **Every non-obvious claim carries a source URL and the retrieval date.**
2. **Tag the class of source**: primary (regulation, papers, vendor docs),
   vendor claim (marketing — mark it as such), secondary (press — use only as a
   pointer, never load-bearing), thin or contested (mark it and say so).
3. **A claim you could not verify says so.** An honest gap beats a confident
   unsourced assertion, but a document that is thin because you stopped searching
   is not an acceptable deliverable.
4. **Vendor accuracy and latency figures are vendor claims.** Always.
5. **A finding that changes the design goes in an "Implications" section**
   mapped to the specific section of `docs/architecture/00-overview.md` it
   affects, not left in the research file as an observation.

## What to search for this product

`docs/research/trust-safety-reference-research.md` already covers identity
verification and age assurance, safety signals, moderation operations, privacy
law, and metrics — check it before re-researching, and extend it rather than
writing a parallel document.
