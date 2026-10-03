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

    @Bindable var model: AppModel

    public init(model: AppModel) {
        self.model = model
    }

    public var body: some View {
        VStack(spacing: 0) {
            content
            Divider()
            tabBar
        }
        .frame(width: phoneWidth)
        .background(Ink.canvas)
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
                    onRetry: { Task { await model.refresh() } },
                    onLike: { card in Task { await model.like(candidate: card.userId) } }
                )
            } else {
                loading
            }
        }
    }

    private var loading: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            screenTitle(model.isLoading ? "Loading from the service" : "Nothing loaded yet")
            screenSubtitle(
                model.isLoading
                    ? "Reading the projections the service publishes."
                    : "The service has not answered with an account yet."
            )
            if let failure = model.loadFailure {
                FailureNote(failure) { Task { await model.refresh() } }
            }
        }
        .padding(Space.md)
        .frame(width: phoneWidth, alignment: .leading)
    }

    private var tabBar: some View {
        HStack(spacing: 0) {
            ForEach(availableTabs) { tab in
                Button {
                    model.go(to: tab)
                } label: {
                    VStack(spacing: Space.xs) {
                        Image(systemName: tab.symbol)
                            .font(.system(size: 18))
                        Text(tab.title)
                            .font(.system(size: 11, weight: .medium))
                    }
                    .foregroundStyle(model.tab == tab ? Ink.granted : Color.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Space.sm)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .frame(width: phoneWidth)
        .background(Color.white)
    }
}