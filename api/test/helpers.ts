import pg from 'pg';
import { migrate } from '../src/schema.ts';

// Integration tests run against a separate database in the same Postgres
// container, so they never touch the real `traffic` data.
const adminUrl = process.env.DATABASE_URL ?? 'postgres://traffic:traffic@localhost:5434/traffic';
const testUrl = adminUrl.replace(/\/[^/]*$/, '/traffic_test');

export async function createTestPool(): Promise<pg.Pool> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'traffic_test'");
  if (exists.rowCount === 0) await admin.query('CREATE DATABASE traffic_test');
  await admin.end();

  const pool = new pg.Pool({ connectionString: testUrl, max: 4 });
  await migrate(pool);
  await pool.query('TRUNCATE raw_readings, devices');
  return pool;
}
