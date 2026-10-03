import XCTest
@testable import BeenThereKit

/// The restricted-account screen and the discovery list.
///
/// Both are driven entirely by projections the server publishes. The property
/// under test throughout is that the client never *adds* a fact: every assertion
/// checks what the screen says against what the payload contained, and the two
/// tests that matter most are the ones proving the client declines to invent
/// something the server did not send.
final class RestrictedAndDiscoveryViewModelTests: XCTestCase {

    // MARK: Fixtures — the capability sets the kernel's own table declares

    private func standing(
        _ state: AccountState,
        _ capabilities: [String],
        visible: Bool = true
    ) -> AccountStanding {
        AccountStanding(state: state, capabilities: capabilities, visibleInProduct: visible)
    }
    /// `CAPABILITIES_BY_ACCOUNT_STATE.active`, verbatim.
    private var active: AccountStanding {
        standing(.active, ["browse_discovery", "like", "send_message", "report", "block", "edit_profile"])
    }

    /// `CAPABILITIES_BY_ACCOUNT_STATE.limited`, verbatim: `send_message` and
    /// `like` are what the table drops.
    private var limited: AccountStanding {
        standing(.limited, ["browse_discovery", "report", "block", "edit_profile"])
    }

    /// `CAPABILITIES_BY_ACCOUNT_STATE.suspended`, verbatim.
    private var suspended: AccountStanding {
        standing(.suspended, ["report", "block", "edit_profile"])
    }

    /// `CAPABILITIES_BY_ACCOUNT_STATE.banned`, verbatim. `delete_account` is on
    /// this set for the reason the kernel says: withholding it strands a banned
    /// account — sanctioned, unappealable, and unable to leave.
    private var banned: AccountStanding {
        standing(
            .banned,
            ["report", "block", "appeal_request", "delete_account"],
            visible: false
        )
    }

    // MARK: The restriction screen says what the projection supports

    func testEachStateGetsItsOwnScreen() {
        XCTAssertEqual(RestrictedAccountViewModel(standing: active).title, "Your account is active")
        XCTAssertEqual(RestrictedAccountViewModel(standing: limited).title, "Some features are turned off")
        XCTAssertEqual(RestrictedAccountViewModel(standing: suspended).title, "Your account is suspended")
        XCTAssertEqual(RestrictedAccountViewModel(standing: banned).title, "Your account is banned")
    }

    func testAnActiveAccountOffersNoPrimaryAction() {
        XCTAssertEqual(RestrictedAccountViewModel(standing: active).primaryAction, .none)
    }

    /// Only `banned` is offered the exit.
    ///
    /// `delete_account` is on `UNRESTRICTABLE_CAPABILITIES` — a floor applied
    /// where the grant is computed — but `CAPABILITIES_BY_ACCOUNT_STATE` only
    /// *grants* it on `banned`, because a suspension is reversible by a named
    /// moderator and a ban is not. Offering it on a suspended account would be an
    /// affordance the server refuses, which is the failure this exercise exists
    /// to avoid.
    func testOnlyABannedAccountIsOfferedTheExit() {
        XCTAssertEqual(RestrictedAccountViewModel(standing: banned).primaryAction, .deleteAccount)
        XCTAssertTrue(RestrictedAccountViewModel.offersTheExit(banned))

        XCTAssertEqual(RestrictedAccountViewModel(standing: suspended).primaryAction, .wait)
        XCTAssertFalse(RestrictedAccountViewModel.offersTheExit(suspended))
        XCTAssertEqual(RestrictedAccountViewModel(standing: limited).primaryAction, .wait)
        XCTAssertFalse(RestrictedAccountViewModel.offersTheExit(limited))
        XCTAssertEqual(RestrictedAccountViewModel(standing: active).primaryAction, .none)
    }

    /// The action is derived from the granted set, so a server that stopped
    /// granting `delete_account` would remove the affordance rather than the
    /// screen contradicting the projection it was built from.
    func testTheExitFollowsTheGrantedCapabilityNotTheState() {
        let bannedWithoutTheExit = standing(.banned, ["report", "block", "appeal_request"])
        XCTAssertEqual(RestrictedAccountViewModel(standing: bannedWithoutTheExit).primaryAction, .wait)
    }

    /// A `limited` account's restriction is not something the member can undo, so
    /// the screen does not offer an action it cannot honour. `limited` is the
    /// only restricted state whose capability set still carries `edit_profile`,
    /// so a "fix it yourself" affordance would be claiming a change the client
    /// cannot make.
    func testALimitedAccountWaitsRatherThanActing() {
        XCTAssertEqual(RestrictedAccountViewModel(standing: limited).primaryAction, .wait)
        XCTAssertFalse(RestrictedAccountViewModel.offersTheExit(limited))
    }

    // MARK: Reporting and blocking survive every restriction

    /// The single most important assertion in this file. `report` and `block` are
    /// on `UNRESTRICTABLE_CAPABILITIES` in the kernel and the floor is applied
    /// where the grant is computed, so every published set contains both. A
    /// restricted screen that hid "report" would be the worst possible failure of
    /// a safety product.
    func testEveryRestrictedStateStillCarriesReportAndBlock() {
        for published in [active, limited, suspended, banned] {
            XCTAssertTrue(
                RestrictedAccountViewModel.keepsSafetyControls(published),
                "\(published.state.rawValue) lost report or block"
            )
            XCTAssertTrue(published.capabilities.contains("report"))
            XCTAssertTrue(published.capabilities.contains("block"))
        }
    }

    /// The screen restates the unrestrictable floor by reading it back out of
    /// what was granted, so it can never contradict the server.
    func testTheAlwaysAvailableListIsReadBackFromTheGrantedSet() {
        for published in [active, limited, suspended, banned] {
            let model = RestrictedAccountViewModel(standing: published)
            XCTAssertEqual(
                model.alwaysAvailable,
                ["report", "block", "delete_account"].filter {
                    published.capabilities.contains($0)
                }
            )
        }
        // A standing that somehow lacked `block` would lose it from the screen
        // rather than the screen claiming it is available.
        let stripped = standing(.limited, ["report"])
        XCTAssertEqual(
            RestrictedAccountViewModel(standing: stripped).alwaysAvailable,
            ["report"]
        )
    }

    // MARK: The gap, asserted rather than filled

    /// `AccountStandingProjection` publishes `state`, `capabilities` and
    /// `visibleInProduct` — and nothing else. So the removed set and the case
    /// reference are reported as unknown rather than inferred from a copy of the
    /// kernel's capability table, which is exactly the second copy the repository
    /// exists to prevent.
    func testTheRemovedSetAndTheCaseReferenceAreReportedAsUnknown() {
        for published in [active, limited, suspended, banned] {
            let model = RestrictedAccountViewModel(standing: published)
            XCTAssertFalse(model.removed.isKnown, "\(published.state.rawValue) claimed to know the removed set")
            XCTAssertNil(model.caseReference)
        }
    }

    /// The screen says what is switched off in words, and says it for the state
    /// the projection carries. `state` is the one fact every response publishes
    /// about standing, so a sentence about it is grounded.
    func testTheScreenNamesTheConsequenceInWordsForEachState() {
        XCTAssertTrue(
            RestrictedAccountViewModel(standing: limited).body.contains("Messaging is unavailable")
        )
        XCTAssertTrue(
            RestrictedAccountViewModel(standing: suspended).body.contains("suspended")
        )
        XCTAssertTrue(
            RestrictedAccountViewModel(standing: banned).body.contains("delete your account")
        )
        // Every restricted screen names the controls that survive.
        for published in [limited, suspended, banned] {
            let body = RestrictedAccountViewModel(standing: published).body
            XCTAssertTrue(body.contains("report"), "\(published.state.rawValue) lost the report line")
            XCTAssertTrue(body.contains("block"), "\(published.state.rawValue) lost the block line")
        }
    }

    /// Nothing on the screen names a case, a moderator or a reason.
    ///
    /// `AccountStandingProjection` carries a state, a capability list and a
    /// visibility bit and nothing else, "because a projection that carried one
    /// would turn a dating client into a moderation surface". The client's copy
    /// must stay on the same side of that line.
    func testTheScreenNeverNamesACaseOrAModerator() {
        for published in [active, limited, suspended, banned] {
            let model = RestrictedAccountViewModel(standing: published)
            let all = [model.title, model.body].joined(separator: " ").lowercased()
            for forbidden in ["case-", "case #", "moderator", "reported", "reviewed", "because you"] {
                XCTAssertFalse(
                    all.contains(forbidden),
                    "\(published.state.rawValue) screen names \(forbidden)"
                )
            }
        }
    }

    // MARK: The discovery list, and its empty page

    private func readiness(
        discoverable: Bool,
        next: OnboardingReadiness.Step?,
        outstanding: [OnboardingReadiness.Step] = [],
        identity: IdentityState = .verified
    ) -> OnboardingReadiness {
        OnboardingReadiness(
            version: 1, userId: "u", contactVerified: true, ageGatePassed: true,
            ageBand: "28-32", termsAcceptedVersion: "2026-09-01", termsCurrent: true,
            identity: .init(state: identity, discoverable: identity == .verified),
            profileState: discoverable ? .complete : .draft,
            preferencesSet: discoverable,
            nextStep: next, outstanding: outstanding,
            discoverable: discoverable, accountState: .active
        )
    }

    private func card(_ name: String = "Alex") -> CandidateCard {
        CandidateCard(
            projectionVersion: 1, userId: "c-1", displayName: name, age: 29,
            genderIdentities: ["non_binary"], bio: "Long walks.", photoIds: ["p-1"],
            distance: .unknown
        )
    }

    private func page(_ cards: [CandidateCard]) -> DiscoveryPage {
        DiscoveryPage(
            viewerId: "u", projectionVersion: 1, candidates: cards, total: cards.count
        )
    }

    /// A page with cards is a page of cards.
    func testAPageWithCardsIsRenderedAsCards() {
        let model = DiscoveryViewModel(
            page: page([card()]), readiness: readiness(discoverable: true, next: nil), standing: active
        )
        XCTAssertEqual(model.content, .cards([card()]))
        XCTAssertEqual(model.cards.count, 1)
        XCTAssertEqual(model.headline, "People you might get along with")
        XCTAssertEqual(model.bodyText, "1 person")
        XCTAssertFalse(model.offersRetry)
    }

    /// The empty page a member may browse is *empty*, not broken.
    ///
    /// This is the honest sentence. Not "no one near you", which would be a
    /// distance claim the platform never made: `discovery.ts` passes `null` for
    /// separation and calls the band `unknown`.
    func testAnEmptyPageForAnEligibleMemberIsEmptyNotBroken() {
        let model = DiscoveryViewModel(
            page: page([]), readiness: readiness(discoverable: true, next: nil), standing: active
        )
        XCTAssertEqual(model.content, .empty)
        XCTAssertTrue(model.cards.isEmpty)
        XCTAssertEqual(model.total, 0)
        XCTAssertEqual(model.headline, "Nobody to show right now")
        // No retry: the service answered, and the answer was zero.
        XCTAssertFalse(model.offersRetry)
        XCTAssertFalse(model.bodyText.lowercased().contains("try again"))
    }

    /// The empty page for a member who cannot be shown one names the step the
    /// server named — the member's *own* outstanding step, which they are
    /// entitled to know.
    func testAnEmptyPageForAMemberWhoIsNotReadyNamesTheirOwnNextStep() {
        let model = DiscoveryViewModel(
            page: page([]),
            readiness: readiness(
                discoverable: false, next: .identityVerification,
                outstanding: [.identityVerification, .profile]
            ),
            standing: active
        )
        XCTAssertEqual(model.content, .blocked(.notReady(.identityVerification)))
        XCTAssertEqual(model.headline, "Finish setting up to see people")
        XCTAssertEqual(model.bodyText, OnboardingViewModel.copy[.identityVerification])
    }

    /// Not visible in the product outranks "not ready", because it has nothing to
    /// do with the member's own checklist and saying otherwise would send them
    /// to finish onboarding they have already finished.
    func testInvisibleInTheProductOutranksNotReady() {
        let model = DiscoveryViewModel(
            page: page([]),
            readiness: readiness(
                discoverable: false, next: .profile, outstanding: [.profile]
            ),
            standing: banned
        )
        XCTAssertEqual(model.content, .blocked(.notVisible))
        XCTAssertEqual(model.headline, "Your account is not visible right now")
    }

    /// Not discoverable with nothing outstanding: the server's conjunction is
    /// false on a clause the checklist does not list. Said as "not ready" without
    /// inventing which clause.
    func testNotDiscoverableWithNothingOutstandingIsStillNotReady() {
        let model = DiscoveryViewModel(
            page: page([]), readiness: readiness(discoverable: false, next: nil), standing: active
        )
        XCTAssertEqual(model.content, .blocked(.notReady(.profile)))
    }

    /// A `503` and a `total: 0` are different facts about the world and must not
    /// render the same way. Telling a member "there is nobody here" when the
    /// store was unreachable is a falsehood the client invented.
    func testAStoreFaultIsNotAnEmptyPage() {
        let fault = DiscoveryViewModel.failure(.storeUnavailable)
        XCTAssertEqual(fault.content, .unavailable(.storeUnavailable))
        XCTAssertEqual(fault.headline, "We could not load this just now")
        XCTAssertNotEqual(fault.content, .empty)
        // The store's own classification decides the retry, forwarded.
        XCTAssertTrue(fault.offersRetry)
        XCTAssertEqual(fault.total, 0)
    }

    func testANonRetryableFaultDoesNotOfferARetry() {
        let fault = DiscoveryViewModel.failure(.storeFailure)
        XCTAssertFalse(fault.offersRetry)
        XCTAssertEqual(fault.bodyText, "That did not work.")
    }

    func testARefusalOnDiscoveryIsAlsoNotAnEmptyPage() {
        let refusal = APIError(refused: .notEligible, domain: "dating.interaction", message: "no")
        let model = DiscoveryViewModel.failure(refusal)
        XCTAssertEqual(model.content, .unavailable(refusal))
        // A refusal is a real answer, so it does not offer a pointless retry.
        XCTAssertFalse(model.offersRetry)
    }

    // MARK: Nothing about another person is inferred

    /// The page carries no exclusion reasons and the client does not construct
    /// any. Every card rendered came from the server's own `candidates` array,
    /// in the server's order, with no client-side filter or sort.
    func testNoCardIsAddedFilteredOrReordered() {
        let first = CandidateCard(
            projectionVersion: 1, userId: "a", displayName: "Zoe", age: 30,
            genderIdentities: [], bio: "", photoIds: [], distance: .unknown
        )
        let second = CandidateCard(
            projectionVersion: 1, userId: "b", displayName: "Adam", age: 31,
            genderIdentities: [], bio: "", photoIds: [], distance: .unknown
        )
        let model = DiscoveryViewModel(
            page: page([first, second]),
            readiness: readiness(discoverable: true, next: nil),
            standing: active
        )
        // Not sorted by name, even though "Adam" precedes "Zoe".
        XCTAssertEqual(model.cards.map(\.userId), ["a", "b"])
        XCTAssertEqual(model.total, 2)
    }

    /// A card whose content the gate accepted always has a name and a derived
    /// age. One that does not is dropped rather than rendered blank, because a
    /// blank card in front of a person is the wrong answer when the row disagrees
    /// with itself.
    func testACardWithNoNameIsDroppedRatherThanRenderedBlank() {
        let model = DiscoveryViewModel(
            page: page([card(""), card("Real")]),
            readiness: readiness(discoverable: true, next: nil),
            standing: active
        )
        XCTAssertEqual(model.cards.map(\.displayName), ["Real"])
        // `total` is the server's count, forwarded even though a card was dropped.
        XCTAssertEqual(model.total, 2)
    }

    /// `unknown` is not zero and not "nearby".
    func testAnUnknownDistanceIsNotRenderedAsADistance() {
        let model = DiscoveryViewModel(
            page: page([card()]),
            readiness: readiness(discoverable: true, next: nil),
            standing: active
        )
        XCTAssertNil(model.cards.first?.distanceLabel)
        XCTAssertFalse(model.cards.first?.hasRenderableDistance ?? true)
        // And it never leaks into the card's own text.
        XCTAssertFalse(model.bodyText.lowercased().contains("km"))
    }

    // MARK: Affordances are readbacks of the granted set

    /// The like button is offered when the projection says the account has `like`.
    /// `limited` drops it in the kernel's table, so a restricted member is not
    /// offered an action the server will refuse.
    func testTheLikeActionFollowsTheGrantedCapability() {
        XCTAssertTrue(DiscoveryViewModel(page: page([]), readiness: readiness(discoverable: true, next: nil), standing: active).offersLike(active))
        XCTAssertFalse(DiscoveryViewModel(page: page([]), readiness: readiness(discoverable: false, next: nil), standing: limited).offersLike(limited))
    }

    /// Report and block are unrestrictable, so they are offered on every card for
    /// every published state — read back from the granted set, not hard-coded.
    func testSafetyControlsAreOfferedOnACardInEveryState() {
        for published in [active, limited, suspended, banned] {
            let model = DiscoveryViewModel(
                page: page([card()]),
                readiness: readiness(discoverable: true, next: nil),
                standing: published
            )
            XCTAssertTrue(
                model.offersSafetyControls(published),
                "\(published.state.rawValue) lost report or block on a card"
            )
        }
    }
}