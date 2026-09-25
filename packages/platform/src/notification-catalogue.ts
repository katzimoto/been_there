/**
 * The three channels a notification travels.
 *
 * `sms` is deliberately absent. A phone number is personal data the account does
 * not have to disclose in order to receive product mail, and a safety notice
 * that arrives by SMS is a notice a shared or coercive device can see. The
 * recovery *flow* may still use an SMS one-time code — that is a credential
 * channel (`RecoveryMethod` in `authn.ts`), and the two are not
 * interchangeable: nobody is ever notified by the channel they authenticate
 * with.
 */
export type NotificationChannel = 'in_app' | 'email' | 'push';

export const NOTIFICATION_CHANNELS: readonly NotificationChannel[] = ['in_app', 'email', 'push'];

/**
 * How a kind uses one channel.
 *
 * - `immediate` — sent as soon as it is planned, or at the end of quiet hours.
 * - `digest` — accumulated and released at the next digest window.
 * - `opt_in` — the channel exists for this kind, but the recipient has to switch
 *   it on. A like push is the case: nobody wants it by default, and a structural
 *   ban would mean the setting could never exist.
 * - `off` — this kind never uses this channel, so a request for it is a
 *   misrouted request rather than a preference.
 */
export type DeliveryMode = 'immediate' | 'digest' | 'opt_in' | 'off';

export interface ChannelUse {
  readonly mode: DeliveryMode;
  /** The facts a body on this channel may bind. See `NotificationContentToken`. */
  readonly content: readonly NotificationContentToken[];
}

/**
 * The only facts a notification body may bind.
 *
 * There is no message-text token, and that absence is the guarantee: a template
 * cannot render a message body because the vocabulary it binds against has no
 * word for one. The list is per channel rather than per kind because the same
 * fact is not equally safe to say everywhere — a case reference belongs in the
 * in-app record and in the email the user will quote to support, and not on a
 * lock screen that may not be the user's own.
 */
export type NotificationContentToken =
  | 'counterparty_first_name'
  | 'own_capability_list'
  | 'case_reference'
  | 'report_reference'
  | 'event_date'
  | 'retained_until'
  | 'retry_at'
  | 'coarse_city'
  | 'device_label'
  | 'appeal_route'
  | 'count';

export interface NotificationKindSpec {
  readonly category: NotificationCategory;
  /**
   * A critical notice cannot be switched off, muted, or deferred. Failing to
   * deliver it can leave a user misinformed about their own safety, their own
   * account standing, or their own ability to use the product.
   */
  readonly critical: boolean;
  /** True when the notice is about one specific other person. */
  readonly pairScoped: boolean;
  readonly channels: Readonly<Record<NotificationChannel, ChannelUse>>;
  /** Required when any channel is `digest`; the window the digest rides on. */
  readonly digest?: { readonly cadence: 'hourly' | 'weekly' };
}

/**
 * The catalogue. `NotificationKind` is the stable identifier a notification is
 * requested by, and this table is the whole of what Platform knows about
 * notification content: the class, the channels, and the bindable facts per
 * channel. A kind that is not a row here does not exist, which is why the
 * reviewable claim — "a notification's content is reviewable" — is a property of
 * the type rather than of a reviewer's memory.
 *
 * Transcribed from `docs/features/notifications.md` §3. The places that document
 * and this table disagree are resolved here and corrected there: a like sends no
 * email, the message digest is email-only, a ban is email-only because a banned
 * account has no product surface to read, and a push never carries a case
 * reference.
 */
export const NOTIFICATION_KINDS = {
  'match.created': {
    category: 'match',
    critical: false,
    pairScoped: true,
    channels: {
      in_app: { mode: 'immediate', content: ['counterparty_first_name'] },
      email: { mode: 'digest', content: ['counterparty_first_name'] },
      push: { mode: 'immediate', content: ['counterparty_first_name'] },
    },
    digest: { cadence: 'hourly' },
  },
  'message.received': {
    category: 'message',
    critical: false,
    pairScoped: true,
    channels: {
      in_app: { mode: 'immediate', content: ['counterparty_first_name'] },
      email: { mode: 'digest', content: ['counterparty_first_name'] },
      push: { mode: 'immediate', content: ['counterparty_first_name'] },
    },
    digest: { cadence: 'hourly' },
  },
  'message.digest': {
    category: 'message',
    critical: false,
    pairScoped: true,
    // The per-message in-app entry is `message.received`; a second in-app entry
    // per digest window would say the same thing twice.
    channels: {
      in_app: { mode: 'off', content: [] },
      email: { mode: 'digest', content: ['counterparty_first_name', 'count'] },
      push: { mode: 'off', content: [] },
    },
    digest: { cadence: 'hourly' },
  },
  'like.received': {
    category: 'like',
    critical: false,
    pairScoped: true,
    channels: {
      in_app: { mode: 'immediate', content: [] },
      email: { mode: 'off', content: [] },
      push: { mode: 'opt_in', content: [] },
    },
  },
  'verification.passed': {
    category: 'verification',
    critical: true,
    pairScoped: false,
    channels: {
      in_app: { mode: 'immediate', content: [] },
      email: { mode: 'immediate', content: [] },
      push: { mode: 'immediate', content: [] },
    },
  },
  'verification.failed': {
    category: 'verification',
    critical: true,
    pairScoped: false,
    channels: {
      in_app: { mode: 'immediate', content: [] },
      email: { mode: 'immediate', content: [] },
      push: { mode: 'immediate', content: [] },
    },
  },
  'verification.rate_limited': {
    // A user who is being refused a retake and not told why will read the
    // refusal as a bug, or as being banned — and a rate-limit notice the user
    // could switch off is a notice whose absence produces exactly that. It is
    // critical for the same reason `verification.failed` is: it is about their
    // own ability to use the product.
    category: 'verification',
    critical: true,
    pairScoped: false,
    channels: {
      in_app: { mode: 'immediate', content: ['retry_at'] },
      email: { mode: 'immediate', content: ['retry_at'] },
      push: { mode: 'immediate', content: [] },
    },
  },
  'verification.review_required': {
    category: 'verification',
    critical: true,
    pairScoped: false,
    channels: {
      in_app: { mode: 'immediate', content: [] },
      email: { mode: 'immediate', content: [] },
      push: { mode: 'immediate', content: [] },
    },
  },
  'verification.expired': {
    category: 'verification',
    critical: true,
    pairScoped: false,
    channels: {
      in_app: { mode: 'immediate', content: [] },
      email: { mode: 'immediate', content: [] },
      push: { mode: 'immediate', content: [] },
    },
  },
  'account.restriction.applied': {
    category: 'account',
    critical: true,
    pairScoped: false,
    channels: {
      in_app: { mode: 'immediate', content: ['own_capability_list', 'case_reference', 'event_date', 'appeal_route'] },
      // The email is the one the user quotes back to support, so it carries the
      // reference. The push does not: it is rendered on a device that may not be
      // the user's own, which is the same reason it carries no distance band.
      email: { mode: 'immediate', content: ['own_capability_list', 'case_reference', 'event_date', 'appeal_route'] },
      push: { mode: 'immediate', content: [] },
    },
  },
  'account.suspended': {
    category: 'account',
    critical: true,
    pairScoped: false,
    channels: {
      in_app: { mode: 'immediate', content: ['case_reference', 'event_date', 'appeal_route'] },
      email: { mode: 'immediate', content: ['case_reference', 'event_date', 'appeal_route'] },
      push: { mode: 'immediate', content: [] },
    },
  },
  'account.banned': {
    category: 'account',
    critical: true,
    pairScoped: false,
    // A banned account has no product surface, so in-app is unreachable and a
    // push token is not ours to use. Email is the delivery guarantee, and the
    // notice is dismissed through the appeal route rather than a product read.
    channels: {
      in_app: { mode: 'off', content: [] },
      email: { mode: 'immediate', content: ['case_reference', 'event_date', 'appeal_route'] },
      push: { mode: 'off', content: [] },
    },
  },
  'account.reinstated': {
    category: 'account',
    critical: true,
    pairScoped: false,
    channels: {
      in_app: { mode: 'immediate', content: ['own_capability_list', 'event_date'] },
      email: { mode: 'immediate', content: ['own_capability_list', 'event_date'] },
      push: { mode: 'immediate', content: [] },
    },
  },
  'moderation.warning_issued': {
    category: 'safety',
    critical: true,
    pairScoped: false,
    channels: {
      in_app: { mode: 'immediate', content: ['case_reference'] },
      // The behaviour summary is a reviewed string, not a bound fact: it is the
      // moderator's own words and the whole point of the notice.
      email: { mode: 'immediate', content: ['case_reference'] },
      push: { mode: 'immediate', content: [] },
    },
  },
  'appeal.resolved': {
    category: 'safety',
    critical: true,
    pairScoped: false,
    channels: {
      in_app: { mode: 'immediate', content: ['case_reference', 'event_date'] },
      email: { mode: 'immediate', content: ['case_reference', 'event_date'] },
      push: { mode: 'immediate', content: [] },
    },
  },
  'report.received': {
    category: 'safety',
    critical: false,
    pairScoped: false,
    channels: {
      in_app: { mode: 'immediate', content: ['report_reference'] },
      email: { mode: 'immediate', content: ['report_reference'] },
      push: { mode: 'off', content: [] },
    },
  },
  'match.ended_by_other': {
    category: 'match',
    critical: false,
    pairScoped: true,
    channels: {
      in_app: { mode: 'immediate', content: [] },
      email: { mode: 'digest', content: [] },
      push: { mode: 'immediate', content: [] },
    },
    digest: { cadence: 'hourly' },
  },
  'login.new_device': {
    category: 'account',
    critical: true,
    pairScoped: false,
    channels: {
      in_app: { mode: 'immediate', content: ['device_label', 'coarse_city', 'event_date'] },
      email: { mode: 'immediate', content: ['device_label', 'coarse_city', 'event_date'] },
      push: { mode: 'immediate', content: ['device_label', 'coarse_city'] },
    },
  },
  'account.recovery': {
    category: 'account',
    critical: true,
    pairScoped: false,
    channels: {
      in_app: { mode: 'off', content: [] },
      email: { mode: 'immediate', content: ['event_date'] },
      push: { mode: 'off', content: [] },
    },
  },
  'account.deletion_completed': {
    category: 'account',
    critical: true,
    pairScoped: false,
    channels: {
      in_app: { mode: 'off', content: [] },
      email: { mode: 'immediate', content: ['event_date', 'retained_until'] },
      push: { mode: 'off', content: [] },
    },
  },
  'discovery.weekly_digest': {
    category: 'system',
    critical: false,
    pairScoped: false,
    channels: {
      in_app: { mode: 'immediate', content: ['count'] },
      email: { mode: 'digest', content: ['count'] },
      push: { mode: 'off', content: [] },
    },
    digest: { cadence: 'weekly' },
  },
} as const satisfies Readonly<Record<string, NotificationKindSpec>>;

export type NotificationKind = keyof typeof NOTIFICATION_KINDS;

/**
 * The routing and opt-in grouping. Declared here rather than derived from the
 * catalogue, because the catalogue's own type mentions it; the compiler checks
 * that every kind files under one of these, and the test suite checks that every
 * one of these has at least one kind — so neither list can drift alone.
 */
export type NotificationCategory = 'safety' | 'account' | 'verification' | 'like' | 'match' | 'message' | 'system';
