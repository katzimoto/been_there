import { type DomainError, type Err, type Result, domainError, ok } from '@been-there/core';

/**
 * The age gate and the age band.
 *
 * Both live here rather than in a product surface because both are Platform's:
 * Platform stores the date of birth and computes the age from it, and Platform
 * decides how coarse the public form of that age is. A feature that asked a user
 * "how old are you" and got an answer would be a gate that accepts a promise,
 * and a promise is not a gate — so the only input this module takes is a
 * calendar date, and the only input it produces is a refusal or a band.
 *
 * Three facts about the shape of the answer, all of them load-bearing:
 *
 *  - The age is **derived at read time**, from the stored date and the caller's
 *    `now`. Nothing here is persisted, because a persisted age is a number that
 *    was true once and a band that moves when its owner has a birthday.
 *  - The band is five years wide and floored at 18 (§4.4). A narrower band
 *    shrinks the anonymity set sharply; a wider one makes the 18+ boundary blur
 *    and makes conversation awkward.
 *  - The band's **label** is a phrase and the band's bounds are a separate
 *    thing. §4.4 forbids printing both in one surface, so `ageBandLabel` is the
 *    only rendering this module offers and the band key is not a label.
 */

/** The adult floor. A market with a different floor needs a different gate. */
export const ADULT_MINIMUM_AGE = 18;

/**
 * Band width, in years. §4.4 argues for five specifically: coarse enough that a
 * stated age is not a correlatable identifier, narrow enough that an age filter
 * and a first conversation stay meaningful, and stable because five divides
 * evenly through the ranges people actually use about themselves.
 */
export const AGE_BAND_WIDTH = 5;

/** The public form of an age. Never an age, never a date, never a band bound. */
export type AgeBand =
  | '18-22'
  | '23-27'
  | '28-32'
  | '33-37'
  | '38-42'
  | '43-47'
  | '48-52'
  | '53-57'
  | '58+';

export interface AgeBandDefinition {
  readonly band: AgeBand;
  readonly minAge: number;
  /** `null` for the open-ended top band; nothing above it is out of range. */
  readonly maxAge: number | null;
  /**
   * The phrase a client may render. Not the band key: the key is the bounds, and
   * §4.4 forbids the bounds and the phrase in the same surface.
   */
  readonly label: string;
}

export const AGE_BANDS: readonly AgeBandDefinition[] = [
  { band: '18-22', minAge: 18, maxAge: 22, label: 'early 20s' },
  { band: '23-27', minAge: 23, maxAge: 27, label: 'late 20s' },
  { band: '28-32', minAge: 28, maxAge: 32, label: 'early 30s' },
  { band: '33-37', minAge: 33, maxAge: 37, label: 'late 30s' },
  { band: '38-42', minAge: 38, maxAge: 42, label: 'early 40s' },
  { band: '43-47', minAge: 43, maxAge: 47, label: 'late 40s' },
  { band: '48-52', minAge: 48, maxAge: 52, label: 'early 50s' },
  { band: '53-57', minAge: 53, maxAge: 57, label: 'late 50s' },
  { band: '58+', minAge: 58, maxAge: null, label: '60s and over' },
];

/** The coarse marker the funnel counts a refused sign-up with. Never a date. */
export const UNDER_18_MARKER = 'under_18';

export interface AgeGateCopy {
  readonly title: string;
  readonly body: string;
  /** What the user can do about it. §9: no copy ends without an action. */
  readonly action: 'leave' | 'edit';
}

/**
 * The two refusals the age gate can produce, verbatim from the failure table.
 * They live beside the rule because a refusal whose copy drifts from its rule is
 * a refusal nobody can act on, and §9 says a failure a user cannot act on is a
 * defect.
 */
export const AGE_GATE_COPY = {
  under18: {
    title: "We can't create an account for you yet.",
    body: 'Been There is for adults 18 and over. Please come back when you are 18. We haven\'t created an account or sent any email.',
    action: 'leave',
  },
  impossibleDate: {
    title: "That date doesn't look right.",
    body: 'Check it and try again.',
    action: 'edit',
  },
} as const satisfies Readonly<Record<string, AgeGateCopy>>;

/** What the user is told before they are asked, so the question is not a surprise. */
export const AGE_GATE_NOTICE = {
  title: 'Been There is 18+.',
  body: 'We ask for your date of birth so we can keep the community adults-only. Your date of birth is never shown to anyone. Other members see only your age range — something like "late 20s" — never a number and never an exact age.',
} as const;

/** A calendar date, split. There is no `age` field in this module's input type. */
export interface DateOfBirth {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parses `YYYY-MM-DD` into a real calendar date.
 *
 * The round trip through `Date.UTC` is the whole check: it rejects 31 February
 * and 29 February in a common year, which a regex cannot, and it rejects a day
 * that JavaScript would silently roll into the next month. A future date is a
 * separate refusal from an impossible one, because the copy differs.
 */
export function readDateOfBirth(value: string, now: Date): Result<DateOfBirth, DomainError> {
  const match = ISO_DATE.exec(value);
  if (match === null) {
    return IMPOSSIBLE_DATE;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  const real =
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day;
  if (!real) {
    return IMPOSSIBLE_DATE;
  }
  if (parsed.getTime() >= Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) {
    return domainError('not_eligible', 'platform.age', 'a date of birth may not be today or later', {
      field: 'dateOfBirth',
      reason: 'in_future',
    });
  }
  return ok({ year, month, day });
}

/**
 * The impossible-date refusal, built once. A constant rather than a function
 * because it carries no input: every caller that cannot read a calendar date
 * gets this exact answer, with this exact copy.
 */
const IMPOSSIBLE_DATE: Err<DomainError> = domainError(
  'validation_failed',
  'platform.age',
  AGE_GATE_COPY.impossibleDate.body,
  {
    field: 'dateOfBirth',
    title: AGE_GATE_COPY.impossibleDate.title,
    action: AGE_GATE_COPY.impossibleDate.action,
  },
);

/**
 * Age in whole years at `now`, from a calendar date. UTC throughout: a birthday
 * is a date, not an instant, and a gate that moves with the operator's timezone
 * is a gate two people can disagree about.
 */
export function ageOn(dateOfBirth: DateOfBirth, now: Date): number {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const born = Date.UTC(dateOfBirth.year, dateOfBirth.month - 1, dateOfBirth.day);
  let age = now.getUTCFullYear() - dateOfBirth.year;
  const birthdayThisYear = Date.UTC(
    now.getUTCFullYear(),
    dateOfBirth.month - 1,
    dateOfBirth.day,
  );
  if (today < birthdayThisYear) {
    age -= 1;
  }
  if (age < 0 || born > today) {
    return 0;
  }
  return age;
}

/** The band an age falls in. An age below the floor has no band and says so. */
export function ageBandFor(ageYears: number): AgeBand | null {
  const definition = AGE_BANDS.find(
    (candidate) => ageYears >= candidate.minAge && (candidate.maxAge === null || ageYears <= candidate.maxAge),
  );
  return definition?.band ?? null;
}

/** The only rendering of a band a client may show. */
export function ageBandLabel(band: AgeBand): string {
  const definition = AGE_BANDS.find((candidate) => candidate.band === band);
  if (definition === undefined) {
    throw new Error(`age band ${band} is not in AGE_BANDS; the vocabulary and the bands disagree`);
  }
  return definition.label;
}

export interface AgeGateOutcome {
  /** Derived, never persisted, and never rendered — §4.3 makes it `user`. */
  readonly ageYears: number;
  readonly ageBand: AgeBand;
}

/**
 * The gate itself.
 *
 * The refusal is `not_eligible` rather than `validation_failed` because it is an
 * eligibility answer, not a malformed request: the date is real, the request is
 * well formed, and the account is simply not one this product may create. The
 * caller turns that into "no account row, no email, no provider call" — the
 * consequences §4.2 lists, which are the caller's to honour because only the
 * caller knows what it was about to do.
 */
export function evaluateAgeGate(dateOfBirth: DateOfBirth, now: Date): Result<AgeGateOutcome, DomainError> {
  const ageYears = ageOn(dateOfBirth, now);
  if (ageYears < ADULT_MINIMUM_AGE) {
    return domainError('not_eligible', 'platform.age', AGE_GATE_COPY.under18.body, {
      reason: UNDER_18_MARKER,
      title: AGE_GATE_COPY.under18.title,
      action: AGE_GATE_COPY.under18.action,
    });
  }
  const ageBand = ageBandFor(ageYears);
  if (ageBand === null) {
    // Unreachable for any age the gate admits, and a loud failure is the right
    // answer: an age above 120 that passed the floor is a corrupt date, not a
    // band this module forgot to write down.
    throw new Error(`age ${ageYears} passed the adult floor but has no band; AGE_BANDS is incomplete`);
  }
  return ok({ ageYears, ageBand });
}
