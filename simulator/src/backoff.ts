const BASE_MS = 1_000;
const MAX_MS = 60_000;

/**
 * Exponential backoff with "full jitter": a random delay between 0 and
 * min(60 s, 1 s × 2^(attempt-1)).
 *
 * The jitter matters: if the API restarts, thousands of devices fail at the
 * same moment. Without jitter they would all retry at the same moment too,
 * and knock it over again (the "thundering herd").
 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(MAX_MS, BASE_MS * 2 ** (attempt - 1));
  return Math.round(random() * ceiling);
}
