import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { createTestPool } from './helpers.ts';
import { insertReadings, isDataError } from '../src/store.ts';

let pool: pg.Pool;
before(async () => {
  pool = await createTestPool();
});
after(async () => {
  await pool.end();
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

test('a 5,000-row batch goes in as one statement', async () => {
  const base = Date.parse('2026-09-30T00:00:00Z');
  const rows = Array.from({ length: 5000 }, (_, i) => ({
    deviceId: 'dev-00003', intervalStart: new Date(base + i * 15_000), vehicles: i % 9,
  }));
  assert.deepEqual(await insertReadings(pool, rows, { warn: () => {} }), { accepted: 5000, duplicates: 0 });
});

test('isDataError: FK violations are data errors, connection failures are not', async () => {
  const err = await insertReadings(pool, [{ deviceId: 'dev-99999', intervalStart: new Date(), vehicles: 1 }], { warn: () => {} })
    .then(() => null, (e: unknown) => e);
  assert.ok(err, 'unknown device must violate the foreign key');
  assert.equal(isDataError(err), true);
  assert.equal(isDataError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })), false);
  assert.equal(isDataError(new Error('timeout exceeded when trying to connect')), false);
});
