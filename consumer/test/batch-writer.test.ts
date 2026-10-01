import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BatchWriter, type BatchWriterDeps } from '../src/batch-writer.ts';
import type { Reading } from '../src/message.ts';

/** A Kafka-like message whose value is a valid reading for `deviceId`. */
function msg(offset: number, deviceId = 'dev-00001', minute = offset) {
  const value = { deviceId, intervalStart: new Date(Date.UTC(2026, 8, 30, 0, minute)).toISOString(), vehicles: 3, receivedAt: new Date().toISOString() };
  return { offset: String(offset), value: Buffer.from(JSON.stringify(value)) };
}

/** Records every store/commit call in order, so tests can check sequencing. */
function harness(overrides: Partial<BatchWriterDeps> = {}) {
  const events: string[] = [];
  const stored: Reading[][] = [];
  const commits: { partition: number; offset: string }[][] = [];
  const deps: BatchWriterDeps = {
    maxRows: 1000,
    maxWaitMs: 10_000,
    store: async (rows) => {
      events.push(`store:${rows.length}`);
      stored.push(rows);
      return { accepted: rows.length, duplicates: 0 };
    },
    commit: async (offsets) => {
      events.push('commit');
      commits.push(offsets);
    },
    retryDelayMs: () => 1,
    log: { info() {}, warn() {}, error() {} },
    ...overrides,
  };
  return { writer: new BatchWriter(deps), events, stored, commits };
}

test('flushes as soon as the batch reaches maxRows, across partitions', async () => {
  const { writer, stored, commits } = harness({ maxRows: 3 });
  const a = writer.add(0, [msg(10), msg(11)]);
  const b = writer.add(1, [msg(7, 'dev-00002')]);
  await Promise.all([a, b]);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].length, 3);
  // Highest offset + 1 per partition: "the next message to read".
  assert.deepEqual(commits[0].sort((x, y) => x.partition - y.partition), [
    { partition: 0, offset: '12' },
    { partition: 1, offset: '8' },
  ]);
});

test('flushes a partial batch after maxWaitMs', async () => {
  const { writer, stored } = harness({ maxRows: 1000, maxWaitMs: 30 });
  const started = Date.now();
  await writer.add(0, [msg(1)]);
  assert.equal(stored.length, 1);
  assert.ok(Date.now() - started >= 25, 'should have waited for the timer');
});

test('add() resolves only after the store AND the offset commit', async () => {
  const { writer, events } = harness({ maxRows: 1 });
  await writer.add(0, [msg(1)]);
  assert.deepEqual(events, ['store:1', 'commit']);
});

test('a database outage retries the same batch until it succeeds, committing only once', async () => {
  let failures = 2;
  const { writer, events, stored } = harness({
    maxRows: 2,
    store: async (rows) => {
      events.push(`store:${rows.length}`);
      stored.push(rows);
      if (failures-- > 0) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      return { accepted: rows.length, duplicates: 0 };
    },
  });
  await writer.add(0, [msg(1), msg(2)]);
  assert.deepEqual(events, ['store:2', 'store:2', 'store:2', 'commit']);
  assert.deepEqual(stored[0], stored[2], 'the retry carries exactly the same rows');
  assert.equal(writer.metrics.storeRetries, 2);
});

test('a data error falls back to row-by-row: bad rows are skipped, good rows kept', async () => {
  const fkViolation = () => Object.assign(new Error('violates foreign key'), { code: '23503' });
  const good: string[] = [];
  const { writer, commits } = harness({
    maxRows: 3,
    store: async (rows) => {
      if (rows.some((r) => r.deviceId === 'dev-99999')) throw fkViolation();
      good.push(...rows.map((r) => r.deviceId));
      return { accepted: rows.length, duplicates: 0 };
    },
  });
  await writer.add(0, [msg(1, 'dev-00001'), msg(2, 'dev-99999'), msg(3, 'dev-00002')]);
  assert.deepEqual(good, ['dev-00001', 'dev-00002']);
  assert.equal(writer.metrics.skipped, 1);
  assert.deepEqual(commits[0], [{ partition: 0, offset: '4' }], 'offsets move past the bad row');
});

test('an unparseable message is skipped but its offset is still committed', async () => {
  const { writer, stored, commits } = harness({ maxRows: 2 });
  await writer.add(0, [msg(1), { offset: '2', value: Buffer.from('not json') }]);
  assert.equal(stored[0].length, 1);
  assert.equal(writer.metrics.skipped, 1);
  assert.deepEqual(commits[0], [{ partition: 0, offset: '3' }]);
});

test('a batch of only unparseable messages commits without touching the store', async () => {
  const { writer, events } = harness({ maxRows: 1 });
  await writer.add(0, [{ offset: '5', value: null }]);
  assert.deepEqual(events, ['commit']);
});

test('only one flush runs at a time; messages arriving meanwhile go in the next batch', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let running = 0;
  let maxRunning = 0;
  const sizes: number[] = [];
  const { writer } = harness({
    maxRows: 2,
    store: async (rows) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      sizes.push(rows.length);
      if (sizes.length === 1) await gate; // hold the first flush open
      running--;
      return { accepted: rows.length, duplicates: 0 };
    },
  });
  const first = writer.add(0, [msg(1), msg(2)]);
  await new Promise((r) => setImmediate(r));
  const second = writer.add(1, [msg(1, 'dev-00002'), msg(2, 'dev-00002')]);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(sizes, [2], 'second batch must wait for the first');
  release();
  await Promise.all([first, second]);
  assert.deepEqual(sizes, [2, 2]);
  assert.equal(maxRunning, 1);
});

test('a failed offset commit is logged, not fatal: the rows are already stored', async () => {
  const warnings: string[] = [];
  const { writer } = harness({
    maxRows: 1,
    commit: async () => {
      throw new Error('not assigned');
    },
    log: { info() {}, warn: (m: string) => warnings.push(m), error() {} },
  });
  await writer.add(0, [msg(1)]);
  assert.equal(warnings.length, 1);
});

test('flushNow() writes whatever is pending (used on shutdown)', async () => {
  const { writer, stored } = harness({ maxRows: 1000, maxWaitMs: 60_000 });
  const pending = writer.add(0, [msg(1)]);
  await writer.flushNow();
  await pending;
  assert.equal(stored.length, 1);
});

test('metrics count batches, inserted rows and duplicates', async () => {
  const { writer } = harness({
    maxRows: 2,
    store: async (rows) => ({ accepted: rows.length - 1, duplicates: 1 }),
  });
  await writer.add(0, [msg(1), msg(2)]);
  const m = writer.metrics;
  assert.equal(m.batches, 1);
  assert.equal(m.inserted, 1);
  assert.equal(m.duplicates, 1);
  assert.equal(m.flushMs.length, 1);
  assert.equal(m.endToEndMs.length, 2);
});
