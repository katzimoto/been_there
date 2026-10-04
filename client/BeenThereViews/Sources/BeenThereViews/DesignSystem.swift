import SwiftUI
import BeenThereKit

// MARK: - The phone this is designed for
//
// Every view in this package is written for **one fixed width**: a 390pt iPhone.
// That number is not a preference, it is the constraint that makes the view
// layer shareable. A layout that is allowed to fill whatever window it lands in
// grows a two-column layout on a Mac, and that layout cannot be put back into a
// phone without being rewritten — which is the thing this package exists to
// avoid.
//
// So the width is applied once, here, by `phoneFrame()`, and the screens below
// lay themselves out as though no other width exists. A row that does not fit
// at 390pt does not get a wider window; it is wrong, and the window will show
// the wrapping rather than hide it.

/// The iPhone width this view layer is designed against.
public let phoneWidth: CGFloat = 390

// MARK: - Spacing and shape

/// A four-point scale, declared once, so the iOS app inherits the rhythm rather
/// than a set of hand-tuned numbers from a screenshot.
public enum Space {
    public static let xs: CGFloat = 4
    public static let sm: CGFloat = 8
    public static let md: CGFloat = 16
    public static let lg: CGFloat = 24
    public static let xl: CGFloat = 32
    /// The top gap under a large title, where iOS puts air rather than a rule.
    public static let screen: CGFloat = Space.md
}

public enum Radius {
    public static let card: CGFloat = 20
    public static let field: CGFloat = 14
    public static let chip: CGFloat = 10
    public static let button: CGFloat = 16
    /// The circular action button on a discovery card.
    public static let pill: CGFloat = 28
}

// MARK: - Type
//
// Six steps and no more, because a scale with twenty sizes is a scale nobody
// follows. Display and title are rounded: a dating product that reads
// institutional has already lost the point, and the system font's rounded design
// is the one typeface guaranteed present on both platforms. Values — ids, dates,
// counts — stay monospaced so a number reads as a number.

public enum Typeface {
    public static let display = Font.system(size: 30, weight: .bold, design: .rounded)
    public static let title = Font.system(size: 23, weight: .semibold, design: .rounded)
    public static let headline = Font.system(size: 17, weight: .semibold, design: .rounded)
    public static let body = Font.system(size: 15, weight: .regular)
    public static let callout = Font.system(size: 14, weight: .regular)
    public static let caption = Font.system(size: 12, weight: .medium)
    /// Anything the server published as an identifier or a number.
    public static let mono = Font.system(size: 12, weight: .medium, design: .monospaced)
}

// MARK: - The frame

/// Centres a screen at the phone width and paints the canvas behind it.
///
/// A modifier rather than a wrapper view because the wrapper had to hand its
/// content to another view's `body`, which Swift 6's region isolation rejects
/// for a non-`Sendable` view value. The modifier keeps the content in the same
/// place in the same isolation region, and reads the palette from the
/// environment — which is how the canvas can be a colour rather than a
/// constant, and therefore how dark mode exists at all.
public struct PhoneFrame: ViewModifier {
    @Environment(\.palette) private var palette

    public func body(content: Content) -> some View {
        content
            .frame(width: phoneWidth)
            .frame(maxWidth: .infinity, alignment: .center)
            .background(palette.canvas)
    }
}

public extension View {
    /// Lays a screen out at the phone width and nothing else.
    ///
    /// - The safe area is respected: the tab bar is part of the phone chrome,
    ///   and a screen that ignores the bottom inset draws under it.
    func phoneFrame() -> some View {
        modifier(PhoneFrame())
    }
}

// MARK: - Screen furniture

/// The shape every screen shares: title, the line under it that says what is
/// being shown and why, then the content, on the canvas.
public struct Screen<Content: View>: View {
    @Environment(\.palette) private var palette

    private let title: String
    private let subtitle: String?
    private let content: Content

    public init(_ title: String, subtitle: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.subtitle = subtitle
        self.content = content()
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.lg) {
                VStack(alignment: .leading, spacing: Space.sm) {
                    Text(title)
                        .font(Typeface.display)
                        .foregroundStyle(palette.ink)
                        .fixedSize(horizontal: false, vertical: true)
                    if let subtitle {
                        Text(subtitle)
                            .font(Typeface.callout)
                            .foregroundStyle(palette.inkSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                content
            }
            .padding(.horizontal, Space.md)
            .padding(.top, Space.sm)
            .padding(.bottom, Space.lg)
        }
        .frame(width: phoneWidth)
        .scrollDismissesKeyboard(.interactively)
        .background(palette.canvas)
    }
}

/// A small label above a group of rows, the way iOS sections itself.
public struct SectionHeader: View {
    @Environment(\.palette) private var palette

    private let title: String

    public init(_ title: String) {
        self.title = title
    }

    public var body: some View {
        Text(title.uppercased())
            .font(.system(size: 11, weight: .semibold))
            .kerning(0.6)
            .foregroundStyle(palette.inkTertiary)
    }
}

// MARK: - Building blocks

/// A card with a soft shadow rather than a hairline edge.
///
/// The hairline is kept for the one thing a hairline is good at — an input's
/// boundary — and dropped everywhere else, because a one-pixel grey line around
/// every box is what makes an interface read as a form instead of an app.
public struct Card<Content: View>: View {
    @Environment(\.palette) private var palette

    private let padding: CGFloat
    private let content: Content

    public init(padding: CGFloat = Space.md, @ViewBuilder content: () -> Content) {
        self.padding = padding
        self.content = content()
    }

    public var body: some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(padding)
            .background(palette.surface)
            .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            .shadow(color: .black.opacity(0.06), radius: 12, x: 0, y: 4)
    }
}

/// Initials on a tint derived from the id, in a circle.
///
/// The honest alternative to a photograph. `photoIds` carries identifiers and no
/// bytes — the media service is outside this system — so an avatar here is a
/// *placeholder drawn from what the projection does hold*, not an impression of
/// somebody's face. The hue is derived from the user id, so the same person is
/// the same colour on every device and in every session.

// MARK: - Components
//
// The chips, buttons, avatar, ring, fields, empty state, failure note and fact
// row live in `Components.swift`. They were one file until this split, at 570
// lines — over the repository's ceiling — and the split is by responsibility
// rather than by convenience: this file is what a screen is laid out *with*, and
// `Components.swift` is what a screen is made *of*.
///
/// `Feedback.swift` holds the press treatments those buttons use, so a change to
/// how a tap feels has one home as well.
