import XCTest
@testable import BeenThereKit

/// The client against the running service.
///
/// ## These are the only tests that need a server
///
/// Everything else in this target is pure: fixtures captured from real
/// responses, decoded without a network. This file is the other half — it proves
/// the client's *requests* are the ones the service accepts, which a fixture
/// cannot. A decoded body shows the shapes agree; nothing else shows that the
/// path, the method, the header or the body field names are right.
///
/// ## Running it
///
/// The suite skips unless `BEEN_THERE_BASE_URL` is set, so `swift test` stays
/// green on a machine with no service and turns into a real check on one that
/// has it:
///
///     make demo                                            # in one terminal
///     BEEN_THERE_BASE_URL=http://127.0.0.1:8787 swift test  # in another
///
/// Skipped rather than failed for the same reason every other client suite is
/// pure: a red build that means "start the demo" is a red build nobody reads.
///
/// ## One account for the whole class
///
/// `SIGNUP_PER_IP_PER_HOUR` and `LOGIN_ATTEMPTS_PER_WINDOW` are both 5. A suite
/// that signed up per test would exhaust the bucket partway through and every
/// later failure would be the rate limiter rather than the client. So the class
/// signs up once and signs in once, and each test gets a client holding a *copy*
/// of that session — which is also what makes the rotation assertions below test
/// this client's behaviour rather than an ordering accident.
final class LiveServiceTests: XCTestCase {

    private var endpoint: ServiceEndpoint!

    /// The one account, guarded because XCTest may run cases concurrently and a
    /// second sign-up would exhaust the per-IP bucket.
    private actor SharedAccount {
        static let shared = SharedAccount()
        private var contact: String?
        private var readOnly: IssuedSession?

        /// Records the contact the moment it is signed up, before any session
        /// exists, so a concurrent test cannot start a second sign-up and
        /// exhaust the per-IP bucket while the first is still in flight.
        func register(contact identifier: String) {
            if contact == nil { contact = identifier }
        }

        func establish(_ value: IssuedSession) {
            if readOnly == nil { readOnly = value }
        }

        /// The session every read-only test holds a copy of.
        ///
        /// Rotation is single-use, so this token is never refreshed by any test:
        /// a test that rotates it would supersede it for all the others. The tests
        /// that must rotate or revoke sign in for their own session instead.
        var held: IssuedSession? { readOnly }
        var heldContact: String? { contact }
    }

    override func setUpWithError() throws {
        try super.setUpWithError()
        guard let configured = ServiceEndpoint.fromEnvironment() else {
            throw XCTSkip("BEEN_THERE_BASE_URL is not set; these tests need a running service")
        }
        endpoint = configured
    }

    override func tearDownWithError() throws {
        endpoint = nil
        try super.tearDownWithError()
    }

    // MARK: Fixtures

    private static let password = "correct-horse-battery"

    /// Over 18, and far enough in the past that it cannot fall behind a calendar
    /// boundary during a run.
    private static let dateOfBirth = "1990-03-14"

    /// The band the service derives from `dateOfBirth`, and the whole point of
    /// `POST /v1/accounts`: the age is *derived* from a calendar date at
    /// submission, the client never sends a number, and what comes back is a band
    /// — never a date and never an exact age.
    private static let expectedBand = "33-37"

    private static func freshContact() -> String {
        "client-\(UUID().uuidString.prefix(8))@gmail.com"
    }

    /// Signs up once, signs in once, and hands that session to the read-only tests.
    ///
    /// Sign-in mints a fresh session each time rather than reusing the sign-up's,
    /// which is what makes a second one available for the tests that rotate or
    /// revoke. `LOGIN_ATTEMPTS_PER_WINDOW` is 5 and this suite uses three.
    private static func sharedAccount(for endpoint: ServiceEndpoint) async throws -> IssuedSession {
        if let existing = await SharedAccount.shared.held { return existing }
        let issued = try await ownSession(for: endpoint)
        await SharedAccount.shared.establish(issued)
        return issued
    }

    /// A session of this class's own, for a test that will rotate or revoke it.
    ///
    /// Rotation is single-use on the server, so a token cannot be shared between
    /// a test that consumes it and tests that only read with it.
    private static func ownSession(for endpoint: ServiceEndpoint) async throws -> IssuedSession {
        let contact = try await establishAccount(for: endpoint)
        let client = APIClient(endpoint: endpoint)
        let issued = try await client.signIn(contact: contact, password: password)
        return issued.issued
    }

    private static func establishAccount(for endpoint: ServiceEndpoint) async throws -> String {
        if let existing = await SharedAccount.shared.heldContact { return existing }
        let contact = freshContact()
        // Registered before the sign-up returns, so a concurrent test cannot
        // start a second one and exhaust the per-IP bucket mid-flight.
        await SharedAccount.shared.register(contact: contact)
        let client = APIClient(endpoint: endpoint)
        _ = try await client.signUp(
            contact: contact, password: password,
            dateOfBirth: dateOfBirth, termsVersion: "2026-09-01"
        )
        return contact
    }

    /// A client holding a copy of the shared session.
    private func signedIn() async throws -> APIClient {
        APIClient(
            endpoint: endpoint,
            sessionStore: MemorySessionStore(session: try await LiveServiceTests.sharedAccount(for: endpoint))
        )
    }

    /// A client with no session at all.
    private func anonymous() -> APIClient {
        APIClient(endpoint: endpoint, sessionStore: MemorySessionStore())
    }

    // MARK: Reachability, with no session

    /// Both health routes are public, so this is the one place a client can prove
    /// the transport works before it holds anything else.
    func testTheHealthRoutesAnswerWithoutASession() async throws {
        let client = anonymous()
        let live = try await client.liveness()
        XCTAssertEqual(live.status, "live")

        let ready = try await client.readiness()
        XCTAssertTrue(ready.ready, "readiness was not ready: \(ready.checks)")
        XCTAssertTrue(ready.checks.contains { $0.name == "database" && $0.ok })
    }

    // MARK: Sign-up and sign-in

    /// The whole chain in one test: sign-up returns a session, the client binds it
    /// to the user id the same response names, and the next authenticated request
    /// works because of it.
    ///
    /// This is the test that fails if `signUp` forgets to persist the credential,
    /// and it is why the model's nested `session` is bound rather than flattened:
    /// the service sends `userId` as a *sibling* of `session`, not a member.
    func testSignUpIssuesASessionThatAuthenticatesTheNextRequest() async throws {
        let client = anonymous()
        let contact = LiveServiceTests.freshContact()
        let signUp = try await client.signUp(
            contact: contact,
            password: LiveServiceTests.password,
            dateOfBirth: LiveServiceTests.dateOfBirth,
            termsVersion: "2026-09-01"
        )

        XCTAssertFalse(signUp.userId.isEmpty)
        XCTAssertFalse(signUp.session.token.isEmpty)
        // The credential was bound to this sign-up's user id, not left unbound.
        XCTAssertEqual(signUp.session.userId, signUp.userId)
        XCTAssertEqual(signUp.ageBand, LiveServiceTests.expectedBand)
        XCTAssertFalse(signUp.contactVerified)
        XCTAssertEqual(signUp.identity.state, .unverified)
        XCTAssertFalse(signUp.identity.discoverable)
        XCTAssertNotNil(signUp.session.expiresOn)
        XCTAssertNotNil(signUp.session.refreshableUntilDate)

        // The session the sign-up returned is enough to read their own account.
        let account = try await client.account(userId: signUp.userId)
        XCTAssertEqual(account.userId, signUp.userId)
        XCTAssertEqual(account.accountId, signUp.accountId)
        XCTAssertEqual(account.identity.state, .unverified)
        XCTAssertEqual(account.account.state, .active)
    }

    func testSignInIssuesASessionForTheSameAccount() async throws {
        let session = try await LiveServiceTests.sharedAccount(for: endpoint)
        XCTAssertFalse(session.token.isEmpty)
        XCTAssertFalse(session.userId.isEmpty)
        XCTAssertNotNil(session.expiresOn)

        // And that session authenticates.
        let client = try await signedIn()
        let account = try await client.account(userId: session.userId)
        XCTAssertEqual(account.userId, session.userId)
    }

    /// A wrong password and an unknown account are one refusal.
    ///
    /// `account-sessions.ts` verifies against a dummy hash so the two cost the
    /// same wall clock, and refuses an unusable identifier as a bad sign-in
    /// rather than a validation failure. A client that branched on this would
    /// reintroduce the oracle the server removed, so the assertion is that the
    /// two are **indistinguishable**.
    func testAWrongPasswordAndAnUnknownAccountAreIndistinguishable() async throws {
        let shared = SharedAccount.shared
        let held = await shared.heldContact
        let contact = try XCTUnwrap(held)
        let client = anonymous()

        let wrongPassword = try await failure {
            () -> Void in _ = try await client.signIn(contact: contact, password: "definitely-not-it")
        }
        let unknownAccount = try await failure {
            () -> Void in _ = try await client.signIn(contact: LiveServiceTests.freshContact(), password: "definitely-not-it")
        }

        XCTAssertEqual(wrongPassword, unknownAccount)
        XCTAssertEqual(wrongPassword.code, .permissionDenied)
        XCTAssertTrue(wrongPassword.isUserFacing)
        XCTAssertFalse(wrongPassword.isRetryable)
    }

    // MARK: Refresh, and the rotation the client has to keep up with

    /// Rotation is unconditional: the old row is written `superseded` in the same
    /// transaction that writes the new one. So the client must store the rotated
    /// token or every later request is refused — this fails if `refreshSession`
    /// does not.
    func testRefreshRotatesTheTokenAndTheClientKeepsPresentingTheNewOne() async throws {
        // Its own session: rotation supersedes the old token for good, so the
        // shared read-only session must not be the one that gets rotated.
        let session = try await LiveServiceTests.ownSession(for: endpoint)
        let client = APIClient(
            endpoint: endpoint, sessionStore: MemorySessionStore(session: session)
        )
        let original = try await client.currentToken()
        let originalToken = try XCTUnwrap(original)

        let rotated = try await client.refreshSession()
        XCTAssertNotEqual(rotated.token, originalToken)
        XCTAssertNotEqual(rotated.sessionId, session.sessionId)
        XCTAssertNotNil(rotated.expiresOn)

        // The client presents the new token without being told to.
        let presented = try await client.currentToken()
        XCTAssertEqual(presented, rotated.token)
        let readiness = try await client.readiness()
        XCTAssertTrue(readiness.ready)

        // The old one is dead, and the service names the reason.
        let stale = APIClient(
            endpoint: endpoint,
            sessionStore: MemorySessionStore(session: session)
        )
        let refusal = try await failure { () -> Void in _ = try await stale.refreshSession() }
        XCTAssertEqual(refusal.code, .permissionDenied)
        XCTAssertEqual(refusal.reason, "superseded")
    }

    func testRefreshingWithoutASessionIsRefusedRatherThanSent() async throws {
        let refusal = try await failure { () -> Void in _ = try await anonymous().refreshSession() }
        XCTAssertEqual(refusal, APIError.noSession)
    }

    // MARK: Sign-out

    /// Sign-out is best-effort locally and authoritative on the server: the token
    /// is discarded whatever the server says, and stops working either way.
    func testSignOutDiscardsTheTokenLocallyAndRevokesItOnTheServer() async throws {
        // Its own session, for the same reason as the rotation test.
        let session = try await LiveServiceTests.ownSession(for: endpoint)
        let client = APIClient(
            endpoint: endpoint, sessionStore: MemorySessionStore(session: session)
        )
        await client.signOut()

        // Locally there is nothing to present.
        let local = try await failure { () -> Void in _ = try await client.matches() }
        XCTAssertEqual(local, APIError.noSession)

        // And the server revoked it, so a client holding the same token is refused
        // rather than quietly working.
        let elsewhere = APIClient(
            endpoint: endpoint, sessionStore: MemorySessionStore(session: session)
        )
        let remote = try await failure { () -> Void in _ = try await elsewhere.matches() }
        XCTAssertEqual(remote.code, .permissionDenied)
        XCTAssertNotNil(remote.reason)
    }

    // MARK: The standing projection, and the gate built from it

    /// `ClientGate`'s input, assembled from one live response.
    ///
    /// Commitment 1 asserted against the projection the server actually published:
    /// an unverified member is not offered discovery, and report and block are
    /// present regardless of the identity state.
    func testTheViewerSnapshotIsBuiltFromTheLiveProjection() async throws {
        let session = try await LiveServiceTests.sharedAccount(for: endpoint)
        let viewer = try await signedIn().viewerSnapshot()

        XCTAssertEqual(viewer.userId, session.userId)
        XCTAssertEqual(viewer.identity, .unverified)
        XCTAssertEqual(viewer.account.state, .active)
        XCTAssertTrue(viewer.account.visibleInProduct)
        XCTAssertFalse(ClientGate.canBrowseDiscovery(viewer))
        XCTAssertTrue(ClientGate.canReport(viewer))
        XCTAssertTrue(ClientGate.canBlock(viewer))

        // The published projection carries no removed set, and that is reported
        // rather than invented.
        XCTAssertTrue(viewer.account.removedCapabilities.isEmpty)
        let restricted = RestrictedAccountViewModel(standing: viewer.account)
        XCTAssertFalse(restricted.removed.isKnown)
        XCTAssertNil(restricted.caseReference)
    }

    // MARK: Onboarding, and the checklist built from it

    /// The whole readiness round trip, plus the view model built from what came
    /// back. This is the test that proves the client's checklist is a rendering of
    /// the server's list rather than a reconstruction of it.
    func testTheChecklistIsBuiltFromTheLiveReadinessProjection() async throws {
        let session = try await LiveServiceTests.sharedAccount(for: endpoint)
        let client = try await signedIn()
        let readiness = try await client.onboarding(userId: session.userId)
        let model = OnboardingViewModel(readiness)

        XCTAssertEqual(readiness.userId, session.userId)
        XCTAssertFalse(readiness.discoverable)
        XCTAssertNotNil(readiness.nextStep)
        XCTAssertEqual(readiness.outstanding.first, readiness.nextStep)
        XCTAssertEqual(readiness.accountState, .active)
        XCTAssertFalse(readiness.contactVerified)
        XCTAssertTrue(readiness.ageGatePassed)
        // The band is public; the date of birth is not in the projection at all.
        XCTAssertEqual(readiness.ageBand, LiveServiceTests.expectedBand)
        let mirror = Mirror(reflecting: readiness)
        XCTAssertFalse(mirror.children.compactMap(\.label).contains("dateOfBirth"))

        // The screen reads the server's list, in the server's order.
        XCTAssertEqual(model.rows.filter { !$0.isComplete }.map(\.step), readiness.outstanding)
        XCTAssertEqual(model.rows.first(where: \.isNext)?.step, readiness.nextStep)
        XCTAssertEqual(model.rows.filter(\.isNext).count, 1)
        XCTAssertFalse(model.isDiscoverable)
        // Nothing outstanding is not "ready": the server said not discoverable.
        XCTAssertFalse(model.headline.lowercased().contains("ready to start"))
    }

    // MARK: Discovery, and its empty page

    /// An unverified member's discovery page.
    ///
    /// Commitment 1 says they see *nobody*, and the honest empty page says so
    /// without claiming a reason: `evaluateEligibility`'s reasons are `internal`
    /// and a reason a client could read would be a side channel for inferring
    /// another user's identity state, standing or block.
    func testAnUnverifiedMemberSeesAnEmptyPageAndIsToldOnlyTheirOwnNextStep() async throws {
        let session = try await LiveServiceTests.sharedAccount(for: endpoint)
        let client = try await signedIn()
        let page = try await client.discovery()
        let readiness = try await client.onboarding(userId: session.userId)
        let account = try await client.account(userId: session.userId)
        let model = DiscoveryViewModel(page: page, readiness: readiness, standing: account.account)

        XCTAssertEqual(page.viewerId, session.userId)
        XCTAssertEqual(page.total, page.candidates.count)
        // Whatever the population, an unverified member's page is empty.
        XCTAssertTrue(model.cards.isEmpty)
        XCTAssertEqual(model.content, .blocked(.notReady(readiness.nextStep ?? .identityVerification)))
        XCTAssertFalse(model.offersRetry)
        XCTAssertFalse(model.headline.lowercased().contains("error"))
        // The gate agrees the tab should not be offered at all.
        XCTAssertFalse(OnboardingViewModel.browseIsAvailable(
            viewer: ViewerSnapshot(
                userId: session.userId, identity: account.identity.state, account: account.account
            )
        ))
    }

    /// No session means no page, and the client must not turn that into "there is
    /// nobody here".
    func testAnUnauthenticatedDiscoveryRequestIsARefusalNotAnEmptyPage() async throws {
        let refusal = try await failure { _ = try await anonymous().discovery() }
        XCTAssertEqual(refusal, APIError.noSession)
        XCTAssertNotEqual(DiscoveryViewModel.failure(refusal).content, .empty)
    }

    // MARK: Profile and preferences

    func testAFreshProfileIsIncompleteAndTheServerNamesWhatIsMissing() async throws {
        let client = try await signedIn()
        let profile = try await client.profile()
        XCTAssertEqual(profile.state, .draft)
        XCTAssertFalse(profile.complete)
        XCTAssertFalse(profile.missing.isEmpty)
        let session = try await LiveServiceTests.sharedAccount(for: endpoint)
        XCTAssertEqual(profile.profileId, "profile:" + session.userId)
        // No score and no field one could be added to: the shape is closed on
        // purpose, because a percentage is a ranking signal.
        let mirror = Mirror(reflecting: profile)
        for label in ["score", "percentage", "percentComplete"] {
            XCTAssertFalse(mirror.children.compactMap(\.label).contains(label))
        }
    }

    /// Unset preferences are served rather than `404`d, because absent is not an
    /// empty filter and the distinction turns on the unset rule.
    func testUnsetPreferencesAreServedRatherThanRefused() async throws {
        let preferences = try await signedIn().preferences()
        XCTAssertTrue(preferences.isUnset)
        XCTAssertNil(preferences.preferences.ageRange)
        XCTAssertNil(preferences.preferences.maxDistanceKm)
    }

    // MARK: Refusals, read live

    /// A report with no recorded interaction. The dating domain owns the refusal
    /// and the domain in the body says so, which is what lets the client branch
    /// on the *owning* domain rather than on the route it happened to hit.
    func testAReportWithNoInteractionIsRefusedByTheDomainThatOwnsTheRule() async throws {
        let session = try await LiveServiceTests.sharedAccount(for: endpoint)
        let client = try await signedIn()
        let refusal = try await failure {
            () -> Void in _ = try await client.report(subjectUserId: session.userId, reason: "other")
        }
        XCTAssertEqual(refusal.domain, "dating.interaction")
        XCTAssertTrue(refusal.isUserFacing)
        // Not a permission refusal: reporting is unrestrictable, so the *attempt*
        // was accepted and the evidence was what was missing.
        XCTAssertNotEqual(refusal.code, .permissionDenied)
    }

    /// Another member's account is `not_found`, not `forbidden`, because a `403`
    /// would confirm the account is real.
    func testAnotherMembersAccountIsNotFoundRatherThanForbidden() async throws {
        let refusal = try await failure {
            _ = try await signedIn().account(userId: "00000000-0000-0000-0000-000000000000")
        }
        XCTAssertEqual(refusal.code, .notFound)
        XCTAssertTrue(refusal.isUserFacing)
    }

    // MARK: Helpers

    /// Runs a call and returns the `APIError` it threw.
    ///
    /// So a failing assertion names the endpoint rather than "the test", and a
    /// call that unexpectedly succeeds fails with that fact rather than
    /// unwrapping a nil into a confusing follow-on error.
    private func failure<T>(_ body: () async throws -> T) async throws -> APIError {
        do {
            _ = try await body()
            XCTFail("the call succeeded; a refusal was expected")
            return .storeFailure
        } catch let error as APIError {
            return error
        } catch {
            XCTFail("threw \(error), which is not an APIError")
            return .storeFailure
        }
    }
}