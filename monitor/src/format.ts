// Pure helpers: CSV in and out, docker stats parsing, Markdown rendering.

/** metrics.csv columns, in order. An empty cell means "could not be measured". */
export const COLUMNS = [
  'timestamp', // ISO time the sample was taken
  'elapsed_min', // minutes since the monitor started
  'rows_approx', // pg_class.reltuples for raw_readings
  'total_mib', // pg_total_relation_size: table + indexes + TOAST
  'table_mib', // pg_table_size
  'index_mib', // pg_indexes_size
  'city_1h_ms', // city-wide per-minute query over the last 1 hour
  'city_6h_ms', // ... and over the last 6 hours
  'sim_devices',
  'sim_age_s', // age of the simulator's metrics file; large means the simulator stopped
  'sent_per_s', // readings sent per second in the simulator's latest window
  'p50_ms',
  'p95_ms',
  'p99_ms',
  'status400', // error counts are for the simulator's latest window (10 s by default)
  'status5xx',
  'timeouts',
  'neterr',
  'buffered',
  'pg_cpu_pct',
  'pg_mem_mib',
  'pg_mem_pct',
] as const;

export type Column = (typeof COLUMNS)[number];
export type Sample = Record<Column, string | number | null>;

function csvCell(v: string | number | null): string {
  if (v === null) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export const csvHeader = (): string => COLUMNS.join(',');
export const csvRow = (s: Sample): string => COLUMNS.map((c) => csvCell(s[c])).join(',');

/** Parses the CSV this module writes: comma-separated, optionally double-quoted. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const endCell = () => {
    row.push(cell);
    cell = '';
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') endCell();
    else if (ch === '\n') endRow();
    else if (ch !== '\r') cell += ch;
  }
  if (cell !== '' || row.length > 0) endRow();

  const nonEmpty = rows.filter((r) => !(r.length === 1 && r[0] === ''));
  const [header, ...data] = nonEmpty;
  if (!header) return [];
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

const UNITS: Record<string, number> = {
  B: 1,
  KB: 1e3,
  MB: 1e6,
  GB: 1e9,
  TB: 1e12,
  KIB: 2 ** 10,
  MIB: 2 ** 20,
  GIB: 2 ** 30,
  TIB: 2 ** 40,
};

/** "123.4MiB" or "1.2GB" → bytes, or null if unparseable. */
export function parseByteSize(s: string): number | null {
  const m = /^\s*([\d.]+)\s*([a-z]+)\s*$/i.exec(s);
  const factor = m && UNITS[m[2].toUpperCase()];
  return m && factor ? Number(m[1]) * factor : null;
}

/** The fields we use from `docker stats --no-stream --format "{{json .}}"`. */
export function parseDockerStats(json: string): { cpuPct: number | null; memMib: number | null; memPct: number | null } {
  const o = JSON.parse(json) as { CPUPerc?: string; MemUsage?: string; MemPerc?: string };
  const pct = (s?: string) => (s && Number.isFinite(parseFloat(s)) ? parseFloat(s) : null);
  const used = o.MemUsage?.split('/')[0] ?? ''; // "50.1MiB / 7.6GiB"
  const bytes = parseByteSize(used);
  return {
    cpuPct: pct(o.CPUPerc),
    memMib: bytes === null ? null : round(bytes / 2 ** 20, 1),
    memPct: pct(o.MemPerc),
  };
}

export const round = (n: number, digits: number): number => Number(n.toFixed(digits));

// ---- Markdown ----

export const START_MARKER = '<!-- monitor:start -->';
export const END_MARKER = '<!-- monitor:end -->';
// replaceSection builds the same markers for other section names.

function formatElapsed(min: string): string {
  if (min === '') return '';
  const total = Math.round(Number(min));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function formatInt(s: string): string {
  return s === '' ? '' : Math.round(Number(s)).toLocaleString('en-US');
}

function formatMib(s: string): string {
  if (s === '') return '';
  const mib = Number(s);
  return mib >= 1024 ? `${(mib / 1024).toFixed(2)} GiB` : `${mib.toFixed(1)} MiB`;
}

/** Joins related cells with " / ", or returns "" if all are empty. */
const group = (cells: string[]): string => (cells.every((c) => c === '') ? '' : cells.map((c) => c || '–').join(' / '));

export function renderTable(rows: Record<string, string>[]): string {
  const header = [
    'Elapsed (h:mm)',
    'Devices',
    'Rows (approx)',
    'Total / table / index',
    'City-wide 1 h / 6 h (ms)',
    'Sent/s',
    'p50 / p95 / p99 (ms)',
    '400 / 5xx / timeouts / neterr',
    'Buffered',
    'Postgres CPU / mem',
  ];
  const align = ['--:', '--:', '--:', '--:', '--:', '--:', '--:', '--:', '--:', '--:'];
  const lines = [`| ${header.join(' | ')} |`, `|${align.join('|')}|`];
  for (const r of rows) {
    // An old simulator file means the latency and error columns are not live.
    const stale = r.sim_age_s !== '' && Number(r.sim_age_s) > 60 ? ` (stale: ${formatInt(r.sim_age_s)} s old)` : '';
    const cells = [
      formatElapsed(r.elapsed_min),
      formatInt(r.sim_devices) + stale,
      formatInt(r.rows_approx),
      group([formatMib(r.total_mib), formatMib(r.table_mib), formatMib(r.index_mib)]),
      group([r.city_1h_ms, r.city_6h_ms]),
      r.sent_per_s,
      group([r.p50_ms, r.p95_ms, r.p99_ms]),
      group([r.status400, r.status5xx, r.timeouts, r.neterr]),
      formatInt(r.buffered),
      group([r.pg_cpu_pct && `${r.pg_cpu_pct}%`, formatMib(r.pg_mem_mib)]),
    ];
    lines.push(`| ${cells.join(' | ')} |`);
  }
  return lines.join('\n');
}

/**
 * Replaces the text between `<!-- name:start -->` and `<!-- name:end -->`
 * with `body`. If the markers are missing, appends a new section, titled
 * `heading`, that contains them.
 */
export function replaceSection(doc: string, body: string, name = 'monitor', heading = 'Monitor samples'): string {
  const startMarker = `<!-- ${name}:start -->`;
  const endMarker = `<!-- ${name}:end -->`;
  const block = `${startMarker}\n${body}\n${endMarker}`;
  const start = doc.indexOf(startMarker);
  const end = doc.indexOf(endMarker);
  if (start !== -1 && end > start) return doc.slice(0, start) + block + doc.slice(end + endMarker.length);
  return `${doc.trimEnd()}\n\n## ${heading}\n\n${block}\n`;
}
