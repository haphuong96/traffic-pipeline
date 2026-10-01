// Configuration from environment variables (optionally via consumer/.env).
function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return n;
}

/** How many partitions we process at once (the topic has 6). */
export const PARTITION_CONCURRENCY = 6;
/** Max messages the Kafka client hands us per partition per callback. */
export const KAFKA_BATCH_SIZE = 1000;

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://traffic:traffic@localhost:5434/traffic',
  poolSize: intEnv('PG_POOL_SIZE', 2),
  queryTimeoutMs: intEnv('PG_QUERY_TIMEOUT_MS', 30_000),
  brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9094').split(','),
  topic: process.env.KAFKA_TOPIC ?? 'readings',
  groupId: process.env.KAFKA_GROUP_ID ?? 'raw-writer',
  batchMaxRows: intEnv('BATCH_MAX_ROWS', 5000),
  batchMaxWaitMs: intEnv('BATCH_MAX_WAIT_MS', 500),
  metricsIntervalMs: intEnv('METRICS_INTERVAL_MS', 10_000),
};

/**
 * The biggest batch that can ever build up. Each partition worker hands over
 * at most KAFKA_BATCH_SIZE messages and then WAITS until they're stored, so
 * at most PARTITION_CONCURRENCY × KAFKA_BATCH_SIZE messages are pending at
 * once (fewer if this consumer owns fewer partitions, e.g. when several
 * consumers share the topic). 6,000 rows × 3 parameters is also safely under
 * Postgres' 65,535-parameter limit for one INSERT.
 */
export const maxReachableBatch = PARTITION_CONCURRENCY * KAFKA_BATCH_SIZE;

/** A larger BATCH_MAX_ROWS would never trigger a flush, so reject it rather than silently ignore it. */
export function validateBatchMaxRows(n: number): void {
  if (n > maxReachableBatch) {
    throw new Error(`BATCH_MAX_ROWS=${n} can never be reached (at most ${maxReachableBatch} messages can be pending); use at most ${maxReachableBatch}.`);
  }
}
validateBatchMaxRows(config.batchMaxRows);
