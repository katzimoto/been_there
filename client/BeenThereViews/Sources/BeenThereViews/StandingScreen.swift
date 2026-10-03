import SwiftUI
import BeenThereKit

/// The member-facing restriction screen, assembled from the published standing.
///
/// ## Every fact on this screen is the server's
///
/// The input is `AccountStandingProjection` at version 2, which carries four
/// things this screen needs and none of the things it must not have:
///
///   * `baselineCapabilities` — the unrestricted grant, so "what an account
///     without restrictions holds" is a published fact rather than a client copy
///     of the kernel's table;
///   * `removedCapabilities` — the server's own subtraction, which is what the
///     member is shown;
///   * `caseId` — the case whose decision produced the standing, and the basis
///     on which it can be contested;
///   * `state` and `capabilities` — what survives.
///
/// There is no reason, no moderator and no counterparty in the projection, so
/// there is none here. A screen that named one would be reading something the
/// server did not publish.
///
/// ## What honesty costs, and what it buys
///
/// `caseReference == nil` renders as *no decision has been recorded*, which is a
/// different sentence from a screen that could not find one. That distinction
/// only exists because `AccountStandingDecoding.swift` refuses a response that
/// omits the `caseId` **key**: a nil here is the server's answer, never this
/// client's gap. The same reasoning puts `removedSetAgreesWithBaseline` on the
/// screen — if the two published capability fields stop describing the same
/// account, the member is told the screen disagrees with itself rather than
/// being shown a confident wrong number.
public struct StandingScreenModel: Sendable, Equatable {

    public let standing: AccountStanding
    /// The existing view model's copy and primary action, reused rather than
    /// rewritten: a second set of sentences for the same four states would drift
    /// from the one that is tested.
    public let summary: RestrictedAccountViewModel

    public init(standing: AccountStanding) {
        self.standing = standing
        self.summary = RestrictedAccountViewModel(standing: standing)
    }

    public var state: AccountState { standing.state }

    /// What the server removed.
    public var removed: [String] { standing.removedCapabilities }

    /// What the server says the account still has.
    ///
    /// Read off the granted set, not off the baseline minus the removed set: the
    /// kernel grants `report`, `block` and `delete_account` on every state, so a
    /// subtraction would list capabilities the account does not in fact hold.
    public var retained: [String] { standing.capabilities }

    /// The unrestricted grant, as published. Never presented as something the
    /// member currently has.
    public var baseline: [String] { standing.baselineCapabilities }

    /// The deciding case, or `nil` when no decision has been taken.
    public var caseReference: String? { standing.caseId }

    public var hasDecision: Bool { standing.caseId != nil }

    /// Whether the server's two published capability fields agree.
    public var agreesWithBaseline: Bool { standing.removedSetAgreesWithBaseline }

    /// The projection version this screen reads, so the screen can say which
    /// shape of the contract it is looking at.
    public var projectionVersion: Int { SupportedStandingProjectionVersion.value }

    /// Reporting and blocking survive every sanction. A readback of the granted
    /// set, so a server that stopped granting one shows up rather than the screen
    /// claiming a control the member does not have.
    public var keepsSafetyControls: Bool {
        RestrictedAccountViewModel.keepsSafetyControls(standing)
    }

    /// Whether the exit is offered. Read off the grant, because the kernel grants
    /// `delete_account` on a ban and withholds it on a suspension.
    public var offersTheExit: Bool {
        RestrictedAccountViewModel.offersTheExit(standing)
    }

    // MARK: Copy

    /// The sentence naming the decision, or saying there is none.
    ///
    /// Deliberately not an empty string and not a placeholder.
    public var caseLine: String {
        caseReference.map { "Case \($0)" } ?? "No decision has been recorded"
    }

    /// What the member is told about the standing's own record.
    public var referenceExplanation: String {
        hasDecision
            ? "The service recorded this decision against the case above. Quote it if you want it reviewed."
            : "The service has recorded no decision against your account, so there is no case to quote."
    }

    /// Shown only when the server's own two fields disagree.
    ///
    /// A real disagreement is worth tripping over in front of the member rather
    /// than resolving by quietly preferring one of the two numbers.
    public var disagreementNote: String? {
        guard !agreesWithBaseline else { return nil }
        return "The service published a removed set that does not match the difference between "
            + "its baseline and the capabilities it granted. One of the two is wrong."
    }

    /// The primary action, in the member's words.
    public var primaryActionTitle: String? {
        switch summary.primaryAction {
        case .none: return nil
        case .wait: return "Waiting on the service"
        case .deleteAccount: return "Delete my account"
        }
    }

    /// Whether this is a restriction screen at all.
    ///
    /// `active` still gets the full honest summary rather than an empty state: an
    /// account with nothing removed is a real answer, and an "all good" screen
    /// that showed nothing would leave a member unable to check what the service
    /// thinks their account holds.
    public var isRestricted: Bool { state != .active }
}

// MARK: - The screen

public struct StandingScreen: View {

    private let model: StandingScreenModel
    private let identityState: IdentityState?
    private let identityGeneration: Int?
    private let onSignOut: () -> Void

    public init(
        model: StandingScreenModel,
        identityState: IdentityState? = nil,
        identityGeneration: Int? = nil,
        onSignOut: @escaping () -> Void = {}
    ) {
        self.model = model
        self.identityState = identityState
        self.identityGeneration = identityGeneration
        self.onSignOut = onSignOut
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.md) {
                header
                facts

                if let note = model.disagreementNote {
                    Card {
                        VStack(alignment: .leading, spacing: Space.sm) {
                            Text("The service's own numbers disagree")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(Ink.restricted)
                            screenSubtitle(note)
                        }
                    }
                }

                capabilityCards
                decisionCard

                if let title = model.primaryActionTitle {
                    PrimaryButton(title, isEnabled: false) {}
                    screenSubtitle(
                        "Deletion is not wired up in this build. The capability the service granted "
                            + "is listed under \"What still works\"."
                    )
                }

                Button("Sign out", action: onSignOut)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(.secondary)
            }
            .padding(Space.md)
        }
        .frame(width: phoneWidth)
        .background(Ink.canvas)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            screenTitle(model.summary.title)
            Text("Standing projection version \(model.projectionVersion)")
                .font(.system(size: 12))
                .foregroundStyle(.tertiary)
        }
    }

    private var facts: some View {
        Card {
            VStack(alignment: .leading, spacing: Space.sm) {
                screenSubtitle(model.summary.body)
                Divider()
                FactRow("Account state", model.state.rawValue)
                FactRow("Visible in the product", model.standing.visibleInProduct ? "Yes" : "No")
                if let identityState {
                    FactRow("Identity", identityState.rawValue)
                }
                if let identityGeneration {
                    FactRow("Identity generation", "\(identityGeneration)")
                }
            }
        }
    }

    /// The three capability lists, and nothing derived from them.
    private var capabilityCards: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            Card {
                VStack(alignment: .leading, spacing: Space.sm) {
                    Text("What was removed")
                        .font(.system(size: 16, weight: .semibold))
                    if model.removed.isEmpty {
                        screenSubtitle("Nothing was removed from your account.")
                    } else {
                        screenSubtitle("\(model.removed.count) capability the service removed.")
                        FlowChips(model.removed, tint: Ink.restricted)
                    }
                }
            }

            Card {
                VStack(alignment: .leading, spacing: Space.sm) {
                    Text("What still works")
                        .font(.system(size: 16, weight: .semibold))
                    screenSubtitle("\(model.retained.count) capability the service still grants.")
                    FlowChips(model.retained, tint: Ink.granted)
                    Divider()
                    screenSubtitle(
                        model.keepsSafetyControls
                            ? "Reporting and blocking survive every restriction."
                            : "The service is not granting reporting or blocking on this account."
                    )
                }
            }

            Card {
                VStack(alignment: .leading, spacing: Space.sm) {
                    Text("Unrestricted baseline")
                        .font(.system(size: 16, weight: .semibold))
                    screenSubtitle("\(model.baseline.count) capability an account with no restriction holds.")
                    FlowChips(model.baseline, tint: .secondary)
                }
            }
        }
    }

    private var decisionCard: some View {
        Card {
            VStack(alignment: .leading, spacing: Space.sm) {
                Text("Which case decided this")
                    .font(.system(size: 16, weight: .semibold))
                ValueChip(model.caseLine, tint: model.hasDecision ? Ink.restricted : .secondary)
                screenSubtitle(model.referenceExplanation)
            }
        }
    }
}

/// A wrapping row of chips.
///
/// Written without a custom `Layout` because the only width that has to look
/// right is 390pt, and this is twenty lines rather than a layout that would then
/// need its own macOS counterpart. The split is measured rather than counted:
/// `report` and `delete_account` are very different widths at the same font, and
/// a character-based split puts one of them on its own line.
struct FlowChips: View {
    private let values: [String]
    private let tint: Color

    init(_ values: [String], tint: Color) {
        self.values = values
        self.tint = tint
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            ForEach(Array(chunked.enumerated()), id: \.offset) { _, row in
                HStack(alignment: .center, spacing: Space.xs) {
                    ForEach(row, id: \.self) { value in
                        ValueChip(value, tint: tint)
                    }
                    Spacer(minLength: 0)
                }
            }
        }
    }

    /// The usable width inside a `Card` at the phone width: 390 less the frame,
    /// less the scroll view's padding, less the card's own padding on both sides.
    private var limit: CGFloat { phoneWidth - (Space.md * 4) }

    private var chunked: [[String]] {
        var rows: [[String]] = []
        var row: [String] = []
        var used: CGFloat = 0
        for value in values {
            let width = FlowChips.width(of: value) + (Space.sm * 2)
            if !row.isEmpty, used + width > limit {
                rows.append(row)
                row = []
                used = 0
            }
            row.append(value)
            used += width + Space.xs
        }
        if !row.isEmpty { rows.append(row) }
        return rows
    }

    /// Measured with the font that actually draws the chip, so a chip never
    /// clips its own text.
    private static func width(of text: String) -> CGFloat {
        let font = NSFont.monospacedSystemFont(ofSize: 12, weight: .medium)
        return (text as NSString).size(withAttributes: [.font: font]).width
    }
}