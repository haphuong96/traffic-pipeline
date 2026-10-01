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
}

/**
 * Sends readings to Kafka and reports whether they were durably accepted.
 *
 * `publish()` resolves only once the broker has acknowledged every message
 * (acks=all), so a 200 from the API means "safely queued", not "stored in
 * Postgres". That's the consumer's job, later.
 */
export class Publisher {
  private producer;
  private connected = false;
  /** False after a failed send, until a send succeeds again. Drives /health. */
  private lastSendOk = true;

  constructor(private readonly opts: PublisherOptions) {
    const kafka = new Kafka({ kafkaJS: { brokers: opts.brokers, logLevel: logLevel.WARN } });
    this.producer = kafka.producer({
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
