import type { NotificationChannel, NotificationKind } from './notification-catalogue.js';

/**
 * Copy for the account-security notices.
 *
 * It lives beside the catalogue rather than in a product surface for the same
 * reason the catalogue does: a notice body is reviewed as a string, and the
 * string that is reviewed should be the string that reaches the bytes. The
 * `{{token}}` placeholders are the renderer's slots, so every fact a body binds
 * is one `NOTIFICATION_KINDS` already declared for that kind *on that channel* —
 * which is why the copy is keyed by channel as well as by kind: the push for
 * `account.recovery_completed` may say how many sessions died and the email may
 * also say when, and a single body string could not satisfy both.
 *
 * The four kinds, and why each exists:
 *
 *  - `account.recovery` is the *request*: the reset link, sent to the channel
 *    being authenticated before anybody has proved anything. Its wording is
 *    fixed by §7.1 — identical whether or not the account exists.
 *  - `account.recovery_completed` is the *fact*: recovery succeeded and these
 *    many sessions died. §7.1 step 5 requires it, and a reset that is silent is
 *    a reset the owner cannot learn from.
 *  - `account.signed_out_all_devices` is §6.1's "all devices" notice, sent on
 *    success and always — including when the request came from a compromised
 *    session, because the owner is the person who needs to know.
 *  - `account.recovery_paused` is the abuse threshold from §7.2. It is safe to
 *    send: it discloses nothing the person issuing the requests does not already
 *    know, and it only ever goes to the verified channel.
 */
export interface NotificationCopy {
  /** The subject line on email, the title on push and in-app. */
  readonly title: string;
  readonly body: string;
}

export type AccountSecurityKind =
  | 'account.recovery'
  | 'account.recovery_completed'
  | 'account.signed_out_all_devices'
  | 'account.recovery_paused';

export const ACCOUNT_SECURITY_COPY: Readonly<
  Record<AccountSecurityKind, Readonly<Partial<Record<NotificationChannel, NotificationCopy>>>>
> = {
  'account.recovery': {
    email: {
      title: 'Reset your Been There password',
      body: 'We received a request to reset your password. If it was you, use the link below. The link expires 30 minutes after {{event_date}}.',
    },
  },
  'account.recovery_completed': {
    in_app: {
      title: 'Your password was reset',
      body: 'Your password was reset on {{event_date}} and {{count}} signed-in devices were signed out.',
    },
    email: {
      title: 'Your Been There password was reset',
      body: 'Your password was reset on {{event_date}} and {{count}} signed-in devices were signed out. If this was not you, secure your account now.',
    },
    push: {
      title: 'Your password was reset',
      body: 'Your password was reset and {{count}} devices were signed out.',
    },
  },
  'account.signed_out_all_devices': {
    in_app: {
      title: 'Signed out on all devices',
      body: 'We signed you out everywhere on {{event_date}}. {{count}} sessions were ended.',
    },
    email: {
      title: 'We signed you out everywhere',
      body: 'We signed you out on all devices. If this wasn\'t you, secure your account now. {{count}} sessions were ended on {{event_date}}.',
    },
    push: {
      title: 'Signed out on all devices',
      body: '{{count}} sessions were ended. If this wasn\'t you, secure your account now.',
    },
  },
  'account.recovery_paused': {
    in_app: {
      title: 'We paused sign-in recovery',
      body: 'We paused sign-in recovery on {{event_date}} after repeated attempts. Your account is fine and nothing was changed.',
    },
    email: {
      title: 'We paused sign-in recovery on your account',
      body: 'We paused sign-in recovery on your account after repeated attempts. Your account is fine and nothing was changed. You can restore recovery immediately by signing in on a device you\'re already logged in on.',
    },
  },
};

/**
 * The kinds above, for a caller that iterates. Exported as a list rather than
 * left as `Object.keys` so that the vocabulary is a value the type system can
 * check against the catalogue: a kind in this file that the catalogue does not
 * declare is a compile error at the point of use, not a notice nobody can plan.
 */
export const ACCOUNT_SECURITY_KINDS: readonly AccountSecurityKind[] = [
  'account.recovery',
  'account.recovery_completed',
  'account.signed_out_all_devices',
  'account.recovery_paused',
] satisfies readonly NotificationKind[];
