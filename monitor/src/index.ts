import { appendFile, readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { dockerStats, simulatorStats, tableStats, timeCityWideQuery } from './collect.ts';
import { config } from './config.ts';
import { COLUMNS, csvHeader, csvRow, round, type Sample } from './format.ts';

// No statement timeout: a slow city-wide query is exactly what we're measuring.
const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 1, connectionTimeoutMillis: 10_000 });
// An idle connection dropped by a Postgres restart must not crash the monitor.
pool.on('error', (err) => console.warn(`postgres: ${err.message}`));
const intervalMs = config.intervalMinutes * 60_000;
const startedAt = Date.now();
let samples = 0;

/** Writes the header to a new file; refuses to append to a file with other columns. */
async function ensureCsvHeader(): Promise<void> {
  let existing = '';
  try {
    existing = await readFile(config.csvFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const firstLine = existing.split(/\r?\n/, 1)[0];
  if (firstLine === '') await writeFile(config.csvFile, csvHeader() + '\n');
  else if (firstLine !== csvHeader()) {
    throw new Error(`${config.csvFile} has different columns. Move it aside and start again.`);
  }
}

/** Node reports a refused localhost connection as an AggregateError with an empty message. */
function describe(err: unknown): string {
  const e = err as Error & { code?: string; errors?: Error[] };
  return e.message || e.code || e.errors?.map(describe).join('; ') || String(err);
}

/** Runs one collector; on failure its columns stay empty and the sample goes on. */
async function part<T extends Partial<Sample>>(name: string, fn: () => Promise<T>): Promise<T | Record<string, never>> {
  try {
    return await fn();
  } catch (err) {
    console.warn(`  ${name}: ${describe(err)}`);
    return {};
  }
}

async function takeSample(): Promise<void> {
  const now = Date.now();
  // docker stats goes first, so its CPU figure reflects the load test and
  // not the monitor's own queries.
  const docker = await part('docker stats', dockerStats);
  const sim = await part('simulator metrics', simulatorStats);
  const table = await part('table size', () => tableStats(pool));
  const city1h = await part('city-wide 1 h', async () => ({ city_1h_ms: await timeCityWideQuery(pool, 1) }));
  const city6h = await part('city-wide 6 h', async () => ({ city_6h_ms: await timeCityWideQuery(pool, 6) }));

  const sample = Object.fromEntries(COLUMNS.map((c) => [c, null])) as Sample;
  Object.assign(sample, docker, sim, table, city1h, city6h, {
    timestamp: new Date(now).toISOString(),
    elapsed_min: round((now - startedAt) / 60_000, 1),
  });
  await appendFile(config.csvFile, csvRow(sample) + '\n');
  samples++;
  console.log(
    `[${sample.timestamp}] sample ${samples}: rows≈${sample.rows_approx ?? '?'} total=${sample.total_mib ?? '?'}MiB ` +
      `city 1h=${sample.city_1h_ms ?? '?'}ms 6h=${sample.city_6h_ms ?? '?'}ms ` +
      `p99=${sample.p99_ms ?? '?'}ms pg cpu=${sample.pg_cpu_pct ?? '?'}%`,
  );
}

// Samples at start + k × interval. A sample that overruns its slot skips to
// the next future slot rather than firing twice in a row.
let slot = 0;
async function loop(): Promise<void> {
  try {
    await takeSample();
  } catch (err) {
    console.error(`sample failed: ${describe(err)}`);
  }
  slot = Math.max(slot + 1, Math.ceil((Date.now() - startedAt) / intervalMs));
  setTimeout(loop, startedAt + slot * intervalMs - Date.now());
}

process.on('SIGINT', () => {
  console.log(`\nstopped after ${samples} sample(s); data is in ${config.csvFile}`);
  void pool.end().finally(() => process.exit(0));
});

await ensureCsvHeader();
console.log(`sampling every ${config.intervalMinutes} min into ${config.csvFile} (Ctrl+C to stop)`);
void loop();
