/**
 * The next interval boundary strictly after `nowMs`.
 *
 * Boundaries are multiples of the interval since the Unix epoch, which starts
 * on a whole minute, so 15 s boundaries land on :00/:15/:30/:45 and 60 s
 * boundaries on :00. That is exactly the alignment the API checks.
 */
export function nextBoundary(nowMs: number, intervalSeconds: number): number {
  const intervalMs = intervalSeconds * 1000;
  return (Math.floor(nowMs / intervalMs) + 1) * intervalMs;
}

/** "2026-09-30T11:00:45Z" (no milliseconds; they are always 0 here). */
export function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}
