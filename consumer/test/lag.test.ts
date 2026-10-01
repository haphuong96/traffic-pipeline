import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLag } from '../src/lag.ts';
import { retryDelayMs } from '../src/backoff.ts';

test('lag = log end - committed offset, summed over partitions', () => {
  const ends = [
    { partition: 0, high: '100', low: '0' },
    { partition: 1, high: '50', low: '0' },
  ];
  const committed = [
    { partition: 0, offset: '90' },
    { partition: 1, offset: '50' },
  ];
  assert.equal(computeLag(ends, committed), 10);
});

test('a partition with no committed offset yet counts from the oldest retained message', () => {
  assert.equal(computeLag([{ partition: 0, high: '100', low: '40' }], [{ partition: 0, offset: '-1' }]), 60);
  assert.equal(computeLag([{ partition: 0, high: '100', low: '40' }], []), 60);
});

test('database retry backoff: full jitter, capped at 5 s (one consumer, so no herd to spread out)', () => {
  assert.equal(retryDelayMs(1, () => 1), 1000);
  assert.equal(retryDelayMs(3, () => 1), 4000);
  assert.equal(retryDelayMs(10, () => 1), 5000);
  assert.equal(retryDelayMs(10, () => 0), 0);
});
