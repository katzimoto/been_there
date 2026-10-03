import Foundation

// MARK: - Sessions
//
// `POST /v1/account-sessions`, `POST /v1/accounts` (nested) and
// `POST /v1/account-sessions/refresh` all issue the same credential, but they
// arrange it differently on the wire: a sign-up nests the credential under
// `session` with the user id as its sibling, while sign-in and refresh return
// the id alongside the credential. Both shapes are typed, because the difference
// is the server's and a single flattened struct would fail to decode a real
// sign-up response.

/// The credential as it is nested in a sign-up response: no user id.
///
/// The service mints the token once and never stores it in the clear, so a client
/// that loses it has to sign in again. That is why this is a `let` on a value the
/// session store owns and not a property the caller mutates.
public struct SessionCredential: Codable, Sendable, Equatable {
    public let token: String
    public let sessionId: String
    public let expiresAt: String
    public let refreshableUntil: String

    public init(token: String, sessionId: String, expiresAt: String, refreshableUntil: String) {
        self.token = token
        self.sessionId = sessionId
        self.expiresAt = expiresAt
        self.refreshableUntil = refreshableUntil
    }

    public var expiresOn: Date? { ISO8601.date(from: expiresAt) }
    public var refreshableUntilDate: Date? { ISO8601.date(from: refreshableUntil) }
}

/// A credential bound to the member it authenticates.
///
/// What the client stores and presents. Sign-in returns exactly this, and a
/// refresh returns it with a new token.
public struct IssuedSession: Codable, Sendable, Equatable {
    public let userId: String
    public let token: String
    public let sessionId: String
    public let expiresAt: String
    public let refreshableUntil: String

    public init(
        userId: String,
        token: String,
        sessionId: String,
        expiresAt: String,
        refreshableUntil: String
    ) {
        self.userId = userId
        self.token = token
        self.sessionId = sessionId
        self.expiresAt = expiresAt
        self.refreshableUntil = refreshableUntil
    }

    /// Binds a nested sign-up credential to the user id that signed up.
    public init(userId: String, credential: SessionCredential) {
        self.init(
            userId: userId,
            token: credential.token,
            sessionId: credential.sessionId,
            expiresAt: credential.expiresAt,
            refreshableUntil: credential.refreshableUntil
        )
    }

    public var expiresOn: Date? { ISO8601.date(from: expiresAt) }
    public var refreshableUntilDate: Date? { ISO8601.date(from: refreshableUntil) }

    public var credential: SessionCredential {
        SessionCredential(
            token: token,
            sessionId: sessionId,
            expiresAt: expiresAt,
            refreshableUntil: refreshableUntil
        )
    }
}

/// The sign-in response.
///
/// `evictedSessions` is sign-in's alone: how many older sessions the per-account
/// cap displaced when this one was issued. A refresh evicts nothing and a sign-up
/// cannot evict anything, so the field is optional rather than defaulted — a
/// client rendering "0 sessions replaced" on a refresh would be reporting a fact
/// the server never sent.
public struct SignInSession: Codable, Sendable, Equatable {
    public let userId: String
    public let token: String
    public let sessionId: String
    public let expiresAt: String
    public let refreshableUntil: String
    public let evictedSessions: Int?

    public init(
        userId: String,
        token: String,
        sessionId: String,
        expiresAt: String,
        refreshableUntil: String,
        evictedSessions: Int? = nil
    ) {
        self.userId = userId
        self.token = token
        self.sessionId = sessionId
        self.expiresAt = expiresAt
        self.refreshableUntil = refreshableUntil
        self.evictedSessions = evictedSessions
    }

    /// The same session in the form the client stores and presents.
    public var issued: IssuedSession {
        IssuedSession(
            userId: userId,
            token: token,
            sessionId: sessionId,
            expiresAt: expiresAt,
            refreshableUntil: refreshableUntil
        )
    }
}

/// The sign-up response.
///
/// Age is never sent: `POST /v1/accounts` returns the band and the age-gate
/// notice, and `readSignUpInput` explains why the input type has no `age` field
/// at all — a gate that reads a number the client typed accepts a promise.
public struct SignUpResult: Codable, Sendable, Equatable {
    public struct Identity: Codable, Sendable, Equatable {
        public let state: IdentityState
        public let generation: Int
        public let discoverable: Bool
    }

    public struct AgeGateNotice: Codable, Sendable, Equatable {
        public let title: String
        public let body: String
    }

    public let userId: String
    public let accountId: String
    public let createdAt: String
    public let contactVerified: Bool
    public let termsVersion: String
    /// The band, never the date of birth and never an exact age.
    public let ageBand: String?
    public let ageGate: AgeGateNotice
    public let identity: Identity
    /// The credential, bound to the `userId` above it.
    public let session: IssuedSession

    /// Explicit because `init(from:)` is hand-written: the synthesised keys would
    /// not exist, and naming them here is what keeps the encoder on the same
    /// vocabulary as the decoder.
    private enum CodingKeys: String, CodingKey {
        case userId
        case accountId
        case createdAt
        case contactVerified
        case termsVersion
        case ageBand
        case ageGate
        case identity
        case session
    }

    public init(
        userId: String,
        accountId: String,
        createdAt: String,
        contactVerified: Bool,
        termsVersion: String,
        ageBand: String?,
        ageGate: AgeGateNotice,
        identity: Identity,
        session: IssuedSession
    ) {
        self.userId = userId
        self.accountId = accountId
        self.createdAt = createdAt
        self.contactVerified = contactVerified
        self.termsVersion = termsVersion
        self.ageBand = ageBand
        self.ageGate = ageGate
        self.identity = identity
        self.session = session
    }

    /// Decoding the wire shape, where `session` is the credential alone.
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.userId = try container.decode(String.self, forKey: .userId)
        self.accountId = try container.decode(String.self, forKey: .accountId)
        self.createdAt = try container.decode(String.self, forKey: .createdAt)
        self.contactVerified = try container.decode(Bool.self, forKey: .contactVerified)
        self.termsVersion = try container.decode(String.self, forKey: .termsVersion)
        self.ageBand = try container.decodeIfPresent(String.self, forKey: .ageBand)
        self.ageGate = try container.decode(AgeGateNotice.self, forKey: .ageGate)
        self.identity = try container.decode(Identity.self, forKey: .identity)
        self.session = IssuedSession(
            userId: userId,
            credential: try container.decode(SessionCredential.self, forKey: .session)
        )
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(userId, forKey: .userId)
        try container.encode(accountId, forKey: .accountId)
        try container.encode(createdAt, forKey: .createdAt)
        try container.encode(contactVerified, forKey: .contactVerified)
        try container.encode(termsVersion, forKey: .termsVersion)
        try container.encodeIfPresent(ageBand, forKey: .ageBand)
        try container.encode(ageGate, forKey: .ageGate)
        try container.encode(identity, forKey: .identity)
        // Encoded the way the service sends it: the id is a sibling, not a member.
        try container.encode(session.credential, forKey: .session)
    }
}

// MARK: - Standing

/// `GET /v1/accounts/:userId`, the viewer's own identity and account standing.
public struct AccountView: Codable, Sendable, Equatable {
    public struct IdentityStatus: Codable, Sendable, Equatable {
        public let projectionVersion: Int
        public let subjectId: String
        public let state: IdentityState
        public let generation: Int
        /// The kernel's own `isDiscoverableIdentity`, never a comparison written here.
        public let discoverable: Bool
        public let updatedAt: String
    }

    public let userId: String
    public let accountId: String
    public let createdAt: String
    public let identity: IdentityStatus
    /// `AccountStandingProjection`. Note what is *absent*: `removedCapabilities`
    /// and any case reference. See `RestrictedAccountViewModel`.
    public let account: AccountStanding

    public init(
        userId: String,
        accountId: String,
        createdAt: String,
        identity: IdentityStatus,
        account: AccountStanding
    ) {
        self.userId = userId
        self.accountId = accountId
        self.createdAt = createdAt
        self.identity = identity
        self.account = account
    }
}

// MARK: - Onboarding

/// `GET /v1/accounts/:userId/onboarding` — `OnboardingReadiness` verbatim.
///
/// `nextStep` and `outstanding` are the server's answer and are read, never
/// computed here. The ordering is `ONBOARDING_ORDER` in the service, and a client
/// that reordered it would send a member back to a step in an order the product
/// did not choose.
public struct OnboardingReadiness: Codable, Sendable, Equatable {
    /// The closed vocabulary `onboarding.ts` declares. A step that is not here
    /// does not exist — the comment above `OnboardingStepId` says so explicitly.
    public enum Step: String, Codable, Sendable, Equatable, CaseIterable {
        case contactVerification = "contact_verification"
        case ageGate = "age_gate"
        case terms
        case identityVerification = "identity_verification"
        case profile
        case preferences
        case photoScreening = "photo_screening"
    }

    public struct Identity: Codable, Sendable, Equatable {
        public let state: IdentityState
        public let discoverable: Bool
    }

    public let version: Int
    public let userId: String
    public let contactVerified: Bool
    public let ageGatePassed: Bool
    /// The band, never the date of birth and never an exact age. Owner-only here,
    /// and §4.3 makes the date itself never rendered at all.
    public let ageBand: String?
    public let termsAcceptedVersion: String?
    public let termsCurrent: Bool
    public let identity: Identity
    public let profileState: ProfileState
    public let preferencesSet: Bool
    public let nextStep: Step?
    public let outstanding: [Step]
    /// True only when the server's four clauses all hold. Read, not recomputed.
    public let discoverable: Bool
    public let accountState: AccountState

    public init(
        version: Int,
        userId: String,
        contactVerified: Bool,
        ageGatePassed: Bool,
        ageBand: String?,
        termsAcceptedVersion: String?,
        termsCurrent: Bool,
        identity: Identity,
        profileState: ProfileState,
        preferencesSet: Bool,
        nextStep: Step?,
        outstanding: [Step],
        discoverable: Bool,
        accountState: AccountState
    ) {
        self.version = version
        self.userId = userId
        self.contactVerified = contactVerified
        self.ageGatePassed = ageGatePassed
        self.ageBand = ageBand
        self.termsAcceptedVersion = termsAcceptedVersion
        self.termsCurrent = termsCurrent
        self.identity = identity
        self.profileState = profileState
        self.preferencesSet = preferencesSet
        self.nextStep = nextStep
        self.outstanding = outstanding
        self.discoverable = discoverable
        self.accountState = accountState
    }
}

// MARK: - Discovery

/// `GET /v1/discovery`.
public struct DiscoveryPage: Codable, Sendable, Equatable {
    public let viewerId: String
    public let projectionVersion: Int
    public let candidates: [CandidateCard]
    public let total: Int

    public init(
        viewerId: String,
        projectionVersion: Int,
        candidates: [CandidateCard],
        total: Int
    ) {
        self.viewerId = viewerId
        self.projectionVersion = projectionVersion
        self.candidates = candidates
        self.total = total
    }
}

/// `CandidateCardProjection`.
///
/// `distance` is a coarse band and is `unknown` whenever the platform could not
/// resolve a separation — `discovery.ts` says so at length, and a client that
/// rendered `unknown` as "nearby" would be inventing a fact.
public struct CandidateCard: Codable, Sendable, Equatable, Identifiable {
    public var id: String { userId }

    public let projectionVersion: Int
    public let userId: String
    public let displayName: String
    public let age: Int
    public let genderIdentities: [String]
    public let bio: String
    public let photoIds: [String]
    public let distance: DistanceBand

    /// Whether the page can render this person at all.
    ///
    /// Not a rule: a card whose content the server sent always has a name and a
    /// derived age, so this is the assertion that the invariant held. A card that
    /// fails it is dropped rather than rendered blank, because a blank card in
    /// front of a person is the wrong answer when the row disagrees with itself.
    public var isRenderable: Bool {
        !displayName.isEmpty && age > 0
    }

    public init(
        projectionVersion: Int,
        userId: String,
        displayName: String,
        age: Int,
        genderIdentities: [String],
        bio: String,
        photoIds: [String],
        distance: DistanceBand
    ) {
        self.projectionVersion = projectionVersion
        self.userId = userId
        self.displayName = displayName
        self.age = age
        self.genderIdentities = genderIdentities
        self.bio = bio
        self.photoIds = photoIds
        self.distance = distance
    }
}

/// The six bands `location.ts` declares, plus `unknown` for the branch the
/// service takes whenever a separation could not be computed.
public enum DistanceBand: String, Codable, Sendable, Equatable, CaseIterable {
    case lt5km = "lt_5_km"
    case from5To25km = "5_25_km"
    case from25To50km = "25_50_km"
    case from50To100km = "50_100_km"
    case over100km = "gt_100_km"
    case unknown

    /// Whether the platform actually resolved this. `unknown` is not a distance
    /// of zero and is never rendered as one.
    public var isResolved: Bool { self != .unknown }
}

// MARK: - Profile

/// `GET /v1/profiles/me` — a boolean and the unmet rules.
///
/// There is no completeness score in this response and no field one could be
/// added to: the shape is closed on purpose, because a percentage is a ranking
/// signal wearing a progress bar's clothes.
public struct ProfileCompleteness: Codable, Sendable, Equatable {
    public enum MissingField: String, Codable, Sendable, Equatable, CaseIterable {
        case displayName = "display_name"
        case bio
        case photos
        case prompt
        case genderIdentities = "gender_identities"
        case age
        case location
    }

    public let profileId: String
    public let state: ProfileState
    public let complete: Bool
    public let missing: [MissingField]

    public init(profileId: String, state: ProfileState, complete: Bool, missing: [MissingField]) {
        self.profileId = profileId
        self.state = state
        self.complete = complete
        self.missing = missing
    }
}

/// `ProfileState`, from `profileMachine`.
public enum ProfileState: String, Codable, Sendable, Equatable, CaseIterable {
    case draft
    case incomplete
    case complete
    case paused
    case hidden
    case deleted
}

// MARK: - Preferences

/// `GET /v1/profiles/me/preferences`.
///
/// Absent is not an empty filter: the server serves `UNSET_PREFERENCES`, whose
/// every axis is `null` and therefore unbounded. The distinction turns on the
/// unset rule, and it is why this is a `200` rather than a `404`.
public struct PreferencesEnvelope: Codable, Sendable, Equatable {
    public struct Dating: Codable, Sendable, Equatable {
        public let ageRange: [Int]?
        public let maxDistanceKm: Double?
        public let seekingGenders: [String]?
        public let openTo: [String]?
        public let locationPrecision: DistanceBand?
    }

    public let preferences: Dating

    /// Whether the member has expressed anything at all.
    ///
    /// Read off the payload's own nullability rather than compared against a copy
    /// of `UNSET_PREFERENCES`, because a client holding its own "unset" constant
    /// would be a second copy of a value the server owns.
    public var isUnset: Bool {
        let p = preferences
        return p.ageRange == nil
            && p.maxDistanceKm == nil
            && p.seekingGenders == nil
            && p.openTo == nil
            && p.locationPrecision == nil
    }
}
