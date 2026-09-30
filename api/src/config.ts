// All configuration comes from environment variables, with defaults that
// match docker-compose.yml (Postgres is published on host port 5434).
export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://traffic:traffic@localhost:5434/traffic',
  poolSize: Number(process.env.PG_POOL_SIZE ?? 10),
  port: Number(process.env.PORT ?? 8080),
  host: process.env.HOST ?? '0.0.0.0',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  // Off by default: at load-test volume (~100 requests/s and up) one log line
  // per request would itself become a bottleneck and hide the real one.
  logRequests: process.env.LOG_REQUESTS === 'true',
  seedDeviceCount: Number(process.env.SEED_DEVICE_COUNT ?? 40_000),
};
