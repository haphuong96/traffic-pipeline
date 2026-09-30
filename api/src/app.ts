import Fastify, { LogController, type FastifyServerOptions } from 'fastify';
import { validateBatch, type Reading } from './validate.ts';
import type { InsertResult } from './store.ts';

export interface AppDeps {
  /** deviceId -> interval_seconds, loaded once at startup. */
  devices: Map<string, number>;
  /** Persists a validated batch. Injected so tests can use a fake. */
  store: (readings: Reading[]) => Promise<InsertResult>;
  /** Throws if the database is unreachable. */
  ping: () => Promise<void>;
  logger?: FastifyServerOptions['logger'];
  logRequests?: boolean;
}

export function buildApp(deps: AppDeps) {
  const app = Fastify({
    logger: deps.logger ?? true,
    logController: new LogController({ disableRequestLogging: !deps.logRequests }),
  });

  // Turning off request logging also silences Fastify's default error log,
  // so log failures (e.g. database errors behind a 500) explicitly.
  app.addHook('onError', async (request, _reply, error) => {
    request.log.error({ err: error, url: request.url }, 'request failed');
  });

  app.post('/readings', async (request, reply) => {
    const result = validateBatch(request.body, deps.devices);
    if (!result.ok) {
      // Log it: a 400 means a device (or the simulator) has a bug.
      request.log.warn({ error: result.error }, 'rejected batch');
      return reply.code(400).send(result.error);
    }

    // If this throws (database down, pool exhausted, ...) Fastify's default
    // error handler answers 500, which tells the device to retry later.
    // Duplicates are NOT errors: they mean "already stored", so 200.
    return deps.store(result.readings);
  });

  app.get('/health', async (_request, reply) => {
    try {
      await deps.ping();
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'database unavailable' });
    }
  });

  return app;
}
