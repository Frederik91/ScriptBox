// Acceptance 14 to 20: isolation between executions and sessions, busy
// sessions, cancellation and termination, limits, failure handling and
// ambient authority.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, test } from 'node:test';
import {
  createRuntime,
  DocsTree,
  SessionBusyError,
  SessionDisposedError,
  type ExecutionEvent,
  type ExecutionOutcome,
  type ScriptBoxRuntime,
} from '@frederik91/scriptbox';
import { catalogRuntime, completed, Draft, failed, heartbeat, limited, testApis } from './helpers.ts';

type Ctx = { readonly tenant: string };

async function withRuntime(run: (runtime: ScriptBoxRuntime<Ctx>, log: string[]) => Promise<void>, options: { onEvent?: (e: ExecutionEvent) => void; audit?: (e: ExecutionEvent) => void | Promise<void> } = {}): Promise<void> {
  const log: string[] = [];
  const runtime = await createRuntime<Ctx>({ ...options, apis: [testApis(log).test] });
  try {
    await run(runtime, log);
  } finally {
    await runtime.dispose();
  }
}

describe('isolation (14)', () => {
  test('a global or prototype change made by one execution is gone in the next', async () => {
    await withRuntime(async (runtime) => {
      const s = runtime.createSession({ context: { tenant: 'a' }, capabilities: ['*'] });
      completed(await s.execute({ language: 'javascript', source: 'globalThis.leak = 1; Object.prototype.polluted = true; Array.prototype.push = null; return 1;' }));
      assert.deepEqual(
        completed(await s.execute({ language: 'javascript', source: 'const a = []; a.push(1); return [typeof leak, ({}).polluted === undefined, a.length];' })),
        ['undefined', true, 1],
      );
    });
  });

  test('sessions do not see each other\'s context, drafts, docs or logs', async () => {
    const { runtime, store, session } = await catalogRuntime();
    try {
      const draftA = new Draft(store.snapshot());
      const draftB = new Draft(store.snapshot());
      const a = session(draftA, { docs: [new DocsTree().addFile('/private/a.md', 'A only', 'secret plan for A')] });
      const b = session(draftB);
      const outA = await a.execute({ language: 'javascript', source: 'console.log("from A"); await draft.rename({ id: "desk-1", name: "A name" }); return (await docs.read("/private/a.md"))[0].content;' });
      const outB = await b.execute({
        language: 'javascript',
        source: 'const item = await catalog.get({ id: "desk-1" }); const doc = (await docs.read("/private/a.md"))[0]; const hits = await docs.grep("secret"); return [item.name, doc.content, doc.error !== null, hits.length];',
      });
      assert.equal(completed(outA), 'secret plan for A');
      assert.deepEqual(completed(outB), ['Standing desk', null, true, 0]);
      assert.deepEqual(outA.logs.map((l) => l.text), ['from A']);
      assert.deepEqual(outB.logs, []);
      assert.equal(draftA.get('desk-1')?.name, 'A name');
      assert.equal(draftB.get('desk-1')?.name, 'Standing desk');
    } finally {
      await runtime.dispose();
    }
  });
});

describe('concurrency (15)', () => {
  test('a second execute on a busy session is rejected, not queued', async () => {
    await withRuntime(async (runtime) => {
      const s = runtime.createSession({ context: { tenant: 'a' }, capabilities: ['*'] });
      const first = s.execute({ language: 'javascript', source: 'return await test.wait(100, "first");' });
      await assert.rejects(s.execute({ language: 'javascript', source: 'return 2;' }), SessionBusyError);
      assert.equal(completed(await first), 'first');
      assert.equal(completed(await s.execute({ language: 'javascript', source: 'return 3;' })), 3);
    });
  });

  test('independent sessions run at the same time without shared guest state', async () => {
    await withRuntime(async (runtime) => {
      const sessions = [runtime.createSession({ context: { tenant: 'a' }, capabilities: ['*'] }), runtime.createSession({ context: { tenant: 'b' }, capabilities: ['*'] })];
      const started = performance.now();
      const values = await Promise.all(sessions.map((s, i) => s.execute({
        language: 'javascript',
        source: `globalThis.mine = ${i}; await test.wait(300); return [globalThis.mine, await test.tenant()];`,
      })));
      const elapsed = performance.now() - started;
      assert.deepEqual(values.map(completed), [[0, 'a'], [1, 'b']]);
      assert.ok(elapsed < 550, `two 300 ms executions took ${elapsed} ms together`);
    });
  });

  test('a disposed session refuses executions and disposing twice is safe', async () => {
    await withRuntime(async (runtime) => {
      const s = runtime.createSession({ context: { tenant: 'a' }, capabilities: ['*'] });
      const running = s.execute({ language: 'javascript', source: 'for (;;) {}' });
      await s.dispose();
      await s.dispose();
      assert.equal((await running).status, 'cancelled');
      await assert.rejects(s.execute({ language: 'javascript', source: 'return 1;' }), SessionDisposedError);
    });
  });
});

describe('cancellation and termination (16, 17)', () => {
  const stuck: [string, string][] = [
    ['a CPU loop', 'for (;;) {}'],
    ['endless promise jobs', 'const f = () => Promise.resolve().then(f); f(); await new Promise(() => { for (;;) {} });'],
    ['an await loop', 'for (;;) { await null; }'],
    ['a long native sort', 'const a = []; for (let i = 0; i < 2e6; i++) a.push((i * 7919) % 1000003); for (;;) a.sort((x, y) => x - y);'],
    ['catastrophic regex backtracking', 'return /^(a+)+$/.test("a".repeat(40) + "b");'],
    ['a pending host call', 'return await test.wait(60000);'],
  ];
  for (const [what, source] of stuck) {
    test(`cancelling ${what} ends it promptly and the parent stays usable`, async () => {
      await withRuntime(async (runtime) => {
        const s = runtime.createSession({ context: { tenant: 'a' }, capabilities: ['*'] });
        const controller = new AbortController();
        const beat = heartbeat();
        setTimeout(() => {
          controller.abort();
        }, 200);
        const outcome = await s.execute({ language: 'javascript', source, signal: controller.signal });
        const gap = beat.stop();
        assert.equal(outcome.status, 'cancelled');
        const latency = outcome.evidence.measurements.terminationLatencyMs;
        assert.ok(latency !== null && latency < 1000, `termination took ${String(latency)} ms`);
        assert.ok(outcome.evidence.elapsedMs < 1200, `the outcome took ${outcome.evidence.elapsedMs} ms`);
        assert.ok(gap < 100, `the parent's event loop stalled for ${gap} ms`);
        assert.equal(completed(await s.execute({ language: 'javascript', source: 'return 1 + 1;' })), 2);
      });
    });
  }

  test('the deadline stops a CPU loop and reports timed-out', async () => {
    await withRuntime(async (runtime) => {
      const s = runtime.createSession({ context: { tenant: 'a' }, capabilities: ['*'] });
      const outcome = await s.execute({ language: 'javascript', source: 'for (;;) {}', limits: { timeoutMs: 300 } });
      assert.equal(outcome.status, 'timed-out');
      assert.ok(outcome.evidence.elapsedMs < 800);
    });
  });

  test('an already aborted signal never starts the script', async () => {
    await withRuntime(async (runtime, log) => {
      const s = runtime.createSession({ context: { tenant: 'a' }, capabilities: ['*'] });
      const outcome = await s.execute({ language: 'javascript', source: 'await test.echo(1);', signal: AbortSignal.abort() });
      assert.equal(outcome.status, 'cancelled');
      assert.deepEqual(log, []);
    });
  });

  test('a host call outliving its own timeout fails catchably and its signal aborts', async () => {
    await withRuntime(async (runtime, log) => {
      const s = runtime.createSession({ context: { tenant: 'a' }, capabilities: ['*'] });
      const outcome = await s.execute({ language: 'javascript', source: 'try { await test.wait(5000, "slow"); } catch (e) { return e.name; }', limits: { hostCallTimeoutMs: 100 } });
      assert.equal(completed(outcome), 'HostTimeoutError');
      assert.deepEqual(outcome.evidence.calls.map((c) => c.disposition), ['host-timeout']);
      assert.deepEqual(log, ['wait:slow:start'], 'the handler saw its signal abort and never finished');
    });
  });

  test('cancelling just before a delayed write lands leaves the draft unchanged', async () => {
    const { runtime, store, session } = await catalogRuntime({ delayMs: 200 });
    try {
      const draft = new Draft(store.snapshot());
      const s = session(draft);
      const controller = new AbortController();
      setTimeout(() => {
        controller.abort();
      }, 180);
      const outcome = await s.execute({ language: 'javascript', source: 'await draft.rename({ id: "desk-1", name: "Late" }); return "done";', signal: controller.signal });
      assert.equal(outcome.status, 'cancelled');
      await delay(150);
      assert.equal(draft.get('desk-1')?.name, 'Standing desk');
      assert.deepEqual(draft.summary().modified, []);
      assert.deepEqual(outcome.evidence.calls.map((c) => [c.method, c.disposition, c.handlerRan]), [['draft.rename', 'revoked', true]]);
    } finally {
      await runtime.dispose();
    }
  });
});

describe('limits (18)', () => {
  test('guest memory growth is a hard stop', async () => {
    await withRuntime(async (runtime) => {
      const s = runtime.createSession({ context: { tenant: 'a' }, capabilities: ['*'] });
      const outcome = limited(await s.execute({
        language: 'javascript',
        source: 'const a = []; try { for (;;) a.push("x".repeat(1e6) + a.length); } catch (e) { return "caught"; }',
        limits: { memoryBytes: 64 * 1024 * 1024 },
      }));
      assert.equal(outcome.limit, 'memory');
      assert.ok((outcome.evidence.measurements.guestMemoryBytes ?? 0) <= 64 * 1024 * 1024);
    });
  });

  test('an oversized request or response fails the call catchably', async () => {
    await withRuntime(async (runtime, log) => {
      const s = runtime.createSession({ context: { tenant: 'a' }, capabilities: ['*'] });
      const outcome = await s.execute({
        language: 'javascript',
        source: `const out = [];
try { await test.echo("x".repeat(300 * 1024)); } catch (e) { out.push(e.name); }
try { await test.repeat("y", 300 * 1024); } catch (e) { out.push(e.name); }
return out;`,
      });
      assert.deepEqual(completed(outcome), ['RequestTooLargeError', 'ResponseTooLargeError']);
      assert.deepEqual(outcome.evidence.calls.map((c) => [c.disposition, c.handlerRan]), [['request-too-large', false], ['response-too-large', true]]);
      assert.deepEqual(log, ['repeat'], 'the oversized request never reached a handler');
    });
  });

  test('call count, cumulative bytes and the result size are hard stops', async () => {
    await withRuntime(async (runtime) => {
      const s = runtime.createSession({ context: { tenant: 'a' }, capabilities: ['*'] });
      const calls = limited(await s.execute({ language: 'javascript', source: 'for (;;) { try { await test.echo(1); } catch { } }' }));
      assert.equal(calls.limit, 'host-calls');
      assert.equal(calls.evidence.counters.callAttempts, 128);
      const bytes = limited(await s.execute({ language: 'javascript', source: 'for (let i = 0; i < 100; i++) await test.echo("x".repeat(100000)); return 1;' }));
      assert.equal(bytes.limit, 'rpc-bytes');
      const result = limited(await s.execute({ language: 'javascript', source: 'return "x".repeat(300 * 1024);' }));
      assert.equal(result.limit, 'result-bytes');
    });
  });

  test('a queue over the outstanding limit refuses the excess before it starts', async () => {
    await withRuntime(async (runtime, log) => {
      const s = runtime.createSession({ context: { tenant: 'a' }, capabilities: ['*'] });
      const value = completed(await s.execute({
        language: 'javascript',
        source: 'const ps = []; for (let i = 0; i < 20; i++) ps.push(test.wait(5, String(i)).catch((e) => e.name)); return await Promise.all(ps);',
      }));
      assert.ok(Array.isArray(value));
      assert.deepEqual(value.slice(16), ['QueueFullError', 'QueueFullError', 'QueueFullError', 'QueueFullError']);
      assert.equal(log.filter((entry) => entry.endsWith(':start')).length, 16);
    });
  });

  test('logs are bounded and their truncation is reported', async () => {
    await withRuntime(async (runtime) => {
      const s = runtime.createSession({ context: { tenant: 'a' }, capabilities: ['*'] });
      const outcome = await s.execute({ language: 'javascript', source: 'for (let i = 0; i < 1000; i++) console.log(i + ":" + "x".repeat(5000)); return 1;' });
      assert.equal(completed(outcome), 1);
      assert.equal(outcome.logs.length, 100);
      assert.ok(outcome.logs.every((l) => l.truncated && l.text.length <= 2048));
      assert.equal(outcome.evidence.truncated.logs, true);
    });
  });

  test('a write followed by a hard limit produces no proposal', async () => {
    const { runtime, store, session } = await catalogRuntime();
    try {
      const draft = new Draft(store.snapshot());
      const s = session(draft);
      const outcome = await s.execute({ language: 'javascript', source: 'await draft.rename({ id: "desk-1", name: "Staged" }); for (;;) await catalog.get({ id: "desk-1" });' });
      assert.equal(limited(outcome).limit, 'host-calls');
      // The application's rule: anything but completed discards the draft.
      draft.discard();
      assert.equal(store.snapshot().items.get('desk-1')?.name, 'Standing desk');
      assert.deepEqual(draft.summary().modified, []);
    } finally {
      await runtime.dispose();
    }
  });
});

describe('failures around the script (19)', () => {
  test('a compiler worker that runs out of heap ends the execution, and the next compile works', async () => {
    await withRuntime(async (runtime) => {
      const s = runtime.createSession({ context: { tenant: 'a' }, capabilities: ['*'] });
      const head = [
        'type Rep<S extends string, N extends unknown[] = []> = N["length"] extends 900 ? S : Rep<`${S}x`, [...N, 0]>;',
        'type Len<S extends string, A extends unknown[] = []> = S extends `${string}${infer R}` ? Len<R, [...A, 0]> : A["length"];',
      ];
      const body = Array.from({ length: 400 }, (_, i) => `const v${i}: Len<Rep<"s${i}">> = 0 as never;`);
      const outcome = await s.execute({ language: 'typescript', source: [...head, ...body].join('\n'), limits: { compilerHeapMb: 64, compileTimeoutMs: 60000 } });
      assert.equal(limited(outcome).limit, 'compiler-memory');
      assert.equal(completed(await s.execute({ language: 'typescript', source: 'return 1;' })), 1);
    });
  });

  test('a handler that throws something internal reaches the script only as HostError; the host keeps the detail', async () => {
    const events: ExecutionEvent[] = [];
    await withRuntime(async (runtime) => {
      const s = runtime.createSession({ context: { tenant: 'a' }, capabilities: ['*'] });
      const outcome = await s.execute({ language: 'javascript', source: 'try { await test.fail(); } catch (e) { return [e.name, e.message, String(e.stack).includes("hunter2")]; }' });
      assert.deepEqual(completed(outcome), ['HostError', 'test.fail failed on the host.', false]);
      const done = events.find((e) => e.type === 'host-call-completed');
      assert.ok(done?.type === 'host-call-completed');
      assert.ok(done.hostError instanceof Error && done.hostError.message.includes('hunter2'));
      const uncaught = failed(await s.execute({ language: 'javascript', source: 'await test.fail();' }));
      assert.equal(uncaught.code, 'host-failure');
      assert.doesNotMatch(JSON.stringify(uncaught), /hunter2|db\.ts|srv/);
    }, { onEvent: (event) => events.push(event) });
  });

  test('a throwing filter fails only that call', async () => {
    const log: string[] = [];
    const runtime = await createRuntime<Ctx>({ apis: [testApis(log).test], filters: [() => { throw new Error('filter bug'); }] });
    try {
      const s = runtime.createSession({ context: { tenant: 'a' }, capabilities: ['*'] });
      const outcome = await s.execute({ language: 'javascript', source: 'try { await test.echo(1); } catch (e) { return e.name; }' });
      assert.equal(completed(outcome), 'HostError');
      assert.deepEqual(log, []);
      assert.deepEqual(outcome.evidence.calls.map((c) => c.disposition), ['host-failure']);
    } finally {
      await runtime.dispose();
    }
  });

  test('a throwing progress callback is counted and ignored', async () => {
    await withRuntime(async (runtime) => {
      const s = runtime.createSession({ context: { tenant: 'a' }, capabilities: ['*'] });
      const outcome = await s.execute({ language: 'javascript', source: 'return await test.echo(1);' });
      assert.equal(completed(outcome), 1);
      assert.ok(outcome.evidence.counters.eventCallbackErrors >= 3);
    }, { onEvent: () => { throw new Error('progress bug'); } });
  });

  test('a failing audit sink stops the execution before the call it could not record', async () => {
    const outcomes: ExecutionOutcome[] = [];
    await withRuntime(async (runtime, log) => {
      const s = runtime.createSession({ context: { tenant: 'a' }, capabilities: ['*'] });
      outcomes.push(await s.execute({ language: 'javascript', source: 'try { await test.nothing(); } catch { } return "survived";' }));
      const error = failed(outcomes[0] ?? await Promise.reject(new Error('no outcome')));
      assert.equal(error.code, 'audit-failure');
      assert.deepEqual(log, [], 'the write was never made');
    }, { audit: (event) => event.type === 'host-call-started' ? Promise.reject(new Error('audit store down')) : undefined });
  });

  test('a failing audit sink at the end turns success into failure', async () => {
    await withRuntime(async (runtime) => {
      const s = runtime.createSession({ context: { tenant: 'a' }, capabilities: ['*'] });
      const error = failed(await s.execute({ language: 'javascript', source: 'return 1;' }));
      assert.equal(error.code, 'audit-failure');
    }, { audit: (event) => {
      if (event.type === 'execution-finished') {
        throw new Error('audit store down');
      }
    } });
  });
});

describe('ambient authority (20)', () => {
  test('the guest has the language, console, the bridge and the registered namespaces; nothing else', async () => {
    await withRuntime(async (runtime) => {
      const s = runtime.createSession({ context: { tenant: 'a' }, capabilities: ['*'] });
      const value = completed(await s.execute({ language: 'javascript', source: 'return Object.getOwnPropertyNames(globalThis).sort();' }));
      const language = ['AggregateError', 'Array', 'ArrayBuffer', 'Atomics', 'BigInt', 'BigInt64Array', 'BigUint64Array', 'Boolean', 'DataView', 'Date', 'Error', 'EvalError',
        'FinalizationRegistry', 'Float16Array', 'Float32Array', 'Float64Array', 'Function', 'Infinity', 'Int16Array', 'Int32Array', 'Int8Array', 'InternalError', 'Iterator',
        'JSON', 'Map', 'Math', 'NaN', 'Number', 'Object', 'Promise', 'Proxy', 'RangeError', 'ReferenceError', 'Reflect', 'RegExp', 'Set', 'SharedArrayBuffer', 'String',
        'Symbol', 'SyntaxError', 'TypeError', 'URIError', 'Uint16Array', 'Uint32Array', 'Uint8Array', 'Uint8ClampedArray', 'WeakMap', 'WeakRef', 'WeakSet', 'decodeURI',
        'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'escape', 'eval', 'globalThis', 'isFinite', 'isNaN', 'parseFloat', 'parseInt', 'undefined', 'unescape'];
      assert.deepEqual(value, [...language, '__scriptbox', 'console', 'docs', 'test'].sort());
    });
  });

  test('probes for process, modules, network, timers and files find nothing', async () => {
    await withRuntime(async (runtime) => {
      const s = runtime.createSession({ context: { tenant: 'a' }, capabilities: ['*'] });
      const value = completed(await s.execute({
        language: 'javascript',
        source: `const probe = (f) => { try { const v = f(); return v === undefined ? 'undefined' : typeof v; } catch (e) { return e.name; } };
const out = {
  process: probe(() => process), require: probe(() => require), fetch: probe(() => fetch), setTimeout: probe(() => setTimeout),
  std: probe(() => std), os: probe(() => os), wasm: probe(() => WebAssembly), host: probe(() => __host), buffer: probe(() => Buffer),
  evalProcess: probe(() => eval('process')), functionProcess: probe(() => new Function('return process')()),
  globalFromFunction: probe(() => Function('return this')() === globalThis),
};
try { await import('os'); out.import = 'loaded'; } catch (e) { out.import = e.name; }
try { await import('/etc/passwd'); out.importFile = 'loaded'; } catch (e) { out.importFile = e.name; }
return out;`,
      }));
      assert.deepEqual(value, {
        process: 'ReferenceError', require: 'ReferenceError', fetch: 'ReferenceError', setTimeout: 'ReferenceError',
        std: 'ReferenceError', os: 'ReferenceError', wasm: 'ReferenceError', host: 'ReferenceError', buffer: 'ReferenceError',
        evalProcess: 'ReferenceError', functionProcess: 'ReferenceError', globalFromFunction: 'boolean',
        import: 'ReferenceError', importFile: 'ReferenceError',
      });
    });
  });
});

describe('time and randomness', () => {
  const source = 'const a = new Date().toISOString(); for (let i = 0; i < 200000; i++) {} return [a, Date.now() - Date.parse(a), Math.random(), Math.random()];';

  const start = Date.parse('2026-01-01T00:00:00Z');

  async function twice(frozenGuestClock: boolean, now: () => number): Promise<[unknown, unknown]> {
    const runtime = await createRuntime<Ctx>({ apis: [testApis([]).test], frozenGuestClock, clock: { now } });
    try {
      const s = runtime.createSession({ context: { tenant: 'a' }, capabilities: ['*'] });
      return [completed(await s.execute({ language: 'javascript', source })), completed(await s.execute({ language: 'javascript', source }))];
    } finally {
      await runtime.dispose();
    }
  }

  test('a frozen guest clock at the same start gives the same time and random numbers each run', async () => {
    const [first, second] = await twice(true, () => start);
    assert.deepEqual(second, first);
    assert.ok(Array.isArray(first));
    assert.equal(first[1], 0);
  });

  test('a running clock moves and the random numbers differ', async () => {
    const [first, second] = await twice(false, () => start + performance.now());
    assert.notDeepEqual(second, first);
  });

  test('the guest reads the injected clock', async () => {
    const [first] = await twice(true, () => start);
    assert.ok(Array.isArray(first));
    assert.equal(first[0], '2026-01-01T00:00:00.000Z');
  });
});
