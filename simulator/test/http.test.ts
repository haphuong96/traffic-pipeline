import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSender } from '../src/http.ts';

// A real local HTTP server whose behaviour depends on the path.
const server = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    if (req.url === '/ok') return res.end(JSON.stringify({ accepted: 2, duplicates: 1 }));
    if (req.url === '/bad') return res.writeHead(400).end('{"reason":"nope"}');
    if (req.url === '/boom') return res.writeHead(500).end();
    if (req.url === '/missing') return res.writeHead(404).end();
    // '/hang': never answer
  });
});
await new Promise<void>((r) => server.listen(0, r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

const batch = [{ deviceId: 'dev-00001', intervalStart: '2026-09-30T11:00:00Z', intervalSeconds: 15, vehicles: 1 }];

test('classifies 200, 400 and 5xx responses', async () => {
  assert.deepEqual({ ...(await createSender(`${base}/ok`, 1000, 2)(batch)), latencyMs: 0 },
    { kind: 'ok', accepted: 2, duplicates: 1, latencyMs: 0 });
  const bad = await createSender(`${base}/bad`, 1000, 2)(batch);
  assert.equal(bad.kind, 'rejected');
  const boom = await createSender(`${base}/boom`, 1000, 2)(batch);
  assert.deepEqual([boom.kind, boom.kind === 'retry' && boom.reason], ['retry', '5xx']);
});

test('classifies a slow server as a timeout', async () => {
  const r = await createSender(`${base}/hang`, 150, 2)(batch);
  assert.deepEqual([r.kind, r.kind === 'retry' && r.reason], ['retry', 'timeout']);
  assert.ok(r.latencyMs >= 140);
});

test('classifies a refused connection as a network error', async () => {
  const r = await createSender('http://127.0.0.1:1/readings', 1000, 2)(batch);
  assert.deepEqual([r.kind, r.kind === 'retry' && r.reason], ['retry', 'network']);
});

test('only a 400 is permanent: other 4xx (e.g. a wrong API_URL → 404) are retried', async () => {
  const r = await createSender(`${base}/missing`, 1000, 2)(batch);
  assert.equal(r.kind, 'retry');
});
