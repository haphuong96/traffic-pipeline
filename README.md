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
(cd monitor && npm install)   # only needed for the long-run monitor

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

The simulator also writes the same window as JSON to `simulator/metrics-latest.json` (overwritten every 10 seconds). The monitor below reads it.

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

### Monitor (`monitor/`)

| Env var                  | Default                                             | Meaning                                         |
|--------------------------|-----------------------------------------------------|-------------------------------------------------|
| `MONITOR_INTERVAL_MIN`   | `30`                                                | Minutes between samples (fractions allowed)     |
| `DATABASE_URL`           | `postgres://traffic:traffic@localhost:5434/traffic` | Postgres connection                             |
| `POSTGRES_CONTAINER`     | _(empty)_                                           | Container for `docker stats`; empty means `docker compose ps -q postgres` |
| `SIMULATOR_METRICS_FILE` | `../simulator/metrics-latest.json`                  | Relative to `monitor/`                          |

### Simulator (`simulator/`)

| Env var              | Default                          | Meaning                                         |
|----------------------|----------------------------------|-------------------------------------------------|
| `DEVICE_COUNT`       | `1000`                           | How many devices to simulate                    |
| `DEVICE_OFFSET`      | `0`                              | Skip this many devices before starting          |
| `API_URL`            | `http://localhost:8080/readings` |                                                 |
| `REQUEST_TIMEOUT_MS` | `5000`                           | Includes time spent waiting for a free connection |
| `MAX_CONNECTIONS`    | `128`                            | Keep-alive sockets to the API                   |
| `METRICS_INTERVAL_MS`| `10000`                          | Length of a metrics window. Windows are aligned to the clock (:00–:10, :10–:20, …) |
| `METRICS_FILE`       | `metrics-latest.json`            | Latest window as JSON, relative to `simulator/`; empty disables it |
| `SEND_JITTER`        | `true`                           | `false`: send exactly on each interval boundary, with no random delay. Only for the spike test in `RESULTS.md` |

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
cd monitor && npm test
npm run typecheck           # in either package
```

## Load test

See `RESULTS.md` for the procedure and results, including the spike and database-outage tests.

Between test runs, empty the readings table so it doesn't fill the disk (this deletes all readings):

```bash
docker compose exec postgres psql -U traffic -d traffic -c "TRUNCATE raw_readings;"
```

### Long-run monitor

For runs of several hours, leave the monitor running next to the API and simulator. It takes a sample right away and then every `MONITOR_INTERVAL_MIN` minutes (default 30) until you press Ctrl+C. Each sample is appended to `monitor/metrics.csv`:

```bash
cd monitor
npm start                          # every 30 minutes
MONITOR_INTERVAL_MIN=5 npm start   # every 5 minutes
```

Each sample records:

- the time and the minutes elapsed since the monitor started
- `raw_readings` total size, table size and index size, and the approximate row count (`pg_class.reltuples`, which stays empty until autovacuum has analyzed the table once)
- the simulator's latest 10-second window, read from `simulator/metrics-latest.json`: device count, send rate, latency p50/p95/p99, 400 / 5xx / timeout / network-error counts, and buffered readings. `sim_age_s` is the file's age; if it is large, the simulator has stopped and those columns are old.
- the wall-clock time of the Grafana city-wide panel's SQL over the last 1 hour and the last 6 hours, including fetching the rows
- Postgres container CPU % and memory from `docker stats --no-stream`

If one part fails (Docker not reachable, no simulator file), its columns are left empty and the monitor keeps going. Restarting appends to the same file, but elapsed time restarts at 0. To start over, delete or move `metrics.csv`.

To turn the CSV into a Markdown table in `RESULTS.md`:

```bash
cd monitor && npm run report
```

This replaces everything between `<!-- monitor:start -->` and `<!-- monitor:end -->` in `RESULTS.md`, so you can re-run it at any time. If the markers are missing, it appends a new section.

### Summarizing a simulator log

The spike and outage tests happen over seconds, so the monitor's samples are too far apart for them. Their evidence is the simulator's own per-window log lines. Save the log with `npm start | tee ../name.log`, then:

```bash
cd monitor
npm run timeline -- ../outage.log                                    # print the summary
npm run timeline -- ../outage.log --restored 2026-09-30T14:04:00Z    # also measure recovery from this time
npm run timeline -- ../outage.log --section outage                   # write it into RESULTS.md instead
```

The summary has:

- totals of requests, 5xx, timeouts, network errors and 400s, plus the peak backlog and peak p99
- when errors started and stopped
- when the retry backlog got back to its level before the errors (`buffered` includes in-flight batches, so under load it is rarely 0)
- with `--restored`, the errors after that time and how long until everything was back to normal
- for windows of 5 s or less, p99 and errors by seconds past the minute, which shows the :00/:15/:30/:45 bursts
- a per-window table of the unusual stretches, with quiet stretches collapsed to "…"

`--section <name>` replaces the text between `<!-- name:start -->` and `<!-- name:end -->` in `RESULTS.md`. Logs saved by PowerShell (UTF-16) work too.
