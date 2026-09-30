import { resolve } from 'node:path';

// Configuration from environment variables. Relative paths resolve against
// the monitor/ directory, so the scripts work from any working directory.
const here = resolve(import.meta.dirname, '..');

function positiveNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got "${raw}"`);
  return n;
}

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://traffic:traffic@localhost:5434/traffic',
  // Fractional minutes are allowed, e.g. 0.5 for a quick check of the setup.
  intervalMinutes: positiveNumberEnv('MONITOR_INTERVAL_MIN', 30),
  // Empty: ask `docker compose ps -q postgres` (run from the repo root).
  postgresContainer: process.env.POSTGRES_CONTAINER ?? '',
  simulatorMetricsFile: resolve(here, process.env.SIMULATOR_METRICS_FILE || '../simulator/metrics-latest.json'),
  repoRoot: resolve(here, '..'),
  csvFile: resolve(here, 'metrics.csv'),
  resultsFile: resolve(here, '../RESULTS.md'),
};
