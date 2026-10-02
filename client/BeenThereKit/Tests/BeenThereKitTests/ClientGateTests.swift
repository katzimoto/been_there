import XCTest
@testable import BeenThereKit

/// These are the client's mirrors of the server's rules. Each one asserts a
/// property the *server* also enforces, because the two must agree: a client that
/// offers an action the server refuses is a bug report, and a client that hides
/// an action the server allows is a safety problem.
final class ClientGateTests: XCTestCase {

    private func active(_ extra: [String] = ["send_message", "report", "block", "browse_discovery", "edit_profile"]) -> AccountStanding {
        AccountStanding(state: .active, capabilities: extra)
    }

    private func viewer(
        _ identity: IdentityState = .verified,
        _ account: AccountStanding? = nil
    ) -> ViewerSnapshot {
        ViewerSnapshot(userId: "u-1", identity: identity, account: account ?? active())
    }

    // MARK: Commitment 1 — verified or not discoverable

    func testDiscoveryIsOfferedOnlyToAVerifiedAccount() {
        XCTAssertTrue(ClientGate.canBrowseDiscovery(viewer(.verified)))
        for state in IdentityState.allCases where state != .verified {
            XCTAssertFalse(
                ClientGate.canBrowseDiscovery(viewer(state)),
                "an account in \(state.rawValue) must not be offered discovery"
            )
        }
    }

    func testABannedAccountIsNotOfferedDiscoveryEvenIfVerified() {
        let banned = AccountStanding(state: .banned, capabilities: ["report"], visibleInProduct: false)
        XCTAssertFalse(ClientGate.canBrowseDiscovery(viewer(.verified, banned)))
    }

    // MARK: Reporting and blocking are unrestrictable

    func testAReportAndBlockSurviveEveryRestriction() {
        // The server puts these on the unrestrictable floor; the client mirrors it
        // so it never hides the control a victim needs. If a restriction removes
        // either, that is a defect in one of the two and the test is the tripwire.
        for state in AccountState.allCases {
            let standing = AccountStanding(
                state: state,
                capabilities: ["report", "block", "delete_account"],
                removedCapabilities: ["send_message", "like"],
                visibleInProduct: state != .banned
            )
            let subject = viewer(.verified, standing)
            XCTAssertTrue(ClientGate.canReport(subject), "report must survive \(state.rawValue)")
            XCTAssertTrue(ClientGate.canBlock(subject), "block must survive \(state.rawValue)")
        }
    }

    func testABannedAccountCanStillDeleteItself() {
        // A banned user who cannot reach delete is stranded: sanctioned,
        // unappealable and unable to leave.
        let banned = AccountStanding(
            state: .banned,
            capabilities: ["report", "delete_account"],
            visibleInProduct: false
        )
        XCTAssertTrue(ClientGate.canDeleteAccount(viewer(.verified, banned)))
        XCTAssertTrue(ClientGate.canEditOwnProfile(viewer(.verified, banned)))
    }

    // MARK: Messaging

    func testComposerIsAvailableWhenBothPartiesAreFine() {
        XCTAssertNil(
            ClientGate.canSendMessage(
                viewer: viewer(),
                counterpartStanding: active(),
                blocked: false,
                conversationOpen: true
            )
        )
    }

    func testABlockClosesTheComposerAndDisclosesNothing() {
        let refusal = ClientGate.canSendMessage(
            viewer: viewer(),
            counterpartStanding: active(),
            blocked: true,
            conversationOpen: true
        )
        XCTAssertNotNil(refusal)
        // A block must not be probeable: no capability named, no case reference.
        XCTAssertTrue(refusal?.removedCapabilities.isEmpty ?? false)
        XCTAssertNil(refusal?.caseReference)
    }

    func testABlockOutranksARestriction() {
        // Where both apply the block is what the user is told, because naming the
        // restriction would reveal the other party's standing.
        let restricted = AccountStanding(
            state: .limited,
            capabilities: ["report", "block"],
            removedCapabilities: ["send_message"]
        )
        let refusal = ClientGate.canSendMessage(
            viewer: viewer(.verified, restricted),
            counterpartStanding: active(),
            blocked: true,
            conversationOpen: true
        )
        XCTAssertEqual(refusal?.reason, .conversationClosed)
    }

    func testARestrictedCounterpartDisablesTheComposerHere() {
        // The symmetric rule the service enforces: a restricted *other* party
        // means the send fails, so the client must not offer it.
        let restricted = AccountStanding(
            state: .limited,
            capabilities: ["report", "block"],
            removedCapabilities: ["send_message"]
        )
        let refusal = ClientGate.canSendMessage(
            viewer: viewer(),
            counterpartStanding: restricted,
            blocked: false,
            conversationOpen: true
        )
        XCTAssertEqual(refusal?.reason, .counterpartRestricted)
    }

    func testARestrictedSenderIsToldWhatWasRemovedAndWhichCase() {
        let restricted = AccountStanding(
            state: .limited,
            capabilities: ["report", "block", "browse_discovery"],
            removedCapabilities: ["send_message", "like"]
        )
        let refusal = ClientGate.canSendMessage(
            viewer: viewer(.verified, restricted),
            counterpartStanding: active(),
            blocked: false,
            conversationOpen: true
        )
        XCTAssertEqual(refusal?.reason, .accountRestricted)
        // The product's explainability promise: a user who cannot see why they
        // were restricted cannot contest it.
        XCTAssertEqual(refusal?.removedCapabilities.sorted(), ["like", "send_message"])
    }

    func testAClosedConversationIsReadOnly() {
        let refusal = ClientGate.canSendMessage(
            viewer: viewer(),
            counterpartStanding: active(),
            blocked: false,
            conversationOpen: false
        )
        XCTAssertEqual(refusal?.reason, .conversationClosed)
    }

    // MARK: Onboarding

    func testOnboardingGivesOneNextStepAndItIsTheEarliestMissing() {
        XCTAssertEqual(
            ClientGate.onboardingNextStep(
                .init(identity: .unverified, contactVerified: false, profileComplete: false, preferencesSet: false)
            ),
            .verifyIdentity
        )
        XCTAssertEqual(
            ClientGate.onboardingNextStep(
                .init(identity: .verified, contactVerified: false, profileComplete: false, preferencesSet: false)
            ),
            .verifyContact
        )
        XCTAssertEqual(
            ClientGate.onboardingNextStep(
                .init(identity: .verified, contactVerified: true, profileComplete: false, preferencesSet: true)
            ),
            .completeProfile
        )
        XCTAssertEqual(
            ClientGate.onboardingNextStep(
                .init(identity: .verified, contactVerified: true, profileComplete: true, preferencesSet: true)
            ),
            .discoverable
        )
    }

    func testAVerifiedUserWithoutPreferencesIsNotYetDiscoverable() {
        // The mirror of the server's four-clause predicate. If these drift, a user
        // is told they are discoverable and is not.
        let step = ClientGate.onboardingNextStep(
            .init(identity: .verified, contactVerified: true, profileComplete: true, preferencesSet: false)
        )
        XCTAssertEqual(step, .setPreferences)
    }
}
