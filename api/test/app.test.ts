import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.ts';
import type { Reading } from '../src/validate.ts';

const devices = new Map([['dev-00001', 15]]);
const reading = { deviceId: 'dev-00001', intervalStart: '2026-01-01T11:00:45Z', intervalSeconds: 15, vehicles: 7 };

function appWith(store: (r: Reading[]) => Promise<{ accepted: number; duplicates: number }>, ping = async () => {}) {
  return buildApp({ devices, store, ping, logger: false });
}

test('POST /readings returns 200 with accepted and duplicate counts', async () => {
  let received: Reading[] = [];
  const app = appWith(async (r) => {
    received = r;
    return { accepted: 1, duplicates: 1 };
  });
  const res = await app.inject({ method: 'POST', url: '/readings', payload: [reading, reading] });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { accepted: 1, duplicates: 1 });
  assert.equal(received.length, 2);
  assert.ok(received[0].intervalStart instanceof Date);
});

test('POST /readings returns 400 naming the failing item, without touching the store', async () => {
  let called = false;
  const app = appWith(async () => {
    called = true;
    return { accepted: 0, duplicates: 0 };
  });
  const res = await app.inject({ method: 'POST', url: '/readings', payload: [reading, { ...reading, vehicles: -3 }] });
  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.equal(body.index, 1);
  assert.match(body.reason, /vehicles/);
  assert.equal(called, false);
});

test('POST /readings returns 400 for malformed JSON', async () => {
  const app = appWith(async () => ({ accepted: 0, duplicates: 0 }));
  const res = await app.inject({
    method: 'POST', url: '/readings', payload: '[{', headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.statusCode, 400);
});

test('POST /readings returns 500 when the database fails, so the device retries', async () => {
  const app = appWith(async () => {
    throw new Error('connection terminated');
  });
  const res = await app.inject({ method: 'POST', url: '/readings', payload: [reading] });
  assert.equal(res.statusCode, 500);
});

test('GET /health is 200 when the database answers and 503 when it does not', async () => {
  const healthy = appWith(async () => ({ accepted: 0, duplicates: 0 }));
  assert.equal((await healthy.inject({ method: 'GET', url: '/health' })).statusCode, 200);

  const sick = appWith(async () => ({ accepted: 0, duplicates: 0 }), async () => {
    throw new Error('db down');
  });
  assert.equal((await sick.inject({ method: 'GET', url: '/health' })).statusCode, 503);
});
