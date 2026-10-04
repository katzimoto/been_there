import SwiftUI

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

public enum Type_ {
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

/// Lays a screen out at the phone width and nothing else.
///
/// - `ignoresSafeArea` is false by default: the tab bar is part of the phone
///   chrome, and a screen that ignores the bottom inset draws under it.
public func phoneFrame(_ content: some View) -> some View {
    PhoneFrame(content: content)
}

/// Centres a screen at the phone width and paints the canvas behind it.
///
/// A `View` rather than a bare function because the canvas is a palette colour
/// and a function cannot read the environment — which is exactly the reason the
/// old `phoneFrame` had to hard-code one and lose dark mode.
struct PhoneFrame<Content: View>: View {
    @Environment(\.palette) private var palette

    let content: Content

    var body: some View {
        content
            .frame(width: phoneWidth)
            .frame(maxWidth: .infinity, alignment: .center)
            .background(palette.canvas)
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
                        .font(Type_.display)
                        .foregroundStyle(palette.ink)
                        .fixedSize(horizontal: false, vertical: true)
                    if let subtitle {
                        Text(subtitle)
                            .font(Type_.callout)
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
public struct Avatar: View {
    @Environment(\.palette) private var palette

    private let name: String
    private let id: String
    private let size: CGFloat

    public init(name: String, id: String, size: CGFloat = 52) {
        self.name = name
        self.id = id
        self.size = size
    }

    public var body: some View {
        Text(initials)
            .font(.system(size: size * 0.36, weight: .semibold, design: .rounded))
            .foregroundStyle(tint.opacity(0.95))
            .frame(width: size, height: size)
            .background(tint.opacity(0.14))
            .clipShape(Circle())
            .accessibilityLabel(name)
    }

    /// Up to two initials, from the first and last word of the published name.
    private var initials: String {
        let words = name.split(separator: " ").filter { !$0.isEmpty }
        guard let first = words.first else { return "?" }
        guard words.count > 1, let last = words.last else { return String(first.prefix(1)).uppercased() }
        return (first.prefix(1) + last.prefix(1)).uppercased()
    }

    /// Eight hues, chosen from the id so the same person keeps the same one.
    /// They are tints, not identities: no hue is more desirable than another.
    private var tint: Color {
        let hues: [Double] = [0.98, 0.06, 0.13, 0.22, 0.33, 0.45, 0.55, 0.72]
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in id.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x0000_0100_0000_01B3
        }
        return Color(
            hue: hues[Int(hash % UInt64(hues.count))],
            saturation: 0.55,
            brightness: palette.ink == Color(hex: 0x1B1614) ? 0.62 : 0.58
        )
    }
}

/// A small label for a value the server published — a state, a band, a count.
///
/// Monospaced, so an id reads as an id, and tinted by the meaning the *server*
/// attached, never by a client's opinion.
public struct ValueChip: View {
    @Environment(\.palette) private var palette

    private let text: String
    private let tint: Color

    public init(_ text: String, tint: Color? = nil) {
        self.text = text
        self.tint = tint ?? palette.inkSecondary
    }

    public var body: some View {
        Text(text)
            .font(Type_.mono)
            .foregroundStyle(tint)
            .padding(.horizontal, Space.sm)
            .padding(.vertical, 5)
            .background(tint.opacity(0.10))
            .clipShape(RoundedRectangle(cornerRadius: Radius.chip, style: .continuous))
    }
}

/// A chip for something a *person* is, rather than a value a machine published —
/// a distance band, a gender identity, a state in the member's own words.
///
/// The distinction matters: ids and counts are read in monospace because they
/// are references, and human attributes are not.
public struct TagChip: View {
    @Environment(\.palette) private var palette

    private let text: String
    private let systemImage: String?
    private let tint: Color

    public init(_ text: String, systemImage: String? = nil, tint: Color? = nil) {
        self.text = text
        self.systemImage = systemImage
        self.tint = tint ?? palette.inkSecondary
    }

    public var body: some View {
        HStack(spacing: 4) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.system(size: 10, weight: .semibold))
            }
            Text(text)
                .font(Type_.caption)
        }
        .foregroundStyle(tint)
        .padding(.horizontal, Space.sm)
        .padding(.vertical, 5)
        .background(tint.opacity(0.10))
        .clipShape(Capsule())
    }
}

/// The primary button. One per screen, so the affordance a member is offered is
/// never ambiguous.
public struct PrimaryButton: View {
    @Environment(\.palette) private var palette

    private let title: String
    private let isEnabled: Bool
    private let action: () -> Void

    public init(_ title: String, isEnabled: Bool = true, action: @escaping () -> Void) {
        self.title = title
        self.isEnabled = isEnabled
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 16, weight: .semibold, design: .rounded))
                .frame(maxWidth: .infinity)
                .frame(height: 52)
                .background(isEnabled ? palette.accent : palette.fill)
                .foregroundStyle(isEnabled ? palette.onAccent : palette.inkTertiary)
                .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
    }
}

/// The button next to the primary one. Outline rather than fill, so the pair
/// reads as one choice and one alternative.
public struct SecondaryButton: View {
    @Environment(\.palette) private var palette

    private let title: String
    private let tint: Color
    private let action: () -> Void

    public init(_ title: String, tint: Color? = nil, action: @escaping () -> Void) {
        self.title = title
        self.tint = tint ?? palette.ink
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 15, weight: .semibold))
                .frame(maxWidth: .infinity)
                .frame(height: 50)
                .background(tint.opacity(0.08))
                .foregroundStyle(tint)
                .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}

/// A circular action, for the row of decisions on a discovery card.
public struct CircleAction: View {
    @Environment(\.palette) private var palette

    private let systemImage: String
    private let label: String
    private let filled: Bool
    private let action: () -> Void

    public init(systemImage: String, label: String, filled: Bool = false, action: @escaping () -> Void) {
        self.systemImage = systemImage
        self.label = label
        self.filled = filled
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(filled ? palette.onAccent : palette.inkSecondary)
                .frame(width: 52, height: 52)
                .background(filled ? palette.accent : palette.fill)
                .clipShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

/// A text field with the app's own boundary and focus treatment.
public struct LabelledField<Content: View>: View {
    @Environment(\.palette) private var palette

    private let label: String
    private let content: Content

    public init(_ label: String, @ViewBuilder content: () -> Content) {
        self.label = label
        self.content = content()
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            SectionHeader(label)
            content
                .padding(.horizontal, Space.md)
                .frame(height: 50)
                .background(palette.fill)
                .clipShape(RoundedRectangle(cornerRadius: Radius.field, style: .continuous))
        }
    }
}

/// What a screen says when there is nothing to show.
///
/// Three parts, always in this order: what is true, why it is not an error, and
/// what the member can do next. A screen that only says "no results" teaches
/// people the product is broken.
public struct EmptyState: View {
    @Environment(\.palette) private var palette

    private let systemImage: String
    private let title: String
    private let body: String
    private let actionTitle: String?
    private let action: (() -> Void)?

    public init(
        systemImage: String,
        title: String,
        body: String,
        actionTitle: String? = nil,
        action: (() -> Void)? = nil
    ) {
        self.systemImage = systemImage
        self.title = title
        self.body = body
        self.actionTitle = actionTitle
        self.action = action
    }

    public var body: some View {
        Card {
            VStack(alignment: .leading, spacing: Space.md) {
                Image(systemName: systemImage)
                    .font(.system(size: 26, weight: .medium))
                    .foregroundStyle(palette.accent)
                Text(title)
                    .font(Type_.headline)
                    .foregroundStyle(palette.ink)
                Text(body)
                    .font(Type_.callout)
                    .foregroundStyle(palette.inkSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let actionTitle, let action {
                    SecondaryButton(actionTitle, action: action)
                }
            }
        }
    }
}

/// What a screen says when a request failed.
///
/// The distinction `DiscoveryViewModel` exists for is kept here too: a refusal is
/// the server's answer and may be shown; a store fault or a transport failure
/// means the platform does not know, and the screen says so rather than
/// rendering the failure as a fact about the member.
public struct FailureNote: View {
    @Environment(\.palette) private var palette

    private let error: APIError
    private let retry: () -> Void

    public init(_ error: APIError, retry: @escaping () -> Void) {
        self.error = error
        self.retry = retry
    }

    public var body: some View {
        Card {
            VStack(alignment: .leading, spacing: Space.sm) {
                HStack(spacing: Space.sm) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(palette.restricted)
                    Text("This did not load")
                        .font(Type_.headline)
                        .foregroundStyle(palette.ink)
                }
                Text(error.memberFacingMessage)
                    .font(Type_.callout)
                    .foregroundStyle(palette.inkSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                SecondaryButton("Try again", action: retry)
            }
        }
    }
}

/// A single line of key/value, used where the server published a fact the
/// member is entitled to see and nothing should be derived from it.
public struct FactRow: View {
    @Environment(\.palette) private var palette

    private let label: String
    private let value: String
    private let tint: Color?

    public init(_ label: String, _ value: String, tint: Color? = nil) {
        self.label = label
        self.value = value
        self.tint = tint
    }

    public var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label)
                .font(Type_.callout)
                .foregroundStyle(palette.inkSecondary)
            Spacer(minLength: Space.md)
            Text(value)
                .font(Type_.mono)
                .foregroundStyle(tint ?? palette.ink)
                .multilineTextAlignment(.trailing)
        }
    }
}