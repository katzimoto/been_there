// swift-tools-version:6.0
import PackageDescription

// The iOS app shell.
//
// It contains no product logic, for the same reason `../BeenThereMac` does: an
// `@main` `App`, the scenes, and nothing else. Every screen the app shows is
// `../BeenThereViews`, consumed unchanged and compiled from one copy of the
// files. If a screen ever has to differ between the phone and the Mac, the
// difference goes in that package behind `#if os(iOS)` — a second copy of a
// screen here would be the exact defect this repository keeps paying for, and
// `SignInScreen.field` already shows the pattern working.
//
// `platforms` is iOS alone, for the same reason `BeenThereMac`'s is macOS alone:
// nothing here is reusable, and declaring both platforms is how a `UIKit` import
// gets in by accident.
let package = Package(
    name: "BeenThereIOS",
    platforms: [.iOS(.v17)],
    dependencies: [
        .package(path: "../BeenThereViews")
    ],
    targets: [
        .executableTarget(
            name: "BeenThereIOS",
            dependencies: [.product(name: "BeenThereViews", package: "BeenThereViews")]
        )
    ]
)
