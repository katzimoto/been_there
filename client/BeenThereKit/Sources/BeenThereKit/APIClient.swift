import Foundation

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Where the service lives. A value rather than a constant because the demo
/// service picks a port and prints it, and a client that hard-coded `localhost`
/// would be untestable against anything else.
public struct ServiceEndpoint: Sendable, Equatable {
    public let baseURL: URL

    public init(baseURL: URL) {
        self.baseURL = baseURL
    }

    /// `http://127.0.0.1:8787` — the port `make demo` prints.
    public static func localhost(port: Int) -> ServiceEndpoint {
        ServiceEndpoint(baseURL: URL(string: "http://127.0.0.1:\(port)")!)
    }

    /// Reads `BEEN_THERE_BASE_URL`, so a live test can point at the running
    /// service without a rebuild and without an argument threaded through.
    public static func fromEnvironment(
        _ environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> ServiceEndpoint? {
        guard let raw = environment["BEEN_THERE_BASE_URL"],
              let url = URL(string: raw) else { return nil }
        return ServiceEndpoint(baseURL: url)
    }
}

/// The session the client presents, and the one it refreshes.
///
/// Rotation is unconditional on the server: the old row is written `superseded`
/// in the same transaction that writes the new one, so a token is single-use.
/// A client that kept two would present a dead one on the next call and get a
/// `permission_denied` with `reason: "superseded"`, which is exactly what the
/// store-then-replace shape below is built to avoid.
public protocol SessionStoring: Sendable {
    func current() async throws -> IssuedSession?
    /// Persists a freshly rotated session. Throwing here must not lose the new
    /// token: the caller holds it and can try again.
    func store(_ session: IssuedSession) async throws
    func clear() async
}

/// An in-memory store, which is what a test and a single process use.
///
/// Not a cache: it is the authority for *this device's* session, and `clear` is
/// what a sign-out calls. A persistent store would have to protect the token at
/// rest, and that is a different product decision than this file makes.
public actor MemorySessionStore: SessionStoring {
    private var session: IssuedSession?

    public init(session: IssuedSession? = nil) {
        self.session = session
    }

    public func current() async throws -> IssuedSession? { session }
    public func store(_ session: IssuedSession) async throws { self.session = session }
    public func clear() async { session = nil }
}

/// The API client.
///
/// Every method is a thin call over one route, and **none of them decides
/// anything**. There is no eligibility check, no permission check and no
/// discovery filter in this file, because every one of those is the server's
/// answer and a second copy would drift. What the client does own is the error
/// taxonomy and session rotation, both of which the server cannot do for it.
public actor APIClient {
    private let endpoint: ServiceEndpoint
    private let session: URLSession
    private let store: any SessionStoring
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    public init(
        endpoint: ServiceEndpoint,
        sessionStore: any SessionStoring = MemorySessionStore(),
        urlSession: URLSession? = nil
    ) {
        self.endpoint = endpoint
        self.store = sessionStore
        if let urlSession {
            self.session = urlSession
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.httpAdditionalHeaders = ["accept": "application/json"]
            self.session = URLSession(configuration: configuration)
        }
        // Timestamps stay as strings in the models on purpose: every projection
        // carries them as `toISOString()` output, and decoding them into a `Date`
        // here would change the bytes on any round trip for no benefit.
        self.decoder = JSONDecoder()
        self.encoder = JSONEncoder()
    }

    // MARK: Sessions

    /// `POST /v1/account-sessions` — sign in with a contact and a password.
    ///
    /// Every failure returns the same refusal: a wrong password, an unknown
    /// account and an unusable identifier are one `permission_denied` with one
    /// message, and `account-sessions.ts` verifies the password against a dummy
    /// hash so all three cost the same wall clock. A client that branched on that
    /// refusal would reintroduce the oracle the server removed.
    @discardableResult
    public func signIn(contact: String, password: String) async throws -> SignInSession {
        let issued: SignInSession = try await publicRequest(
            "POST",
            "/v1/account-sessions",
            body: SignInBody(contact: contact, password: password)
        )
        try await store.store(issued.issued)
        return issued
    }

    /// `POST /v1/accounts` — sign up.
    ///
    /// There is deliberately no `age` parameter. `readSignUpInput` refuses a body
    /// carrying `age` or `ageYears` by name, and giving this method a parameter
    /// the server rejects would be an affordance that always fails.
    @discardableResult
    public func signUp(
        contact: String,
        password: String,
        dateOfBirth: String,
        termsVersion: String
    ) async throws -> SignUpResult {
        let result: SignUpResult = try await publicRequest(
            "POST",
            "/v1/accounts",
            body: SignUpBody(
                contact: contact,
                password: password,
                dateOfBirth: dateOfBirth,
                termsVersion: termsVersion
            )
        )
        try await store.store(result.session)
        return result
    }

    /// `POST /v1/account-sessions/refresh`.
    ///
    /// The rotation is unconditional, so the caller must not retry a refresh it
    /// already sent: the second attempt presents a token the first superseded.
    /// This is the one place where "retry on network failure" is wrong, and the
    /// reason is a property of the server rather than of this code.
    @discardableResult
    public func refreshSession() async throws -> IssuedSession {
        guard let held = try await store.current() else { throw APIError.noSession }
        let rotated: IssuedSession = try await publicRequest(
            "POST",
            "/v1/account-sessions/refresh",
            body: TokenBody(token: held.token)
        )
        // Stored only once the server has answered, so a failed rotation leaves
        // the old token in place rather than replacing it with nothing.
        try await store.store(rotated)
        return rotated
    }

    /// `DELETE /v1/account-sessions` — sign out of this device.
    ///
    /// Best-effort by design: the token is discarded locally whatever the server
    /// says, and reporting a failure here would leave a user believing they are
    /// still signed in on a device that no longer holds a usable token.
    public func signOut() async {
        let token = try? await store.current()?.token
        await store.clear()
        guard let token else { return }
        _ = try? await requestDiscard(
            method: "DELETE",
            path: "/v1/account-sessions",
            body: TokenBody(token: token),
            authenticated: false
        )
    }

    // MARK: Standing

    /// The token this client would present, or `nil` when it holds no session.
    ///
    /// Exposed so a caller can see that a rotation was stored rather than to let
    /// one build a request by hand. `signOut` is the only other way to drop it.
    public func currentToken() async throws -> String? {
        try await store.current()?.token
    }

    /// `GET /v1/accounts/:userId`.
    ///
    /// Owner-only in effect: the route answers `404` for someone else's account
    /// and for one that does not exist alike, because a `403` would confirm the
    /// account is real. `viewerSnapshot` below is the shape `ClientGate` wants,
    /// built from this response and nothing else.
    public func account(userId: String) async throws -> AccountView {
        try await request("GET", "/v1/accounts/\(userId)")
    }

    /// `ClientGate`'s input, assembled from the one projection the server publishes.
    ///
    /// `AccountStanding.removedCapabilities` is left at its empty default, because
    /// `AccountStandingProjection` does not publish it. The server's
    /// `AccountStandingRow` carries `caseId` and `decisionId`, but neither reaches
    /// any response body — so the client has nothing to fill them from and does
    /// not invent anything. See the handoff note.
    public func viewerSnapshot() async throws -> ViewerSnapshot {
        let held = try await requireSession()
        let view = try await account(userId: held.userId)
        return ViewerSnapshot(
            userId: view.userId,
            identity: view.identity.state,
            account: view.account
        )
    }

    /// `GET /v1/accounts/:userId/onboarding` — the readiness checklist.
    public func onboarding(userId: String) async throws -> OnboardingReadiness {
        try await request("GET", "/v1/accounts/\(userId)/onboarding")
    }

    /// `GET /v1/health/ready`.
    ///
    /// A `503` with the same body is the *answer* here, not a failed request: the
    /// endpoint exists precisely so a probe can be answered while the database is
    /// unreachable. Throwing away that body would make readiness
    /// indistinguishable from the network being down.
    public func readiness() async throws -> ReadinessReport {
        try await unauthenticatedRequest("GET", "/v1/health/ready")
    }

    /// `GET /v1/health/live`.
    public func liveness() async throws -> LivenessReport {
        try await unauthenticatedRequest("GET", "/v1/health/live")
    }

    // MARK: Discovery

    /// `GET /v1/discovery`.
    ///
    /// The response is filtered by the server's `evaluateEligibility` and carries
    /// no reason for any absence. This returns it as published: no client-side
    /// filter, and no attempt to explain an empty page from a rule the client
    /// would have to re-derive.
    public func discovery(limit: Int = 20, offset: Int = 0) async throws -> DiscoveryPage {
        try await request("GET", "/v1/discovery?limit=\(limit)&offset=\(offset)")
    }

    // MARK: Profile

    /// `GET /v1/profiles/me`.
    public func profile() async throws -> ProfileCompleteness {
        try await request("GET", "/v1/profiles/me")
    }

    /// `GET /v1/profiles/me/preferences`.
    public func preferences() async throws -> PreferencesEnvelope {
        try await request("GET", "/v1/profiles/me/preferences")
    }

    // MARK: Interactions

    /// `POST /v1/interactions/likes`.
    ///
    /// `likeId` is the caller's idempotency key and travels on the request: the
    /// port's idempotence is on `(from, to, likeId)`, so a server-minted id would
    /// make a transport retry a *second* like. Passing `nil` is right for a first
    /// attempt and wrong for a retry, which is the caller's decision.
    @discardableResult
    public func like(userId: String, likeId: String? = nil) async throws -> LikeResult {
        var body = LikeBody(toUserId: userId)
        if let likeId { body.likeId = likeId }
        return try await request("POST", "/v1/interactions/likes", body: body)
    }

    /// `POST /v1/interactions/passes`.
    public func pass(userId: String) async throws {
        try await requestDiscard(
            method: "POST",
            path: "/v1/interactions/passes",
            body: CounterpartBody(toUserId: userId),
            authenticated: true
        )
    }

    /// `POST /v1/blocks`.
    @discardableResult
    public func block(userId: String) async throws -> BlockResult {
        try await request("POST", "/v1/blocks", body: BlockBody(blockedUserId: userId))
    }

    /// `POST /v1/reports`.
    ///
    /// A report outlives the relationship on the server: `evidenceForReport` reads
    /// the retained records, so this works after an unmatch. That is why there is
    /// no "is the relationship current?" check here, and why there must not be.
    @discardableResult
    public func report(
        subjectUserId: String,
        reason: String,
        statement: String? = nil,
        anonymous: Bool = false
    ) async throws -> ReportResult {
        try await request(
            "POST",
            "/v1/reports",
            body: ReportBody(
                subjectUserId: subjectUserId,
                reason: reason,
                statement: statement,
                anonymous: anonymous
            )
        )
    }

    // MARK: Matches and conversations

    /// `GET /v1/matches`.
    public func matches() async throws -> MatchList {
        try await request("GET", "/v1/matches")
    }

    /// `GET /v1/conversations/:conversationId/messages`.
    public func messages(conversationId: String) async throws -> MessagePage {
        try await request("GET", "/v1/conversations/\(conversationId)/messages")
    }

    /// `POST /v1/conversations/:conversationId/messages`.
    ///
    /// The route calls `sendMessage` and passes its answer through; it does not
    /// re-check the conversation, the block or the sender. That is why this method
    /// has no local guard either — `ClientGate.canSendMessage` decides whether to
    /// *offer* the composer, and this is where the server decides whether the send
    /// happens. Both read the same published standing; neither re-derives it.
    @discardableResult
    public func sendMessage(
        conversationId: String,
        body: String
    ) async throws -> MessagePage.Message {
        let page: MessagePage = try await request(
            "POST",
            "/v1/conversations/\(conversationId)/messages",
            body: MessageBody(body: body)
        )
        // The response is the whole page, so a caller that wants its own message
        // reads it off the send. An empty page after a successful send is not a
        // shape the service produces, and is surfaced as one rather than invented.
        guard let sent = page.messages.last else {
            throw APIError.undecodable("the send succeeded but carried no message")
        }
        return sent
    }

    // MARK: Transport

    private func requireSession() async throws -> IssuedSession {
        guard let held = try await store.current() else { throw APIError.noSession }
        return held
    }

    /// A request carrying the session, with no body.
    private func request<Response: Decodable>(_ method: String, _ path: String) async throws -> Response {
        try await decode(
            Response.self,
            from: perform(method, path, bodyData: nil, authenticated: true),
            path: path
        )
    }

    /// A request carrying the session, with a body.
    private func request<Response: Decodable, Body: Encodable>(
        _ method: String,
        _ path: String,
        body: Body
    ) async throws -> Response {
        try await decode(
            Response.self,
            from: perform(method, path, bodyData: try encoder.encode(body), authenticated: true),
            path: path
        )
    }

    /// A request carrying no session.
    ///
    /// Sign-up, sign-in, refresh and this-device sign-out are the four routes the
    /// service marks `public`, and holding a token is the thing a caller is either
    /// trying to get or trying to get back. They are named here rather than
    /// passing `false` around, so a new public route reads as deliberate.
    private func unauthenticatedRequest<Response: Decodable>(
        _ method: String,
        _ path: String
    ) async throws -> Response {
        try await decode(
            Response.self,
            from: perform(method, path, bodyData: nil, authenticated: false),
            path: path
        )
    }

    /// A request carrying no session, with a body.
    private func publicRequest<Response: Decodable, Body: Encodable>(
        _ method: String,
        _ path: String,
        body: Body
    ) async throws -> Response {
        try await decode(
            Response.self,
            from: perform(method, path, bodyData: try encoder.encode(body), authenticated: false),
            path: path
        )
    }

    /// A request whose body the caller has no use for.
    ///
    /// Separate from `request` rather than returning `Data`, because a `Void`
    /// signature is what stops a caller from reaching into a response body the
    /// route never documented.
    private func requestDiscard<Body: Encodable>(
        method: String,
        path: String,
        body: Body,
        authenticated: Bool
    ) async throws {
        _ = try await perform(method, path, bodyData: try encoder.encode(body), authenticated: authenticated)
    }

    private func decode<Response: Decodable>(
        _ type: Response.Type,
        from data: Data,
        path: String
    ) throws -> Response {
        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            throw APIError.undecodable("\(Response.self) could not be read from \(path): \(error)")
        }
    }

    private func perform(
        _ method: String,
        _ path: String,
        bodyData: Data?,
        authenticated: Bool
    ) async throws -> Data {
        guard let url = URL(string: path, relativeTo: endpoint.baseURL) else {
            throw APIError.undecodable("\(path) is not a valid path against \(endpoint.baseURL)")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        if let bodyData {
            request.httpBody = bodyData
            request.setValue("application/json", forHTTPHeaderField: "content-type")
        }
        if authenticated {
            request.setValue("Bearer \(try await requireSession().token)", forHTTPHeaderField: "authorization")
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            // No response was produced, so the answer is genuinely unknown.
            // Deliberately not a refusal: "we could not reach the service" and
            // "the service said no" must never render the same way.
            throw APIError.transport(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else {
            throw APIError.transport("the response carried no HTTP status")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw failure(status: http.statusCode, data: data)
        }
        return data
    }

    /// Turns a non-2xx into the taxonomy the service publishes.
    ///
    /// The status is read *and* the body, because the two together are what
    /// distinguishes a refusal from a fault: a `503` carrying
    /// `{ code: "store_unavailable", domain: "service.store" }` is a store fault,
    /// while a `503` carrying a domain code is `external_dependency_failed` —
    /// somebody else's provider, which `failure.ts` maps to `503` precisely
    /// because the caller's retry is the fix.
    private func failure(status: Int, data: Data) -> APIError {
        guard let body = try? decoder.decode(FailureBody.self, from: data) else {
            // A non-2xx with an unreadable body is still classifiable by status,
            // and refusing to classify it would drop the caller into
            // `undecodable` and lose the fact that the server answered at all.
            return status >= 500 ? .storeUnavailable : .storeFailure
        }
        // The two store codes are not a domain's decision, so they never become a
        // `Refusal`: that would put `service.store` into a field reserved for the
        // domain that refused, and would give a storage fault a message.
        switch body.error.code {
        case "store_unavailable":
            return .storeUnavailable
        case "store_failure":
            return .storeFailure
        default:
            break
        }
        if let refusal = body.refusal {
            // `body.refusal` forwards the server's own `retryable` flag.
            return .refused(refusal)
        }
        // A code this build does not know is still classified by status, and the
        // server's domain, message and details are preserved rather than dropped
        // for having an unfamiliar code — on a 4xx it is still a refusal, and on
        // a 5xx still an outage.
        return status >= 500 ? .storeUnavailable : .refused(
            Refusal(
                code: .internalError,
                domain: body.error.domain,
                message: body.error.message,
                details: body.details,
                retryable: body.error.retryable
            )
        )
    }
}

// MARK: - Request bodies
//
// Private and separate from the models because these are the only shapes the
// client *sends*, and a request type a view model could also construct is a
// request type a view model will eventually get wrong.

private struct SignInBody: Encodable {
    let contact: String
    let password: String
}

private struct SignUpBody: Encodable {
    let contact: String
    let password: String
    let dateOfBirth: String
    let termsVersion: String
}

private struct TokenBody: Encodable {
    let token: String
}

private struct LikeBody: Encodable {
    let toUserId: String
    var likeId: String?
}

private struct CounterpartBody: Encodable {
    let toUserId: String
}

private struct BlockBody: Encodable {
    let blockedUserId: String
}

private struct ReportBody: Encodable {
    let subjectUserId: String
    let reason: String
    let statement: String?
    let anonymous: Bool
}

private struct MessageBody: Encodable {
    let body: String
}