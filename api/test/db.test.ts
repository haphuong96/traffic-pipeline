import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { createTestPool } from './helpers.ts';
import { migrate } from '../src/schema.ts';
import { seedDevices, loadDevices } from '../src/devices.ts';
import { insertReadings } from '../src/store.ts';

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

test('insertReadings stores new rows, counts duplicates, keeps the original value', async () => {
  const warnings: unknown[] = [];
  const log = { warn: (obj: unknown) => warnings.push(obj) };
  const t0 = new Date('2026-09-30T11:00:00Z');
  const t1 = new Date('2026-09-30T11:00:15Z');

  const first = await insertReadings(pool, [
    { deviceId: 'dev-00001', intervalStart: t0, vehicles: 5 },
    { deviceId: 'dev-00001', intervalStart: t1, vehicles: 6 },
  ], log);
  assert.deepEqual(first, { accepted: 2, duplicates: 0 });

  // Exact retry of t0 (same value: silent) + conflicting t1 (different value: warn)
  // + one brand new reading.
  const second = await insertReadings(pool, [
    { deviceId: 'dev-00001', intervalStart: t0, vehicles: 5 },
    { deviceId: 'dev-00001', intervalStart: t1, vehicles: 99 },
    { deviceId: 'dev-00021', intervalStart: t0, vehicles: 30 },
  ], log);
  assert.deepEqual(second, { accepted: 1, duplicates: 2 });

  assert.equal(warnings.length, 1);
  assert.match(JSON.stringify(warnings[0]), /dev-00001/);

  const stored = await pool.query(
    "SELECT vehicles FROM raw_readings WHERE device_id = 'dev-00001' AND interval_start = $1", [t1]);
  assert.equal(stored.rows[0].vehicles, 6, 'original value must be kept');
});

test('insertReadings handles the same reading twice inside one batch', async () => {
  const t = new Date('2026-09-30T12:00:00Z');
  const r = await insertReadings(pool, [
    { deviceId: 'dev-00002', intervalStart: t, vehicles: 1 },
    { deviceId: 'dev-00002', intervalStart: t, vehicles: 1 },
  ], { warn: () => {} });
  assert.deepEqual(r, { accepted: 1, duplicates: 1 });
});
