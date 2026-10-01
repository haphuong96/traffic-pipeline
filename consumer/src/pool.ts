import pg from 'pg';

export interface PoolOptions {
  databaseUrl: string;
  poolSize: number;
  queryTimeoutMs: number;
}

/**
 * A pg pool that fails instead of hanging, so BatchWriter's retry loop can
 * do its job:
 *   - connectionTimeoutMillis: give up connecting after 5 s (in Phase 1 a
 *     hung connect kept the API stuck for 1.5 min after Postgres was back).
 *   - query_timeout: give up on a query after queryTimeoutMs. Covers a
 *     Postgres that stops answering on an already-open connection (paused
 *     container, network black hole), which the connect timeout doesn't.
 */
export function createPool(opts: PoolOptions, onIdleError: (err: Error) => void): pg.Pool {
  const pool = new pg.Pool({
    connectionString: opts.databaseUrl,
    max: opts.poolSize,
    connectionTimeoutMillis: 5000,
    query_timeout: opts.queryTimeoutMs,
  });
  pool.on('error', onIdleError);
  return pool;
}
