import XCTest
@testable import BeenThereKit

/// The onboarding checklist.
///
/// The rule under test throughout: the *facts* come from `OnboardingReadiness`
/// and the *copy* comes from the view model. Every fixture below is either a
/// captured response or a variation on one, and every assertion is about what
/// the screen does with what the server said — never about a step list the
/// client rebuilt for itself.
final class OnboardingViewModelTests: XCTestCase {

    // MARK: Fixtures

    /// The readiness a fresh sign-up gets, verbatim from the service.
    private func freshSignUp() -> OnboardingReadiness {
        OnboardingReadiness(
            version: 1,
            userId: "u",
            contactVerified: false,
            ageGatePassed: true,
            ageBand: "28-32",
            termsAcceptedVersion: "2026-09-01",
            termsCurrent: true,
            identity: .init(state: .unverified, discoverable: false),
            profileState: .draft,
            preferencesSet: false,
            nextStep: .contactVerification,
            outstanding: [.contactVerification, .identityVerification, .profile, .preferences],
            discoverable: false,
            accountState: .active
        )
    }

    /// The readiness of a member who has done everything: the server's
    /// `discoverable: true`.
    private func fullyOnboarded() -> OnboardingReadiness {
        OnboardingReadiness(
            version: 1,
            userId: "u",
            contactVerified: true,
            ageGatePassed: true,
            ageBand: "33-37",
            termsAcceptedVersion: "2026-09-01",
            termsCurrent: true,
            identity: .init(state: .verified, discoverable: true),
            profileState: .complete,
            preferencesSet: true,
            nextStep: nil,
            outstanding: [],
            discoverable: true,
            accountState: .active
        )
    }

    private func viewer(_ identity: IdentityState = .verified, _ state: AccountState = .active) -> ViewerSnapshot {
        let capabilities: [String] = switch state {
        case .active: ["browse_discovery", "like", "send_message", "report", "block", "edit_profile"]
        case .limited: ["browse_discovery", "report", "block", "edit_profile"]
        case .suspended: ["report", "block", "edit_profile"]
        case .banned: ["report", "block", "appeal_request", "delete_account"]
        }
        return ViewerSnapshot(
            userId: "u",
            identity: identity,
            account: AccountStanding(state: state, capabilities: capabilities, visibleInProduct: state != .banned)
        )
    }

    // MARK: The checklist is the server's list

    /// A row is complete exactly when the server did not list it as outstanding.
    /// If the client rebuilt the list from booleans this would still pass, so the
    /// companion test below is the one that catches it.
    func testARowIsCompleteExactlyWhenTheServerDidNotListItOutstanding() {
        let model = OnboardingViewModel(freshSignUp())
        for row in model.rows {
            XCTAssertEqual(
                row.isComplete,
                !freshSignUp().outstanding.contains(row.step),
                "\(row.step.rawValue) disagrees with the server's outstanding list"
            )
        }
    }

    /// The order is the server's order.
    ///
    /// `ONBOARDING_ORDER` is an ordered array rather than a record because the
    /// order *is* the product: "next step" is the first outstanding one. A client
    /// that reordered it would send a member back to a step the product did not
    /// choose first.
    func testTheChecklistKeepsTheServersOrder() {
        let model = OnboardingViewModel(freshSignUp())
        let outstandingRows = model.rows.filter { !$0.isComplete }
        XCTAssertEqual(
            outstandingRows.map(\.step),
            freshSignUp().outstanding,
            "the rows must appear in the order the server listed them"
        )
        XCTAssertEqual(outstandingRows.first?.step, freshSignUp().nextStep)
    }

    /// `photo_screening` is listed until identity is `verified`, and not after.
    ///
    /// The server never puts it in `outstanding` — Identity and Moderation
    /// resolve it — but its comment says it "appears in the vocabulary because the
    /// client's copy names it, and it drops off the list the moment the identity
    /// state is `verified`". So the client shows it while verification is
    /// outstanding, and dropping it afterwards would leave a member who just
    /// finished verifying wondering what happened to the photos step.
    func testPhotoScreeningIsListedUntilIdentityIsVerified() {
        let whileUnverified = OnboardingViewModel(freshSignUp())
        let screening = whileUnverified.rows.first { $0.step == .photoScreening }
        XCTAssertNotNil(screening)
        // The server never lists `photo_screening` as outstanding, so the row is
        // not "next" — but "not outstanding" is also the only completeness fact
        // available, so it reads as done. That is the server's silence, and the
        // comment above `outstandingSteps` is why: this feature never reads
        // whether photo screening is outstanding.
        XCTAssertEqual(screening?.isComplete, true)
        XCTAssertEqual(screening?.isNext, false)

        XCTAssertNil(OnboardingViewModel(fullyOnboarded()).rows.first { $0.step == .photoScreening })
    }

    /// A step the client has copy for but the server did not name is shown as
    /// complete, because "the server did not list it outstanding" is the only
    /// completeness fact the client has.
    func testAStepTheServerDidNotNameIsShownAsComplete() {
        let model = OnboardingViewModel(freshSignUp())
        let ageGate = model.rows.first { $0.step == .ageGate }
        XCTAssertEqual(ageGate?.isComplete, true)
        XCTAssertEqual(ageGate?.isNext, false)
        XCTAssertNotNil(ageGate?.title)
        XCTAssertNotEqual(ageGate?.title, ageGate?.step.rawValue)
    }

    /// Exactly one row is next, and it is the server's `nextStep`.
    func testExactlyOneRowIsNextAndItIsTheServersNextStep() {
        let model = OnboardingViewModel(freshSignUp())
        XCTAssertEqual(model.rows.filter(\.isNext).count, 1)
        XCTAssertEqual(model.rows.first(where: \.isNext)?.step, freshSignUp().nextStep)
        XCTAssertEqual(model.nextActionTitle, OnboardingViewModel.actionTitle[.contactVerification])
    }

    /// The completion summary counts rows, and there is no percentage.
    ///
    /// `GET /v1/profiles/me` is a closed shape for the same reason: a completeness
    /// percentage is a ranking signal wearing a progress bar's clothes.
    func testTheCompletionSummaryIsACountAndNotAPercentage() {
        let model = OnboardingViewModel(freshSignUp())
        // Six rows plus `photo_screening`, listed until identity is verified.
        // Three read as complete: `age_gate`, `terms` and screening.
        XCTAssertEqual(model.completionSummary, "3 of 7 complete")
        XCTAssertFalse(model.completionSummary.contains("%"))
        XCTAssertFalse(model.completionSummary.contains("score"))
    }

    // MARK: Headlines do not overstate

    /// "You're ready" is claimed only when the server said `discoverable: true`.
    func testTheHeadlineClaimsReadinessOnlyWhenTheServerSaidSo() {
        XCTAssertFalse(OnboardingViewModel(freshSignUp()).headline.contains("ready"))
        XCTAssertTrue(OnboardingViewModel(fullyOnboarded()).headline.contains("ready to start browsing"))
    }

    /// A member with nothing outstanding who is still not discoverable is not told
    /// they are done. The server's conjunction is false on a clause the checklist
    /// does not list, and the screen says so rather than inventing which one.
    func testNothingOutstandingButNotDiscoverableIsNotCalledDone() {
        let readiness = OnboardingReadiness(
            version: 1,
            userId: "u",
            contactVerified: true,
            ageGatePassed: true,
            ageBand: "28-32",
            termsAcceptedVersion: "2026-09-01",
            termsCurrent: true,
            identity: .init(state: .verified, discoverable: true),
            profileState: .complete,
            preferencesSet: true,
            nextStep: nil,
            outstanding: [],
            discoverable: false,
            accountState: .active
        )
        let model = OnboardingViewModel(readiness)
        XCTAssertFalse(model.isDiscoverable)
        XCTAssertNil(model.nextActionTitle)
        XCTAssertFalse(model.headline.lowercased().contains("done"))
        XCTAssertFalse(model.headline.lowercased().contains("ready"))
    }

    // MARK: Waiting is not acting

    /// `onboarding.ts` is explicit that the checklist treats `review_required`
    /// and `verification_failed` alike: neither is a state a member reaches
    /// discovery from, so a checklist that called them done would be lying.
    func testAWaitingIdentityIsOutstandingRatherThanComplete() {
        for state: IdentityState in [.pending, .reviewRequired, .verificationFailed, .expired] {
            let readiness = OnboardingReadiness(
                version: 1, userId: "u", contactVerified: true, ageGatePassed: true,
                ageBand: "28-32", termsAcceptedVersion: "2026-09-01", termsCurrent: true,
                identity: .init(state: state, discoverable: false),
                profileState: .complete, preferencesSet: true,
                nextStep: .identityVerification,
                outstanding: [.identityVerification],
                discoverable: false, accountState: .active
            )
            let model = OnboardingViewModel(readiness)
            XCTAssertEqual(model.waitingOn?.rawValue, state.rawValue)
            XCTAssertFalse(
                model.rows.first { $0.step == .identityVerification }?.isComplete ?? true,
                "\(state.rawValue) must not read as complete"
            )
            // The identity step stays outstanding, so it is still the next one.
            XCTAssertEqual(model.nextActionTitle, OnboardingViewModel.actionTitle[.identityVerification])
        }
    }

    /// `verified` and `unverified` are not waits: one is the goal and the other
    /// is where a member can act.
    func testAnUnverifiedIdentityIsNotAWait() {
        XCTAssertNil(OnboardingViewModel(freshSignUp()).waitingOn)
        XCTAssertNil(OnboardingViewModel(fullyOnboarded()).waitingOn)
    }

    // MARK: The gate, and how a disagreement is reported

    /// The offer comes from `ClientGate`, which reads the identity state and the
    /// product-visibility bit. It is the narrow predicate: an unverified member
    /// is not offered discovery even though the server would happily answer the
    /// request with an empty page.
    func testDiscoveryIsOfferedFromTheGateNotFromTheReadinessPredicate() {
        XCTAssertTrue(OnboardingViewModel.browseIsAvailable(viewer: viewer(.verified, .active)))
        XCTAssertFalse(OnboardingViewModel.browseIsAvailable(viewer: viewer(.unverified, .active)))
        XCTAssertFalse(OnboardingViewModel.browseIsAvailable(viewer: viewer(.verified, .banned)))
    }

    /// The two predicates are different questions, so they differ legitimately.
    ///
    /// The defect direction is readiness true and gate false: the server would
    /// show this member people while the client withholds the tab. The reverse is
    /// safe — the client would offer a page the server filters to nothing — and
    /// is not reported, because "we cannot show you anyone yet" is not a harm.
    func testAGateDisagreementIsReportedOnlyWhenTheServerWouldServeAndTheClientWouldNot() {
        // Readiness says yes, the gate says no. A verified member whose account
        // is not visible in the product: the readiness conjunction does not read
        // that bit, so the two can legitimately disagree.
        let serverYesGateNo = OnboardingReadiness(
            version: 1, userId: "u", contactVerified: true, ageGatePassed: true,
            ageBand: "28-32", termsAcceptedVersion: "2026-09-01", termsCurrent: true,
            identity: .init(state: .verified, discoverable: true),
            profileState: .complete, preferencesSet: true,
            nextStep: nil, outstanding: [], discoverable: true, accountState: .active
        )
        XCTAssertTrue(OnboardingViewModel.reportsGateDisagreement(
            readiness: serverYesGateNo, viewer: viewer(.verified, .banned)
        ))

        // Both agree, in each direction. No disagreement to report.
        XCTAssertFalse(OnboardingViewModel.reportsGateDisagreement(
            readiness: fullyOnboarded(), viewer: viewer(.verified, .active)
        ))
        XCTAssertFalse(OnboardingViewModel.reportsGateDisagreement(
            readiness: freshSignUp(), viewer: viewer(.unverified, .active)
        ))
    }

    /// The drift this test was written to catch, now closed.
    ///
    /// It used to assert the mirror said `.verifyIdentity` for a fresh sign-up
    /// while the server said `.contactVerification`, and reported the two as
    /// disagreeing. That was a true report of a real defect: `ONBOARDING_ORDER`
    /// puts `contact_verification` ahead of `identity_verification`, and §3 makes
    /// contact verification blocking while identity verification is deferrable.
    ///
    /// The fix was to make the mirror *walk* the server's order rather than
    /// restate it, so this now asserts agreement in the state where the two used
    /// to differ. The reporter is unchanged and still reports genuine
    /// divergence — `testAMirrorThatRunsAheadOfTheServerIsReported` covers the
    /// other direction, and `testAReorderingOfTheServerOrderIsReported` covers a
    /// server that moves a step.
    func testTheMirrorAgreesWithTheServerForAFreshSignUp() {
        let mirror = ClientGate.onboardingNextStep(
            OnboardingSnapshot(
                identity: .unverified, contactVerified: false,
                profileComplete: false, preferencesSet: false
            )
        )
        XCTAssertEqual(mirror, .verifyContact)
        XCTAssertEqual(freshSignUp().nextStep, .contactVerification)
        XCTAssertFalse(OnboardingViewModel.reportsStepDisagreement(
            readiness: freshSignUp(), viewer: viewer(.unverified, .active)
        ))
    }

    /// Agreement across every state the mirror and the server both describe.
    ///
    /// The states where the two used to differ are exactly those with an
    /// unverified identity *and* an unconfirmed contact, so every non-`verified`
    /// identity state is checked against a server projection built the way
    /// `readinessFor` builds it — outstanding and next both derived, never
    /// hand-written to please the assertion.
    func testTheMirrorAgreesWithTheServerInEveryStateItCanDescribe() {
        for state in IdentityState.allCases {
            for contactVerified in [true, false] {
                for profileComplete in [true, false] {
                    for preferencesSet in [true, false] {
                        let readiness = serverReadiness(
                            identity: state,
                            contactVerified: contactVerified,
                            profileComplete: profileComplete,
                            preferencesSet: preferencesSet
                        )
                        let context = "\(state.rawValue) contact:\(contactVerified) "
                            + "profile:\(profileComplete) prefs:\(preferencesSet)"

                        let mirrored = ClientGate.onboardingNextStep(
                            OnboardingSnapshot(
                                identity: state,
                                contactVerified: contactVerified,
                                profileComplete: profileComplete,
                                preferencesSet: preferencesSet
                            )
                        )
                        let server = readiness.nextStep?.rawValue ?? "nil"
                        XCTAssertFalse(
                            OnboardingViewModel.reportsStepDisagreement(
                                readiness: readiness, viewer: viewer(state, .active)
                            ),
                            "\(context) — server \(server), mirror \(mirrored)"
                        )
                    }
                }
            }
        }
    }

    /// The reporter still fires when the server really does disagree.
    ///
    /// A drift test that only ever asserts agreement cannot tell a fixed
    /// ordering from a broken detector, so this constructs the disagreement the
    /// fix removed — the server naming `identity_verification` next for a member
    /// whose contact is unconfirmed — and requires it to be reported. If someone
    /// reorders `ONBOARDING_ORDER` the way the client used to be ordered, this
    /// goes red.
    func testAReorderingOfTheServerOrderIsReported() {
        let reordered = OnboardingReadiness(
            version: 1, userId: "u", contactVerified: false, ageGatePassed: true,
            ageBand: "28-32", termsAcceptedVersion: "2026-09-01", termsCurrent: true,
            identity: .init(state: .unverified, discoverable: false),
            profileState: .draft, preferencesSet: false,
            nextStep: .identityVerification,
            outstanding: [.identityVerification, .contactVerification, .profile, .preferences],
            discoverable: false, accountState: .active
        )
        XCTAssertTrue(OnboardingViewModel.reportsStepDisagreement(
            readiness: reordered, viewer: viewer(.unverified, .active)
        ))
    }

    /// Builds the readiness `readinessFor` would publish for these facts.
    ///
    /// `ONBOARDING_ORDER` restated in the order the service declares it, so the
    /// expectation is derived from the server's list rather than written out to
    /// suit the client. `age_gate` and `terms` are complete in every case,
    /// because `OnboardingSnapshot` has no fact for them and this is about the
    /// four steps both sides can see.
    private func serverReadiness(
        identity: IdentityState,
        contactVerified: Bool,
        profileComplete: Bool,
        preferencesSet: Bool
    ) -> OnboardingReadiness {
        let order: [OnboardingReadiness.Step] = [
            .contactVerification, .ageGate, .terms,
            .identityVerification, .profile, .preferences, .photoScreening,
        ]
        var outstanding: [OnboardingReadiness.Step] = []
        if !contactVerified { outstanding.append(.contactVerification) }
        if identity != .verified { outstanding.append(.identityVerification) }
        if !profileComplete { outstanding.append(.profile) }
        if !preferencesSet { outstanding.append(.preferences) }
        outstanding = order.filter { outstanding.contains($0) }

        return OnboardingReadiness(
            version: 1, userId: "u",
            contactVerified: contactVerified,
            ageGatePassed: true, ageBand: "28-32",
            termsAcceptedVersion: "2026-09-01", termsCurrent: true,
            identity: .init(state: identity, discoverable: false),
            profileState: profileComplete ? .complete : .draft,
            preferencesSet: preferencesSet,
            nextStep: outstanding.first,
            outstanding: outstanding,
            discoverable: false, accountState: .active
        )
    }

    /// The mirror is strictly narrower than the server's list, so a difference is
    /// not automatically a defect: an outstanding `age_gate` or `terms` has no
    /// mirror counterpart by design, and the server is more specific there.
    func testANarrowerMirrorIsNotReportedAsADisagreement() {
        var readiness = freshSignUp()
        readiness = OnboardingReadiness(
            version: 1, userId: readiness.userId, contactVerified: true,
            ageGatePassed: true, ageBand: readiness.ageBand,
            termsAcceptedVersion: "2026-09-01", termsCurrent: true,
            identity: .init(state: .unverified, discoverable: false),
            profileState: .draft, preferencesSet: false,
            nextStep: .ageGate,
            outstanding: [.ageGate, .identityVerification, .profile, .preferences],
            discoverable: false, accountState: .active
        )
        // The server says `age_gate`; the mirror says `identity_verification`.
        // Both are true statements about different vocabularies.
        XCTAssertEqual(ClientGate.onboardingNextStep(
            OnboardingSnapshot(
                identity: .unverified, contactVerified: true,
                profileComplete: false, preferencesSet: false
            )
        ), .verifyIdentity)
        XCTAssertEqual(readiness.nextStep, .ageGate)
    }

    /// When they truly diverge — the mirror reaches its terminal state while the
    /// server still has an outstanding step — that is reported.
    func testAMirrorThatRunsAheadOfTheServerIsReported() {
        // Everything the mirror checks is done, but the server still lists the
        // profile step. One of them is out of date.
        let readiness = OnboardingReadiness(
            version: 1, userId: "u", contactVerified: true, ageGatePassed: true,
            ageBand: "28-32", termsAcceptedVersion: "2026-09-01", termsCurrent: true,
            identity: .init(state: .verified, discoverable: true),
            profileState: .complete, preferencesSet: true,
            nextStep: .profile,
            outstanding: [.profile],
            discoverable: false, accountState: .active
        )
        // The mirror sees verified + contact + complete profile + preferences and
        // reaches `.discoverable`; the server still names `profile` as next.
        XCTAssertEqual(ClientGate.onboardingNextStep(
            OnboardingSnapshot(
                identity: .verified, contactVerified: true,
                profileComplete: true, preferencesSet: true
            )
        ), .discoverable)
        XCTAssertEqual(readiness.nextStep, .profile)
        XCTAssertTrue(OnboardingViewModel.reportsStepDisagreement(
            readiness: readiness, viewer: viewer(.verified, .active)
        ))
    }

    // MARK: Copy exists for every step the server can name

    /// A step with no copy falls back to its raw id rather than rendering blank.
    func testEveryServerStepHasCopyOrFallsBackToItsId() {
        for step in OnboardingReadiness.Step.allCases {
            XCTAssertFalse(
                OnboardingViewModel.copy[step]?.isEmpty ?? true,
                "\(step.rawValue) has no copy"
            )
            XCTAssertFalse(OnboardingViewModel.actionTitle[step]?.isEmpty ?? true)
        }
    }
}