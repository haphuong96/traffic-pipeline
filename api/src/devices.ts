import type pg from 'pg';

/** "dev-00042" — five digits, zero padded. */
export function deviceIdFor(n: number): string {
  return `dev-${String(n).padStart(5, '0')}`;
}

/**
 * Inserts dev-00001 … dev-<count>. The first half report every 15 s, the rest
 * every 60 s (40,000 → 20,000 of each). Re-runnable thanks to ON CONFLICT.
 *
 * generate_series lets Postgres create all rows in one statement instead of
 * 40,000 round trips from Node.
 */
export async function seedDevices(pool: pg.Pool, count: number): Promise<number> {
  const half = Math.floor(count / 2);
  const result = await pool.query(
    `INSERT INTO devices (device_id, name, interval_seconds)
     SELECT 'dev-' || lpad(n::text, 5, '0'),
            'Sensor ' || n,
            CASE WHEN n <= $2 THEN 15 ELSE 60 END
     FROM generate_series(1, $1::int) AS n
     ON CONFLICT (device_id) DO NOTHING`,
    [count, half],
  );
  return result.rowCount ?? 0;
}

/** deviceId -> interval_seconds. Loaded once at API startup and kept in memory. */
export async function loadDevices(pool: pg.Pool): Promise<Map<string, number>> {
  const result = await pool.query<{ device_id: string; interval_seconds: number }>(
    'SELECT device_id, interval_seconds FROM devices',
  );
  return new Map(result.rows.map((r) => [r.device_id, r.interval_seconds]));
}
