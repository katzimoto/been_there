import Foundation

/// The discovery list, and what it shows when there is nothing in it.
///
/// ## The empty page is the interesting case
///
/// `GET /v1/discovery` filters with `evaluateEligibility` and publishes **no
/// reason for any absence**. `discovery.ts` says why at length: the reasons are
/// `internal` by the domain's design, and a reason a client could read would be a
/// side channel for inferring another user's identity state, standing or block.
///
/// That constrains what an empty page may say, and it constrains it hard. This
/// view model has exactly three explanations and each is grounded:
///
///   * the viewer is not discoverable, which the server published on the
///     readiness projection as `discoverable: false` with the reason in
///     `nextStep` — the member's *own* state, which they are entitled to know;
///   * the viewer is not visible in the product, which the account projection
///     published as `visibleInProduct: false`;
///   * the page is simply empty, which the server answered with `total: 0` and no
///     exclusions.
///
/// It never says "no one near you matches", never names a filter, and never
/// distinguishes "nobody is eligible" from "nobody else is here" — because the
/// server does not, and a client that guessed would be teaching people a rule
/// nobody wrote.
public struct DiscoveryViewModel: Sendable, Equatable {

    /// What the screen is showing.
    public enum Content: Sendable, Equatable {
        /// Cards, as published. Not re-filtered, not re-ordered.
        case cards([CandidateCard])
        /// The page is empty and the member cannot be shown it yet.
        case blocked(Reason)
        /// The page is empty and the member may browse.
        case empty
        /// The answer is unknown. Distinct from `empty` on purpose: "we could not
        /// reach the service" is not "there is nobody here".
        case unavailable(APIError)
    }

    /// Why a member is not shown discovery, in the server's own vocabulary.
    ///
    /// Every case is a fact the member's own projections publish. Nothing here
    /// names another person or another person's state.
    public enum Reason: Sendable, Equatable {
        /// The server's readiness projection said `discoverable: false`, and named
        /// the outstanding step.
        case notReady(OnboardingReadiness.Step)
        /// The account projection said `visibleInProduct: false`.
        case notVisible
        /// The member is verified and visible but the page came back empty. The
        /// only honest reading: nobody else is eligible right now.
        case nobodyElse
    }

    public let content: Content
    public let cards: [CandidateCard]
    public let total: Int
    public let projectionVersion: Int

    /// Direct construction, for the failure path only.
    ///
    /// Private so the *only* way to build a list from server data is
    /// `init(page:readiness:standing:)`, which requires all three projections. A
    /// public memberwise init would let a caller assemble a list from a page and
    /// no standing, and would then have to decide the empty-page copy itself.
    private init(
        content: Content,
        cards: [CandidateCard],
        total: Int,
        projectionVersion: Int
    ) {
        self.content = content
        self.cards = cards
        self.total = total
        self.projectionVersion = projectionVersion
    }

    /// Builds the list from the server's page plus the viewer's own two
    /// projections.

    ///
    /// `readiness` is `GET /v1/accounts/:userId/onboarding` and `standing` is the
    /// `account` half of `GET /v1/accounts/:userId`. Both are read for the
    /// member's own state; neither carries anything about another user.
    public init(
        page: DiscoveryPage,
        readiness: OnboardingReadiness,
        standing: AccountStanding
    ) {
        self.projectionVersion = page.projectionVersion
        self.cards = page.candidates.filter(\.isRenderable)
        self.total = page.total

        if !standing.visibleInProduct {
            // Checked before discoverability because it is the stronger fact: a
            // member who is not visible in the product is not shown people for a
            // reason that has nothing to do with their own checklist.
            self.content = .blocked(.notVisible)
        } else if !readiness.discoverable, let next = readiness.nextStep {
            self.content = .blocked(.notReady(next))
        } else if !readiness.discoverable {
            // Not discoverable with nothing outstanding: the server's conjunction
            // is false on a clause the checklist does not list. Said as
            // "not ready" without inventing which clause.
            self.content = .blocked(.notReady(.profile))
        } else if page.candidates.isEmpty {
            self.content = .empty
        } else {
            self.content = .cards(self.cards)
        }
    }

    /// Builds the list for a failure, which is never the same as an empty page.
    ///
    /// A `503` and a `total: 0` are different facts about the world and must not
    /// render the same way — telling a member "there is nobody here" when the
    /// store was unreachable is a falsehood the client invented.
    public static func failure(_ error: APIError) -> DiscoveryViewModel {
        DiscoveryViewModel(content: .unavailable(error), cards: [], total: 0, projectionVersion: 0)
    }

    // MARK: What the screen says

    /// The headline for the current content.
    ///
    /// Copy is the client's; the branch is driven entirely by which case the
    /// server's own projections put the member in.
    public var headline: String {
        switch content {
        case .cards:
            return "People you might get along with"
        case .blocked(.notVisible):
            return "Your account is not visible right now"
        case .blocked(.notReady):
            return "Finish setting up to see people"
        case .blocked(.nobodyElse):
            return "Nobody to show right now"
        case .empty:
            return "Nobody to show right now"
        case .unavailable:
            return "We could not load this just now"
        }
    }

    /// The body for the current content.
    public var bodyText: String {
        switch content {
        case .cards(let cards):
            return "\(cards.count) \(cards.count == 1 ? "person" : "people")"
        case .blocked(.notVisible):
            return "Your account is not visible in Been There at the moment."
        case .blocked(.notReady(let step)):
            return OnboardingViewModel.copy[step] ?? "There is one thing left to finish."
        case .blocked(.nobodyElse), .empty:
            // The one honest sentence. Not "no one near you", which would be a
            // distance claim the platform never made — `discovery.ts` passes
            // `null` for separation and calls the band `unknown`.
            return "There is nobody to show you right now. Check back later."
        case .unavailable(let error):
            return error.isRetryable
                ? "That did not work. Try again in a moment."
                : "That did not work."
        }
    }

    /// Whether a retry button is the right affordance.
    ///
    /// The store's own classification, forwarded: `failure.ts` reads
    /// `StoreError.retryable`, which comes from the driver error code, so the
    /// service is not deciding this either.
    public var offersRetry: Bool {
        if case let .unavailable(error) = content { return error.isRetryable }
        return false
    }

    /// Whether the member may act on a card.
    ///
    /// A readback of the granted capability list, not a rule: the like button is
    /// offered when the account projection says the account has `like`. A card
    /// the server served to a member without that capability is a defect, and the
    /// button is withheld rather than offered-and-refused.
    public func offersLike(_ standing: AccountStanding) -> Bool {
        standing.capabilities.contains("like")
    }

    /// Whether report and block are offered on a card.
    ///
    /// Unrestrictable, and mirrored from `ClientGate`. Reported as a readback of
    /// the granted set rather than hard-coded true, so a server that stopped
    /// granting them trips this instead of the client quietly claiming otherwise.
    public func offersSafetyControls(_ standing: AccountStanding) -> Bool {
        standing.capabilities.contains("report") && standing.capabilities.contains("block")
    }
}

// MARK: - One card's affordances

extension CandidateCard {

    /// Whether the distance is worth rendering at all.
    ///
    /// `unknown` is not zero and not "nearby". `discovery.ts` passes `null`
    /// because there is no location anchor table and a band is not a point, and
    /// the dating domain deliberately treats `unknown` as "could not prove it, so
    /// do not punish the member for it". Rendering that as a distance would undo
    /// the decision the server made.
    public var hasRenderableDistance: Bool { distance.isResolved }

    /// The distance as a person reads it, or `nil` when there is no answer.
    public var distanceLabel: String? {
        guard distance.isResolved else { return nil }
        switch distance {
        case .lt5km: return "Under 5 km away"
        case .from5To25km: return "5 to 25 km away"
        case .from25To50km: return "25 to 50 km away"
        case .from50To100km: return "50 to 100 km away"
        case .over100km: return "Over 100 km away"
        case .unknown: return nil
        }
    }
}