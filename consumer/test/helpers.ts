import pg from 'pg';
// The schema is owned by the API package (npm run migrate); reuse it so the
// test database can never drift from the real one.
import { migrate } from '../../api/src/schema.ts';

const adminUrl = process.env.DATABASE_URL ?? 'postgres://traffic:traffic@localhost:5434/traffic';
const testUrl = adminUrl.replace(/\/[^/]*$/, '/traffic_test');

/** A pool on the `traffic_test` database with empty tables and devices dev-00001…dev-00040. */
export async function createTestPool(): Promise<pg.Pool> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'traffic_test'");
  if (exists.rowCount === 0) await admin.query('CREATE DATABASE traffic_test');
  await admin.end();

  const pool = new pg.Pool({ connectionString: testUrl, max: 4 });
  await migrate(pool);
  await pool.query('TRUNCATE raw_readings, devices');
  await pool.query(`INSERT INTO devices (device_id, interval_seconds)
                    SELECT 'dev-' || lpad(n::text, 5, '0'), CASE WHEN n <= 20 THEN 15 ELSE 60 END
                    FROM generate_series(1, 40) n`);
  return pool;
}
