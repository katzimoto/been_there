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
                    TabBar(tabs: availableTabs, selected: model.tab) { tab in
                        model.go(to: tab)
                    }
                }
                .frame(width: phoneWidth)
            }
        }
    }

    /// The tabs this load can serve.
    ///
    /// `signIn` is always available because it is the only way to reach anything
    /// else, and `standing` appears once a standing has been published — which
    /// includes an `active` one, because "what does the service think my account
    /// holds" is answerable for any account.
    private var availableTabs: [AppModel.Tab] {
        AppModel.Tab.allCases.filter { tab in
            switch tab {
            case .signIn: return true
            case .standing: return model.account != nil
            case .onboarding: return model.readiness != nil
            case .discovery: return model.offersDiscovery
            }
        }
    }

    @ViewBuilder
    private var content: some View {
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
                    offersLike: model.offersLike(),
                    likeOutcome: model.likeOutcome,
                    likeFailure: model.likeFailure,
                    onRetry: { Task { await model.refresh() } },
                    onLike: { card in Task { await model.like(candidate: card.userId) } }
                )
            } else {
                loading
            }
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
                    .accessibilityAddTraits(isSelected ? [.isSelected] : [])
                }
            }
            .background(palette.surface)
        }
        .frame(width: phoneWidth)
    }
}
