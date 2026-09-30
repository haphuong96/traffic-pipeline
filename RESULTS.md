# Phase 1 — Load test results

> **Status: not run yet.** The table below is the template to fill in.

## Setup

- Machine: _CPU / RAM / disk_
- API: `PG_POOL_SIZE=10`, single Node process
- Simulator: `REQUEST_TIMEOUT_MS=5000`, `MAX_CONNECTIONS=128`, single Node process on the same machine
- Postgres 16 in Docker, default config

## Procedure

For each step, start the simulator with `DEVICE_COUNT=<n>`, let it run **at least 5 minutes**, and record the values below. Take metrics from the simulator's 10-second log lines once the first minute has passed (warm-up). Take CPU and memory from `docker stats`.

```bash
cd simulator && DEVICE_COUNT=5000 npm start | tee ../load-5000.log
docker stats --no-stream traffic-pipeline-postgres-1   # a few times during the run
```

Expected ingest: `n15/15 + n60/60` readings/s. The default split puts 15 s devices first, so up to 20,000 devices every device is a 15 s device.

| Devices | Expected rows/min | Actual rows/min (Grafana ingest panel) | p50 / p95 / p99 (ms) | 5xx / timeouts / neterr per 10 s | Max buffered | Postgres CPU / mem | API CPU | City-wide panel load time |
|--------:|------------------:|---------------------------------------:|---------------------:|---------------------------------:|-------------:|-------------------:|--------:|--------------------------:|
| 1,000   | 4,000             |                                        |                      |                                  |              |                    |         |                           |
| 5,000   | 20,000            |                                        |                      |                                  |              |                    |         |                           |
| 10,000  | 40,000            |                                        |                      |                                  |              |                    |         |                           |
| 20,000  | 80,000            |                                        |                      |                                  |              |                    |         |                           |
| 40,000  | 100,000           |                                        |                      |                                  |              |                    |         |                           |

To time the city-wide panel, open the panel → Inspect → Query and read the request time, or run its SQL under `EXPLAIN ANALYZE`.

## Where it first degrades

_Which step, and which signal moved first: latency, timeouts, buffered readings, or ingest falling behind expected?_

## Why (evidence)

_Hint: the API's pg pool (`PG_POOL_SIZE`) queues requests with no time limit, so API-side overload tends to show up as rising latency and client timeouts, not as 500s. Timed-out batches are often still inserted later, so the retries show up as `dupes`._

_E.g. API CPU pegged at 100% of one core? Pool waits (latency grows but Postgres CPU stays low)? Postgres CPU or disk I/O? The city-wide query scanning the whole table? Include `docker stats`, `top`, `pg_stat_activity`, and `EXPLAIN ANALYZE` output._

## Notes for Phase 2

_What would fix each bottleneck? Don't implement it here._
