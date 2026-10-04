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

    @Environment(\.palette) private var palette

    public var body: some View {
        Screen(model.headline, subtitle: "Readiness projection v\(readiness.version)") {
            progress

            if let step = readiness.nextStep {
                Card {
                    VStack(alignment: .leading, spacing: Space.sm) {
                        HStack {
                            SectionHeader("Do this next")
                            Spacer(minLength: Space.sm)
                            ValueChip(step.rawValue, tint: palette.accent)
                        }
                        if let title = model.nextActionTitle {
                            Text(title)
                                .font(Typeface.body)
                                .foregroundStyle(palette.ink)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }

            if let waiting = model.waitingOn {
                Card {
                    VStack(alignment: .leading, spacing: Space.sm) {
                        HStack(spacing: Space.sm) {
                            Image(systemName: "hourglass")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(palette.attention)
                            Text("We are checking")
                                .font(Typeface.headline)
                                .foregroundStyle(palette.ink)
                        }
                        Text(waitingExplanation(waiting))
                            .font(Typeface.callout)
                            .foregroundStyle(palette.inkSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }

            checklist

            Card {
                VStack(alignment: .leading, spacing: Space.sm) {
                    SectionHeader("What the service says")
                    Text(model.completionSummary)
                        .font(Typeface.body)
                        .foregroundStyle(palette.ink)
                    Text(
                        model.isDiscoverable
                            ? "This account is discoverable."
                            : "This account is not discoverable yet."
                    )
                    .font(Typeface.callout)
                    .foregroundStyle(palette.inkSecondary)
                    .fixedSize(horizontal: false, vertical: true)

                    if let band = readiness.ageBand {
                        Divider().overlay(palette.hairline)
                        FactRow("Age band", band)
                    }
                    Divider().overlay(palette.hairline)
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
                        HStack(spacing: Space.sm) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundStyle(palette.restricted)
                            Text("The client and the service disagree")
                                .font(Typeface.headline)
                                .foregroundStyle(palette.ink)
                        }
                        Text(
                            "The service says this account is discoverable, and the client "
                                + "gate says it is not. Discovery is withheld rather than offered "
                                + "and refused."
                        )
                        .font(Typeface.callout)
                        .foregroundStyle(palette.inkSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }

            PrimaryButton("Refresh from the service", action: onRefresh)
        }
    }

    /// How far along the checklist is, as a ring rather than a sentence.
    ///
    /// The count below it is the same number the server's `outstanding` list
    /// produces; the ring is a reading of it, not a second source of truth.
    private var progress: some View {
        let done = model.rows.count { $0.isComplete }
        let fraction = model.rows.isEmpty ? 0 : Double(done) / Double(model.rows.count)
        return Card {
            HStack(spacing: Space.md) {
                ProgressRing(fraction: fraction, tint: palette.accent, size: 56)
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(done) of \(model.rows.count) done")
                        .font(Typeface.headline)
                        .foregroundStyle(palette.ink)
                    Text(
                        done == model.rows.count
                            ? "Every step the service lists is complete."
                            : "The service lists what is still outstanding, in its own order."
                    )
                    .font(Typeface.callout)
                    .foregroundStyle(palette.inkSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
        }
    }

    private var checklist: some View {
        Card {
            VStack(alignment: .leading, spacing: Space.md) {
                SectionHeader("Checklist")
                ForEach(model.rows) { row in
                    HStack(alignment: .center, spacing: Space.sm) {
                        Image(systemName: row.isComplete ? "checkmark.circle.fill" : "circle")
                            .font(.system(size: 19))
                            .foregroundStyle(row.isComplete ? palette.granted : palette.inkTertiary)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(row.title)
                                .font(row.isNext ? Typeface.headline : Typeface.body)
                                .foregroundStyle(palette.ink)
                            Text(row.step.rawValue)
                                .font(Typeface.mono)
                                .foregroundStyle(palette.inkTertiary)
                        }
                        Spacer(minLength: Space.sm)
                        if row.isNext {
                            TagChip("Next", systemImage: "arrow.right", tint: palette.accent)
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