import SwiftUI
import Observation

/// How things move, as a handful of named curves rather than a number per call
/// site.
///
/// ## Why this is its own file
///
/// `Feedback.swift` owns how a tap *feels*; this owns how the app *arrives*. The
/// two used to be the same question and the answer was "nothing animates" — a
/// screen replaced its own content, so a member watching a load saw a blank
/// frame, then a spinner, then the finished screen, with no relationship drawn
/// between any two of those. Naming the curves once is what lets a screen say
/// `Motion.replace` and mean the same thing as every other screen.
///
/// ## Every one of these respects Reduce Motion
///
/// Not by shortening them — by choosing a different transition. A rise is
/// removed and a cross-fade is kept, because the cross-fade is what makes the
/// change legible and the rise is what makes somebody's vestibular system
/// complain. `reduceMotion` is read from the environment at each use rather than
/// declared once here, because it is a setting a person can change while the app
/// is running.
public enum Motion {

    /// Content arriving over a placeholder.
    ///
    /// `easeOut` rather than a spring because this one runs on data that may
    /// arrive at any moment, including mid-scroll, and a spring that is still
    /// settling when the next packet lands reads as the app being unsure.
    public static let replace = Animation.easeOut(duration: 0.28)

    /// Arriving on a tab for the first time with a session held.
    ///
    /// The slowest curve in the file, and the only one with a little bounce. It
    /// runs once per sign-in and it is the moment the member is least sure the
    /// app worked, so it is the moment worth spending a beat on.
    public static let landing = Animation.spring(response: 0.46, dampingFraction: 0.86)

    /// Moving between tabs the member chose.
    ///
    /// Quicker and flatter than `landing`: the member drove this one, so it
    /// should feel like an answer to their thumb rather than a performance.
    public static let tabSwitch = Animation.easeOut(duration: 0.22)

    /// A like landing.
    ///
    /// The one genuinely bouncy curve here. The press and the outcome are
    /// separated by a round trip to the service, so the spring is what stitches
    /// the two halves of the action together across that gap.
    public static let like = Animation.spring(response: 0.34, dampingFraction: 0.55)

    /// The skeleton breathing.
    public static let breathe = Animation.easeInOut(duration: 0.9).repeatForever(autoreverses: true)

    /// How far content rises as it replaces a placeholder, in points.
    ///
    /// Small on purpose. Twelve points reads as a considered entrance; forty
    /// reads as a card being thrown at the member.
    public static let rise: CGFloat = 10

    /// How long a load may take before a placeholder is worth drawing.
    ///
    /// This is the number behind "a load that finishes in 40ms should not flash
    /// a spinner". A spinner that is on screen for two frames is worse than no
    /// spinner: it is a flash of a shape the member has to re-read, on a screen
    /// that was about to be correct anyway.
    public static let placeholderDelay = Duration.milliseconds(220)

    /// How long the like control stays sprung before it settles back.
    ///
    /// An upper bound rather than a wait: the release normally happens the
    /// moment the server answers, and this only covers a load that never
    /// answers, so a like cannot leave the heart stuck open.
    public static let likeSettle = Duration.milliseconds(520)
}

// MARK: - Content arriving

/// Cross-fades content in over a placeholder, with a slight rise.
///
/// The transition is declared on the content itself and the animation on the
/// same view, so a screen opts in with one modifier and gets both halves: the
/// rise cannot be forgotten, and the cross-fade cannot be left unanimated.
public struct RevealOnReplace<Value: Equatable>: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let value: Value

    public func body(content: Content) -> some View {
        content
            .transition(
                reduceMotion
                    ? .opacity
                    : .asymmetric(
                        insertion: .opacity.combined(with: .offset(y: Motion.rise)),
                        removal: .opacity
                    )
            )
            .animation(reduceMotion ? nil : Motion.replace, value: value)
    }
}

public extension View {
    /// Reveals this view when it replaces a loading frame, keyed on `value`.
    ///
    /// - Parameter value: what changed to make this the content rather than the
    ///   placeholder. It keys the animation *and* documents the intent at the
    ///   call site, so `revealOnReplace(when: model.readiness?.nextStep)` says
    ///   more than `revealOnReplace(when: true)`.
    func revealOnReplace<Value: Equatable>(when value: Value) -> some View {
        modifier(RevealOnReplace(value: value))
    }
}

// MARK: - Loading that does not flicker

/// Whether a placeholder has been on long enough to be worth drawing.
///
/// ## The rule
///
/// A placeholder appears only if the load outlasts
/// `Motion.placeholderDelay`. Faster than that and the screen goes straight
/// from what it had to what it got, which for a fast load means the member never
/// learns a load happened at all — and that is the correct amount to learn.
///
/// ## Why a class
///
/// It holds a pending timer across renders, so it has to be a reference with a
/// single identity. `@State` inside the view that uses it would be recreated
/// with the view, which is exactly when the timer must survive.
@MainActor
@Observable
public final class LoadingGate {
    /// Whether the placeholder should be on screen right now.
    public private(set) var showsPlaceholder = false

    private var pending: Task<Void, Never>?
    private let delay: Duration

    /// - Parameter delay: how long a load may run before the placeholder is
    ///   drawn. Defaults to `Motion.placeholderDelay`.
    public nonisolated init(after delay: Duration = Motion.placeholderDelay) {
        self.delay = delay
    }

    /// A load has started. Arms the placeholder, and does not show it yet.
    public func begin() {
        pending?.cancel()
        pending = Task { @MainActor in
            do {
                try await Task.sleep(for: delay)
            } catch {
                // Cancelled by `finish()`: the load beat the delay, which is the
                // whole point of the gate, so there is nothing to report.
                return
            }
            showsPlaceholder = true
        }
    }

    /// The load has landed, successfully or not.
    public func finish() {
        pending?.cancel()
        pending = nil
        showsPlaceholder = false
    }
}

// MARK: - The placeholder itself

/// A block of the shape content is about to take.
///
/// ## Why a skeleton and not a spinner
///
/// A ring says "something is happening somewhere". A skeleton says "this is
/// what is arriving, and it is this tall". On a list of people the second is
/// the difference between a screen that is thinking and a screen that is broken,
/// because the member can see the row spacing is already right.
///
/// Nothing here is content. The blocks carry no text and no initials, because a
/// placeholder that invents a name is a claim the service has not made.
public struct SkeletonBlock: View {
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var breathed = false

    private let height: CGFloat
    private let width: CGFloat?
    private let corner: CGFloat

    /// - Parameters:
    ///   - height: the block's height in points.
    ///   - width: the block's width, or `nil` to fill the available width.
    ///   - corner: the corner radius, matching the shape it stands in for.
    public init(height: CGFloat, width: CGFloat? = nil, corner: CGFloat = Radius.field) {
        self.height = height
        self.width = width
        self.corner = corner
    }

    public var body: some View {
        RoundedRectangle(cornerRadius: corner, style: .continuous)
            .fill(palette.placeholder)
            .frame(width: width, height: height)
            .opacity(reduceMotion ? 1 : (breathed ? 0.55 : 1))
            .animation(reduceMotion ? nil : Motion.breathe, value: breathed)
            .onAppear { breathed = true }
            // A placeholder is not a fact and is not an action. Announcing a row
            // of grey rectangles tells a screen-reader user the app is loading
            // something they cannot otherwise perceive, which is the one thing
            // this file can usefully say — so it is said once, by the screen.
            .accessibilityHidden(true)
    }
}

/// The placeholder for a list of people: an avatar circle and two lines.
///
/// The proportions are `CandidateRow`'s own — 56pt avatar, 17pt name line,
/// 14pt secondary line — so the page does not change height when the real rows
/// arrive. A skeleton of the wrong height is worse than a spinner, because it
/// promises a layout the content then breaks.
public struct SkeletonCandidateRow: View {
    public init() {}

    public var body: some View {
        Card(padding: Space.md) {
            VStack(alignment: .leading, spacing: Space.md) {
                HStack(spacing: Space.md) {
                    SkeletonBlock(height: 56, width: 56, corner: Radius.pill)
                    VStack(alignment: .leading, spacing: Space.sm) {
                        SkeletonBlock(height: 17, width: 148)
                        SkeletonBlock(height: 14, width: 44)
                    }
                    Spacer(minLength: 0)
                }
                SkeletonBlock(height: 14)
                SkeletonBlock(height: 14, width: 232)
                HStack(spacing: Space.xs) {
                    SkeletonBlock(height: 22, width: 84, corner: Radius.chip)
                    SkeletonBlock(height: 22, width: 62, corner: Radius.chip)
                    Spacer(minLength: 0)
                }
            }
        }
    }
}

// MARK: - A like landing

/// The spring on the like button, so the press and the outcome are one action.
///
/// `POST /v1/interactions/likes` is a round trip, so between pressing the heart
/// and learning what happened there is a gap where nothing happened on screen.
/// This springs the control out and back across that gap, which is what makes
/// the wait read as the app working on the press rather than as the press
/// having been ignored.
public struct LikeSpring: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Whether the like this control sent is still in flight.
    let pending: Bool

    public func body(content: Content) -> some View {
        content
            .scaleEffect(pending && !reduceMotion ? 1.14 : 1)
            .animation(reduceMotion ? nil : Motion.like, value: pending)
    }
}

public extension View {
    /// Springs this control while a like it sent is in flight.
    func likeSpring(pending: Bool) -> some View {
        modifier(LikeSpring(pending: pending))
    }
}

// MARK: - The keyboard

/// The keyboard handling a scrolling form needs, in one modifier.
///
/// ## Why the app needed this
///
/// `Screen` already carries `scrollDismissesKeyboard(.interactively)`, so a drag
/// dismisses. That is the only part of the problem it solves, and it leaves two
/// things undone on a sign-in form:
///
/// 1. **Nothing ends the keyboard except a drag.** The Return key submits a
///    password field in a way that leaves the keyboard up, and a tap on the
///    card beside the field does nothing at all — so the member has to guess
///    that dragging is the way out.
/// 2. **The focused field can sit under the keyboard.** SwiftUI scrolls a
///    first responder into view, but only as far as the content allows. A form
///    whose last field is near the bottom of a short page cannot scroll far
///    enough, and the field the member is typing into is the one that is
///    hidden.
///
/// So this adds a Done key above the keyboard — the control iOS itself puts
/// there for text views, and the one people reach for — and keeps the form
/// dismissing on a drag rather than snapping shut under a moving thumb.
///
/// ## Why it takes a focus binding
///
/// Ending the keyboard means moving the focus, and the focus belongs to the
/// screen that declared it. There is no way to clear a first responder without
/// a `FocusState`, and inventing one here would be a second, invisible copy of
/// the screen's focus. So the screen passes its own binding and this owns only
/// the affordance.
public struct KeyboardForm<Field: Hashable>: ViewModifier {
    let focus: FocusState<Field?>.Binding

    public func body(content: Content) -> some View {
        content
            .scrollDismissesKeyboard(.interactively)
            .toolbar {
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") { focus.wrappedValue = nil }
                }
            }
    }
}

public extension View {
    /// Adds the keyboard's Done key to this form.
    ///
    /// Two lines at the call site: hold a `@FocusState`, and pass it here. Each
    /// field then claims a value with `.focused($focus, equals: .someCase)`, and
    /// Done clears it.
    func keyboardForm<Field: Hashable>(_ focus: FocusState<Field?>.Binding) -> some View {
        modifier(KeyboardForm(focus: focus))
    }
}
