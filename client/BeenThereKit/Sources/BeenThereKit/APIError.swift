import Foundation

// MARK: - The error taxonomy the server publishes
//
// `packages/service/src/http/failure.ts` is the authority for this file, and the
// distinction it draws is the one this type exists to preserve:
//
//   * a **domain refusal** (`4xx`) means "the request was refused and that is the
//     answer". It carries the domain's own `code`, the domain that owns it, and
//     the `retryable` flag that domain set. Showing it to a person is correct.
//   * a **store fault** (`5xx`) means "the answer is unknown". It carries no
//     message — a driver error carries a SQL fragment, a constraint name and
//     occasionally a row value, and none of that may reach a client.
//
// Conflating the two in either direction is a real harm, so `APIError` is a
// closed enum rather than a struct with a `code` string: the compiler refuses a
// branch that treats a safety refusal as an outage.

/// The machine-readable codes `packages/core` declares.
///
/// Closed rather than a `String` so a client built against an older kernel fails
/// to compile on a code it has never heard of, instead of falling through a
/// `default` that nobody chose.
public enum DomainErrorCode: String, Codable, Sendable, CaseIterable {
    case invalidTransition = "invalid_transition"
    case notFound = "not_found"
    case notEligible = "not_eligible"
    case permissionDenied = "permission_denied"
    case conflict = "conflict"
    case validationFailed = "validation_failed"
    case rateLimited = "rate_limited"
    case externalDependencyFailed = "external_dependency_failed"
    case internalError = "internal"
}

/// A refusal: the server understood the request and declined it.
public struct Refusal: Sendable, Equatable {
    public let code: DomainErrorCode
    /// The domain that owns the decision — `dating.interaction`, not `service.http`.
    public let domain: String
    public let message: String
    /// The domain's own stable metadata: `{ field, title, reason }`,
    /// `{ reason: "superseded" }`, `{ retryAfterSeconds }`.
    public let details: [String: ErrorDetail]
    /// **The server's flag, forwarded.**
    ///
    /// Not derived here. `failureBodyFromDomain` writes
    /// `error.retryable === true`, and the value comes from whichever domain made
    /// the call — `rate_limited` sets it with a delay, `external_dependency_failed`
    /// sets it because the provider is somebody else's problem and the caller's
    /// retry is the fix. A client that re-decided retryability from the status
    /// would make both of those wrong.
    public let retryable: Bool

    public init(
        code: DomainErrorCode,
        domain: String,
        message: String,
        details: [String: ErrorDetail] = [:],
        retryable: Bool = false
    ) {
        self.code = code
        self.domain = domain
        self.message = message
        self.details = details
        self.retryable = retryable
    }

    /// The server's detail for a key, if it sent one.
    public func detail(_ key: String) -> ErrorDetail? { details[key] }

    /// The `reason` detail — the domain's own short discriminator
    /// (`"superseded"`, `"unauthenticated"`, `"domain_not_allowed"`).
    public var reason: String? { detail("reason")?.stringValue }

    /// The `field` detail, naming the body field a validation failure is about.
    public var field: String? { detail("field")?.stringValue }

    /// How long the server asked the caller to wait, for a rate limit.
    ///
    /// Read from the refusal rather than guessed from a header, because
    /// `rate_limited` puts it in the body as `delayMinutes` / `retryAfterSeconds`
    /// where the caller can act on it directly.
    public var retryAfterSeconds: Int? {
        if let seconds = detail("retryAfterSeconds")?.intValue { return seconds }
        guard let minutes = detail("delayMinutes")?.intValue else { return nil }
        return minutes * 60
    }
}

/// A domain refusal or a store fault, as the service publishes them.
public enum APIError: Error, Sendable, Equatable {

    /// A refusal: the answer is known, and it is no.
    case refused(Refusal)

    /// The answer is unknown: the store failed transiently.
    ///
    /// Carries no message from the server. `failureBodyFromStore` deliberately
    /// withholds one, and re-adding a field here would invite a caller to
    /// surface a driver error to a person.
    case storeUnavailable

    /// The answer is unknown and retrying will not help.
    case storeFailure

    /// The transport itself failed: no HTTP response was produced.
    case transport(String)

    /// A response arrived that this client cannot read — an unexpected shape, or
    /// a projection built at a version this build does not understand.
    ///
    /// Deliberately distinct from `storeUnavailable`: misreading a payload is a
    /// defect in the client, not an outage, and the two call for different
    /// responses.
    case undecodable(String)

    /// Convenience for the common case: a refusal whose `retryable` was not set.
    ///
    /// Exists so the client's own call sites read as the sentence they are —
    /// "refused, because of this code, in this domain" — and so the one place
    /// that *does* know the flag (`APIClient.failure`) has to reach for the
    /// explicit initialiser and pass it deliberately.
    public init(
        refused code: DomainErrorCode,
        domain: String,
        message: String,
        details: [String: ErrorDetail] = [:]
    ) {
        self = .refused(
            Refusal(code: code, domain: domain, message: message, details: details)
        )
    }

    /// The refusal, or `nil` when the failure is not one.
    public var refusal: Refusal? {
        if case let .refused(value) = self { return value }
        return nil
    }

    /// Whether showing this to a person is honest.
    ///
    /// Only a refusal is safe to show: it is a real answer about the caller's own
    /// request. A store fault means the platform does not know, and answering a
    /// safety question with "we don't know" is not a product decision the client
    /// may make.
    public var isUserFacing: Bool { refusal != nil }

    /// Whether the same request may be sent again unchanged.
    ///
    /// For a refusal this is **the server's own flag**, forwarded. For a store
    /// fault it is the store's classification of the driver error code, which
    /// `statusForStoreError` also forwards. The client re-derives neither.
    public var isRetryable: Bool {
        switch self {
        case let .refused(refusal):
            return refusal.retryable
        case .storeUnavailable, .transport:
            return true
        case .storeFailure, .undecodable:
            return false
        }
    }

    /// The domain that owns the refusal, or `nil` when there is no refusal.
    public var domain: String? { refusal?.domain }

    /// The code, or `nil` when the failure is not a domain refusal.
    public var code: DomainErrorCode? { refusal?.code }

    /// The server's message, or `nil` when the server deliberately withheld one.
    public var message: String? { refusal?.message }

    /// The server's stable detail for a key, if it sent one.
    public func detail(_ key: String) -> ErrorDetail? { refusal?.detail(key) }

    /// The `reason` detail.
    public var reason: String? { refusal?.reason }

    /// The `field` detail.
    public var field: String? { refusal?.field }

    /// How long the server asked the caller to wait.
    public var retryAfterSeconds: Int? { refusal?.retryAfterSeconds }

    /// No session is held, so there is nothing to present.
    ///
    /// Synthesised by the client rather than received: the service's own answer
    /// for a request with no recognisable session is a `permission_denied` with
    /// `reason: "unauthenticated"`, and this is that fact raised before the
    /// request was worth making. Shaped identically so one `catch` handles both.
    public static let noSession = APIError.refused(
        Refusal(
            code: .permissionDenied,
            domain: "service.accounts",
            message: "This action needs a session.",
            details: ["reason": .string("no_session")]
        )
    )

    /// The status class the service maps a code to.
    ///
    /// Not used at runtime — nothing in the client branches on a status, because
    /// the body carries everything the status says. It exists so a test can
    /// compare the client's understanding of the service's table without a live
    /// service, which is the drift tripwire for `STATUS_BY_DOMAIN_CODE`.
    var statusClass: Int {
        switch self {
        case let .refused(refusal):
            switch refusal.code {
            case .validationFailed: return 400
            case .notFound: return 404
            case .notEligible: return 422
            case .permissionDenied: return 403
            case .conflict, .invalidTransition: return 409
            case .rateLimited: return 429
            case .externalDependencyFailed: return 503
            case .internalError: return 500
            }
        case .storeUnavailable, .transport:
            return 503
        case .storeFailure, .undecodable:
            return 500
        }
    }
}

/// One value from a failure's `details` map.
///
/// The wire type is `string | number | boolean | null`, so this is the same
/// closed set rather than a lossy collapse to `String`: `delayMinutes` is a
/// number on the wire and a number here, and a client cannot accidentally sort
/// `"10"` before `"9"`.
public enum ErrorDetail: Sendable, Equatable, Codable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case null

    public var stringValue: String? {
        if case let .string(value) = self { return value }
        return nil
    }

    public var intValue: Int? {
        if case let .number(value) = self { return Int(value) }
        return nil
    }

    public var boolValue: Bool? {
        if case let .bool(value) = self { return value }
        return nil
    }
}

// MARK: - Decoding the failure body

/// The wire shape of every refusal and every fault, from `failureBodyFromDomain`
/// and `failureBodyFromStore`. One decoder for both because the service builds
/// both through the same function and the status is the only thing that differs.
struct FailureBody: Decodable {
    struct Payload: Decodable {
        let code: String
        let domain: String
        let message: String
        let retryable: Bool
        let details: [String: DetailValue]?
    }

    /// `details` is declared with `string | number | boolean | null` on the wire.
    /// The branches are tried most-specific first, so a boolean is never read as
    /// `1` by a `Double` decoder.
    enum DetailValue: Decodable {
        case null
        case bool(Bool)
        case number(Double)
        case string(String)

        init(from decoder: any Decoder) throws {
            let container = try decoder.singleValueContainer()
            if container.decodeNil() {
                self = .null
            } else if let value = try? container.decode(Bool.self) {
                self = .bool(value)
            } else if let value = try? container.decode(Double.self) {
                self = .number(value)
            } else {
                self = .string(try container.decode(String.self))
            }
        }

        var detail: ErrorDetail {
            switch self {
            case .null: return .null
            case let .bool(value): return .bool(value)
            case let .number(value): return .number(value)
            case let .string(value): return .string(value)
            }
        }
    }

    let error: Payload

    var details: [String: ErrorDetail] {
        (error.details ?? [:]).mapValues(\.detail)
    }

    /// The refusal this body describes, or `nil` when it describes a store fault.
    ///
    /// `nil` for the two store codes rather than a synthesised refusal: they are
    /// not a domain's decision, and building one would put `service.store` into
    /// a field reserved for the domain that refused.
    var refusal: Refusal? {
        guard let code = DomainErrorCode(rawValue: error.code) else { return nil }
        return Refusal(
            code: code,
            domain: error.domain,
            message: error.message,
            details: details,
            // Forwarded, not re-derived: see `Refusal.retryable`.
            retryable: error.retryable
        )
    }
}