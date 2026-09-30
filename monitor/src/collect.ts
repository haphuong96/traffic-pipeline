import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type pg from 'pg';
import { config } from './config.ts';
import { parseDockerStats, round } from './format.ts';

const exec = promisify(execFile);
// A stuck Docker daemon can hang the CLI indefinitely; don't let it stall sampling.
const DOCKER_TIMEOUT_MS = 30_000;
const MIB = 2 ** 20;

export async function tableStats(pool: pg.Pool) {
  // reltuples is -1 until the table has been vacuumed or analyzed once.
  const { rows } = await pool.query<{ total: string; table: string; index: string; reltuples: number }>(`
    SELECT pg_total_relation_size(c.oid) AS total,
           pg_table_size(c.oid)          AS table,
           pg_indexes_size(c.oid)        AS index,
           c.reltuples
    FROM pg_class c
    WHERE c.oid = 'raw_readings'::regclass`);
  const r = rows[0];
  return {
    rows_approx: r.reltuples < 0 ? null : Math.round(r.reltuples),
    total_mib: round(Number(r.total) / MIB, 1),
    table_mib: round(Number(r.table) / MIB, 1),
    index_mib: round(Number(r.index) / MIB, 1),
  };
}

/**
 * The city-wide panel's SQL from grafana/dashboard.json, with $__timeFilter
 * expanded the way Grafana's Postgres data source does it (a BETWEEN over
 * two timestamp literals). Returns the wall-clock time for the query and
 * for fetching all its rows, as Grafana would.
 */
export async function timeCityWideQuery(pool: pg.Pool, hours: number): Promise<number> {
  const to = new Date();
  const from = new Date(to.getTime() - hours * 3600_000);
  const sql = `SELECT date_bin('1 minute', interval_start, '2000-01-01 00:00:00+00') AS time,
       sum(vehicles) AS vehicles
FROM raw_readings
WHERE interval_start BETWEEN '${from.toISOString()}' AND '${to.toISOString()}'
GROUP BY 1 ORDER BY 1`;
  const started = performance.now();
  await pool.query(sql);
  return round(performance.now() - started, 1);
}

interface SimulatorFile {
  writtenAt: string;
  deviceCount: number;
  buffered: number;
  windowSeconds: number;
  readingsSent: number;
  status400: number;
  status5xx: number;
  timeouts: number;
  networkErrors: number;
  p50: number;
  p95: number;
  p99: number;
}

export async function simulatorStats() {
  const s = JSON.parse(await readFile(config.simulatorMetricsFile, 'utf8')) as SimulatorFile;
  return {
    sim_devices: s.deviceCount,
    sim_age_s: Math.round((Date.now() - Date.parse(s.writtenAt)) / 1000),
    sent_per_s: round(s.readingsSent / s.windowSeconds, 1),
    p50_ms: s.p50,
    p95_ms: s.p95,
    p99_ms: s.p99,
    status400: s.status400,
    status5xx: s.status5xx,
    timeouts: s.timeouts,
    neterr: s.networkErrors,
    buffered: s.buffered,
  };
}

let containerId: string | undefined;

async function postgresContainer(): Promise<string> {
  if (config.postgresContainer) return config.postgresContainer;
  if (!containerId) {
    const { stdout } = await exec('docker', ['compose', 'ps', '-q', 'postgres'], {
      cwd: config.repoRoot,
      timeout: DOCKER_TIMEOUT_MS,
    });
    containerId = stdout.trim();
    if (!containerId) throw new Error('`docker compose ps -q postgres` found no running container');
  }
  return containerId;
}

export async function dockerStats() {
  const id = await postgresContainer();
  let stdout: string;
  try {
    ({ stdout } = await exec('docker', ['stats', '--no-stream', '--format', '{{json .}}', id], { timeout: DOCKER_TIMEOUT_MS }));
  } catch (err) {
    containerId = undefined; // the container may have been recreated; look it up again next time
    throw err;
  }
  const s = parseDockerStats(stdout.trim());
  return { pg_cpu_pct: s.cpuPct, pg_mem_mib: s.memMib, pg_mem_pct: s.memPct };
}
