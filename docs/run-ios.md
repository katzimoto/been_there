# Running the iOS app

> Written 2026-10-03. The iOS app exists: `client/BeenThereIos` is a real
> SwiftUI app shell over the shared `BeenThereViews` package, generated into an
> Xcode project by `xcodegen`. The simulator path is proven end to end; the
> physical-iPhone path needs one interactive signing step that only you can do.

## What runs where

| Destination | Status | What it needs |
|---|---|---|
| **iPhone 18 Pro simulator** | ✅ proven — app launches, reads readiness, signs an account up over the real service | the demo service on `127.0.0.1:8787` |
| **Physical iPhone** | one step away | your Apple ID, once, in Xcode (free Personal Team) |

## The service must be running first

```bash
make demo          # deps up, migrated, seeded, serving http://127.0.0.1:8787
make demo-stop     # when you are done
```

The app's connection screen opens with this address pre-filled and probes
`/v1/health/ready` before asking you to sign in, so "ready / database ok" on
that screen means the service behind it answered.

## Simulator (works today)

```bash
cd client/BeenThereIos
xcodegen generate                                   # once, or after editing project.yml
xcodebuild -project BeenThereIos.xcodeproj -scheme BeenThereIos \
  -destination 'platform=iOS Simulator,name=iPhone 18 Pro' build
xcrun simctl install "iPhone 18 Pro" <path to Built Products>/BeenThereIos.app
xcrun simctl launch "iPhone 18 Pro" dev.beenthere.BeenThereIos
```

Or simply open `client/BeenThereIos/BeenThereIos.xcodeproj` in Xcode and press
Cmd+R with an iPhone simulator selected.

On the simulator, `127.0.0.1` **is** the Mac, so the pre-filled address is
already correct — nothing to type.

## Your physical iPhone

The phone is paired and Developer Mode is on (verified: `xcrun devicectl list
devices` shows it). What is missing is a **signing identity** — the machine has
`0 valid identities`. A physical device refuses to run an app that is not
signed, and minting that identity requires your Apple ID interactively
(two-factor, terms). It cannot be done from the shell.

One time, in Xcode (already open at the project):

1. Select the **BeenThereIos** target → **Signing & Capabilities**.
2. Tick **Automatically manage signing**, choose your **Personal Team**
   (sign into Xcode → Settings → Accounts if it is not there yet).
3. With the **iPhone** selected as the destination, press **Cmd+R**.
   First run on the phone: trust the developer certificate under
   **Settings → General → VPN & Device Management**, then launch again.

After that first build the shell can do the rest:

```bash
xcodebuild -project client/BeenThereIos/BeenThereIos.xcodeproj -scheme BeenThereIos \
  -destination 'platform=iOS,id=00008140-00064D012633001C' build
xcrun devicectl device install app --device 00008140-00064D012633001C <Built Products>/BeenThereIos.app
xcrun devicectl device process launch --device 00008140-00064D012633001C dev.beenthere.BeenThereIos
```

Free Personal-Team apps expire after 7 days and must be re-signed by
rebuilding; a paid team removes that.

### The address to type on the phone

A physical iPhone cannot reach the Mac's `127.0.0.1`. Type the Mac's **LAN
address** into the Service field instead — found with:

```bash
ipconfig getifaddr en0        # e.g. 172.20.10.10 — phone and Mac on the same network
```

…so the Service field reads `http://172.20.10.10:8787`. Two things make this
work: the app's ATS exception (`NSAllowsLocalNetworking`) permits plain HTTP on
the local network, and the demo service must be reachable from the phone.

If the phone cannot connect, check macOS **Local Network** permission and that
nothing blocks port 8787. A service bound to `127.0.0.1` only is **not**
reachable from the phone; when that is the case, expose it over the network
rather than editing the service's bind address, e.g. a local port-forward to
the demo process. The bind is a deliberate safety default in
`packages/service/src/http/server.ts` and is not changed for a demo.

## What the app shows

The connection screen's own text is the contract: *"Everything below is read
from it; nothing on this screen is invented."* Sign-up enforces the same age
gate the service does (a `422` with `not_eligible` for an under-18 date of
birth), verification is the stub provider the service reports at
`/v1/health/ready`, and the tabs that appear are exactly the ones your
account's standing can serve.
