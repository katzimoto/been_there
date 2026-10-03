import Foundation

/// What the product says to a member whose account is not `active`.
///
/// ## The server is the authority, and this file does not paper over its gaps
///
/// Every field is read from `AccountStanding`, which is
/// `AccountStandingProjection` — the same projection `evaluateEligibility` and
/// `canSend` consume. There is no copy of the capability table here and no
/// reason-naming: that projection carries a state, a capability list and a
/// visibility bit and nothing else, because a projection carrying a reason would
/// turn a dating client into a moderation surface.
///
/// ## The gap this file refuses to fill
///
/// `ClientGate`'s own comment says an honest restriction explanation needs
/// `removedCapabilities` and `caseReference` — "this restriction came from case
/// X" is the basis on which a member can contest it. **The server publishes
/// neither.** `AccountStandingRow` carries `caseId` and `decisionId`, but no
/// response body includes them: `accountProjectionFor` builds its projection from
/// `state`, `capabilities` and `visibleInProduct`, and that is the whole of what
/// any endpoint publishes about standing.
///
/// Naming what was removed needs the unrestricted baseline to subtract from, and
/// the projection publishes no baseline either — a client cannot reconstruct
/// `CAPABILITIES_BY_ACCOUNT_STATE` without copying the kernel's table, which is
/// precisely the second copy this repository exists to prevent. So
/// `RemovedCapabilities` is a closed enum whose real case is `.notPublished`, and
/// `caseReference` is `nil`. Both are typed so a caller cannot mistake "the
/// server does not send this" for "the client forgot to implement it".
public struct RestrictedAccountViewModel: Sendable, Equatable {

    /// What was taken away — which the server does not publish.
    ///
    /// `.notPublished` is not a placeholder. It is the only answer the projection
    /// supports, and it is what the screen renders: the member is told what is
    /// switched off in words, without a machine list that would have to be
    /// derived from a table the client does not hold.
    public enum RemovedCapabilities: Sendable, Equatable {
        /// `AccountStandingProjection` publishes neither the removed set nor the
        /// unrestricted baseline it would be subtracted from.
        case notPublished

        /// Whether the client can name the removed set. False today.
        public var isKnown: Bool {
            if case .notPublished = self { return false }
            return true
        }
    }

    /// The member-facing screen.
    public let title: String
    public let body: String
    /// Always `.notPublished` today. Typed rather than omitted so the absence is
    /// a finding rather than an oversight.
    public let removed: RemovedCapabilities
    /// The capabilities that survive every restriction, restated to the member.
    ///
    /// `UNRESTRICTABLE_CAPABILITIES` in the kernel is `report`, `block` and
    /// `delete_account`. They are read back out of what the server *granted*
    /// rather than copied from a list: the point of the screen is that these
    /// three are always present, so reading them off the granted set means a
    /// server that stopped granting one would make them vanish from the screen
    /// rather than being contradicted by it.
    public let alwaysAvailable: [String]
    /// `nil` because no endpoint publishes the deciding case.
    public let caseReference: String?
    /// The one action the screen must never withhold.
    public let primaryAction: PrimaryAction

    /// What a restricted member is still allowed to do next.
    public enum PrimaryAction: Sendable, Equatable {
        /// A restriction the member cannot lift themselves. Nothing is actionable,
        /// and the honest screen says so rather than offering a retry the server
        /// would refuse.
        case wait
        /// Leaving. Offered only where the projection grants `delete_account` —
        /// `banned`, and **not** `suspended`, because the kernel's capability table
        /// grants the exit only where the sanction is not reversible by a named
        /// moderator. `core` says withholding it there strands the account:
        /// sanctioned, unappealable, and unable to leave.
        case deleteAccount
        /// `active`: nothing to offer, so there is no primary action.
        case none
    }

    /// Builds the screen from the published standing.
    ///
    /// The copy for each state names, in words, what the member cannot do. That
    /// is the one thing `state` alone supports: `state` is in the projection, so
    /// the sentence about it is grounded, while a list of the individual
    /// capabilities that went with it would not be.
    public init(standing: AccountStanding) {
        self.caseReference = nil
        self.removed = .notPublished
        self.alwaysAvailable = RestrictedAccountViewModel.alwaysAvailable(from: standing)

        switch standing.state {
        case .active:
            self.title = "Your account is active"
            self.body = "Everything on your account is switched on."
            self.primaryAction = .none

        case .limited:
            self.title = "Some features are turned off"
            self.body = "Messaging is unavailable right now. You can still browse,"
                + " report a concern and block someone."
            self.primaryAction = .wait

        case .suspended:
            self.title = "Your account is suspended"
            self.body = "Messaging and browsing are unavailable while your account is suspended."
                + " You can still report a concern and block someone."
            self.primaryAction = RestrictedAccountViewModel.primaryAction(for: standing)

        case .banned:
            self.title = "Your account is banned"
            self.body = "Messaging and browsing are unavailable."
                + " You can still report a concern, block someone, or delete your account."
            // Also derived, for the same reason: the banned screen must not offer
            // an exit the projection did not grant, and `core` says withholding it
            // strands the account. Deriving means a server that stopped granting
            // it would remove the affordance rather than the screen contradicting
            // the server.
            self.primaryAction = RestrictedAccountViewModel.primaryAction(for: standing)
        }
    }

    /// The capabilities that survive every restriction, read off what was granted.
    ///
    /// The kernel's floor is `report`, `block` and `delete_account`, applied where
    /// the grant is computed — so a restricted account's granted set already
    /// contains all three. Reading them back means the screen asserts only what
    /// the server actually granted, and never contradicts it.
    static func alwaysAvailable(from standing: AccountStanding) -> [String] {
        let floor = ["report", "block", "delete_account"]
        return floor.filter { standing.capabilities.contains($0) }
    }

    /// The one action the screen offers, read off the granted set.
    ///
    /// Not a table in this file. `delete_account` is on the kernel's
    /// `UNRESTRICTABLE_CAPABILITIES` and the floor is applied where the grant is
    /// computed — but the *capability table* only grants it on `banned`, because a
    /// suspension is reversible by a named moderator and a ban is not. Deriving
    /// from the granted set rather than from the state is what keeps a suspended
    /// member from being offered an exit the server will refuse.
    static func primaryAction(for standing: AccountStanding) -> PrimaryAction {
        switch standing.state {
        case .active:
            return .none
        case .limited:
            // A restriction the member cannot lift themselves.
            return .wait
        case .suspended, .banned:
            return standing.capabilities.contains("delete_account") ? .deleteAccount : .wait
        }
    }
}

// MARK: - The claims a restricted screen must never make

extension RestrictedAccountViewModel {

    /// Whether the screen still offers reporting and blocking.
    ///
    /// Both are unrestrictable on the server and `ClientGate` mirrors that, so
    /// this is a *readback* of the granted set rather than a rule: it can only be
    /// false if the server itself withheld them, which is the defect worth
    /// tripping over. A restricted screen that hid "report" would be the worst
    /// possible failure of a safety product, so it is asserted here as well.
    public static func keepsSafetyControls(_ standing: AccountStanding) -> Bool {
        ClientGate.canReport(viewer(standing)) && ClientGate.canBlock(viewer(standing))
    }

    /// Whether the screen can still offer the exit.
    ///
    /// `ClientGate.canEditOwnProfile` treats a banned member as able to reach their
    /// own profile precisely so deletion stays reachable; this reads the capability
    /// the kernel put there for it.
    public static func offersTheExit(_ standing: AccountStanding) -> Bool {
        ClientGate.canDeleteAccount(viewer(standing))
    }

    private static func viewer(_ standing: AccountStanding) -> ViewerSnapshot {
        ViewerSnapshot(userId: "", identity: .verified, account: standing)
    }
}