import SwiftUI
import BeenThereKit

/// One conversation, as `GET /v1/conversations/:conversationId/messages`
/// published it.
///
/// ## What this screen is and is not allowed to know
///
/// A conversation is between two people and the member is one of them, so every
/// message here is theirs to read — `senderId` is compared against the
/// session's own id to decide which side of the thread a message sits on, and
/// that comparison is the only thing this file derives.
///
/// What it does not do is decide whether a message may be sent. `ClientGate`
/// governs whether the composer is *offered*; the service decides whether the
/// send happens, and a refusal arrives as its own message with its own reason.
///
/// ## Why there is no photograph
///
/// `photoIds` carries identifiers and no bytes, and `MatchRecord` carries no
/// media at all — so the header's circle is the design system's `Avatar`,
/// derived from the counterpart's id, which claims nothing about how anybody
/// looks.
public struct ChatScreen: View {

    @Environment(\.palette) private var palette
    @Environment(\.feedback) private var feedback

    @Bindable var model: AppModel

    let conversation: AppModel.Conversation
    let onBack: () -> Void

    @State private var sheet: SafetySheet?

    public init(
        model: AppModel,
        conversation: AppModel.Conversation,
        onBack: @escaping () -> Void
    ) {
        self.model = model
        self.conversation = conversation
        self.onBack = onBack
    }

    public var body: some View {
        Screen("Messages", subtitle: conversation.counterpartId) {
            header

            SafetyNotice(
                failure: model.safetyFailure,
                report: model.lastReport,
                block: model.lastBlock
            )

            transcript
            composer
        }
        .sheet(item: $sheet) { presented in
            SafetySheetView(model: model, sheet: presented)
        }
        .onChange(of: sheet) { _, next in
            if next != nil { feedback.changed() }
        }
    }

    private var header: some View {
        Card(padding: Space.md) {
            VStack(alignment: .leading, spacing: Space.md) {
                HStack(spacing: Space.md) {
                    Avatar(name: conversation.counterpartId, id: conversation.counterpartId, size: 44)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(conversation.counterpartId)
                            .font(Typeface.mono)
                            .foregroundStyle(palette.ink)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Text(conversation.match.endedAt == nil ? "Open" : "Ended")
                            .font(Typeface.caption)
                            .foregroundStyle(palette.inkTertiary)
                    }
                    Spacer(minLength: 0)
                    SecondaryButton("Back", action: onBack)
                }

                SafetyActions(
                    offersBlock: model.offersBlock,
                    offersReport: model.offersReport,
                    onBlock: { sheet = .block(conversation.counterpartId) },
                    onReport: { sheet = .report(conversation.counterpartId) }
                )
            }
        }
    }

    @ViewBuilder
    private var transcript: some View {
        if let failure = model.messagesFailure {
            FailureNote(failure) { Task { await model.reloadMessages() } }
        } else if let page = model.messages, !page.messages.isEmpty {
            LazyVStack(spacing: Space.sm) {
                ForEach(page.messages) { message in
                    MessageBubble(
                        message: message,
                        isMine: message.senderId == model.session?.userId
                    )
                }
            }
            Text("\(page.total) in total")
                .font(Typeface.caption)
                .foregroundStyle(palette.inkTertiary)
                .padding(.top, Space.xs)
        } else if model.messages != nil {
            EmptyState(
                systemImage: "bubble.left.and.bubble.right",
                title: "No messages yet",
                body: "Nobody has sent anything in this conversation."
            )
        } else {
            ProgressRing(fraction: 0.15, tint: palette.accent, size: 44)
                .frame(maxWidth: .infinity)
        }
    }

    @ViewBuilder
    private var composer: some View {
        if model.offersComposer {
            VStack(alignment: .leading, spacing: Space.sm) {
                LabelledField("Message") {
                    TextField("Say something", text: $model.draft, axis: .vertical)
                        .textFieldStyle(.plain)
                        .font(Typeface.callout)
                        .foregroundStyle(palette.ink)
                        .lineLimit(1...5)
                }
                PrimaryButton("Send", isEnabled: model.canSendDraft) {
                    Task {
                        await model.sendMessage()
                        feedback.tap(.light)
                    }
                }
            }
        } else {
            Card {
                Text(unavailableReason)
                    .font(Typeface.callout)
                    .foregroundStyle(palette.inkSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// Why the composer is absent, stated only in facts the service published.
    ///
    /// ## Why this is not `ClientGate.canSendMessage`
    ///
    /// That gate is the right instrument and cannot be played honestly here. It
    /// wants the *counterpart's* `AccountStanding` — capabilities and all — and
    /// `MatchRecord.standings` publishes only a state string per participant.
    /// Building an `AccountStanding` out of it would be a standing the app
    /// invented, and then the gate would be reading the app's own fiction.
    ///
    /// So the two facts that are real are stated instead: the match's own
    /// ending, and the viewer's own granted capabilities. A block is not named
    /// — the member who blocked and the member who was blocked are told the same
    /// thing, because a refusal that told them apart would be an oracle, and the
    /// service is the one that decides it on the send anyway.
    private var unavailableReason: String {
        guard let open = model.chat else { return "No conversation is open." }
        if let endedAt = open.match.endedAt {
            let cause = open.match.endedCause ?? "no cause given"
            return "This conversation ended on \(endedAt); the service recorded the cause as "
                + "\(cause). You can still read it, and you can still report."
        }
        guard let snapshot = model.viewerSnapshot else {
            return "The service has not published your standing yet."
        }
        if !snapshot.account.capabilities.contains("send_message") {
            let removed = snapshot.account.removedCapabilities
            return "Your account does not hold the send_message capability. The service "
                + "published these restrictions"
                + (removed.isEmpty ? "" : ": " + removed.joined(separator: ", "))
                + "."
        }
        return "Messaging is unavailable on your account right now."
    }
}

/// One message, on the side it belongs to.
struct MessageBubble: View {
    @Environment(\.palette) private var palette

    let message: MessagePage.Message
    let isMine: Bool

    var body: some View {
        HStack {
            if isMine { Spacer(minLength: Space.xl) }
            VStack(alignment: isMine ? .trailing : .leading, spacing: 2) {
                Text(message.body)
                    .font(Typeface.callout)
                    .foregroundStyle(isMine ? palette.onAccent : palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                Text("\(message.createdAt) · \(message.state)")
                    .font(Typeface.caption)
                    .foregroundStyle(isMine ? palette.onAccent.opacity(0.75) : palette.inkTertiary)
            }
            .padding(Space.md)
            .background(isMine ? palette.accent : palette.surface)
            .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            if !isMine { Spacer(minLength: Space.xl) }
        }
    }
}