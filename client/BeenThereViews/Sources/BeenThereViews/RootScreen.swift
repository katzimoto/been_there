import SwiftUI
import BeenThereKit

/// The whole app, at phone width.
///
/// ## The tab bar is the iOS one
///
/// Four tabs in `Tab.allCases` order with the system tab bar, drawn at 390pt.
///
/// A macOS sidebar would have been more native and would have been a rewrite:
/// the tab bar here is the chrome the iOS app gets for free, so the only thing
/// that has to change for a phone is the window around it, which is eleven
/// lines in `../BeenThereMac`.
///
/// ## Tabs are withheld, never disabled
///
/// A tab whose data the service has not published yet is not shown at all
/// rather than shown greyed out. `ClientGate`'s comment gives the reason: an
/// affordance that always fails teaches people the app is broken, and a screen
/// that reveals a state the member is not entitled to know about is worse than
/// an absent one. So the bar lists exactly the tabs this load can serve.
public struct RootScreen: View {

    @Environment(\.palette) private var palette

    @Bindable var model: AppModel

    /// - Parameter feedback: how hard a tap feels. The shell decides — the iOS
    ///   app installs UIKit's generators, the Mac app installs nothing — so this
    ///   view never has to know which platform it is on. `.silent` is the
    ///   default rather than a requirement, because a preview and a Mac build
    ///   both want it.
    public init(model: AppModel, feedback: Feedback = .silent) {
        self.model = model
        self.feedback = feedback
        // Seeded from the model rather than defaulted to `.signIn`, because the
        // app can be constructed after a session exists and a wrong seed would
        // make the very first tab switch look like a landing.
        _previousTab = State(initialValue: model.tab)
    }

    private let feedback: Feedback

    /// Which tab was showing when this render began.
    ///
    /// Read *before* `onChange` writes the new value back, which is the only
    /// moment the difference between "the member chose this" and "the app landed
    /// here" exists. It is what lets the two cases use different curves.
    @State private var previousTab: AppModel.Tab

    /// Whether a placeholder has been on long enough to be worth drawing.
    ///
    /// Held here rather than in the screens because every tab waits on the same
    /// load: `refresh()` fetches all four projections at once, so the rule about
    /// not flashing a spinner is one rule for the whole app, not one per screen.
    @State private var loadGate = LoadingGate()

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public var body: some View {
        // The palette is provided here rather than at each screen: `RootScreen` is
        // the root of both app shells, so one line gives every view its colours
        // and neither shell has to know the scheme exists. The same goes for
        // haptics, for the same reason.
        //
        // Nothing *inside this file* may read `@Environment(\.palette)` directly:
        // this view's own environment is the one above `PaletteProvider`, so a
        // colour read here is the light default in dark mode — which is exactly
        // the bug the dark screenshot showed, a white tab bar on a charcoal app.
        // The chrome below is therefore its own view, rendered inside the
        // provider, and the canvas behind it is painted by the screens.
        PaletteProvider {
            FeedbackProvider(feedback: feedback) {
                VStack(spacing: 0) {
                    // The screen takes the space that is left, and the bar keeps
                    // its own height. Without this the content's intrinsic height
                    // wins: a long page pushes the bar past the bottom of the
                    // window, and it stops being tappable — which is what a UI
                    // test saw as a hit point of (-1, -1) rather than as a tab
                    // that had moved.
                    content
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    // The bar is chrome for moving between tabs, and a chat is
                    // not a tab — it is pushed over one. Leaving it visible would
                    // invite a tap that throws the conversation away.
                    if model.chat == nil {
                        TabBar(tabs: availableTabs, selected: model.tab) { tab in
                            model.go(to: tab)
                        }
                    }
                }
                .frame(width: phoneWidth)
            }
        }
        // The tab bar reflows when the service publishes a different set of
        // tabs, and a bar that jumps is a bar that moves under a thumb aimed at
        // it. Animating the reflow makes the change legible instead of silent.
        .animation(reduceMotion ? nil : Motion.tabSwitch, value: availableTabs)
        .animation(reduceMotion ? nil : tabArrival, value: model.tab)
        .onChange(of: model.tab) { _, next in previousTab = next }
        // One rule for the whole app's loading: a load that outlasts
        // `Motion.placeholderDelay` earns a skeleton, and one that finishes
        // sooner than that never puts a spinner on screen at all.
        .task(id: model.isLoading) {
            if model.isLoading {
                loadGate.begin()
            } else {
                loadGate.finish()
            }
        }
    }

    /// The curve a tab change gets.
    ///
    /// Two cases, because they are two different events. Arriving on a member
    /// tab from the sign-in form is the app telling the member it worked, and it
    /// gets the slow spring. Moving between tabs the member chose is an answer
    /// to their own thumb, and it gets the quick flat one.
    private var tabArrival: Animation {
        previousTab == .signIn && model.tab != .signIn ? Motion.landing : Motion.tabSwitch
    }

    /// The tabs for this load, decided once when it finished.
    ///
    /// Not derived here, per render, per projection. That is what made the bar
    /// reflow four times during one load — once per projection landing — and
    /// move under a thumb that was aiming at it. The rules live in
    /// `AppModel.tabs`, evaluated at the end of the load, so the bar changes
    /// once and then holds still while the member reads it.
    private var availableTabs: [AppModel.Tab] { model.availableTabs }

    @ViewBuilder
    private var content: some View {
        // A chat is pushed over the tab that opened it, so it is decided before
        // the tab is: `model.chat` is the only thing that moves the member out of
        // a tab and back, and `closeChat()` is the only way back.
        //
        // The tabs stay mounted underneath it rather than being torn down, so
        // the member comes back from a conversation to the place they left.
        ZStack {
            memberTabs

            if let chat = model.chat {
                ChatScreen(model: model, conversation: chat) { model.closeChat() }
                    .transition(reduceMotion ? .identity : .move(edge: .trailing))
            }
        }
        .animation(reduceMotion ? nil : Motion.tabSwitch, value: model.chat?.conversationId)
    }

    /// Every tab this load can serve, stacked and kept.
    ///
    /// ## Why they are not switched
    ///
    /// Each tab's `Screen` owns a `ScrollView`, and a `ScrollView` holds its
    /// offset only for as long as it stays in the hierarchy. Rendering one tab
    /// at a time therefore threw away the member's place every single time they
    /// came back — read three match rows, checked Account, came back, and found
    /// themselves at the top of the list again, on a tab they had not changed.
    ///
    /// So every tab this load serves stays mounted, and only the selected one
    /// is visible. That costs four idle scroll views, which on this app is a
    /// rounding error next to the cost of losing the member's place.
    ///
    /// A hidden tab is transparent, not hittable, *and* hidden from the
    /// accessibility tree. Without that last one a screen-reader user arrowing
    /// through the app walks into screens they are not looking at, and any client
    /// identifying a control by name finds two of them.
    @ViewBuilder
    private var memberTabs: some View {
        ZStack {
            ForEach(availableTabs) { tab in
                screen(for: tab)
                    .opacity(tab == model.tab ? 1 : 0)
                    .offset(y: tab == model.tab ? 0 : Motion.rise)
                    .allowsHitTesting(tab == model.tab)
                    .accessibilityHidden(tab != model.tab)
            }
        }
        .refreshable { await model.refresh() }
        .accessibilityAction(named: Text("Refresh")) {
            Task { await model.refresh() }
        }
    }

    /// The screen for one tab.
    ///
    /// A function rather than a `switch` over `model.tab`, because the stack
    /// asks for a tab's screen rather than for *the* screen: every tab in
    /// `availableTabs` gets asked, and the ones that are not showing are simply
    /// not drawn.
    @ViewBuilder
    private func screen(for tab: AppModel.Tab) -> some View {
        switch tab {
        case .signIn:
            SignInScreen(model: model)

        case .standing:
            if let account = model.account {
                let standing = account.account
                StandingScreen(
                    model: StandingScreenModel(standing: standing),
                    identityState: account.identity.state,
                    identityGeneration: account.identity.generation
                ) {
                    Task { await model.signOut() }
                }
                // The identity projection's own version, not the standing's:
                // `AccountStanding` carries no version of its own, and the screen
                // draws both, so this is the number that says the page it is on
                // is a new one.
                .revealOnReplace(when: account.identity.projectionVersion)
            } else {
                loading
            }

        case .onboarding:
            if let readiness = model.readiness {
                OnboardingScreen(readiness: readiness, snapshot: model.viewerSnapshot) {
                    Task { await model.refresh() }
                }
                .revealOnReplace(when: readiness.version)
            } else {
                loading
            }

        case .discovery:
            if let discovery = model.discovery {
                DiscoveryScreen(
                    model: discovery,
                    actions: model,
                    offersLike: model.offersLike(),
                    offersBlock: model.offersBlock,
                    offersReport: model.offersReport,
                    likeOutcome: model.likeOutcome,
                    likeFailure: model.likeFailure,
                    onRetry: { Task { await model.refresh() } },
                    onLike: { card in Task { await model.like(candidate: card.userId) } }
                )
                .revealOnReplace(when: discovery.projectionVersion)
            } else {
                loading
            }

        case .matches:
            MatchesScreen(model: model)
        }
    }

    /// What a tab shows while it waits for the projection that fills it.
    ///
    /// Its own view for the reason `TabBar` is one: it reads `palette` from the
    /// environment, and this is rendered *inside* `PaletteProvider` rather than
    /// beside it. As a computed property of `RootScreen` it would have read the
    /// light default in dark mode — which is the exact bug the comment on `body`
    /// warns about, and which the old `loading` was living in.
    private var loading: some View {
        LoadingPlaceholder(
            isLoading: model.isLoading,
            failure: model.loadFailure,
            showsPlaceholder: loadGate.showsPlaceholder,
            onRetry: { Task { await model.refresh() } }
        )
    }
}

/// What a tab shows while the load that fills it is still running.
///
/// ## Why a skeleton, and why it is gated
///
/// A `ProgressRing` in the middle of an empty screen says "something is
/// happening somewhere". A skeleton says "this is what is arriving, and it is
/// this tall" — on a page of people the member can see the row spacing is
/// already right, which is the difference between a screen that is thinking and
/// a screen that is broken.
///
/// But a placeholder that appears for two frames is a flash of a shape the
/// member has to re-read, on a screen that was about to be correct anyway. So
/// `LoadingGate` decides: under `Motion.placeholderDelay` nothing is drawn at
/// all, and over it the skeleton arrives and the content rises over the top.
///
/// The skeleton draws no names and no initials. A placeholder that invented a
/// person would be a claim the service has not made.
private struct LoadingPlaceholder: View {
    @Environment(\.palette) private var palette

    let isLoading: Bool
    let failure: APIError?
    let showsPlaceholder: Bool
    let onRetry: () -> Void

    /// How many placeholder rows are drawn.
    ///
    /// Three is a screenful at this width and no more: a seventh row would be
    /// below the fold, drawing nothing anybody will see and costing a view for
    /// it.
    private static let rows = 3

    var body: some View {
        Screen(
            isLoading ? "Loading from the service" : "Nothing loaded yet",
            subtitle: isLoading
                ? "Reading the projections the service publishes."
                : "The service has not answered with an account yet."
        ) {
            if let failure {
                FailureNote(failure, retry: onRetry)
                    .revealOnReplace(when: failure)
            } else if showsPlaceholder {
                VStack(spacing: Space.sm) {
                    ForEach(0..<Self.rows, id: \.self) { _ in
                        SkeletonCandidateRow()
                    }
                }
                .revealOnReplace(when: showsPlaceholder)
                // One announcement for the whole page rather than nine for nine
                // grey rectangles, and no announcement at all once the content
                // has arrived to speak for itself.
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(isLoading ? "Loading" : "Nothing loaded yet")
            }
        }
    }
}

/// The tab bar, drawn the way the phone draws it: a filled surface with a hairline
/// above it, the selected tab in the accent, the rest in tertiary ink.
///
/// Its own view for one reason — the palette. `RootScreen` installs
/// `PaletteProvider` inside its own body, so anything *in that file* reading
/// `@Environment(\.palette)` gets the default light scheme, not the one just
/// installed. Rendered inside the provider, this reads the right one, which is
/// the difference between a tab bar that follows the app and one that stays white
/// on a charcoal screen.
///
/// ## Why each tab carries an identifier as well as a label
///
/// A tab and the action on the screen it opens can easily share a name — the
/// "Sign in" tab and the "Sign in" button did. VoiceOver and XCUITest both
/// identify a control by its accessible name when no identifier is set, so two
/// such controls are indistinguishable to both, and the tab sits later in the
/// hierarchy and therefore wins the lookup. The identifier says *what kind of
/// control this is* and leaves the label saying *what it is called*.
struct TabBar: View {
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let tabs: [AppModel.Tab]
    let selected: AppModel.Tab
    let onSelect: (AppModel.Tab) -> Void

    var body: some View {
        VStack(spacing: 0) {
            Rectangle()
                .fill(palette.hairline)
                .frame(height: 1)
            HStack(spacing: 0) {
                ForEach(tabs) { tab in
                    let isSelected = tab == selected
                    Button {
                        onSelect(tab)
                    } label: {
                        VStack(spacing: 3) {
                            Image(systemName: isSelected ? "\(tab.symbol).fill" : tab.symbol)
                                .font(.system(size: 17, weight: .medium))
                            Text(tab.title)
                                .font(.system(size: 10, weight: .semibold))
                        }
                        .foregroundStyle(isSelected ? palette.accent : palette.inkTertiary)
                        // The bar reflows when the service publishes a different
                        // set of tabs. A tab that appears fades and rises into
                        // its slot rather than blinking into existence, and a tab
                        // that is withdrawn fades out on the way — so the change
                        // is something the member watches happen instead of
                        // something that has already happened to them.
                        .transition(
                            reduceMotion
                                ? .opacity
                                : .opacity.combined(with: .offset(y: Motion.rise))
                        )
                        .frame(maxWidth: .infinity)
                        .padding(.top, Space.sm)
                        .padding(.bottom, Space.sm)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(tab.title)
                    .accessibilityIdentifier("tab.\(tab.rawValue)")
                    .accessibilityAddTraits(isSelected ? [.isSelected] : [])
                }
            }
            .background(palette.surface)
        }
        .frame(width: phoneWidth)
    }
}
