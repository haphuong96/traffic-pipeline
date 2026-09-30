import { backoffDelay } from './backoff.ts';
import type { ReadingPayload, SendResult } from './http.ts';
import type { Metrics } from './metrics.ts';
import { isoSeconds, nextBoundary } from './time.ts';
import { vehicleCount } from './traffic.ts';

export const MAX_BATCH = 500;

/** Timers and time, injectable so tests can run hours in milliseconds. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): void;
}

/** What the device needs to know from a send attempt (SendResult fits). */
export type SendOutcome =
  | { kind: 'ok'; accepted?: number; duplicates?: number; latencyMs?: number }
  | { kind: 'rejected'; reason: string; latencyMs?: number }
  | { kind: 'retry'; reason: string; latencyMs?: number };

export interface DeviceConfig {
  deviceId: string;
  intervalSeconds: number;
  baseRatePerMinute: number;
}

export interface DeviceDeps {
  clock: Clock;
  send: (batch: ReadingPayload[]) => Promise<SendOutcome | SendResult>;
  metrics: Metrics;
  random: () => number;
  log: (msg: string) => void;
}

/**
 * One simulated road sensor.
 *
 * Life cycle, once per interval:
 *   1. wait until the interval ends, plus a random jitter
 *   2. count vehicles for the interval that just ended and add the reading
 *      to the buffer
 *   3. send the buffer (oldest first, at most 500) unless a send or a retry
 *      is already pending, in which case that one will pick it up
 *
 * Readings leave the buffer only after the API confirms them (200) or
 * rejects them as invalid (400). Anything else (timeout, connection refused,
 * 5xx) keeps them buffered and schedules a retry with backoff. That is what
 * makes "kill the API and restart it" lose nothing.
 */
export class SimDevice {
  private buffer: ReadingPayload[] = [];
  private inFlight = false;
  private retryPending = false;
  private failedAttempts = 0;

  constructor(private readonly cfg: DeviceConfig, private readonly deps: DeviceDeps) {}

  get bufferedCount(): number {
    return this.buffer.length;
  }

  start(): void {
    this.scheduleInterval(nextBoundary(this.deps.clock.now(), this.cfg.intervalSeconds));
  }

  /**
   * Waits for `boundary` (the end of an interval) plus jitter.
   *
   * The next boundary is always derived from the previous one, never
   * recomputed from "now". Timers fire late under load (event-loop lag); if
   * we recomputed from the clock, a late timer near the end of its jitter
   * window would land past the next boundary and that interval would be
   * silently skipped.
   */
  private scheduleInterval(boundary: number): void {
    const { clock, random } = this.deps;
    // Send jitter: 0 to one full interval after the boundary, so 20,000
    // devices don't all hit the API in the same millisecond. The reading's
    // intervalStart is still the aligned boundary, whenever we send it.
    const jitter = random() * this.cfg.intervalSeconds * 1000;
    // max(0, …): if we're already behind schedule, fire now and catch up.
    clock.setTimeout(() => this.onIntervalEnd(boundary), Math.max(0, boundary - clock.now() + jitter));
  }

  private onIntervalEnd(boundary: number): void {
    const intervalStart = boundary - this.cfg.intervalSeconds * 1000;
    this.buffer.push({
      deviceId: this.cfg.deviceId,
      intervalStart: isoSeconds(intervalStart),
      intervalSeconds: this.cfg.intervalSeconds,
      vehicles: vehicleCount(this.cfg.baseRatePerMinute, new Date(intervalStart), this.cfg.intervalSeconds, this.deps.random),
    });
    this.scheduleInterval(boundary + this.cfg.intervalSeconds * 1000);
    if (!this.inFlight && !this.retryPending) void this.flush();
  }

  private async flush(): Promise<void> {
    const { metrics } = this.deps;
    const batch = this.buffer.slice(0, MAX_BATCH);
    this.inFlight = true;
    metrics.requests++;
    metrics.readingsSent += batch.length;

    const outcome = await this.deps.send(batch);
    this.inFlight = false;
    // Latency percentiles describe how fast the API answers, so they only
    // include requests that got an HTTP response. Timeouts (≈ the timeout
    // value) and refused connections (≈ 1 ms) are counted separately instead
    // of distorting p50/p99.
    const gotResponse = outcome.kind !== 'retry' || outcome.reason === '5xx';
    if (gotResponse && outcome.latencyMs !== undefined) metrics.latenciesMs.push(outcome.latencyMs);

    if (outcome.kind === 'retry') {
      if (outcome.reason === 'timeout') metrics.timeouts++;
      else if (outcome.reason === '5xx') metrics.status5xx++;
      else metrics.networkErrors++;
      this.failedAttempts++;
      this.retryPending = true;
      this.deps.clock.setTimeout(() => {
        this.retryPending = false;
        void this.flush();
      }, backoffDelay(this.failedAttempts, this.deps.random));
      return;
    }

    if (outcome.kind === 'ok') {
      metrics.status200++;
      metrics.accepted += outcome.accepted ?? 0;
      metrics.duplicates += outcome.duplicates ?? 0;
    } else {
      // 400: the data itself is wrong, so resending would fail forever.
      // Drop it and make noise about it: this is a bug to fix, not to retry.
      metrics.status400++;
      this.deps.log(`${this.cfg.deviceId}: batch of ${batch.length} rejected, dropping it: ${outcome.reason}`);
    }
    // Only now remove the batch. New readings may have been appended while
    // the request was in flight; they stay and are sent right away.
    this.buffer.splice(0, batch.length);
    this.failedAttempts = 0;
    if (this.buffer.length > 0) void this.flush();
  }
}
