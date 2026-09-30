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
      { ...spec, baseRatePerMinute: 10 + Math.random() * 20 },
      { clock: realClock, send, metrics, random: Math.random, log: (msg) => console.warn(msg) },
    ),
);

const fifteens = specs.filter((s) => s.intervalSeconds === 15).length;
const expectedPerSecond = fifteens / 15 + (specs.length - fifteens) / 60;
console.log(
  `simulating ${specs.length} devices (${fifteens} × 15 s, ${specs.length - fifteens} × 60 s) → ${config.apiUrl}\n` +
    `expected ingest: ${expectedPerSecond.toFixed(1)} readings/s = ${Math.round(expectedPerSecond * 60)} readings/min`,
);
for (const d of devices) d.start();

const windowSeconds = config.metricsIntervalMs / 1000;
setInterval(() => {
  const s = metrics.snapshot();
  metrics.reset();
  const buffered = devices.reduce((sum, d) => sum + d.bufferedCount, 0);
  console.log(
    `[${new Date().toISOString()}] ` +
      `sent=${s.readingsSent} (${(s.readingsSent / windowSeconds).toFixed(0)}/s) reqs=${s.requests} ` +
      `200=${s.status200} 400=${s.status400} 5xx=${s.status5xx} timeouts=${s.timeouts} neterr=${s.networkErrors} ` +
      `accepted=${s.accepted} dupes=${s.duplicates} buffered=${buffered} ` +
      `latency p50=${s.p50}ms p95=${s.p95}ms p99=${s.p99}ms`,
  );
}, config.metricsIntervalMs);
