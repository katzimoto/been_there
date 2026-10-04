import SwiftUI

/// Haptic feedback, injected rather than imported.
///
/// ## Why this is an environment value
///
/// A tap you can feel is the cheapest possible confirmation that a phone
/// registered an action, and on iOS it is one line of UIKit. That one line is
/// exactly what this package does not import: the views build for macOS too, and
/// a `UIKit` import would put a platform framework in a file that must not have
/// one. So the *shell* owns the capability and the views ask for it — the iOS
/// shell installs a real implementation, the macOS shell installs nothing, and
/// no view file knows which platform it is on.
///
/// The same shape as `Palette`: a value in the environment, resolved once at the
/// root, so a leaf view calls `Feedback.tap()` without declaring a dependency.
public struct Feedback: Sendable {

    private let impact: @Sendable (Haptics.Weight) -> Void
    private let notify: @Sendable (Haptics.Result) -> Void
    private let selection: @Sendable () -> Void

    public init(
        impact: @escaping @Sendable (Haptics.Weight) -> Void = { _ in },
        notify: @escaping @Sendable (Haptics.Result) -> Void = { _ in },
        selection: @escaping @Sendable () -> Void = {}
    ) {
        self.impact = impact
        self.notify = notify
        self.selection = selection
    }

    /// Does nothing. The macOS default and the value in a preview.
    public static let silent = Feedback()

    public func tap(_ weight: Haptics.Weight = .light) { impact(weight) }
    public func succeed() { notify(.success) }
    public func warn() { notify(.warning) }
    public func fail() { notify(.error) }
    public func changed() { selection() }
}

/// The vocabulary of feedback, so a view names an intent and not a device.
public enum Haptics {
    public enum Weight: Sendable { case light, medium, heavy, soft, rigid }
    public enum Result: Sendable { case success, warning, error }
}

private struct FeedbackKey: EnvironmentKey {
    static let defaultValue = Feedback.silent
}

extension EnvironmentValues {
    public var feedback: Feedback {
        get { self[FeedbackKey.self] }
        set { self[FeedbackKey.self] = newValue }
    }
}

/// Installs a feedback implementation for a subtree.
///
/// `RootScreen` does this once; the iOS shell passes its UIKit-backed
/// implementation, the macOS shell passes nothing.
public struct FeedbackProvider<Content: View>: View {
    private let feedback: Feedback
    private let content: Content

    public init(feedback: Feedback = .silent, @ViewBuilder content: () -> Content) {
        self.feedback = feedback
        self.content = content()
    }

    public var body: some View {
        content.environment(\.feedback, feedback)
    }
}

// MARK: - Press response

/// The press treatment every tappable thing in the app shares.
///
/// ## Why scale and not a colour
///
/// Two rules from the design references, applied together. *Micro-interactions*
/// wants a short (50–100ms) physical acknowledgement on touch, and Material's
/// state-layer guidance wants a 10–15% overlay rather than swapping the colour
/// outright — a button that changes hue on press reads as a state change, while
/// one that shrinks a hair reads as "this is a button and I pushed it".
///
/// So: a 0.97 scale with a light spring, plus a whisper of the palette's own
/// fill underneath. Nothing animates on a screen the member did not touch, and
/// `reduceMotion` removes it entirely rather than merely shortening it.
public struct PressableStyle: ButtonStyle {
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(
                RoundedRectangle(cornerRadius: Radius.button, style: .continuous)
                    .fill(palette.ink.opacity(configuration.isPressed ? 0.06 : 0))
            )
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
            .animation(
                reduceMotion ? nil : .spring(response: 0.22, dampingFraction: 0.7),
                value: configuration.isPressed
            )
    }
}

/// The same treatment for a circular action, whose corner radius is a circle.
public struct PressableCircleStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.9 : 1)
            .animation(
                reduceMotion ? nil : .spring(response: 0.2, dampingFraction: 0.6),
                value: configuration.isPressed
            )
    }
}