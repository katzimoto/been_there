import Foundation
import BeenThereKit

/// Where the service is, and which screen a completed load opens on.
///
/// ## Why these live beside `AppModel`
///
/// Connecting is a different question from "what may this member do", and
/// `AppModel.swift` is the file where the stored properties are: it has to stay
/// the only place `@Observable` sees them, because that macro instruments the
/// primary declaration and nothing else. Its behaviour splits across these
/// extensions by concern instead, which is what keeps each file readable.
///
/// The properties these methods write are `internal(set)` for that reason. Read
/// access is unchanged, so a view outside the module still cannot invent a
/// server answer.
extension AppModel {

    // MARK: Connecting

    /// Whether the typed address parses, and whether this button is worth
    /// offering.
    ///
    /// Derived from the text rather than tracked: a "Connect" button that is
    /// enabled for an address the app cannot use teaches the person that the app
    /// is broken.
    public var canConnect: Bool {
        AppModel.parse(serviceURLText) != nil
    }

    static func parse(_ text: String) -> ServiceEndpoint? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              url.host != nil
        else { return nil }
        return ServiceEndpoint(baseURL: url)
    }

    /// Points the app at the address on screen and loads from it.
    ///
    /// The `URLSession` is rebuilt with the endpoint because the service's base
    /// URL is fixed at client construction — see `APIClient.init`.
    public func connect() async {
        guard let parsed = AppModel.parse(serviceURLText) else { return }
        endpoint = parsed
        client = APIClient(endpoint: parsed)
        session = nil
        await resetProjections()
        authFailure = nil
        loadFailure = nil
        // Pointing at a different service is a new arrival, so the landing rule
        // applies again — see `hasChosenTab`.
        hasChosenTab = false
        tab = .signIn
        await checkService()
    }

    /// Asks the service whether it is up, before anyone types a password.
    ///
    /// `/v1/health/ready` is public and answers `503` **with a body**, which is
    /// the whole reason it exists: an app that renders "nobody to show you" when
    /// the store is unreachable is stating a falsehood. So the connection screen
    /// says which it is.
    public func checkService() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let report = try await client.readiness()
            serviceReady = report.ready
            serviceChecks = report.checks
        } catch let error as APIError {
            serviceReady = false
            serviceChecks = []
            loadFailure = error
        } catch {
            serviceReady = false
            serviceChecks = []
            loadFailure = .transport(String(describing: error))
        }
    }

    /// Which screen a completed load opens on.
    ///
    /// A reading, not a policy: each branch names a fact the server published.
    /// `standings` is checked first because a restricted member's reason for
    /// opening the app is the restriction, and sending them to an empty discovery
    /// page first would be a worse experience than saying why they are seeing it.
    static func landingTab(
        account: AccountView,
        onboarding: OnboardingViewModel?
    ) -> Tab {
        if account.account.state != .active { return .standing }
        if onboarding?.isDiscoverable == false { return .onboarding }
        return .discovery
    }

    // MARK: What the screens read

    /// The gate's input, assembled from the account projection the server sent.
    ///
    /// `nil` before a load rather than a fabricated snapshot: a gate answered
    /// from a standing the app made up would be exactly the client-side rule
    /// copy this repository refuses to have.
    public var viewerSnapshot: ViewerSnapshot? {
        guard let account else { return nil }
        return ViewerSnapshot(
            userId: account.userId,
            identity: account.identity.state,
            account: account.account
        )
    }

    /// Whether discovery is offered at all, per `ClientGate`.
    public var offersDiscovery: Bool {
        guard let snapshot = viewerSnapshot else { return false }
        return ClientGate.canBrowseDiscovery(snapshot)
    }

    /// Whether the like affordance is offered on a card, per the granted set.
    ///
    /// `DiscoveryViewModel.offersLike` is a readback of what the server granted
    /// rather than a rule of its own, so it needs a loaded page — hence the
    /// `discovery?`. Before the first load the answer is `false`: withholding an
    /// affordance the server may well grant is the safe direction, and
    /// `OnboardingViewModel.reportsGateDisagreement` is what catches the case
    /// where that turns out to be wrong.
    public func offersLike() -> Bool {
        guard let discovery, let account else { return false }
        return discovery.offersLike(account.account)
    }
}