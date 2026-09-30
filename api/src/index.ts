import pg from 'pg';
import { config } from './config.ts';
import { buildApp } from './app.ts';
import { loadDevices } from './devices.ts';
import { insertReadings } from './store.ts';

// One pool for the whole process. Its size caps how many INSERTs run in
// Postgres at the same time; extra requests wait in the pool's queue, with
// no time limit (pg's default connectionTimeoutMillis is 0).
const pool = new pg.Pool({ connectionString: config.databaseUrl, max: config.poolSize });
// Without this handler an idle client losing its connection (e.g. Postgres
// restarts) would emit an unhandled 'error' event and crash the process.
pool.on('error', (err) => console.error('idle pg client error', err.message));

// Loaded once: validating 1,000+ readings/s with a DB lookup each would put
// far more load on Postgres than the inserts themselves. Trade-off: devices
// seeded after startup are unknown until the API restarts.
const devices = await loadDevices(pool);

const app = buildApp({
  devices,
  store: (readings) => insertReadings(pool, readings, app.log),
  ping: async () => {
    await pool.query('SELECT 1');
  },
  logger: { level: config.logLevel },
  logRequests: config.logRequests,
});

app.log.info({ devices: devices.size, poolSize: config.poolSize }, 'devices loaded');
await app.listen({ port: config.port, host: config.host });

// Graceful shutdown: stop accepting requests, let in-flight ones finish.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
