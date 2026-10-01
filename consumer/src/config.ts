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
  brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9094').split(','),
  topic: process.env.KAFKA_TOPIC ?? 'readings',
  groupId: process.env.KAFKA_GROUP_ID ?? 'raw-writer',
  batchMaxRows: intEnv('BATCH_MAX_ROWS', 5000),
  batchMaxWaitMs: intEnv('BATCH_MAX_WAIT_MS', 500),
  metricsIntervalMs: intEnv('METRICS_INTERVAL_MS', 10_000),
};

// One INSERT uses 3 parameters per row, and Postgres allows at most 65,535
// parameters per statement, i.e. 21,845 rows. A batch can overshoot
// BATCH_MAX_ROWS: while one flush runs, each partition worker may add one
// more Kafka batch. So the worst case is maxRows + 6 × 1000 rows.
const worstCase = config.batchMaxRows + PARTITION_CONCURRENCY * KAFKA_BATCH_SIZE;
if (worstCase > 21_000) {
  throw new Error(`BATCH_MAX_ROWS=${config.batchMaxRows} is too large: a batch could reach ${worstCase} rows (limit 21,000). Use at most 15000.`);
}
