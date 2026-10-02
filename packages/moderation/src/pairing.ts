import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The pairing token (issue #45).
 *
 * `interaction.unmatch_report` — the strongest pattern in the catalogue — needs
 * to know that an unmatch and a report describe **the same pair of accounts**.
 * The report leg could not supply that, for two independent reasons: it is
 * published at `restricted`, and its payload named no match, no conversation
 * and no counterparty. The first is a clearance decision and the second is a
 * missing fact, and only the second is fatal.
 *
 * The decision here is deliberately *not* to widen the clearance. A detector
 * that can read `moderation.report_submitted` can read who reported whom, and
 * that is the one fact a `restricted` class exists to withhold; handing it over
 * to a scoring engine also makes every future detector author a potential
 * privacy leak. So moderation publishes a second event, at `user`, carrying a
 * **join key and nothing else**: a keyed hash over the report, the match and
 * the reported account. Two parties that each hold one of the three facts can
 * agree on a match without either learning the other's.
 *
 * The three properties this shape is chosen for:
 *
 *  - **Not reversible.** Nothing in this file maps a token back to a match, a
 *    report or an account. Recovering the inputs from a token is a keyed-hash
 *    preimage, and the key never leaves the deployment.
 *  - **Not correlatable across deployments.** The key is per deployment, so the
 *    same report about the same match yields different tokens in two
 *    installations and a token copied between them joins nothing.
 *  - **Not reusable as a fingerprint.** `reportId` is inside the hash, so a
 *    subject reported repeatedly on one match does not accumulate one stable
 *    identifier. Each token answers one question about one pair.
 *
 * ## What this still leaks
 *
 * It is a join key, and a join key is not free. A holder of many tokens and a
 * small enough user population can still correlate: the same token appearing
 * twice is the same (report, match, subject) triple, and a moderator who can
 * enumerate a handful of candidate match ids learns which triple a token names
 * — that is what `createPairingMatcher` does, and it is why the secret is a
 * deployment secret rather than a public salt. Nothing here is a claim that the
 * join is free; it is a claim that the join does not require anybody to learn
 * an identity, which is a smaller and defensible thing.
 */

/** A per-deployment secret. Rotating it retires every token ever published. */
export interface PairingKey {
  readonly secret: string;
}

/**
 * The three facts a token is derived from. Plain strings, because a branded id
 * is a string with a compile-time name and the hash is over the bytes; the
 * producer casts at the call site and the consumer has no ids to cast.
 */
export interface PairingTriple {
  readonly reportId: string;
  readonly matchId: string;
  readonly subjectId: string;
}

/**
 * Domain separation, so a token is never equal to a hash of the same material
 * computed for any other purpose, and so rotating the derivation is a visible
 * change rather than a silent one.
 */
export const PAIRING_TOKEN_VERSION = 'rpt1';

/**
 * The token. A keyed hash — not a bare hash of the triple, which would be
 * enumerable by anyone who can guess a match id, and not a digest of the ids in
 * an order, which would be a canonical fingerprint of one account.
 */
export function pairingToken(key: PairingKey, triple: PairingTriple): string {
  const material = [triple.reportId, triple.matchId, triple.subjectId];
  if (key.secret.length === 0 || material.some((part) => part.length === 0)) {
    throw new Error('a pairing token needs a deployment secret and a report, a match and a subject');
  }
  // Length-prefixed rather than separator-joined. A separator is only
  // unambiguous for as long as no id can contain it, and these are opaque
  // platform ids that nothing here constrains: `(a, bc)` and `(ab, c)` frame to
  // the same bytes and would hash to the same token, which is a join that fires
  // on the wrong report.
  const framed = material.map((part) => `${part.length}:${part}`).join('|');
  return createHmac('sha256', key.secret)
    .update([PAIRING_TOKEN_VERSION, framed].join('|'))
    .digest('hex');
}

/**
 * The capability a detector is given instead of the derivation.
 *
 * The verifier is a port, not a hash: Trust & Safety never computes a token, so
 * there is no second copy of the derivation to drift out of step with this one.
 * The deployment builds this from its secret and hands it to the safety seam.
 */
export interface PairingMatcher {
  /**
   * True when `token` is the pairing token for `triple` under this deployment's
   * key. Constant time, so a detector that probes a run of candidate match ids
   * cannot learn the token one comparison at a time.
   */
  matches(token: string, triple: PairingTriple): boolean;
}

export function createPairingMatcher(key: PairingKey): PairingMatcher {
  return {
    matches(token: string, triple: PairingTriple): boolean {
      const expected = Buffer.from(pairingToken(key, triple), 'hex');
      // A malformed token decodes to fewer bytes, which the length check below
      // rejects — `timingSafeEqual` throws on a length mismatch, and a throw
      // inside a detector is a refused cycle rather than a `false`.
      const given = Buffer.from(token, 'hex');
      return given.length === expected.length && timingSafeEqual(given, expected);
    },
  };
}
