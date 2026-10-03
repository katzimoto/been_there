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

/// The standing projection, as `AccountStandingProjection` publishes it.
///
/// `removedCapabilities`, `baselineCapabilities` and `caseId` are read from the
/// server, never computed here. That is the point of this change: the client
/// used to declare `removedCapabilities` with an empty default and leave
/// `caseReference` nil because the projection published neither, which meant an
/// honest restriction screen had to name what was removed in prose or hold a
/// second copy of `CAPABILITIES_BY_ACCOUNT_STATE`. The server now publishes all
/// three and `AccountStandingDecoding.swift` requires them on the wire.
public struct AccountStanding: Codable, Sendable, Equatable {
    public let state: AccountState
    public let capabilities: [String]
    /// What was taken away, as the server computed it by subtracting the granted
    /// set from the unrestricted baseline. Owner-visible, and carrying no reason
    /// and nobody else's data.
    public let removedCapabilities: [String]
    /// The unrestricted grant, published so the subtraction above is checkable
    /// from both ends rather than being a second copy of the kernel's table.
    public let baselineCapabilities: [String]
    public let visibleInProduct: Bool
    /// The case whose decision produced this standing, or `nil` when no decision
    /// has. Opaque, owner-visible, and the basis on which a member contests the
    /// decision.
    public let caseId: String?

    public init(
        state: AccountState,
        capabilities: [String],
        removedCapabilities: [String] = [],
        baselineCapabilities: [String] = [],
        visibleInProduct: Bool = true,
        caseId: String? = nil
    ) {
        self.state = state
        self.capabilities = capabilities
        self.removedCapabilities = removedCapabilities
        self.baselineCapabilities = baselineCapabilities
        self.visibleInProduct = visibleInProduct
        self.caseId = caseId
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
    /// ## The order is read, not restated
    ///
    /// This walks `OnboardingReadiness.Step.allCases` — which *is* the server's
    /// `ONBOARDING_ORDER` as the client received it — and returns the first step
    /// it can see is outstanding. It used to be an `if` chain that checked
    /// identity before contact: a second, independent copy of an order that
    /// already existed, disagreeing with it. For a fresh sign-up that chain said
    /// `identity_verification` where the server said `contact_verification`, so a
    /// member was sent to verify an identity before the contact the spec makes
    /// blocking — §3 says the funnel "may never skip 1–4", and §5.2 says an
    /// unverified contact is blocking because it is what makes recovery possible.
    ///
    /// ## What it deliberately does not see
    ///
    /// `age_gate`, `terms` and `photo_screening` have no counterpart in
    /// `OnboardingSnapshot`, so they are skipped rather than guessed at. That is
    /// what keeps this a *narrow* mirror rather than a wrong one: it names the
    /// first outstanding step among the four it can see, and the server stays
    /// free to be more specific. `OnboardingViewModel.reportsStepDisagreement`
    /// is where that difference is reported instead of being smoothed over.
    public static func onboardingNextStep(_ snapshot: OnboardingSnapshot) -> OnboardingStep {
        for serverStep in OnboardingReadiness.Step.allCases {
            if let outstanding = snapshot.outstandingMirror(for: serverStep) {
                return outstanding
            }
        }
        return .discoverable
    }

    /// The steps this mirror carries, and the phrase the client uses for each.
    ///
    /// The three that are absent are the ones `OnboardingSnapshot` cannot speak
    /// to at all. Membership here is what "the mirror can see this step" means
    /// everywhere else, so it is stated once rather than in each caller.
    static let mirroredSteps: [OnboardingReadiness.Step: OnboardingStep] = [
        .contactVerification: .verifyContact,
        .identityVerification: .verifyIdentity,
        .profile: .completeProfile,
        .preferences: .setPreferences,
    ]

    /// The server step a mirror step stands for, or `nil` for `.discoverable`.
    ///
    /// The inverse of `mirroredSteps` and derived from it rather than written out
    /// a second time, so the two directions cannot drift apart.
    static func serverStep(for mirror: OnboardingStep) -> OnboardingReadiness.Step? {
        mirroredSteps.first { $0.value == mirror }?.key
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

extension OnboardingSnapshot {
    /// Whether this step is outstanding, in the client's own vocabulary.
    ///
    /// One switch over `ClientGate.mirroredSteps`, so "which fact decides this
    /// step" is written once and the walk in `ClientGate` stays a walk. A step
    /// the mirror does not carry returns `nil`, which is not the same as
    /// "complete" — it means the mirror has no opinion, and the walk keeps
    /// looking.
    func outstandingMirror(for step: OnboardingReadiness.Step) -> OnboardingStep? {
        switch step {
        case .contactVerification:
            return contactVerified ? nil : .verifyContact
        case .identityVerification:
            return identity == .verified ? nil : .verifyIdentity
        case .profile:
            return profileComplete ? nil : .completeProfile
        case .preferences:
            return preferencesSet ? nil : .setPreferences
        case .ageGate, .terms, .photoScreening:
            return nil
        }
    }
}

public enum OnboardingStep: String, Sendable, Equatable {
    case verifyContact
    case verifyIdentity
    case completeProfile
    case setPreferences
    case discoverable
}
