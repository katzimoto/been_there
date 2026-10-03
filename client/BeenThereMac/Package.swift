// swift-tools-version:6.0
import PackageDescription

// The macOS app shell.
//
// It contains no product logic: an `@main` `App`, a window, and the
// iPhone-width frame the shared views are designed for. Everything a screen
// shows lives in `../BeenThereViews`, which the eventual iOS app consumes
// unchanged — so this target is the only thing that has to be rewritten for a
// phone, and it is eleven lines of it.
//
// `platforms` is macOS alone on purpose. Nothing here is reusable and pretending
// otherwise would be how a `UIKit` import gets in.
let package = Package(
    name: "BeenThereMac",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(path: "../BeenThereViews")
    ],
    targets: [
        .executableTarget(
            name: "BeenThereMac",
            dependencies: [.product(name: "BeenThereViews", package: "BeenThereViews")]
        )
    ]
)