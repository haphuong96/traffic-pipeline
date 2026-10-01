import { parseMessage, type ParsedMessage, type Reading } from './message.ts';
import { isDataError, type InsertResult } from './store.ts';

/** The part of a Kafka message we need. */
export interface IncomingMessage {
  offset: string;
  value: Buffer | null;
}

export interface PartitionOffset {
  partition: number;
  /** The NEXT offset to read, i.e. the last processed offset + 1 (Kafka's convention). */
  offset: string;
}

export interface Log {
  info(msg: string, obj?: object): void;
  warn(msg: string, obj?: object): void;
  error(msg: string, obj?: object): void;
}

export interface BatchWriterDeps {
  /** Flush when this many messages are waiting… */
  maxRows: number;
  /** …or when the oldest waiting message is this old, whichever is first. */
  maxWaitMs: number;
  /** Writes rows to Postgres in one transaction. */
  store: (rows: Reading[]) => Promise<InsertResult>;
  /** Commits offsets to Kafka. Called only after `store` succeeded. */
  commit: (offsets: PartitionOffset[]) => Promise<void>;
  /** Delay before retry number `attempt` (1, 2, …) after a database error. */
  retryDelayMs: (attempt: number) => number;
  log: Log;
}

/** One batch being collected: rows to write plus how far it reaches in each partition. */
interface Pending {
  rows: ParsedMessage[];
  messageCount: number;
  lastOffsetByPartition: Map<number, bigint>;
  skipped: number;
  waiters: (() => void)[];
}

const emptyPending = (): Pending => ({
  rows: [],
  messageCount: 0,
  lastOffsetByPartition: new Map(),
  skipped: 0,
  waiters: [],
});

export class Metrics {
  batches = 0;
  inserted = 0;
  duplicates = 0;
  skipped = 0;
  storeRetries = 0;
  flushMs: number[] = [];
  endToEndMs: number[] = [];
}

/**
 * Turns a stream of small per-partition message batches into a few big
 * Postgres transactions. This is THE fix for Phase 1's bottleneck: one
 * commit (one WAL flush) per few thousand readings instead of one per request.
 *
 * Contract with the Kafka side:
 *   - `add()` returns a promise that resolves only once those messages are
 *     stored in Postgres AND their offsets are committed to Kafka. The Kafka
 *     callback awaits it, so the client can't run ahead: that's our
 *     backpressure, with no manual pause/resume.
 *   - Offsets are committed only AFTER the database commit. If we crash in
 *     between, Kafka redelivers those messages and `ON CONFLICT DO NOTHING`
 *     turns them into harmless duplicates (at-least-once + idempotent writes).
 *   - Flushes run one at a time, in order.
 */
export class BatchWriter {
  metrics = new Metrics();
  private pending = emptyPending();
  private timer: NodeJS.Timeout | null = null;
  /** Each flush is chained onto the previous one, so they never overlap. */
  private flushChain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: BatchWriterDeps) {}

  add(partition: number, messages: IncomingMessage[]): Promise<void> {
    const p = this.pending;
    for (const m of messages) {
      const parsed = parseMessage(m.value);
      if (parsed) {
        p.rows.push(parsed);
      } else {
        // Skip it, but still move the offset past it: one corrupt message must
        // never block its partition forever.
        p.skipped++;
        this.deps.log.warn('skipping unparseable message', { partition, offset: m.offset });
      }
      const offset = BigInt(m.offset);
      const prev = p.lastOffsetByPartition.get(partition);
      if (prev === undefined || offset > prev) p.lastOffsetByPartition.set(partition, offset);
    }
    p.messageCount += messages.length;

    const done = new Promise<void>((resolve) => p.waiters.push(resolve));
    if (p.messageCount >= this.deps.maxRows) {
      this.scheduleFlush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.scheduleFlush(), this.deps.maxWaitMs);
    }
    return done;
  }

  /** Writes whatever is pending right now. Used on shutdown. */
  flushNow(): Promise<void> {
    this.scheduleFlush();
    return this.flushChain;
  }

  private scheduleFlush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Take the batch at the moment the flush actually starts, not now: rows
    // that arrive while an earlier flush is still running join this one.
    this.flushChain = this.flushChain.then(() => {
      const batch = this.pending;
      this.pending = emptyPending();
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      return batch.messageCount > 0 ? this.flush(batch) : undefined;
    });
  }

  private async flush(batch: Pending): Promise<void> {
    const started = performance.now();
    const result = batch.rows.length > 0 ? await this.storeWithRetry(batch.rows) : { accepted: 0, duplicates: 0, skipped: 0 };

    const offsets = [...batch.lastOffsetByPartition].map(([partition, last]) => ({ partition, offset: String(last + 1n) }));
    try {
      await this.deps.commit(offsets);
    } catch (err) {
      // The rows are already in Postgres. If this commit is lost (e.g. the
      // partition moved to another consumer), the messages get redelivered
      // and become duplicates. Annoying, never wrong. The next successful
      // commit for the partition covers these offsets anyway.
      this.deps.log.warn('offset commit failed; messages may be redelivered as duplicates', {
        offsets,
        error: (err as Error).message,
      });
    }

    const m = this.metrics;
    const now = Date.now();
    m.batches++;
    m.inserted += result.accepted;
    m.duplicates += result.duplicates;
    m.skipped += batch.skipped + result.skipped;
    m.flushMs.push(Math.round(performance.now() - started));
    for (const r of batch.rows) m.endToEndMs.push(now - r.receivedAt.getTime());

    for (const resolve of batch.waiters) resolve();
  }

  /**
   * Keeps trying until the batch is stored. A database outage just means we
   * wait here; meanwhile Kafka holds the backlog, the API keeps answering 200,
   * and consumer lag grows until Postgres is back.
   */
  private async storeWithRetry(rows: Reading[]): Promise<InsertResult & { skipped: number }> {
    for (let attempt = 1; ; attempt++) {
      try {
        try {
          return { ...(await this.deps.store(rows)), skipped: 0 };
        } catch (err) {
          if (!isDataError(err)) throw err;
          // Some row is bad. Find it by writing one row at a time. Slow, but
          // only happens for broken data, which the API should never let through.
          return await this.storeRowByRow(rows);
        }
      } catch (err) {
        this.metrics.storeRetries++;
        const delay = this.deps.retryDelayMs(attempt);
        this.deps.log.error('database write failed; retrying the same batch', {
          attempt,
          retryInMs: delay,
          rows: rows.length,
          error: (err as Error).message,
        });
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  private async storeRowByRow(rows: Reading[]): Promise<InsertResult & { skipped: number }> {
    const total = { accepted: 0, duplicates: 0, skipped: 0 };
    for (const row of rows) {
      try {
        const r = await this.deps.store([row]);
        total.accepted += r.accepted;
        total.duplicates += r.duplicates;
      } catch (err) {
        if (!isDataError(err)) throw err; // e.g. the DB went away mid-way: retry the whole batch
        total.skipped++;
        this.deps.log.warn('skipping reading rejected by the database', {
          deviceId: row.deviceId,
          intervalStart: row.intervalStart.toISOString(),
          error: (err as Error).message,
        });
      }
    }
    return total;
  }
}
