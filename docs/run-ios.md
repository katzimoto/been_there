# Running the iOS app

> Written 2026-10-03, updated 2026-10-04. The iOS app exists: `client/BeenThereIos`
> is a real SwiftUI app shell over the shared `BeenThereViews` package, generated
> into an Xcode project by `xcodegen`. The simulator path is proven end to end;
> the physical-iPhone path needs one interactive signing step that only you can
> do, and — with the LAN forwarder below — a reachable service.

## What runs where

| Destination | Status | What it needs |
|---|---|---|
| **iPhone 18 Pro simulator** | ✅ proven — app launches, reads readiness, signs an account up over the real service | the demo service on `127.0.0.1:8787` |
| **Physical iPhone** | one step away — Developer Mode and signing are done, the service is not yet reachable | your Apple ID, once, in Xcode (free Personal Team), and the LAN forwarder below |

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

Three things stand between you and the app running on the phone. The first two
are one-time setup on the phone or in Xcode; the third — reaching the service
from the phone — is a process you start before each session and stop after it.

### 1. Developer Mode

iOS refuses to run a development build on a device that is not in Developer
Mode. On this phone it is **already on**, verified:

```bash
xcrun devicectl list devices
```

On a different phone, Xcode offers to turn it on the first time you attach and
run — accept it on the phone (**Settings → Privacy & Security → Developer
Mode**, then confirm and reboot). If the toggle is absent, Developer Mode is
already enabled.

### 2. A signing identity, and trusting its certificate

The phone is paired. What is missing on the machine is a **signing identity** —
it has `0 valid identities`. A physical device refuses to run an app that is not
signed, and minting that identity requires your Apple ID interactively
(two-factor, terms). It cannot be done from the shell.

One time, in Xcode (already open at the project):

1. Select the **BeenThereIos** target → **Signing & Capabilities**.
2. Tick **Automatically manage signing**, choose your **Personal Team**
   (sign into Xcode → Settings → Accounts if it is not there yet).
3. With the **iPhone** selected as the destination, press **Cmd+R**.
4. **Trust the developer certificate**, on the phone: **Settings → General →
   VPN & Device Management**, then the entry for your Apple ID → **Trust**.
   Until that is tapped the app installs and then refuses to launch. Do this
   once per certificate; a re-signed app from a free Personal Team needs it
   again.

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

Developer Mode and signing are what make the app launch. This is what makes it
connect — the last thing between you and the app running on the phone.

A physical iPhone cannot reach the Mac's `127.0.0.1` — on the phone, that
address means the phone. Two things have to be true before the app can connect:
the phone must be given the Mac's **LAN address**, and something must be
listening on that address, because the demo service binds `127.0.0.1` and
nothing else.

**1. Start the service** (skip if `make demo` is already up):

```bash
make demo          # serving http://127.0.0.1:8787
```

**2. Start the LAN forwarder**, in a second terminal:

```bash
node scripts/dev/lan-forward.mjs
```

It prints the address to type, so nothing has to be worked out by hand:

```text
[lan-forward] listening on http://172.20.10.10:8787
[lan-forward] forwarding to http://127.0.0.1:8787
[lan-forward]
[lan-forward]   Service field on the iPhone:
[lan-forward]
[lan-forward]     http://172.20.10.10:8787
[lan-forward]
[lan-forward]   check it from this Mac:  curl -s http://172.20.10.10:8787/v1/health/ready
[lan-forward]   stop it:               Ctrl-C here
```

…so the Service field reads `http://172.20.10.10:8787`. Check it from the Mac
before touching the phone — a `200` here means the forwarder and the service
are both good, and anything left to diagnose is between the phone and this
machine:

```bash
curl -s http://172.20.10.10:8787/v1/health/ready
```

**3. Stop the forwarder** with **Ctrl-C** in its terminal. It registers no
firewall rule, writes no file and holds no other port, so stopping it leaves
the Mac exactly as it was. Then `make demo-stop`.

#### What the forwarder is, and what it costs

`scripts/dev/lan-forward.mjs` is a Node script with no dependencies beyond the
standard library. It listens on **one address** — the Mac's LAN address, never
`0.0.0.0` — and forwards every request to `127.0.0.1:8787`. It exists because
the alternatives are all worse here: `socat` is not installed, and a `pfctl`
redirect needs `sudo` and leaves a rule behind after the process exits. Editing
the service's bind address is not an option at all: the loopback bind is a
deliberate safety default in `packages/service/src/http/server.ts` and is not
changed for a demo.

**While it runs, the demo service is reachable by anything else on this
network**, over plain HTTP, with no authentication in front of it. The risk is
the seeded development data and whatever you enter into the app on your phone —
not a real account, because there is no real account here. It is a development
service with a stub verification provider. Run it while you are using the phone,
stop it when you are done, and do not run it on an untrusted network (a hotel
or café Wi-Fi). Binding `0.0.0.0` would widen this to every interface the Mac
has including VPNs and virtual networks, so the script refuses it and refuses a
loopback address too.

Options, when the defaults do not fit:

```bash
node scripts/dev/lan-forward.mjs --address 192.168.1.20   # a specific address
node scripts/dev/lan-forward.mjs --interface en1          # a different interface
node scripts/dev/lan-forward.mjs --port 8899 --target-port 8899   # a demo on another port
node scripts/dev/lan-forward.mjs --help
```

It refuses to start when nothing is listening on the target port, so a
forwarder that would answer `502` for everything never comes up.

#### If the phone still cannot connect

Two things make the plain-HTTP connection work at all: the app's ATS exception
(`NSAllowsLocalNetworking`) permits plain HTTP on the local network, and the
forwarder has to be running.

- **Nothing listening**: the phone was connected before the forwarder started —
  reopen the connection screen so the app re-probes.
- **Local Network permission**: iOS asks on first use and denies silently
  afterwards. Check **Settings → Privacy & Security → Local Network** for
  BeenThereIos.
- **Not the same network**: the phone on cellular, or a different Wi-Fi, cannot
  see `172.20.10.10` at all. Both must be on the same network, and a guest Wi-Fi
  with client isolation blocks it even then.

## What the app shows

The connection screen's own text is the contract: *"Everything below is read
from it; nothing on this screen is invented."* Sign-up enforces the same age
gate the service does (a `422` with `not_eligible` for an under-18 date of
birth), verification is the stub provider the service reports at
`/v1/health/ready`, and the tabs that appear are exactly the ones your
account's standing can serve.
