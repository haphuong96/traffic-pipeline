import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toKafkaMessages } from '../src/publisher.ts';

test('one message per reading, keyed by deviceId, with the agreed JSON value', () => {
  const receivedAt = new Date('2026-09-30T11:00:52.123Z');
  const msgs = toKafkaMessages(
    [{ deviceId: 'dev-00042', intervalStart: new Date('2026-09-30T11:00:45Z'), vehicles: 7 }],
    receivedAt,
  );
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].key, 'dev-00042');
  assert.deepEqual(JSON.parse(msgs[0].value), {
    deviceId: 'dev-00042',
    intervalStart: '2026-09-30T11:00:45Z',
    vehicles: 7,
    receivedAt: '2026-09-30T11:00:52.123Z',
  });
});
