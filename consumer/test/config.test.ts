import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maxReachableBatch, validateBatchMaxRows } from '../src/config.ts';

test('a batch can never exceed partitions-in-flight × Kafka batch size (6 × 1000)', () => {
  assert.equal(maxReachableBatch, 6000);
});

test('BATCH_MAX_ROWS above the reachable size is rejected instead of silently never triggering', () => {
  assert.doesNotThrow(() => validateBatchMaxRows(5000));
  assert.doesNotThrow(() => validateBatchMaxRows(6000));
  assert.throws(() => validateBatchMaxRows(6001), /at most 6000/);
});
