import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimDevice, type Clock, type SendOutcome } from '../src/device.ts';
import type { ReadingPayload } from '../src/http.ts';
import { Metrics } from '../src/metrics.ts';

/** A manual clock: timers only fire when the test calls advance(). */
class FakeClock implements Clock {
  t: number;
  timers: { at: number; fn: () => void }[] = [];
  constructor(iso: string) {
    this.t = Date.parse(iso);
  }
  now() {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number) {
    this.timers.push({ at: this.t + ms, fn });
  }
  /** Move time forward, firing due timers in order and letting promises settle. */
  async advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = next.at;
      next.fn();
      await flushPromises();
    }
    this.t = end;
    await flushPromises();
  }
}
const flushPromises = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

function makeDevice(clock: FakeClock, send: (b: ReadingPayload[]) => Promise<SendOutcome>, intervalSeconds = 15) {
  const metrics = new Metrics();
  const device = new SimDevice(
    { deviceId: 'dev-00001', intervalSeconds, baseRatePerMinute: 20 },
    { clock, send, metrics, random: () => 0.5, log: () => {} },
  );
  return { device, metrics };
}

test('sends one aligned reading per interval, after a jittered delay', async () => {
  const clock = new FakeClock('2026-09-30T11:00:50Z');
  const sent: { at: number; batch: ReadingPayload[] }[] = [];
  const { device } = makeDevice(clock, async (batch) => {
    sent.push({ at: clock.now(), batch });
    return { kind: 'ok' };
  });
  device.start();

  await clock.advance(40_000); // until 11:01:30
  // Boundaries 11:01:00 and 11:01:15, each + 7.5 s jitter (random 0.5 × 15 s).
  assert.equal(sent.length, 2);
  assert.equal(new Date(sent[0].at).toISOString(), '2026-09-30T11:01:07.500Z');
  assert.equal(sent[0].batch[0].intervalStart, '2026-09-30T11:00:45Z');
  assert.equal(sent[1].batch[0].intervalStart, '2026-09-30T11:01:00Z');
  assert.equal(sent[0].batch[0].intervalSeconds, 15);
  assert.equal(device.bufferedCount, 0);
});

test('buffers on retryable failures and resends everything in one batch once the API is back', async () => {
  const clock = new FakeClock('2026-09-30T11:00:50Z');
  let apiUp = false;
  const attempts: ReadingPayload[][] = [];
  const { device } = makeDevice(clock, async (batch) => {
    attempts.push(batch);
    return apiUp ? { kind: 'ok' } : { kind: 'retry', reason: '5xx' };
  });
  device.start();

  await clock.advance(60_000); // API down for ~4 intervals
  assert.ok(device.bufferedCount >= 3, `expected buffered readings, got ${device.bufferedCount}`);
  const waiting = device.bufferedCount;

  apiUp = true;
  await clock.advance(120_000); // long enough for the backoff (capped at 60 s) to fire
  assert.equal(device.bufferedCount, 0);

  // The first successful request carried every buffered reading at once.
  const firstOk = attempts.find((b) => b.length >= waiting)!;
  assert.ok(firstOk, 'a single batch should contain all buffered readings');
  const starts = firstOk.map((r) => r.intervalStart);
  assert.deepEqual(starts, [...starts].sort(), 'oldest first');
  assert.equal(new Set(starts).size, starts.length, 'no reading duplicated within a batch');
});

test('does not retry a 400: the batch is dropped and logged', async () => {
  const clock = new FakeClock('2026-09-30T11:00:50Z');
  let calls = 0;
  const { device, metrics } = makeDevice(clock, async () => {
    calls++;
    return { kind: 'rejected', reason: 'bad' };
  });
  device.start();
  await clock.advance(20_000); // exactly one interval's send
  assert.equal(calls, 1);
  assert.equal(device.bufferedCount, 0);
  await clock.advance(5_000);
  assert.equal(calls, 1, 'no retry after 400');
  assert.equal(metrics.snapshot().status400, 1);
});

test('never sends more than 500 readings per request', async () => {
  const clock = new FakeClock('2026-09-30T11:00:50Z');
  let apiUp = false;
  const sizes: number[] = [];
  const { device } = makeDevice(clock, async (batch) => {
    sizes.push(batch.length);
    return apiUp ? { kind: 'ok' } : { kind: 'retry', reason: 'timeout' };
  });
  device.start();
  await clock.advance(3 * 60 * 60 * 1000); // 3 hours down = 720 readings
  assert.ok(device.bufferedCount > 500);
  apiUp = true;
  await clock.advance(120_000);
  assert.equal(device.bufferedCount, 0);
  assert.ok(Math.max(...sizes) <= 500, `max batch ${Math.max(...sizes)}`);
});
