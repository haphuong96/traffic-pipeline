/**
 * Delay before database retry number `attempt`: full jitter, 1 s doubling,
 * capped at 5 s. The cap is low on purpose: there is one consumer making one
 * connection attempt, so there's no herd to spread out, and a high cap would
 * just add up to that much idle time after Postgres comes back.
 */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  return Math.round(random() * Math.min(5_000, 1000 * 2 ** (attempt - 1)));
}
