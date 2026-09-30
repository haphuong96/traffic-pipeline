// Summarizes a simulator log (its per-window metrics lines) for the spike
// and outage tests: error totals, when errors started and stopped, when the
// retry backlog cleared, and latency by position in the 15 s cycle.

export interface Window {
  end: number; // ms; the log line's timestamp
  sent: number;
  reqs: number;
  s200: number;
  s400: number;
  s5xx: number;
  timeouts: number;
  neterr: number;
  buffered: number;
  p50: number;
  p95: number;
  p99: number;
}

/** Picks the metrics lines out of a simulator log; everything else is ignored. */
export function parseLog(text: string): Window[] {
  const windows: Window[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\[([^\]]+)\] sent=/.exec(line);
    if (!m) continue;
    const v: Record<string, number> = {};
    for (const [, k, n] of line.matchAll(/(\w+)=(\d+)/g)) v[k] = Number(n);
    windows.push({
      end: Date.parse(m[1]),
      sent: v.sent,
      reqs: v.reqs,
      s200: v['200'],
      s400: v['400'],
      s5xx: v['5xx'],
      timeouts: v.timeouts,
      neterr: v.neterr,
      buffered: v.buffered,
      p50: v.p50,
      p95: v.p95,
      p99: v.p99,
    });
  }
  return windows;
}

const errors = (w: Window) => w.s5xx + w.timeouts + w.neterr;
const hms = (ms: number) => new Date(ms).toISOString().slice(11, 19);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

/** Log lines are printed a few ms after the window ends; snap to the grid. */
const windowStart = (w: Window, len: number) => Math.round(w.end / len) * len - len;

/**
 * `buffered` includes batches that are merely in flight, so it is rarely 0
 * under load. "Normal" is its highest value before the first error, or its
 * median if there were no errors.
 */
function normalBuffered(ws: Window[]): number {
  const firstError = ws.findIndex((w) => errors(w) > 0);
  if (firstError === -1) return median(ws.map((w) => w.buffered));
  return Math.max(0, ...ws.slice(0, firstError).map((w) => w.buffered));
}

/** The typical gap between log lines, i.e. METRICS_INTERVAL_MS, rounded to 1 s. */
export function windowLength(ws: Window[]): number {
  const gaps = ws.slice(1).map((w, i) => w.end - ws[i].end);
  return Math.max(1000, Math.round(median(gaps) / 1000) * 1000);
}

export interface Options {
  /** When Postgres (or the API) came back, to measure recovery from. */
  restoredAt?: number;
}

export function summarize(ws: Window[], opts: Options = {}): string {
  if (ws.length === 0) return '_No simulator metrics lines found in the log._';
  const len = windowLength(ws);
  const sum = (f: (w: Window) => number, from = ws) => from.reduce((a, w) => a + f(w), 0);
  const out: string[] = [];

  out.push(
    `${ws.length} windows of ${len / 1000} s, ${hms(windowStart(ws[0], len))}–${hms(ws[ws.length - 1].end)} UTC.`,
    '',
    '| | Total |',
    '|---|--:|',
    `| Requests | ${sum((w) => w.reqs).toLocaleString('en-US')} |`,
    `| 5xx | ${sum((w) => w.s5xx).toLocaleString('en-US')} |`,
    `| Timeouts | ${sum((w) => w.timeouts).toLocaleString('en-US')} |`,
    `| Network errors | ${sum((w) => w.neterr).toLocaleString('en-US')} |`,
    `| 400 | ${sum((w) => w.s400).toLocaleString('en-US')} |`,
    `| Max buffered readings | ${Math.max(...ws.map((w) => w.buffered)).toLocaleString('en-US')} |`,
    `| Max p99 (ms) | ${Math.max(...ws.map((w) => w.p99)).toLocaleString('en-US')} |`,
    '',
  );

  const errorWindows = ws.filter((w) => errors(w) > 0);
  const normal = normalBuffered(ws);
  if (errorWindows.length > 0) {
    const first = errorWindows[0];
    const last = errorWindows[errorWindows.length - 1];
    const lastIdx = ws.indexOf(last);
    // Recovered: the first window after the last error whose backlog is back
    // to its level before the errors.
    const cleared = ws.slice(lastIdx + 1).find((w) => w.buffered <= normal);
    out.push(
      `- Errors between ${hms(windowStart(first, len))} and ${hms(windowStart(last, len) + len)} ` +
        `(${duration(windowStart(last, len) + len - windowStart(first, len))}), in ${errorWindows.length} of the ${ws.length} windows.`,
    );
    out.push(
      cleared
        ? `- Retry backlog back to its normal level (≤ ${normal} readings) by ${hms(cleared.end)}, ${duration(cleared.end - last.end)} after the last error window.`
        : '- The retry backlog never cleared before the log ended.',
    );
    if (opts.restoredAt !== undefined) {
      const after = ws.filter((w) => windowStart(w, len) + len > opts.restoredAt!);
      out.push(
        `- Restored at ${hms(opts.restoredAt)}. After that: ${sum(errors, after).toLocaleString('en-US')} more errors; ` +
          (cleared ? `back to normal (no errors, normal backlog) ${duration(cleared.end - opts.restoredAt)} later.` : 'not recovered by the end of the log.'),
      );
    }
    out.push('');
  } else out.push('- No 5xx, timeouts or network errors.', '');

  // Where the windows divide a 15 s cycle, group them by position within the
  // minute. With send jitter off, the load lands in the first window after
  // :00/:15/:30/:45, and :00 carries the 60 s devices too.
  if (len < 15_000 && 15_000 % len === 0) {
    out.push(
      '| Seconds past the minute | Windows | Median p99 (ms) | Max p99 (ms) | 5xx | Timeouts | Network errors |',
      '|---|--:|--:|--:|--:|--:|--:|',
    );
    for (let offset = 0; offset < 60_000; offset += len) {
      const group = ws.filter((w) => windowStart(w, len) % 60_000 === offset);
      if (group.length === 0) continue;
      out.push(
        `| :${String(offset / 1000).padStart(2, '0')}–:${String((offset + len) / 1000).padStart(2, '0')} | ${group.length} | ${median(group.map((w) => w.p99))} | ` +
          `${Math.max(...group.map((w) => w.p99))} | ${sum((w) => w.s5xx, group)} | ${sum((w) => w.timeouts, group)} | ${sum((w) => w.neterr, group)} |`,
      );
    }
    out.push('');
  }

  out.push(timelineTable(ws, len));
  return out.join('\n');
}

/**
 * Per-window rows around the interesting parts (errors, a backlog, or a p99
 * well above normal), with one window of context on each side. Quiet
 * stretches are collapsed to "…".
 */
function timelineTable(ws: Window[], len: number): string {
  const normalP99 = median(ws.map((w) => w.p99));
  const normal = normalBuffered(ws);
  const interesting = ws.map((w) => errors(w) > 0 || w.buffered > normal || w.p99 > 3 * normalP99 + 5);
  const show = ws.map((_, i) => interesting[i] || interesting[i - 1] || interesting[i + 1]);
  if (!show.some(Boolean)) return '_Every window looks normal: no errors, no backlog, no p99 outliers._';

  const lines = [
    '| Window (UTC) | Sent | 200 | 5xx | Timeouts | Net err | Buffered | p50 / p95 / p99 (ms) |',
    '|---|--:|--:|--:|--:|--:|--:|--:|',
  ];
  let gap = false;
  ws.forEach((w, i) => {
    if (!show[i]) {
      if (!gap) lines.push('| … | | | | | | | |');
      gap = true;
      return;
    }
    gap = false;
    lines.push(
      `| ${hms(windowStart(w, len))}–${hms(windowStart(w, len) + len)} | ${w.sent} | ${w.s200} | ${w.s5xx} | ${w.timeouts} | ${w.neterr} | ${w.buffered} | ${w.p50} / ${w.p95} / ${w.p99} |`,
    );
  });
  return lines.join('\n');
}
