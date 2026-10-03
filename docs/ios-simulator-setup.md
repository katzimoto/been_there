# Running the iOS app, and the macOS app you can run today

> **Two corrections, and the second one matters more.**
>
> An earlier version said the client had no views because no iOS simulator
> runtime was installed. That was the wrong conclusion from a true premise, and
> it held up a UI layer that was buildable the whole time. The specific error:
> **macOS needs no simulator runtime.** A macOS destination builds, tests and
> launches on a machine with zero runtimes installed, because the platform you
> build for is the platform you run on.
>
> **Xcode 27.0 (27A266a) is now installed**, with the iOS 27.0 runtime and eleven
> available simulators — five iPhones (18 Pro, 18 Pro Max, 17e, Air, 17) and six
> iPads. (An earlier version of this file said three; `xcrun simctl list devices
> available` reports five iPhones. The count was taken when the runtime was
> first installed and not re-read.) So the
> item below marked blocked is no longer blocked. Everything stated about
> *why* it was blocked — the runtime being a separate ~7 GB download, and
> `runFirstLaunch` needing `sudo` — was accurate when written, and the honest
> lesson is that "needs sudo" was read as "not possible" for far too long.

## What is blocked and what is not

| Target | Status |
|---|---|
| **macOS SwiftUI app** | ✅ **available now** — builds, tests, launches, no runtime needed |
| **Mac Catalyst / iPad** | ✅ available, but buys nothing (see below) |
| **Compiling for `iphonesimulator`** | ✅ already proven — `make client-ios` compiles against the iOS SDK that ships inside Xcode |
| **Launching on an iOS simulator** | ✅ **now possible** — Xcode 27.0 with the iOS 27.0 runtime; `xcrun simctl list devices available` reports 11 devices, 5 of them iPhones |

The macOS evidence, verified when no runtime was present at all:
`MacOSX.platform` carries `SwiftUI.framework`, `AppKit.framework` and an
explicit `maccatalyst` variant, and
`client/BeenThereKit/.build/debug/.../BeenThereKitTests.xctest/Contents/MacOS/`
holds a macOS test binary that was built and run with zero runtimes installed.
Xcode's release notes tie the preview fallback to the **iOS** destination
specifically, which is why macOS was available and iOS was not. That asymmetry
is no longer in effect: `xcrun simctl list devices available` now reports iOS
27.0 simulators, so the iOS destination is a first-class target rather than a
fallback.

## macOS-first, sharing the views — this is built

`BeenThereKit` declares `platforms: [.iOS(.v17), .macOS(.v14)]` and imports only
Foundation — nothing UIKit — so a macOS app consumes it unchanged. Steps 1 and 2
of the plan below are **done**; only the iOS app is outstanding.

1. A **shared view target**, `client/BeenThereViews`, holding the SwiftUI views
   written against a fixed iPhone-width frame (`.frame(width: 390)`) so a layout
   tuned on macOS does not look wrong on a phone.
2. A **macOS app target**, `client/BeenThereMac`, that runs them against the live
   service. `swift build` in that directory completes.
3. The **iOS app** later consumes the same view target. Nothing is thrown away:
   the view layer and the network client are all things the iOS app needs
   anyway, and the platform-conditional text-entry modifiers are already fenced
   with `#if os(iOS)` for that move.

**Skip Mac Catalyst.** It would let iOS view code run on macOS, but it
introduces UIKit, which `BeenThereKit` deliberately avoids.

## Why not a web UI, and not Figma

A web UI would need new static-file serving (the service sets
`content-type: application/json` on every response), a bundler, a component
library, and **a second implementation of every client rule in TypeScript**. For a
product whose thesis is that the client must never offer an action the server
refuses, two client rule-implementations is precisely the failure to avoid.

Figma is good at visual design and bad at being the source of truth for a
codebase whose design lives in code and whose safety rules must be tested. The
useful part — shared design tokens for spacing, colour and type — can be derived
from the code rather than being authored twice and reconciled by hand.

## When you do want the iOS simulator

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
sudo xcodebuild -runFirstLaunch
xcodebuild -downloadPlatform iOS
```

Without the middle step, `xcodebuild` fails with *"failed to load a required
plug-in"*, which looks like a broken install rather than a skipped one.

## What the client gate covers

Every rule mirrors `packages/core`, and each has a test:

- discovery is offered only to a `verified` account;
- `report` and `block` survive **every** account state;
- a banned account can still reach delete-account and its own profile, or it is
  stranded — sanctioned, unappealable, unable to leave;
- messaging is **symmetric**: a restricted counterpart disables the composer here;
- a block outranks a restriction and discloses nothing;
- a restriction explains itself, because a user who cannot see why cannot
  contest it.

The point of the gate is that the server is the authority, so the client must not
offer an action the server will refuse.