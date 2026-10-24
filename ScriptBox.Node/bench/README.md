# Measurements

`run.ts` measures the built package through its public API: real workers, the bundled guest and real host calls. It writes every raw sample, with the environment and package versions, to `results/<label>.json`.

```sh
npm run build
node bench/run.ts                  # label: <platform>-<arch>-node<version>
node bench/run.ts --quick          # a tenth of the samples, for a smoke run
```

The container profile, from `ScriptBox.Node` after `npm ci` and `npm run build`:

```sh
docker run --rm --network none --cpus 2 --memory 1g --memory-swap 1g \
  -e BENCH_PROFILE="--cpus 2 --memory 1g, network none, package copied into the container" \
  -v "$PWD:/src:ro" -v "$PWD/bench/results:/out" \
  node@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 \
  sh -c 'cp -a /src /pkg && cd /pkg && node bench/run.ts --label linux-x64-node24.22.1-2cpu-1g && cp bench/results/*.json /out/'
```

The package is copied into the container first. Read across a bind mount from Windows, loading the modules made a cold start take about 5 seconds.

## What it measures

| Section | Samples | What |
| --- | --- | --- |
| `cold` | 10 processes | A new Node process each: create the runtime, then the first JavaScript and the first TypeScript execution. |
| `warm` | 100 JS, 50 TS, after 10 warm-up runs | `return 1`, end to end, with the worker start and TypeScript compile time from the evidence. |
| `calls` | 30 each, after 3 warm-up runs | 0, 1, 10 and 100 sequential calls of a trivial method, and 10 calls of a method that waits 2 ms. |
| `paging` | 10 each | A catalog of 10,000 items held by the host. Five pages of 50, then a full scan for comparison, with the bytes that crossed the boundary. |
| `responsiveness` | 1 each | A 5 ms heartbeat and Node's event-loop delay histogram while idle, while the guest computes for about a second, and while handlers wait on 10 x 100 ms of I/O. |
| `memory` | 10 | Guest memory after building 200,000 objects, host memory before, after and at peak, and a script that runs into a 64 MiB guest limit. |
| `cancellation` | 10 per case | From `abort()` to the outcome, for a CPU loop, endless promise jobs, a long native sort and a pending host call, then how far a 200 ms deadline overshoots. |
| `concurrency` | 10 each | The same script alone, and in two sessions at once: guest computation, and host calls with I/O. |

How the call figures are split: a single call is lost in an execution's own jitter, so the round trip per call is the slope between 1 and 100 calls. The host side per call (validation, filters, handler, result checks, evidence) comes from the evidence's `hostCallMs`. The handler's own time is measured inside the handler. What remains is the guest, JSON encoding and the worker messages.

## Results from 2026-10-24

Medians unless marked. Both on one AMD Ryzen 7 7700X. Windows 11 with Node 24.18.0 used all 16 threads. Linux used `node:24-bookworm-slim` with Node 24.22.1 under the container profile above. No run had errors. The raw samples are in `results/`.

| Measurement | Windows | Linux, 2 CPUs, 1 GiB |
| --- | --- | --- |
| Cold: a new process that runs one JavaScript and one TypeScript execution, start to exit | 523 ms | 513 ms |
| Cold: of which Node start and module loading | 165 ms | 127 ms |
| Cold: first TypeScript compile | 261 ms | 289 ms |
| Warm `return 1`, JavaScript, p50 / p95 | 23.7 / 28.3 ms | 22.6 / 25.5 ms |
| Warm: of which worker and guest start | 16.4 ms | 15.1 ms |
| Warm `return 1`, TypeScript | 26.0 ms | 25.7 ms |
| Trivial host call, round trip | 0.089 ms | 0.146 ms |
| Of which host side: validation, filters, evidence | 0.035 ms | 0.035 ms |
| Of which guest, encoding and worker messages | 0.054 ms | 0.111 ms |
| Call to a handler that waits 2 ms, excluding the handler | 0.15 ms | 0.07 ms |
| 5 pages of 50 from 10,000 items (602 KB) | 26.9 ms, 15 KB crossed | 26.5 ms, 15 KB crossed |
| Full scan, 200 pages, for comparison | 182 ms, 627 KB | 203 ms, 627 KB |
| Longest 5 ms heartbeat gap: idle / guest computing / handlers waiting | 16.5 / 16.5 / 16.6 ms | 5.7 / 5.5 / 5.9 ms |
| Event-loop delay p99 while the guest computes | 16.1 ms (timer granularity) | 1.1 ms |
| Guest memory after 200,000 objects | 36 MiB | 36 MiB |
| Host RSS peak during the memory runs | 279 MB | 325 MB |
| Script against a 64 MiB guest limit | `resource-limit` after 675 ms | `resource-limit` after 908 ms |
| Abort to outcome: CPU loop / promise jobs / native sort / pending call, max of 10 | 1.5 / 3.7 / 4.3 / 1.6 ms | 1.3 / 4.0 / 1.9 / 1.4 ms |
| Deadline overshoot, 200 ms deadline, p50 / max | 2.9 / 16.1 ms | 1.8 / 2.9 ms |
| Guest computation: alone / two sessions at once | 264 / 353 ms | 192 / 195 ms |
| Host calls with I/O: alone / two sessions at once | 327 / 342 ms | 130 / 131 ms |

The limiting resource is worker start, at about two thirds of a warm execution. Host calls and paging add little next to it. The host RSS includes the TypeScript compiler worker, which stays loaded.

## Reading the results

- On Windows, timers fire at about 15.6 ms granularity. The idle heartbeat shows the same gap as the busy ones, and a 2 ms wait takes about 15 ms. Compare a run with its own idle line, and use the Linux results for timer-sensitive numbers.
- Every execution starts a new worker. That is most of a warm execution's cost, and it is the price of terminating a stuck guest without touching the parent.
- Results are numbers from one machine on one day. They inform the next optimisation; they are not promises.
