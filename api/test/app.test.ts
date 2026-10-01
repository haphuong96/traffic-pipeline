import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp, type AppDeps } from '../src/app.ts';
import type { Reading } from '../src/validate.ts';

const devices = new Map([['dev-00001', 15]]);
const reading = { deviceId: 'dev-00001', intervalStart: '2026-01-01T11:00:45Z', intervalSeconds: 15, vehicles: 7 };

function appWith(publish: AppDeps['publish'], isReady = () => true) {
  return buildApp({ devices, publish, isReady, logger: false });
}

test('POST /readings publishes the batch and returns 200 { queued }', async () => {
  let published: Reading[] = [];
  let receivedAt: Date | undefined;
  const app = appWith(async (r, at) => {
    published = r;
    receivedAt = at;
  });
  const res = await app.inject({ method: 'POST', url: '/readings', payload: [reading, reading] });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { queued: 2 });
  assert.equal(published.length, 2);
  assert.ok(published[0].intervalStart instanceof Date);
  assert.ok(receivedAt instanceof Date);
});

test('POST /readings returns 400 naming the failing item, without publishing', async () => {
  let called = false;
  const app = appWith(async () => {
    called = true;
  });
  const res = await app.inject({ method: 'POST', url: '/readings', payload: [reading, { ...reading, vehicles: -3 }] });
  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.equal(body.index, 1);
  assert.match(body.reason, /vehicles/);
  assert.equal(called, false);
});

test('POST /readings returns 400 for malformed JSON', async () => {
  const app = appWith(async () => {});
  const res = await app.inject({
    method: 'POST', url: '/readings', payload: '[{', headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.statusCode, 400);
});

test('POST /readings returns 503 when Kafka does not confirm, so the device retries', async () => {
  const app = appWith(async () => {
    throw new Error('Local: Message timed out');
  });
  const res = await app.inject({ method: 'POST', url: '/readings', payload: [reading] });
  assert.equal(res.statusCode, 503);
});

test('GET /health follows the producer: 200 when connected, 503 when not', async () => {
  const up = appWith(async () => {}, () => true);
  assert.equal((await up.inject({ method: 'GET', url: '/health' })).statusCode, 200);
  const down = appWith(async () => {}, () => false);
  assert.equal((await down.inject({ method: 'GET', url: '/health' })).statusCode, 503);
});
