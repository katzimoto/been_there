import SwiftUI
import BeenThereKit

/// The discovery page, as `GET /v1/discovery` published it.
///
/// ## What this screen is allowed to say about an empty page
///
/// `discovery.ts` publishes **no reason for any absence** — the reasons are
/// `internal` by the domain's design, because a reason a client could read would
/// be a side channel for inferring another person's identity state, standing or
/// block. So this screen has exactly the three explanations
/// `DiscoveryViewModel` allows, each grounded in the member's own projections:
///
///   * not visible in the product (`visibleInProduct: false`);
///   * not yet ready, with the step the server itself named in `nextStep`;
///   * the page is simply empty and the member may browse.
///
/// It never says "no one near you matches", never names a filter, and never
/// claims a distance it was not given — `CandidateCard.distance` is `unknown`
/// whenever the platform could not resolve a separation, and
/// `hasRenderableDistance` is what keeps that out of the card.
public struct DiscoveryScreen: View {

    @Environment(\.palette) private var palette
    @Environment(\.feedback) private var feedback

    private let model: DiscoveryViewModel
    /// The model that performs the actions. Separate from `model` because this
    /// screen *renders* a `DiscoveryViewModel` — the page the service published
    /// — while blocking and reporting are account-wide writes that only
    /// `AppModel`, which owns the session, may make.
    private let actions: AppModel
    private let offersLike: Bool
    private let offersBlock: Bool
    private let offersReport: Bool
    private let likeOutcome: LikeResult.Resolution?
    private let likeFailure: APIError?
    private let onRetry: () -> Void
    private let onLike: (CandidateCard) -> Void
    private let onBlock: (CandidateCard) -> Void
    private let onReport: (CandidateCard) -> Void

    public init(
        model: DiscoveryViewModel,
        actions: AppModel,
        offersLike: Bool,
        offersBlock: Bool = false,
        offersReport: Bool = false,
        likeOutcome: LikeResult.Resolution? = nil,
        likeFailure: APIError? = nil,
        onRetry: @escaping () -> Void = {},
        onLike: @escaping (CandidateCard) -> Void = { _ in },
        onBlock: @escaping (CandidateCard) -> Void = { _ in },
        onReport: @escaping (CandidateCard) -> Void = { _ in }
    ) {
        self.model = model
        self.actions = actions
        self.offersLike = offersLike
        self.offersBlock = offersBlock
        self.offersReport = offersReport
        self.likeOutcome = likeOutcome
        self.likeFailure = likeFailure
        self.onRetry = onRetry
        self.onLike = onLike
        self.onBlock = onBlock
        self.onReport = onReport
    }

    /// The safety sheet this screen is showing, or `nil`.
    ///
    /// Block and Report live here as well as on a match because the person on a
    /// discovery card is somebody a member may never match — and the moment a
    /// member wants to report someone is usually *before* they match.
    @State private var sheet: SafetySheet?

    /// The card whose like is in flight, or `nil`.
    ///
    /// Held here rather than read off the model because `isLoading` is true for
    /// every load in the app, and a heart that springs because a background
    /// refresh happened is a lie about the member's own action. The id is what
    /// keeps it to *this* card, so liking one person does not animate the other
    /// nine.
    @State private var liking: String?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public var body: some View {
        Screen(model.headline, subtitle: model.bodyText) {
            outcomeBanner

            switch model.content {
            case .cards(let cards):
                VStack(alignment: .leading, spacing: 0) {
                    LazyVStack(spacing: Space.sm) {
                        ForEach(cards) { card in
                            CandidateRow(
                                card: card,
                                offersLike: offersLike,
                                offersBlock: offersBlock,
                                offersReport: offersReport,
                                isLiking: liking == card.userId,
                                onLike: {
                                    liking = card.userId
                                    onLike(card)
                                },
                                onBlock: { sheet = .block(card.userId) },
                                onReport: { sheet = .report(card.userId) }
                            )
                        }
                    }
                    Text("\(model.total) in total · projection v\(model.projectionVersion)")
                        .font(.system(size: 12))
                        .foregroundStyle(.tertiary)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.top, Space.xs)
                }
                .revealOnReplace(when: model.projectionVersion)

            case .blocked, .empty:
                EmptyState(
                    systemImage: "sparkle.magnifyingglass",
                    title: "Nobody here right now",
                    body: "This page says nothing about anybody else. The service does not "
                        + "publish why a person is absent from it.",
                    actionTitle: model.offersRetry ? "Try again" : nil,
                    action: model.offersRetry ? onRetry : nil
                )
                .revealOnReplace(when: model.projectionVersion)

            case .unavailable(let error):
                FailureNote(error, retry: onRetry)
                    .revealOnReplace(when: error)
            }

            if model.offersRetry, case .cards = model.content {
                SecondaryButton("Refresh") { onRetry() }
            }
        }
        .sheet(item: $sheet) { presented in
            SafetySheetView(model: actions, sheet: presented)
        }
        // The spring is released the moment the service answers, and at
        // `Motion.likeSettle` regardless — so a request that never comes back
        // cannot leave a heart stuck open on somebody's card.
        .task(id: liking) {
            guard liking != nil else { return }
            do {
                try await Task.sleep(for: Motion.likeSettle)
            } catch {
                return
            }
            liking = nil
        }
        .onChange(of: likeOutcome) { liking = nil }
        .onChange(of: likeFailure) { liking = nil }
    }

/// What the last like did, in the domain's own words.
///
/// A like that produced a match is the one moment this screen has something to
/// celebrate, and the one moment a member needs confirmation for: the button was
/// pressed, the page reloaded, and without this the only evidence anything
/// happened is that a card is gone. A refused like says so with the reason the
/// server gave — the two are opposites and merging them would tell a member their
/// like landed when it did not.
@ViewBuilder
private var outcomeBanner: some View {
    if let outcome = likeOutcome {
        let matched = outcome == .matchCreated
        HStack(spacing: Space.sm) {
            Image(systemName: matched ? "heart.circle.fill" : "info.circle.fill")
                .foregroundStyle(matched ? palette.accent : palette.inkSecondary)
            Text(matched ? "It's a match." : likeRefusalText(outcome))
                .font(Typeface.callout)
                .foregroundStyle(palette.ink)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(Space.md)
        .background(matched ? palette.accentSoft : palette.fill)
        .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .top)))
        // Spring rather than the default ease, because this is the far end of
        // the like: the heart sprang on the press, and this is the same spring
        // arriving. An ease-out here would read as a different event.
        .animation(reduceMotion ? nil : Motion.like, value: outcome)
        .task {
            matched ? feedback.succeed() : feedback.warn()
        }
    } else if let likeFailure {
        FailureNote(likeFailure, retry: onRetry)
    }
}

/// The refusal's own name, not a paraphrase of it. `DiscoveryViewModel` treats
/// the reasons as server vocabulary for the same reason this screen does.
private func likeRefusalText(_ outcome: LikeResult.Resolution) -> String {
    switch outcome {
    case .matchCreated: "It's a match."
    case .matchRefused: "The service did not make a match from that like."
    case .awaitingCounterpart: "Like sent — waiting to see if they liked you back."
    }
}
}

/// One person, as published.
///
/// Every field is the projection's. `photoIds` is a **count**, never an image:
/// the field carries identifiers and no bytes — the media service lives outside
/// this system — so drawing a photograph would be inventing the thing the field
/// is a reference to. The leading circle is an avatar built from the name the
/// projection published and a hue derived from the id, which claims nothing about
/// how anybody looks.
///
/// ## Why block and report are on this card
///
/// The person on a discovery card is somebody a member may never match, and the
/// moment somebody wants to report a person is usually *before* they match. The
/// safety controls therefore cannot live only behind a match: a member who
/// cannot block or report from this card is a member who cannot use the safety
/// product at all. They are offered exactly when `ClientGate` says the service
/// granted `block` and `report`, and are absent otherwise.
struct CandidateRow: View {
    let card: CandidateCard
    let offersLike: Bool
    let offersBlock: Bool
    let offersReport: Bool
    /// Whether the like this row sent is still in flight.
    ///
    /// The spring is on the control rather than on the row, because the row is
    /// what disappears when the service answers — animating the row would
    /// animate it out of existence instead of connecting the press to the
    /// outcome.
    let isLiking: Bool
    let onLike: () -> Void
    let onBlock: () -> Void
    let onReport: () -> Void

    var body: some View {
        Card(padding: Space.md) {
            VStack(alignment: .leading, spacing: Space.md) {
                HStack(alignment: .center, spacing: Space.md) {
                    Avatar(name: card.displayName, id: card.userId, size: 56)

                    VStack(alignment: .leading, spacing: 2) {
                        Text(card.displayName)
                            .font(Typeface.headline)
                            .foregroundStyle(.primary)
                        Text("\(card.age)")
                            .font(Typeface.callout)
                            .foregroundStyle(.secondary)
                    }

                    Spacer(minLength: Space.sm)

                    if offersLike {
                        CircleAction(systemImage: "heart.fill", label: "Like \(card.displayName)") {
                            onLike()
                        }
                        .likeSpring(pending: isLiking)
                    }
                }

                if !card.bio.isEmpty {
                    Text(card.bio)
                        .font(Typeface.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                }

                HStack(spacing: Space.xs) {
                    // `nil` rather than "nearby": the platform publishes no
                    // distance when it could not resolve one, and a screen that
                    // invented a proximity claim would be stating something
                    // nobody knows.
                    if let distance = card.distanceLabel {
                        TagChip(distance, systemImage: "location")
                    }
                    ForEach(card.genderIdentities, id: \.self) { identity in
                        TagChip(identity)
                    }
                    if !card.photoIds.isEmpty {
                        TagChip("\(card.photoIds.count) photos", systemImage: "photo")
                    }
                    Spacer(minLength: 0)
                }

                if !offersLike {
                    Text("Liking is not offered on your account right now.")
                        .font(Typeface.caption)
                        .foregroundStyle(.tertiary)
                }

                SafetyActions(
                    offersBlock: offersBlock,
                    offersReport: offersReport,
                    onBlock: onBlock,
                    onReport: onReport
                )
            }
        }
    }
}