# Phase 1 — Load test results

> **Status:** the two failure tests were run on 2026-09-30 (results below). The step-by-step table is not filled in yet, but a 40,000-device baseline run already showed where Phase 1 breaks; see [Where it first degrades](#where-it-first-degrades).

## Setup

- Machine: Windows 11. _CPU / RAM / disk: fill in._
- API: `PG_POOL_SIZE=10`, single Node process (Node 20.19)
- Simulator: `REQUEST_TIMEOUT_MS=5000`, `MAX_CONNECTIONS=128`, single Node process (Node 22.23) on the same machine
- Postgres 16 in Docker inside WSL2 Ubuntu, default config apart from `mem_limit: 1g`, reached from Windows through `localhost:5434`

## Procedure

For each step, start the simulator with `DEVICE_COUNT=<n>`, let it run **at least 5 minutes**, and record the values below. Take metrics from the simulator's 10-second log lines once the first minute has passed (warm-up). Take CPU and memory from `docker stats`.

```bash
cd simulator && DEVICE_COUNT=5000 npm start | tee ../load-5000.log
docker stats --no-stream traffic-pipeline-postgres-1   # a few times during the run
```

Expected ingest: `n15/15 + n60/60` readings/s. The default split puts 15 s devices first, so up to 20,000 devices every device is a 15 s device.

### Between runs: reset the table

`raw_readings` grows by about 100,000 rows a minute at 40,000 devices, and it keeps growing into the Kafka phase. Empty it between test runs so disk space doesn't cut a later run short, and so every run starts from the same table size:

```bash
docker compose exec postgres psql -U traffic -d traffic -c "TRUNCATE raw_readings;"
```

This **deletes every reading** and cannot be undone. Save what you need first: the simulator log, `npm run timeline` / `npm run report` output, and Grafana screenshots. `TRUNCATE` frees the disk space at once, unlike `DELETE`. If the monitor is running, stop it and move `monitor/metrics.csv` aside too, so samples from different runs don't mix.

| Devices | Expected rows/min | Actual rows/min (Grafana ingest panel) | p50 / p95 / p99 (ms) | 5xx / timeouts / neterr per 10 s | Max buffered | Postgres CPU / mem | API CPU | City-wide panel load time |
|--------:|------------------:|---------------------------------------:|---------------------:|---------------------------------:|-------------:|-------------------:|--------:|--------------------------:|
| 1,000   | 4,000             |                                        |                      |                                  |              |                    |         |                           |
| 5,000   | 20,000            |                                        |                      |                                  |              |                    |         |                           |
| 10,000  | 40,000            |                                        |                      |                                  |              |                    |         |                           |
| 20,000  | 80,000            |                                        |                      |                                  |              |                    |         |                           |
| 40,000  | 100,000           |                                        |                      |                                  |              |                    |         |                           |

To time the city-wide panel, open the panel → Inspect → Query and read the request time, or run its SQL under `EXPLAIN ANALYZE`.

## Monitor samples

For long runs, `monitor/` records a sample every 30 minutes (see the README). `cd monitor && npm run report` replaces everything between the two markers below with the latest `monitor/metrics.csv`.

<!-- monitor:start -->
_No samples yet._
<!-- monitor:end -->

## Failure tests (before Kafka)

These two tests reproduce the problems Phase 2's Kafka is meant to fix, so there is a Phase 1 baseline to compare it against. Reset the table before each one (see above). Both use the simulator log as the evidence. `cd monitor && npm run timeline -- <log>` prints the summary; add `--section <name>` to write it below.

**Run at 20,000 devices, not 40,000.** The plan was 40,000, but at 40,000 the system collapses after about 70 s even with normal jitter (see [Where it first degrades](#where-it-first-degrades)). Tests at that size would only show that collapse again. They use `DEVICE_OFFSET=10000 DEVICE_COUNT=20000`: 10,000 × 15 s + 10,000 × 60 s = 833 readings/s, about half of what the API sustains, so the baseline is stable and every error is caused by the test. Run the same commands after adding Kafka, so the two phases are compared at the same load.

### Test 1: spike (no send jitter)

Normally each device waits a random 0–15 s (or 0–60 s) after its interval boundary before sending. `SEND_JITTER=false` turns that off: all 10,000 fifteen-second devices send at exactly :00, :15, :30 and :45, and at :00 the 10,000 sixty-second devices send too, so :00 gets 20,000 requests in the same instant.

5-second metrics windows put each burst at the start of its own window:

```bash
docker compose exec postgres psql -U traffic -d traffic -c "TRUNCATE raw_readings;"
cd simulator
SEND_JITTER=false DEVICE_OFFSET=10000 DEVICE_COUNT=20000 METRICS_INTERVAL_MS=5000 npm start | tee ../spike.log
# let it run at least 5 minutes, then Ctrl+C
cd ../monitor && npm run timeline -- ../spike.log --section spike
```

For comparison, run the same thing with `SEND_JITTER=true` into `../spike-jitter.log` and write it with `--section spike-jitter`.

Look at the "Seconds past the minute" table. With the spike, p99, timeouts and 5xx should concentrate in the :00–:05, :15–:20, :30–:35 and :45–:50 windows, with :00 worst. With jitter on, all rows should look the same. A timed-out request is often still inserted later, so check `dupes` in the log too.

#### Result

The spike did far more than raise p99 at the boundaries. **One burst collapsed the system for 3 min 20 s.**

| | Jitter on (baseline) | Jitter off (spike) |
|---|--:|--:|
| Errors in 5.5 min | 0 | 161,109 timeouts, 0 5xx |
| Max p99 | 62 ms | 5,013 ms (the timeout) |
| Max retry backlog | 19 readings | 166,242 readings |
| Time with zero successful requests | 0 | 3 min 20 s (15:17:05–15:20:25) |

- **15:16:30 and 15:16:45, 10,000-request bursts:** these got through with p50 about 3 s and p99 about 5 s. The API peaked at 92% of one core and Postgres at about 100% CPU.
- **15:17:00, the first :00 burst (20,000 requests):** 12,877 succeeded and the rest timed out. Their retries (backoff 0–1 s, then 0–2 s, …) plus the next burst at :15 kept the simulator's request queue more than 5 s deep. From then on every request expired in the queue before it was sent, so for 3 minutes the API and Postgres were idle while every device was failing. The "seconds past the minute" table below is flat for this reason: once collapsed, the timeouts no longer follow the bursts.
- **Recovery:** it recovered by itself at 15:20:25, when every device's retry delay had grown toward the 60 s cap. That spread the retries out enough for the queue to drain. The backlog was worked off by about 15:21:20.

What this shows about Phase 1: the API has no load shedding. A burst larger than about 5 s of capacity (≈ 10,000 requests) turns into timeouts, the timeouts turn into retries, and the retries hold the overload in place long after the burst is gone.

Caveat: here the queue sits in the simulator's one shared HTTP client (128 sockets), which is why the API went idle during the collapse. With real devices, each on its own connection, the queue would be in the API's pg pool instead. The API would then stay busy inserting batches whose devices had already given up, and the retries would show up as `dupes`.

<!-- spike:start -->
Generated by `npm run timeline` from `results/2026-09-30/spike.log`.

66 windows of 5 s, 15:16:25–15:21:56 UTC.

| | Total |
|---|--:|
| Requests | 265,127 |
| 5xx | 0 |
| Timeouts | 161,109 |
| Network errors | 0 |
| 400 | 0 |
| Max buffered readings | 166,242 |
| Max p99 (ms) | 5,013 |

- Errors between 15:16:30 and 15:21:10 (4 min 40 s), in 46 of the 66 windows.
- Retry backlog back to its normal level (≤ 10000 readings) by 15:21:21, 10 s after the last error window.

| Seconds past the minute | Windows | Median p99 (ms) | Max p99 (ms) | 5xx | Timeouts | Network errors |
|---|--:|--:|--:|--:|--:|--:|
| :00–:05 | 5 | 0 | 4948 | 0 | 14444 | 0 |
| :05–:10 | 5 | 0 | 4873 | 0 | 17955 | 0 |
| :10–:15 | 5 | 0 | 1514 | 0 | 16050 | 0 |
| :15–:20 | 5 | 0 | 5013 | 0 | 17402 | 0 |
| :20–:25 | 5 | 0 | 12 | 0 | 13659 | 0 |
| :25–:30 | 6 | 0 | 4951 | 0 | 13042 | 0 |
| :30–:35 | 6 | 1230 | 4974 | 0 | 12146 | 0 |
| :35–:40 | 6 | 16 | 1383 | 0 | 9546 | 0 |
| :40–:45 | 6 | 406 | 1494 | 0 | 9642 | 0 |
| :45–:50 | 6 | 2055 | 3767 | 0 | 13384 | 0 |
| :50–:55 | 6 | 0 | 21 | 0 | 10774 | 0 |
| :55–:60 | 5 | 0 | 1478 | 0 | 13065 | 0 |

| Window (UTC) | Sent | 200 | 5xx | Timeouts | Net err | Buffered | p50 / p95 / p99 (ms) |
|---|--:|--:|--:|--:|--:|--:|--:|
| 15:16:25–15:16:30 | 10000 | 0 | 0 | 0 | 0 | 10000 | 0 / 0 / 0 |
| 15:16:30–15:16:35 | 4 | 8108 | 0 | 128 | 0 | 1892 | 2926 / 4859 / 4974 |
| 15:16:35–15:16:40 | 1888 | 1892 | 0 | 1764 | 0 | 0 | 688 / 1210 / 1383 |
| 15:16:40–15:16:45 | 10000 | 683 | 0 | 0 | 0 | 9317 | 297 / 399 / 406 |
| 15:16:45–15:16:50 | 0 | 9317 | 0 | 0 | 0 | 0 | 2052 / 3528 / 3682 |
| 15:16:50–15:16:55 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 / 0 |
| 15:16:55–15:17:00 | 20000 | 0 | 0 | 0 | 0 | 20000 | 0 / 0 / 0 |
| 15:17:00–15:17:05 | 22 | 12877 | 0 | 200 | 0 | 7123 | 2660 / 4667 / 4944 |
| 15:17:05–15:17:10 | 6093 | 0 | 0 | 6388 | 0 | 7123 | 0 / 0 / 0 |
| 15:17:10–15:17:15 | 7991 | 0 | 0 | 5203 | 0 | 17123 | 0 / 0 / 0 |
| 15:17:15–15:17:20 | 10258 | 881 | 0 | 5598 | 0 | 16242 | 4935 / 5000 / 5013 |
| 15:17:20–15:17:25 | 7206 | 0 | 0 | 4457 | 0 | 16242 | 0 / 0 / 0 |
| 15:17:25–15:17:30 | 7446 | 0 | 0 | 3680 | 0 | 26242 | 0 / 0 / 0 |
| 15:17:30–15:17:35 | 9192 | 0 | 0 | 3568 | 0 | 26242 | 0 / 0 / 0 |
| 15:17:35–15:17:40 | 5754 | 0 | 0 | 2380 | 0 | 26242 | 0 / 0 / 0 |
| 15:17:40–15:17:45 | 8001 | 0 | 0 | 2818 | 0 | 36242 | 0 / 0 / 0 |
| 15:17:45–15:17:50 | 10116 | 0 | 0 | 3489 | 0 | 36242 | 0 / 0 / 0 |
| 15:17:50–15:17:55 | 8144 | 0 | 0 | 4183 | 0 | 36242 | 0 / 0 / 0 |
| 15:17:55–15:18:00 | 20412 | 0 | 0 | 3360 | 0 | 56242 | 0 / 0 / 0 |
| 15:18:00–15:18:05 | 17977 | 0 | 0 | 5071 | 0 | 56242 | 0 / 0 / 0 |
| 15:18:05–15:18:10 | 16259 | 0 | 0 | 4020 | 0 | 56242 | 0 / 0 / 0 |
| 15:18:10–15:18:15 | 9738 | 0 | 0 | 5130 | 0 | 66242 | 0 / 0 / 0 |
| 15:18:15–15:18:20 | 5951 | 0 | 0 | 4067 | 0 | 66242 | 0 / 0 / 0 |
| 15:18:20–15:18:25 | 9387 | 0 | 0 | 2923 | 0 | 66242 | 0 / 0 / 0 |
| 15:18:25–15:18:30 | 12084 | 0 | 0 | 2898 | 0 | 76242 | 0 / 0 / 0 |
| 15:18:30–15:18:35 | 13647 | 0 | 0 | 3243 | 0 | 76242 | 0 / 0 / 0 |
| 15:18:35–15:18:40 | 9007 | 0 | 0 | 2420 | 0 | 76242 | 0 / 0 / 0 |
| 15:18:40–15:18:45 | 8578 | 0 | 0 | 3591 | 0 | 86242 | 0 / 0 / 0 |
| 15:18:45–15:18:50 | 9282 | 0 | 0 | 5561 | 0 | 86242 | 0 / 0 / 0 |
| 15:18:50–15:18:55 | 10111 | 0 | 0 | 3845 | 0 | 86242 | 0 / 0 / 0 |
| 15:18:55–15:19:00 | 12023 | 0 | 0 | 4759 | 0 | 106242 | 0 / 0 / 0 |
| 15:19:00–15:19:05 | 16165 | 0 | 0 | 4520 | 0 | 106242 | 0 / 0 / 0 |
| 15:19:05–15:19:10 | 12723 | 0 | 0 | 2971 | 0 | 106242 | 0 / 0 / 0 |
| 15:19:10–15:19:15 | 13826 | 0 | 0 | 2574 | 0 | 116242 | 0 / 0 / 0 |
| 15:19:15–15:19:20 | 14398 | 0 | 0 | 3946 | 0 | 116242 | 0 / 0 / 0 |
| 15:19:20–15:19:25 | 15059 | 0 | 0 | 2696 | 0 | 116242 | 0 / 0 / 0 |
| 15:19:25–15:19:30 | 13249 | 0 | 0 | 3684 | 0 | 126242 | 0 / 0 / 0 |
| 15:19:30–15:19:35 | 14524 | 0 | 0 | 5207 | 0 | 126242 | 0 / 0 / 0 |
| 15:19:35–15:19:40 | 15616 | 0 | 0 | 2982 | 0 | 126242 | 0 / 0 / 0 |
| 15:19:40–15:19:45 | 17610 | 0 | 0 | 3233 | 0 | 136242 | 0 / 0 / 0 |
| 15:19:45–15:19:50 | 17819 | 0 | 0 | 4334 | 0 | 136242 | 0 / 0 / 0 |
| 15:19:50–15:19:55 | 16116 | 0 | 0 | 2746 | 0 | 136242 | 0 / 0 / 0 |
| 15:19:55–15:20:00 | 16779 | 0 | 0 | 4946 | 0 | 156242 | 0 / 0 / 0 |
| 15:20:00–15:20:05 | 18520 | 0 | 0 | 3047 | 0 | 156242 | 0 / 0 / 0 |
| 15:20:05–15:20:10 | 18558 | 0 | 0 | 3701 | 0 | 156242 | 0 / 0 / 0 |
| 15:20:10–15:20:15 | 20473 | 0 | 0 | 3143 | 0 | 166242 | 0 / 0 / 0 |
| 15:20:15–15:20:20 | 23610 | 0 | 0 | 3791 | 0 | 166242 | 0 / 0 / 0 |
| 15:20:20–15:20:25 | 23982 | 0 | 0 | 3583 | 0 | 166242 | 0 / 0 / 0 |
| 15:20:25–15:20:30 | 26413 | 4392 | 0 | 2780 | 0 | 146688 | 2584 / 4801 / 4951 |
| 15:20:30–15:20:35 | 22138 | 4028 | 0 | 0 | 0 | 117609 | 43 / 1197 / 1230 |
| 15:20:35–15:20:40 | 18920 | 2019 | 0 | 0 | 0 | 98654 | 5 / 17 / 23 |
| 15:20:40–15:20:45 | 22465 | 4675 | 0 | 0 | 0 | 92994 | 599 / 1354 / 1427 |
| 15:20:45–15:20:50 | 16890 | 3857 | 0 | 0 | 0 | 69299 | 1463 / 2015 / 2055 |
| 15:20:50–15:20:55 | 15339 | 1564 | 0 | 0 | 0 | 53979 | 5 / 14 / 21 |
| 15:20:55–15:21:00 | 29128 | 4318 | 0 | 0 | 0 | 60846 | 691 / 1392 / 1478 |
| 15:21:00–15:21:05 | 14508 | 9768 | 0 | 1606 | 0 | 51078 | 3197 / 4680 / 4948 |
| 15:21:05–15:21:10 | 12678 | 4208 | 0 | 875 | 0 | 26030 | 1614 / 4365 / 4873 |
| 15:21:10–15:21:15 | 19062 | 4149 | 0 | 0 | 0 | 25837 | 766 / 1444 / 1514 |
| 15:21:15–15:21:20 | 7184 | 6774 | 0 | 0 | 0 | 9771 | 2449 / 3417 / 3493 |
| 15:21:20–15:21:25 | 4342 | 416 | 0 | 0 | 0 | 5429 | 5 / 11 / 12 |
| 15:21:25–15:21:30 | 10999 | 3510 | 0 | 0 | 0 | 11017 | 726 / 1400 / 1494 |
| 15:21:30–15:21:35 | 742 | 6472 | 0 | 0 | 0 | 3702 | 2697 / 3811 / 3909 |
| 15:21:35–15:21:40 | 777 | 60 | 0 | 0 | 0 | 2907 | 6 / 13 / 16 |
| 15:21:40–15:21:45 | 10468 | 3609 | 0 | 0 | 0 | 8943 | 902 / 1446 / 1494 |
| 15:21:45–15:21:50 | 602 | 6391 | 0 | 0 | 0 | 1837 | 2760 / 3702 / 3767 |
| 15:21:50–15:21:55 | 581 | 50 | 0 | 0 | 0 | 1256 | 6 / 12 / 13 |
<!-- spike:end -->

<!-- spike-jitter:start -->
Generated by `npm run timeline` from `results/2026-09-30/spike-jitter.log`.

66 windows of 5 s, 15:10:35–15:16:05 UTC.

| | Total |
|---|--:|
| Requests | 264,237 |
| 5xx | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| 400 | 0 |
| Max buffered readings | 19 |
| Max p99 (ms) | 62 |

- No 5xx, timeouts or network errors.

| Seconds past the minute | Windows | Median p99 (ms) | Max p99 (ms) | 5xx | Timeouts | Network errors |
|---|--:|--:|--:|--:|--:|--:|
| :00–:05 | 6 | 18 | 22 | 0 | 0 | 0 |
| :05–:10 | 5 | 21 | 30 | 0 | 0 | 0 |
| :10–:15 | 5 | 17 | 41 | 0 | 0 | 0 |
| :15–:20 | 5 | 46 | 61 | 0 | 0 | 0 |
| :20–:25 | 5 | 25 | 47 | 0 | 0 | 0 |
| :25–:30 | 5 | 19 | 29 | 0 | 0 | 0 |
| :30–:35 | 5 | 18 | 30 | 0 | 0 | 0 |
| :35–:40 | 6 | 16 | 21 | 0 | 0 | 0 |
| :40–:45 | 6 | 15 | 19 | 0 | 0 | 0 |
| :45–:50 | 6 | 18 | 62 | 0 | 0 | 0 |
| :50–:55 | 6 | 22 | 37 | 0 | 0 | 0 |
| :55–:60 | 6 | 19 | 28 | 0 | 0 | 0 |

| Window (UTC) | Sent | 200 | 5xx | Timeouts | Net err | Buffered | p50 / p95 / p99 (ms) |
|---|--:|--:|--:|--:|--:|--:|--:|
| … | | | | | | | |
| 15:10:50–15:10:55 | 3293 | 3295 | 0 | 0 | 0 | 2 | 4 / 17 / 25 |
| 15:10:55–15:11:00 | 3340 | 3334 | 0 | 0 | 0 | 8 | 5 / 20 / 28 |
| 15:11:00–15:11:05 | 4139 | 4144 | 0 | 0 | 0 | 3 | 4 / 14 / 22 |
| … | | | | | | | |
| 15:11:10–15:11:15 | 4150 | 4148 | 0 | 0 | 0 | 4 | 4 / 14 / 28 |
| 15:11:15–15:11:20 | 4226 | 4215 | 0 | 0 | 0 | 15 | 4 / 17 / 36 |
| 15:11:20–15:11:25 | 4102 | 4115 | 0 | 0 | 0 | 2 | 4 / 18 / 26 |
| 15:11:25–15:11:30 | 4147 | 4137 | 0 | 0 | 0 | 12 | 4 / 11 / 19 |
| 15:11:30–15:11:35 | 4243 | 4250 | 0 | 0 | 0 | 5 | 4 / 16 / 30 |
| … | | | | | | | |
| 15:11:55–15:12:00 | 4099 | 4098 | 0 | 0 | 0 | 4 | 4 / 9 / 19 |
| 15:12:00–15:12:05 | 4211 | 4206 | 0 | 0 | 0 | 9 | 4 / 9 / 21 |
| 15:12:05–15:12:10 | 4076 | 4081 | 0 | 0 | 0 | 4 | 4 / 11 / 21 |
| 15:12:10–15:12:15 | 4203 | 4195 | 0 | 0 | 0 | 12 | 4 / 17 / 41 |
| 15:12:15–15:12:20 | 4126 | 4132 | 0 | 0 | 0 | 6 | 4 / 14 / 57 |
| 15:12:20–15:12:25 | 4255 | 4249 | 0 | 0 | 0 | 12 | 4 / 8 / 11 |
| 15:12:25–15:12:30 | 4121 | 4128 | 0 | 0 | 0 | 5 | 6 / 20 / 29 |
| 15:12:30–15:12:35 | 4221 | 4221 | 0 | 0 | 0 | 5 | 6 / 12 / 24 |
| 15:12:35–15:12:40 | 4125 | 4124 | 0 | 0 | 0 | 6 | 6 / 9 / 13 |
| 15:12:40–15:12:45 | 4181 | 4184 | 0 | 0 | 0 | 3 | 6 / 11 / 15 |
| 15:12:45–15:12:50 | 4121 | 4105 | 0 | 0 | 0 | 19 | 7 / 13 / 20 |
| 15:12:50–15:12:55 | 4067 | 4084 | 0 | 0 | 0 | 2 | 7 / 14 / 22 |
| 15:12:55–15:13:00 | 4303 | 4302 | 0 | 0 | 0 | 3 | 7 / 12 / 20 |
| 15:13:00–15:13:05 | 4129 | 4126 | 0 | 0 | 0 | 6 | 6 / 12 / 18 |
| 15:13:05–15:13:10 | 4220 | 4221 | 0 | 0 | 0 | 5 | 6 / 10 / 16 |
| 15:13:10–15:13:15 | 4123 | 4122 | 0 | 0 | 0 | 6 | 6 / 11 / 17 |
| 15:13:15–15:13:20 | 4200 | 4201 | 0 | 0 | 0 | 5 | 6 / 18 / 46 |
| … | | | | | | | |
| 15:13:25–15:13:30 | 4304 | 4305 | 0 | 0 | 0 | 4 | 6 / 11 / 18 |
| 15:13:30–15:13:35 | 4134 | 4130 | 0 | 0 | 0 | 8 | 6 / 12 / 18 |
| 15:13:35–15:13:40 | 4105 | 4110 | 0 | 0 | 0 | 3 | 6 / 10 / 16 |
| 15:13:40–15:13:45 | 4211 | 4207 | 0 | 0 | 0 | 7 | 6 / 10 / 16 |
| 15:13:45–15:13:50 | 4108 | 4113 | 0 | 0 | 0 | 2 | 6 / 12 / 17 |
| … | | | | | | | |
| 15:13:55–15:14:00 | 4104 | 4108 | 0 | 0 | 0 | 1 | 6 / 10 / 14 |
| 15:14:00–15:14:05 | 4183 | 4178 | 0 | 0 | 0 | 6 | 6 / 10 / 13 |
| 15:14:05–15:14:10 | 4171 | 4173 | 0 | 0 | 0 | 4 | 6 / 13 / 30 |
| 15:14:10–15:14:15 | 4138 | 4136 | 0 | 0 | 0 | 6 | 6 / 11 / 15 |
| 15:14:15–15:14:20 | 4135 | 4135 | 0 | 0 | 0 | 6 | 6 / 14 / 61 |
| 15:14:20–15:14:25 | 4187 | 4190 | 0 | 0 | 0 | 3 | 6 / 14 / 25 |
| … | | | | | | | |
| 15:14:30–15:14:35 | 4227 | 4227 | 0 | 0 | 0 | 5 | 6 / 11 / 17 |
| 15:14:35–15:14:40 | 4162 | 4157 | 0 | 0 | 0 | 10 | 6 / 11 / 16 |
| 15:14:40–15:14:45 | 4144 | 4152 | 0 | 0 | 0 | 2 | 6 / 11 / 15 |
| 15:14:45–15:14:50 | 4186 | 4181 | 0 | 0 | 0 | 7 | 6 / 10 / 14 |
| 15:14:50–15:14:55 | 4169 | 4168 | 0 | 0 | 0 | 8 | 6 / 12 / 18 |
| 15:14:55–15:15:00 | 4136 | 4141 | 0 | 0 | 0 | 3 | 6 / 10 / 16 |
| 15:15:00–15:15:05 | 4177 | 4168 | 0 | 0 | 0 | 12 | 6 / 11 / 18 |
| 15:15:05–15:15:10 | 4203 | 4213 | 0 | 0 | 0 | 2 | 6 / 10 / 17 |
| 15:15:10–15:15:15 | 4184 | 4179 | 0 | 0 | 0 | 7 | 6 / 11 / 15 |
| 15:15:15–15:15:20 | 4090 | 4078 | 0 | 0 | 0 | 19 | 6 / 12 / 19 |
| 15:15:20–15:15:25 | 4132 | 4147 | 0 | 0 | 0 | 4 | 6 / 12 / 47 |
| 15:15:25–15:15:30 | 4217 | 4215 | 0 | 0 | 0 | 6 | 6 / 11 / 18 |
| 15:15:30–15:15:35 | 4129 | 4128 | 0 | 0 | 0 | 7 | 6 / 11 / 18 |
| 15:15:35–15:15:40 | 4206 | 4211 | 0 | 0 | 0 | 2 | 6 / 13 / 21 |
| 15:15:40–15:15:45 | 4167 | 4163 | 0 | 0 | 0 | 6 | 6 / 10 / 15 |
| 15:15:45–15:15:50 | 4163 | 4159 | 0 | 0 | 0 | 10 | 6 / 10 / 18 |
| 15:15:50–15:15:55 | 4112 | 4118 | 0 | 0 | 0 | 4 | 6 / 15 / 21 |
| 15:15:55–15:16:00 | 4217 | 4215 | 0 | 0 | 0 | 6 | 6 / 13 / 19 |
| 15:16:00–15:16:05 | 4179 | 4178 | 0 | 0 | 0 | 7 | 6 / 11 / 17 |
<!-- spike-jitter:end -->

Record by hand: API CPU during the bursts (Task Manager / `top`), and Postgres CPU from `docker stats` taken during a burst. For this run, CPU samples every 2 s are in `results/2026-09-30/spike.stats.csv` and `spike-jitter.stats.csv`. With jitter on: API about 30%, Postgres about 30%. In the bursts: API up to 93%, Postgres up to 125%. In both, Postgres sessions were mostly waiting on `WALWrite` / `WALSync`.

### Test 2: database outage (Postgres down for 2 minutes)

Run with send jitter **on** (the default), so the only thing out of the ordinary is the outage. Start the simulator, let it settle, then stop Postgres for 2 minutes:

```bash
docker compose exec postgres psql -U traffic -d traffic -c "TRUNCATE raw_readings;"
cd simulator && DEVICE_OFFSET=10000 DEVICE_COUNT=20000 npm start | tee ../outage.log

# In another terminal, after at least 3 minutes of steady state. The last line prints the restore time.
docker compose stop postgres; sleep 120; docker compose start postgres; date -u +%FT%TZ

# Keep the simulator running until `buffered` is back to normal, plus a few minutes, then Ctrl+C
cd monitor && npm run timeline -- ../outage.log --restored <the time printed above> --section outage
```

What to expect: while Postgres is down, the API is still up (it has a pool error handler) and answers 500, so most errors should be `5xx`. Every device keeps its readings buffered and retries with backoff. After 2 minutes each 15 s device holds about 8 readings (at 20,000 devices, around 100,000 in total). When Postgres comes back, each device sends its whole buffer as one batch. The retry backoff is jittered (a random 0–60 s by then), so the flush is spread over up to a minute rather than one instant. The summary reports the error totals, the peak backlog, and how long after the restore everything was back to normal.

On WSL2, `docker compose stop` has to run inside Ubuntu (`wsl -e docker stop traffic-pipeline-postgres-1` from Windows). For this run, Postgres was stopped at 15:25:12 and started at 15:27:13 UTC.

#### Result

**No readings were lost**, but it took **2 min 37 s after Postgres came back** to return to normal, longer than the outage itself.

| Phase | What happened |
|---|---|
| 15:25:12–15:25:23 (first 10 s) | Fast failures: the API answered 8,688 × 500 at 130–160% CPU. |
| 15:25:23–15:27:13 (rest of the outage) | No more 500s; **every request timed out** instead (143,817 timeouts in total). The API's pg pool has no connect timeout (`connectionTimeoutMillis: 0`). Once the container was gone, new connection attempts through the WSL port forward hung rather than being refused, so the pool's 10 slots stayed occupied and every request waited behind them. |
| 15:27:13–15:28:47 (**1 min 34 s after the restore**) | Postgres was accepting connections, but the API opened **no sessions at all** (`pg_stat_activity` empty, Postgres at 0% CPU). It was still stuck on the hung attempts. Every request kept timing out and the backlog grew to 173,394 readings. |
| 15:28:47–15:29:50 | The API reconnected. Devices flushed their buffers in batches of about 5–6 readings, the backlog drained in about 1 minute, and p99 was back to 22–42 ms within 10 s. 349 duplicates from batches that had timed out but been stored anyway. |

The API CPU, Postgres CPU and `pg_stat_activity` samples behind this table (every 1–2 s) are in `results/2026-09-30/outage.stats.csv`.

Nothing lost: every full minute from 15:22 to 15:30 has exactly 50,000 rows (10,000 × 4 + 10,000 × 1), including the outage minutes. The retry buffers work.

What this shows about Phase 1: the devices are the only buffer. The API can't accept data while Postgres is down, and a hung database connection turns a 2-minute outage into 3 min 40 s of errors.

<!-- outage:start -->
Generated by `npm run timeline` from `results/2026-09-30/outage.log`.

60 windows of 10 s, 15:22:00–15:32:00 UTC.

| | Total |
|---|--:|
| Requests | 459,743 |
| 5xx | 8,688 |
| Timeouts | 143,817 |
| Network errors | 0 |
| 400 | 0 |
| Max buffered readings | 173,394 |
| Max p99 (ms) | 4,979 |

- Errors between 15:25:10 and 15:28:50 (3 min 40 s), in 22 of the 60 windows.
- Retry backlog back to its normal level (≤ 31 readings) by 15:29:50, 1 min 00 s after the last error window.
- Restored at 15:27:13. After that: 67,541 more errors; back to normal (no errors, normal backlog) 2 min 37 s later.

| Window (UTC) | Sent | 200 | 5xx | Timeouts | Net err | Buffered | p50 / p95 / p99 (ms) |
|---|--:|--:|--:|--:|--:|--:|--:|
| … | | | | | | | |
| 15:23:00–15:23:10 | 8333 | 8338 | 0 | 0 | 0 | 6 | 4 / 10 / 18 |
| 15:23:10–15:23:20 | 8340 | 8344 | 0 | 0 | 0 | 2 | 4 / 93 / 192 |
| 15:23:20–15:23:30 | 8214 | 8216 | 0 | 0 | 0 | 0 | 4 / 8 / 11 |
| … | | | | | | | |
| 15:25:00–15:25:10 | 8330 | 8335 | 0 | 0 | 0 | 5 | 6 / 15 / 32 |
| 15:25:10–15:25:20 | 13098 | 1884 | 5762 | 0 | 0 | 6523 | 1355 / 3268 / 3387 |
| 15:25:20–15:25:30 | 17674 | 0 | 2926 | 6702 | 0 | 14903 | 4182 / 4894 / 4979 |
| 15:25:30–15:25:40 | 13391 | 0 | 0 | 8341 | 0 | 23191 | 0 / 0 / 0 |
| 15:25:40–15:25:50 | 12066 | 0 | 0 | 5800 | 0 | 31565 | 0 / 0 / 0 |
| 15:25:50–15:26:00 | 15801 | 0 | 0 | 6875 | 0 | 39870 | 0 / 0 / 0 |
| 15:26:00–15:26:10 | 18157 | 0 | 0 | 7585 | 0 | 48172 | 0 / 0 / 0 |
| 15:26:10–15:26:20 | 15341 | 0 | 0 | 4950 | 0 | 56626 | 0 / 0 / 0 |
| 15:26:20–15:26:30 | 16619 | 0 | 0 | 6225 | 0 | 64945 | 0 / 0 / 0 |
| 15:26:30–15:26:40 | 23708 | 0 | 0 | 6569 | 0 | 73223 | 0 / 0 / 0 |
| 15:26:40–15:26:50 | 23693 | 0 | 0 | 7568 | 0 | 81627 | 0 / 0 / 0 |
| 15:26:50–15:27:00 | 27776 | 0 | 0 | 7458 | 0 | 89916 | 0 / 0 / 0 |
| 15:27:00–15:27:10 | 31380 | 0 | 0 | 8203 | 0 | 98298 | 0 / 0 / 0 |
| 15:27:10–15:27:20 | 28173 | 0 | 0 | 5009 | 0 | 106567 | 0 / 0 / 0 |
| 15:27:20–15:27:30 | 27347 | 0 | 0 | 6231 | 0 | 114967 | 0 / 0 / 0 |
| 15:27:30–15:27:40 | 31252 | 0 | 0 | 6972 | 0 | 123251 | 0 / 0 / 0 |
| 15:27:40–15:27:50 | 29006 | 0 | 0 | 7878 | 0 | 131662 | 0 / 0 / 0 |
| 15:27:50–15:28:00 | 36779 | 0 | 0 | 7466 | 0 | 139985 | 0 / 0 / 0 |
| 15:28:00–15:28:10 | 40242 | 0 | 0 | 8014 | 0 | 148431 | 0 / 0 / 0 |
| 15:28:10–15:28:20 | 40135 | 0 | 0 | 7812 | 0 | 156736 | 0 / 0 / 0 |
| 15:28:20–15:28:30 | 40395 | 0 | 0 | 6808 | 0 | 164992 | 0 / 0 / 0 |
| 15:28:30–15:28:40 | 44503 | 0 | 0 | 6786 | 0 | 173394 | 0 / 0 / 0 |
| 15:28:40–15:28:50 | 48166 | 5555 | 0 | 4565 | 0 | 139814 | 1707 / 4678 / 4972 |
| 15:28:50–15:29:00 | 48329 | 7756 | 0 | 0 | 0 | 99790 | 5 / 25 / 37 |
| 15:29:00–15:29:10 | 43895 | 8867 | 0 | 0 | 0 | 64340 | 4 / 11 / 22 |
| 15:29:10–15:29:20 | 36737 | 9304 | 0 | 0 | 0 | 35901 | 4 / 17 / 30 |
| 15:29:20–15:29:30 | 29364 | 9387 | 0 | 0 | 0 | 14754 | 4 / 19 / 42 |
| 15:29:30–15:29:40 | 20737 | 9198 | 0 | 0 | 0 | 2352 | 4 / 13 / 31 |
| 15:29:40–15:29:50 | 10657 | 8528 | 0 | 0 | 0 | 8 | 4 / 12 / 29 |
| … | | | | | | | |
<!-- outage:end -->

Also record:

- **Nothing lost:** once recovered, every full minute should have 50,000 rows at 20,000 devices (10,000 × 4 + 10,000 × 1), or 100,000 at 40,000. A minute with fewer means readings were lost.

  ```sql
  SELECT date_trunc('minute', interval_start) AS minute, count(*)
  FROM raw_readings
  WHERE interval_start > now() - interval '20 minutes'
  GROUP BY 1 ORDER BY 1;
  ```

- The Grafana ingest-rate panel over the outage: a gap, then a catch-up peak above the normal rate (50,000 rows/min at 20,000 devices). _Screenshot not taken for the 2026-09-30 run._
- API CPU and Postgres CPU during the catch-up, and whether the API logged anything besides the database errors.

## Where it first degrades

_Which step, and which signal moved first: latency, timeouts, buffered readings, or ingest falling behind expected?_

**Found before the step table was run: 40,000 devices is already past the limit, even with normal jitter.** Two 40,000-device baseline runs (`results/2026-09-30/baseline-40k-run1.log` and `baseline-40k-run2.log`) behaved the same way:

1. For the first ~70 s: healthy. About 1,667 readings/s as expected, p50 4 ms, p99 under 200 ms.
2. Then **throughput moved first**: successful requests dropped from about 1,670/s to about 1,280–1,570/s while devices kept sending 1,667/s. Nothing failed yet, but latency started rising steadily: p50 168 ms → 609 ms → 1.2 s → … about 0.5 s every 5 s.
3. About 70 s later, p50 reached the 5 s timeout. Timeouts and retries took over, and from then on **zero requests succeeded** and the backlog grew without limit. It never recovered while the load continued: an earlier 40,000-device no-jitter run (`results/2026-09-30/spike-40k.log`) stayed at 0 successes for 5 minutes with 490,000 readings buffered.

In run 2 the drop began at 15:08:12, one second after a timed Postgres checkpoint started (15:08:10.958). In run 1 there was no checkpoint at the moment of the drop, so a checkpoint is at most one of the triggers. The cause below holds either way: at 40,000 devices there's almost no headroom, so any small slowdown is enough to start the slide.

## Why (evidence)

_Hint: the API's pg pool (`PG_POOL_SIZE`) queues requests with no time limit, so API-side overload tends to show up as rising latency and client timeouts, not as 500s. Timed-out batches are often still inserted later, so the retries show up as `dupes`._

_E.g. API CPU pegged at 100% of one core? Pool waits (latency grows but Postgres CPU stays low)? Postgres CPU or disk I/O? The city-wide query scanning the whole table? Include `docker stats`, `top`, `pg_stat_activity`, and `EXPLAIN ANALYZE` output._

Evidence from the 2026-09-30 runs:

- **Commit-bound Postgres.** In healthy 40,000-device operation, CPU was about 45% for the simulator, 55% for the API, 50% for Postgres and 20% for the WSL port relay, so nothing was at 100%. Yet `pg_stat_activity` showed Postgres sessions almost always waiting on **`WALWrite` / `WALSync`** (for example `ClientRead:3 WALSync:1 WALWrite:8`). Every request is its own `INSERT` and its own commit, so 1,667 requests/s means about 1,667 WAL flushes/s to the WSL2 virtual disk. A 40,000-reading burst test measured the ceiling at about 2,000–2,300 inserts/s. That leaves 20–40% headroom, which a checkpoint or disk hiccup can take away.
- **Nothing sheds load, so overload doesn't end when its cause does.** The API accepts every request and queues it (the pg pool queue has no limit). Clients time out after 5 s and retry. Once the queue is more than 5 s deep, every request expires before it's served, and the retries keep the queue that deep. The API and Postgres then sit almost idle (API about 20%, Postgres about 0%, no DB sessions) while every device fails. This is the collapse in both the 40,000 baseline and the spike test.
- **The API doesn't fail fast when the database goes away.** `connectionTimeoutMillis` is 0, so pool connection attempts that hang (as they did through the WSL port forward after `docker stop`) block the pool until the OS gives up. This produced about 2 minutes of timeouts instead of 500s during the outage, and 1 min 34 s with no DB connection *after* Postgres was back.
- **What held up:** the device-side retry buffers. No readings were lost in any run, and the capped, jittered backoff eventually let the system recover (3 min 20 s after the spike collapse).

Not yet measured: the city-wide query time, and how the table size affects it.

## Notes for Phase 2

_What would fix each bottleneck? Don't implement it here._

Re-run both failure tests after adding Kafka and fill in the last column:

All Phase 1 numbers below are at 20,000 devices (`DEVICE_OFFSET=10000 DEVICE_COUNT=20000`), 2026-09-30.

| Test | Signal | Phase 1 (API → Postgres) | Phase 2 (with Kafka) |
|------|--------|--------------------------|----------------------|
| Spike, no jitter | Timeouts / 5xx in 5.5 min | 161,109 / 0 | |
| Spike, no jitter | Time with zero successful requests | 3 min 20 s | |
| Spike, no jitter | Max p99 / max backlog | 5,013 ms / 166,242 readings | |
| Outage, 2 min | 5xx + timeouts + neterr | 8,688 + 143,817 + 0 | |
| Outage, 2 min | Time from restore to normal | 2 min 37 s (1 min 34 s of it before the API reconnected) | |
| Outage, 2 min | Readings lost (minutes under 50,000 rows) | 0 | |
| Baseline, jitter on | Highest stable load | between 20,000 and 40,000 devices; collapses at 40,000 | |
| Outage, 2 min | Max consumer lag / time to drain after restore | n/a (no queue; the devices were the buffer) | |
| All | Consumer end-to-end delay p50 / max (API accepted → stored) | n/a | |
| All | Avg rows per Postgres commit | 1 request (≈ 1 reading) | |

In Phase 2 the API answers 200 once a reading is in Kafka, so database problems no longer show up as client errors. Read them in the consumer's metrics line (`lag`, `storeRetries`, `endToEndMs*`) or in kafka-ui → Consumers → `raw-writer`. The simulator log only shows the API → Kafka path now: no more `accepted` or `dupes`, just `queued`.
