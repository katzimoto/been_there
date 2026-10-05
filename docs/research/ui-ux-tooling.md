# UI/UX tooling for a SwiftUI dating app

> A survey of design skills, plugins, MCP servers and tooling that could
> genuinely improve `client/BeenThereViews`. Every URL was read (not a search
> snippet) on **2026-10-05**. Claims are tagged **[P]** primary — the project's
> own README, spec or official documentation; **[V]** vendor claim, not
> independently replicated; **[?]** thin or unverifiable.
>
> The house design system — `Palette.swift`, `DesignSystem.swift`,
> `Components.swift`, `Feedback.swift`, `Accessibility.swift`, `Motion.swift` —
> is the incumbent and is judged good throughout. Nothing below proposes
> replacing it without naming the cost.

## Ranked, by expected value

1. **`sankalpaacharya/apple-human-interface-skills`** — Apple's HIG distilled
   into 65 short routing skills plus a token playbook. **Adopt selectively**, as a
   read-only design reference at user scope, not vendored into this repo: it has
   no licence file and credits the content to Apple. Its
   `references/foundations/color.md` says *"supply light and dark variants, and
   an increased contrast option for each variant"* **[P]** — which is the one
   substantive gap this survey found in our own palette.
2. **Xcode Accessibility Inspector** (ships with Xcode, already installed) — the
   only tool here that measures *rendered* contrast and the real accessibility
   tree. Zero install cost.
3. **`lightscape-jm/swiftui-hig-audit`** — 22 rule files, MIT, iOS 15+/macOS 14+
   (matching `Package.swift` exactly). Worth reading the *rules* as a checklist
   to steal; **not** wiring `/hig-fix`, which is a batch-edit agent and this repo
   does not want unattended multi-file rewrites.
4. **`kevinswint/xcode-studio-mcp`** — MIT, single Swift binary;
   `simulator_screenshot` and `xcode_build` need nothing external.
   `simulator_describe` (the real a11y tree) depends on Meta's **archived**
   `idb`.
5. **A ~60-line contrast script in `scripts/dev/`** — highest value per line of
   effort. Reimplements the six-line WCAG 2.1 formula from the spec rather than
   vendoring it (see the licence trap below).

## Candidate table

| Name | What it does | SwiftUI fit | Licence | Last activity | Verdict |
|---|---|---|---|---|---|
| [`apple-human-interface-skills`](https://github.com/sankalpaacharya/apple-human-interface-skills) | Scrapes ~172 HIG pages to Markdown + 65 topic files + a design playbook | Excellent — HIG *is* the spec; framework-neutral prose | **No licence file** **[?]** | Scraped June 2026; 5 stars | Adopt as reference only |
| [`swiftui-hig-audit`](https://github.com/lightscape-jm/swiftui-hig-audit) | 22 rule files, `/hig-audit` + `/hig-fix`. Self-reports 0% catch on runtime/visual, ~30–40% overall **[V]** | Good — iOS 15+/macOS 14+ | MIT **[P]** | New; 2 stars | Read the rules, skip the commands |
| [`anthropics/skills` → `frontend-design`](https://github.com/anthropics/skills/tree/main/skills/frontend-design) | Anti-templating brief naming five "AI design tells" | Partial — everything after the tells is CSS | Source-available **[P]** | High cadence | Adopt the tells and the copy rules |
| [`anthropics/skills` → `brand-guidelines`](https://github.com/anthropics/skills/tree/main/skills/brand-guidelines) | Applies *Anthropic's* brand (`#141413`/`#faf9f5`, Poppins/Lora, `#d97757`) | None — it is another company's brand | Source-available **[P]** | — | **Trap** |
| [Figma MCP](https://developers.figma.com/docs/figma-mcp-server/) | ~17 read + 11 write tools; `get_design_context` defaults to React/Tailwind, iOS only on prompt **[P]** | Only if design lives in Figma | Proprietary; non-Dev seats capped at 6 calls/month **[P]** | Active | Defer |
| [`xcode-studio-mcp`](https://github.com/kevinswint/xcode-studio-mcp) | 6 tools incl. `simulator_screenshot`, `simulator_describe` | Excellent | MIT **[P]** | v0.1 | Adopt screenshot + build |
| [Accessibility Inspector](https://developer.apple.com/documentation/accessibility/accessibility-inspector) | Audits a **running** app: contrast, descriptions, audit report | Excellent | Free with Xcode | Ships with toolchain | **Adopt now** |
| [`swift-snapshot-testing`](https://github.com/pointfreeco/swift-snapshot-testing) | SwiftUI + accessibility snapshot tests | Good | MIT **[P]** | Very active | Later, once screens settle |
| [Style Dictionary](https://github.com/amzn/style-dictionary) | JSON tokens → per-platform code | **Weak** — README shows SCSS/Android/ObjC, no Swift **[P]** | Check | Mature | Rejected |
| [`theme-kit`](https://github.com/rozd/theme-kit) | SwiftUI token codegen with `colorSchemeContrast` resolvers | Technically excellent, needs **Swift 6.2** (we are 6.0) | MIT **[P]** | 42 stars | Rejected — it would replace a better artifact |
| [`ios-design-system`](https://github.com/ersandip94/ios-design-system) | `@Entry` theming, a custom SwiftLint a11y rule as a CI step | Needs iOS 18 (we target 17) | Apache-2.0 **[P]** | New | Rejected; steal the lint *pattern* |
| [`ui-ux-pro-max-cli`](https://www.npmjs.com/package/ui-ux-pro-max-cli) | BM25 search over 15 CSVs incl. a 50-row `swiftui.csv` | Already installed and used | **CC-BY-NC-4.0** **[P]** | Data generated 2026-08-13 | Keep for research; **never ship its data** |

## Can `ui-ux-pro-max`'s catalogues be queried programmatically?

**Retrieval — yes, and there is a SwiftUI-specific catalogue.** Its
`assets/scripts/search.py` is BM25 over CSVs with `--json` output, and
`core.py` maps `"swiftui"` to `stacks/swiftui.csv` **[P]**. That file has 50 rows
with `Guideline / Do / Don't / Code Good / Code Bad / Severity / Docs URL`
columns, verified 2026-08-13 **[P]** — including "Respect reduced motion"
(High), "Support Dynamic Type" (High), and a 500-line-view anti-pattern that
coincides with `AGENTS.md`'s own rule.

```bash
python3 ~/.nvm/versions/node/v24.19.0/lib/node_modules/ui-ux-pro-max-cli/assets/scripts/search.py \
  "accessibility dynamic type contrast reduce motion" \
  --stack swiftui --max-results 10 --json
```

**Contrast maths — already implemented there, but do not copy it.**
`validate_data.py` has a correct WCAG 2.1 `_relative_luminance` /
`contrast_ratio` **[P]**. It is internal to a **CC-BY-NC** package, so vendoring
it here would carry a non-commercial licence into the repo. The formula is six
lines and the spec is public: reimplement it.

**Token generation — no, and this is the load-bearing negative finding.**
`design_system.py` has no stack awareness at all (no match for
`Tailwind|React|--stack` **[P]**); its `--design-system` mode writes a
web-page-shaped `design-system/<slug>/MASTER.md`, and its motion dial attaches a
**GSAP** snippet **[P]**. It can *tell an agent what Apple's rules say*; it must
never write into this repository. Never pass `--design-system --persist` here.

## Traps

- **`ui-ux-pro-max-cli` is CC-BY-NC-4.0** **[P]**. Fine as internal research;
  no derived value belongs in the shipped app or its committed tokens. It is
  installed globally, which makes it one `uipro init` away from writing web
  advice into the repo root.
- **`brand-guidelines` is Anthropic's brand, not a design system.** Its
  `#faf9f5` is within two hex steps of this app's `canvas: 0xFAF7F5`; installing
  it would have an agent confidently restyle our palette into another company's.
- **Style Dictionary and ThemeKit replace rather than augment**, and both would
  move the tokens out of the Swift file into a second source of truth.
  `AGENTS.md` says "prefer editing to creating"; codegen is the opposite.
- **`swiftui-hig-audit` is 2 stars and its install instructions contain an
  unfilled `yourusername` placeholder** **[P]** — read it; do not depend on it.
- **`idb` is archived.** Plan for screenshot/build tools only.
- **Figma MCP is a seat cost**, and six calls a month is not a workflow.
- **Our own palette has no increased-contrast variant.** Apple's guidance says
  every custom colour needs one **[P]**; nothing in `Palette.swift` answers
  "what does this app look like with Increase Contrast on?". This is the one
  real gap the survey found in the existing design system.

## What this survey did not find

- **No SwiftUI-native design MCP.** Every design MCP targets Figma files or web
  pages; the axe-core family audits DOM, and a SwiftUI view tree is not DOM.
- **No maintained SwiftUI design-token validator.** The closest is the SwiftLint
  a11y rule inside a package we cannot depend on — the pattern, not the package.
- **No standalone SwiftUI contrast linter.** Which is why the recommendation is
  sixty lines rather than a dependency.

## Sources

- Agent Skills spec — https://agentskills.io/specification **[P]**
- `anthropics/skills` README and `frontend-design` **[P]**
- Claude plugin marketplaces — https://code.claude.com/docs/en/plugin-marketplaces **[P]**
- `apple-human-interface-skills` — https://github.com/sankalpaacharya/apple-human-interface-skills **[P]**
- `swiftui-hig-audit` — https://github.com/lightscape-jm/swiftui-hig-audit **[P]**
- Figma MCP tools and seat limits — https://developers.figma.com/docs/figma-mcp-server/ **[P]**
- `xcode-studio-mcp` — https://github.com/kevinswint/xcode-studio-mcp **[P]**
- Accessibility Inspector — https://developer.apple.com/documentation/accessibility/accessibility-inspector **[P]**
- Enhancing SwiftUI accessibility — https://developer.apple.com/documentation/accessibility/enhancing-the-accessibility-of-your-swiftui-app **[P]**
- `swift-snapshot-testing` — https://github.com/pointfreeco/swift-snapshot-testing **[P]**
- Style Dictionary README — https://github.com/amzn/style-dictionary/blob/main/README.md **[P]**
- `theme-kit` — https://github.com/rozd/theme-kit **[P]**
- `ios-design-system` — https://github.com/ersandip94/ios-design-system **[P]**
- `a11y-color-contrast-mcp` — https://github.com/ryelle/a11y-color-contrast-mcp **[P]**
- WCAG 2.1 contrast minimum — https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html **[P]**
- Installed CLI internals (`README.md`, `assets/scripts/{search,core,design_system,validate_data}.py`,
  `assets/data/stacks/swiftui.csv`, `assets/data/data-provenance.json`) **[P]**
- This repository: `AGENTS.md`, `client/BeenThereViews/Package.swift`,
  `Palette.swift`, `Accessibility.swift` **[P]**