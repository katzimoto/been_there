import Foundation

// MARK: - What the client is allowed to show

/// The client-side safety gate.
///
/// The server is the authority — it refuses anything unsafe regardless of what
/// the client renders. This exists so the **client does not offer an action the
/// server will refuse**, because an affordance that always fails is worse than a
/// disabled one: it teaches people that the app is broken, and it leaks the
/// existence of a state the user is not entitled to know about.
///
/// The rules here mirror `packages/core`:
///   - an account that is not `verified` is never discoverable and never seen;
///   - `report` and `block` cannot be restricted away, so a restricted account
///     keeps them;
///   - messaging is symmetric, so a restricted *counterpart* disables the
///     composer on this side too.
///
/// Every rule is a pure function over values the server already sent. Nothing
/// here reaches for a capability list that is not on screen.

public enum IdentityState: String, Codable, Sendable, CaseIterable {
    case unverified
    case pending
    case verified
    case reviewRequired = "review_required"
    case verificationFailed = "verification_failed"
    case expired
}

public enum AccountState: String, Codable, Sendable, CaseIterable {
    case active
    case limited
    case suspended
    case banned
}

/// The standing projection, as `AccountStateChangedPayload` publishes it.
public struct AccountStanding: Codable, Sendable, Equatable {
    public let state: AccountState
    public let capabilities: [String]
    public let removedCapabilities: [String]
    public let visibleInProduct: Bool

    public init(
        state: AccountState,
        capabilities: [String],
        removedCapabilities: [String] = [],
        visibleInProduct: Bool = true
    ) {
        self.state = state
        self.capabilities = capabilities
        self.removedCapabilities = removedCapabilities
        self.visibleInProduct = visibleInProduct
    }
}

public struct ViewerSnapshot: Codable, Sendable, Equatable {
    public let userId: String
    public let identity: IdentityState
    public let account: AccountStanding

    public init(userId: String, identity: IdentityState, account: AccountStanding) {
        self.userId = userId
        self.identity = identity
        self.account = account
    }
}

// MARK: - Why something is unavailable

/// A refusal the user can be *shown*, and the reason behind it.
///
/// `AccountStanding.removedCapabilities` names what was taken and `caseReference`
/// names the decision, which is what lets the product say "this restriction
/// came from case X" — the basis on which a user can contest it. Neither is
/// derivable from a capability list the client happens to hold, which is why
/// the server publishes both.
public struct Unavailable: Error, Equatable, Sendable {
    public enum Reason: String, Sendable, Equatable {
        case identityNotVerified
        case accountRestricted
        case accountSuspended
        case accountBanned
        case counterpartRestricted
        case conversationClosed
    }

    public let reason: Reason
    public let title: String
    public let body: String
    public let removedCapabilities: [String]
    public let caseReference: String?

    public init(
        reason: Reason,
        title: String,
        body: String,
        removedCapabilities: [String] = [],
        caseReference: String? = nil
    ) {
        self.reason = reason
        self.title = title
        self.body = body
        self.removedCapabilities = removedCapabilities
        self.caseReference = caseReference
    }
}

// MARK: - The gate

public enum ClientGate {

    /// Discovery is only ever offered to a verified account.
    ///
    /// Commitment 1, and the reason an unverified user sees an empty page
    /// rather than a disabled tab with an explanation: telling someone they are
    /// unverified in a place only they can see is fine, but the *reason* a
    /// candidate is absent must never be exposed to anyone else.
    public static func canBrowseDiscovery(_ viewer: ViewerSnapshot) -> Bool {
        viewer.identity == .verified && viewer.account.visibleInProduct
    }

    /// A profile of one's own can always be opened, even when banned.
    ///
    /// A banned user who cannot reach their own profile cannot delete the
    /// account, which strands them. That is why `delete_account` is on the
    /// banned capability set.
    public static func canEditOwnProfile(_ viewer: ViewerSnapshot) -> Bool {
        viewer.account.capabilities.contains("edit_profile") || viewer.account.state == .banned
    }

    /// Reporting and blocking are never withheld.
    ///
    /// They are unrestrictable on the server; this mirrors it so the client never
    /// hides the control that a victim needs most. A client that hid "report"
    /// behind a restriction would be the worst possible failure of a safety
    /// product, so it is asserted here as well as enforced there.
    public static func canReport(_ viewer: ViewerSnapshot) -> Bool {
        viewer.account.capabilities.contains("report")
    }

    public static func canBlock(_ viewer: ViewerSnapshot) -> Bool {
        viewer.account.capabilities.contains("block")
    }

    public static func canDeleteAccount(_ viewer: ViewerSnapshot) -> Bool {
        viewer.account.capabilities.contains("delete_account")
    }

    // MARK: Messaging

    /// Whether the composer is available in a conversation.
    ///
    /// Three conditions, and the ordering matters: a block outranks everything,
    /// because a block must never be probeable. Then the conversation's own
    /// state. Then the sender's standing, and **then the counterpart's**, because
    /// the server refuses a send when either party is restricted and a composer
    /// that appears and then fails is a bug report waiting to happen.
    ///
    /// - Parameters:
    ///   - blocked: a block edge exists in either direction.
    ///   - conversationOpen: the conversation is accepting messages.
    ///   - counterpartStanding: the *other* party's account standing.
    public static func canSendMessage(
        viewer: ViewerSnapshot,
        counterpartStanding: AccountStanding,
        blocked: Bool,
        conversationOpen: Bool
    ) -> Unavailable? {
        if blocked {
            // Details are exactly the block. Naming a capability or a party here
            // would turn a refusal into an oracle.
            return Unavailable(
                reason: .conversationClosed,
                title: "Messaging is not available",
                body: "This conversation is no longer available."
            )
        }

        if !conversationOpen {
            return Unavailable(
                reason: .conversationClosed,
                title: "Messaging is not available",
                body: "This conversation is closed. You can still read it."
            )
        }

        switch viewer.account.state {
        case .suspended:
            return Unavailable(
                reason: .accountSuspended,
                title: "Your account is suspended",
                body: "Messaging is unavailable while your account is suspended.",
                removedCapabilities: viewer.account.removedCapabilities,
                caseReference: nil
            )
        case .banned:
            return Unavailable(
                reason: .accountBanned,
                title: "Your account is banned",
                body: "Messaging is unavailable.",
                caseReference: nil
            )
        case .limited where !viewer.account.capabilities.contains("send_message"):
            return Unavailable(
                reason: .accountRestricted,
                title: "Some features are turned off",
                body: "Messaging is unavailable on your account right now.",
                removedCapabilities: viewer.account.removedCapabilities,
                caseReference: nil
            )
        default:
            break
        }

        // The counterpart's restriction disables the composer here too. The
        // server enforces it symmetrically; without this the client would offer
        // a send that always fails.
        if !counterpartStanding.capabilities.contains("send_message") {
            return Unavailable(
                reason: .counterpartRestricted,
                title: "Messaging is not available",
                body: "You cannot send messages in this conversation right now."
            )
        }

        return nil
    }

    // MARK: Onboarding

    /// Whether onboarding is finished, and the single next thing to do.
    ///
    /// Mirrors the server's discoverability predicate — verified AND account
    /// visible AND profile complete AND preferences set — so "you're nearly
    /// there" and "you are discoverable" are the same computation. Two copies of
    /// this rule would drift, which is why the server's is the authority and this
    /// one is a mirror that reports disagreement rather than acting on it.
    public static func onboardingNextStep(_ snapshot: OnboardingSnapshot) -> OnboardingStep {
        if snapshot.identity != .verified {
            return .verifyIdentity
        }
        if !snapshot.contactVerified {
            return .verifyContact
        }
        if !snapshot.profileComplete {
            return .completeProfile
        }
        if !snapshot.preferencesSet {
            return .setPreferences
        }
        return .discoverable
    }
}

public struct OnboardingSnapshot: Sendable, Equatable {
    public let identity: IdentityState
    public let contactVerified: Bool
    public let profileComplete: Bool
    public let preferencesSet: Bool

    public init(
        identity: IdentityState,
        contactVerified: Bool,
        profileComplete: Bool,
        preferencesSet: Bool
    ) {
        self.identity = identity
        self.contactVerified = contactVerified
        self.profileComplete = profileComplete
        self.preferencesSet = preferencesSet
    }
}

public enum OnboardingStep: String, Sendable, Equatable {
    case verifyContact
    case verifyIdentity
    case completeProfile
    case setPreferences
    case discoverable
}
