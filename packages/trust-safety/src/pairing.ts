/**
 * The pairing port (issue #45).
 *
 * `interaction.unmatch_report` needs to know that an unmatch and a report
 * describe the same pair of accounts. It is not allowed to read
 * `moderation.report_submitted` — that event is `restricted` and exists so that
 * nobody outside a moderator role learns who reported whom — so the producer
 * publishes a keyed join token on a second event instead, and this detector
 * joins on the token.
 *
 * What this module deliberately does **not** contain is the derivation. A
 * detector compares two strings; it never hashes anything. Moderation owns the
 * token because moderation is the only party that holds all three of its
 * inputs, and it hands this seam a matcher built from the deployment secret.
 * That is the whole reason there is one copy of the derivation: a second
 * implementation in this package would be free to drift out of step, and the
 * symptom of drift would be a detector that silently never fires.
 *
 * The residual is stated where the token is built, in
 * `packages/moderation/src/pairing.ts`. It is a join key, not an identity, and
 * it is not free.
 */

/**
 * The three facts a token is derived from, offered back to the matcher as a
 * candidate. Plain strings: a branded id is a string with a compile-time name,
 * and this side has no ids to cast.
 */
export interface PairingTriple {
  readonly reportId: string;
  readonly matchId: string;
  readonly subjectId: string;
}

/**
 * The capability, and the only way a detector can learn that two facts describe
 * one pair. It answers one question and returns no data: a detector that could
 * ask "and who was it?" would be a detector holding the derivation.
 */
export interface PairingMatcher {
  matches(token: string, triple: PairingTriple): boolean;
}
