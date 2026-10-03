import Foundation
import XCTest
@testable import BeenThereKit

/// The client and the server must ask for the same step next.
///
/// ## Why a file rather than a literal
///
/// `ClientGate.onboardingNextStep` walks `OnboardingReadiness.Step.allCases`,
/// so the Swift enum's *declaration order* is load-bearing: it is the order a
/// member is walked through. That order used to be restated as an `if` chain,
/// which is how it came to disagree with `ONBOARDING_ORDER` in the service —
/// the mirror checked identity before contact, so a fresh sign-up was told to
/// verify an identity before the contact it cannot be recovered without.
///
/// A second literal on this side would be the same defect with a different
/// spelling. `onboarding-order.json` is the one list, the server asserts
/// `ONBOARDING_ORDER` against it in `packages/service/test/onboarding-order.test.ts`,
/// and this asserts the enum against it. Reordering the product means editing
/// that file, and forgetting to move a side is a failed test rather than a
/// member sent to the wrong step.
final class OnboardingOrderingTests: XCTestCase {

    /// The fixture, read from beside this test rather than embedded.
    private func serverOrder() throws -> [String] {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("onboarding-order.json")
        let parsed = try JSONSerialization.jsonObject(with: try Data(contentsOf: url))
        let root = try XCTUnwrap(parsed as? [String: Any])
        return try XCTUnwrap(root["steps"] as? [String])
    }

    /// The Swift enum's declaration order is the order the product asks for.
    ///
    /// `CaseIterable` synthesises `allCases` in declaration order, so this is an
    /// assertion about the source, not about a re-sort: reordering the cases in
    /// `APIModels.swift` is what this catches.
    func testTheStepEnumIsDeclaredInTheServersOrder() throws {
        let expected = try serverOrder()
        let actual = OnboardingReadiness.Step.allCases.map(\.rawValue)
        XCTAssertEqual(
            actual, expected,
            "the enum order is what the onboarding walk follows; it must be ONBOARDING_ORDER"
        )
    }

    /// Contact verification precedes identity verification.
    ///
    /// Stated on its own because it is the one ordering the drift got wrong, and
    /// because it is the one the spec is unambiguous about: §3 makes contact
    /// verification blocking and identity verification deferrable, and says the
    /// funnel "may never skip 1–4".
    func testContactVerificationComesBeforeIdentityVerification() throws {
        let order = try serverOrder()
        let contact = try XCTUnwrap(order.firstIndex(of: "contact_verification"))
        let identity = try XCTUnwrap(order.firstIndex(of: "identity_verification"))
        XCTAssertLessThan(contact, identity)
    }

    /// Every step the mirror carries is one the server names, and vice versa for
    /// the four it does not.
    ///
    /// The mirror's vocabulary is the server's minus the three steps
    /// `OnboardingSnapshot` holds no fact about. If the server added a step, the
    /// mirror would silently skip it, which is safe; if it renamed one, the
    /// mirror's mapping would silently miss, which is not — so both directions
    /// are asserted against the fixture rather than against each other.
    func testTheMirrorCarriesOnlyStepsTheServerNames() throws {
        let serverSteps = Set(try serverOrder())
        for step in OnboardingReadiness.Step.allCases {
            XCTAssertTrue(serverSteps.contains(step.rawValue), "\(step.rawValue) is not a server step")
        }
        for (server, _) in ClientGate.mirroredSteps {
            XCTAssertTrue(serverSteps.contains(server.rawValue))
        }
    }
}
