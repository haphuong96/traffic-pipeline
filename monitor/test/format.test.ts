import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COLUMNS,
  END_MARKER,
  START_MARKER,
  csvHeader,
  csvRow,
  parseByteSize,
  parseCsv,
  parseDockerStats,
  renderTable,
  replaceSection,
  type Sample,
} from '../src/format.ts';

const empty = () => Object.fromEntries(COLUMNS.map((c) => [c, null])) as Sample;

test('CSV round-trips, with empty cells for missing values and quoting where needed', () => {
  const s = { ...empty(), timestamp: '2026-09-30T11:00:00.000Z', elapsed_min: 30, p99_ms: 12, sim_devices: 'a,"b"' };
  const text = `${csvHeader()}\r\n${csvRow(s)}\n`;
  const [row] = parseCsv(text);
  assert.equal(row.timestamp, '2026-09-30T11:00:00.000Z');
  assert.equal(row.elapsed_min, '30');
  assert.equal(row.p99_ms, '12');
  assert.equal(row.sim_devices, 'a,"b"');
  assert.equal(row.pg_cpu_pct, '');
  assert.equal(parseCsv(csvHeader() + '\n').length, 0);
});

test('docker stats sizes and percentages are parsed', () => {
  assert.equal(parseByteSize('1.5GiB'), 1.5 * 2 ** 30);
  assert.equal(parseByteSize('200kB'), 200_000);
  assert.equal(parseByteSize('n/a'), null);
  const s = parseDockerStats('{"CPUPerc":"12.34%","MemUsage":"256MiB / 7.6GiB","MemPerc":"3.29%"}');
  assert.deepEqual(s, { cpuPct: 12.34, memMib: 256, memPct: 3.29 });
});

test('renderTable formats elapsed time, sizes and groups, and flags a stale simulator file', () => {
  const row = (over: Partial<Record<string, string>>) =>
    ({ ...Object.fromEntries(COLUMNS.map((c) => [c, ''])), ...over }) as Record<string, string>;
  const table = renderTable([
    row({ elapsed_min: '90', sim_devices: '5000', sim_age_s: '4', rows_approx: '1234567', total_mib: '2048', table_mib: '1000.04', index_mib: '1048', p50_ms: '5', p95_ms: '8', p99_ms: '20' }),
    row({ elapsed_min: '120', sim_devices: '5000', sim_age_s: '600' }),
  ]);
  const lines = table.split('\n');
  assert.equal(lines.length, 4);
  assert.match(lines[2], /^\| 1:30 \| 5,000 \| 1,234,567 \| 2\.00 GiB \/ 1000\.0 MiB \/ 1\.02 GiB \| {2}\|/);
  assert.match(lines[2], /\| 5 \/ 8 \/ 20 \|/);
  assert.match(lines[3], /5,000 \(stale: 600 s old\)/);
});

test('replaceSection replaces between markers, or appends a section', () => {
  const doc = `# R\n\nbefore\n${START_MARKER}\nold\n${END_MARKER}\nafter\n`;
  assert.equal(replaceSection(doc, 'new'), `# R\n\nbefore\n${START_MARKER}\nnew\n${END_MARKER}\nafter\n`);
  assert.equal(replaceSection('# R\n', 'new'), `# R\n\n## Monitor samples\n\n${START_MARKER}\nnew\n${END_MARKER}\n`);
});
