// swift-tools-version:6.0
import PackageDescription

// The iOS app shell.
//
// ## Everything a screen shows lives elsewhere
//
// This package is the phone counterpart of `../BeenThereMac`: the `@main`, the
// scene, and nothing else. The views are `BeenThereViews`, which declares both
// `.iOS(.v17)` and `.macOS(.v14)` and contains no AppKit, no UIKit and no
// platform conditionals — so this shell and the Mac one consume the same files
// and neither has to track the other.
//
// ## Why the shell is nearly empty
//
// A phone needs no phone-width frame: the window the Mac draws to fake one is
// the physical screen here. The shell therefore contributes exactly two things
// the views cannot own — the scene itself, and the app's `Info.plist` decisions
// (an App Transport Security exception, because the service a developer runs
// speaks plain HTTP on the local network and the app must be able to name it).
// `.macOS(.v14)` appears here too, though this app never ships on the Mac: a
// package that declares only `.iOS` builds its host-side tooling at the Swift
// default of macOS 12, below what `BeenThereViews` promises. Stating the floor
// keeps `swift build` working on this machine for syntax checks.
let package = Package(
    name: "BeenThereIos",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .executable(name: "BeenThereIos", targets: ["BeenThereIos"])
    ],
    dependencies: [
        .package(path: "../BeenThereViews")
    ],
    targets: [
        .executableTarget(
            name: "BeenThereIos",
            dependencies: [.product(name: "BeenThereViews", package: "BeenThereViews")]
        )
    ]
)
