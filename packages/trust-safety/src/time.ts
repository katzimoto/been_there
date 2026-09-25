/**
 * The package's only clock arithmetic. Every TTL, corroboration window and
 * decay clock in Trust & Safety is expressed against these two functions, so
 * "how long does a thing last" is answered in one place rather than by a
 * hand-rolled `24 * 60 * 60 * 1000` at each call site.
 *
 * Both take an explicit `Date`; nothing here reads the system clock, which is
 * what keeps the whole engine a pure function of (state, signals, now).
 */

/** Shared shift used for every friction TTL and every observation window. */
export function addHours(from: Date, hours: number): Date {
  return new Date(from.getTime() + hours * 60 * 60 * 1000);
}

/**
 * Whole days elapsed from `from` to `to`. The shared `riskMachine` guards on
 * `daysSinceLastSignal`, so a partial day never counts as a day of quiet.
 */
export function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
}
