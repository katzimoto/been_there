# Running the iOS app in a simulator

The app is built and its safety gate is tested, but **no iOS simulator runtime is
installed on this machine yet.** That is the one thing standing between the
repository and a runnable iOS build, and it needs two commands that require
`sudo` — so it cannot be done from here.

## What you need to run, in order

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
sudo xcodebuild -runFirstLaunch
xcodebuild -downloadPlatform iOS
```

The first selects the full Xcode over the command-line tools that shipped with
macOS. The second completes Xcode's one-time setup — without it, `xcodebuild`
fails with *"failed to load a required plug-in"*, which is what happens if you
skip straight to the third. The third downloads the simulator runtime, which is
roughly 7 GB and the long pole.

## Then

```bash
make client-test      # 12 Swift tests against the safety gate
make client-ios        # compiles the client for arm64-apple-ios17.0-simulator
```

Both are already wired into `npm run check`, so CI is proving the code compiles
for the simulator today — without needing a runtime on the machine.

To actually launch it in a simulator you would additionally need an app target
and a view layer. There is deliberately no `Package.swift` app product yet: see
"what is not built" below.

## Why the client has no views yet

`client/BeenThereKit` holds the iOS-agnostic core — the safety gate that decides
whether to offer a composer, whether discovery is available, and what a
restriction explains — and it is unit-tested against the same rules the server
enforces. That is the part with logic worth testing, and it is tested.

A SwiftUI layer is deliberately absent. Writing views I could not compile would
have produced the exact "written but unverified" artefact this repository has
spent its time eliminating. With a runtime installed it becomes worth building,
and that is the case for running the commands above.

## What the client gate covers

Every rule here mirrors `packages/core`, and each has a test:

- discovery is offered only to a `verified` account;
- `report` and `block` survive **every** account state, because a client that
  hid "report" behind a restriction would be the worst failure this product has;
- a banned account can still reach delete-account and its own profile, or it is
  stranded — sanctioned, unappealable, unable to leave;
- messaging is **symmetric**: a restricted counterpart disables the composer here,
  because the server refuses it;
- a block outranks a restriction and discloses nothing;
- a restriction explains itself, because a user who cannot see why cannot
  contest it.

The point of the gate is that the server is the authority, so the client must
not offer an action the server will refuse. An affordance that always fails is
worse than a disabled one: it teaches people the app is broken, and it leaks the
existence of a state they are not entitled to know about.