import { rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { config, deviceList } from './config.ts';
import { SimDevice, type Clock } from './device.ts';
import { createSender } from './http.ts';
import { Metrics } from './metrics.ts';

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    setTimeout(fn, ms);
  },
};

const metrics = new Metrics();
const send = createSender(config.apiUrl, config.requestTimeoutMs, config.maxConnections);
const specs = deviceList(config.deviceOffset, config.deviceCount);

// All devices live in this one process; each has its own timer. Node handles
// tens of thousands of timers easily because they're just entries in a heap.
const devices = specs.map(
  (spec) =>
    new SimDevice(
      // Each sensor sits on a different road: 10-30 vehicles/minute at peak.
      { ...spec, baseRatePerMinute: 10 + Math.random() * 20, sendJitter: config.sendJitter },
      { clock: realClock, send, metrics, random: Math.random, log: (msg) => console.warn(msg) },
    ),
);

const fifteens = specs.filter((s) => s.intervalSeconds === 15).length;
const expectedPerSecond = fifteens / 15 + (specs.length - fifteens) / 60;
console.log(
  `simulating ${specs.length} devices (${fifteens} × 15 s, ${specs.length - fifteens} × 60 s) → ${config.apiUrl}\n` +
    `expected ingest: ${expectedPerSecond.toFixed(1)} readings/s = ${Math.round(expectedPerSecond * 60)} readings/min` +
    (config.sendJitter ? '' : '\nsend jitter OFF: all devices send exactly on their interval boundaries'),
);
for (const d of devices) d.start();

const metricsFile = config.metricsFile && resolve(import.meta.dirname, '..', config.metricsFile);
let metricsFileWarned = false;

/** Write via a temp file and rename, so a reader never sees half a file. */
async function writeMetricsFile(data: object): Promise<void> {
  if (!metricsFile) return;
  try {
    const tmp = `${metricsFile}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
    await rename(tmp, metricsFile);
    metricsFileWarned = false;
  } catch (err) {
    // On Windows the rename can fail while a reader has the file open; the
    // next window will overwrite it anyway, so warn once and carry on.
    if (!metricsFileWarned) console.warn(`could not write ${metricsFile}: ${(err as Error).message}`);
    metricsFileWarned = true;
  }
}

const windowSeconds = config.metricsIntervalMs / 1000;
function reportWindow(): void {
  const s = metrics.snapshot();
  metrics.reset();
  const buffered = devices.reduce((sum, d) => sum + d.bufferedCount, 0);
  console.log(
    `[${new Date().toISOString()}] ` +
      `sent=${s.readingsSent} (${(s.readingsSent / windowSeconds).toFixed(0)}/s) reqs=${s.requests} ` +
      `200=${s.status200} 400=${s.status400} 5xx=${s.status5xx} timeouts=${s.timeouts} neterr=${s.networkErrors} ` +
      `queued=${s.queued} buffered=${buffered} ` +
      `latency p50=${s.p50}ms p95=${s.p95}ms p99=${s.p99}ms`,
  );
  void writeMetricsFile({
    writtenAt: new Date().toISOString(),
    windowSeconds,
    deviceCount: specs.length,
    buffered,
    ...s,
  });
}

// Windows are aligned to the wall clock (with the default 10 s: :00-:10,
// :10-:20, ...), so a burst at a known second always lands in a known window.
// The first window is partial.
setTimeout(() => {
  reportWindow();
  setInterval(reportWindow, config.metricsIntervalMs);
}, config.metricsIntervalMs - (Date.now() % config.metricsIntervalMs));
