import type pg from 'pg';
import type { Reading } from './validate.ts';

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
  // Note: if the same reading appears twice in one batch, the first copy is
  // inserted and the second is "not returned", so it lands here too. That
  // is fine: it is compared against the stored value like any other.
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
