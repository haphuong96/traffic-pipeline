/** Nearest-rank percentile of an already sorted array. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/** Counters for one reporting window (reset every 10 s by the caller). */
export class Metrics {
  requests = 0;
  readingsSent = 0; // readings inside requests, including retries
  queued = 0; // readings the API confirmed are in Kafka
  status200 = 0;
  status400 = 0;
  status5xx = 0;
  timeouts = 0;
  networkErrors = 0;
  latenciesMs: number[] = [];

  snapshot() {
    const sorted = [...this.latenciesMs].sort((a, b) => a - b);
    return {
      requests: this.requests,
      readingsSent: this.readingsSent,
      queued: this.queued,
      status200: this.status200,
      status400: this.status400,
      status5xx: this.status5xx,
      timeouts: this.timeouts,
      networkErrors: this.networkErrors,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
    };
  }

  reset() {
    Object.assign(this, new Metrics());
  }
}
