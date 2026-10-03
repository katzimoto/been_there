import Foundation

// MARK: - Reading the projections the server actually publishes
//
// `ClientGate.swift` is not edited by this file and its `AccountStanding` is used
// exactly as written. What is added here is only the coding that type needs.
//
// ## The defect this file works around
//
// `ClientGate.AccountStanding` declares `removedCapabilities: [String] = []`. Swift's
// synthesised `Decodable` ignores a default value in an `init` and requires the key
// on the wire. The server's `AccountStandingProjection` has **no**
// `removedCapabilities` field — `accountProjectionFor` builds it from `state`,
// `capabilities` and `visibleInProduct`, and those three are the whole
// projection.
//
// Without this file `AccountView` would not decode a single real response, so the
// client could not be tested against the running service at all. The `[]` default
// in the declared initialiser is the author's statement that the field is
// optional; this decoder honours that statement rather than the compiler's
// synthesised guess.
//
// ## What it does not do
//
// It does not invent a removed set. An absent `removedCapabilities` decodes as
// `[]`, which means "the server did not say", and `RestrictedAccountViewModel`
// reads it as exactly that rather than as "nothing was removed".

extension AccountStanding {

    /// Decoding `AccountStandingProjection`, with `removedCapabilities` optional.
    ///
    /// `state` and `capabilities` are required, so a row missing one fails loudly
    /// rather than decoding as a standing the member does not have.
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
        self.removedCapabilities = try container.decodeIfPresent(
            [String].self,
            forKey: .removedCapabilities
        ) ?? []
        self.visibleInProduct = try container.decodeIfPresent(
            Bool.self,
            forKey: .visibleInProduct
        ) ?? true
    }

    /// Encoded with the projection's own field names, so a standing this client
    /// built reads back through the same decoder.
    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(SupportedStandingProjectionVersion.value, forKey: .projectionVersion)
        try container.encode(state, forKey: .state)
        try container.encode(capabilities, forKey: .capabilities)
        try container.encode(removedCapabilities, forKey: .removedCapabilities)
        try container.encode(visibleInProduct, forKey: .visibleInProduct)
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
        case visibleInProduct
    }
}

/// `STANDING_PROJECTION_VERSION` in `packages/dating/src/read-models.ts`.
public enum SupportedStandingProjectionVersion {
    public static let value = 1
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