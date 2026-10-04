import Foundation

// MARK: - Interactions, matches and conversations
//
// Split out of `APIModels.swift` only to keep each file readable; there is no
// boundary between them in the design. These are the shapes the interaction and
// communication routes publish, and like the rest of this file every field is
// read off the wire rather than derived.
//
// Two shapes here are worth reading twice:
//
//   * `LikeResult` is a `201` even when the like did not become a match. The like
//     exists whether or not it matched, so the route answers with the domain's
//     resolution and a `null` match rather than refusing.
//   * `BlockResult` reports a repeated block as `created: false` with the existing
//     block's id. "A block already exists" and "the write failed" must never look
//     alike, so the second one is a fact and not a conflict.

// MARK: - Interactions

/// `POST /v1/interactions/likes`.
///
/// A like exists whether or not it became a match, which is why a blocked or
/// passed-through pair is a `201` with `match: nil` rather than a refusal.
/// `resolution` is the domain's own word, read as-is.
public struct LikeResult: Codable, Sendable, Equatable {
    public enum Resolution: String, Codable, Sendable, Equatable {
        case matchCreated = "match_created"
        case awaitingCounterpart = "awaiting_counterpart"
        case matchRefused = "match_refused"
    }

    public struct Match: Codable, Sendable, Equatable {
        public let matchId: String
        public let conversationId: String?
    }

    public let likeId: String
    public let created: Bool
    public let match: Match?
    public let resolution: Resolution
    public let reason: String?

    public init(
        likeId: String,
        created: Bool,
        match: Match?,
        resolution: Resolution,
        reason: String?
    ) {
        self.likeId = likeId
        self.created = created
        self.match = match
        self.resolution = resolution
        self.reason = reason
    }
}

/// `POST /v1/blocks`.
///
/// A second block on a pair is a fact the service handles, so it is a `200` with
/// `created: false` and the existing block's id — not a conflict.
public struct BlockResult: Codable, Sendable, Equatable {
    public let blockId: String?
    public let created: Bool

    public init(blockId: String?, created: Bool) {
        self.blockId = blockId
        self.created = created
    }
}

/// `POST /v1/reports`.
///
/// `evidence` is a count of frozen artefacts, not the artefacts: the digests are
/// retained for the appeal record and are not published to the reporter.
public struct ReportResult: Codable, Sendable, Equatable {
    public let reportId: String
    public let state: String
    public let reason: String
    public let evidence: Int
    public let relationship: String
    public let submittedAt: String

    public init(
        reportId: String,
        state: String,
        reason: String,
        evidence: Int,
        relationship: String,
        submittedAt: String
    ) {
        self.reportId = reportId
        self.state = state
        self.reason = reason
        self.evidence = evidence
        self.relationship = relationship
        self.submittedAt = submittedAt
    }
}

// MARK: - Matches and conversations

/// `GET /v1/matches`. The rows are the store's `matchView`, so these shapes are
/// the schema's rather than a projection the client would have to invent.
public struct MatchList: Codable, Sendable, Equatable {
    public let total: Int
    public let matches: [MatchRecord]

    public init(total: Int, matches: [MatchRecord]) {
        self.total = total
        self.matches = matches
    }
}

public struct MatchRecord: Codable, Sendable, Equatable, Identifiable {
    public var id: String { matchId }

    public let matchId: String
    public let pairKey: String
    public let participants: [String]
    public let likeIds: [String]
    public let standings: [String]
    public let createdAt: String
    public let endedAt: String?
    public let endedCause: String?

    /// The conversation this match opened, or `nil` when the service holds none.
    ///
    /// `GET /v1/matches` resolves it per row through `conversations.findByMatch`,
    /// scoped to the requesting participant — the same actor-scoped read the like
    /// route already does — so a member can only ever be told about a conversation
    /// they are in. Before it was published, the only conversation id a client ever
    /// received was the one on a `match_created` like response, which meant a
    /// member who opened the app on this list had no way to start a chat at all.
    public let conversationId: String?

    public init(
        matchId: String,
        pairKey: String,
        participants: [String],
        likeIds: [String],
        standings: [String],
        createdAt: String,
        endedAt: String?,
        endedCause: String?,
        conversationId: String? = nil
    ) {
        self.matchId = matchId
        self.pairKey = pairKey
        self.participants = participants
        self.likeIds = likeIds
        self.standings = standings
        self.createdAt = createdAt
        self.endedAt = endedAt
        self.endedCause = endedCause
        self.conversationId = conversationId
    }
}

/// `GET /v1/conversations/:conversationId/messages`, and the response to a send.
public struct MessagePage: Codable, Sendable, Equatable {
    public struct Message: Codable, Sendable, Equatable, Identifiable {
        public var id: String { messageId }

        public let messageId: String
        public let senderId: String
        public let body: String
        public let state: String
        public let createdAt: String
    }

    public let total: Int
    public let messages: [Message]

    public init(total: Int, messages: [Message]) {
        self.total = total
        self.messages = messages
    }
}

// MARK: - Readiness and health

/// `GET /v1/health/ready`. A `503` carries the same body, which is the whole
/// reason the endpoint is non-transactional.
public struct ReadinessReport: Codable, Sendable, Equatable {
    public struct Check: Codable, Sendable, Equatable {
        public let name: String
        public let ok: Bool
        public let detail: String
    }

    public let ready: Bool
    public let checkedAt: String
    public let checks: [Check]
    /// What the service tells a client *before* it asks for a birth date.
    ///
    /// Optional because a service that does not publish it must still decode —
    /// the alternative is a client that refuses to start against an older
    /// deployment. Absent, the sign-up screen shows no notice rather than writing
    /// its own: the age-gate sentence is the service's policy to state, and a
    /// paraphrase from the client is a promise nobody checked.
    public let terms: TermsDeclaration?
}

/// The terms version the service accepts, and the notice that precedes the age
/// gate. Published on readiness so every client quotes one sentence rather than
/// writing its own.
public struct TermsDeclaration: Codable, Sendable, Equatable {
    public struct AgeGate: Codable, Sendable, Equatable {
        public let title: String
        public let body: String

        public init(title: String, body: String) {
            self.title = title
            self.body = body
        }
    }

    public let currentVersion: String
    public let ageGate: AgeGate

    public init(currentVersion: String, ageGate: AgeGate) {
        self.currentVersion = currentVersion
        self.ageGate = ageGate
    }
}

/// `GET /v1/health/live`.
public struct LivenessReport: Codable, Sendable, Equatable {
    public let status: String
    public let phase: String
    public let pid: Int?
    public let uptimeSeconds: Double?
}

// MARK: - Timestamps

/// ISO-8601 with fractional seconds, which is what every `toISOString()` in the
/// service produces.
///
/// A formatter per call rather than a shared static: `ISO8601DateFormatter` is
/// documented as not thread-safe before iOS 17, and one shared across two
/// concurrent requests is a data race that shows up as a misparsed timestamp.
enum ISO8601 {
    static func date(from string: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: string) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: string)
    }
}