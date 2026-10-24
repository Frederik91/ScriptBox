import { isRecord } from './json.ts';
import type { WasmModule } from './wasm.ts';

/** The guest ABI this host speaks: scriptbox-async.wasm's sb_abi_version. */
export const guestAbiVersion = 2;
/** The bootstrap contract this host speaks: scriptbox.js's BOOTSTRAP_VERSION. */
export const bootstrapVersion = 3;
/** The parent-to-worker message protocol, checked when the worker starts. */
export const workerProtocolVersion = 1;

/** Why a hard limit ended an execution. */
export type ResourceLimit =
  | 'source-bytes'
  | 'memory'
  | 'host-calls'
  | 'rpc-bytes'
  | 'result-bytes'
  | 'evidence'
  | 'compile-time'
  | 'compiler-memory'
  | 'worker-memory';

/** Everything the guest worker needs; passed as workerData. */
export interface GuestWorkerData {
  readonly protocol: number;
  readonly module: WasmModule;
  readonly abiVersion: number;
  readonly initialMemoryBytes: number;
  readonly bootstrap: readonly { readonly name: string; readonly code: string }[];
  readonly script: { readonly name: string; readonly code: string };
  readonly limits: {
    readonly memoryBytes: number;
    readonly messageBytes: number;
    readonly rpcBytes: number;
    readonly hostCalls: number;
    readonly outstandingCalls: number;
    readonly resultBytes: number;
    readonly logEntries: number;
    readonly logEntryBytes: number;
  };
  /** Milliseconds since the epoch the guest's clock starts at. */
  readonly clockStartMs: number;
  /** Whether the guest's clock stands still at clockStartMs, making Date and Math.random's seed repeatable. */
  readonly frozenClock: boolean;
}

/** Why the guest worker refused a call before it reached the parent's dispatcher. */
export type RefusalReason = 'queue-full' | 'request-too-large' | 'revoked';

/** The guest error kinds the worker reports. */
export type GuestErrorKind =
  | 'script'          // the script's promise rejected, or it threw while starting
  | 'syntax'          // the script did not parse
  | 'unhandled'       // a promise rejected and nothing handled it
  | 'never-settled'   // the script awaited something nothing could settle
  | 'encode'          // the script's result has no JSON form
  | 'bootstrap'       // the bootstrap failed
  | 'protocol';       // the guest and host disagree about the ABI

export type WorkerMessage =
  | { readonly t: 'call'; readonly id: number; readonly payload: string; readonly bytes: number }
  | { readonly t: 'refused'; readonly method: string; readonly reason: RefusalReason; readonly bytes: number }
  | { readonly t: 'log'; readonly level: number; readonly text: string; readonly bytes: number; readonly cut: boolean }
  | { readonly t: 'logs-dropped' }
  | { readonly t: 'returned' }
  | { readonly t: 'result'; readonly json: string | null; readonly bytes: number; readonly memoryBytes: number }
  | { readonly t: 'error'; readonly kind: GuestErrorKind; readonly name: string; readonly message: string; readonly stack: string; readonly memoryBytes: number }
  | { readonly t: 'limit'; readonly limit: ResourceLimit; readonly detail: string; readonly memoryBytes: number };

export type ParentMessage =
  | { readonly t: 'settle'; readonly id: number; readonly response: string };

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

const refusalReasons: readonly string[] = ['queue-full', 'request-too-large', 'revoked'];
const errorKinds: readonly string[] = ['script', 'syntax', 'unhandled', 'never-settled', 'encode', 'bootstrap', 'protocol'];
const limits: readonly string[] = ['source-bytes', 'memory', 'host-calls', 'rpc-bytes', 'result-bytes', 'evidence', 'compile-time', 'compiler-memory', 'worker-memory'];

function isRefusalReason(value: unknown): value is RefusalReason {
  return typeof value === 'string' && refusalReasons.includes(value);
}

function isErrorKind(value: unknown): value is GuestErrorKind {
  return typeof value === 'string' && errorKinds.includes(value);
}

function isLimit(value: unknown): value is ResourceLimit {
  return typeof value === 'string' && limits.includes(value);
}

/** Reads a message from the guest worker, which arrives as `unknown`. Returns undefined for anything malformed. */
export function readWorkerMessage(value: unknown): WorkerMessage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const v = value;
  switch (v['t']) {
    case 'call':
      return isCount(v['id']) && isString(v['payload']) && isCount(v['bytes'])
        ? { t: 'call', id: v['id'], payload: v['payload'], bytes: v['bytes'] } : undefined;
    case 'refused':
      return isString(v['method']) && isRefusalReason(v['reason']) && isCount(v['bytes'])
        ? { t: 'refused', method: v['method'], reason: v['reason'], bytes: v['bytes'] } : undefined;
    case 'log':
      return isCount(v['level']) && isString(v['text']) && isCount(v['bytes']) && typeof v['cut'] === 'boolean'
        ? { t: 'log', level: v['level'], text: v['text'], bytes: v['bytes'], cut: v['cut'] } : undefined;
    case 'logs-dropped':
      return { t: 'logs-dropped' };
    case 'returned':
      return { t: 'returned' };
    case 'result':
      return (v['json'] === null || isString(v['json'])) && isCount(v['bytes']) && isCount(v['memoryBytes'])
        ? { t: 'result', json: v['json'], bytes: v['bytes'], memoryBytes: v['memoryBytes'] } : undefined;
    case 'error':
      return isErrorKind(v['kind']) && isString(v['name']) && isString(v['message']) && isString(v['stack']) && isCount(v['memoryBytes'])
        ? { t: 'error', kind: v['kind'], name: v['name'], message: v['message'], stack: v['stack'], memoryBytes: v['memoryBytes'] } : undefined;
    case 'limit':
      return isLimit(v['limit']) && isString(v['detail']) && isCount(v['memoryBytes'])
        ? { t: 'limit', limit: v['limit'], detail: v['detail'], memoryBytes: v['memoryBytes'] } : undefined;
    default:
      return undefined;
  }
}

/** Reads a message from the parent, in the guest worker. */
export function readParentMessage(value: unknown): ParentMessage | undefined {
  if (!isRecord(value) || value['t'] !== 'settle') {
    return undefined;
  }
  const id = value['id'];
  const response = value['response'];
  return isCount(id) && isString(response) ? { t: 'settle', id, response } : undefined;
}
