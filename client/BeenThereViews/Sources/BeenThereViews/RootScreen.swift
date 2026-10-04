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
    }

    private let feedback: Feedback

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
                    content
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
    }

    /// The tabs this load can serve.
    ///
    /// `signIn` appears only while there is no session. It is the way in, and
    /// once a session exists it is a control that can only return a member to a
    /// form they no longer need — so it is withheld rather than shown greyed
    /// out, which is this file's own rule. Withholding it also removes the
    /// collision that made it unreachable: a tab labelled "Sign in" and a
    /// button labelled "Sign in" are the same control to VoiceOver and to any
    /// UI test querying by name, and the tab won.
    ///
    /// `standing` appears once a standing has been published — which includes an
    /// `active` one, because "what does the service think my account holds" is
    /// answerable for any account. `matches` appears with the session rather
    /// than with a loaded list: `GET /v1/matches` answers for any member,
    /// including an empty one, so withholding it until a match exists would hide
    /// the empty state the member needs to see.
    private var availableTabs: [AppModel.Tab] {
        AppModel.Tab.allCases.filter { tab in
            switch tab {
            case .signIn: return model.session == nil
            case .standing: return model.account != nil
            case .onboarding: return model.readiness != nil
            case .discovery: return model.offersDiscovery
            case .matches: return model.session != nil
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        // A chat is pushed over the tab that opened it, so it is decided before
        // the tab is: `model.chat` is the only thing that moves the member out of
        // a tab and back, and `closeChat()` is the only way back.
        if let chat = model.chat {
            ChatScreen(model: model, conversation: chat) { model.closeChat() }
        } else {
            tabContent
        }
    }

    @ViewBuilder
    private var tabContent: some View {
        switch model.tab {
        case .signIn:
            SignInScreen(model: model)

        case .standing:
            if let standing = model.account?.account {
                StandingScreen(
                    model: StandingScreenModel(standing: standing),
                    identityState: model.account?.identity.state,
                    identityGeneration: model.account?.identity.generation
                ) {
                    Task { await model.signOut() }
                }
            } else {
                loading
            }

        case .onboarding:
            if let readiness = model.readiness {
                OnboardingScreen(readiness: readiness, snapshot: model.viewerSnapshot) {
                    Task { await model.refresh() }
                }
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
            } else {
                loading
            }

        case .matches:
            MatchesScreen(model: model)
        }
    }

    private var loading: some View {
        Screen(
            model.isLoading ? "Loading from the service" : "Nothing loaded yet",
            subtitle: model.isLoading
                ? "Reading the projections the service publishes."
                : "The service has not answered with an account yet."
        ) {
            if let failure = model.loadFailure {
                FailureNote(failure) { Task { await model.refresh() } }
            } else if model.isLoading {
                ProgressRing(fraction: 0.15, tint: palette.accent, size: 44)
                    .frame(maxWidth: .infinity)
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
