import { type DomainError, type Result, domainError, ok } from '@been-there/core';

/**
 * The currently published terms, and what happens when a client is behind them.
 *
 * A single constant rather than a table, because a version is not a choice the
 * service makes per request: it is a fact about the product, and the only two
 * answers to "which version is live" are "this one" and "the one the client
 * thinks". Publishing it in a second place would create a third.
 *
 * The comparison is on the version the *client* says it displayed, not on a
 * timestamp. A client that has never shown any terms sends nothing and is
 * refused here rather than being let through on a default, because a default
 * acceptance is an acceptance nobody was asked for.
 */
export const CURRENT_TERMS_VERSION = '2026-09-01';

/** §9's row for a terms version that changed under the user. */
export const TERMS_CHANGED_COPY = {
  title: "We've updated our terms.",
  body: 'Have a read, then accept to continue.',
} as const;

/**
 * Whether an acceptance is current.
 *
 * A refusal, not a boolean, because the caller has to render the copy and the
 * refusal is what carries it. An account whose accepted version is older is not
 * broken and not suspended: it is one version behind, and the only remedy is to
 * read and accept.
 */
export function evaluateTermsAcceptance(accepted: string): Result<true, DomainError> {
  if (accepted === CURRENT_TERMS_VERSION) {
    return ok(true);
  }
  return domainError('validation_failed', 'service.accounts', TERMS_CHANGED_COPY.body, {
    field: 'terms',
    title: TERMS_CHANGED_COPY.title,
    action: 'read_accept',
    current_version: CURRENT_TERMS_VERSION,
  });
}
