// swift-tools-version:6.0
import PackageDescription

// The view layer, as its own package, for one reason: the iOS app is going to
// consume exactly these files and nothing here may depend on the platform it
// happens to be built for today. `platforms` therefore lists both, and the
// package has no AppKit, no UIKit and no `#if os(...)` in any source file — a
// grep for `AppKit` in `Sources/` is a check that can be run rather than a
// convention that can drift.
//
// The app shell that runs these views on macOS lives in `../BeenThereMac` and
// depends on this package, so nothing here knows an application exists.
let package = Package(
    name: "BeenThereViews",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "BeenThereViews", targets: ["BeenThereViews"])
    ],
    dependencies: [
        // The same client the tests already cover, consumed unchanged. The views
        // hold no networking of their own.
        .package(path: "../BeenThereKit")
    ],
    targets: [
        .target(name: "BeenThereViews", dependencies: [.product(name: "BeenThereKit", package: "BeenThereKit")]),
        // No test target yet: there are no tests to put in one, and a target
        // with no directory defaults to the whole package and fails with
        // "overlapping sources". Declared when there is something to declare.
    ]
)