import type pg from 'pg';

// The Postgres volume already exists, so docker-entrypoint-initdb.d scripts
// never run. Instead we apply the schema ourselves, idempotently: running
// this twice is harmless.
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS devices (
  device_id        text PRIMARY KEY,
  name             text,
  interval_seconds int  NOT NULL CHECK (interval_seconds IN (15, 60))
);

-- The composite primary key is the idempotency key (one reading per device
-- per interval) and also the index behind the per-device dashboard queries.
-- There is deliberately no surrogate id: an int would overflow within weeks.
CREATE TABLE IF NOT EXISTS raw_readings (
  device_id      text        NOT NULL REFERENCES devices,
  interval_start timestamptz NOT NULL,
  vehicles       int         NOT NULL CHECK (vehicles >= 0),
  received_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, interval_start)
);
`;

export async function migrate(pool: pg.Pool): Promise<void> {
  await pool.query(SCHEMA_SQL);
}
