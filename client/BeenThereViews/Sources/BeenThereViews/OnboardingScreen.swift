import SwiftUI
import BeenThereKit

/// The setup checklist, exactly as `GET /v1/accounts/:userId/onboarding`
/// publishes it.
///
/// The ordering on screen is `OnboardingViewModel.rows`, which is built from
/// `OnboardingReadiness.Step.allCases` in the server's own vocabulary order — a
/// checklist reordered by the client would send a member back to a step in an
/// order the product did not choose.
///
/// Two things are shown that are worth naming, because both are easy to lose:
///
///   * the **age band**, never a date of birth and never a number of years. The
///     projection publishes the band and nothing else, and §4.3 makes the date
///     itself never rendered at all;
///   * a **waiting state** when identity is `pending`, `review_required`,
///     `verification_failed` or `expired` — the checklist treats those as
///     outstanding, but the screen says "we are checking" rather than "do this",
///     because a member cannot act on a step only a provider or a person can
///     resolve.
public struct OnboardingScreen: View {

    private let readiness: OnboardingReadiness
    private let model: OnboardingViewModel
    private let snapshot: ViewerSnapshot?
    private let onRefresh: () -> Void

    public init(
        readiness: OnboardingReadiness,
        snapshot: ViewerSnapshot? = nil,
        onRefresh: @escaping () -> Void = {}
    ) {
        self.readiness = readiness
        self.model = OnboardingViewModel(readiness)
        self.snapshot = snapshot
        self.onRefresh = onRefresh
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.md) {
                VStack(alignment: .leading, spacing: Space.xs) {
                    screenTitle(model.headline)
                    Text("Readiness projection version \(readiness.version)")
                        .font(.system(size: 12))
                        .foregroundStyle(.tertiary)
                }

                if let step = readiness.nextStep {
                    Card {
                        VStack(alignment: .leading, spacing: Space.sm) {
                            Text("Next").font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(.secondary)
                            Text(step.rawValue)
                                .font(.system(size: 16, weight: .semibold, design: .monospaced))
                            if let title = model.nextActionTitle {
                                screenSubtitle(title)
                            }
                        }
                    }
                }

                if let waiting = model.waitingOn {
                    Card {
                        VStack(alignment: .leading, spacing: Space.sm) {
                            Text("We are checking")
                                .font(.system(size: 15, weight: .semibold))
                            screenSubtitle(waitingExplanation(waiting))
                        }
                    }
                }

                checklist

                Card {
                    VStack(alignment: .leading, spacing: Space.sm) {
                        screenSubtitle(model.completionSummary)
                        screenSubtitle(
                            model.isDiscoverable
                                ? "The service says this account is discoverable."
                                : "The service says this account is not discoverable yet."
                        )
                        if let band = readiness.ageBand {
                            Divider()
                            FactRow("Age band", band)
                        }
                        Divider()
                        FactRow("Identity", readiness.identity.state.rawValue)
                        FactRow("Profile", readiness.profileState.rawValue)
                        FactRow("Preferences", readiness.preferencesSet ? "Set" : "Not set")
                    }
                }

                if let snapshot, OnboardingViewModel.reportsGateDisagreement(
                    readiness: readiness, viewer: snapshot
                ) {
                    Card {
                        VStack(alignment: .leading, spacing: Space.sm) {
                            Text("The client and the service disagree")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(Ink.restricted)
                            screenSubtitle(
                                "The service says this account is discoverable, and the client "
                                    + "gate says it is not. Discovery is withheld rather than offered "
                                    + "and refused."
                            )
                        }
                    }
                }

                PrimaryButton("Refresh from the service", action: onRefresh)
            }
            .padding(Space.md)
        }
        .frame(width: phoneWidth)
        .background(Ink.canvas)
    }

    private var checklist: some View {
        Card {
            VStack(alignment: .leading, spacing: Space.sm) {
                ForEach(model.rows) { row in
                    HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
                        Image(systemName: row.isComplete ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(row.isComplete ? Ink.granted : Color.secondary)
                        VStack(alignment: .leading, spacing: Space.xs) {
                            Text(row.title)
                                .font(.system(size: 15, weight: row.isNext ? .semibold : .regular))
                            Text(row.step.rawValue)
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(.tertiary)
                        }
                        Spacer(minLength: 0)
                        if row.isNext {
                            ValueChip("Next")
                        }
                    }
                }
            }
        }
    }

    /// What "we are checking" means for each state the server can be in.
    ///
    /// The client cannot move any of these, so it does not offer a button that
    /// the service would refuse.
    private func waitingExplanation(_ state: OnboardingViewModel.WaitingState) -> String {
        switch state {
        case .pending:
            return "Your identity check is with the verification provider. Nothing to do until they answer."
        case .reviewRequired:
            return "A person is reviewing your identity check. Nothing to do until they finish."
        case .verificationFailed:
            return "The last identity check did not pass. The service has recorded why; nothing is offered here."
        case .expired:
            return "Your identity check has expired and the service has not asked for a new one."
        }
    }
}