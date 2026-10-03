import Foundation
import Observation
import BeenThereKit

/// Everything the shared screens bind to.
///
/// ## What this type decides, and what it does not
///
/// It owns three things: **which tab is showing**, **what the last load
/// returned**, and **which service is being asked**. Everything visible is a
/// view model from `BeenThereKit` built out of a server response — this file
/// never computes a rule, filters a list, or decides that a member may do
/// something.
///
/// The one piece of routing it does own is *which tab to land on after a load*,
/// and that is a reading of the server's own answers rather than a policy:
///
///   * an account that is not `active` goes to Standing, because the restriction
///     screen is the reason the member opened the app;
///   * a member who is not yet discoverable goes to Onboarding, because
///     `OnboardingReadiness.nextStep` is the server naming the thing to do;
///   * otherwise Discovery, which is the product.
///
/// ## Why it holds an `APIClient` and not a protocol
///
/// A client-side protocol over `APIClient` would be a second description of the
/// service's routes, and the only implementation would be the one below. The
/// tests exercise this type against a running service rather than against a
/// double, so there is nothing a protocol would let them do that they cannot do
/// already — see `AppModelLiveTests`.

@MainActor
@Observable
public final class AppModel {

    /// The screens, in the order the tab bar shows them.
    public enum Tab: String, CaseIterable, Identifiable, Sendable {
        case signIn
        case onboarding
        case discovery
        case standing

        public var id: String { rawValue }

        public var title: String {
            switch self {
            case .signIn: return "Sign in"
            case .onboarding: return "Setup"
            case .discovery: return "People"
            case .standing: return "Account"
            }
        }

        /// The glyph. SF Symbols, because both platforms resolve them and an
        /// image asset would have to be shipped twice.
        public var symbol: String {
            switch self {
            case .signIn: return "person.crop.circle"
            case .onboarding: return "checklist"
            case .discovery: return "person.2"
            case .standing: return "person.text.rectangle"
            }
        }
    }

    // MARK: Where the service is

    /// Typed by the person using the app, and shown on screen.
    ///
    /// A value rather than a build-time constant because the service picks a
    /// port and prints it — `ServiceEndpoint`'s own comment says so — and an
    /// app that could only talk to one hard-coded address would be untestable
    /// against anything else.
    public var serviceURLText: String

    /// The endpoint as last applied. `nil` until `connect()` has parsed the text
    /// into a URL, so a screen never claims to be pointed somewhere it is not.
    public private(set) var endpoint: ServiceEndpoint?

    private var client: APIClient

    // MARK: What the member typed

    public var contact: String = ""
    public var password: String = ""
    public var dateOfBirth: String = ""
    public var termsVersion: String = AppModel.currentTermsVersion

    /// The terms version the repository's service was written against.
    ///
    /// Prefilled so the sign-up form is clickable, and **not** authoritative: it
    /// is a default the member can edit, and the service refuses a stale one by
    /// naming the version it wants. A refusal is how the real value arrives, so
    /// nothing here is a second copy of the server's table — it is a starting
    /// point, and the field stays editable.
    public static let currentTermsVersion = "2026-09-01"

    // MARK: What the server said

    public private(set) var tab: Tab = .signIn
    /// The tab bar is the only thing that moves this, so it asks rather than
    /// assigning: `tab` stays `private(set)` because every other field here is
    /// something the server said, and a view that could write one of those would
    /// be able to invent a server answer.
    public func go(to tab: Tab) {
        self.tab = tab
    }
    public private(set) var session: IssuedSession?
    public private(set) var account: AccountView?
    public private(set) var readiness: OnboardingReadiness?
    public private(set) var onboarding: OnboardingViewModel?
    public private(set) var discovery: DiscoveryViewModel?
    public private(set) var standing: RestrictedAccountViewModel?
    /// The sign-up response's own age-gate notice, shown verbatim.
    ///
    /// The server writes this copy. The app has an opinion about nothing here,
    /// so the notice is carried and displayed rather than paraphrased.
    public private(set) var ageGateNotice: SignUpResult.AgeGateNotice?

    public private(set) var isLoading = false
    /// A failure from the last load, not from the last sign-in attempt.
    public private(set) var loadFailure: APIError?
    /// A failure from the last sign-in or sign-up attempt.
    public private(set) var authFailure: APIError?

    // MARK: Lifecycle

    /// - Parameter endpoint: where the service is. `nil` — the default — reads
    ///   `BEEN_THERE_BASE_URL` and falls back to the port `make demo` prints, so
    ///   the app runs against the service a developer already started.
    public init(endpoint: ServiceEndpoint? = nil) {
        let resolved = endpoint
            ?? ServiceEndpoint.fromEnvironment()
            ?? .localhost(port: AppModel.demoPort)
        self.endpoint = resolved
        self.serviceURLText = resolved.baseURL.absoluteString
        self.client = APIClient(endpoint: resolved)
    }

    /// The port `make demo` prints. A named constant rather than a literal at the
    /// call site, so the default and the printed URL cannot drift apart.
    public static let demoPort = 8787

    // MARK: Connecting

    /// Whether the typed address parses, and whether this button is worth
    /// offering.
    ///
    /// Derived from the text rather than tracked: a "Connect" button that is
    /// enabled for an address the app cannot use teaches the person that the
    /// app is broken.
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

    public private(set) var serviceReady: Bool?
    public private(set) var serviceChecks: [ReadinessReport.Check] = []

    // MARK: Signing in

    public var canSubmitCredentials: Bool {
        !contact.trimmingCharacters(in: .whitespaces).isEmpty
            && !password.isEmpty
            && !isLoading
    }

    public func signIn() async {
        authFailure = nil
        isLoading = true
        defer { isLoading = false }
        do {
            let issued = try await client.signIn(contact: contact, password: password)
            await adopt(issued.issued)
        } catch let error as APIError {
            authFailure = error
        } catch {
            authFailure = .transport(String(describing: error))
        }
    }

    /// Creates the account, then reads its own projections.
    ///
    /// The sign-up response is not treated as a load: it carries the identity
    /// state and the age-gate notice, but not the standing or the checklist, so
    /// the follow-up `refresh()` is what actually fills the screens.
    public func signUp() async {
        authFailure = nil
        isLoading = true
        defer { isLoading = false }
        do {
            let result = try await client.signUp(
                contact: contact,
                password: password,
                dateOfBirth: dateOfBirth,
                termsVersion: termsVersion
            )
            ageGateNotice = result.ageGate
            await adopt(result.session)
        } catch let error as APIError {
            authFailure = error
        } catch {
            authFailure = .transport(String(describing: error))
        }
    }

    /// Records a like, then reloads.
    ///
    /// The reload is not optional. `POST /v1/interactions/likes` is a `201`
    /// whether or not it matched — the like exists either way and the route
    /// answers with `match: null` — so the page after a like is a *different
    /// page*, not the same one with a new badge on it. Re-fetching is the only
    /// way to show what the server now serves.
    ///
    /// `likeOutcome` carries the resolution the server returned, including
    /// `match_refused` with its reason. That is the domain's own word for it and
    /// it is shown as such, because "the service refused this like" and "the
    /// like was sent" are different answers and the screen must not merge them.
    public func like(candidate userId: String) async {
        guard session != nil else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let result = try await client.like(userId: userId)
            likeOutcome = result.resolution
            await refresh()
        } catch let error as APIError {
            likeFailure = error
        } catch {
            likeFailure = .transport(String(describing: error))
        }
    }

    /// The last like's resolution, in the domain's vocabulary.
    public private(set) var likeOutcome: LikeResult.Resolution?
    /// The last like's failure, kept apart from the load's.
    public private(set) var likeFailure: APIError?

    public func signOut() async {
        await client.signOut()
        session = nil
        password = ""
        await resetProjections()
        tab = .signIn
    }

    private func adopt(_ issued: IssuedSession) async {
        session = issued
        await refresh()
    }

    // MARK: Loading

    /// Reloads everything the screens show, from three routes.
    ///
    /// `GET /v1/accounts/:userId` carries the standing and the identity status,
    /// `GET /v1/accounts/:userId/onboarding` carries the checklist, and
    /// `GET /v1/discovery` carries the page. The first two are read once and the
    /// third is built from them, because `DiscoveryViewModel` refuses to be built
    /// from a page alone: its empty-page copy depends on the member's own
    /// visibility and readiness, and a screen that guessed would invent a fact.
    public func refresh() async {
        guard let held = session else { return }
        let api = client
        isLoading = true
        loadFailure = nil
        defer { isLoading = false }

        do {
            async let accountResponse = api.account(userId: held.userId)
            async let readinessResponse = api.onboarding(userId: held.userId)
            let loadedAccount = try await accountResponse
            let loadedReadiness = try await readinessResponse

            account = loadedAccount
            readiness = loadedReadiness
            standing = RestrictedAccountViewModel(standing: loadedAccount.account)
            onboarding = OnboardingViewModel(loadedReadiness)

            do {
                let page = try await api.discovery()
                discovery = DiscoveryViewModel(
                    page: page,
                    readiness: loadedReadiness,
                    standing: loadedAccount.account
                )
            } catch let error as APIError {
                // Kept as a *page* failure rather than replacing the whole load:
                // the standing and the checklist did arrive, and rendering them
                // as "we could not load this" would hide two answers the member
                // is entitled to.
                discovery = .failure(error)
            }

            tab = AppModel.landingTab(account: loadedAccount, onboarding: self.onboarding)
        } catch let error as APIError {
            loadFailure = error
        } catch {
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

    private func resetProjections() async {
        account = nil
        readiness = nil
        onboarding = nil
        discovery = nil
        standing = nil
        ageGateNotice = nil
        loadFailure = nil
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