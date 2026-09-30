# Traffic Pipeline — Phase 1

Simulated road sensors report vehicle counts to an API that stores them in Postgres, and Grafana charts them.

```
simulator (Node) --HTTP POST /readings--> api (Fastify) --> Postgres <-- Grafana
```

Phase 1 is deliberately the simplest thing that works: no queue, no time-series extension, no pre-aggregation. The point is to load-test it and see where it breaks (see `RESULTS.md`). The design is in `phase-1-plan.md`.

## Prerequisites

- Docker with Compose
- Node.js ≥ 22.19 (TypeScript runs directly through `tsx`, so there is no build step)

## Run it

```bash
# 1. Start Postgres (host port 5434) and Grafana (host port 4000)
docker compose up -d

# 2. Install dependencies (once)
(cd api && npm install)
(cd simulator && npm install)

# 3. Create the tables, then the 40,000 devices. Both are safe to re-run.
cd api
npm run migrate
npm run seed

# 4. Start the API on :8080 (leave it running)
npm start

# 5. In another terminal, from the repo root: start the simulator (1,000 devices by default)
cd simulator
npm start
```

Every 10 seconds the simulator logs something like:

```
sent=660 (66/s) reqs=660 200=660 400=0 5xx=0 timeouts=0 neterr=0 accepted=660 dupes=0 buffered=0 latency p50=5ms p95=8ms p99=20ms
```

`sent` counts every reading in every request, including retries. `buffered` is the number of readings waiting to be retried.

### Grafana dashboard

The dashboard is committed as `grafana/dashboard.json`. Import it in either of these ways:

- **UI:** Grafana (http://localhost:4000) → Dashboards → New → Import → upload `grafana/dashboard.json`, then choose the PostgreSQL data source in the dashboard's **Data source** dropdown.
- **Script:** `GRAFANA_USER=admin GRAFANA_PASSWORD=... ./grafana/import.sh`

It has four panels: vehicles per 1 minute and per 15 minutes for the device in the **Device** box, city-wide vehicles per minute, and the ingest rate. All aggregation is computed on the fly from `raw_readings`. That is intentional in Phase 1.

## Configuration

Set these as environment variables, or put them in a `.env` file in `api/` or `simulator/`. Copy `.env.example` to `.env` to start. `npm start`, `migrate` and `seed` load it automatically, and a variable set in the shell wins over `.env`. `.env` is git-ignored.

### API (`api/`)

| Env var             | Default                                               | Meaning                                   |
|---------------------|-------------------------------------------------------|-------------------------------------------|
| `DATABASE_URL`      | `postgres://traffic:traffic@localhost:5434/traffic`   | Postgres connection                       |
| `PG_POOL_SIZE`      | `10`                                                  | Max concurrent Postgres connections       |
| `PORT`              | `8080`                                                |                                           |
| `LOG_LEVEL`         | `info`                                                |                                           |
| `LOG_REQUESTS`      | `false`                                               | One log line per request (noisy under load) |
| `SEED_DEVICE_COUNT` | `40000`                                               | Used by `npm run seed`                    |

The API loads all devices into memory at startup. **Restart it after seeding** new devices.

### Simulator (`simulator/`)

| Env var              | Default                          | Meaning                                         |
|----------------------|----------------------------------|-------------------------------------------------|
| `DEVICE_COUNT`       | `1000`                           | How many devices to simulate                    |
| `DEVICE_OFFSET`      | `0`                              | Skip this many devices before starting          |
| `API_URL`            | `http://localhost:8080/readings` |                                                 |
| `REQUEST_TIMEOUT_MS` | `5000`                           | Includes time spent waiting for a free connection |
| `MAX_CONNECTIONS`    | `128`                            | Keep-alive sockets to the API                   |
| `METRICS_INTERVAL_MS`| `10000`                          | How often metrics are logged                    |

Devices `dev-00001`…`dev-20000` report every 15 s and `dev-20001`…`dev-40000` every 60 s. To get both types in a small run, straddle the boundary:

```bash
DEVICE_OFFSET=19500 DEVICE_COUNT=1000 npm start   # 500 × 15 s + 500 × 60 s
```

The traffic model uses the simulator's **local** time of day, with rush hours at 07:30–09:00 and 17:00–18:30. Set `TZ=...` to change it.

## API

`POST /readings` takes a JSON array of 1–500 readings:

```json
[{ "deviceId": "dev-00042", "intervalStart": "2026-09-30T11:00:45Z", "intervalSeconds": 15, "vehicles": 7 }]
```

| Status | When | Body |
|--------|------|------|
| 200 | stored, including duplicates | `{ "accepted": 1, "duplicates": 0 }` |
| 400 | any reading invalid; nothing is stored | `{ "index": 0, "reason": "..." }` (`index` is `null` for body-level errors) |
| 500 | database error; the device should retry | |

A duplicate is a reading whose `(deviceId, intervalStart)` is already stored. If its vehicle count differs from the stored one, the API logs a warning, because that points to a device bug. The first value is kept.

`GET /health` returns 200 `{ "status": "ok" }`, or 503 if Postgres is unreachable.

## Tests

```bash
cd api && npm test          # needs Postgres running; uses a separate `traffic_test` database
cd simulator && npm test
npm run typecheck           # in either package
```

## Load test

See `RESULTS.md` for the procedure and results.
