import SwiftUI

/// The colour system, as two complete schemes rather than as fixed constants.
///
/// ## Why this is injected and not a static enum
///
/// Every colour here has a light and a dark value, and `Ink.canvas` as a
/// `static let` cannot answer "which one" — a fixed colour is a fixed colour on
/// both platforms, which is why the first version of this view layer had no dark
/// mode at all: the tokens were literals. The fix without breaking the package's
/// no-UIKit/no-AppKit rule is to carry the values as data and let SwiftUI decide.
///
/// So the palette is a `Sendable` value with light and dark instances, the
/// environment carries the current one, and `RootScreen` — which can read
/// `colorScheme` without importing a platform framework — puts it there. A view
/// reads `@Environment(\.palette)`, and there is no branch in any view file for
/// "are we dark".
///
/// ## Why the palette is warm
///
/// The product's claim is that it is safe by construction and reads calm rather
/// than alarmed. A neutral grey scale and a single saturated accent do that;
/// alarm-red used for anything decorative would not, which is why the reds here
/// are reserved for what the *server* declared (`restricted`) and the amber is
/// reserved for a step that is waiting on a person.
public struct Palette: Sendable, Equatable {

    // Surfaces, back to front.
    public let canvas: Color
    public let surface: Color
    public let surfaceRaised: Color
    /// Photos and other imagery that does not exist are drawn on this.
    public let placeholder: Color

    // Text, strongest to weakest.
    public let ink: Color
    public let inkSecondary: Color
    public let inkTertiary: Color
    public let onAccent: Color

    // Lines and fills.
    public let hairline: Color
    public let fill: Color

    /// The brand accent. The one colour that is this product's own rather than
    /// the server's answer, and it is used only where the member is the one
    /// acting: the primary action, the progress they have made, the tab they are
    /// in.
    public let accent: Color
    public let accentSoft: Color
    public let accentInk: Color

    // Server-declared states. Named for what the server said, never for how it
    // looks: a client that coloured a state the server did not declare would be
    // making a claim the server has not made.
    public let granted: Color
    public let grantedSoft: Color
    public let restricted: Color
    public let restrictedSoft: Color
    public let attention: Color
    public let attentionSoft: Color

    public static let light = Palette(
        canvas: Color(hex: 0xFAF7F5),
        surface: Color(hex: 0xFFFFFF),
        surfaceRaised: Color(hex: 0xF3EDE8),
        placeholder: Color(hex: 0xEDE4DC),
        ink: Color(hex: 0x1B1614),
        inkSecondary: Color(hex: 0x6B615B),
        inkTertiary: Color(hex: 0x9A9089),
        onAccent: Color(hex: 0xFFFFFF),
        hairline: Color(hex: 0xE7DED6),
        fill: Color(hex: 0xF6F1EC),
        accent: Color(hex: 0xB03A62),
        accentSoft: Color(hex: 0xFBEDF2),
        accentInk: Color(hex: 0x8C2C4D),
        granted: Color(hex: 0x1F6B4A),
        grantedSoft: Color(hex: 0xE7F3ED),
        restricted: Color(hex: 0xA32020),
        restrictedSoft: Color(hex: 0xFBEBEA),
        attention: Color(hex: 0x8A5A12),
        attentionSoft: Color(hex: 0xFAF1DF)
    )

    public static let dark = Palette(
        canvas: Color(hex: 0x100F0E),
        surface: Color(hex: 0x1B1918),
        surfaceRaised: Color(hex: 0x252220),
        placeholder: Color(hex: 0x2E2A27),
        ink: Color(hex: 0xF6F0EA),
        inkSecondary: Color(hex: 0xB0A69E),
        inkTertiary: Color(hex: 0x7C736C),
        onAccent: Color(hex: 0x1A0F13),
        hairline: Color(hex: 0x322D2A),
        fill: Color(hex: 0x232020),
        accent: Color(hex: 0xE889A8),
        accentSoft: Color(hex: 0x3A2029),
        accentInk: Color(hex: 0xF2AFC6),
        granted: Color(hex: 0x6FCBA0),
        grantedSoft: Color(hex: 0x16301F),
        restricted: Color(hex: 0xE89494),
        restrictedSoft: Color(hex: 0x33191A),
        attention: Color(hex: 0xE0B36A),
        attentionSoft: Color(hex: 0x33260F)
    )

    public static func for(_ scheme: ColorScheme) -> Palette {
        scheme == .dark ? .dark : .light
    }
}

// MARK: - Environment

private struct PaletteKey: EnvironmentKey {
    static let defaultValue = Palette.light
}

extension EnvironmentValues {
    /// The current palette. Light by default so a view rendered outside a
    /// `RootScreen` — a preview, a test — is still legible rather than invisible.
    public var palette: Palette {
        get { self[PaletteKey.self] }
        set { self[PaletteKey.self] = newValue }
    }
}

/// Provides the palette for the current colour scheme, once, at the root.
///
/// Both app shells call this through `RootScreen`, so a view never has to know
/// whether it is on a phone or a Mac.
public struct PaletteProvider<Content: View>: View {
    @Environment(\.colorScheme) private var scheme
    private let content: Content

    public init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    public var body: some View {
        content.environment(\.palette, Palette.for(scheme))
    }
}

// MARK: - Colour literal

extension Color {
    /// `Color(hex: 0xFAF7F5)` — written as a hex literal so a designer and a
    /// developer are reading the same number, and so a scheme can be compared
    /// against its counterpart by reading two lines rather than two structs.
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
}