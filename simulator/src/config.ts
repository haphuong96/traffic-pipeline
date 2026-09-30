// Configuration from environment variables.
function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  return n;
}

export const config = {
  deviceCount: intEnv('DEVICE_COUNT', 1000),
  // Skip this many devices. dev-00001…dev-20000 are 15 s devices and the
  // rest are 60 s, so e.g. DEVICE_OFFSET=19500 DEVICE_COUNT=1000 gives a
  // small run with 500 of each.
  deviceOffset: intEnv('DEVICE_OFFSET', 0),
  apiUrl: process.env.API_URL ?? 'http://localhost:8080/readings',
  requestTimeoutMs: intEnv('REQUEST_TIMEOUT_MS', 5000),
  maxConnections: intEnv('MAX_CONNECTIONS', 128),
  metricsIntervalMs: intEnv('METRICS_INTERVAL_MS', 10_000),
};

/** Must match the API's seed: the first 20,000 devices report every 15 s. */
export const FIFTEEN_SECOND_DEVICES = 20_000;

export function deviceList(offset: number, count: number) {
  return Array.from({ length: count }, (_, i) => {
    const n = offset + i + 1;
    return {
      deviceId: `dev-${String(n).padStart(5, '0')}`,
      intervalSeconds: n <= FIFTEEN_SECOND_DEVICES ? 15 : 60,
    };
  });
}
