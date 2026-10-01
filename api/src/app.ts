import Fastify, { LogController, type FastifyServerOptions } from 'fastify';
import { validateBatch, type Reading } from './validate.ts';

export interface AppDeps {
  /** deviceId -> interval_seconds, loaded once at startup. */
  devices: Map<string, number>;
  /** Hands a validated batch to Kafka; resolves once Kafka confirmed it. Injected so tests can use a fake. */
  publish: (readings: Reading[], receivedAt: Date) => Promise<void>;
  /** Whether we can currently publish (drives /health). */
  isReady: () => boolean;
  logger?: FastifyServerOptions['logger'];
  logRequests?: boolean;
}

export function buildApp(deps: AppDeps) {
  const app = Fastify({
    logger: deps.logger ?? true,
    logController: new LogController({ disableRequestLogging: !deps.logRequests }),
  });

  // Turning off request logging also silences Fastify's default error log,
  // so log failures explicitly.
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

    try {
      await deps.publish(result.readings, new Date());
    } catch (err) {
      // Kafka didn't confirm in time (down or overloaded). 503 = "try again
      // later": the device keeps the readings and retries with backoff.
      request.log.error({ err }, 'publish to Kafka failed');
      return reply.code(503).send({ error: 'queue unavailable, retry later' });
    }

    // 200 means "durably queued in Kafka". The consumer writes it to Postgres
    // shortly after, and duplicates are handled there, so we can't count them here.
    return { queued: result.readings.length };
  });

  app.get('/health', async (_request, reply) => {
    if (deps.isReady()) return { status: 'ok' };
    return reply.code(503).send({ status: 'kafka unavailable' });
  });

  return app;
}
