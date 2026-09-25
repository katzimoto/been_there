import { type DomainError, type PhotoId, type Result, type UserId, ok } from '@been-there/core';
import type { Page } from '@been-there/contracts';
import {
  type CandidateCardProjection,
  DATING_READ_MODEL_VERSION,
  type DistanceBand,
  type SubjectStandingProjection,
  evaluateEligibility,
} from '@been-there/dating';
import { MISSING_FIELD, NOT_FOUND } from '../http/failure.js';
import { okResponse, route, type Route } from '../http/router.js';
import type { ServiceDependencies } from '../ports.js';
import { relationshipFor } from '../wiring/dating.js';
import { type SubjectStanding, subjectStandingFor } from '../wiring/standing.js';

/**
 * Discovery.
 *
 * ## Every decision here belongs to `evaluateEligibility`
 *
 * This route reads standing projections, asks the dating domain one question per
 * candidate, and renders the answers. It contains no rule of its own: not
 * "verified only", not "not blocked", not "profile complete", not a gender or
 * age filter. All of those are rows in `ELIGIBILITY_RULES`, in the domain's
 * priority order, so a new disqualifying condition is one entry there rather
 * than another `if` in a query builder, and "why was this person not shown?" has
 * one answer per request instead of one per code path.
 *
 * A candidate that fails is *not* reported with its reason. The reasons are
 * `internal` by the domain's own design, and a reason a client could read would
 * be a side channel for inferring another user's identity state, standing or
 * block — which is the leak the whole gate exists to prevent.
 *
 * ## The candidate set is the population
 *
 * `UserStore.listCandidateIds` pages the candidates; the service never accepts a
 * list of ids from the request. A candidate set the client chose is a filtered
 * list wearing a page's name — it would look like discovery while being a
 * lookup, and the eligibility work would never be exercised over the population.
 *
 * ## Distance is `unknown`, and that is honest
 *
 * A `DiscoverySnapshot` needs the separation between two people. There is no
 * location anchor table and no coordinate anywhere in the schema — a profile
 * stores a coarse `DistanceBand`, and a band is not a point — so the separation
 * cannot be computed and `null` is passed.
 *
 * `null` is not a shrug. The dating domain reads it as `unknown` deliberately:
 * `isWithinDistanceLimit` returns true for `unknown` because the platform could
 * not prove distance and the product must not punish an unproven fact, and
 * `areMutuallyCompatible`'s distance test is skipped for `null` for the same
 * reason. So the distance rules are evaluated in their documented no-answer
 * branch. Inventing a band here would have been the service quietly answering a
 * question only the platform can answer, and it would have filtered real people
 * out of a page on a number nobody computed.
 */

/** The band a card carries when the platform could not resolve a separation. */
const UNRESOLVED_BAND: DistanceBand = 'unknown';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export function discoveryRoutes(dependencies: ServiceDependencies): readonly Route[] {
  return [
    route('GET', '/v1/discovery', async (request) => {
      const viewerId = request.actor.userId;
      if (viewerId === null) {
        return MISSING_FIELD('userId');
      }
      const page = pageOf(request.query);
      if (!page.ok) {
        return page;
      }
      const candidateIds = await dependencies.stores.users.listCandidateIds(page.value, request.tx);
      const viewer = await subjectStandingFor(dependencies.stores, viewerId, request.now, request.tx);
      if (viewer === null) {
        return NOT_FOUND('account');
      }

      const candidates = new Map<UserId, SubjectStanding>();
      for (const candidateId of candidateIds) {
        if (candidateId === viewerId) {
          continue;
        }
        const standing = await subjectStandingFor(
          dependencies.stores,
          candidateId,
          request.now,
          request.tx,
        );
        if (standing !== null) {
          candidates.set(candidateId, standing);
        }
      }

      const cards: CandidateCardProjection[] = [];
      for (const [candidateId, candidate] of candidates) {
        const relationship = await relationshipFor(
          dependencies.stores,
          viewerId,
          candidateId,
          standingOf(viewerId, viewer, candidates),
          request.tx,
        );
        const decision = evaluateEligibility({
          viewer: viewer.standing,
          candidate: candidate.standing,
          relationship,
          distance: null,
          now: request.now,
        });
        if (!decision.eligible) {
          continue;
        }
        const card = cardFor(candidateId, candidate);
        if (card !== null) {
          cards.push(card);
        }
      }
      return okResponse(200, {
        viewerId,
        projectionVersion: DATING_READ_MODEL_VERSION,
        candidates: cards,
        total: cards.length,
      });
    }),
  ];
}

/**
 * The `StandingLookup` the domain assembles relationships with.
 *
 * `relationshipView` calls back for both participants, so both have to resolve
 * or it throws rather than degrading. The viewer's own standing is supplied here
 * because `listCandidateIds` never returns the viewer — the `self_view` rule
 * would catch it anyway, but the lookup is asked for the viewer first and a
 * missing entry would be a crash instead of a filter.
 */
function standingOf(
  viewerId: UserId,
  viewer: SubjectStanding,
  candidates: Map<UserId, SubjectStanding>,
): (user: UserId) => SubjectStandingProjection | null {
  return (user: UserId) => {
    if (user === viewerId) {
      return viewer.standing;
    }
    return candidates.get(user)?.standing ?? null;
  };
}

function pageOf(query: URLSearchParams): Result<Page, DomainError> {
  const limitRaw = query.get('limit');
  const offsetRaw = query.get('offset');
  const limit = limitRaw === null ? DEFAULT_LIMIT : Number(limitRaw);
  const offset = offsetRaw === null ? 0 : Number(offsetRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return MISSING_FIELD('limit');
  }
  if (!Number.isInteger(offset) || offset < 0) {
    return MISSING_FIELD('offset');
  }
  return ok({ limit, offset });
}

/**
 * The card a candidate is rendered as, from the *candidate's own* content.
 *
 * `null` when the content cannot produce one. A profile the gate accepted is
 * `complete`, and a complete profile always has a display name and a derived
 * age, so a `null` here means the row disagrees with the state the gate just
 * accepted — dropping the card is the right answer, and inventing a placeholder
 * would put a blank card in front of a person.
 */
function cardFor(candidateId: UserId, candidate: SubjectStanding): CandidateCardProjection | null {
  const age = candidate.standing.profile.age;
  if (age === null) {
    return null;
  }
  return {
    projectionVersion: DATING_READ_MODEL_VERSION,
    userId: candidateId,
    displayName: candidate.content.displayName,
    age,
    genderIdentities: candidate.standing.profile.genderIdentities,
    bio: candidate.content.bio,
    photoIds: candidate.content.photos
      .filter((photo) => photo.approval === 'approved')
      .map((photo) => photo.photoId as PhotoId),
    distance: UNRESOLVED_BAND,
  };
}
