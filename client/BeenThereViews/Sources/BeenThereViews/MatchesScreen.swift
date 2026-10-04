import SwiftUI
import BeenThereKit

/// The matches page, as `GET /v1/matches` published it.
///
/// ## What this screen can and cannot say about a person
///
/// `MatchRecord` names two participants and nothing else — no display name, no
/// age, no bio, no photo. No route resolves another member's profile, so the
/// row's only handle on them is their id, drawn with the `Avatar` the design
/// system already uses for exactly this case: initials derived from what the
/// projection holds and a hue derived from the id. `photoIds` carries
/// identifiers and no bytes, so nothing here draws a photograph.
///
/// ## Where the chat comes from
///
/// `GET /v1/matches` publishes each row's conversation, resolved through the
/// participant-scoped port, so `match.conversationId` is the id and it is only
/// ever an id this member is inside. A match the service holds with no
/// conversation behind it gets no button, and the row says why.
public struct MatchesScreen: View {

    @Environment(\.palette) private var palette
    @Environment(\.feedback) private var feedback

    @Bindable var model: AppModel

    @State private var sheet: SafetySheet?

    public init(model: AppModel) {
        self.model = model
    }

    public var body: some View {
        Screen("Matches", subtitle: "Everyone you matched with, as the service lists them.") {
            SafetyNotice(failure: model.safetyFailure, report: model.lastReport, block: model.lastBlock)

            content

            SecondaryButton("Refresh") { Task { await model.refresh() } }
        }
        .sheet(item: $sheet) { presented in
            SafetySheetView(model: model, sheet: presented)
        }
        .onChange(of: sheet) { _, next in
            if next != nil { feedback.changed() }
        }
    }

    @ViewBuilder
    private var content: some View {
        if let failure = model.matchesFailure {
            FailureNote(failure) { Task { await model.refresh() } }
        } else if let matches = model.matches, !matches.matches.isEmpty {
            LazyVStack(spacing: Space.sm) {
                ForEach(matches.matches) { match in
                    MatchRow(
                        match: match,
                        counterpartId: counterpart(of: match),
                        opensChat: match.conversationId != nil,
                        offersBlock: model.offersBlock,
                        offersReport: model.offersReport,
                        onOpenChat: { Task { await model.openChat(match) } },
                        onBlock: { sheet = .block(counterpart(of: match)) },
                        onReport: { sheet = .report(counterpart(of: match)) }
                    )
                }
            }
            Text("\(matches.total) in total")
                .font(Typeface.caption)
                .foregroundStyle(palette.inkTertiary)
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.top, Space.xs)
        } else if model.matches != nil {
            // The shortcut only exists where the People tab exists. Sending a
            // member to a tab the tab bar is not offering would leave `tab`
            // pointing at something they cannot get back to.
            EmptyState(
                systemImage: "heart",
                title: "No matches yet",
                body: "A match appears here the moment somebody likes you back. Nothing is "
                    + "missing here — this list is what the service currently holds.",
                actionTitle: model.offersDiscovery ? "Browse people" : nil,
                action: model.offersDiscovery ? { model.go(to: .discovery) } : nil
            )
        } else {
            ProgressRing(fraction: 0.15, tint: palette.accent, size: 44)
                .frame(maxWidth: .infinity)
        }
    }

    /// The other participant.
    ///
    /// `participants` names both and the client knows its own id, so this is a
    /// choice between two published strings rather than a lookup.
    private func counterpart(of match: MatchRecord) -> String {
        let viewerId = model.session?.userId
        return match.participants.first { $0 != viewerId } ?? match.participants[0]
    }
}

/// One match, as published.
struct MatchRow: View {
    @Environment(\.palette) private var palette

    let match: MatchRecord
    let counterpartId: String
    let opensChat: Bool
    let offersBlock: Bool
    let offersReport: Bool
    let onOpenChat: () -> Void
    let onBlock: () -> Void
    let onReport: () -> Void

    var body: some View {
        Card(padding: Space.md) {
            VStack(alignment: .leading, spacing: Space.md) {
                HStack(alignment: .center, spacing: Space.md) {
                    // The id is the whole of what the service published about
                    // this person, so it is shown as the name rather than a
                    // friendly label standing in for one.
                    Avatar(name: counterpartId, id: counterpartId, size: 52)

                    VStack(alignment: .leading, spacing: 2) {
                        Text(counterpartId)
                            .font(Typeface.mono)
                            .foregroundStyle(palette.ink)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Text(match.endedAt == nil ? "Matched" : "Ended")
                            .font(Typeface.caption)
                            .foregroundStyle(palette.inkTertiary)
                    }

                    Spacer(minLength: 0)
                }

                FactRow("Match", match.matchId)
                FactRow("Matched", match.createdAt)
                ForEach(Array(match.standings.enumerated()), id: \.offset) { index, state in
                    FactRow(standingLabel(index), state)
                }

                if !opensChat {
                    Text("The service holds no conversation for this match, so there is nothing to "
                        + "open. No chat button is offered rather than one that would fail.")
                        .font(Typeface.caption)
                        .foregroundStyle(palette.inkTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                SafetyActions(
                    offersBlock: offersBlock,
                    offersReport: offersReport,
                    onBlock: onBlock,
                    onReport: onReport
                )

                if opensChat {
                    SecondaryButton("Open chat", action: onOpenChat)
                }
            }
        }
    }

    /// Whose standing a row is about.
    ///
    /// `standings` is parallel to `participants` in the store's view, so the
    /// index is the join. "You" is the one thing the projection cannot supply:
    /// the member knows which of the two ids is theirs.
    private func standingLabel(_ index: Int) -> String {
        index < match.participants.count && match.participants[index] == counterpartId
            ? "Their standing"
            : "Your standing"
    }
}