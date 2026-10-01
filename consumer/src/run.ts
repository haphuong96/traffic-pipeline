import type pg from 'pg';
import kafkaJs from '@confluentinc/kafka-javascript';
import { KAFKA_BATCH_SIZE, PARTITION_CONCURRENCY } from './config.ts';
import { BatchWriter, type Log } from './batch-writer.ts';
import { insertReadings } from './store.ts';
import { retryDelayMs } from './backoff.ts';
import { computeLag } from './lag.ts';

const { Kafka, logLevel } = kafkaJs.KafkaJS;

export interface ConsumerOptions {
  brokers: string[];
  topic: string;
  groupId: string;
  pool: pg.Pool;
  batchMaxRows: number;
  batchMaxWaitMs: number;
  log: Log;
}

/** Connects to Kafka and starts moving messages into Postgres. */
export async function startConsumer(opts: ConsumerOptions) {
  const kafka = new Kafka({ kafkaJS: { brokers: opts.brokers, logLevel: logLevel.WARN } });
  const consumer = kafka.consumer({
    'group.id': opts.groupId,
    // A brand-new group starts at the oldest retained message, so nothing
    // produced before the consumer's first start is skipped.
    'auto.offset.reset': 'earliest',
    // We commit offsets ourselves, and only after Postgres has committed.
    'enable.auto.commit': false,
    'js.consumer.max.batch.size': KAFKA_BATCH_SIZE,
  });

  const writer = new BatchWriter({
    maxRows: opts.batchMaxRows,
    maxWaitMs: opts.batchMaxWaitMs,
    store: (rows) => insertReadings(opts.pool, rows, { warn: (obj, msg) => opts.log.warn(msg ?? 'duplicate warning', obj) }),
    commit: (offsets) => consumer.commitOffsets(offsets.map((o) => ({ topic: opts.topic, ...o }))),
    retryDelayMs: (attempt) => retryDelayMs(attempt),
    log: opts.log,
  });

  // A separate admin connection for reading offsets (consumer lag).
  const admin = kafka.admin();
  await admin.connect();

  await consumer.connect();
  await consumer.subscribe({ topics: [opts.topic] });
  await consumer.run({
    partitionsConsumedConcurrently: PARTITION_CONCURRENCY,
    eachBatch: async ({ batch }) => {
      // Waits until these messages are in Postgres and committed in Kafka.
      // While we wait, this partition doesn't fetch more: backpressure.
      await writer.add(batch.partition, batch.messages);
    },
  });

  return {
    writer,
    /** Messages in Kafka not yet stored and committed by this group. */
    async lag(): Promise<number> {
      const [ends, committed] = await Promise.all([
        admin.fetchTopicOffsets(opts.topic),
        admin.fetchOffsets({ groupId: opts.groupId, topics: [opts.topic] }),
      ]);
      return computeLag(ends, committed[0]?.partitions ?? []);
    },
    /** Writes what's pending, commits it, then leaves the group. */
    async stop() {
      await writer.flushNow();
      await consumer.disconnect();
      await admin.disconnect();
    },
  };
}
