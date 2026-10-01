// End-to-end: API (real Publisher) → Kafka → consumer → Postgres.
// Needs `docker compose up -d` (Kafka on localhost:9094, Postgres on 5434).
// Uses a throwaway topic and consumer group, so it never touches `readings`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import kafkaJs from '@confluentinc/kafka-javascript';
import { createTestPool } from './helpers.ts';
import { startConsumer } from '../src/run.ts';
import { buildApp } from '../../api/src/app.ts';
import { Publisher } from '../../api/src/publisher.ts';

const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:9094').split(',');
const topic = `e2e-${Date.now()}`;
const quiet = { info() {}, warn() {}, error() {} };

let pool: pg.Pool;
let publisher: Publisher;
let admin: ReturnType<InstanceType<typeof kafkaJs.KafkaJS.Kafka>['admin']>;

before(async () => {
  pool = await createTestPool();
  admin = new kafkaJs.KafkaJS.Kafka({ kafkaJS: { brokers, logLevel: kafkaJs.KafkaJS.logLevel.ERROR } }).admin();
  await admin.connect();
  await admin.createTopics({ topics: [{ topic, numPartitions: 3 }] });
  publisher = new Publisher({ brokers, topic, produceTimeoutMs: 5000 });
  await publisher.connect();
});

after(async () => {
  await publisher.disconnect();
  await admin.deleteTopics({ topics: [topic] });
  await admin.disconnect();
  await pool.end();
});

/** n readings for dev-00001…dev-00020 (15 s devices), starting at `fromIndex`. */
function readings(fromIndex: number, n: number) {
  const base = Date.parse('2026-01-01T00:00:00Z');
  return Array.from({ length: n }, (_, k) => {
    const i = fromIndex + k;
    return {
      deviceId: `dev-${String((i % 20) + 1).padStart(5, '0')}`,
      intervalStart: new Date(base + Math.floor(i / 20) * 15_000).toISOString().replace('.000Z', 'Z'),
      intervalSeconds: 15,
      vehicles: i % 7,
    };
  });
}

async function rowCount(): Promise<number> {
  return Number((await pool.query('SELECT count(*) FROM raw_readings')).rows[0].count);
}

async function waitForRows(n: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await rowCount()) >= n) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.fail(`timed out waiting for ${n} rows, have ${await rowCount()}`);
}

test('readings flow API → Kafka → Postgres; a consumer restart loses nothing and double-counts nothing', { timeout: 120_000 }, async () => {
  const devices = new Map(Array.from({ length: 20 }, (_, i) => [`dev-${String(i + 1).padStart(5, '0')}`, 15]));
  const app = buildApp({ devices, publish: (r, at) => publisher.publish(r, at), isReady: () => publisher.isReady(), logger: false });
  const post = (body: unknown) => app.inject({ method: 'POST', url: '/readings', payload: body as object });

  const groupId = `${topic}-writer`;
  const opts = { brokers, topic, groupId, pool, batchMaxRows: 5000, batchMaxWaitMs: 100, log: quiet };

  // 1. Consumer running: 200 readings in 4 requests.
  let consumer = await startConsumer(opts);
  for (let i = 0; i < 4; i++) {
    const res = await post(readings(i * 50, 50));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { queued: 50 });
  }
  await waitForRows(200);

  // 2. Consumer stopped: the API keeps accepting. Also re-send 50 old readings
  //    (a device retry), which must not become extra rows.
  await consumer.stop();
  assert.equal((await post(readings(200, 100))).statusCode, 200);
  assert.equal((await post(readings(0, 50))).statusCode, 200);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(await rowCount(), 200, 'nothing is written while the consumer is down');

  // 3. Restart: it resumes from the committed offsets and catches up.
  consumer = await startConsumer(opts);
  await waitForRows(300);
  await new Promise((r) => setTimeout(r, 1000)); // let the duplicates land too
  await consumer.stop();

  assert.equal(await rowCount(), 300, 'each (device, interval) stored exactly once');
  const sum = Number((await pool.query('SELECT sum(vehicles) FROM raw_readings')).rows[0].sum);
  const expected = readings(0, 300).reduce((a, r) => a + r.vehicles, 0);
  assert.equal(sum, expected, 'stored values are the originals');
});
