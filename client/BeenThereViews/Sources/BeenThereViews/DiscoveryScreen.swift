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

    private let model: DiscoveryViewModel
    private let offersLike: Bool
    private let onRetry: () -> Void
    private let onLike: (CandidateCard) -> Void

    public init(
        model: DiscoveryViewModel,
        offersLike: Bool,
        onRetry: @escaping () -> Void = {},
        onLike: @escaping (CandidateCard) -> Void = { _ in }
    ) {
        self.model = model
        self.offersLike = offersLike
        self.onRetry = onRetry
        self.onLike = onLike
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.md) {
                VStack(alignment: .leading, spacing: Space.xs) {
                    screenTitle(model.headline)
                    screenSubtitle(model.bodyText)
                    Text("Read model version \(model.projectionVersion)")
                        .font(.system(size: 12))
                        .foregroundStyle(.tertiary)
                }

                switch model.content {
                case .cards(let cards):
                    ForEach(cards) { card in
                        CandidateRow(card: card, offersLike: offersLike) { onLike(card) }
                    }
                    screenSubtitle("The service published \(model.total) in total.")

                case .blocked, .empty:
                    Card {
                        screenSubtitle(
                            "This page says nothing about anybody else. The service does not "
                                + "publish why a person is absent from it."
                        )
                    }

                case .unavailable(let error):
                    FailureNote(error, retry: onRetry)
                }

                if model.offersRetry {
                    PrimaryButton("Try again", action: onRetry)
                }
            }
            .padding(Space.md)
        }
        .frame(width: phoneWidth)
        .background(Ink.canvas)
    }
}

/// One card, as published.
///
/// Every field is the projection's. The photo ids are shown as a count and
/// ordered slots rather than as images, because `photoIds` carries identifiers
/// and no bytes: drawing a placeholder as though it were the person's photograph
/// would be inventing the thing the field is a reference to.
struct CandidateRow: View {
    let card: CandidateCard
    let offersLike: Bool
    let onLike: () -> Void

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: Space.sm) {
                HStack(alignment: .firstTextBaseline) {
                    Text(card.displayName)
                        .font(.system(size: 18, weight: .semibold))
                    Spacer(minLength: Space.sm)
                    Text("\(card.age)")
                        .font(.system(size: 15))
                        .foregroundStyle(.secondary)
                }

                if !card.bio.isEmpty {
                    Text(card.bio)
                        .font(.system(size: 15))
                        .fixedSize(horizontal: false, vertical: true)
                }

                HStack(alignment: .center, spacing: Space.xs) {
                    // `nil` rather than "nearby": the platform publishes no
                    // distance when it could not resolve one, and a screen that
                    // invented a proximity claim would be stating something
                    // nobody knows.
                    if let distance = card.distanceLabel {
                        ValueChip(distance)
                    } else {
                        ValueChip("Distance not resolved")
                    }
                    if !card.photoIds.isEmpty {
                        ValueChip("\(card.photoIds.count) photos")
                    }
                    if !card.genderIdentities.isEmpty {
                        ValueChip(card.genderIdentities.joined(separator: ", "))
                    }
                    Spacer(minLength: 0)
                }

                if offersLike {
                    PrimaryButton("Like") { onLike() }
                } else {
                    Text("Liking is not offered on your account right now.")
                        .font(.system(size: 13))
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}