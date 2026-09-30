import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateBatch } from '../src/validate.ts';

// Two known devices: one of each interval type.
const devices = new Map<string, number>([
  ['dev-00001', 15],
  ['dev-20001', 60],
]);
// A fixed "now" so the tests don't depend on the wall clock.
const now = Date.parse('2026-09-30T11:01:00Z');

const good = {
  deviceId: 'dev-00001',
  intervalStart: '2026-09-30T11:00:45Z',
  intervalSeconds: 15,
  vehicles: 7,
};

function check(body: unknown) {
  return validateBatch(body, devices, now);
}

test('accepts a valid batch and parses timestamps', () => {
  const r = check([good, { ...good, deviceId: 'dev-20001', intervalSeconds: 60, intervalStart: '2026-09-30T11:00:00Z' }]);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.readings.length, 2);
  assert.equal(r.readings[0].intervalStart.toISOString(), '2026-09-30T11:00:45.000Z');
});

test('accepts milliseconds of .000 and a timestamp within 5s of clock skew', () => {
  assert.equal(check([{ ...good, intervalStart: '2026-09-30T11:01:00.000Z' }]).ok, true);
  const skewed = validateBatch([{ ...good, intervalStart: '2026-09-30T11:01:00Z' }], devices, now - 4000);
  assert.equal(skewed.ok, true);
});

function rejects(body: unknown, index: number | null, reasonPart: string) {
  const r = check(body);
  assert.equal(r.ok, false, `expected rejection for ${JSON.stringify(body)}`);
  if (r.ok) return;
  assert.equal(r.error.index, index);
  assert.match(r.error.reason, new RegExp(reasonPart));
}

test('rejects bodies that are not an array of 1-500 items', () => {
  rejects({ ...good }, null, 'array');
  rejects([], null, '1-500');
  rejects(Array(501).fill(good), null, '1-500');
});

test('accepts exactly 500 items', () => {
  assert.equal(check(Array(500).fill(good)).ok, true);
});

test('rejects items that are not objects', () => {
  rejects([good, 42], 1, 'object');
  rejects([null], 0, 'object');
});

test('rejects unknown devices', () => {
  rejects([good, { ...good, deviceId: 'dev-99999' }], 1, 'unknown deviceId');
  rejects([{ ...good, deviceId: 5 }], 0, 'deviceId');
});

test('rejects an intervalSeconds that does not match the device', () => {
  rejects([{ ...good, intervalSeconds: 60 }], 0, 'intervalSeconds');
  rejects([{ ...good, intervalSeconds: '15' }], 0, 'intervalSeconds');
});

test('rejects malformed or non-UTC timestamps', () => {
  rejects([{ ...good, intervalStart: 'yesterday' }], 0, 'ISO 8601');
  rejects([{ ...good, intervalStart: '2026-09-30T13:00:45+02:00' }], 0, 'ISO 8601');
  rejects([{ ...good, intervalStart: '2026-02-30T11:00:45Z' }], 0, 'ISO 8601');
  rejects([{ ...good, intervalStart: 1727694045000 }], 0, 'ISO 8601');
});

test('rejects timestamps not aligned to the interval', () => {
  rejects([{ ...good, intervalStart: '2026-09-30T11:00:40Z' }], 0, 'aligned');
  rejects([{ ...good, intervalStart: '2026-09-30T11:00:45.500Z' }], 0, 'aligned');
  // :30 is fine for a 15 s device but not for a 60 s device.
  rejects([{ ...good, deviceId: 'dev-20001', intervalSeconds: 60, intervalStart: '2026-09-30T11:00:30Z' }], 0, 'aligned');
});

test('rejects timestamps more than 5 s in the future', () => {
  rejects([{ ...good, intervalStart: '2026-09-30T11:01:15Z' }], 0, 'future');
});

test('rejects bad vehicle counts', () => {
  rejects([{ ...good, vehicles: -1 }], 0, 'vehicles');
  rejects([{ ...good, vehicles: 1.5 }], 0, 'vehicles');
  rejects([{ ...good, vehicles: '7' }], 0, 'vehicles');
  // Larger than a Postgres int: would be a DB error (500 → retry forever) if we let it through.
  rejects([{ ...good, vehicles: 2 ** 31 }], 0, 'vehicles');
});
