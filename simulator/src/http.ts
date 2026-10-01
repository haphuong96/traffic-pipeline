import { Agent, request } from 'undici';

/** The wire format of one reading, exactly as the API expects it. */
export interface ReadingPayload {
  deviceId: string;
  intervalStart: string;
  intervalSeconds: number;
  vehicles: number;
}

export type SendResult =
  | { kind: 'ok'; queued: number; latencyMs: number } // queued in Kafka; the consumer stores it later
  | { kind: 'rejected'; reason: string; latencyMs: number } // 400: never retry
  | { kind: 'retry'; reason: '5xx' | 'timeout' | 'network'; latencyMs: number }; // '5xx' = any non-200/400 response

export function createSender(apiUrl: string, timeoutMs: number, maxConnections: number) {
  // One shared agent for all simulated devices. Keep-alive reuses TCP
  // connections instead of opening one per request; `connections` caps how
  // many sockets we open to the API. When all are busy, requests queue
  // inside the agent, and that queueing time counts toward the timeout,
  // just as it would for a real device waiting on a slow server.
  const agent = new Agent({ connections: maxConnections, keepAliveTimeout: 30_000 });

  return async function send(batch: ReadingPayload[]): Promise<SendResult> {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    try {
      const res = await request(apiUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(batch),
        dispatcher: agent,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.body.text(); // always read the body so the socket can be reused
      const latencyMs = elapsed();
      if (res.statusCode === 200) {
        const body = JSON.parse(text) as { queued: number };
        return { kind: 'ok', queued: body.queued, latencyMs };
      }
      // Only 400 means "this data is invalid, never resend it". Anything else
      // (404 from a wrong API_URL, 429, 5xx, ...) is a problem on the server
      // side, so keep the data and retry rather than silently lose it.
      if (res.statusCode === 400) {
        return { kind: 'rejected', reason: `${res.statusCode} ${text}`, latencyMs };
      }
      return { kind: 'retry', reason: '5xx', latencyMs };
    } catch (err) {
      const latencyMs = elapsed();
      if (isTimeout(err)) return { kind: 'retry', reason: 'timeout', latencyMs };
      return { kind: 'retry', reason: 'network', latencyMs }; // refused, reset, DNS, ...
    }
  };
}

function isTimeout(err: unknown): boolean {
  const e = err as { name?: string; cause?: { name?: string } } | null;
  return e?.name === 'TimeoutError' || e?.cause?.name === 'TimeoutError';
}
