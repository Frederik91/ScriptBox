// The guest worker: one WebAssembly instance of scriptbox-async.wasm, running
// one execution. It relays host calls to the parent and settles them when the
// parent answers. The parent terminates this worker to stop an execution, so
// nothing here has to cooperate with a stop.
//
// The worker is trusted code that handles untrusted data. It enforces the
// bounds it can check before anything is copied: message sizes, call counts,
// cumulative bytes, the result size and log volume. The parent checks again.
import { parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { isRecord } from '../json.ts';
import {
  readParentMessage,
  workerProtocolVersion,
  type GuestErrorKind,
  type GuestWorkerData,
  type RefusalReason,
  type ResourceLimit,
  type WorkerMessage,
} from '../protocol.ts';
import { createMemory, instantiate, isWasmModule } from '../wasm.ts';

// Status codes from scriptbox_wrapper.c.
const SB_OK = 0;
const SB_SCRIPT_ERROR = 1;
const SB_PENDING = 4;
const SB_UNHANDLED_REJECTION = 5;
const SB_SYNTAX_ERROR = 7;

// WASI errno values.
const ERRNO_BADF = 8;
const ERRNO_NOSYS = 52;

const maxErrorTextBytes = 8 * 1024;
const methodPrefixBytes = 512;

class GuestStop extends Error {
  readonly limit: ResourceLimit;
  constructor(limit: ResourceLimit, detail: string) {
    super(detail);
    this.limit = limit;
  }
}

class GuestFault extends Error {}

function readData(value: unknown): GuestWorkerData {
  if (!isRecord(value) || value['protocol'] !== workerProtocolVersion || !isWasmModule(value['module'])) {
    throw new Error('The guest worker was started with data from another protocol version.');
  }
  const limits = value['limits'];
  const script = value['script'];
  const bootstrap = value['bootstrap'];
  if (!isRecord(limits) || !isRecord(script) || !Array.isArray(bootstrap)) {
    throw new Error('The guest worker was started without its limits, script or bootstrap.');
  }
  const count = (record: Readonly<Record<string, unknown>>, key: string): number => {
    const n = record[key];
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) {
      throw new Error(`The guest worker's ${key} is not a count.`);
    }
    return n;
  };
  const text = (record: Readonly<Record<string, unknown>>, key: string): string => {
    const s = record[key];
    if (typeof s !== 'string') {
      throw new Error(`The guest worker's ${key} is not text.`);
    }
    return s;
  };
  const bootstrapItems: unknown[] = bootstrap;
  return {
    protocol: workerProtocolVersion,
    module: value['module'],
    abiVersion: count(value, 'abiVersion'),
    initialMemoryBytes: count(value, 'initialMemoryBytes'),
    bootstrap: bootstrapItems.map((item) => {
      if (!isRecord(item)) {
        throw new Error('A bootstrap script is malformed.');
      }
      return { name: text(item, 'name'), code: text(item, 'code') };
    }),
    script: { name: text(script, 'name'), code: text(script, 'code') },
    limits: {
      memoryBytes: count(limits, 'memoryBytes'),
      messageBytes: count(limits, 'messageBytes'),
      rpcBytes: count(limits, 'rpcBytes'),
      hostCalls: count(limits, 'hostCalls'),
      outstandingCalls: count(limits, 'outstandingCalls'),
      resultBytes: count(limits, 'resultBytes'),
      logEntries: count(limits, 'logEntries'),
      logEntryBytes: count(limits, 'logEntryBytes'),
    },
    clockStartMs: count(value, 'clockStartMs'),
    frozenClock: value['frozenClock'] === true,
  };
}

type ExportFunction = (...args: number[]) => number;

function exportFunction(exports: Readonly<Record<string, unknown>>, name: string): ExportFunction {
  const fn = exports[name];
  if (typeof fn !== 'function') {
    throw new GuestFault(`The guest does not export ${name}; it was built for another version of ScriptBox.`);
  }
  return (...args: number[]): number => {
    const result: unknown = Reflect.apply(fn, undefined, args);
    return typeof result === 'number' ? result : 0;
  };
}

function run(port: NonNullable<typeof parentPort>, data: GuestWorkerData): void {
  const limits = data.limits;
  const memory = createMemory(data.initialMemoryBytes / 65536, limits.memoryBytes / 65536);
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const encoder = new TextEncoder();
  const clockOrigin = performance.now();

  let nextId = 1;
  const outstanding = new Set<number>();
  // Calls admitted during the current guest step. They reach the parent only
  // once the step ends without failing, so a script that fails never starts
  // the calls it made in its last step.
  let posted: { id: number; payload: string; bytes: number }[] = [];
  let attempts = 0;
  let rpcBytes = 0;
  let logs = 0;
  let logsDropped = false;
  let mainSettled = false;
  let finished = false;
  let resultJson: string | null | undefined;
  let lastError: { name: string; message: string; stack: string } | undefined;

  const bytes = (ptr: number, len: number): Uint8Array => new Uint8Array(memory.buffer, ptr, len);
  const read = (ptr: number, len: number): string => decoder.decode(bytes(ptr, len));
  const readBounded = (ptr: number, len: number, max: number): string => read(ptr, Math.min(len, max));
  const send = (message: WorkerMessage): void => {
    port.postMessage(message);
  };

  const spendRpc = (n: number): void => {
    rpcBytes += n;
    if (rpcBytes > limits.rpcBytes) {
      throw new GuestStop('rpc-bytes', `Host calls exchanged more than ${limits.rpcBytes} bytes.`);
    }
  };

  const nowMs = (): number => data.frozenClock ? data.clockStartMs : data.clockStartMs + (performance.now() - clockOrigin);

  // The method's name leads the request the bootstrap writes.
  const methodOf = (prefix: string): string => /^\{"method":"([^"\\]{0,256})"/.exec(prefix)?.[1] ?? '';

  const refuse = (ptr: number, len: number, reason: RefusalReason, code: number): number => {
    send({ t: 'refused', method: methodOf(readBounded(ptr, len, methodPrefixBytes)), reason, bytes: len });
    return code;
  };

  const sendPosted = (): void => {
    for (const call of posted) {
      send({ t: 'call', id: call.id, payload: call.payload, bytes: call.bytes });
    }
    posted = [];
  };

  const revokePosted = (): void => {
    for (const call of posted) {
      outstanding.delete(call.id);
      send({ t: 'refused', method: methodOf(call.payload.slice(0, methodPrefixBytes)), reason: 'revoked', bytes: call.bytes });
    }
    posted = [];
  };

  const host = {
    post: (ptr: number, len: number): number => {
      attempts++;
      if (attempts > limits.hostCalls) {
        throw new GuestStop('host-calls', `The script tried more than ${limits.hostCalls} host calls.`);
      }
      spendRpc(len);
      if (len > limits.messageBytes) {
        return refuse(ptr, len, 'request-too-large', -2);
      }
      if (mainSettled) {
        return refuse(ptr, len, 'revoked', 0);
      }
      if (outstanding.size >= limits.outstandingCalls) {
        return refuse(ptr, len, 'queue-full', -1);
      }
      const id = nextId++;
      outstanding.add(id);
      posted.push({ id, payload: read(ptr, len), bytes: len });
      return id;
    },
    limit: (): never => {
      throw new GuestStop('memory', `The script used all ${limits.memoryBytes} bytes of its memory.`);
    },
    log: (level: number, ptr: number, len: number): void => {
      if (logs >= limits.logEntries) {
        if (!logsDropped) {
          logsDropped = true;
          send({ t: 'logs-dropped' });
        }
        return;
      }
      logs++;
      send({ t: 'log', level, text: readBounded(ptr, len, limits.logEntryBytes), bytes: len, cut: len > limits.logEntryBytes });
    },
    interrupt: (): number => 0,
    result: (ptr: number, len: number): void => {
      if (len > limits.resultBytes) {
        throw new GuestStop('result-bytes', `The script returned ${len} bytes of JSON, more than the ${limits.resultBytes} allowed.`);
      }
      resultJson = len === 0 ? null : read(ptr, len);
    },
    error: (namePtr: number, nameLen: number, messagePtr: number, messageLen: number, stackPtr: number, stackLen: number): void => {
      lastError = {
        name: readBounded(namePtr, nameLen, 256),
        message: readBounded(messagePtr, messageLen, maxErrorTextBytes),
        stack: readBounded(stackPtr, stackLen, maxErrorTextBytes),
      };
    },
  };

  // The guest gets a clock and nothing else: no files, no environment, no
  // arguments. Output to stdout and stderr is discarded; QuickJS writes there
  // only from debugging helpers this build never calls.
  const wasi = {
    clock_time_get: (clockId: number, _precision: bigint, out: number): number => {
      const ms = clockId === 0 ? nowMs() : (data.frozenClock ? 0 : performance.now() - clockOrigin);
      new DataView(memory.buffer).setBigUint64(out, BigInt(Math.floor(ms * 1_000_000)), true);
      return 0;
    },
    args_sizes_get: (countPtr: number, sizePtr: number): number => {
      const view = new DataView(memory.buffer);
      view.setUint32(countPtr, 0, true);
      view.setUint32(sizePtr, 0, true);
      return 0;
    },
    args_get: (): number => 0,
    fd_write: (fd: number, iovs: number, iovsLen: number, written: number): number => {
      if (fd !== 1 && fd !== 2) {
        return ERRNO_BADF;
      }
      const view = new DataView(memory.buffer);
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        total += view.getUint32(iovs + i * 8 + 4, true);
      }
      view.setUint32(written, total, true);
      return 0;
    },
    fd_close: (): number => ERRNO_BADF,
    fd_seek: (): number => ERRNO_BADF,
    poll_oneoff: (): number => ERRNO_NOSYS,
    proc_exit: (): never => {
      throw new GuestFault('The guest exited.');
    },
  };

  const x = instantiate(data.module, { env: { memory }, host, wasi_snapshot_preview1: wasi });
  const abiVersion = exportFunction(x, 'sb_abi_version');
  const init = exportFunction(x, 'sb_init');
  const evaluate = exportFunction(x, 'sb_eval');
  const resume = exportFunction(x, 'sb_resume');
  const finishGuest = exportFunction(x, 'sb_finish');
  const alloc = exportFunction(x, 'sb_alloc');
  const free = exportFunction(x, 'sb_free');

  const write = (text: string | Uint8Array): [number, number] => {
    const encoded = typeof text === 'string' ? encoder.encode(text) : text;
    const ptr = alloc(encoded.length);
    if (ptr === 0) {
      throw new GuestStop('memory', 'The guest had no memory left for a message from the host.');
    }
    bytes(ptr, encoded.length).set(encoded);
    return [ptr, encoded.length];
  };

  const evalScript = (name: string, code: string, mode: number): number => {
    const [codePtr, codeLen] = write(code);
    const [namePtr, nameLen] = write(name);
    try {
      return evaluate(codePtr, codeLen, namePtr, nameLen, mode);
    } finally {
      free(namePtr);
    }
  };

  const memoryBytes = (): number => memory.buffer.byteLength;

  const fail = (kind: GuestErrorKind, fallback: string): void => {
    finished = true;
    revokePosted();
    const error = lastError ?? { name: 'Error', message: fallback, stack: '' };
    send({ t: 'error', kind, name: error.name, message: error.message, stack: error.stack, memoryBytes: memoryBytes() });
  };

  const complete = (): void => {
    const status = finishGuest();
    if (status === SB_UNHANDLED_REJECTION) {
      fail('unhandled', 'A promise was rejected and nothing handled it.');
      return;
    }
    if (status !== SB_OK) {
      fail('protocol', `sb_finish returned ${status}.`);
      return;
    }
    finished = true;
    const json = resultJson ?? null;
    send({ t: 'result', json, bytes: json === null ? 0 : encoder.encode(json).length, memoryBytes: memoryBytes() });
  };

  // Acts on a status from sb_eval (mode 2) or sb_resume.
  const handle = (status: number): void => {
    if (finished) {
      return;
    }
    if (!mainSettled) {
      if (status === SB_PENDING) {
        if (outstanding.size === 0) {
          lastError = undefined;
          fail('never-settled', 'The script awaited a promise that nothing can settle: no host call is pending.');
        }
        return;
      }
      mainSettled = true;
      if (status === SB_OK) {
        if (outstanding.size === 0) {
          complete();
        } else {
          // The script returned with calls still pending. They were admitted,
          // so they run to completion; no new call is admitted.
          send({ t: 'returned' });
        }
        return;
      }
      if (status === SB_SYNTAX_ERROR) {
        fail('syntax', 'The script did not compile.');
        return;
      }
      if (status === SB_SCRIPT_ERROR) {
        fail('script', 'The script failed.');
        return;
      }
      fail('protocol', `The guest returned status ${status}.`);
      return;
    }
    if (status !== SB_OK) {
      fail(status === SB_SCRIPT_ERROR ? 'script' : 'protocol', `The guest returned status ${status} while settling a call.`);
      return;
    }
    if (outstanding.size === 0) {
      complete();
    }
  };

  // Runs guest code, turning a trap into the message that ends the execution.
  const guard = (action: () => void): void => {
    try {
      action();
      sendPosted();
    } catch (error) {
      finished = true;
      revokePosted();
      if (error instanceof GuestStop) {
        send({ t: 'limit', limit: error.limit, detail: error.message, memoryBytes: memoryBytes() });
      } else if (error instanceof RangeError && /call stack/i.test(error.message)) {
        send({ t: 'error', kind: 'script', name: 'InternalError', message: 'stack overflow', stack: '', memoryBytes: memoryBytes() });
      } else {
        const message = error instanceof Error ? `${error.name}: ${error.message}` : 'The guest stopped.';
        send({ t: 'error', kind: 'protocol', name: 'SandboxFault', message, stack: '', memoryBytes: memoryBytes() });
      }
    }
  };

  guard(() => {
    if (abiVersion() !== data.abiVersion) {
      throw new GuestFault(`The guest speaks ABI ${abiVersion()}, but the host expects ${data.abiVersion}.`);
    }
    if (init() !== SB_OK) {
      fail('bootstrap', 'The guest could not start its JavaScript runtime.');
      return;
    }
    for (const script of data.bootstrap) {
      if (evalScript(script.name, script.code, 0) !== SB_OK) {
        fail('bootstrap', `The bootstrap script ${script.name} failed.`);
        return;
      }
    }
    handle(evalScript(data.script.name, data.script.code, 2));
  });

  port.on('message', (raw: unknown) => {
    if (finished) {
      return;
    }
    const message = readParentMessage(raw);
    // Only a call this execution admitted and has not settled can be settled,
    // once. Anything else is ignored.
    if (message === undefined || !outstanding.delete(message.id)) {
      return;
    }
    guard(() => {
      const encoded = encoder.encode(message.response);
      spendRpc(encoded.length);
      const [ptr, len] = write(encoded);
      handle(resume(ptr, len));
    });
  });
}

const port = parentPort;
if (port === null) {
  throw new Error('The guest worker must run as a worker thread.');
}
run(port, readData(workerData));
