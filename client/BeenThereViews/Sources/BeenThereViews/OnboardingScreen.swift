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
                                .font(ScaledTypeface.body)
                                .foregroundStyle(palette.ink)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                // The chip is the server's own name for the step and is useless
                // spoken alone, so the card is announced as a label and a value:
                // the step the service named, then what the client tells the
                // member to do about it.
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Do this next")
                .accessibilityValue(
                    [spokenWords(step.rawValue), model.nextActionTitle]
                        .compactMap { $0 }
                        .joined(separator: ". ")
                )
            }

            if let waiting = model.waitingOn {
                Card {
                    VStack(alignment: .leading, spacing: Space.sm) {
                        HStack(spacing: Space.sm) {
                            Image(systemName: "hourglass")
                                .font(ScaledTypeface.symbol)
                                .foregroundStyle(palette.attention)
                            Text("We are checking")
                                .font(ScaledTypeface.headline)
                                .foregroundStyle(palette.ink)
                        }
                        Text(waitingExplanation(waiting))
                            .font(ScaledTypeface.callout)
                            .foregroundStyle(palette.inkSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("We are checking")
                .accessibilityValue(waitingExplanation(waiting))
            }

            checklist

            Card {
                VStack(alignment: .leading, spacing: Space.sm) {
                    SectionHeader("What the service says")
                    Text(model.completionSummary)
                        .font(ScaledTypeface.body)
                        .foregroundStyle(palette.ink)
                    Text(
                        model.isDiscoverable
                            ? "This account is discoverable."
                            : "This account is not discoverable yet."
                    )
                    .font(ScaledTypeface.callout)
                    .foregroundStyle(palette.inkSecondary)
                    .fixedSize(horizontal: false, vertical: true)

                    Divider().overlay(palette.hairline)
                    VStack(alignment: .leading, spacing: Space.sm) {
                        ForEach(publishedFacts, id: \.label) { fact in
                            FactRow(fact.label, fact.value)
                        }
                    }
                    // Four rows are four swipes and four separate announcements
                    // for one block of published facts, so the block is one
                    // element spoken from the same list it draws.
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("What the service publishes")
                    .accessibilityValue(spokenFacts(publishedFacts))
                }
            }

            if let snapshot, OnboardingViewModel.reportsGateDisagreement(
                readiness: readiness, viewer: snapshot
            ) {
                Card {
                    VStack(alignment: .leading, spacing: Space.sm) {
                        HStack(spacing: Space.sm) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .font(ScaledTypeface.symbol)
                                .foregroundStyle(palette.restricted)
                            Text("The client and the service disagree")
                                .font(ScaledTypeface.headline)
                                .foregroundStyle(palette.ink)
                        }
                        Text(
                            "The service says this account is discoverable, and the client "
                                + "gate says it is not. Discovery is withheld rather than offered "
                                + "and refused."
                        )
                        .font(ScaledTypeface.callout)
                        .foregroundStyle(palette.inkSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("The client and the service disagree")
                .accessibilityValue(
                    "The service says this account is discoverable, and the client gate "
                        + "says it is not. Discovery is withheld rather than offered and refused."
                )
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
                        .font(ScaledTypeface.headline)
                        .foregroundStyle(palette.ink)
                    Text(
                        done == model.rows.count
                            ? "Every step the service lists is complete."
                            : "The service lists what is still outstanding, in its own order."
                    )
                    .font(ScaledTypeface.callout)
                    .foregroundStyle(palette.inkSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
        }
        // `ProgressRing` carries a value and no name, so on its own it is
        // announced as "38 percent complete" with nothing to attach it to. The
        // ring and the sentence beside it are one fact, so they are one element
        // with a name, and the value is the count the server's `outstanding`
        // list produces rather than the ring's own percentage.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Setup progress")
        .accessibilityValue("\(done) of \(model.rows.count) steps complete")
        .accessibilityHint(
            done == model.rows.count
                ? "Every step the service lists is complete."
                : "The service lists what is still outstanding, in its own order."
        )
    }

    /// The facts this screen read, as the rows it draws and as the sentence it
    /// speaks.
    ///
    /// One list rather than four `FactRow` calls and a fourth copy of the same
    /// strings: a screen that draws a fact and does not speak it is a screen
    /// that is shorter for the member using VoiceOver than for the member
    /// looking at it.
    private var publishedFacts: [(label: String, value: String)] {
        var facts: [(label: String, value: String)] = []
        if let band = readiness.ageBand {
            facts.append((label: "Age band", value: band))
        }
        facts.append((label: "Identity", value: readiness.identity.state.rawValue))
        facts.append((label: "Profile", value: readiness.profileState.rawValue))
        facts.append((label: "Preferences", value: readiness.preferencesSet ? "Set" : "Not set"))
        return facts
    }

    private var checklist: some View {
        Card {
            VStack(alignment: .leading, spacing: Space.md) {
                SectionHeader("Checklist")
                ForEach(model.rows) { row in
                    HStack(alignment: .center, spacing: Space.sm) {
                        Image(systemName: row.isComplete ? "checkmark.circle.fill" : "circle")
                            .font(ScaledTypeface.symbolStrong)
                            .foregroundStyle(row.isComplete ? palette.granted : palette.inkSecondary)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(row.title)
                                .font(row.isNext ? ScaledTypeface.headline : ScaledTypeface.body)
                                .foregroundStyle(palette.ink)
                                .fixedSize(horizontal: false, vertical: true)
                            Text(spokenWords(row.step.rawValue))
                                .font(ScaledTypeface.mono)
                                .foregroundStyle(palette.inkSecondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: Space.sm)
                        if row.isNext {
                            TagChip("Next", systemImage: "arrow.right", tint: palette.accent)
                        }
                    }
                    // A row is a tick, a sentence and a step name: three elements
                    // saying one thing about one step, and the monospaced step
                    // name is the least useful of the three to hear. So the row
                    // is one element whose value is the state the service
                    // published — which is the fact the tick was drawing — and
                    // whose hint is the step's own name, so a member who cannot
                    // see the row still hears which step it is and whether it is
                    // outstanding.
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(row.title)
                    .accessibilityValue(
                        row.isComplete
                            ? "Complete"
                            : row.isNext ? "Outstanding. This is the next step." : "Outstanding"
                    )
                    .accessibilityHint("The service calls this step \(spokenWords(row.step.rawValue)).")
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