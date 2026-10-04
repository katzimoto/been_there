import SwiftUI
import BeenThereKit

/// Which safety sheet is open, and about whom.
///
/// One enum rather than two booleans because they are the same decision: a
/// member can only be doing one of these at a time, and two optionals would
/// allow a state the product does not have.
enum SafetySheet: Identifiable, Equatable {
    case report(String)
    case block(String)

    /// The subject's id, which is also the sheet's identity — one sheet at a
    /// time means one subject.
    var id: String { subjectId }
    var subjectId: String {
        switch self {
        case .report(let id), .block(let id): id
        }
    }
}

/// The report reasons `POST /v1/reports` accepts.
///
/// ## This is a vocabulary, not a rule
///

/// `reports.ts` passes `Object.keys(REPORT_REASON_POLICY)` to `readEnum`, which
/// **refuses** anything outside the list with a `validation_failed` naming the
/// field. So a free-text reason would be refused by the service every time, and
/// a client that offers nothing to pick from cannot file a report at all.
///
/// What this list deliberately does **not** carry is the triage policy beside
/// each reason — the priority, and whether the service insists on a statement.
/// Those are the server's and no route publishes them, so this file offers the
/// statement always and lets the service refuse in its own words if it wants
/// one. Copying the policy here would be a second answer to a question only the
/// moderation domain may answer.
enum ReportReason: String, CaseIterable, Identifiable {
    case harassment
    case hateOrDiscrimination = "hate_or_discrimination"
    case threatsOrViolence = "threats_or_violence"
    case sexualContent = "sexual_content"
    case nonConsensualIntimacy = "non_consensual_intimacy"
    case minorSafety = "minor_safety"
    case unsafeContact = "unsafe_contact"
    case scamOrSolicitation = "scam_or_solicitation"
    case impersonation
    case fakeOrMisleadingProfile = "fake_or_misleading_profile"
    case spam
    case other

    var id: String { rawValue }

    /// The wire value. The client sends this and reads the answer against it.
    var wireValue: String { rawValue }

    /// What the member picks from.
    ///
    /// The same words the service declares, with underscores read as spaces.
    /// Replacing `non_consensual_intimacy` with something gentler would make the
    /// picker disagree with what the case will say about it.
    var title: String {
        rawValue.replacingOccurrences(of: "_", with: " ").capitalized
    }
}

/// The sheet for a `SafetySheet`, bound to the model that performs it.
///
/// One implementation for all three places the actions are reachable from — a
/// discovery card, a match row and a chat — because a member filing a report
/// must not be able to tell which screen they are on from what the form says.
struct SafetySheetView: View {
    @Bindable var model: AppModel

    let sheet: SafetySheet

    var body: some View {
        switch sheet {
        case .report(let subjectId):
            ReportSheet(subjectId: subjectId) { reason, statement in
                Task {
                    await model.report(counterpartId: subjectId, reason: reason, statement: statement)
                }
            }
        case .block(let subjectId):
            BlockConfirmation(subjectId: subjectId) {
                Task { await model.block(counterpartId: subjectId) }
            }
        }
    }
}

/// Block and Report, offered only where the service granted them.
///
/// `offersBlock` and `offersReport` are `ClientGate.canBlock` / `canReport`
/// readbacks of the capabilities the standing projection published. A control
/// the server would refuse is not drawn greyed out — it is absent, because an
/// affordance that always fails teaches people the app is broken.
struct SafetyActions: View {
    @Environment(\.palette) private var palette

    let offersBlock: Bool
    let offersReport: Bool
    let onBlock: () -> Void
    let onReport: () -> Void

    var body: some View {
        if offersBlock || offersReport {
            HStack(spacing: Space.sm) {
                if offersReport {
                    SecondaryButton("Report", action: onReport)
                }
                if offersBlock {
                    SecondaryButton("Block", tint: palette.restricted, action: onBlock)
                }
            }
        }
    }
}

/// What the last block or report did, and any refusal.
///
/// Every value here was published by the service: `BlockResult.created` says a
/// second block on a pair was a fact rather than a conflict, and `ReportResult`
/// carries the case's state, its reason, how much evidence was frozen and what
/// the relationship was at the moment of the report.
struct SafetyNotice: View {
    @Environment(\.palette) private var palette

    let failure: APIError?
    let report: ReportResult?
    let block: BlockResult?

    var body: some View {
        if let failure {
            Card {
                VStack(alignment: .leading, spacing: Space.sm) {
                    HStack(spacing: Space.sm) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(palette.restricted)
                        Text("The service refused this")
                            .font(Typeface.headline)
                            .foregroundStyle(palette.ink)
                    }
                    // The domain's own message, plus the `reason` detail it
                    // attached. Both are the service's words; a paraphrase would
                    // be the client explaining a refusal the member is owed
                    // verbatim.
                    Text(failure.message ?? "The request did not complete.")
                        .font(Typeface.callout)
                        .foregroundStyle(palette.inkSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if let reason = failure.reason {
                        FactRow("Reason", reason)
                    }
                    if let field = failure.field {
                        FactRow("Field", field)
                    }
                    if failure.isRetryable {
                        FactRow("Retryable", "the service says yes")
                    }
                }
            }
        } else if let report {
            Card {
                VStack(alignment: .leading, spacing: Space.sm) {
                    Label("Report received", systemImage: "checkmark.shield.fill")
                        .font(Typeface.headline)
                        .foregroundStyle(palette.ink)
                    FactRow("Report", report.reportId)
                    FactRow("State", report.state)
                    FactRow("Reason", report.reason)
                    FactRow("Evidence kept", "\(report.evidence)")
                    FactRow("Relationship", report.relationship)
                }
            }
        } else if let block {
            Card {
                VStack(alignment: .leading, spacing: Space.sm) {
                    Label(
                        block.created ? "Blocked" : "Already blocked",
                        systemImage: "hand.raised.fill"
                    )
                    .font(Typeface.headline)
                    .foregroundStyle(palette.ink)
                    if let blockId = block.blockId {
                        FactRow("Block", blockId)
                    }
                    Text("A block is immediate and needs nothing from the service afterwards.")
                        .font(Typeface.caption)
                        .foregroundStyle(palette.inkTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

/// Confirming a block.
///
/// A block ends the match, withdraws the pair's likes and closes the
/// conversation, and there is no undo route. That is worth one tap of
/// confirmation, stated in the words of what will happen rather than softened.
struct BlockConfirmation: View {
    @Environment(\.palette) private var palette
    @Environment(\.dismiss) private var dismiss

    let subjectId: String
    let onBlock: () -> Void

    var body: some View {
        Screen("Block this person?", subtitle: "About \(subjectId)") {
            Card {
                VStack(alignment: .leading, spacing: Space.sm) {
                    Text("Blocking is immediate. The match ends, the messages you have with "
                        + "them stop being sent, and you will not be told whether they have "
                        + "blocked you.")
                        .font(Typeface.callout)
                        .foregroundStyle(palette.inkSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("You can still report them afterwards. A report outlives the match.")
                        .font(Typeface.caption)
                        .foregroundStyle(palette.inkTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            PrimaryButton("Block", action: onBlock)
            SecondaryButton("Cancel", action: { dismiss() })
        }
    }
}

/// Filing a report.
struct ReportSheet: View {
    @Environment(\.palette) private var palette
    @Environment(\.dismiss) private var dismiss

    let subjectId: String
    let onSubmit: (String, String) -> Void

    @State private var reason: ReportReason?
    @State private var statement: String = ""

    var body: some View {
        Screen("Report \(subjectId)", subtitle: "A person reads this. Say what happened.") {
            VStack(alignment: .leading, spacing: Space.sm) {
                SectionHeader("Why")
                ForEach(ReportReason.allCases) { option in
                    Button {
                        reason = option
                    } label: {
                        HStack(spacing: Space.sm) {
                            Image(systemName: option == reason ? "largecircle.fill.circle" : "circle")
                                .font(.system(size: 17))
                                .foregroundStyle(option == reason ? palette.accent : palette.inkTertiary)
                            Text(option.title)
                                .font(Typeface.callout)
                                .foregroundStyle(palette.ink)
                            Spacer(minLength: 0)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(PressableStyle())
                }
            }

            VStack(alignment: .leading, spacing: Space.sm) {
                LabelledField("What happened (optional)") {
                    TextField("Add anything that helps", text: $statement, axis: .vertical)
                        .textFieldStyle(.plain)
                        .font(Typeface.callout)
                        .foregroundStyle(palette.ink)
                        .lineLimit(3...8)
                }
                // The service decides whether a given reason needs one:
                // `REPORT_REASON_POLICY.requiresStatement` is a moderation rule
                // and no route publishes it. Stating that is honest; promising
                // "optional" would not be.
                Text("Some reasons need a written statement and some do not. The service "
                    + "decides, and will say so if it needs one.")
                    .font(Typeface.caption)
                    .foregroundStyle(palette.inkTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            PrimaryButton("Send report", isEnabled: reason != nil) {
                guard let reason else { return }
                onSubmit(reason.wireValue, statement)
                dismiss()
            }
            SecondaryButton("Cancel", action: { dismiss() })
        }
    }
}