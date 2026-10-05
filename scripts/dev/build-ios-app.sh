#!/bin/sh
# Builds the iOS app for the simulator and assembles a launchable .app bundle.
#
#   scripts/dev/build-ios-app.sh [output-directory]
#
# ## Why a script and not an Xcode project
#
# `client/BeenThereIOS` is a Swift package like the other three client packages,
# and `swift build --triple arm64-apple-ios17.0-simulator` compiles it — the
# views and `BeenThereKit` with it — for the simulator SDK. What SwiftPM does
# not produce is a bundle: it links a bare Mach-O executable, and the simulator
# will only install a directory called `*.app` carrying an `Info.plist`. That
# assembly is the twenty lines below, and it is the only reason this file
# exists.
#
# No project file, no scheme, no signing identity. `simctl install` accepts an
# unsigned simulator bundle, which is why this runs on a developer machine and
# on a CI runner with nothing configured. A device build is a different thing
# and needs an Apple developer account; nothing here claims otherwise.
#
# The whole client source set is compiled, not one file of it — the glob in the
# old `client-ios` recipe, and the package graph here, both make a new source
# file part of the gate by existing.

set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
PACKAGE="$ROOT/client/BeenThereIOS"
SCRATCH="$PACKAGE/.build/simulator"
APP="$PACKAGE/.build/BeenThereIOS.app"
TRIPLE=arm64-apple-ios17.0-simulator
BUNDLE_ID=app.beenthere.ios

: "${DEVELOPER_DIR:=/Applications/Xcode.app/Contents/Developer}"
export DEVELOPER_DIR

# A `.build` under the package, which `.gitignore` already covers. Not a
# temporary directory: an app bundle the simulator has to install and the next
# command has to find again is not a throwaway.
mkdir -p "$APP"

echo "Building BeenThereIOS for $TRIPLE"
swift build \
  --package-path "$PACKAGE" \
  --scratch-path "$SCRATCH" \
  --triple "$TRIPLE" \
  --configuration release

BINARY="$SCRATCH/release/BeenThereIOS"
if [ ! -x "$BINARY" ]; then
  echo "swift build reported success but $BINARY is not there." >&2
  exit 1
fi

# The executable inside the bundle must carry the bundle's name; a mismatch is
# a launch failure on the device rather than a build failure here, so it is
# written out rather than assumed.
cp "$BINARY" "$APP/BeenThereIOS"

cat > "$APP/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>BeenThereIOS</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Been There</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>MinimumOSVersion</key><string>17.0</string>
  <key>UIDeviceFamily</key><array><integer>1</integer><integer>2</integer></array>
  <!-- The phone layout, not a Mac one: the app's own views declare iPhone idiom. -->
  <key>UIDeviceFamilyName</key><string>iPhone</string>
  <key>UILaunchScreen</key><dict/>
  <key>UIRequiredDeviceCapabilities</key><array><string>arm64</string></array>
  <key>UISupportedInterfaceOrientations</key>
  <array>
    <string>UIInterfaceOrientationPortrait</string>
  </array>
  <!--
    App Transport Security. The app talks to a plain-HTTP service a developer
    started with `make demo` on 127.0.0.1, and ATS refuses cleartext by default.
    The exception is scoped to loopback rather than opened with
    NSAllowsArbitraryLoads: nothing here permits cleartext to a real host, so a
    build of this app pointed at production is refused by the OS rather than
    quietly sending a password over http. The address is typed on screen and
    checked against /v1/health/ready before anything is sent to it.
  -->
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
    <key>NSExceptionDomains</key>
    <dict>
      <key>localhost</key>
      <dict>
        <key>NSExceptionAllowsInsecureHTTPLoads</key><true/>
      </dict>
    </dict>
  </dict>
</dict>
</plist>
PLIST

echo "App bundle: $APP"
