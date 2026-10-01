# Phase 2 — Kafka between the API and Postgres

Status: draft for review · 2026-10-01

## Why

The Phase 1 load tests (`RESULTS.md`) found two problems:

1. **One commit per request.** Each `POST /readings` is its own `INSERT` and its own commit, so it needs its own WAL flush. Postgres sessions mostly waited on `WALWrite` / `WALSync`, and the ceiling was about 2,000–2,300 inserts/s. 40,000 devices need 1,667/s, which leaves almost no headroom.
2. **Nothing sheds load, so a slowdown becomes a collapse.** Requests queue in the pg pool without limit. Clients time out after 5 s and retry, and the retries keep the queue deeper than the timeout. Useful throughput drops to zero, both after a send spike and during a database outage.

Phase 2 puts Kafka between the API and Postgres. Ingestion (API → Kafka) is decoupled from storage (Kafka → consumer → Postgres), and the consumer writes in large batches, one commit per batch. Kafka was chosen over a plain queue because telemetry benefits from **replay** and **multiple consumers** of the same stream (e.g. an aggregator in a later phase).

## Goals

- At 40,000 devices with normal jitter, readings are stored steadily, with no collapse.
- A 2-minute Postgres outage causes **no client errors**: the API keeps accepting and the backlog waits in Kafka.
- Still no lost readings.
- Re-run the Phase 1 tests (spike, outage, 40k baseline) at the same load, and fill in the Phase 2 column of `RESULTS.md`.

## Non-goals

- **Load shedding in the API** (e.g. 503 + `Retry-After` when overloaded). We deliberately measure Kafka on its own first; shedding is the next step if the spike test still collapses.
- TimescaleDB, aggregate tables, a dead-letter topic, authentication, multiple brokers.
- Schema changes. `raw_readings` and `devices` stay as they are.

## Architecture

```
simulator --HTTP--> api --produce--> Kafka topic "readings" --consume--> consumer --batch INSERT--> Postgres <-- Grafana
                    (validate,        (6 partitions,                    (group "raw-writer")
                     ack after Kafka)  key = deviceId)
```

Infrastructure is already in `docker-compose.yml`: a single KRaft broker, external listener `localhost:9094`, the `readings` topic with 6 partitions created by `kafka-init`, 24 h retention, and kafka-ui on `:8081`.

### Kafka client

`@confluentinc/kafka-javascript` (Confluent's official client, built on librdkafka) through its KafkaJS-compatible promise API. It is maintained and has prebuilt binaries for Linux and Windows. The API ran on Node 20.19 on Windows in Phase 1, so check during implementation that a prebuilt binary installs there; if not, run the API on Node 22.

## Message format

- **Topic:** `readings`
- **Key:** `deviceId`. Each device always lands on the same partition, so its readings stay in order.
- **Value:** JSON, one reading per message:

  ```json
  { "deviceId": "dev-00042", "intervalStart": "2026-09-30T11:00:45Z", "vehicles": 7, "receivedAt": "2026-09-30T11:00:52.123Z" }
  ```

  `receivedAt` is when the API accepted the reading. It is not stored in Postgres; the consumer uses it to log end-to-end delay (API receipt → stored). `intervalSeconds` is not included: the API already checked it, and the table doesn't store it.

## API changes (`api/`)

- **Validation is unchanged.** The same rules and the same in-memory device map, loaded from Postgres once at startup. If any reading is invalid, the whole batch gets 400.
- **Storage:** instead of inserting, the API produces one message per reading, with the whole batch in a single `producer.send()` call. Producer settings:
  - `acks = all`
  - idempotence on (so internal producer retries can't duplicate or reorder within a partition)
  - `compression = lz4`
  - `linger.ms = 5` (small batching across concurrent requests)
  - delivery timeout `PRODUCE_TIMEOUT_MS`, default 3000, kept below the simulator's 5 s request timeout
- **Responses:**
  - **200 `{ "queued": n }`** once Kafka has acknowledged every message in the batch. 200 now means "durably queued", not "stored". The API can no longer report duplicates, because those are found later by the consumer.
  - **400** for validation errors, unchanged.
  - **503** if the produce fails or times out (Kafka down or overloaded), so the device keeps the readings and retries. Phase 1 returned 500 for database errors. 503 is more accurate here, and the simulator retries on any non-400 status anyway.
- **`GET /health`:** 200 when the producer is connected, otherwise 503. The API no longer talks to Postgres after startup, so the health check doesn't either.
- **Startup:** load devices, connect the producer, then listen. **Shutdown:** stop accepting requests, wait for in-flight requests, then disconnect the producer, which flushes pending messages.
- **Removed from the API:** `store.ts` (it moves to the consumer) and the per-request use of the pg pool. The pool is now used only to load devices, so it is created with a size of 1 and closed after startup.
- `migrate` and `seed` stay in `api/`.

New API env vars:

| Var | Default |
|---|---|
| `KAFKA_BROKERS` | `localhost:9094` |
| `KAFKA_TOPIC` | `readings` |
| `PRODUCE_TIMEOUT_MS` | `3000` |

`PG_POOL_SIZE` is removed.

## Consumer (new `consumer/` package)

A separate Node + TypeScript package in the same style as `api/` and `simulator/`: `tsx`, `node:test`, an optional `.env`.

### Behaviour

1. Join consumer group `raw-writer` and subscribe to `readings`. Auto-commit is **off**.
2. **Accumulate** messages into an in-memory batch until it holds `BATCH_MAX_ROWS` (default 5,000) or `BATCH_MAX_WAIT_MS` (default 500) has passed since the first message, whichever comes first.
3. **Flush:** write the batch to `raw_readings` with **one** multi-row `INSERT … ON CONFLICT (device_id, interval_start) DO NOTHING RETURNING …`, in one transaction. This is `insertReadings` moved over from the API, including the warning when a duplicate has a different vehicle count. At 3 parameters per row, Postgres' limit of 65,535 parameters caps a statement at 21,845 rows, so `BATCH_MAX_ROWS` is rejected at startup if it is above 20,000.
4. **Only after the Postgres commit**, commit the Kafka offsets: for each partition in the batch, the highest offset + 1.
5. While a flush is in progress, consumption is **paused**. The in-memory batch never grows beyond `BATCH_MAX_ROWS`, and only one flush runs at a time.

### Delivery guarantee

**At-least-once delivery, idempotent storage.**
- If the consumer crashes after the Postgres commit but before the offset commit, the batch is redelivered. `ON CONFLICT DO NOTHING` absorbs it, and the rows count as duplicates.
- If the consumer crashes before the Postgres commit, nothing was stored and nothing was committed, so the batch is simply consumed again.
- If partitions are revoked (a rebalance), any batch not yet flushed is discarded without committing. The new owner of the partitions re-reads those messages from Kafka.

### Errors

| Failure | Handling |
|---|---|
| **Postgres unreachable or erroring** (connection refused, timeout, server shutting down, etc.) | Keep the same batch. Retry it with exponential backoff and jitter (1 s → capped at 30 s) and stay paused until it succeeds. Never skip it. The backlog waits in Kafka and consumer lag grows. The pg pool uses `connectionTimeoutMillis = 5000`, so a dead database fails fast instead of hanging; that hang is what kept the API stuck for 1 min 34 s in Phase 1. |
| **Data error in a batch** (e.g. an FK violation for a device deleted after the API validated it; SQLSTATE class 22 or 23 other than the expected conflict) | Retry the batch **one row at a time**. Insert the good rows, **log and skip** the bad ones, then commit the offsets. One bad message must never block a partition forever. A dead-letter topic is a later improvement. |
| **Unparseable message** (bad JSON or missing fields) | Log it with its partition and offset, then skip it. Its offset is committed along with the rest of the batch. |

### Metrics log, every 10 s

Batches flushed, rows inserted, duplicates, rows skipped, p50 and max flush time, p50 and max end-to-end delay (now − `receivedAt`), and consumer lag (log-end offset − committed offset, summed over partitions).

### Env vars

| Var | Default |
|---|---|
| `DATABASE_URL` | `postgres://traffic:traffic@localhost:5434/traffic` |
| `PG_POOL_SIZE` | `2` |
| `KAFKA_BROKERS` | `localhost:9094` |
| `KAFKA_TOPIC` | `readings` |
| `KAFKA_GROUP_ID` | `raw-writer` |
| `BATCH_MAX_ROWS` | `5000` |
| `BATCH_MAX_WAIT_MS` | `500` |

One consumer instance is the default. You can run up to 6, one per partition, to test scaling.

## Simulator changes

- `http.ts`: parse `{ queued }` instead of `{ accepted, duplicates }`.
- `metrics.ts` / `index.ts`: replace `accepted=… dupes=…` with `queued=…` in the 10-second log line.
- Retry behaviour is unchanged: it already retries every non-400 status, including 503.

## Observability

- **Grafana:** queries are unchanged. `received_at` still defaults to `now()` at insert time, so the **ingest panel now shows storage throughput**, i.e. what the consumer writes. The gap between it and the simulator's send rate is the backlog.
- **kafka-ui** (`http://localhost:8081`): topic throughput, and consumer-group lag for `raw-writer`.
- **Consumer log:** batch size, flush time, end-to-end delay and lag (see above).
- `RESULTS.md` gets new rows or columns for consumer lag and end-to-end delay in the re-run tests.

## Testing

- **API unit tests:** the existing validation tests are unchanged. The app tests use a **fake producer**: 200 `{queued}` on success, 503 when the producer rejects or times out, 400 without producing, `/health` reflecting the producer state.
- **Consumer unit tests, with a fake Kafka consumer and a fake store:**
  - a batch flushes at `BATCH_MAX_ROWS` and also at `BATCH_MAX_WAIT_MS`;
  - offsets are committed only after the store succeeds, and the committed offset is the highest + 1 per partition;
  - a store failure means no commit, the same batch is retried, and consumption stays paused;
  - a data error falls back to row-by-row: bad rows skipped, good rows kept;
  - an unparseable message is skipped;
  - a rebalance discards the unflushed batch.
- **Consumer DB tests:** the existing `insertReadings` tests move over and run against `traffic_test`.
- **One integration test** against the real Kafka (`localhost:9094`) and Postgres: produce readings through the API, see them in `raw_readings`; stop the consumer and restart it, see no loss and no double counting.
- **Load re-runs (manual, by you):** spike, 2-minute Postgres outage and 40k baseline, with the same commands as Phase 1. Results go in the Phase 2 column of `RESULTS.md`.

## Rollout

- Tag the current commit `phase-1` first, so the Phase 1 code can always be checked out and re-measured.
- README: a new "run it" order: `docker compose up -d` → `migrate` / `seed` → consumer → API → simulator. Also the new env vars and a short "how data flows now" section.

## Risks and open points

- **Batching inside the KafkaJS-style API.** `eachMessage` / `eachBatch` deliver per partition, and we accumulate across partitions. Pausing and resuming has to be done carefully, so the client doesn't keep fetching into memory while a flush is in progress. The implementation plan should prove this with a test before building on it.
- **Single broker:** an acknowledged message sits in the OS page cache, not on disk. A crash of the whole machine can lose recently acknowledged readings. Restarting a container cannot. This is acceptable for a learning setup and is documented.
- **Disk:** 24 h retention at 40k devices is several GB even with lz4. Watch `docker system df` during long runs.
