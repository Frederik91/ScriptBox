// Calls to methods marked concurrent run together; every other call runs alone.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, test } from 'node:test';
import { createApiKit, createRuntime, Type, type ExecutionLimits, type ScriptBoxRuntime } from '@frederik91/scriptbox';
import { completed, failed } from './helpers.ts';

type Ctx = Record<string, never>;

interface Probe {
  readonly log: string[];
  running: number;
  maxRunning: number;
  arrived: number;
  everyoneArrived: PromiseWithResolvers<true>;
}

function gateApis(probe: Probe) {
  const kit = createApiKit<Ctx>();
  const hold = async (name: string, ms: number, signal: AbortSignal): Promise<string> => {
    probe.log.push(`start:${name}`);
    probe.maxRunning = Math.max(probe.maxRunning, ++probe.running);
    try {
      await delay(ms, undefined, { signal });
      return name;
    } catch (error) {
      probe.log.push(`cancelled:${name}`);
      throw error;
    } finally {
      probe.running--;
      probe.log.push(`end:${name}`);
    }
  };
  return kit.namespace({
    name: 'gate',
    methods: {
      meet: kit.method({
        summary: 'Resolves once the given number of calls have arrived, so it succeeds only when they run together.',
        effect: 'read',
        concurrent: true,
        params: { count: Type.Integer({ minimum: 1 }) },
        result: Type.Integer(),
        handler: async ({ count }, call) => {
          if (++probe.arrived >= count) {
            probe.everyoneArrived.resolve(true);
          }
          const aborted = new Promise<never>((_resolve, reject) => {
            call.signal.addEventListener('abort', () => {
              reject(new Error('aborted'));
            }, { once: true });
          });
          await Promise.race([probe.everyoneArrived.promise, aborted]);
          return count;
        },
      }),
      read: kit.method({
        summary: 'Waits, then returns its name.',
        effect: 'read',
        concurrent: true,
        params: { name: Type.String(), ms: Type.Integer({ minimum: 0 }) },
        result: Type.String(),
        handler: ({ name, ms }, call) => hold(name, ms, call.signal),
      }),
      write: kit.method({
        summary: 'Waits, then returns its name.',
        effect: 'draft-write',
        params: { name: Type.String(), ms: Type.Integer({ minimum: 0 }) },
        result: Type.String(),
        handler: ({ name, ms }, call) => hold(name, ms, call.signal),
      }),
      failSoon: kit.method({
        summary: 'Fails after a moment.',
        effect: 'read',
        concurrent: true,
        handler: async () => {
          await delay(20);
          throw new Error('failed on purpose');
        },
      }),
    },
  });
}

async function withGate(
  limits: Partial<ExecutionLimits>,
  run: (runtime: ScriptBoxRuntime<Ctx>, probe: Probe) => void | Promise<void>,
): Promise<void> {
  const probe: Probe = { log: [], running: 0, maxRunning: 0, arrived: 0, everyoneArrived: Promise.withResolvers<true>() };
  const runtime = await createRuntime<Ctx>({ apis: [gateApis(probe)], limits: { timeoutMs: 10_000, ...limits } });
  try {
    await run(runtime, probe);
  } finally {
    await runtime.dispose();
  }
}

const javascript = (source: string) => ({ language: 'javascript' as const, source });

describe('concurrent calls', () => {
  test('concurrent calls the script awaits together run at the same time', async () => {
    await withGate({}, async (runtime) => {
      const s = runtime.createSession({ context: {}, capabilities: ['*'] });
      const value = completed(await s.execute(javascript('return await Promise.all([gate.meet(3), gate.meet(3), gate.meet(3)]);')));
      assert.deepEqual(value, [3, 3, 3]);
    });
  });

  for (const [limit, expected] of [[undefined, 4], [2, 2]] as const) {
    test(`no more concurrent calls run than the limit (${limit ?? 'default'})`, async () => {
      await withGate(limit === undefined ? {} : { concurrentCalls: limit }, async (runtime, probe) => {
        const s = runtime.createSession({ context: {}, capabilities: ['*'] });
        const value = completed(await s.execute(javascript(
          "return await Promise.all(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(n => gate.read(n, 100)));")));
        assert.deepEqual(value, ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
        assert.equal(probe.maxRunning, expected);
      });
    });
  }

  test('a call to a method not marked concurrent runs alone, in the order it was made', async () => {
    await withGate({}, async (runtime, probe) => {
      const s = runtime.createSession({ context: {}, capabilities: ['*'] });
      completed(await s.execute(javascript(
        "return await Promise.all([gate.read('r1', 60), gate.read('r2', 30), gate.write('w', 30), gate.read('r3', 5)]);")));
      const at = (event: string) => probe.log.indexOf(event);
      assert.equal(probe.maxRunning, 2);
      assert.ok(at('start:w') > at('end:r1') && at('start:w') > at('end:r2'), probe.log.join(', '));
      assert.ok(at('start:r3') > at('end:w'), probe.log.join(', '));
    });
  });

  test('each call settles when its handler finishes', async () => {
    await withGate({}, async (runtime) => {
      const s = runtime.createSession({ context: {}, capabilities: ['*'] });
      const value = completed(await s.execute(javascript(`const order = [];
await Promise.all([gate.read('slow', 200).then(n => order.push(n)), gate.read('fast', 5).then(n => order.push(n))]);
return order;`)));
      assert.deepEqual(value, ['fast', 'slow']);
    });
  });

  test('calls still running when the script fails are revoked', async () => {
    await withGate({}, async (runtime, probe) => {
      const s = runtime.createSession({ context: {}, capabilities: ['*'] });
      const started = performance.now();
      const error = failed(await s.execute(javascript("await Promise.all([gate.read('long', 5000), gate.failSoon()]);")));
      assert.equal(error.name, 'HostError');
      assert.ok(performance.now() - started < 4000);
      await delay(20);
      assert.ok(probe.log.includes('cancelled:long'), probe.log.join(', '));
    });
  });

  test('the descriptor says whether a method is concurrent', async () => {
    await withGate({}, (runtime) => {
      const methods = new Map(runtime.contract.namespaces.flatMap((ns) => ns.methods).map((m) => [m.qualifiedName, m]));
      assert.equal(methods.get('gate.read')?.concurrent, true);
      assert.equal(methods.get('gate.write')?.concurrent, false);
    });
  });
});
