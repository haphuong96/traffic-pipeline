import { config } from './config.ts';
import { Metrics, type Log } from './batch-writer.ts';
import { startConsumer } from './run.ts';
import { createPool } from './pool.ts';

const log: Log = {
  info: (msg, obj) => console.log(JSON.stringify({ level: 'info', time: new Date().toISOString(), msg, ...obj })),
  warn: (msg, obj) => console.warn(JSON.stringify({ level: 'warn', time: new Date().toISOString(), msg, ...obj })),
  error: (msg, obj) => console.error(JSON.stringify({ level: 'error', time: new Date().toISOString(), msg, ...obj })),
};

const pool = createPool(config, (err) => log.warn('idle pg client error', { error: err.message }));

const consumer = await startConsumer({
  brokers: config.brokers,
  topic: config.topic,
  groupId: config.groupId,
  pool,
  batchMaxRows: config.batchMaxRows,
  batchMaxWaitMs: config.batchMaxWaitMs,
  log,
});
log.info('consumer started', { topic: config.topic, groupId: config.groupId, batchMaxRows: config.batchMaxRows, batchMaxWaitMs: config.batchMaxWaitMs });

// reduce, not Math.max(...xs): spreading a huge array (e.g. a backlog
// catch-up of 200k rows) overflows the call stack.
const max = (xs: number[]) => xs.reduce((a, b) => (b > a ? b : a), 0);
const pct = (xs: number[], p: number) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
setInterval(async () => {
  const m = consumer.writer.metrics;
  consumer.writer.metrics = new Metrics();
  log.info('metrics', {
    batches: m.batches,
    inserted: m.inserted,
    duplicates: m.duplicates,
    skipped: m.skipped,
    storeRetries: m.storeRetries,
    avgBatch: m.batches ? Math.round((m.inserted + m.duplicates) / m.batches) : 0,
    flushMsP50: pct(m.flushMs, 50),
    flushMsMax: max(m.flushMs),
    endToEndMsP50: pct(m.endToEndMs, 50),
    endToEndMsMax: max(m.endToEndMs),
    lag: await consumer.lag().catch(() => -1), // -1 = couldn't ask Kafka
  });
}, config.metricsIntervalMs).unref();

// Graceful shutdown: write what we have, commit it, then leave the group so
// partitions are reassigned immediately instead of after a session timeout.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    log.info('shutting down');
    await consumer.stop();
    await pool.end();
    process.exit(0);
  });
}
