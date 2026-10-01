/**
 * Consumer lag: how many messages are in Kafka but not yet committed by our
 * group, i.e. written to Kafka but not yet stored in Postgres.
 *
 * Computed from the broker's view (log end − committed offset) rather than
 * from what the client last fetched, so it keeps growing while the consumer
 * is stuck (e.g. Postgres down). That's exactly when you want to see it.
 */
export function computeLag(
  ends: { partition: number; high: string; low: string }[],
  committed: { partition: number; offset: string }[],
): number {
  const committedBy = new Map(committed.map((c) => [c.partition, BigInt(c.offset)]));
  let lag = 0n;
  for (const e of ends) {
    const c = committedBy.get(e.partition);
    // -1 / missing = nothing committed yet: everything still retained is pending.
    const from = c === undefined || c < 0n ? BigInt(e.low) : c;
    lag += BigInt(e.high) - from;
  }
  return Number(lag);
}
