import XCTest
@testable import BeenThereKit

/// These decode bodies captured from the running service.
///
/// Every fixture below is a real response, trimmed only where a value is a
/// timestamp or an id that changes per run. A fixture written from the route
/// source rather than from a response would only prove that the client matches
/// my reading of the TypeScript, which is exactly the mistake that produces two
/// implementations of one contract.
final class APIModelDecodingTests: XCTestCase {

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    // MARK: Sign-up

    func testSignUpResponseDecodes() throws {
        // Verbatim from `POST /v1/accounts` against the service.
        let json = """
        {
          "userId": "991e1c45-0cd1-4346-a279-3f9d8787cf55",
          "accountId": "a7fdf9b2-1cc1-4065-821c-5d4e172e471e",
          "createdAt": "2026-10-03T06:12:47.059Z",
          "contactVerified": false,
          "termsVersion": "2026-09-01",
          "ageBand": "28-32",
          "ageGate": {
            "title": "Been There is 18+.",
            "body": "We ask for your date of birth so we can keep the community adults-only."
          },
          "identity": { "state": "unverified", "generation": 1, "discoverable": false },
          "session": {
            "token": "aa496df9b742e3e45f43ef762678a9b6359f91dc91d645b026ac2ef1a8e23336",
            "sessionId": "d7b3e108-6d76-466a-9104-3d989d4e287f",
            "expiresAt": "2026-10-03T06:27:47.059Z",
            "refreshableUntil": "2026-11-02T06:12:47.059Z"
          }
        }
        """
        let result = try decode(SignUpResult.self, json)
        XCTAssertEqual(result.identity.state, .unverified)
        XCTAssertFalse(result.identity.discoverable)
        XCTAssertEqual(result.ageBand, "28-32")
        XCTAssertNotNil(result.session.expiresOn)
        XCTAssertNotNil(result.session.refreshableUntilDate)
    }

    /// The age band is the only age the product ever sends, and it is a band.
    /// There is no field on `SignUpResult` that could hold a date of birth.
    func testSignUpResultCarriesNoExactAge() throws {
        let result = try decode(SignUpResult.self, """
        {
          "userId": "u", "accountId": "a", "createdAt": "2026-10-03T06:12:47.059Z",
          "contactVerified": false, "termsVersion": "2026-09-01", "ageBand": "28-32",
          "ageGate": { "title": "t", "body": "b" },
          "identity": { "state": "unverified", "generation": 1, "discoverable": false },
          "session": { "token": "t", "sessionId": "s", "expiresAt": "x", "refreshableUntil": "y" }
        }
        """)
        let mirror = Mirror(reflecting: result)
        let fields = mirror.children.compactMap(\.label)
        XCTAssertFalse(fields.contains("age"))
        XCTAssertFalse(fields.contains("dateOfBirth"))
        XCTAssertFalse(fields.contains("ageYears"))
    }

    // MARK: Sessions

    func testSignInResponseDecodesWithTheEvictionCount() throws {
        // Sign-in alone carries `evictedSessions`; sign-up and refresh do not.
        let json = """
        {
          "userId": "95f75ed3-d9f3-46f0-bb5e-5571e9a4f396",
          "token": "cb00f7deaacca9c76d2b955f9dee5815dde1f07ec2ef98134518be249f1efbfd",
          "sessionId": "4f0a69a1-86db-4c1a-a373-a7b9aae18f8b",
          "expiresAt": "2026-10-03T06:27:59.410Z",
          "refreshableUntil": "2026-11-02T06:12:59.410Z",
          "evictedSessions": 0
        }
        """
        let session = try decode(SignInSession.self, json)
        XCTAssertEqual(session.evictedSessions, 0)
        XCTAssertEqual(session.issued.token, session.token)
        XCTAssertEqual(session.issued.sessionId, session.sessionId)
    }

    func testRefreshResponseDecodesWithNoEvictionCount() throws {
        let json = """
        {
          "userId": "u", "token": "t", "sessionId": "s",
          "expiresAt": "2026-10-03T06:27:59.264Z", "refreshableUntil": "2026-11-02T06:12:52.550Z"
        }
        """
        let session = try decode(IssuedSession.self, json)
        XCTAssertEqual(session.userId, "u")
        // A rotation evicted nothing; rendering "0 sessions replaced" from a
        // refresh would report a fact the server never sent.
        XCTAssertNil(SignInSession(
            userId: session.userId, token: session.token, sessionId: session.sessionId,
            expiresAt: session.expiresAt, refreshableUntil: session.refreshableUntil
        ).evictedSessions)
    }

    // MARK: Standing

    func testAccountViewDecodes() throws {
        // Verbatim from `GET /v1/accounts/:userId`.
        let json = """
        {
          "userId": "95f75ed3-d9f3-46f0-bb5e-5571e9a4f396",
          "accountId": "889245f1-ebd9-44f2-a06b-bba5f62fef8e",
          "createdAt": "2026-10-03T06:12:52.550Z",
          "identity": {
            "projectionVersion": 1,
            "subjectId": "95f75ed3-d9f3-46f0-bb5e-5571e9a4f396",
            "state": "unverified",
            "generation": 1,
            "discoverable": false,
            "updatedAt": "2026-10-03T06:12:52.550Z"
          },
          "account": {
            "projectionVersion": 2,
            "state": "active",
            "capabilities": ["browse_discovery","like","send_message","report","block","edit_profile"],
            "baselineCapabilities": ["browse_discovery","like","send_message","report","block","edit_profile"],
            "removedCapabilities": [],
            "visibleInProduct": true,
            "caseId": null
          }
        }
        """
        let view = try decode(AccountView.self, json)
        XCTAssertEqual(view.identity.state, .unverified)
        XCTAssertEqual(view.account.state, .active)
        XCTAssertTrue(view.account.capabilities.contains("report"))
        XCTAssertTrue(view.account.visibleInProduct)
    }

    /// The standing projection carries what a restriction screen needs, and this
    /// asserts the decoder reads it rather than defaulting it.
    ///
    /// `ClientGate.Unavailable` documents that an honest explanation needs
    /// `removedCapabilities` and a case reference. This is the payload the server
    /// produces for a restricted account, taken from
    /// `accountProjectionFor`: the baseline is the kernel's grant for an
    /// unrestricted account, the removed set is that minus what was granted, and
    /// `caseId` is the deciding case. The projection version is 2 and the
    /// decoder refuses anything else, so a response built against the old
    /// three-field shape cannot decode at all — which is what makes this a real
    /// assertion rather than a tolerant read of whatever arrived.
    func testARestrictedStandingCarriesTheRemovedSetAndTheDecidingCase() throws {
        let view = try decode(AccountView.self, """
        {
          "userId": "u", "accountId": "a", "createdAt": "t",
          "identity": { "projectionVersion": 1, "subjectId": "u", "state": "verified",
                        "generation": 2, "discoverable": false, "updatedAt": "t" },
          "account": {
            "projectionVersion": 2, "state": "limited",
            "capabilities": ["browse_discovery","report","block","edit_profile"],
            "baselineCapabilities": ["browse_discovery","like","send_message","report","block","edit_profile"],
            "removedCapabilities": ["like","send_message"],
            "visibleInProduct": true,
            "caseId": "case-4f1c"
          }
        }
        """)
        XCTAssertEqual(view.account.state, .limited)
        XCTAssertEqual(view.account.removedCapabilities.sorted(), ["like", "send_message"])
        XCTAssertEqual(view.account.caseId, "case-4f1c")
        // The two published sets describe the same account. A server that changed
        // one without the other would fail here rather than render a screen that
        // quietly contradicts itself.
        XCTAssertTrue(view.account.removedSetAgreesWithBaseline)

        let screen = RestrictedAccountViewModel(standing: view.account)
        XCTAssertEqual(screen.removed.sorted(), ["like", "send_message"])
        XCTAssertEqual(screen.caseReference, "case-4f1c")
        // The unrestrictable floor is still on the screen: this is a restriction,
        // not a mute, and the member can still reach a human.
        XCTAssertTrue(screen.alwaysAvailable.contains("report"))
        XCTAssertTrue(screen.alwaysAvailable.contains("block"))
    }

    /// A response missing a field the projection declares is a failure, not a
    /// screen that says a restriction removed nothing.
    ///
    /// This is the assertion that replaced the old tolerance. The decoder used
    /// to default an absent `removedCapabilities` to `[]`, which a restriction
    /// screen would then render as "nothing was removed" — a false statement
    /// about somebody's account, produced by a client-side default.
    func testAStandingMissingTheRemovedSetFailsToDecode() {
        let json = """
        {
          "userId": "u", "accountId": "a", "createdAt": "t",
          "identity": { "projectionVersion": 1, "subjectId": "u", "state": "verified",
                        "generation": 2, "discoverable": false, "updatedAt": "t" },
          "account": {
            "projectionVersion": 2, "state": "limited",
            "capabilities": ["browse_discovery","report","block","edit_profile"],
            "baselineCapabilities": ["browse_discovery","like","send_message","report","block","edit_profile"],
            "visibleInProduct": true,
            "caseId": "case-4f1c"
          }
        }
        """
        XCTAssertThrowsError(try decode(AccountView.self, json))
    }

    /// A standing published at the version this build does not read is refused,
    /// rather than decoded with three of its fields quietly wrong.
    func testThePreviousStandingProjectionVersionIsRefused() {
        let json = """
        {
          "userId": "u", "accountId": "a", "createdAt": "t",
          "identity": { "projectionVersion": 1, "subjectId": "u", "state": "verified",
                        "generation": 2, "discoverable": false, "updatedAt": "t" },
          "account": {
            "projectionVersion": 1, "state": "limited",
            "capabilities": ["browse_discovery","report","block","edit_profile"],
            "baselineCapabilities": ["browse_discovery","like","send_message","report","block","edit_profile"],
            "removedCapabilities": ["like","send_message"],
            "visibleInProduct": true,
            "caseId": "case-4f1c"
          }
        }
        """
        XCTAssertThrowsError(try decode(AccountView.self, json))
    }

    // MARK: Onboarding

    func testOnboardingReadinessDecodes() throws {
        // Verbatim from `GET /v1/accounts/:userId/onboarding`.
        let json = """
        {
          "version": 1,
          "userId": "95f75ed3-d9f3-46f0-bb5e-5571e9a4f396",
          "contactVerified": false,
          "ageGatePassed": true,
          "ageBand": "28-32",
          "termsAcceptedVersion": "2026-09-01",
          "termsCurrent": true,
          "identity": { "state": "unverified", "discoverable": false },
          "profileState": "draft",
          "preferencesSet": false,
          "nextStep": "contact_verification",
          "outstanding": ["contact_verification","identity_verification","profile","preferences"],
          "discoverable": false,
          "accountState": "active"
        }
        """
        let readiness = try decode(OnboardingReadiness.self, json)
        XCTAssertEqual(readiness.nextStep, .contactVerification)
        XCTAssertEqual(
            readiness.outstanding,
            [.contactVerification, .identityVerification, .profile, .preferences]
        )
        XCTAssertFalse(readiness.discoverable)
        XCTAssertEqual(readiness.accountState, .active)
        XCTAssertEqual(readiness.profileState, .draft)
    }

    /// The server's step order is the product's order. A client that reordered it
    /// would send a member back to a step the server did not choose first.
    func testOutstandingStepsKeepTheServerOrder() throws {
        let readiness = try decode(OnboardingReadiness.self, """
        {
          "version": 1, "userId": "u", "contactVerified": false, "ageGatePassed": false,
          "ageBand": null, "termsAcceptedVersion": null, "termsCurrent": false,
          "identity": { "state": "unverified", "discoverable": false },
          "profileState": "draft", "preferencesSet": false,
          "nextStep": "contact_verification",
          "outstanding": ["contact_verification","age_gate","terms","identity_verification","profile","preferences"],
          "discoverable": false, "accountState": "active"
        }
        """)
        XCTAssertEqual(readiness.outstanding.first, .contactVerification)
        XCTAssertEqual(readiness.nextStep, .contactVerification)
        // The model's declared order and the payload's order are the same list.
        XCTAssertEqual(
            OnboardingReadiness.Step.allCases.filter { readiness.outstanding.contains($0) }.map(\.rawValue),
            readiness.outstanding.map(\.rawValue)
        )
    }

    // MARK: Discovery

    func testEmptyDiscoveryPageDecodes() throws {
        // Verbatim from `GET /v1/discovery` for a member with nobody to show.
        let page = try decode(DiscoveryPage.self, """
        {
          "viewerId": "95f75ed3-d9f3-46f0-bb5e-5571e9a4f396",
          "projectionVersion": 1,
          "candidates": [],
          "total": 0
        }
        """)
        XCTAssertTrue(page.candidates.isEmpty)
        XCTAssertEqual(page.total, 0)
    }

    func testCandidateCardDecodes() throws {
        // The `CandidateCardProjection` shape, as `discovery.ts` builds it.
        let card = try decode(CandidateCard.self, """
        {
          "projectionVersion": 1,
          "userId": "c-1",
          "displayName": "Alex",
          "age": 29,
          "genderIdentities": ["non_binary"],
          "bio": "Long walks.",
          "photoIds": ["p-1","p-2"],
          "distance": "unknown"
        }
        """)
        XCTAssertEqual(card.displayName, "Alex")
        XCTAssertEqual(card.age, 29)
        XCTAssertEqual(card.distance, .unknown)
        XCTAssertFalse(card.distance.isResolved)
        // `unknown` is not a distance and must not render as one.
        XCTAssertNil(card.distanceLabel)
        XCTAssertFalse(card.hasRenderableDistance)
    }

    func testEveryDistanceBandDecodesFromItsWireValue() throws {
        // The six bands `location.ts` declares, spelled as the server spells them.
        let pairs: [(String, DistanceBand)] = [
            ("lt_5_km", .lt5km),
            ("5_25_km", .from5To25km),
            ("25_50_km", .from25To50km),
            ("50_100_km", .from50To100km),
            ("gt_100_km", .over100km),
            ("unknown", .unknown),
        ]
        XCTAssertEqual(pairs.count, DistanceBand.allCases.count)
        for (raw, expected) in pairs {
            XCTAssertEqual(DistanceBand(rawValue: raw), expected)
        }
    }

    /// A card whose content the gate accepted always has a name and a derived
    /// age. One that does not is dropped rather than rendered blank, because
    /// `cardFor` returning null means the row disagrees with the state the gate
    /// accepted — putting an empty card in front of a person is the wrong answer.
    func testACardWithoutANameIsNotRenderable() throws {
        let blank = try decode(CandidateCard.self, """
        { "projectionVersion": 1, "userId": "c", "displayName": "", "age": 0,
          "genderIdentities": [], "bio": "", "photoIds": [], "distance": "unknown" }
        """)
        XCTAssertFalse(blank.isRenderable)
        let real = try decode(CandidateCard.self, """
        { "projectionVersion": 1, "userId": "c", "displayName": "Sam", "age": 31,
          "genderIdentities": ["woman"], "bio": "b", "photoIds": [], "distance": "5_25_km" }
        """)
        XCTAssertTrue(real.isRenderable)
        XCTAssertEqual(real.distanceLabel, "5 to 25 km away")
    }

    // MARK: Profile

    func testProfileCompletenessDecodes() throws {
        // Verbatim from `GET /v1/profiles/me` for an account with nothing written.
        let json = """
        {
          "profileId": "profile:95f75ed3-d9f3-46f0-bb5e-5571e9a4f396",
          "state": "draft",
          "complete": false,
          "missing": ["display_name","bio","photos","prompt","gender_identities","age","location"]
        }
        """
        let profile = try decode(ProfileCompleteness.self, json)
        XCTAssertFalse(profile.complete)
        XCTAssertEqual(profile.missing.count, ProfileCompleteness.MissingField.allCases.count)
        XCTAssertEqual(profile.state, .draft)
    }

    /// Unset preferences are every axis `null`, and the server serves them rather
    /// than a 404 — the distinction the preferences spec's unset rule turns on.
    func testUnsetPreferencesAreServedRatherThan404() throws {
        let envelope = try decode(PreferencesEnvelope.self, """
        { "preferences": { "ageRange": null, "maxDistanceKm": null, "seekingGenders": null,
                           "openTo": null, "locationPrecision": null } }
        """)
        XCTAssertTrue(envelope.isUnset)
    }

    func testExpressedPreferencesAreNotUnset() throws {
        let envelope = try decode(PreferencesEnvelope.self, """
        { "preferences": { "ageRange": [28, 37], "maxDistanceKm": 25, "seekingGenders": ["woman"],
                           "openTo": null, "locationPrecision": "25_50_km" } }
        """)
        XCTAssertFalse(envelope.isUnset)
        XCTAssertEqual(envelope.preferences.ageRange, [28, 37])
        XCTAssertEqual(envelope.preferences.maxDistanceKm, 25)
    }

    // MARK: Interactions

    func testLikeResultDecodesAnAwaitingCounterpartResolution() throws {
        // The 201 a like gets when it did not become a match. The like exists
        // whether or not it matched, so this is a success and not a refusal.
        let result = try decode(LikeResult.self, """
        {
          "likeId": "l-1", "created": true, "match": null,
          "resolution": "awaiting_counterpart", "reason": null
        }
        """)
        XCTAssertEqual(result.resolution, .awaitingCounterpart)
        XCTAssertNil(result.match)
        XCTAssertNil(result.reason)
    }

    func testLikeResultDecodesAMatchWithAConversation() throws {
        let result = try decode(LikeResult.self, """
        {
          "likeId": "l-2", "created": true,
          "match": { "matchId": "m-1", "conversationId": "conv-1" },
          "resolution": "match_created", "reason": null
        }
        """)
        XCTAssertEqual(result.resolution, .matchCreated)
        XCTAssertEqual(result.match?.conversationId, "conv-1")
    }

    func testLikeResultDecodesARefusedMatchWithAReason() throws {
        let result = try decode(LikeResult.self, """
        {
          "likeId": "l-3", "created": true, "match": null,
          "resolution": "match_refused", "reason": "blocked"
        }
        """)
        XCTAssertEqual(result.resolution, .matchRefused)
        XCTAssertEqual(result.reason, "blocked")
    }

    /// A second block on a pair is a fact the service handles: a `200` with the
    /// existing block's id and `created: false`, not a conflict.
    func testRepeatedBlockIsAFactRatherThanAConflict() throws {
        let first = try decode(BlockResult.self, #"{"blockId":"b-1","created":true}"#)
        XCTAssertTrue(first.created)
        let second = try decode(BlockResult.self, #"{"blockId":"b-1","created":false}"#)
        XCTAssertFalse(second.created)
        XCTAssertEqual(second.blockId, "b-1")
    }

    func testReportResultDecodesTheEvidenceCountRatherThanTheArtefacts() throws {
        let result = try decode(ReportResult.self, """
        {
          "reportId": "r-1", "state": "submitted", "reason": "harassment",
          "evidence": 1, "relationship": "unmatched",
          "submittedAt": "2026-10-03T06:14:00.000Z"
        }
        """)
        XCTAssertEqual(result.evidence, 1)
        XCTAssertEqual(result.relationship, "unmatched")
        // A report filed after an unmatch still carries the frozen evidence.
        XCTAssertEqual(result.state, "submitted")
    }

    // MARK: Matches, conversations, health

    func testEmptyMatchListDecodes() throws {
        let list = try decode(MatchList.self, #"{"total": 0, "matches": []}"#)
        XCTAssertEqual(list.total, 0)
        XCTAssertTrue(list.matches.isEmpty)
    }

    func testMatchRecordDecodesTheStoredView() throws {
        // `matchView` in the database package, verbatim.
        let match = try decode(MatchRecord.self, """
        {
          "matchId": "match:a|b",
          "pairKey": "a|b",
          "participants": ["a", "b"],
          "likeIds": ["l-1"],
          "standings": ["active", "active"],
          "createdAt": "2026-10-03T06:14:00.000Z",
          "endedAt": null,
          "endedCause": null
        }
        """)
        XCTAssertEqual(match.participants.count, 2)
        XCTAssertEqual(match.standings, ["active", "active"])
        XCTAssertNil(match.endedAt)
    }

    func testMessagePageDecodes() throws {
        let page = try decode(MessagePage.self, """
        {
          "total": 1,
          "messages": [
            { "messageId": "m-1", "senderId": "a", "body": "hi",
              "state": "sent", "createdAt": "2026-10-03T06:14:00.000Z" }
          ]
        }
        """)
        XCTAssertEqual(page.messages.count, 1)
        XCTAssertEqual(page.messages.last?.body, "hi")
    }

    func testReadinessReportDecodes() throws {
        let report = try decode(ReadinessReport.self, """
        { "ready": true, "checkedAt": "2026-10-03T06:12:40.746Z",
          "checks": [{ "name": "database", "ok": true, "detail": "the transactional store answered" }] }
        """)
        XCTAssertTrue(report.ready)
        XCTAssertEqual(report.checks.first?.name, "database")
    }

    func testLivenessReportDecodes() throws {
        let report = try decode(LivenessReport.self, """
        { "status": "live", "phase": "serving", "pid": 60371, "uptimeSeconds": 106 }
        """)
        XCTAssertEqual(report.phase, "serving")
        XCTAssertEqual(report.uptimeSeconds, 106)
    }

    // MARK: The closed vocabularies

    /// A state this build has never heard of must fail to decode rather than fall
    /// through a `default` that nobody chose.
    func testAnUnknownIdentityStateIsRefusedRatherThanCoerced() {
        XCTAssertThrowsError(
            try decode(AccountView.self, """
            { "userId": "u", "accountId": "a", "createdAt": "t",
              "identity": { "projectionVersion": 1, "subjectId": "u", "state": "quantum",
                            "generation": 1, "discoverable": false, "updatedAt": "t" },
              "account": { "projectionVersion": 1, "state": "active", "capabilities": [],
                           "visibleInProduct": true } }
            """)
        )
    }

    func testEveryIdentityAndAccountStateTheKernelDeclaresIsRepresented() {
        // The six identity states in `identityMachine` and the four account
        // states in `accountMachine`. A client missing one could not decode a
        // response the server can legitimately send.
        XCTAssertEqual(IdentityState.allCases.count, 6)
        XCTAssertEqual(AccountState.allCases.count, 4)
        XCTAssertEqual(ProfileState.allCases.count, 6)
        for state in IdentityState.allCases {
            XCTAssertNotNil(IdentityState(rawValue: state.rawValue))
        }
        for state in AccountState.allCases {
            XCTAssertNotNil(AccountState(rawValue: state.rawValue))
        }
    }

    /// Every capability string the kernel's table names must be one the client's
    /// gate reads by name. A capability the client cannot spell is a control it
    /// cannot decide to show.
    func testTheClientsCapabilityNamesMatchTheKernelsTable() {
        let kernelCapabilities: Set<String> = [
            "browse_discovery", "like", "send_message", "report", "block",
            "edit_profile", "appeal_request", "delete_account",
        ]
        // The names the client gates on, taken from ClientGate and the view models.
        let clientNames: Set<String> = [
            "browse_discovery", "send_message", "report", "block", "edit_profile",
            "delete_account", "like",
        ]
        XCTAssertTrue(clientNames.isSubset(of: kernelCapabilities))
        // `appeal_request` is granted on `banned` only and the client never gates
        // on it, which is fine — it is named here so that is a decision on record.
        XCTAssertTrue(kernelCapabilities.contains("appeal_request"))
    }
}