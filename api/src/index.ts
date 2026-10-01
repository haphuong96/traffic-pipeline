import pg from 'pg';
import { config } from './config.ts';
import { buildApp } from './app.ts';
import { loadDevices } from './devices.ts';
import { Publisher } from './publisher.ts';

// Postgres is only needed once, to load the devices. After that the API
// never touches the database: it validates and hands readings to Kafka.
// Trade-off: devices seeded after startup are unknown until the API restarts.
const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
const devices = await loadDevices(pool);
await pool.end();

const publisher = new Publisher({ brokers: config.kafkaBrokers, topic: config.kafkaTopic, produceTimeoutMs: config.produceTimeoutMs });
await publisher.connect();

const app = buildApp({
  devices,
  publish: (readings, receivedAt) => publisher.publish(readings, receivedAt),
  isReady: () => publisher.isReady(),
  logger: { level: config.logLevel },
  logRequests: config.logRequests,
});

app.log.info({ devices: devices.size, topic: config.kafkaTopic }, 'devices loaded, producer connected');
await app.listen({ port: config.port, host: config.host });

// Graceful shutdown: stop accepting requests, let in-flight ones finish,
// then flush anything the producer still holds.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    await publisher.disconnect();
    process.exit(0);
  });
}
