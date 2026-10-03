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

// MARK: - Tokens
//
// Spacing is a four-point scale and type is a five-step scale, declared once.
// Both exist so the iOS app inherits the same rhythm rather than a set of
// hand-tuned numbers from a screenshot.

public enum Space {
    public static let xs: CGFloat = 4
    public static let sm: CGFloat = 8
    public static let md: CGFloat = 16
    public static let lg: CGFloat = 24
    public static let xl: CGFloat = 32
}

public enum Radius {
    public static let card: CGFloat = 14
    public static let chip: CGFloat = 8
}

/// The palette, in semantic terms only.
///
/// Nothing here is a brand colour. The product's own surfaces are the server's
/// answer — a restriction is shown with the capabilities the server removed, and
/// a card is shown because the server served it — so the client has no colour
/// decisions of its own to make beyond telling those states apart.
public enum Ink {
    /// Page background. Explicit rather than `.background`, which resolves
    /// differently on the two platforms.
    public static let canvas = Color(red: 0.98, green: 0.98, blue: 0.99)
    public static let card = Color.white
    public static let hairline = Color(red: 0.85, green: 0.85, blue: 0.88)
    /// Reserved for a *server-declared* restriction. Never for a client opinion.
    public static let restricted = Color(red: 0.72, green: 0.11, blue: 0.11)
    public static let restrictedWash = Color(red: 0.99, green: 0.93, blue: 0.93)
    /// Reserved for a server-declared success — a completed checklist step, a
    /// grant the server actually published.
    public static let granted = Color(red: 0.09, green: 0.42, blue: 0.27)
}

// MARK: - The frame

/// Lays a screen out at the phone width and nothing else.
///
/// - `ignoresSafeArea` is false by default: the tab bar is part of the phone
///   chrome, and a screen that ignores the bottom inset draws under it.
public func phoneFrame(_ content: some View) -> some View {
    content
        .frame(width: phoneWidth)
        .frame(maxWidth: .infinity, alignment: .center)
        .background(Ink.canvas)
}

/// A title, in the type scale, with the spacing that goes with it.
public func screenTitle(_ text: String) -> some View {
    Text(text)
        .font(.system(size: 26, weight: .semibold))
        .foregroundStyle(.primary)
        .fixedSize(horizontal: false, vertical: true)
}

/// The supporting line under a title. Present on every screen: the server's
/// projections are read rather than inferred, so every screen has something to
/// say about what it is showing.
public func screenSubtitle(_ text: String) -> some View {
    Text(text)
        .font(.system(size: 15))
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
}

// MARK: - Building blocks

/// A white card with a hairline edge, the one container every screen uses.
public struct Card<Content: View>: View {
    private let content: Content

    public init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    public var body: some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Space.md)
            .background(Ink.card)
            .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                    .stroke(Ink.hairline, lineWidth: 1)
            )
    }
}

/// A small label for a value the server published — a capability name, a case
/// id, a state. Monospaced so an id reads as an id.
public struct ValueChip: View {
    private let text: String
    private let tint: Color

    public init(_ text: String, tint: Color = .secondary) {
        self.text = text
        self.tint = tint
    }

    public var body: some View {
        Text(text)
            .font(.system(size: 12, weight: .medium, design: .monospaced))
            .foregroundStyle(tint)
            .padding(.horizontal, Space.sm)
            .padding(.vertical, Space.xs)
            .background(tint.opacity(0.10))
            .clipShape(RoundedRectangle(cornerRadius: Radius.chip, style: .continuous))
    }
}

/// The primary button. One per screen, so the affordance a member is offered is
/// never ambiguous.
public struct PrimaryButton: View {
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
                .font(.system(size: 16, weight: .semibold))
                .frame(maxWidth: .infinity)
                .padding(.vertical, Space.md)
                .background(isEnabled ? Ink.granted : Ink.hairline)
                .foregroundStyle(.white)
                .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
    }
}

/// What a screen says when a request failed.
///
/// The distinction `DiscoveryViewModel` exists for is kept here too: a refusal is
/// the server's answer and may be shown; a store fault or a transport failure
/// means the platform does not know, and the screen says so rather than
/// rendering the failure as a fact about the member.
public struct FailureNote: View {
    private let error: APIError
    private let retry: () -> Void

    public init(_ error: APIError, retry: @escaping () -> Void) {
        self.error = error
        self.retry = retry
    }

    public var body: some View {
        Card {
            VStack(alignment: .leading, spacing: Space.sm) {
                Text(error.isUserFacing ? "The service refused that" : "We could not load this")
                    .font(.system(size: 16, weight: .semibold))
                if let message = error.message, error.isUserFacing {
                    screenSubtitle(message)
                } else {
                    screenSubtitle(
                        error.isRetryable
                            ? "That did not work. Try again in a moment."
                            : "That did not work."
                    )
                }
                if let code = error.code {
                    ValueChip(code.rawValue)
                }
                if error.isRetryable {
                    Button("Try again", action: retry)
                        .font(.system(size: 14, weight: .medium))
                }
            }
        }
    }
}

/// A single line of key/value, used where the server published a fact the
/// member is entitled to see and nothing should be derived from it.
public struct FactRow: View {
    private let label: String
    private let value: String

    public init(_ label: String, _ value: String) {
        self.label = label
        self.value = value
    }

    public var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label)
                .font(.system(size: 14))
                .foregroundStyle(.secondary)
            Spacer(minLength: Space.sm)
            Text(value)
                .font(.system(size: 14, weight: .medium))
                .multilineTextAlignment(.trailing)
        }
    }
}