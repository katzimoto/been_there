import SwiftUI
import BeenThereKit

/// The pieces a screen is made of.
///
/// Split out of `DesignSystem.swift` when that file passed the repository's
/// 500-line ceiling. Nothing here is a token and nothing here is layout: these
/// are the individual controls — a chip for a value the server published, a tag
/// for something a person is, a button, a circle action, a field, a ring, an
/// empty state, a failure note and a fact row.
///
/// Every colour comes from `@Environment(\.palette)`, so all of it follows the
/// colour scheme without a single branch, and none of it hard-codes a colour a
/// second time. The press treatments are in `Feedback.swift`.
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

/// A ring showing how much of something is done.
///
/// Used for the onboarding checklist, where the number matters less than the
/// shape: a member should see "most of the way" without reading a percentage.
public struct ProgressRing: View {
    private let fraction: Double
    private let tint: Color
    private let size: CGFloat

    public init(fraction: Double, tint: Color, size: CGFloat = 56) {
        self.fraction = fraction
        self.tint = tint
        self.size = size
    }

    public var body: some View {
        ZStack {
            Circle()
                .stroke(tint.opacity(0.15), lineWidth: 6)
            Circle()
                .trim(from: 0, to: max(0.001, min(1, fraction)))
                .stroke(tint, style: StrokeStyle(lineWidth: 6, lineCap: .round))
                .rotationEffect(.degrees(-90))
            Text("\(Int(fraction * 100))%")
                .font(.system(size: size * 0.26, weight: .semibold, design: .rounded))
                .foregroundStyle(tint)
        }
        .frame(width: size, height: size)
        .accessibilityValue("\(Int(fraction * 100)) percent complete")
    }
}

/// A small label for a value the server published — a state, a band, a count.
///
/// Monospaced, so an id reads as an id, and tinted by the meaning the *server*
/// attached, never by a client's opinion.
public struct ValueChip: View {
    @Environment(\.palette) private var palette

    private let text: String

    private let requestedTint: Color?

    public init(_ text: String, tint: Color? = nil) {
        self.text = text
        self.requestedTint = tint
    }

    private var tint: Color { requestedTint ?? palette.inkSecondary }

    public var body: some View {
        Text(text)
            .font(Typeface.mono)
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

    private let requestedTint: Color?

    public init(_ text: String, systemImage: String? = nil, tint: Color? = nil) {
        self.text = text
        self.systemImage = systemImage
        self.requestedTint = tint
    }

    private var tint: Color { requestedTint ?? palette.inkSecondary }

    public var body: some View {
        HStack(spacing: 4) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.system(size: 10, weight: .semibold))
            }
            Text(text)
                .font(Typeface.caption)
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
        .buttonStyle(PressableStyle())
        .disabled(!isEnabled)
    }
}

/// The button next to the primary one. Outline rather than fill, so the pair
/// reads as one choice and one alternative.
public struct SecondaryButton: View {
    @Environment(\.palette) private var palette

    private let title: String
    private let action: () -> Void

    private let requestedTint: Color?

    public init(_ title: String, tint: Color? = nil, action: @escaping () -> Void) {
        self.title = title
        self.requestedTint = tint
        self.action = action
    }

    private var tint: Color { requestedTint ?? palette.ink }

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
        .buttonStyle(PressableStyle())
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
        .buttonStyle(PressableCircleStyle())
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
    private let message: String
    private let actionTitle: String?
    private let action: (() -> Void)?

    public init(
        systemImage: String,
        title: String,
        body message: String,
        actionTitle: String? = nil,
        action: (() -> Void)? = nil
    ) {
        self.systemImage = systemImage
        self.title = title
        self.message = message
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
                    .font(Typeface.headline)
                    .foregroundStyle(palette.ink)
                Text(message)
                    .font(Typeface.callout)
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
                        .font(Typeface.headline)
                        .foregroundStyle(palette.ink)
                }
                Text(error.message ?? "The request did not complete.")
                    .font(Typeface.callout)
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

    private let requestedTint: Color?

    public init(_ label: String, _ value: String, tint: Color? = nil) {
        self.label = label
        self.value = value
        self.requestedTint = tint
    }

    private var tint: Color { requestedTint ?? palette.ink }

    public var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label)
                .font(Typeface.callout)
                .foregroundStyle(palette.inkSecondary)
            Spacer(minLength: Space.md)
            Text(value)
                .font(Typeface.mono)
                .foregroundStyle(tint)
                .multilineTextAlignment(.trailing)
        }
    }
}