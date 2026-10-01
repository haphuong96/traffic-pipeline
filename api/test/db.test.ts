import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { createTestPool } from './helpers.ts';
import { migrate } from '../src/schema.ts';
import { seedDevices, loadDevices } from '../src/devices.ts';

let pool: pg.Pool;
before(async () => {
  pool = await createTestPool();
});
after(async () => {
  await pool.end();
});

test('migrate is idempotent', async () => {
  await migrate(pool);
  await migrate(pool);
});

test('seed creates devices with the 15/60 split and is re-runnable', async () => {
  await seedDevices(pool, 40); // first half 15 s, second half 60 s
  await seedDevices(pool, 40);
  const devices = await loadDevices(pool);
  assert.equal(devices.size, 40);
  assert.equal(devices.get('dev-00001'), 15);
  assert.equal(devices.get('dev-00020'), 15);
  assert.equal(devices.get('dev-00021'), 60);
  assert.equal(devices.get('dev-00040'), 60);
});
