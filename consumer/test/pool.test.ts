import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPool } from '../src/pool.ts';

const url = process.env.DATABASE_URL ?? 'postgres://traffic:traffic@localhost:5434/traffic';

test('a query that hangs is abandoned after queryTimeoutMs, so the batch can be retried', async () => {
  const pool = createPool({ databaseUrl: url, poolSize: 1, queryTimeoutMs: 200 }, () => {});
  const started = Date.now();
  await assert.rejects(pool.query('SELECT pg_sleep(3)'), /timeout/i);
  assert.ok(Date.now() - started < 2000, 'must not wait for the sleep to finish');
  await pool.end();
});
