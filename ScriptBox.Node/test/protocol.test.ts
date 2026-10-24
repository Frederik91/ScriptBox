// Acceptance 11 and 30, below the public API: the guest worker driven
// directly with forged messages, and bundled files or versions that do not
// match what the package was built with.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { loadAssets } from '../dist/assets.js';
import { buildInfo } from '../dist/generated/build-info.js';
import { bootstrapVersion, guestAbiVersion, readParentMessage, readWorkerMessage, workerProtocolVersion, type GuestWorkerData, type WorkerMessage } from '../dist/protocol.js';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const packageRoot = fileURLToPath(new URL('../', import.meta.url));

/** A guest worker started by hand, with every message it sends collected. */
async function startGuest(script: string, overrides: Partial<GuestWorkerData> = {}, bootstrapOptions: Record<string, unknown> = {}): Promise<{
  worker: Worker;
  messages: WorkerMessage[];
  next: (predicate: (m: WorkerMessage) => boolean) => Promise<WorkerMessage>;
  exited: Promise<number>;
  errors: Error[];
}> {
  const assets = await loadAssets();
  const options = { bootstrap: bootstrapVersion, maxDepth: 64, ...bootstrapOptions };
  const data: GuestWorkerData = {
    protocol: workerProtocolVersion,
    module: assets.module,
    abiVersion: guestAbiVersion,
    initialMemoryBytes: buildInfo.artifact.initialMemoryBytes,
    bootstrap: [
      { name: 'scriptbox.js', code: `globalThis.__scriptbox_options = ${JSON.stringify(options)};\n${assets.bootstrapCode}` },
      { name: 'apis.js', code: 'globalThis.test = { echo: __scriptbox.createMethod("test.echo") };' },
    ],
    script: { name: 'script.js', code: `(async () => {"use strict";${script}\n})()` },
    limits: { memoryBytes: 64 * 1024 * 1024, messageBytes: 4096, rpcBytes: 1024 * 1024, hostCalls: 16, outstandingCalls: 4, resultBytes: 4096, logEntries: 10, logEntryBytes: 256 },
    clockStartMs: 0,
    frozenClock: true,
    ...overrides,
  };
  const worker = new Worker(join(dist, 'guest', 'worker.js'), { workerData: data, env: {}, stdout: true, stderr: true });
  worker.stdout.resume();
  worker.stderr.resume();
  const messages: WorkerMessage[] = [];
  const waiters: { predicate: (m: WorkerMessage) => boolean; resolve: (m: WorkerMessage) => void }[] = [];
  const errors: Error[] = [];
  worker.on('message', (raw: unknown) => {
    const message = readWorkerMessage(raw);
    assert.ok(message !== undefined, `the worker sent a malformed message: ${JSON.stringify(raw)}`);
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });
  worker.on('error', (error: unknown) => errors.push(error instanceof Error ? error : new Error(String(error))));
  const exited = new Promise<number>((resolve) => worker.once('exit', resolve));
  const next = (predicate: (m: WorkerMessage) => boolean): Promise<WorkerMessage> => {
    const found = messages.find(predicate);
    return found !== undefined ? Promise.resolve(found) : new Promise((resolve) => waiters.push({ predicate, resolve }));
  };
  return { worker, messages, next, exited, errors };
}

const isTerminal = (m: WorkerMessage): boolean => m.t === 'result' || m.t === 'error' || m.t === 'limit';

describe('message readers (11)', () => {
  test('malformed worker messages are refused', () => {
    const malformed: unknown[] = [
      null, 42, 'call', [], {}, { t: 'nope' },
      { t: 'call', id: -1, payload: '{}', bytes: 2 }, { t: 'call', id: 1.5, payload: '{}', bytes: 2 }, { t: 'call', id: 1, payload: {}, bytes: 2 },
      { t: 'result', json: 1, bytes: 0, memoryBytes: 0 }, { t: 'error', kind: 'other', name: 'E', message: 'm', stack: '', memoryBytes: 0 },
      { t: 'limit', limit: 'cpu', detail: '', memoryBytes: 0 }, { t: 'refused', method: 'a', reason: 'maybe', bytes: 0 },
      { t: 'log', level: 0, text: 'x', bytes: 1 },
    ];
    for (const value of malformed) {
      assert.equal(readWorkerMessage(value), undefined, JSON.stringify(value));
    }
    assert.deepEqual(readWorkerMessage({ t: 'call', id: 1, payload: '{}', bytes: 2, extra: true }), { t: 'call', id: 1, payload: '{}', bytes: 2 });
  });

  test('malformed parent messages are refused', () => {
    for (const value of [null, { t: 'settle' }, { t: 'settle', id: '1', response: '{}' }, { t: 'settle', id: 1, response: {} }, { t: 'other', id: 1, response: '{}' }]) {
      assert.equal(readParentMessage(value), undefined, JSON.stringify(value));
    }
  });
});

describe('the guest worker under forged messages (11)', () => {
  test('a settle for an unknown id, a repeat settle and junk are ignored; the real answer still lands once', async () => {
    const guest = await startGuest('const a = await test.echo(1); return a;');
    const call = await guest.next((m) => m.t === 'call');
    assert.ok(call.t === 'call');
    guest.worker.postMessage({ t: 'settle', id: call.id + 100, response: JSON.stringify({ id: call.id + 100, result: 'forged' }) });
    guest.worker.postMessage({ t: 'settle', id: '1', response: '{}' });
    guest.worker.postMessage('garbage');
    guest.worker.postMessage({ t: 'settle', id: call.id, response: JSON.stringify({ id: call.id, result: 'real' }) });
    guest.worker.postMessage({ t: 'settle', id: call.id, response: JSON.stringify({ id: call.id, result: 'again' }) });
    const end = await guest.next(isTerminal);
    assert.deepEqual(end.t === 'result' ? end.json : end, '"real"');
    await guest.worker.terminate();
  });

  test('call ids belong to one execution: another guest\'s answer for the same id cannot reach this one', async () => {
    const a = await startGuest('return await test.echo("a");');
    const b = await startGuest('return await test.echo("b");');
    const callA = await a.next((m) => m.t === 'call');
    const callB = await b.next((m) => m.t === 'call');
    assert.ok(callA.t === 'call' && callB.t === 'call');
    // Both executions number their calls from 1; each has its own channel, so answers cannot cross.
    assert.equal(callA.id, callB.id);
    a.worker.postMessage({ t: 'settle', id: callA.id, response: JSON.stringify({ id: callA.id, result: 'for a' }) });
    b.worker.postMessage({ t: 'settle', id: callB.id, response: JSON.stringify({ id: callB.id, result: 'for b' }) });
    const [endA, endB] = await Promise.all([a.next(isTerminal), b.next(isTerminal)]);
    assert.ok(endA.t === 'result' && endB.t === 'result');
    assert.deepEqual([endA.json, endB.json], ['"for a"', '"for b"']);
    await Promise.all([a.worker.terminate(), b.worker.terminate()]);
  });

  test('a response that is not JSON, or names another call, fails the execution closed', async () => {
    for (const response of ['not json', JSON.stringify({ id: 999, result: 1 })]) {
      const guest = await startGuest('try { return await test.echo(1); } catch (e) { return "caught"; }');
      const call = await guest.next((m) => m.t === 'call');
      assert.ok(call.t === 'call');
      guest.worker.postMessage({ t: 'settle', id: call.id, response });
      const end = await guest.next(isTerminal);
      assert.equal(end.t, 'error', response);
      assert.ok(end.kind === 'script' || end.kind === 'protocol');
      await guest.worker.terminate();
    }
  });

  test('worker data from another protocol version stops the worker before any script runs', async () => {
    const guest = await startGuest('return await test.echo(1);', { protocol: workerProtocolVersion + 1 });
    await guest.exited;
    assert.equal(guest.messages.length, 0);
    assert.match(guest.errors[0]?.message ?? '', /another protocol version/);
  });
});

describe('versions and artifacts (30)', () => {
  test('a guest built for another ABI is refused before the script runs', async () => {
    const guest = await startGuest('return await test.echo(1);', { abiVersion: 1 });
    const end = await guest.next(isTerminal);
    assert.ok(end.t === 'error' && end.kind === 'protocol');
    assert.match(end.message, /speaks ABI 2, but the host expects 1/);
    assert.equal(guest.messages.some((m) => m.t === 'call'), false);
    await guest.worker.terminate();
  });

  test('a bootstrap of another version is refused before the script runs', async () => {
    const guest = await startGuest('return await test.echo(1);', {}, { bootstrap: bootstrapVersion + 1 });
    const end = await guest.next(isTerminal);
    assert.ok(end.t === 'error' && end.kind === 'bootstrap');
    assert.equal(guest.messages.some((m) => m.t === 'call'), false);
    await guest.worker.terminate();
  });

  const tampered: string[] = [];
  after(() => {
    for (const directory of tampered) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  for (const file of [buildInfo.artifact.file, buildInfo.bootstrap.file]) {
    test(`a changed ${file} stops createRuntime`, async () => {
      // A copy of the package next to its node_modules, with one byte of the file changed.
      const copy = mkdtempSync(join(packageRoot, '.tamper-'));
      tampered.push(copy);
      cpSync(dist, join(copy, 'dist'), { recursive: true });
      const target = join(copy, 'dist', 'assets', file);
      const bytes = readFileSync(target);
      bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
      writeFileSync(target, bytes);
      const module: unknown = await import(new URL(`file:///${join(copy, 'dist', 'index.js').replaceAll('\\', '/')}`).href);
      const create: unknown = typeof module === 'object' && module !== null ? Reflect.get(module, 'createRuntime') : undefined;
      assert.ok(typeof create === 'function');
      const created: unknown = Reflect.apply(create, undefined, [{ apis: [] }]);
      await assert.rejects(Promise.resolve(created), { name: 'ProtocolMismatchError', message: new RegExp(`${file.replace('.', '\\.')} does not match`) });
    });
  }

  test('the committed build info matches the bundled artifacts', () => {
    const manifest: unknown = JSON.parse(readFileSync(join(packageRoot, '..', 'ScriptBox.Wasm', 'artifacts.json'), 'utf8'));
    assert.ok(typeof manifest === 'object' && manifest !== null);
    const artifacts: unknown = Reflect.get(manifest, 'artifacts');
    const entry: unknown = typeof artifacts === 'object' && artifacts !== null ? Reflect.get(artifacts, buildInfo.artifact.file) : undefined;
    assert.ok(typeof entry === 'object' && entry !== null);
    assert.equal(Reflect.get(entry, 'sha256'), buildInfo.artifact.sha256);
    assert.equal(Reflect.get(entry, 'abi'), guestAbiVersion);
  });
});
