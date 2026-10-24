import { ScriptBoxConfigurationError } from './errors.ts';

/**
 * The bounds one execution runs under. They are trusted host configuration:
 * set on the runtime, narrowed or widened per session or execution by host
 * code, never by a script.
 */
export interface ExecutionLimits {
  /** End to end: compilation, guest computation, host calls and result encoding. */
  readonly timeoutMs: number;
  /** One host method, unless the method declares its own. Never more than the time the execution has left. */
  readonly hostCallTimeoutMs: number;
  /** The guest's linear memory, including growth. */
  readonly memoryBytes: number;
  /** The submitted source, UTF-8. */
  readonly sourceBytes: number;
  /** One host-call request or response, UTF-8. */
  readonly messageBytes: number;
  /** Every request and response of the execution together, including refused and failed calls. */
  readonly rpcBytes: number;
  /** Host-call attempts, including refused and denied ones and docs calls. */
  readonly hostCalls: number;
  /** Admitted calls not yet settled, including the one being handled. */
  readonly outstandingCalls: number;
  /** The script's returned value as JSON, UTF-8. */
  readonly resultBytes: number;
  readonly logEntries: number;
  /** One log entry; longer entries are cut and marked. */
  readonly logEntryBytes: number;
  readonly evidenceRecords: number;
  readonly evidenceBytes: number;
  /** Nesting of arrays and objects in any value that crosses the boundary. */
  readonly jsonDepth: number;
  /** TypeScript checking and emit. Never more than the time the execution has left. */
  readonly compileTimeoutMs: number;
  /** The V8 heap of the TypeScript compiler worker. */
  readonly compilerHeapMb: number;
  /** The V8 heap of the guest's worker, excluding the guest's linear memory. */
  readonly workerHeapMb: number;
  /** The native stack of the guest's worker. Deep script recursion fails with a catchable error before reaching it. */
  readonly workerStackMb: number;
}

export const defaultLimits: ExecutionLimits = Object.freeze({
  timeoutMs: 30_000,
  hostCallTimeoutMs: 5_000,
  memoryBytes: 256 * 1024 * 1024,
  sourceBytes: 64 * 1024,
  messageBytes: 256 * 1024,
  rpcBytes: 4 * 1024 * 1024,
  hostCalls: 128,
  outstandingCalls: 16,
  resultBytes: 256 * 1024,
  logEntries: 100,
  logEntryBytes: 2 * 1024,
  evidenceRecords: 128,
  evidenceBytes: 256 * 1024,
  jsonDepth: 64,
  compileTimeoutMs: 10_000,
  compilerHeapMb: 512,
  workerHeapMb: 64,
  workerStackMb: 16,
});

/** The smallest guest memory the async guest can start with: its 8 MB stack and static data, plus room to run. */
export const minimumMemoryBytes = 32 * 1024 * 1024;
/** The most a 32-bit WebAssembly memory can address. */
export const maximumMemoryBytes = 4 * 1024 * 1024 * 1024;

const ranges: Readonly<Record<keyof ExecutionLimits, readonly [number, number]>> = {
  timeoutMs: [1, 24 * 60 * 60 * 1000],
  hostCallTimeoutMs: [1, 24 * 60 * 60 * 1000],
  memoryBytes: [minimumMemoryBytes, maximumMemoryBytes],
  sourceBytes: [1, 16 * 1024 * 1024],
  messageBytes: [1024, 64 * 1024 * 1024],
  rpcBytes: [1024, 1024 * 1024 * 1024],
  hostCalls: [0, 1_000_000],
  outstandingCalls: [1, 1024],
  resultBytes: [16, 64 * 1024 * 1024],
  logEntries: [0, 100_000],
  logEntryBytes: [16, 1024 * 1024],
  evidenceRecords: [1, 1_000_000],
  evidenceBytes: [1024, 64 * 1024 * 1024],
  jsonDepth: [2, 1000],
  compileTimeoutMs: [1, 24 * 60 * 60 * 1000],
  compilerHeapMb: [64, 16 * 1024],
  workerHeapMb: [16, 16 * 1024],
  workerStackMb: [1, 256],
};

/** Applies overrides to a set of limits and checks every value is a finite integer in range. */
export function resolveLimits(base: ExecutionLimits, overrides: Partial<ExecutionLimits> | undefined): ExecutionLimits {
  const merged: Record<keyof ExecutionLimits, number> = { ...base };
  if (overrides !== undefined) {
    for (const key of limitKeys) {
      const value = overrides[key];
      if (value !== undefined) {
        merged[key] = value;
      }
    }
  }
  for (const key of limitKeys) {
    const value = merged[key];
    const [min, max] = ranges[key];
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new ScriptBoxConfigurationError(`The limit ${key} must be an integer from ${min} to ${max}; it is ${String(value)}.`);
    }
  }
  if (merged.evidenceRecords < merged.hostCalls) {
    throw new ScriptBoxConfigurationError(
      `evidenceRecords (${merged.evidenceRecords}) must cover hostCalls (${merged.hostCalls}), so every call attempt can be recorded.`);
  }
  if (merged.memoryBytes % 65536 !== 0) {
    throw new ScriptBoxConfigurationError('memoryBytes must be a whole number of 64 KiB WebAssembly pages.');
  }
  return Object.freeze(merged);
}

const limitKeys: readonly (keyof ExecutionLimits)[] = [
  'timeoutMs', 'hostCallTimeoutMs', 'memoryBytes', 'sourceBytes', 'messageBytes', 'rpcBytes', 'hostCalls',
  'outstandingCalls', 'resultBytes', 'logEntries', 'logEntryBytes', 'evidenceRecords', 'evidenceBytes', 'jsonDepth',
  'compileTimeoutMs', 'compilerHeapMb', 'workerHeapMb', 'workerStackMb',
];

/** Bounds on what a host may register, so a contract cannot grow without limit. */
export const contractLimits = Object.freeze({
  namespaces: 64,
  methods: 512,
  paramsPerMethod: 16,
  schemaDepth: 32,
  schemaNodesPerMethod: 2_000,
  descriptionBytes: 4 * 1024,
  declarationBytes: 1024 * 1024,
});
