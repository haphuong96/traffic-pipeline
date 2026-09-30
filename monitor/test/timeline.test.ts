import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLog, summarize, windowLength } from '../src/timeline.ts';

const t0 = Date.parse('2026-09-30T14:00:00Z');

/** A simulator metrics line for the window ending at t (printed 3 ms late, like the real one). */
function line(t: number, o: { ok?: number; e5?: number; to?: number; buf?: number; p99?: number } = {}): string {
  const ok = o.ok ?? 100;
  return (
    `[${new Date(t + 3).toISOString()}] sent=${ok} (10/s) reqs=${ok} 200=${ok} 400=0 5xx=${o.e5 ?? 0} ` +
    `timeouts=${o.to ?? 0} neterr=0 accepted=${ok} dupes=0 buffered=${o.buf ?? 2} latency p50=5ms p95=9ms p99=${o.p99 ?? 20}ms`
  );
}

test('parseLog keeps only metrics lines and reads every counter', () => {
  const ws = parseLog(['> simulator@1.0.0 start', line(t0 + 10_000, { e5: 3, buf: 40, p99: 77 }), 'dev-00001: batch rejected'].join('\r\n'));
  assert.equal(ws.length, 1);
  assert.equal(ws[0].s5xx, 3);
  assert.equal(ws[0].buffered, 40);
  assert.equal(ws[0].p99, 77);
  assert.equal(ws[0].s200, 100);
});

test('outage: error span, backlog recovery, and time from restore', () => {
  const lines = [];
  for (let i = 1; i <= 30; i++) {
    const t = t0 + i * 10_000;
    if (i >= 7 && i <= 12) lines.push(line(t, { ok: 0, e5: 50, buf: 1000 * (i - 6) })); // 14:01:00-14:02:00 down
    else if (i >= 13 && i <= 15) lines.push(line(t, { buf: 3000, p99: 900 })); // draining
    else lines.push(line(t));
  }
  const ws = parseLog(lines.join('\n'));
  assert.equal(windowLength(ws), 10_000);
  const s = summarize(ws, { restoredAt: Date.parse('2026-09-30T14:02:00Z') });
  assert.match(s, /\| 5xx \| 300 \|/);
  assert.match(s, /Errors between 14:01:00 and 14:02:00 \(1 min 00 s\), in 6 of the 30 windows/);
  assert.match(s, /back to its normal level \(≤ 2 readings\) by 14:02:40, 40 s after/);
  assert.match(s, /Restored at 14:02:00\. After that: 0 more errors; back to normal .* 40 s later/);
  assert.ok(!s.includes('Seconds past the minute'), 'no phase table for 10 s windows');
});

test('spike: 5 s windows are grouped by position within the minute', () => {
  const lines = [];
  for (let i = 1; i <= 24; i++) {
    const t = t0 + i * 5_000; // two minutes
    const start = (t - 5_000) % 60_000;
    // :00 gets the 15 s and the 60 s devices, :15/:30/:45 only the 15 s ones.
    if (start === 0) lines.push(line(t, { to: 20, p99: 5000 }));
    else if (start % 15_000 === 0) lines.push(line(t, { to: 5, p99: 2000 }));
    else lines.push(line(t));
  }
  const s = summarize(parseLog(lines.join('\n')));
  assert.match(s, /\| :00–:05 \| 2 \| 5000 \| 5000 \| 0 \| 40 \| 0 \|/);
  assert.match(s, /\| :05–:10 \| 2 \| 20 \| 20 \| 0 \| 0 \| 0 \|/);
  assert.match(s, /\| :15–:20 \| 2 \| 2000 \| 2000 \| 0 \| 10 \| 0 \|/);
  assert.match(s, /\| :55–:60 \| 2 \|/);
});

test('an empty or quiet log says so', () => {
  assert.match(summarize([]), /No simulator metrics lines/);
  const quiet = parseLog([1, 2, 3].map((i) => line(t0 + i * 10_000)).join('\n'));
  assert.match(summarize(quiet), /No 5xx, timeouts or network errors/);
  assert.match(summarize(quiet), /Every window looks normal/);
});
