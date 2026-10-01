import kafkaJs from '@confluentinc/kafka-javascript';
import type { Reading } from './validate.ts';

const { Kafka, logLevel } = kafkaJs.KafkaJS;

/** Wire format shared with the consumer (consumer/src/message.ts). */
export function toKafkaMessages(readings: Reading[], receivedAt: Date) {
  const at = receivedAt.toISOString();
  return readings.map((r) => ({
    // Same key → same partition → one device's readings stay in order.
    key: r.deviceId,
    value: JSON.stringify({
      deviceId: r.deviceId,
      intervalStart: r.intervalStart.toISOString().replace('.000Z', 'Z'),
      vehicles: r.vehicles,
      receivedAt: at,
    }),
  }));
}

export interface PublisherOptions {
  brokers: string[];
  topic: string;
  /** Give up on a message after this long; the request then gets a 503. */
  produceTimeoutMs: number;
  /** Called when the producer hit an unrecoverable error (see isFatalKafkaError). */
  onFatal?: (err: unknown) => void;
}

/** The subset of the producer we use; tests pass a fake. */
interface ProducerLike {
  connect(): Promise<unknown>;
  disconnect(): Promise<unknown>;
  send(record: { topic: string; messages: { key: string; value: string }[] }): Promise<unknown>;
}

/**
 * True for librdkafka's "fatal" errors (code -150, ERR__FATAL). The
 * idempotent producer raises one when it can no longer guarantee ordering
 * or no-duplicates, e.g. OUT_OF_ORDER_SEQUENCE_NUMBER after a single broker
 * lost acknowledged data. After that, every send fails until the producer
 * is recreated. A timeout is NOT fatal: the next send may well work.
 */
export function isFatalKafkaError(err: unknown): boolean {
  const e = err as { code?: unknown; fatal?: unknown } | null;
  return e?.code === -150 || e?.fatal === true;
}

/**
 * Sends readings to Kafka and reports whether they were durably accepted.
 *
 * `publish()` resolves only once the broker has acknowledged every message
 * (acks=all), so a 200 from the API means "safely queued", not "stored in
 * Postgres". That's the consumer's job, later.
 */
export class Publisher {
  private producer: ProducerLike;
  private connected = false;
  /** False after a failed send, until a send succeeds again. Drives /health. */
  private lastSendOk = true;

  constructor(private readonly opts: PublisherOptions, producer?: ProducerLike) {
    this.producer = producer ?? Publisher.createProducer(opts);
  }

  private static createProducer(opts: PublisherOptions): ProducerLike {
    const kafka = new Kafka({ kafkaJS: { brokers: opts.brokers, logLevel: logLevel.WARN } });
    return kafka.producer({
      // Wait for all in-sync replicas (just one broker here, but the setting is
      // what you'd use in production).
      acks: -1, // -1 = "all"
      // Internal retries can't create duplicates or reorder a partition.
      'enable.idempotence': true,
      'compression.type': 'lz4',
      // Wait up to 5 ms to group messages from concurrent requests into one
      // produce request. Same idea as the consumer's batching, on a tiny scale.
      'linger.ms': 5,
      // Total time librdkafka may spend delivering a message (incl. retries).
      // Kept below the simulator's 5 s timeout so we answer 503 before the
      // device gives up on us.
      'message.timeout.ms': opts.produceTimeoutMs,
    });
  }

  async connect(): Promise<void> {
    await this.producer.connect();
    this.connected = true;
  }

  async publish(readings: Reading[], receivedAt: Date): Promise<void> {
    try {
      await this.producer.send({ topic: this.opts.topic, messages: toKafkaMessages(readings, receivedAt) });
      this.lastSendOk = true;
    } catch (err) {
      this.lastSendOk = false;
      if (isFatalKafkaError(err)) this.opts.onFatal?.(err);
      throw err;
    }
  }

  isReady(): boolean {
    return this.connected && this.lastSendOk;
  }

  /** Flushes anything still buffered, then closes. */
  async disconnect(): Promise<void> {
    this.connected = false;
    await this.producer.disconnect();
  }
}
