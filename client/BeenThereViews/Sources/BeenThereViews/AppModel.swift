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
        case matches
        case standing

        public var id: String { rawValue }

        public var title: String {
            switch self {
            case .signIn: return "Sign in"
            case .onboarding: return "Setup"
            case .discovery: return "People"
            case .matches: return "Matches"
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
            case .matches: return "heart"
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
    public internal(set) var endpoint: ServiceEndpoint?

    /// The client every route goes through. Module-internal rather than private
    /// because `AppModel+MemberSurfaces.swift` is an extension in another file,
    /// and `private` is scoped to the file. Not `public`: nothing outside this
    /// module may reach the session behind it.
    var client: APIClient

    // MARK: What the member typed

    public var contact: String = ""
    public var password: String = ""
    public var dateOfBirth: String = ""

    /// The terms version the repository's service was written against.
    ///
    /// Prefilled so the sign-up form is clickable, and **not** authoritative: it
    /// is a default the member can edit, and the service refuses a stale one by
    /// naming the version it wants. A refusal is how the real value arrives, so
    /// nothing here is a second copy of the server's table — it is a starting
    /// point, and the field stays editable.
    public static let currentTermsVersion = "2026-09-01"

    // MARK: What the server said

    /// The tab bar is the only thing that moves this, so it asks rather than
    /// assigning. The setter is `internal` rather than `private` for the reason
    /// the other server answers below carry — `connect()` writes it from
    /// `AppModel+Service.swift` — and it is still unwritable from outside this
    /// module, which is where "a view could invent a server answer" would bite.
    public internal(set) var tab: Tab = .signIn
    /// Whether the member has picked a tab themselves.
    ///
    /// Set by `go(to:)`, cleared by `connect()` and `signOut()`. It exists for
    /// one bug: `refresh()` used to decide the landing tab on *every* load, so a
    /// member who tapped Matches while a load was still in flight was moved back
    /// by that load finishing — the tab became tappable at the moment `session`
    /// was set, which is before any of the four GETs have answered. The same
    /// race made pull-to-refresh throw anyone who is not yet discoverable back to
    /// Setup.
    ///
    /// So the landing tab is a property of arriving, not of loading: it applies to
    /// sign-in, sign-up and a fresh connect, and to nothing the member triggered.
    /// Module-internal rather than `private(set)`: `connect()` lives in an extension in
    /// another file and `private` is scoped to the file.
    public internal(set) var hasChosenTab = false

    public func go(to tab: Tab) {
        self.tab = tab
        self.hasChosenTab = true
    }
    public internal(set) var session: IssuedSession?
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

    /// The notice the *service* publishes for the age gate, read from its readiness
    /// answer, so the sign-up screen can say why it is asking before it asks.
    /// `nil` when the service published none — the screen then shows nothing,
    /// because the alternative is this client stating the policy in its own words.
    public private(set) var preflightAgeGate: TermsDeclaration.AgeGate?

    /// Kept so a later refresh does not re-probe readiness for a session it has
    /// already read.
    private var terms: TermsDeclaration?

    /// The terms version the service says it accepts. Falls back to the last known
    /// value when readiness has not answered, so a sign-up is never blocked by a
    /// probe that has not landed.
    public private(set) var termsVersion: String = AppModel.currentTermsVersion

    /// The age band the service derived at sign-up, shown back to the member. It
    /// publishes a band and never a date, so this is the only form of the answer
    /// that exists.
    public private(set) var signUpAgeBand: String?

    /// The birth date the member picked, as a `DatePicker` holds it. The service
    /// takes `YYYY-MM-DD`; `signUpDateOfBirthISO` is what gets sent, formatted in
    /// the calendar the picker used so what is sent is what was seen.
    public var signUpDateOfBirth: Date = AppModel.defaultDateOfBirth

    /// Twenty-five years ago, so the picker opens on a plausible adult date
    /// rather than today — a screen that opens on the member's birthday reads as
    /// a form that was not filled in.
    public static let defaultDateOfBirth: Date = {
        let calendar = Calendar.current
        let now = Date()
        let year = calendar.component(.year, from: now) - 25
        let month = calendar.component(.month, from: now)
        let day = calendar.component(.day, from: now)
        return calendar.date(from: DateComponents(year: year, month: month, day: day)) ?? now
    }()

    /// The picked date as the service reads it.
    public var signUpDateOfBirthISO: String {
        let calendar = Calendar.current
        let parts = calendar.dateComponents([.year, .month, .day], from: signUpDateOfBirth)
        return String(format: "%04d-%02d-%02d",
                      parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    /// Whether the sign-up form holds everything the service requires.
    ///
    /// Shape only: a contact, a password of some length, and a date. Deliberately
    /// *not* a local age check and not a local password policy — those are the
    /// service's rules, and a client that pre-judged them would be a second
    /// definition that drifts. What is refused here is an obviously empty field.
    public var canSubmitSignUp: Bool {
        !contact.trimmingCharacters(in: .whitespaces).isEmpty
            && !password.isEmpty
            && !isLoading
    }

    /// `internal(set)` rather than `private(set)` for the reason the member-surface
    /// properties carry: their mutating half is in `AppModel+MemberSurfaces.swift`
    /// and `private` is file-scoped. Outside this module it is still read-only.
    public internal(set) var isLoading = false
    /// A failure from the last load, not from the last sign-in attempt.
    public internal(set) var loadFailure: APIError?
    /// A failure from the last sign-in or sign-up attempt.
    public internal(set) var authFailure: APIError?

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


    public internal(set) var serviceReady: Bool?
    public internal(set) var serviceChecks: [ReadinessReport.Check] = []

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
                dateOfBirth: signUpDateOfBirthISO,
                termsVersion: termsVersion
            )
            ageGateNotice = result.ageGate
            signUpAgeBand = result.ageBand
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
        // Signing out ends this member's session, so the next one has not chosen a
        // tab yet: the landing rule applies to it as it does to a first arrival.
        hasChosenTab = false
        tab = .signIn
    }

    // MARK: Matches, conversations and safety
    //
    // These are `internal(set)` rather than `private(set)` for the same reason
    // `client` is: their mutating half lives in `AppModel+MemberSurfaces.swift`,
    // and `private` is scoped to the file. Read access stays `public`, so
    // outside this module they are exactly as before — readable, not writable.

    /// `GET /v1/matches`, as published.
    public internal(set) var matches: MatchList?
    /// The matches load's own failure, kept apart from the standing's.
    public internal(set) var matchesFailure: APIError?

    /// A conversation the app has an id for, and the match it belongs to.
    ///
    /// ## Where the conversation id comes from
    ///
    /// `GET /v1/matches` publishes it per row, resolved through the
    /// participant-scoped `conversations.findByMatch`, so a member is told about
    /// a conversation only when they are in it. Nothing here derives it and
    /// nothing here remembers it: `match.conversationId` is the id, or there is
    /// no conversation and the row says so rather than offering a button that
    /// would be answered `404`.
    public struct Conversation: Identifiable {
        public let match: MatchRecord
        /// The other participant, derived from `participants` and the viewer's
        /// own id. `MatchRecord` names both; the client knows which one it is.
        public let counterpartId: String
        public let conversationId: String

        public var id: String { conversationId }
    }

    /// The chat on screen, or `nil` when the member is on a tab.
    public internal(set) var chat: Conversation?
    public internal(set) var messages: MessagePage?
    public internal(set) var messagesFailure: APIError?
    /// What the member has typed, held here so closing the chat discards it.
    public var draft: String = ""

    /// The refusal from the last block or report, and what the last one returned.
    public internal(set) var safetyFailure: APIError?
    public internal(set) var lastReport: ReportResult?
    public internal(set) var lastBlock: BlockResult?

    /// Takes a session and reads everything the session can reach.
    ///
    /// The destination after a load is `refresh`'s, not this one's: one rule
    /// decides where the app opens, and it runs on every load rather than only on
    /// sign-in. A second rule here would be two answers to one question.
    private func adopt(_ issued: IssuedSession) async {
        session = issued
        await refresh()
    }

    // MARK: Loading

    /// Reloads everything the screens show, from three routes.
    ///
    /// `GET /v1/accounts/:userId` carries the standing and the identity status,
    /// `GET /v1/accounts/:userId/onboarding` carries the checklist,
    /// `GET /v1/discovery` carries the page and `GET /v1/matches` the matches.
    /// The first two are read once and the other two are built from them,
    /// because `DiscoveryViewModel` refuses to be built from a page alone: its
    /// empty-page copy depends on the member's own visibility and readiness, and
    /// a screen that guessed would invent a fact.
    ///
    /// Matches are loaded here rather than on demand because a like changes them
    /// — `POST /v1/interactions/likes` may create a match, and a block ends one
    /// — and both go through `refresh()`.
    public func refresh() async {
        // The readiness probe runs before any session exists: the sign-up screen
        // needs the age-gate notice and the accepted terms version, and both are
        // public answers. A failure here is not a load failure — nothing on screen
        // depends on it, so it is silently absent rather than an error the member
        // cannot act on.
        if preflightAgeGate == nil, let report = try? await client.readiness() {
            terms = report.terms
            if let terms = report.terms {
                preflightAgeGate = terms.ageGate
                termsVersion = terms.currentVersion
            }
        }
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

            if let terms = terms {
                preflightAgeGate = terms.ageGate
                termsVersion = terms.currentVersion
            }
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

            do {
                matches = try await api.matches()
                matchesFailure = nil
            } catch let error as APIError {
                // The same reasoning as discovery: the standing, the checklist and
                // the page all arrived, and one route failing is not the whole
                // load having failed.
                matchesFailure = error
            } catch {
                matchesFailure = .transport(String(describing: error))
            }

            // Only when the member has not already chosen. A load they asked for —
            // pull to refresh, a like, the checklist's refresh — updates what is on
            // screen and must not move them off the tab they are reading.
            if !hasChosenTab {
                tab = AppModel.landingTab(account: loadedAccount, onboarding: self.onboarding)
            }
        } catch let error as APIError {
            loadFailure = error
        } catch {
            loadFailure = .transport(String(describing: error))
        }
    }

    /// Forgets everything the previous session was showing.
    ///
    /// Called by `connect()` and `signOut()`. Everything the previous session
    /// was showing goes with it, including the open chat.
    func resetProjections() async {
        account = nil
        readiness = nil
        onboarding = nil
        discovery = nil
        standing = nil
        ageGateNotice = nil
        loadFailure = nil
        matches = nil
        matchesFailure = nil
        closeChat()
        safetyFailure = nil
        lastReport = nil
        lastBlock = nil
    }

}