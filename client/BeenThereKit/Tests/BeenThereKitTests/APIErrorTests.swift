import XCTest
@testable import BeenThereKit

/// The taxonomy, against the bodies the running service returned.
///
/// The fixtures are real responses. The distinction under test is the one
/// `failure.ts` exists to draw: a refusal is a `4xx` carrying the domain's own
/// code with `retryable: false`, and a store fault is a `5xx` carrying no message.
final class APIErrorTests: XCTestCase {

    // MARK: A refusal is an answer

    /// Verbatim from a real sign-in with the wrong password: a `403`, one code,
    /// `retryable: false`, and no detail naming the account.
    func testAWrongPasswordIsARefusalCarryingTheDomainsOwnCode() throws {
        let body = """
        { "error": {
            "code": "permission_denied",
            "domain": "service.accounts",
            "message": "That sign-in did not work.",
            "retryable": false
        } }
        """
        let failure = try decodeFailure(status: 403, body: body)
        XCTAssertEqual(failure.code, .permissionDenied)
        XCTAssertEqual(failure.domain, "service.accounts")
        XCTAssertTrue(failure.isUserFacing)
        XCTAssertFalse(failure.isRetryable)
    }

    /// The sign-up validation refusals, which carry the copy §9 specifies. A
    /// client that renders `message` shows the product's own words rather than
    /// an error string it invented.
    func testValidationRefusalsCarryTheCopyAndTheFieldTheyAreAbout() throws {
        let email = try decodeFailure(status: 400, body: """
        { "error": {
            "code": "validation_failed",
            "domain": "platform.credentials",
            "message": "Use a personal email address, or continue with a phone number instead.",
            "retryable": false,
            "details": { "field": "contactIdentifier", "title": "We can't use that email address.",
                         "reason": "domain_not_allowed" }
        } }
        """)
        XCTAssertEqual(email.code, .validationFailed)
        XCTAssertEqual(email.field, "contactIdentifier")
        XCTAssertEqual(email.reason, "domain_not_allowed")
        XCTAssertTrue(email.isUserFacing)

        let phone = try decodeFailure(status: 400, body: """
        { "error": {
            "code": "validation_failed",
            "domain": "platform.credentials",
            "message": "a phone number must be E.164",
            "retryable": false,
            "details": { "field": "contactIdentifier" }
        } }
        """)
        XCTAssertEqual(phone.field, "contactIdentifier")
        XCTAssertNil(phone.reason)
    }

    /// An unauthenticated request. The domain is the one that resolved the
    /// session, not the route that was hit, so it is read rather than assumed.
    func testAMissingSessionIsARefusalNotAFault() throws {
        let failure = try decodeFailure(status: 403, body: """
        { "error": {
            "code": "permission_denied",
            "domain": "service.accounts",
            "message": "this request carries no recognised session",
            "retryable": false,
            "details": { "reason": "unauthenticated" }
        } }
        """)
        XCTAssertEqual(failure.reason, "unauthenticated")
        XCTAssertTrue(failure.isUserFacing)
        XCTAssertFalse(failure.isRetryable)
    }

    /// The superseded-session refusal, which is what a client gets if it presents
    /// a token that a rotation already replaced. The client avoids it by storing
    /// the rotated token, and recognises it if it happens anyway.
    func testASupersededSessionIsRefusedWithAReasonTheClientCanBranchOn() throws {
        let failure = try decodeFailure(status: 403, body: """
        { "error": {
            "code": "permission_denied",
            "domain": "service.accounts",
            "message": "Sign in again to pick up where you left off.",
            "retryable": false,
            "details": { "title": "You've been signed out for security.", "reason": "superseded" }
        } }
        """)
        XCTAssertEqual(failure.reason, "superseded")
        XCTAssertEqual(failure.detail("title")?.stringValue, "You've been signed out for security.")
    }

    /// A live refusal: `GET /v1/accounts/:userId` answered for an account the
    /// caller does not own, with `404` rather than `403` so the account's
    /// existence is not confirmed.
    func testAnotherMembersAccountIsNotFoundRatherThanForbidden() throws {
        let failure = try decodeFailure(status: 404, body: """
        { "error": {
            "code": "not_found",
            "domain": "service.http",
            "message": "account was not found",
            "retryable": false
        } }
        """)
        XCTAssertEqual(failure.code, .notFound)
        XCTAssertTrue(failure.isUserFacing)
    }

    /// A report with no recorded interaction. The dating domain owns the refusal,
    /// so the domain in the body is `dating.interaction` rather than the service.
    func testARefusalCarriesTheDomainThatOwnsTheDecision() throws {
        let failure = try decodeFailure(status: 404, body: """
        { "error": {
            "code": "not_found",
            "domain": "dating.interaction",
            "message": "no recorded interaction with this user",
            "retryable": false
        } }
        """)
        XCTAssertEqual(failure.domain, "dating.interaction")
        XCTAssertNotEqual(failure.domain, "service.http")
    }

    /// A rate limit carries how long to wait, in the body rather than only in a
    /// header, so the client can act on it without parsing prose.
    func testARateLimitCarriesTheDelayItAsksFor() throws {
        let failure = try decodeFailure(status: 429, body: """
        { "error": {
            "code": "rate_limited",
            "domain": "service.accounts",
            "message": "That sign-in did not work.",
            "retryable": false,
            "details": { "title": "Too many attempts.",
                         "reason": "too_many_attempts",
                         "delayMinutes": 15,
                         "retryAfterSeconds": 900 }
        } }
        """)
        XCTAssertEqual(failure.code, .rateLimited)
        XCTAssertEqual(failure.reason, "too_many_attempts")
        XCTAssertEqual(failure.detail("delayMinutes")?.intValue, 15)
        XCTAssertEqual(failure.retryAfterSeconds, 900)
    }

    /// The one refusal class that is about time rather than about the request,
    /// and only when the server said so.
    ///
    /// The flag is forwarded, not inferred from the code: a domain that refuses
    /// with `rate_limited` and no retryable flag has declined for good, and a
    /// client that retried it anyway would be arguing with the server.
    func testARateLimitedRefusalIsRetryableOnlyWhenTheServerSaysSo() {
        let serverSaidRetry = APIError.refused(
            Refusal(code: .rateLimited, domain: "service.accounts", message: "slow down", retryable: true)
        )
        XCTAssertTrue(serverSaidRetry.isRetryable)
        XCTAssertTrue(serverSaidRetry.isUserFacing)

        let serverDidNot = APIError.refused(
            Refusal(code: .rateLimited, domain: "service.accounts", message: "slow down")
        )
        XCTAssertFalse(serverDidNot.isRetryable)
    }

    // MARK: A store fault is not an answer

    /// Verbatim body from `failureBodyFromStore`. The message is deliberately
    /// generic: a driver error carries a SQL fragment, a constraint name and
    /// occasionally a row value, and none of that may reach a client.
    func testAStoreFaultCarriesNoMessageToShow() throws {
        let unavailable = try decodeFailure(status: 503, body: """
        { "error": {
            "code": "store_unavailable",
            "domain": "service.store",
            "message": "the request could not be completed and may be retried",
            "retryable": true
        } }
        """)
        XCTAssertEqual(unavailable, .storeUnavailable)
        // Not user-facing: the platform does not know the answer, and answering a
        // safety question with "we don't know" is not the client's decision.
        XCTAssertFalse(unavailable.isUserFacing)
        XCTAssertTrue(unavailable.isRetryable)
        XCTAssertNil(unavailable.message)
        XCTAssertNil(unavailable.code)
        XCTAssertNil(unavailable.domain)
    }

    func testANonRetryableStoreFaultIsAnOutageThatRetryingWillNotFix() throws {
        let failure = try decodeFailure(status: 500, body: """
        { "error": {
            "code": "store_failure",
            "domain": "service.store",
            "message": "the request could not be completed",
            "retryable": false
        } }
        """)
        XCTAssertEqual(failure, .storeFailure)
        XCTAssertFalse(failure.isRetryable)
        XCTAssertFalse(failure.isUserFacing)
    }

    /// `external_dependency_failed` is the one domain code the service maps to
    /// `503`, because the provider is somebody else's problem and the caller's
    /// retry is the fix. It is a domain refusal *and* an outage status, and the
    /// client keeps both facts rather than collapsing on the status.
    func testA503CarryingADomainCodeStaysARefusal() throws {
        let failure = try decodeFailure(status: 503, body: """
        { "error": {
            "code": "external_dependency_failed",
            "domain": "communication",
            "message": "an account standing could not be evaluated",
            "retryable": true,
            "details": { "party": "counterpart" }
        } }
        """)
        XCTAssertEqual(failure.code, .externalDependencyFailed)
        XCTAssertEqual(failure.domain, "communication")
        XCTAssertEqual(failure.detail("party")?.stringValue, "counterpart")
        // The service set `retryable: true`, so the client honours it rather than
        // re-deciding from the status.
        XCTAssertTrue(failure.isRetryable)
    }

    // MARK: The two must never look alike

    /// A `4xx` and a `5xx` on the same route are different facts about the world.
    /// A client that rendered both as "something went wrong" would be telling a
    /// member the platform refused them when the store was merely unreachable.
    func testARefusalAndAStoreFaultAreDistinguishable() {
        let refused = APIError.refused(
            Refusal(code: .notEligible, domain: "dating.interaction", message: "no")
        )
        let fault = APIError.storeUnavailable
        XCTAssertNotEqual(refused, fault)
        XCTAssertTrue(refused.isUserFacing)
        XCTAssertFalse(fault.isUserFacing)
        XCTAssertFalse(refused.isRetryable)
        XCTAssertTrue(fault.isRetryable)
    }

    /// An unreadable payload is a defect in the client, not an outage. Collapsing
    /// it into `storeUnavailable` would show a member a retry button for a bug.
    func testAnUnreadablePayloadIsNotAnOutage() {
        let unreadable = APIError.undecodable("nope")
        XCTAssertFalse(unreadable.isUserFacing)
        XCTAssertFalse(unreadable.isRetryable)
        XCTAssertNotEqual(unreadable, .storeUnavailable)
        XCTAssertNotEqual(unreadable, .storeFailure)
    }

    func testATransportFailureIsRetryableAndCarriesNoDomainCode() {
        let transport = APIError.transport("offline")
        XCTAssertTrue(transport.isRetryable)
        XCTAssertFalse(transport.isUserFacing)
        XCTAssertNil(transport.code)
    }

    // MARK: Details keep their wire types

    /// `details` is `string | number | boolean | null`. Collapsing it to `String`
    /// would make a client sort `"10"` before `"9"` and compare `"true"` against
    /// `"false"`, so each type is preserved.
    func testDetailsPreserveTheirWireTypes() throws {
        let failure = try decodeFailure(status: 400, body: """
        { "error": {
            "code": "validation_failed",
            "domain": "service.http",
            "message": "a required field is missing or malformed",
            "retryable": false,
            "details": { "field": "userId", "delayMinutes": 15, "anonymous": true, "note": null }
        } }
        """)
        XCTAssertEqual(failure.detail("field"), .string("userId"))
        XCTAssertEqual(failure.detail("delayMinutes"), .number(15))
        XCTAssertEqual(failure.detail("anonymous"), .bool(true))
        XCTAssertEqual(failure.detail("note"), .null)
        // A boolean must not read as a number just because it decodes as one.
        XCTAssertNil(failure.detail("anonymous")?.intValue)
        XCTAssertNil(failure.detail("delayMinutes")?.stringValue)
        XCTAssertNil(failure.detail("note")?.stringValue)
    }

    func testTheRetryDelayIsReadFromEitherKeyTheServerUses() {
        let withSeconds = APIError.refused(
            Refusal(
                code: .rateLimited, domain: "d", message: "m",
                details: ["retryAfterSeconds": .number(900)], retryable: true
            )
        )
        XCTAssertEqual(withSeconds.retryAfterSeconds, 900)
        let withMinutes = APIError.refused(
            Refusal(
                code: .rateLimited, domain: "d", message: "m",
                details: ["delayMinutes": .number(15)], retryable: true
            )
        )
        XCTAssertEqual(withMinutes.retryAfterSeconds, 900)
        let withNeither = APIError.refused(
            Refusal(code: .rateLimited, domain: "d", message: "m")
        )
        XCTAssertNil(withNeither.retryAfterSeconds)
    }

    /// Every code `packages/core` declares is representable, and a code the
    /// kernel does not declare is not — so a client cannot invent one.
    func testTheDomainCodeSetMatchesTheKernel() {
        XCTAssertEqual(DomainErrorCode.allCases.count, 9)
        for raw in [
            "invalid_transition", "not_found", "not_eligible", "permission_denied",
            "conflict", "validation_failed", "rate_limited", "external_dependency_failed",
            "internal",
        ] {
            XCTAssertNotNil(DomainErrorCode(rawValue: raw), "\(raw) is declared by the kernel")
        }
        XCTAssertNil(DomainErrorCode(rawValue: "store_unavailable"))
        XCTAssertNil(DomainErrorCode(rawValue: "quantum"))
    }

    // MARK: The mapping the service performs, read back

    /// `STATUS_BY_DOMAIN_CODE` in `failure.ts`, as the client understands it.
    ///
    /// The table rather than a chain of comparisons exists so that adding a code
    /// to the kernel makes the service file fail to compile until somebody
    /// decides what it means over HTTP. This test is the client's half of that
    /// tripwire: if a code gains a status the client does not expect, the two
    /// have drifted.
    func testEachDomainCodeHasTheStatusTheServiceGivesIt() {
        let expected: [DomainErrorCode: Int] = [
            .validationFailed: 400,
            .notFound: 404,
            .notEligible: 422,
            .permissionDenied: 403,
            .conflict: 409,
            .invalidTransition: 409,
            .rateLimited: 429,
            .externalDependencyFailed: 503,
            .internalError: 500,
        ]
        XCTAssertEqual(DomainErrorCode.allCases.count, expected.count)
        for (code, status) in expected {
            XCTAssertEqual(APIError(refused: code, domain: "d", message: "m").statusClass, status)
        }
    }

    // MARK: No session

    /// The client's own "nothing to present" answer, shaped like the server's
    /// unauthenticated refusal so one `catch` handles both.
    func testNoSessionIsShapedLikeTheServersUnauthenticatedRefusal() {
        XCTAssertEqual(APIError.noSession.code, .permissionDenied)
        XCTAssertEqual(APIError.noSession.domain, "service.accounts")
        XCTAssertEqual(APIError.noSession.reason, "no_session")
        XCTAssertTrue(APIError.noSession.isUserFacing)
        XCTAssertFalse(APIError.noSession.isRetryable)
    }

    // MARK: Helper

    /// Runs a body through the same classification `APIClient.failure` performs.
    ///
    /// Written out rather than reaching into the client's private, so the test
    /// asserts the rule and not the plumbing.
    private func decodeFailure(status: Int, body: String) throws -> APIError {
        let decoded = try JSONDecoder().decode(FailureBody.self, from: Data(body.utf8))
        switch decoded.error.code {
        case "store_unavailable":
            return .storeUnavailable
        case "store_failure":
            return .storeFailure
        default:
            break
        }
        if let refusal = decoded.refusal {
            return .refused(refusal)
        }
        return status >= 500 ? .storeUnavailable : .refused(
            Refusal(
                code: .internalError,
                domain: decoded.error.domain,
                message: decoded.error.message,
                details: decoded.details,
                retryable: decoded.error.retryable
            )
        )
    }
}