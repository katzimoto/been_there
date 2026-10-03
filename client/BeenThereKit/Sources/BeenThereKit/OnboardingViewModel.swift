import Foundation

/// The onboarding checklist, as the server publishes it.
///
/// ## Every field here came from a response
///
/// `OnboardingReadiness` is `readinessFor`'s output, byte for byte: `outstanding`
/// is the server's list in `ONBOARDING_ORDER`, `nextStep` is its first element,
/// and `discoverable` is the server's own four-clause predicate. None of them is
/// recomputed here, because §3 says the checklist is "driven by the projections
/// above, not a hard-coded 'you are not verified' flag" — a view model that
/// rebuilt the list from booleans would be exactly the flag the spec denies.
///
/// The one thing this file decides is *how to say* each step, because copy is the
/// client's job and the server does not publish any.
public struct OnboardingViewModel: Sendable, Equatable {

    /// One row of the checklist, as it is shown.
    public struct Row: Sendable, Equatable, Identifiable {
        public var id: OnboardingReadiness.Step { step }

        public let step: OnboardingReadiness.Step
        /// What the user is told to do. The copy is the client's; the *fact* that
        /// the step is outstanding came from `outstanding`.
        public let title: String
        public let isNext: Bool
        public let isComplete: Bool
    }

    /// States in which identity verification is outstanding but the member cannot
    /// act on it — they are waiting on a provider or a person.
    ///
    /// `onboarding.ts` is explicit that the *checklist* treats these alike: none
    /// of them is a state a user reaches discovery from, and a checklist that
    /// called them done would be lying about the one thing it exists to report.
    /// What differs is the *screen* — "we are checking" rather than "do this".
    public enum WaitingState: String, Sendable, Equatable {
        case pending
        case reviewRequired = "review_required"
        case verificationFailed = "verification_failed"
        case expired
    }

    public let headline: String
    /// The single call to action, or `nil` when nothing is outstanding.
    public let nextActionTitle: String?
    public let rows: [Row]
    /// The server's own predicate, read rather than recomputed.
    public let isDiscoverable: Bool
    /// What "done" means, in words. A percentage is deliberately absent:
    /// `GET /v1/profiles/me` is a closed shape for the same reason.
    public let completionSummary: String
    /// Set when the member is waiting on something only a third party can resolve.
    public let waitingOn: WaitingState?

    /// Builds the screen from the server's readiness projection.
    public init(_ readiness: OnboardingReadiness) {
        self.isDiscoverable = readiness.discoverable
        self.waitingOn = OnboardingViewModel.waitingState(for: readiness.identity.state)

        // `photo_screening` is shown only while identity is not `verified`, which is
        // exactly when the server's own comment says it drops off: "It appears in
        // the vocabulary because the client's copy names it, and it drops off the
        // list the moment the identity state is `verified`." Listing it afterwards
        // would claim a step the member cannot act on.
        let showsPhotoScreening = readiness.identity.state != .verified
        let outstanding = Set(readiness.outstanding)
        self.rows = OnboardingReadiness.Step.allCases
            .filter { showsPhotoScreening || $0 != .photoScreening }
            .map { step in
                Row(
                    step: step,
                    title: OnboardingViewModel.copy[step] ?? step.rawValue,
                    isNext: step == readiness.nextStep,
                    isComplete: !outstanding.contains(step)
                )
            }

        self.completionSummary = "\(rows.filter(\.isComplete).count) of \(rows.count) complete"

        // The headline does not claim the member is ready unless the server said
        // `discoverable: true`. An outstanding list is not a percentage and the
        // two are not the same fact.
        if readiness.discoverable {
            self.headline = "You're ready to start browsing."
            self.nextActionTitle = nil
        } else if let next = readiness.nextStep {
            self.headline = "A few things left before you can browse."
            self.nextActionTitle = OnboardingViewModel.actionTitle[next]
        } else {
            // Nothing outstanding and not discoverable: the server's own
            // conjunction is false on a clause the checklist does not list. Said
            // plainly rather than as "you're done", which would be a claim the
            // projection does not support.
            self.headline = "Your setup is complete, but browsing isn't available yet."
            self.nextActionTitle = nil
        }
    }

    // MARK: Copy
    //
    // The only judgement in this file. Each line hangs off a server step id, so a
    // step this build has never heard of falls back to its raw id rather than
    // being dropped — dropping it would make the checklist silently shorter than
    // the truth, which is the failure mode a checklist exists to prevent.

    static let copy: [OnboardingReadiness.Step: String] = [
        .contactVerification: "Confirm your email or phone",
        .ageGate: "Confirm your date of birth",
        .terms: "Accept the current terms",
        .identityVerification: "Verify your identity",
        .profile: "Finish your profile",
        .preferences: "Set who you would like to meet",
        .photoScreening: "Photo screening",
    ]

    static let actionTitle: [OnboardingReadiness.Step: String] = [
        .contactVerification: "Confirm your contact",
        .ageGate: "Confirm your date of birth",
        .terms: "Read the terms",
        .identityVerification: "Start verification",
        .profile: "Finish your profile",
        .preferences: "Set your preferences",
        .photoScreening: "Check your photos",
    ]

    /// The states in which the identity step is outstanding and the member waits.
    ///
    /// `verified` and `unverified` are absent because neither is a wait: one is
    /// the starting state the member can act on, the other is the goal.
    static func waitingState(for state: IdentityState) -> WaitingState? {
        switch state {
        case .pending: return .pending
        case .reviewRequired: return .reviewRequired
        case .verificationFailed: return .verificationFailed
        case .expired: return .expired
        case .verified, .unverified: return nil
        }
    }
}

// MARK: - The client gate, and how a disagreement is reported

extension OnboardingViewModel {

    /// Whether the client should *offer* discovery.
    ///
    /// `ClientGate.canBrowseDiscovery`, and nothing else.
    public static func browseIsAvailable(viewer: ViewerSnapshot) -> Bool {
        ClientGate.canBrowseDiscovery(viewer)
    }

    /// Whether the client and the server disagree about discoverability.
    ///
    /// The two are different predicates, not copies. `readiness.discoverable` is a
    /// four-clause conjunction (identity, account state, profile state,
    /// preferences); `ClientGate.canBrowseDiscovery` is the two-clause client
    /// mirror. A disagreement is a defect in one of the two, so it is *reported*
    /// rather than resolved by quietly preferring an answer.
    ///
    /// The only direction that is a defect is readiness true and gate false: the
    /// server would show this member people while the client withholds the tab.
    /// The other direction means the client would offer a page the server filters
    /// to nothing, which is the safe direction and is not reported.
    public static func reportsGateDisagreement(
        readiness: OnboardingReadiness,
        viewer: ViewerSnapshot
    ) -> Bool {
        readiness.discoverable && !ClientGate.canBrowseDiscovery(viewer)
    }

    /// Whether the server's `nextStep` agrees with the client mirror.
    ///
    /// `ClientGate.onboardingNextStep` is the narrow mirror: contact, identity,
    /// profile, preferences — the four steps it holds a fact for. It walks
    /// `OnboardingReadiness.Step.allCases`, which is the server's own order, so
    /// the two cannot disagree about *which* step comes first; what is left is
    /// only whether each side considers it outstanding. The server's list is
    /// wider — it also carries `age_gate` and `terms` — so the two can still
    /// differ legitimately. They differ *defectively* when the mirror names a
    /// step the server does not consider next, which means one of them is out of
    /// step with the other and the checklist would send the member somewhere the
    /// server did not ask for.
    ///
    /// A mirror step the server has no equivalent for is not a disagreement: the
    /// server is strictly more specific and `age_gate`/`terms` have no mirror
    /// counterpart by design.
    public static func reportsStepDisagreement(
        readiness: OnboardingReadiness,
        viewer: ViewerSnapshot
    ) -> Bool {
        let mirrored = ClientGate.onboardingNextStep(
            OnboardingSnapshot(
                identity: viewer.identity,
                contactVerified: readiness.contactVerified,
                profileComplete: readiness.profileState == .complete,
                preferencesSet: readiness.preferencesSet
            )
        )
        guard let server = readiness.nextStep,
              let mirror = ClientGate.serverStep(for: mirrored)
        else {
            // One side reached its terminal state while the other still has an
            // outstanding step.
            return (readiness.nextStep == nil) != (mirrored == .discoverable)
        }
        return server != mirror
    }

}