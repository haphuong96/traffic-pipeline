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

import { Publisher, isFatalKafkaError } from '../src/publisher.ts';

test('isFatalKafkaError recognises librdkafka fatal errors only', () => {
  assert.equal(isFatalKafkaError(Object.assign(new Error('Fatal error'), { code: -150 })), true);
  assert.equal(isFatalKafkaError(Object.assign(new Error('x'), { fatal: true })), true);
  assert.equal(isFatalKafkaError(Object.assign(new Error('Local: Message timed out'), { code: -192 })), false);
  assert.equal(isFatalKafkaError(new Error('plain')), false);
});

test('a fatal producer error triggers onFatal (the API exits and gets restarted); a timeout does not', async () => {
  const fatals: unknown[] = [];
  let next: Error = Object.assign(new Error('Local: Message timed out'), { code: -192 });
  const fakeProducer = {
    connect: async () => {},
    disconnect: async () => {},
    send: async () => {
      throw next;
    },
  };
  const p = new Publisher({ brokers: [], topic: 't', produceTimeoutMs: 1000, onFatal: (e) => fatals.push(e) }, fakeProducer);
  const reading = [{ deviceId: 'd', intervalStart: new Date(), vehicles: 1 }];
  await assert.rejects(p.publish(reading, new Date()));
  assert.equal(fatals.length, 0);
  next = Object.assign(new Error('Fatal: out of order sequence number'), { code: -150 });
  await assert.rejects(p.publish(reading, new Date()));
  assert.equal(fatals.length, 1);
});
