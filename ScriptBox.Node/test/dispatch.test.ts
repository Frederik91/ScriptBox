// Acceptance 7 to 13: real async calls, filters, capabilities, discovery,
// forged input, bridge tampering and calls a script did not await.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, test } from 'node:test';
import {
  createRuntime,
  denyCall,
  type ExecutionEvent,
  type HostCallFilter,
  type JsonValue,
  type RuntimeOptions,
  type ScriptBoxRuntime,
} from '@frederik91/scriptbox';
import { catalogRuntime, completed, Draft, failed, heartbeat, testApis } from './helpers.ts';

type Ctx = { readonly tenant: string };

async function withRuntime(
  options: Omit<RuntimeOptions<Ctx>, 'apis'>,
  run: (runtime: ScriptBoxRuntime<Ctx>, log: string[]) => void | Promise<void>,
): Promise<void> {
  const log: string[] = [];
  const runtime = await createRuntime<Ctx>({ ...options, apis: [testApis(log).test] });
  try {
    await run(runtime, log);
  } finally {
    await runtime.dispose();
  }
}

describe('async host calls (7)', () => {
  test('a delayed read, a write, then a read of the staged value; the parent stays responsive', async () => {
    const { session, store } = await catalogRuntime({ delayMs: 150 });
    const draft = new Draft(store.snapshot());
    const s = session(draft);
    const beat = heartbeat();
    const started = performance.now();
    const outcome = await s.execute({
      language: 'typescript',
      source: `const item = await catalog.get({ id: 'desk-1' });
await draft.rename({ id: item.id, name: 'Desk by window' });
const updated = await catalog.get({ id: item.id });
return { id: updated.id, name: updated.name };`,
    });
    const elapsed = performance.now() - started;
    const gap = beat.stop();
    assert.deepEqual(completed(outcome), { id: 'desk-1', name: 'Desk by window' });
    assert.ok(elapsed >= 450, `three 150 ms calls took ${elapsed} ms`);
    assert.ok(gap < 60, `the parent's event loop stalled for ${gap} ms`);
    assert.deepEqual(outcome.evidence.calls.map((c) => [c.method, c.effect, c.disposition, c.handlerRan]), [
      ['catalog.get', 'read', 'completed', true],
      ['draft.rename', 'draft-write', 'completed', true],
      ['catalog.get', 'read', 'completed', true],
    ]);
    assert.equal(store.snapshot().items.get('desk-1')?.name, 'Standing desk', 'the accepted catalog is unchanged');
    await s.dispose();
  });

  test('calls started together run one at a time, in the order they were made', async () => {
    await withRuntime({}, async (runtime, log) => {
      const s = runtime.createSession({ context: { tenant: 'a' }, capabilities: ['*'] });
      const value = completed(await s.execute({
        language: 'javascript',
        source: 'return await Promise.all([test.wait(30, "a"), test.wait(1, "b"), test.wait(10, "c")]);',
      }));
      assert.deepEqual(value, ['a', 'b', 'c']);
      assert.deepEqual(log, ['wait:a:start', 'wait:a:end', 'wait:b:start', 'wait:b:end', 'wait:c:start', 'wait:c:end']);
    });
  });
});

describe('filters (8)', () => {
  test('runtime filters wrap session filters, each in the order added, on the way in and out', async () => {
    const order: string[] = [];
    const named = (name: string): HostCallFilter<Ctx> => async (_call, next) => {
      order.push(`${name}>`);
      const result = await next();
      order.push(`<${name}`);
      return result;
    };
    await withRuntime({ filters: [named('g1'), named('g2')] }, async (runtime, log) => {
      const s = runtime.createSession({ context: { tenant: 'a' }, capabilities: ['*'], filters: [named('s1'), named('s2')] });
      completed(await s.execute({ language: 'javascript', source: 'return await test.echo(1);' }));
      assert.deepEqual(order, ['g1>', 'g2>', 's1>', 's2>', '<s2', '<s1', '<g2', '<g1']);
      assert.deepEqual(log, ['echo']);
    });
  });

  test('a filter sees the method, the raw arguments and trusted identity before binding', async () => {
    const seen: unknown[] = [];
    await withRuntime({
      filters: [(call, next) => {
        seen.push({ method: call.method.qualifiedName, effect: call.method.effect, args: call.args, omitted: call.omitted, session: call.sessionId, tenant: call.context.tenant, frozen: Object.isFrozen(call.args) });
        return next();
      }],
    }, async (runtime) => {
      const s = runtime.createSession({ id: 'session-1', context: { tenant: 'a' }, capabilities: ['*'] });
      completed(await s.execute({ language: 'javascript', source: 'return await test.wait(0, undefined);' }));
      assert.deepEqual(seen, [{ method: 'test.wait', effect: 'read', args: [0], omitted: [], session: 'session-1', tenant: 'a', frozen: true }]);
    });
  });

  test('next may be called once; a second call fails and the handler runs once', async () => {
    await withRuntime({ filters: [async (_call, next) => {
      await next();
      return next();
    }] }, async (runtime, log) => {
      const s = runtime.createSession({ context: { tenant: 'a' }, capabilities: ['*'] });
      const outcome = await s.execute({ language: 'javascript', source: 'try { await test.echo(1); } catch (e) { return e.name; }' });
      assert.equal(completed(outcome), 'HostError');
      assert.deepEqual(log, ['echo']);
      assert.deepEqual(outcome.evidence.calls.map((c) => [c.disposition, c.handlerRan]), [['host-failure', true]]);
    });
  });

  test('a filter can deny a call; the script can catch it and the handler never runs', async () => {
    const events: ExecutionEvent[] = [];
    await withRuntime({
      onEvent: (event) => events.push(event),
      filters: [(call, next) => call.method.effect === 'draft-write' ? Promise.reject(denyCall('No writes in this demo.')) : next()],
    }, async (runtime, log) => {
      const s = runtime.createSession({ context: { tenant: 'a' }, capabilities: ['*'] });
      const outcome = await s.execute({ language: 'javascript', source: 'try { await test.nothing(); } catch (e) { return [e.name, e.message]; }' });
      assert.deepEqual(completed(outcome), ['PermissionDeniedError', 'No writes in this demo.']);
      assert.deepEqual(log, []);
      assert.deepEqual(outcome.evidence.calls.map((c) => [c.disposition, c.handlerRan]), [['denied', false]]);
      assert.ok(events.some((e) => e.type === 'host-call-denied' && e.reason === 'filter'));
    });
  });

  test('a replacement result must match the result schema, and says the handler did not run', async () => {
    let replacement: JsonValue = { count: 2 };
    await withRuntime({
      filters: [(call, next) => call.method.name === 'wrong' ? replacement : next()],
    }, async (runtime, log) => {
      const s = runtime.createSession({ context: { tenant: 'a' }, capabilities: ['*'] });
      const ok = await s.execute({ language: 'javascript', source: 'return await test.wrong();' });
      assert.deepEqual(completed(ok), { count: 2 });
      assert.deepEqual(ok.evidence.calls.map((c) => [c.disposition, c.handlerRan]), [['replaced', false]]);

      replacement = { count: 'two', extra: true };
      const bad = await s.execute({ language: 'javascript', source: 'try { await test.wrong(); } catch (e) { return e.name; }' });
      assert.equal(completed(bad), 'HostError');
      assert.deepEqual(bad.evidence.calls.map((c) => [c.disposition, c.handlerRan]), [['invalid-result', false]]);
      assert.deepEqual(log, [], 'the handler never ran');
    });
  });

  test('a filter that changes the handler\'s result is recorded as replaced, with the handler run', async () => {
    await withRuntime({
      filters: [async (_call, next) => {
        const value = await next();
        return typeof value === 'number' ? value + 1 : value;
      }],
    }, async (runtime) => {
      const s = runtime.createSession({ context: { tenant: 'a' }, capabilities: ['*'] });
      const outcome = await s.execute({ language: 'javascript', source: 'return await test.echo(1);' });
      assert.equal(completed(outcome), 2);
      assert.deepEqual(outcome.evidence.calls.map((c) => [c.disposition, c.handlerRan]), [['replaced', true]]);
    });
  });

  test('a handler result that breaks its own schema is a host error, not a value', async () => {
    await withRuntime({}, async (runtime) => {
      const s = runtime.createSession({ context: { tenant: 'a' }, capabilities: ['*'] });
      const outcome = await s.execute({ language: 'javascript', source: 'try { await test.wrong(); } catch (e) { return [e.name, e.message]; }' });
      assert.deepEqual(completed(outcome), ['HostError', 'test.wrong returned a value that does not match its declared result.']);
      assert.deepEqual(outcome.evidence.calls.map((c) => c.disposition), ['invalid-result']);
    });
  });
});

describe('capabilities (9, 10)', () => {
  test('a method outside the capabilities is denied through its wrapper and through the low-level bridge', async () => {
    await withRuntime({}, async (runtime, log) => {
      const s = runtime.createSession({ context: { tenant: 'a' }, capabilities: ['test.echo'] });
      const value = completed(await s.execute({
        language: 'javascript',
        source: `const out = [];
for (const attempt of [() => test.fail(), () => __scriptbox.hostCall('test.fail', []), () => __scriptbox.createMethod('test.fail')()]) {
  try { await attempt(); out.push('called'); } catch (e) { out.push(e.name); }
}
out.push(await test.echo('allowed'));
return out;`,
      }));
      assert.deepEqual(value, ['PermissionDeniedError', 'PermissionDeniedError', 'PermissionDeniedError', 'allowed']);
      assert.deepEqual(log, ['echo']);
    });
  });

  test('a method hidden from discovery but allowed still works; hidden and not allowed fails even by name', async () => {
    await withRuntime({}, async (runtime, log) => {
      const hidden = (name: string) => (m: { qualifiedName: string }) => m.qualifiedName !== name;
      const allowed = runtime.createSession({ context: { tenant: 'a' }, capabilities: ['*'], discover: hidden('test.tenant') });
      assert.doesNotMatch(allowed.getTypeScriptDeclarations(), /tenant\(/);
      const docs = completed(await allowed.execute({ language: 'javascript', source: 'return (await docs.ls("/api/test")).map(e => e.path);' }));
      assert.ok(Array.isArray(docs) && !docs.includes('/api/test/tenant.d.ts') && docs.includes('/api/test/echo.d.ts'));
      assert.equal(completed(await allowed.execute({ language: 'javascript', source: 'return await test.tenant();' })), 'a');

      const denied = runtime.createSession({ context: { tenant: 'b' }, capabilities: ['test.echo'], discover: hidden('test.tenant') });
      const value = completed(await denied.execute({ language: 'javascript', source: 'try { return await __scriptbox.hostCall("test.tenant", []); } catch (e) { return e.name; }' }));
      assert.equal(value, 'PermissionDeniedError');
      assert.deepEqual(log, ['tenant']);
    });
  });

  test('a capability naming nothing registered is a configuration error', async () => {
    await withRuntime({}, (runtime) => {
      assert.throws(() => runtime.createSession({ context: { tenant: 'a' }, capabilities: ['test.missing'] }), /names no registered method/);
      assert.throws(() => runtime.createSession({ context: { tenant: 'a' }, capabilities: ['other.*'] }), /names no registered namespace/);
    });
  });
});

describe('forged and malformed input (11)', () => {
  test('scope comes from the session, not the script: a claimed tenant is refused', async () => {
    await withRuntime({}, async (runtime, log) => {
      const s = runtime.createSession({ context: { tenant: 'a' }, capabilities: ['*'] });
      const value = completed(await s.execute({
        language: 'javascript',
        source: `const out = [];
try { await test.tenant({ tenant: 'b', role: 'admin', approved: true }); } catch (e) { out.push(e.name); }
out.push(await test.tenant());
return out;`,
      }));
      assert.deepEqual(value, ['InvalidArgumentsError', 'a']);
      assert.deepEqual(log, ['tenant']);
    });
  });

  test('unknown and malformed method names are refused', async () => {
    await withRuntime({}, async (runtime, log) => {
      const s = runtime.createSession({ context: { tenant: 'a' }, capabilities: ['*'] });
      const names = ['nope.x', 'test.missing', 'test', 'test.echo.x', '__proto__.x', 'test.__proto__', 'test.constructor', 'test.hasOwnProperty', 'constructor', ' test.echo', 'test.echo ', 'x'.repeat(5000)];
      const value = completed(await s.execute({
        language: 'javascript',
        source: `const out = [];
for (const name of ${JSON.stringify(names)}) {
  try { await __scriptbox.hostCall(name, [1]); out.push('called'); } catch (e) { out.push(e.name); }
}
return out;`,
      }));
      assert.deepEqual(value, names.map(() => 'UnknownMethodError'));
      assert.deepEqual(log, []);
    });
  });

  test('a non-string method name and a non-array argument list are refused in the guest', async () => {
    await withRuntime({}, async (runtime, log) => {
      const s = runtime.createSession({ context: { tenant: 'a' }, capabilities: ['*'] });
      const value = completed(await s.execute({
        language: 'javascript',
        source: `const out = [];
for (const name of [42, null, '', { toString() { return 'test.echo'; } }]) {
  try { await __scriptbox.hostCall(name, [1]); out.push('called'); } catch (e) { out.push(e.name); }
}
return out;`,
      }));
      assert.deepEqual(value, ['TypeError', 'TypeError', 'TypeError', 'TypeError']);
      assert.deepEqual(log, []);
    });
  });
});

describe('bridge tampering (12)', () => {
  test('a script cannot replace a namespace, its methods or the bridge', async () => {
    await withRuntime({}, async (runtime, log) => {
      const s = runtime.createSession({ context: { tenant: 'a' }, capabilities: ['test.echo'] });
      const value = completed(await s.execute({
        language: 'javascript',
        source: `const out = [];
const attempts = [
  () => { test.echo = () => 'fake'; },
  () => { globalThis.test = { echo: () => 'fake' }; },
  () => { delete globalThis.test; },
  () => { __scriptbox.hostCall = () => 'fake'; },
  () => { Object.defineProperty(test, 'echo', { value: () => 'fake' }); },
];
for (const attempt of attempts) {
  try { attempt(); out.push('changed'); } catch (e) { out.push(e.name); }
}
out.push(typeof __host);
out.push(await test.echo('real'));
return out;`,
      }));
      assert.deepEqual(value, ['TypeError', 'TypeError', 'TypeError', 'TypeError', 'TypeError', 'undefined', 'real']);
      assert.deepEqual(log, ['echo']);
    });
  });

  test('a global the script redefines changes only its own view; every call still passes the dispatcher', async () => {
    // This QuickJS lets Object.defineProperty redefine a read-only property of
    // the global object. The bridge itself lives in the guest's C code and the
    // host, so a redefined global can only point the script at its own code.
    await withRuntime({}, async (runtime, log) => {
      const s = runtime.createSession({ context: { tenant: 'a' }, capabilities: ['test.echo'] });
      const value = completed(await s.execute({
        language: 'javascript',
        source: `const realEcho = test.echo;
Object.defineProperty(globalThis, '__scriptbox', { value: { hostCall: () => 'fake' } });
Object.defineProperty(globalThis, 'test', { value: { echo: () => 'fake', fail: () => 'fake' } });
const out = [__scriptbox.hostCall('test.fail', []), test.fail(), await realEcho('real')];
try { await __scriptbox.createMethod('test.fail')(); } catch (e) { out.push(e.name); }
return out;`,
      }));
      assert.deepEqual(value, ['fake', 'fake', 'real', 'TypeError']);
      assert.deepEqual(log, ['echo'], 'only the real, permitted call reached a handler');
    });
  });

  test('replacing JSON, Array methods or prototypes does not change what reaches the host', async () => {
    const seen: unknown[] = [];
    await withRuntime({ filters: [(call, next) => {
      seen.push([call.method.qualifiedName, call.args]);
      return next();
    }] }, async (runtime, log) => {
      const s = runtime.createSession({ context: { tenant: 'a' }, capabilities: ['test.echo'] });
      const value = completed(await s.execute({
        language: 'javascript',
        source: `JSON.stringify = () => '{"method":"test.fail","args":[]}';
JSON.parse = () => ({ id: 1, result: 'forged' });
Array.prototype.join = function () { return 'x'; };
Array.prototype.push = function () { return 0; };
Object.keys = () => ['approved'];
Object.prototype.approved = true;
Object.prototype.toJSON = function () { return { approved: true }; };
const result = await test.echo({ value: 1 });
return [result.value, Object.prototype.hasOwnProperty.call(result, 'approved')];`,
      }));
      assert.deepEqual(value, [1, false]);
      assert.deepEqual(seen, [['test.echo', [{ value: 1 }]]]);
      assert.deepEqual(log, ['echo']);
    });
  });

  test('changing a returned object changes only the script\'s copy', async () => {
    const { session, store } = await catalogRuntime();
    const draft = new Draft(store.snapshot());
    const s = session(draft);
    const value = completed(await s.execute({
      language: 'javascript',
      source: `const item = await catalog.get({ id: 'desk-1' });
item.name = 'Hacked';
item.id = 'chair-1';
const again = await catalog.get({ id: 'desk-1' });
return again.name;`,
    }));
    assert.equal(value, 'Standing desk');
    assert.equal(draft.get('desk-1')?.name, 'Standing desk');
    assert.deepEqual(draft.summary().modified, []);
    await s.dispose();
  });
});

describe('calls the script did not await (13)', () => {
  test('a pending write finishes before the outcome; a new call after return is refused', async () => {
    const { session, store } = await catalogRuntime({ delayMs: 100 });
    const draft = new Draft(store.snapshot());
    const s = session(draft);
    const outcome = await s.execute({
      language: 'javascript',
      source: `draft.rename({ id: 'desk-1', name: 'Renamed later' })
  .then(() => draft.create({ name: 'Too late' }))
  .catch((e) => console.log(e.name));
return 'returned';`,
    });
    assert.equal(completed(outcome), 'returned');
    // The outcome arrives only once the admitted write has finished.
    assert.equal(draft.get('desk-1')?.name, 'Renamed later');
    assert.deepEqual(outcome.logs.map((l) => l.text), ['RevokedError']);
    assert.deepEqual(outcome.evidence.calls.map((c) => [c.method, c.disposition]), [['draft.rename', 'completed'], ['draft.create', 'revoked']]);
    assert.deepEqual(draft.summary().added, []);
    await s.dispose();
  });

  test('a pending write that fails after return fails the execution', async () => {
    const { session, store } = await catalogRuntime({ delayMs: 20 });
    const draft = new Draft(store.snapshot());
    const s = session(draft);
    const error = failed(await s.execute({ language: 'javascript', source: 'draft.rename({ id: "missing", name: "x" }); return "returned";' }));
    assert.equal(error.code, 'unhandled-rejection');
    assert.equal(error.name, 'NotFoundError');
    await s.dispose();
  });

  test('when the script fails, a pending write is revoked and cannot land later', async () => {
    const { session, store } = await catalogRuntime({ delayMs: 200 });
    const draft = new Draft(store.snapshot());
    const s = session(draft);
    const outcome = await s.execute({ language: 'javascript', source: 'draft.rename({ id: "desk-1", name: "Never" }); await null; throw new Error("boom");' });
    assert.equal(failed(outcome).message, 'boom');
    await delay(300);
    assert.equal(draft.get('desk-1')?.name, 'Standing desk');
    assert.deepEqual(outcome.evidence.calls.map((c) => [c.method, c.disposition]), [['draft.rename', 'revoked']]);
    await s.dispose();
  });
});
