// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "BeenThereKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "BeenThereKit", targets: ["BeenThereKit"])
    ],
    targets: [
        .target(name: "BeenThereKit"),
        .testTarget(name: "BeenThereKitTests", dependencies: ["BeenThereKit"])
    ]
)
