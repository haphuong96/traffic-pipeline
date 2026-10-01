import type pg from 'pg';
import type { Reading } from './message.ts';

export interface InsertResult {
  accepted: number;
  duplicates: number;
}

export interface WarnLogger {
  warn(obj: object, msg?: string): void;
}

const key = (deviceId: string, intervalStart: Date) => `${deviceId}|${intervalStart.getTime()}`;

/**
 * Stores a validated batch with ONE multi-row INSERT.
 *
 * ON CONFLICT DO NOTHING makes retries safe: a reading the device already
 * sent (e.g. the response got lost) is simply skipped. RETURNING tells us
 * which rows were actually new; everything else was a duplicate.
 */
export async function insertReadings(pool: pg.Pool, readings: Reading[], log: WarnLogger): Promise<InsertResult> {
  // Build "($1,$2,$3),($4,$5,$6),…". 500 readings = 1,500 parameters, well
  // under Postgres' limit of 65,535.
  const values: unknown[] = [];
  const tuples = readings.map((r, i) => {
    values.push(r.deviceId, r.intervalStart, r.vehicles);
    return `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`;
  });

  const inserted = await pool.query<{ device_id: string; interval_start: Date }>(
    `INSERT INTO raw_readings (device_id, interval_start, vehicles)
     VALUES ${tuples.join(', ')}
     ON CONFLICT (device_id, interval_start) DO NOTHING
     RETURNING device_id, interval_start`,
    values,
  );

  const accepted = inserted.rowCount ?? 0;
  const duplicates = readings.length - accepted;
  if (duplicates > 0) {
    await warnOnConflictingDuplicates(pool, readings, inserted.rows, log);
  }
  return { accepted, duplicates };
}

/**
 * A duplicate with the SAME vehicle count is a normal retry. A duplicate with
 * a DIFFERENT count means the device is buggy (it re-counted an interval it
 * already reported). We keep the first value and log a warning so a human
 * can investigate. We never overwrite: first write wins.
 */
async function warnOnConflictingDuplicates(
  pool: pg.Pool,
  readings: Reading[],
  insertedRows: { device_id: string; interval_start: Date }[],
  log: WarnLogger,
): Promise<void> {
  const insertedKeys = new Set(insertedRows.map((r) => key(r.device_id, r.interval_start)));
  // Limitation: if the same (device, intervalStart) appears twice in ONE
  // batch, its key is in insertedKeys, so neither copy is checked here. The
  // second copy is still counted as a duplicate and the first value is kept,
  // but a conflicting count within a single batch is not logged.
  const dupes = readings.filter((r) => !insertedKeys.has(key(r.deviceId, r.intervalStart)));

  // Fetch the stored values for all duplicates in one query. unnest() turns
  // the two arrays into a small table we can join against.
  const stored = await pool.query<{ device_id: string; interval_start: Date; vehicles: number }>(
    `SELECT r.device_id, r.interval_start, r.vehicles
     FROM raw_readings r
     JOIN unnest($1::text[], $2::timestamptz[]) AS d(device_id, interval_start)
       USING (device_id, interval_start)`,
    [dupes.map((d) => d.deviceId), dupes.map((d) => d.intervalStart)],
  );
  const storedByKey = new Map(stored.rows.map((r) => [key(r.device_id, r.interval_start), r.vehicles]));

  for (const d of dupes) {
    const storedVehicles = storedByKey.get(key(d.deviceId, d.intervalStart));
    if (storedVehicles !== undefined && storedVehicles !== d.vehicles) {
      log.warn(
        {
          deviceId: d.deviceId,
          intervalStart: d.intervalStart.toISOString(),
          storedVehicles,
          incomingVehicles: d.vehicles,
        },
        'duplicate reading with a different vehicle count; keeping the stored value',
      );
    }
  }
}

/**
 * True when Postgres rejected the DATA (SQLSTATE class 22 "data exception" or
 * 23 "integrity constraint violation", e.g. an unknown device_id). Retrying
 * the same rows would fail forever, so the caller skips them instead.
 *
 * Anything else (connection refused, timeouts, the server shutting down…)
 * is treated as temporary: the caller keeps the batch and retries it.
 */
export function isDataError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^2[23][0-9A-Z]{3}$/.test(code);
}
