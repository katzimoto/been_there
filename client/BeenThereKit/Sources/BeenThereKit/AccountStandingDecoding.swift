import Foundation

// MARK: - Reading the projections the server actually publishes
//
// `ClientGate.swift` declares the types; what is added here is only the coding
// they need, because Swift's synthesised `Decodable` and the server's declared
// field set do not agree on one point: `AccountStandingProjection` publishes
// `baselineCapabilities`, `removedCapabilities` and `caseId` as *required*
// members, with `caseId` nullable but always present. The compiler's guess
// would make them all optional and silently default, which is the exact failure
// this file was first written to prevent.
//
// ## Why the tolerance is gone
//
// This file used to decode an absent `removedCapabilities` as `[]` and leave
// `caseReference` nil, because the server published neither. That was a
// documented workaround, and `RestrictedAccountViewModel` carried a
// `.notPublished` case to keep a caller from mistaking it for "nothing was
// removed". Both are now real assertions: `STANDING_PROJECTION_VERSION` is 2,
// the projection carries all three fields, and a response missing one fails to
// decode rather than producing a screen that says a restriction removed
// nothing.

extension AccountStanding {

    /// Decoding `AccountStandingProjection`, strictly.
    ///
    /// Every field the projection declares is required. `state` and
    /// `capabilities` fail loudly rather than decoding as a standing the member
    /// does not have; `removedCapabilities` and `baselineCapabilities` fail
    /// loudly because a missing one used to decode as "nothing was removed",
    /// which is the specific false statement a restriction screen must not make;
    /// and `caseId` is required as a *key* while remaining nullable, so a
    /// server that stopped sending it is a failure and a server that sent `null`
    /// is the honest "no decision has been taken".
    ///
    /// `projectionVersion` is checked rather than discarded: the projection's own
    /// doc comment says a consumer that has not been rebuilt against a new
    /// version must see a refusal rather than a mis-read, and refusing is the
    /// only way to honour that from a client.
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        try Self.checkProjectionVersion(
            try container.decodeIfPresent(Int.self, forKey: .projectionVersion)
        )
        self.state = try container.decode(AccountState.self, forKey: .state)
        self.capabilities = try container.decode([String].self, forKey: .capabilities)
        self.removedCapabilities = try container.decode([String].self, forKey: .removedCapabilities)
        self.baselineCapabilities = try container.decode([String].self, forKey: .baselineCapabilities)
        self.visibleInProduct = try container.decode(Bool.self, forKey: .visibleInProduct)
        guard container.contains(.caseId) else {
            throw DecodingError.keyNotFound(
                CodingKeys.caseId,
                .init(
                    codingPath: container.codingPath,
                    debugDescription: """
                    the account standing projection has no `caseId` key. It is \
                    nullable — a null is how the server says no decision has been \
                    taken — but it is always present, and its absence means the \
                    server is not publishing the reference this client needs in \
                    order to let a member contest the decision.
                    """
                )
            )
        }
        self.caseId = try container.decodeIfPresent(String.self, forKey: .caseId)
    }

    /// Encoded with the projection's own field names, so a standing this client
    /// built reads back through the same decoder.
    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(SupportedStandingProjectionVersion.value, forKey: .projectionVersion)
        try container.encode(state, forKey: .state)
        try container.encode(capabilities, forKey: .capabilities)
        try container.encode(removedCapabilities, forKey: .removedCapabilities)
        try container.encode(baselineCapabilities, forKey: .baselineCapabilities)
        try container.encode(visibleInProduct, forKey: .visibleInProduct)
        try container.encodeIfPresent(caseId, forKey: .caseId)
    }

    /// Whether the server's removed set agrees with its own baseline.
    ///
    /// A readback, not a rule: `removedCapabilities` is what the screen renders,
    /// and this is the check that the two published fields describe the same
    /// account. It can only be false if the server changed one without the other,
    /// which is a real disagreement worth tripping over rather than silently
    /// preferring one of the two numbers.
    public var removedSetAgreesWithBaseline: Bool {
        let difference = baselineCapabilities.filter { !capabilities.contains($0) }
        return difference.sorted() == removedCapabilities.sorted()
    }

    /// Throws when the projection is built at a version this build cannot read.
    ///
    /// A missing version decodes: an absent field is not a version, and refusing
    /// on absence would make the client fail on a response the server did send.
    static func checkProjectionVersion(_ version: Int?) throws {
        guard let version, version != SupportedStandingProjectionVersion.value else { return }
        throw DecodingError.dataCorrupted(
            .init(
                codingPath: [],
                debugDescription: """
                account standing projection version \(version) is not the version \
                this build reads (\(SupportedStandingProjectionVersion.value))
                """
            )
        )
    }

    private enum CodingKeys: String, CodingKey {
        case projectionVersion
        case state
        case capabilities
        case removedCapabilities
        case baselineCapabilities
        case visibleInProduct
        case caseId
    }
}

/// `STANDING_PROJECTION_VERSION` in `packages/dating/src/read-models.ts`.
public enum SupportedStandingProjectionVersion {
    public static let value = 2
}

/// The same tolerance and the same version check for `AccountView`'s identity
/// half, which the service publishes as `IdentityStatusProjection`.
extension AccountView.IdentityStatus {

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let version = try container.decodeIfPresent(Int.self, forKey: .projectionVersion)
        guard version == nil || version == SupportedIdentityProjectionVersion.value else {
            throw DecodingError.dataCorrupted(
                .init(
                    codingPath: [],
                    // `version` is unwrapped by the guard, so this is the number
                    // and not an `Optional` debug description.
                    debugDescription: """
                    identity status projection version \(String(describing: version)) is not \
                    the version this build reads (\(SupportedIdentityProjectionVersion.value))
                    """
                )
            )
        }
        self.projectionVersion = version ?? SupportedIdentityProjectionVersion.value
        self.subjectId = try container.decode(String.self, forKey: .subjectId)
        self.state = try container.decode(IdentityState.self, forKey: .state)
        self.generation = try container.decode(Int.self, forKey: .generation)
        self.discoverable = try container.decode(Bool.self, forKey: .discoverable)
        self.updatedAt = try container.decode(String.self, forKey: .updatedAt)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(projectionVersion, forKey: .projectionVersion)
        try container.encode(subjectId, forKey: .subjectId)
        try container.encode(state, forKey: .state)
        try container.encode(generation, forKey: .generation)
        try container.encode(discoverable, forKey: .discoverable)
        try container.encode(updatedAt, forKey: .updatedAt)
    }

    private enum CodingKeys: String, CodingKey {
        case projectionVersion
        case subjectId
        case state
        case generation
        case discoverable
        case updatedAt
    }
}

/// `IDENTITY_PROJECTION_VERSION` in `packages/identity/src/read-model.ts`.
public enum SupportedIdentityProjectionVersion {
    public static let value = 1
}

// MARK: - A card, read at the version it was built at

extension CandidateCard {

    /// Decoding `CandidateCardProjection`, refusing a version it cannot read.
    ///
    /// `DATING_READ_MODEL_VERSION` is 1. The projection's doc comment is explicit
    /// that a consumer which has not been rebuilt against a new version "must
    /// see an `unsupported_version` refusal rather than a mis-parsed card", so
    /// this throws rather than decoding a shape it does not know — which makes
    /// the refusal structural instead of a convention.
    ///
    /// `bio` and `photoIds` default when absent: a card with neither is still a
    /// person, and `isRenderable` decides whether the page shows them at all.
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let version = try container.decodeIfPresent(Int.self, forKey: .projectionVersion)
        guard version == nil || version == SupportedDatingReadModelVersion.value else {
            throw DecodingError.dataCorrupted(
                .init(
                    codingPath: [],
                    debugDescription: """
                    candidate card projection version \(String(describing: version)) is not \
                    the version this build reads (\(SupportedDatingReadModelVersion.value))
                    """
                )
            )
        }
        self.projectionVersion = version ?? SupportedDatingReadModelVersion.value
        self.userId = try container.decode(String.self, forKey: .userId)
        self.displayName = try container.decode(String.self, forKey: .displayName)
        self.age = try container.decode(Int.self, forKey: .age)
        self.genderIdentities = try container.decodeIfPresent([String].self, forKey: .genderIdentities) ?? []
        self.bio = try container.decodeIfPresent(String.self, forKey: .bio) ?? ""
        self.photoIds = try container.decodeIfPresent([String].self, forKey: .photoIds) ?? []
        // Absent distance is `unknown`, not zero: there is no location anchor
        // table and a band is not a point, so the platform cannot prove a
        // separation and must not pretend otherwise.
        self.distance = try container.decodeIfPresent(DistanceBand.self, forKey: .distance) ?? .unknown
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(projectionVersion, forKey: .projectionVersion)
        try container.encode(userId, forKey: .userId)
        try container.encode(displayName, forKey: .displayName)
        try container.encode(age, forKey: .age)
        try container.encode(genderIdentities, forKey: .genderIdentities)
        try container.encode(bio, forKey: .bio)
        try container.encode(photoIds, forKey: .photoIds)
        try container.encode(distance, forKey: .distance)
    }

    private enum CodingKeys: String, CodingKey {
        case projectionVersion
        case userId
        case displayName
        case age
        case genderIdentities
        case bio
        case photoIds
        case distance
    }
}

/// `DATING_READ_MODEL_VERSION` in `packages/dating/src/read-models.ts`.
public enum SupportedDatingReadModelVersion {
    public static let value = 1
}