import Foundation
import BeenThereKit

/// The member surfaces that need the service: conversations, messages, blocks
/// and reports.
///
/// ## Why these live beside `AppModel` and not in it
///
/// They are `AppModel` behaviour with no state of their own — every fact they
/// show was published by the service, and none of it is stored here. Splitting
/// them out is what keeps `AppModel.swift` inside the 500-line ceiling without
/// thinning its documentation, which is where this repository's rules live.
///
/// ## Why they are an extension and not a second object
///
/// `AppModel` is `@Observable`, and that macro instruments the *stored*
/// properties of its primary declaration. A second observable object holding
/// the same session would be a second copy of one truth and a second thing to
/// invalidate; an extension keeps one object, one set of stored properties and
/// one invalidation. It reaches `client`, which is why that property is
/// module-internal rather than file-private.
extension AppModel {

    /// Whether the composer is worth offering.
    ///
    /// Two published facts gate it and neither is re-derived here: the match is
    /// still open (`endedAt == nil`), and the viewer still holds
    /// `send_message` on the standing the service sent. The third condition —
    /// no block — the service decides on the send, because a block is never
    /// published to the blocked party in either direction and a client that
    /// guessed at it would be an oracle.
    public var offersComposer: Bool {
        guard let chat, let snapshot = viewerSnapshot else { return false }
        return chat.match.endedAt == nil && snapshot.account.capabilities.contains("send_message")
    }

    public var canSendDraft: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isLoading
    }

    /// Whether the report affordance is offered, per the granted set.
    ///
    /// `ClientGate.canReport` reads the capabilities the standing projection
    /// published, so this is a readback and not a rule: before the first load
    /// there is no standing and the answer is `false`.
    public var offersReport: Bool {
        guard let snapshot = viewerSnapshot else { return false }
        return ClientGate.canReport(snapshot)
    }

    /// Whether the block affordance is offered, per the granted set.
    public var offersBlock: Bool {
        guard let snapshot = viewerSnapshot else { return false }
        return ClientGate.canBlock(snapshot)
    }

    /// Re-reads the open conversation. The only thing a failed read can honestly
    /// offer a member: the page the service serves now.
    public func reloadMessages() async {
        await loadMessages()
    }

    /// Opens the chat behind a match, reading its history.
    ///
    /// The id comes off the match itself: `GET /v1/matches` resolves each row's
    /// conversation through the participant-scoped port, so a member can only be
    /// told about a conversation they are in. A match the service holds with no
    /// conversation behind it opens nothing, and its row says so rather than
    /// offering a button that cannot work.
    public func openChat(_ match: MatchRecord) async {
        guard let conversationId = match.conversationId, let held = session else { return }
        let counterpart = match.participants.first { $0 != held.userId } ?? match.participants[0]
        chat = Conversation(match: match, counterpartId: counterpart, conversationId: conversationId)
        draft = ""
        messagesFailure = nil
        await loadMessages()
    }

    public func closeChat() {
        chat = nil
        messages = nil
        messagesFailure = nil
        draft = ""
    }

    func loadMessages() async {
        guard let open = chat else { return }
        messagesFailure = nil
        do {
            messages = try await client.messages(conversationId: open.conversationId)
        } catch let error as APIError {
            messagesFailure = error
        } catch {
            messagesFailure = .transport(String(describing: error))
        }
    }

    /// Sends the draft, then reads the conversation back.
    ///
    /// The re-read is the whole point: `POST .../messages` answers with the
    /// whole page, but `APIClient.sendMessage` hands back only the message it
    /// sent, and a client that stitched that onto its own list would have to
    /// invent a `total` it was never given. So the send clears the draft, the
    /// page is read again, and if that read fails the screen says so rather
    /// than showing a conversation the app assembled.
    public func sendMessage() async {
        guard let open = chat else { return }
        let body = draft
        isLoading = true
        defer { isLoading = false }
        do {
            _ = try await client.sendMessage(conversationId: open.conversationId, body: body)
            draft = ""
            await loadMessages()
        } catch let error as APIError {
            messagesFailure = error
        } catch {
            messagesFailure = .transport(String(describing: error))
        }
    }

    /// `POST /v1/blocks`.
    ///
    /// A block is unilateral and immediate, so the matches are re-read rather
    /// than patched: `applyBlockToMatch` ends the match, withdraws the pair's
    /// likes and closes the conversation behind it, and the only honest list
    /// afterwards is the one the service now serves.
    public func block(counterpartId: String) async {
        guard session != nil else { return }
        safetyFailure = nil
        isLoading = true
        defer { isLoading = false }
        do {
            lastBlock = try await client.block(userId: counterpartId)
            closeChat()
            await refresh()
        } catch let error as APIError {
            safetyFailure = error
        } catch {
            safetyFailure = .transport(String(describing: error))
        }
    }

    /// `POST /v1/reports`.
    ///
    /// The reason is the server's closed vocabulary and travels untouched. A
    /// refusal comes back as the domain's own message and `field`, and it is
    /// shown as sent rather than translated — the member is owed the service's
    /// reason, not a paraphrase of it.
    public func report(counterpartId: String, reason: String, statement: String) async {
        guard session != nil else { return }
        safetyFailure = nil
        isLoading = true
        defer { isLoading = false }
        do {
            let trimmed = statement.trimmingCharacters(in: .whitespacesAndNewlines)
            lastReport = try await client.report(
                subjectUserId: counterpartId,
                reason: reason,
                statement: trimmed.isEmpty ? nil : trimmed
            )
            await refresh()
        } catch let error as APIError {
            safetyFailure = error
        } catch {
            safetyFailure = .transport(String(describing: error))
        }
    }
}