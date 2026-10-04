import { type DomainError, type Result, domainError, ok } from '@been-there/core';

/**
 * Signing *in* with Google, Apple or Meta: the two questions a returning member's
 * assertion raises, and the one it raises about an account with no password.
 *
 * It is a separate module from `social-authn.ts` because sign-up and sign-in
 * answer different questions and share no rule. What they share is the vocabulary
 * there and the schema behind both — the same `social_identities` table and the
 * same `account_credentials_method_shape` constraint.
 *
 * ## The whole of the anti-takeover argument
 *
 * `resolveSocialSignIn` is where an account takeover by email match would happen
 * if it could happen here, and it cannot because the function has no way to
 * express it. It receives the provider-subject lookup and the address lookup as
 * two separate arguments, and only the first can produce an account. There is no
 * branch where "the addresses agree" resolves to an account, because a provider
 * account can be bought, inherited or shared and an address on it can be
 * reassigned, while a member's own account cannot be.
 */

/** §6's copy for a password presented against an account that has none. */
export const NO_PASSWORD_CREDENTIAL_COPY = {
  title: 'This account signs in with a provider.',
  body: 'Continue with the provider you used when you joined, or set a password to use both.',
} as const;

/** §6's copy for an address that already has an account and no linked provider. */
export const SOCIAL_LINK_REQUIRED_COPY = {
  title: 'That address already has an account.',
  body: 'Sign in the way you joined, then link this provider from settings.',
} as const;

/**
 * The sign-in refusal for an account that has no password, and the hash for one
 * that does.
 *
 * Returning the hash rather than a `true` is what lets the caller pass a
 * `string | null` into `verifyPassword` without a `?? something` fallback — a
 * fallback there would be a fake hash to satisfy a type, which is the same
 * invented-credential mistake the nullable column exists to prevent.
 *
 * **`permission_denied`**, and the reason is that it is the code this platform
 * already uses for exactly this situation: `validateSession` in `authn.ts` gives
 * a revoked, a superseded and an expired session `permission_denied`, because the
 * caller's credential does not currently authenticate them. A password presented
 * against an account with none is the same fact — the credential held cannot
 * authenticate — arrived at from a different direction.
 *
 * The alternatives were rejected on their merits:
 *
 * - `not_found` would be a lie the client cannot act on. The account exists; the
 *   member is looking at a sign-in form for an account they created, and "no
 *   such account" sends them to register a duplicate.
 * - `validation_failed` blames the member's password. Their password may be
 *   perfectly good; it is simply not this account's credential, and a message
 *   that says otherwise teaches them to keep editing something that is not
 *   broken.
 * - `conflict` describes a disagreement between two requests, and there is only
 *   one here.
 *
 * `details.reason` is `'no_password_credential'` rather than the copy, so a
 * client renders §6's text and never has to match on a sentence.
 */
export function resolvePasswordCredential(credential: {
  readonly passwordHash: string | null;
}): Result<string, DomainError> {
  if (credential.passwordHash === null) {
    return domainError('permission_denied', 'platform.social', NO_PASSWORD_CREDENTIAL_COPY.body, {
      reason: 'no_password_credential',
      title: NO_PASSWORD_CREDENTIAL_COPY.title,
      action: 'continue_with_provider',
    });
  }
  return ok(credential.passwordHash);
}

/** What a verified assertion resolved to. */
export type SocialSignInResolution =
  | { readonly kind: 'existing_account'; readonly userId: string }
  | { readonly kind: 'new_account' };

/**
 * Resolves a verified provider assertion to an account.
 *
 * Two lookups arrive separately and stay separately: the provider-subject row the
 * member already holds, and the credential row carrying the attested address. Only
 * the first can produce an account. When the second exists and the first does not,
 * the answer is a refusal that names the remedy — sign in the original way and
 * link the provider from settings — because the alternative is an account takeover
 * by email match, and "the addresses agree" is not evidence that the person
 * holding this provider account is the person who registered that address.
 *
 * `'conflict'` rather than `'not_found'`: the request is well formed and the
 * provider did authenticate somebody, but it conflicts with an account that
 * already exists and may only be joined deliberately. `'permission_denied'` would
 * be wrong here for the mirror of the reason it is right above — this is not a
 * request the caller is barred from making, it is a step they have not taken yet.
 */
export function resolveSocialSignIn(resolved: {
  readonly linked: { readonly userId: string } | null;
  readonly contactExists: boolean;
}): Result<SocialSignInResolution, DomainError> {
  if (resolved.linked !== null) {
    return ok({ kind: 'existing_account', userId: resolved.linked.userId });
  }
  if (resolved.contactExists) {
    return domainError('conflict', 'platform.social', SOCIAL_LINK_REQUIRED_COPY.body, {
      reason: 'account_exists_requires_explicit_link',
      title: SOCIAL_LINK_REQUIRED_COPY.title,
      action: 'sign_in_then_link',
    });
  }
  return ok({ kind: 'new_account' });
}