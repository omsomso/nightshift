// swift-tools-version: 6.0
import PackageDescription

// The Nightshift macOS app: a window and menu-bar view over the Nightshift CLI.
let package = Package(
    name: "NightshiftApp",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "Nightshift",
            path: "Sources/Nightshift",
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)
