# Traffic Pipeline — Phase 1 Implementation Plan

## Context

This is a learning project that simulates a real traffic-counting system. Road sensors ("devices") report how many vehicles passed during a fixed interval. Phase 1 builds the **simplest working pipeline** and then load-tests it to find where it breaks. Later phases add Kafka, TimescaleDB and pre-aggregation, so **do not add them now**. Feeling the limits of the simple version is the goal.

```
Node simulator  --HTTP-->  Node API  -->  Postgres  <--  Grafana
```

Keep the code simple and readable, and explain non-obvious decisions in comments. The owner is learning, so clarity beats cleverness.

## Already in place

```
traffic-pipeline/
  docker-compose.yml   # postgres:16 (traffic/traffic, db "traffic", port 5432), grafana (port 3000)
  api/                 # npm init done
  simulator/           # npm init done
```

Grafana already has a working PostgreSQL data source (host `postgres:5432`).

## Before starting, ask the user

- JavaScript or TypeScript?

Defaults if the user has no preference: Node.js 22 LTS, `pg` for Postgres, Fastify for the API, built-in `fetch`/undici for HTTP in the simulator.

## 1. Database

The Postgres volume already exists, so `docker-entrypoint-initdb.d` scripts will **not** run. Add a small migration script in `api/` (e.g. `npm run migrate`) that applies the SQL below idempotently (`CREATE TABLE IF NOT EXISTS`).

```sql
CREATE TABLE IF NOT EXISTS devices (
  device_id        text PRIMARY KEY,
  name             text,
  interval_seconds int  NOT NULL CHECK (interval_seconds IN (15, 60))
);

CREATE TABLE IF NOT EXISTS raw_readings (
  device_id      text        NOT NULL REFERENCES devices,
  interval_start timestamptz NOT NULL,
  vehicles       int         NOT NULL CHECK (vehicles >= 0),
  received_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, interval_start)
);
```

Design notes:
- The composite primary key is the idempotency key: one reading per device per interval. It also serves the main dashboard query, so no extra index is needed.
- There is no surrogate `id`: an `int` would overflow within weeks at this volume.
- `interval_seconds` lives on the device, not on each reading.

**Seed script** (`npm run seed`): insert 40,000 devices, `dev-00001` … `dev-40000`. Give the first 20,000 a 15-second interval and the rest 60 seconds. The script must be re-runnable (`ON CONFLICT DO NOTHING`).

## 2. API (`api/`)

### Endpoint

`POST /readings`: the body is a JSON array of 1–500 readings. A single reading is a batch of one.

```json
[
  {
    "deviceId": "dev-00042",
    "intervalStart": "2026-09-30T11:00:45Z",
    "intervalSeconds": 15,
    "vehicles": 7
  }
]
```

### Validation (reject the whole batch with 400 if any reading fails)

- The body is an array of 1–500 items.
- `deviceId` exists. Load all devices into an in-memory map at startup; do not query the database per reading.
- `intervalSeconds` equals that device's `interval_seconds`.
- `intervalStart` is a valid ISO 8601 UTC timestamp, **aligned** to the interval (seconds divisible by 15 for 15-second devices; `:00` seconds for 60-second devices), and not in the future (allow 5 seconds of clock skew).
- `vehicles` is an integer ≥ 0.

The 400 response body should say which item failed and why.

### Storage

- Insert the whole batch with a single multi-row `INSERT ... ON CONFLICT (device_id, interval_start) DO NOTHING RETURNING device_id, interval_start`.
- Readings not returned were duplicates. For those, check whether the stored `vehicles` differs from the incoming value. If it does, **log a warning** (a device bug, not a retry) and keep the original value.
- Use a `pg` connection pool, with the size configurable via env var.

### Responses

- **200** `{ "accepted": n, "duplicates": m }`. Duplicates are **not** errors: the device only needs to know the data is stored, and an error would make it retry forever.
- **400** for validation errors.
- **500** for database errors, so the simulator retries.

Also add `GET /health`.

## 3. Simulator (`simulator/`)

One Node process simulates all devices. Each device runs its own timer.

### Configuration (env vars or CLI flags)

- `DEVICE_COUNT` (default 1000): simulate devices `dev-00001` onward, so a small run gets a mix only if it crosses 20,000. Also support `DEVICE_OFFSET` or an explicit split, so that small runs can include both interval types.
- `API_URL` (default `http://localhost:8080/readings`)
- `REQUEST_TIMEOUT_MS` (default 5000)

### Behaviour

- Every interval, each device produces one reading with an **aligned** `intervalStart`. For example, a 15-second device sending just after 11:01:00 reports `intervalStart = 11:00:45`.
- **Send jitter:** each device waits a random delay (0 to its interval length) after the boundary before sending, so 20,000 devices don't all fire in the same millisecond. `intervalStart` stays aligned regardless of when the send happens.
- **Vehicle counts:** `base rate × time-of-day factor + random noise`, clamped to ≥ 0 and scaled to the interval length. The time-of-day factor peaks around 07:30–09:00 and 17:00–18:30 and is low overnight. Give each device a slightly different base rate.
- **Retries:** on a network error, timeout or 5xx, keep the reading in a per-device buffer and retry with exponential backoff and jitter. The next send includes all buffered readings as one batch (max 500). Do not retry on 400; log it instead.
- Use an HTTP agent with keep-alive and a sensible connection limit.

### Metrics

Every 10 seconds, log readings sent, 200s, 400s, 5xx, timeouts, buffered readings waiting to be retried, and request latency p50/p95/p99.

## 4. Grafana

Create a dashboard (manually, or provisioned from JSON committed to the repo) with:

1. **Vehicles per 1 minute** for one selected device over a chosen day (use a dashboard variable for `device_id`).
2. **Vehicles per 15 minutes** for the same device.
3. **City-wide vehicles per minute** across all devices.
4. **Ingest rate:** rows per minute by `received_at`, used to watch the load test.

Example query:

```sql
SELECT date_bin('15 minutes', interval_start, '2000-01-01') AS time,
       sum(vehicles) AS vehicles
FROM raw_readings
WHERE device_id = '$device'
  AND $__timeFilter(interval_start)
GROUP BY 1 ORDER BY 1;
```

Aggregation is computed on the fly from raw data in Phase 1. That is intentional.

## 5. Load test

Run the simulator in steps: 1,000 → 5,000 → 10,000 → 20,000 → 40,000 devices, each for at least 5 minutes. Record the following in `RESULTS.md`:

- expected vs actual ingest rate
- API latency p50/p95/p99 and error/timeout rates
- Postgres CPU and memory (`docker stats`)
- the time the city-wide Grafana panel takes to load
- where it first degrades, and the evidence for why

**Do not optimise yet.** The goal of Phase 1 is to observe and explain the breaking point. The fixes are Phase 2.

## Out of scope for Phase 1

Kafka, MQTT, TimescaleDB, aggregate tables, 1-hour devices, authentication, a dashboard API, and Java services.

## Done when

- [ ] `docker compose up`, then `migrate`, `seed`, API and simulator all run with documented commands (README).
- [ ] Duplicate submissions are stored once and return 200.
- [ ] Invalid readings return 400 with a clear reason.
- [ ] Killing and restarting the API loses no readings: the simulator buffers and retries.
- [ ] All four Grafana panels show data.
- [ ] `RESULTS.md` records the load test and the observed breaking point.
