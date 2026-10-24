// Measures the built package through its public API: real workers, real
// guest, real host calls. Writes every raw sample, with the environment, to
// bench/results/<label>.json and prints a summary.
//
//   npm run build && node bench/run.ts [--label name] [--quick]
//
// For the container profile, see bench/README.md.
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem, release, platform, arch } from 'node:os';
import { dirname, join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  createApiKit,
  createRuntime,
  Type,
  versions,
  type ExecutionOutcome,
  type JsonValue,
  type ScriptBoxRuntime,
} from '@frederik91/scriptbox';
import { CatalogStore, createCatalogApis, Draft, type Item, type RequestState } from '../examples/catalog/app.ts';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const quick = args.includes('--quick');
const scale = (n: number): number => (quick ? Math.max(3, Math.ceil(n / 10)) : n);

interface Stats { n: number; min: number; p50: number; p95: number; max: number; mean: number }

function stats(samples: readonly number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Number.NaN;
  const round = (v: number): number => Math.round(v * 1000) / 1000;
  return {
    n: sorted.length,
    min: round(sorted[0] ?? Number.NaN),
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted[sorted.length - 1] ?? Number.NaN),
    mean: round(sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length)),
  };
}

const errors: string[] = [];

function expectStatus(outcome: ExecutionOutcome, status: ExecutionOutcome['status'], what: string): ExecutionOutcome {
  if (outcome.status !== status) {
    const detail = outcome.status === 'failed' ? `${outcome.error.code}: ${outcome.error.message}` : outcome.status;
    errors.push(`${what}: expected ${status}, got ${detail}`);
  }
  return outcome;
}

// Handler time is measured inside the handler, so the bridge's share is what
// remains of a call's round trip.
let handlerMs = 0;

function benchApis() {
  const kit = createApiKit<Record<string, never>>();
  return kit.namespace({
    name: 'bench',
    description: 'Methods for measurements.',
    methods: {
      echo: kit.method({
        summary: 'Returns its argument.',
        effect: 'read',
        params: { value: Type.Unsafe<JsonValue>({}) },
        result: Type.Unsafe<JsonValue>({}),
        handler: ({ value }) => {
          const start = performance.now();
          const result = value;
          handlerMs += performance.now() - start;
          return result;
        },
      }),
      work: kit.method({
        summary: 'Waits as if doing I/O, then returns.',
        effect: 'read',
        params: { ms: Type.Integer({ minimum: 0, maximum: 10_000 }) },
        result: Type.Integer(),
        handler: async ({ ms }, call) => {
          const start = performance.now();
          await delay(ms, undefined, { signal: call.signal });
          handlerMs += performance.now() - start;
          return ms;
        },
      }),
    },
  });
}

async function timed(run: () => Promise<ExecutionOutcome>): Promise<{ ms: number; outcome: ExecutionOutcome }> {
  const start = performance.now();
  const outcome = await run();
  return { ms: performance.now() - start, outcome };
}

// One process per sample: importing the package, compiling the guest and the
// first execution of each language.
async function coldChild(): Promise<void> {
  // From process start: Node's own start and loading the package's modules.
  const t0 = performance.now();
  const runtime = await createRuntime({ apis: [benchApis()] });
  const t1 = performance.now();
  const session = runtime.createSession({ context: {}, capabilities: ['*'] });
  const js = await timed(() => session.execute({ language: 'javascript', source: 'return 1;' }));
  const ts = await timed(() => session.execute({ language: 'typescript', source: 'const n: number = 1; return n;' }));
  await session.dispose();
  await runtime.dispose();
  const evidence = ts.outcome.evidence.measurements;
  process.stdout.write(JSON.stringify({
    startupMs: t0,
    createRuntimeMs: t1 - t0,
    firstJavaScriptMs: js.ms,
    firstTypeScriptMs: ts.ms,
    firstCompileMs: evidence.compileMs,
    status: [js.outcome.status, ts.outcome.status],
  }));
}

async function cold(samples: number): Promise<Record<string, unknown>> {
  const results: Record<string, unknown>[] = [];
  for (let i = 0; i < samples; i++) {
    const startedAt = performance.now();
    // An empty environment: the child inherits no credentials. Windows needs SystemRoot to start.
    const env: Record<string, string> = process.platform === 'win32' && process.env['SystemRoot'] !== undefined ? { SystemRoot: process.env['SystemRoot'] } : {};
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--cold-child'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { out += chunk; });
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    const processMs = performance.now() - startedAt;
    if (code !== 0) {
      errors.push(`cold sample ${i}: exit ${String(code)}`);
      continue;
    }
    const parsed: unknown = JSON.parse(out);
    if (typeof parsed === 'object' && parsed !== null) {
      results.push({ ...parsed, processMs });
    }
  }
  const pick = (key: string): number[] => results.map((r) => r[key]).filter((v): v is number => typeof v === 'number');
  return {
    samples: results,
    summary: {
      processMs: stats(pick('processMs')),
      startupMs: stats(pick('startupMs')),
      createRuntimeMs: stats(pick('createRuntimeMs')),
      firstJavaScriptMs: stats(pick('firstJavaScriptMs')),
      firstTypeScriptMs: stats(pick('firstTypeScriptMs')),
      firstCompileMs: stats(pick('firstCompileMs')),
    },
  };
}

async function warm(runtime: ScriptBoxRuntime<Record<string, never>>, warmup: number, samples: number): Promise<Record<string, unknown>> {
  const session = runtime.createSession({ context: {}, capabilities: ['*'] });
  const measure = async (language: 'javascript' | 'typescript', source: string, n: number) => {
    for (let i = 0; i < warmup; i++) {
      await session.execute({ language, source });
    }
    const wall: number[] = [];
    const workerStart: number[] = [];
    const compile: number[] = [];
    for (let i = 0; i < n; i++) {
      const { ms, outcome } = await timed(() => session.execute({ language, source }));
      expectStatus(outcome, 'completed', `warm ${language}`);
      wall.push(ms);
      workerStart.push(outcome.evidence.measurements.workerStartMs ?? Number.NaN);
      if (outcome.evidence.measurements.compileMs !== null) {
        compile.push(outcome.evidence.measurements.compileMs);
      }
    }
    return { wallMs: wall, workerStartMs: workerStart, compileMs: compile, summary: { wallMs: stats(wall), workerStartMs: stats(workerStart), compileMs: stats(compile) } };
  };
  const result = {
    javascript: await measure('javascript', 'return 1;', samples),
    typescript: await measure('typescript', 'const n: number = 1; return n;', Math.ceil(samples / 2)),
  };
  await session.dispose();
  return result;
}

async function calls(runtime: ScriptBoxRuntime<Record<string, never>>, warmup: number, samples: number): Promise<Record<string, unknown>> {
  const session = runtime.createSession({ context: {}, capabilities: ['*'] });
  const run = async (count: number, method: 'echo' | 'work') => {
    const call = method === 'echo' ? 'bench.echo(i)' : 'bench.work(2)';
    const source = count === 0 ? 'return 0;' : `let s = 0; for (let i = 0; i < ${count}; i++) { s += await ${call}; } return s;`;
    for (let i = 0; i < warmup; i++) {
      await session.execute({ language: 'javascript', source, limits: { hostCalls: 1000, evidenceRecords: 1000 } });
    }
    const wall: number[] = [];
    const handler: number[] = [];
    const dispatch: number[] = [];
    for (let i = 0; i < samples; i++) {
      handlerMs = 0;
      const { ms, outcome } = await timed(() => session.execute({ language: 'javascript', source, limits: { hostCalls: 1000, evidenceRecords: 1000 } }));
      expectStatus(outcome, 'completed', `calls ${method} x${count}`);
      wall.push(ms);
      handler.push(handlerMs);
      dispatch.push(outcome.evidence.measurements.hostCallMs);
    }
    return { count, method, wallMs: wall, handlerMs: handler, hostCallMs: dispatch };
  };
  const baseline = await run(0, 'echo');
  const one = await run(1, 'echo');
  const ten = await run(10, 'echo');
  const hundred = await run(100, 'echo');
  const io = await run(10, 'work');
  await session.dispose();
  // Per call, from medians. A single call is lost in the execution's own
  // jitter, so the round trip is the slope between 1 and 100 calls. The host
  // side (validation, filters, handler, result checks, evidence) comes from
  // the evidence; the rest is the guest, encoding and worker messages.
  const p50 = (samples: readonly number[]): number => stats(samples).p50;
  const split = (roundTrip: number, series: typeof one) => {
    const host = p50(series.hostCallMs) / series.count;
    const handler = p50(series.handlerMs) / series.count;
    return { roundTripMs: roundTrip, hostSideMs: host, handlerMs: handler, hostSideExcludingHandlerMs: host - handler, guestAndTransportMs: roundTrip - host };
  };
  return {
    series: [baseline, one, ten, hundred, io],
    summary: {
      wallMs: Object.fromEntries([baseline, one, ten, hundred, io].map((r) => [`${r.method} x${r.count}`, stats(r.wallMs)])),
      echoPerCall: split((p50(hundred.wallMs) - p50(one.wallMs)) / 99, hundred),
      ioPerCall: split((p50(io.wallMs) - p50(baseline.wallMs)) / io.count, io),
    },
  };
}

async function paging(samples: number): Promise<Record<string, unknown>> {
  const items: Item[] = [];
  const kinds = ['desk', 'chair', 'lamp'] as const;
  for (let i = 0; i < 10_000; i++) {
    items.push({ id: `item-${String(i).padStart(5, '0')}`, name: `Item number ${i}`, kind: kinds[i % 3] ?? 'desk' });
  }
  const store = new CatalogStore(items);
  const datasetBytes = Buffer.byteLength(JSON.stringify(items));
  const runtime = await createRuntime<RequestState>({ apis: createCatalogApis() });
  const session = runtime.createSession({ context: { draft: new Draft(store.snapshot()) }, capabilities: ['catalog.*'] });
  // The first five pages of 50 lamps, as a script that needs a few results would read them.
  const firstPages = `
    const lamps = []; let cursor;
    for (let page = 0; page < 5; page++) {
      const result = await catalog.list({ cursor, limit: 50 });
      for (const item of result.items) if (item.kind === 'lamp') lamps.push(item.id);
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
    }
    return lamps.length;`;
  const fullScan = firstPages.replace('page < 5', 'page < 1000');
  const run = async (source: string, label: string) => {
    const wall: number[] = [];
    const rpc: number[] = [];
    const callCounts: number[] = [];
    for (let i = 0; i < samples; i++) {
      const { ms, outcome } = await timed(() => session.execute({ language: 'javascript', source, limits: { hostCalls: 1000, evidenceRecords: 1000, rpcBytes: 64 * 1024 * 1024 } }));
      expectStatus(outcome, 'completed', `paging ${label}`);
      wall.push(ms);
      rpc.push(outcome.evidence.counters.rpcBytes);
      callCounts.push(outcome.evidence.counters.callsAdmitted);
    }
    return { label, wallMs: wall, rpcBytes: rpc, calls: callCounts, summary: { wallMs: stats(wall), rpcBytes: rpc[0], calls: callCounts[0] } };
  };
  const result = { datasetItems: items.length, datasetBytes, firstFivePages: await run(firstPages, 'first five pages'), fullScan: await run(fullScan, 'full scan, for comparison') };
  await session.dispose();
  await runtime.dispose();
  return result;
}

async function responsiveness(runtime: ScriptBoxRuntime<Record<string, never>>): Promise<Record<string, unknown>> {
  const session = runtime.createSession({ context: {}, capabilities: ['*'] });
  // The same heartbeat with nothing running, for comparison.
  const watchIdle = async () => {
    const histogram = monitorEventLoopDelay({ resolution: 1 });
    let last = performance.now();
    const ticks: number[] = [];
    const timer = setInterval(() => {
      const now = performance.now();
      ticks.push(now - last);
      last = now;
    }, 5);
    histogram.enable();
    await delay(1000);
    histogram.disable();
    clearInterval(timer);
    return {
      label: 'idle for 1 s, for comparison',
      executionMs: 0,
      heartbeatIntervalMs: 5,
      heartbeatGapMs: stats(ticks),
      maxHeartbeatGapMs: Math.max(...ticks),
      eventLoopDelayMs: { p50: histogram.percentile(50) / 1e6, p99: histogram.percentile(99) / 1e6, max: histogram.max / 1e6 },
    };
  };
  const watch = async (label: string, source: string) => {
    const histogram = monitorEventLoopDelay({ resolution: 1 });
    let last = performance.now();
    let maxGap = 0;
    const ticks: number[] = [];
    const timer = setInterval(() => {
      const now = performance.now();
      ticks.push(now - last);
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 5);
    histogram.enable();
    const { ms, outcome } = await timed(() => session.execute({ language: 'javascript', source }));
    histogram.disable();
    clearInterval(timer);
    expectStatus(outcome, 'completed', `responsiveness ${label}`);
    return {
      label,
      executionMs: ms,
      heartbeatIntervalMs: 5,
      heartbeatGapMs: stats(ticks),
      maxHeartbeatGapMs: maxGap,
      eventLoopDelayMs: { p50: histogram.percentile(50) / 1e6, p99: histogram.percentile(99) / 1e6, max: histogram.max / 1e6 },
    };
  };
  const result = [
    await watchIdle(),
    await watch('guest computes for about 1 s', 'let x = 0; for (let i = 0; i < 3e7; i++) { x = (x + i) % 1000003; } return x;'),
    await watch('handlers await 10 x 100 ms of I/O', 'let s = 0; for (let i = 0; i < 10; i++) { s += await bench.work(100); } return s;'),
  ];
  await session.dispose();
  return { runs: result };
}

async function memory(runtime: ScriptBoxRuntime<Record<string, never>>, samples: number): Promise<Record<string, unknown>> {
  const session = runtime.createSession({ context: {}, capabilities: ['*'] });
  const usage = () => {
    const m = process.memoryUsage();
    return { rss: m.rss, heapUsed: m.heapUsed, external: m.external, arrayBuffers: m.arrayBuffers };
  };
  const before = usage();
  let peakRss = before.rss;
  const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage.rss()); }, 2);
  const guest: number[] = [];
  for (let i = 0; i < samples; i++) {
    const outcome = await session.execute({ language: 'javascript', source: 'const a = []; for (let i = 0; i < 200000; i++) a.push({ i, s: "x" + i }); return a.length;' });
    expectStatus(outcome, 'completed', 'memory allocation');
    guest.push(outcome.evidence.measurements.guestMemoryBytes ?? Number.NaN);
  }
  const limit = await timed(() => session.execute({
    language: 'javascript',
    source: 'const a = []; for (;;) a.push("x".repeat(1024) + a.length);',
    limits: { memoryBytes: 64 * 1024 * 1024 },
  }));
  expectStatus(limit.outcome, 'resource-limit', 'memory limit');
  clearInterval(sampler);
  const after = usage();
  await session.dispose();
  return {
    executions: samples,
    guestMemoryBytes: stats(guest),
    defaultMemoryLimitBytes: runtime.limits.memoryBytes,
    hostBefore: before,
    hostAfter: after,
    hostPeakRss: peakRss,
    limitRun: {
      memoryBytes: 64 * 1024 * 1024,
      status: limit.outcome.status,
      limit: limit.outcome.status === 'resource-limit' ? limit.outcome.limit : null,
      wallMs: limit.ms,
      guestMemoryBytes: limit.outcome.evidence.measurements.guestMemoryBytes,
    },
  };
}

async function cancellation(runtime: ScriptBoxRuntime<Record<string, never>>, samples: number): Promise<Record<string, unknown>> {
  const session = runtime.createSession({ context: {}, capabilities: ['*'] });
  const cases = {
    'CPU loop': 'for (;;) {}',
    'promise jobs': 'const spin = () => Promise.resolve().then(spin); spin(); await new Promise(() => {});',
    'native sort': 'const a = []; for (let i = 0; i < 3e6; i++) a.push((i * 7919) % 1000003); for (;;) a.slice().sort((x, y) => x - y);',
    'pending host call': 'await bench.work(10000);',
  };
  const results: Record<string, unknown>[] = [];
  for (const [label, source] of Object.entries(cases)) {
    const toOutcome: number[] = [];
    const termination: number[] = [];
    for (let i = 0; i < samples; i++) {
      const controller = new AbortController();
      const running = session.execute({ language: 'javascript', source, signal: controller.signal });
      await delay(100);
      const abortedAt = performance.now();
      controller.abort();
      const outcome = await running;
      toOutcome.push(performance.now() - abortedAt);
      expectStatus(outcome, 'cancelled', `cancel ${label}`);
      termination.push(outcome.evidence.measurements.terminationLatencyMs ?? Number.NaN);
    }
    results.push({ label, abortToOutcomeMs: toOutcome, terminationLatencyMs: termination, summary: { abortToOutcomeMs: stats(toOutcome), terminationLatencyMs: stats(termination) } });
  }
  // The deadline, rather than a signal, stops a CPU loop.
  const deadline: number[] = [];
  for (let i = 0; i < samples; i++) {
    const { ms, outcome } = await timed(() => session.execute({ language: 'javascript', source: 'for (;;) {}', limits: { timeoutMs: 200 } }));
    expectStatus(outcome, 'timed-out', 'deadline');
    deadline.push(ms - 200);
  }
  // The parent is still usable afterwards.
  const after = await session.execute({ language: 'javascript', source: 'return 1;' });
  expectStatus(after, 'completed', 'execution after cancellations');
  await session.dispose();
  return { cases: results, deadlineOvershootMs: { samples: deadline, summary: stats(deadline) }, usableAfterwards: after.status === 'completed' };
}

async function concurrency(runtime: ScriptBoxRuntime<Record<string, never>>, samples: number): Promise<Record<string, unknown>> {
  const a = runtime.createSession({ context: {}, capabilities: ['*'] });
  const b = runtime.createSession({ context: {}, capabilities: ['*'] });
  const cpu = 'let x = 0; for (let i = 0; i < 1e7; i++) { x = (x + i) % 1000003; } return x;';
  const io = 'let s = 0; for (let i = 0; i < 20; i++) { s += await bench.work(5); s += await bench.echo(i); } return s;';
  const pair = async (source: string, label: string) => {
    const alone: number[] = [];
    const together: number[] = [];
    for (let i = 0; i < samples; i++) {
      const single = await timed(() => a.execute({ language: 'javascript', source }));
      expectStatus(single.outcome, 'completed', `${label} alone`);
      alone.push(single.ms);
      const start = performance.now();
      const both = await Promise.all([a.execute({ language: 'javascript', source }), b.execute({ language: 'javascript', source })]);
      together.push(performance.now() - start);
      for (const outcome of both) {
        expectStatus(outcome, 'completed', `${label} together`);
      }
    }
    return { label, aloneMs: alone, bothTogetherMs: together, summary: { aloneMs: stats(alone), bothTogetherMs: stats(together) } };
  };
  const result = [await pair(cpu, 'guest computation'), await pair(io, 'host calls with I/O')];
  await a.dispose();
  await b.dispose();
  return { runs: result };
}

function cgroup(file: string): string | null {
  try {
    return readFileSync(join('/sys/fs/cgroup', file), 'utf8').trim();
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const labelIndex = args.indexOf('--label');
  const label = (labelIndex >= 0 ? args[labelIndex + 1] : undefined) ?? `${platform()}-${arch()}-node${process.versions.node}`;
  const environment = {
    label,
    date: new Date().toISOString(),
    node: process.versions.node,
    v8: process.versions.v8,
    platform: platform(),
    release: release(),
    arch: arch(),
    cpuModel: cpus()[0]?.model ?? null,
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    cgroupCpuMax: cgroup('cpu.max'),
    cgroupMemoryMax: cgroup('memory.max'),
    profile: process.env['BENCH_PROFILE'] ?? null,
    package: versions,
    quick,
  };
  console.log(`ScriptBox bench: ${label}${quick ? ' (quick)' : ''}`);

  const results: Record<string, unknown> = { environment };
  results['cold'] = await cold(scale(10));
  const runtime = await createRuntime({ apis: [benchApis()] });
  try {
    results['warm'] = await warm(runtime, 10, scale(100));
    results['calls'] = await calls(runtime, 3, scale(30));
    results['paging'] = await paging(scale(10));
    results['responsiveness'] = await responsiveness(runtime);
    results['memory'] = await memory(runtime, scale(10));
    results['cancellation'] = await cancellation(runtime, scale(10));
    results['concurrency'] = await concurrency(runtime, scale(10));
  } finally {
    await runtime.dispose();
  }
  results['errors'] = errors;

  const directory = join(here, 'results');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${label}.json`);
  writeFileSync(file, JSON.stringify(results, null, 2) + '\n');
  console.log(`Raw results: ${file}`);
  console.log(`Errors: ${errors.length === 0 ? 'none' : errors.join('; ')}`);
}

if (args.includes('--cold-child')) {
  await coldChild();
} else {
  await main();
}
