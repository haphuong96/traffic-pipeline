import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextBoundary } from '../src/time.ts';
import { timeOfDayFactor, vehicleCount } from '../src/traffic.ts';
import { backoffDelay } from '../src/backoff.ts';
import { percentile } from '../src/metrics.ts';
import { deviceList } from '../src/config.ts';

const at = (iso: string) => Date.parse(iso);

test('nextBoundary returns the next aligned boundary strictly after now', () => {
  assert.equal(nextBoundary(at('2026-09-30T11:00:50Z'), 15), at('2026-09-30T11:01:00Z'));
  assert.equal(nextBoundary(at('2026-09-30T11:00:50Z'), 60), at('2026-09-30T11:01:00Z'));
  assert.equal(nextBoundary(at('2026-09-30T11:00:30.001Z'), 15), at('2026-09-30T11:00:45Z'));
  // Exactly on a boundary: that interval has only just started, so wait for the next.
  assert.equal(nextBoundary(at('2026-09-30T11:01:00Z'), 60), at('2026-09-30T11:02:00Z'));
});

test('time-of-day factor peaks at rush hours and is low overnight', () => {
  const night = timeOfDayFactor(3);
  const morning = timeOfDayFactor(8.25);
  const midday = timeOfDayFactor(13);
  const evening = timeOfDayFactor(17.75);
  assert.ok(morning > midday && evening > midday, 'rush hours beat midday');
  assert.ok(midday > night * 3, 'midday is well above night');
  assert.ok(night > 0 && night < 0.15, `night factor ${night} should be small but non-zero`);
  // Rush hour is a plateau, not a spike: 07:30 and 09:00 still busy.
  assert.ok(timeOfDayFactor(7.5) > midday && timeOfDayFactor(9) > midday);
});

test('vehicleCount scales with interval length and is a non-negative integer', () => {
  const noNoise = () => 0.25; // Box-Muller angle 2π·0.25 → cos = 0 → zero noise
  const peak = new Date(2026, 8, 30, 8, 15); // local time
  const c15 = vehicleCount(20, peak, 15, noNoise);
  const c60 = vehicleCount(20, peak, 60, noNoise);
  assert.ok(Number.isInteger(c15) && Number.isInteger(c60));
  assert.ok(Math.abs(c60 - 4 * c15) <= 2, `60s (${c60}) ≈ 4 × 15s (${c15})`);

  // Extreme negative noise must clamp to 0, never go negative.
  let calls = 0;
  // First draw → radius as large as possible, second → angle π (cos = -1).
  const worst = () => (calls++ % 2 === 0 ? 1 - 1e-12 : 0.5);
  assert.equal(vehicleCount(1, new Date(2026, 8, 30, 3, 0), 15, worst), 0);
});

test('backoffDelay grows exponentially, is capped, and is jittered', () => {
  assert.equal(backoffDelay(1, () => 1), 1000);
  assert.equal(backoffDelay(2, () => 1), 2000);
  assert.equal(backoffDelay(4, () => 1), 8000);
  assert.equal(backoffDelay(20, () => 1), 60_000);
  assert.equal(backoffDelay(3, () => 0), 0);
  assert.equal(backoffDelay(3, () => 0.5), 2000);
});

test('percentile picks nearest-rank values from a sorted list', () => {
  const xs = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(xs, 50), 50);
  assert.equal(percentile(xs, 95), 95);
  assert.equal(percentile(xs, 99), 99);
  assert.equal(percentile([7], 99), 7);
  assert.equal(percentile([], 50), 0);
});

test('deviceList follows the seed split: ≤ 20,000 → 15 s, above → 60 s', () => {
  const list = deviceList(19_998, 4);
  assert.deepEqual(list, [
    { deviceId: 'dev-19999', intervalSeconds: 15 },
    { deviceId: 'dev-20000', intervalSeconds: 15 },
    { deviceId: 'dev-20001', intervalSeconds: 60 },
    { deviceId: 'dev-20002', intervalSeconds: 60 },
  ]);
  assert.equal(deviceList(0, 3)[0].deviceId, 'dev-00001');
});
