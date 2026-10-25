import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { markValidated, type HostCall, type MethodDescriptor, type RegisteredMethod } from './api.ts';
import { bindDocsView, docsNamespace, type DocsView } from './docs/docs-api.ts';
import { ScriptApiError, type CallErrorCode } from './errors.ts';
import { asJsonValue, freezeJson, isRecord, JsonBoundaryError, parseBoundedJson, utf8Length, type JsonValue } from './json.ts';
import type { ExecutionLimits } from './limits.ts';
import type {
  CallDisposition,
  CallRecord,
  ExecutionEvent,
  ExecutionEvidence,
  ExecutionOutcome,
  ExecutionStatus,
  FailureCode,
  GuestLog,
  ScriptDiagnostic,
  ScriptLanguage,
} from './outcome.ts';
import {
  bootstrapVersion,
  guestAbiVersion,
  readWorkerMessage,
  workerProtocolVersion,
  type GuestErrorKind,
  type GuestWorkerData,
  type ResourceLimit,
  type WorkerMessage,
} from './protocol.ts';
import { invalid, OutputTooLargeError, projectOutput, validateInput, type Issue } from './schema.ts';
import type { CompilerPool } from './typescript/compiler.ts';
import type { WasmModule } from './wasm.ts';
import { decodeMappings, originalPosition, type DecodedMappings } from './typescript/source-map.ts';

/** One call as a filter sees it: identity and raw arguments, before binding. */
export interface FilterCall<Context> {
  readonly method: MethodDescriptor;
  /** The arguments exactly as the script sent them, frozen. An omitted argument is null here and listed in `omitted`. */
  readonly args: readonly JsonValue[];
  readonly omitted: readonly number[];
  readonly context: Context;
  readonly sessionId: string;
  readonly executionId: string;
  readonly callId: number;
  readonly signal: AbortSignal;
  readonly deadline: number;
}

/**
 * Runs the rest of the filters and then the method. Returns the result as the
 * script will receive it; throws a ScriptApiError when the call fails. It may
 * be called at most once.
 */
export type HostCallNext = () => Promise<JsonValue | undefined>;

/**
 * Runs around every call a script makes, before its arguments are bound.
 * Continue with `next()`, refuse by throwing `denyCall(...)`, or answer in the
 * method's place by returning a value without calling `next()`; a replacement
 * must still match the method's result schema. Runtime filters run outside
 * session filters, each in the order it was added.
 */
export type HostCallFilter<Context> = (call: FilterCall<Context>, next: HostCallNext) => JsonValue | undefined | Promise<JsonValue | undefined>;

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
}

export interface EventSinks {
  /** Best effort: called synchronously, never awaited; a throw is counted and ignored. */
  readonly onEvent: readonly ((event: ExecutionEvent) => void)[];
  /** Required: awaited; a throw or rejection stops the execution with `audit-failure`. */
  readonly audit: readonly ((event: ExecutionEvent) => void | Promise<void>)[];
}

/** @internal What an execution needs from its runtime. */
export interface RuntimeCore<Context> {
  readonly module: WasmModule;
  readonly initialMemoryBytes: number;
  readonly bootstrapCode: string;
  readonly apisCode: string;
  readonly methods: ReadonlyMap<string, RegisteredMethod<Context>>;
  readonly filters: readonly HostCallFilter<Context>[];
  readonly declarations: string;
  readonly declarationsKey: string;
  readonly compiler: CompilerPool;
  readonly clock: Clock;
  readonly clockSource: 'system' | 'injected';
  readonly frozenGuestClock: boolean;
  readonly sealResults: boolean;
  readonly contractSha256: string;
  readonly contractVersion: string | null;
  readonly policyVersion: string | null;
  readonly packageVersion: string;
  readonly artifact: string;
  readonly artifactSha256: string;
  readonly quickjsCommit: string;
  readonly events: EventSinks;
}

/** @internal What an execution needs from its session. */
export interface SessionCore<Context> {
  readonly id: string;
  readonly context: Context;
  readonly allows: (method: MethodDescriptor) => boolean;
  readonly filters: readonly HostCallFilter<Context>[];
  readonly docsView: DocsView | undefined;
  readonly events: EventSinks;
}

export interface ExecutionRequest {
  readonly executionId: string;
  readonly language: ScriptLanguage;
  readonly source: string;
  readonly limits: ExecutionLimits;
  readonly signal: AbortSignal | undefined;
}

/** The JavaScript wrapper. It shares the first line with the script, so line numbers stay put. */
const javaScriptPrefix = '(async () => {"use strict";';
const javaScriptSuffix = '\n})()';
const scriptName = 'script.js';
const methodNamePattern = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}\.[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const maxDiagnosticText = 2048;
const maxStackFrames = 20;

class AuditFailure extends Error {}

interface QueuedCall {
  readonly seq: number;
  readonly id: number;
  readonly payload: string;
  readonly bytes: number;
  readonly receivedAt: number;
  /** Whether it may run alongside other concurrent calls; set when it reaches the head of the queue. */
  concurrent?: boolean;
}

type Terminal =
  | { readonly status: 'completed'; readonly value: JsonValue; readonly hasValue: boolean }
  | { readonly status: 'failed'; readonly error: ScriptDiagnostic }
  | { readonly status: 'cancelled' }
  | { readonly status: 'timed-out' }
  | { readonly status: 'resource-limit'; readonly limit: ResourceLimit; readonly detail: string };

/** Runs one execution from source to terminal outcome. */
export function runExecution<Context>(runtime: RuntimeCore<Context>, session: SessionCore<Context>, request: ExecutionRequest): Promise<ExecutionOutcome> {
  return new ExecutionRun(runtime, session, request).run();
}

class ExecutionRun<Context> {
  private readonly runtime: RuntimeCore<Context>;
  private readonly session: SessionCore<Context>;
  private readonly request: ExecutionRequest;
  private readonly limits: ExecutionLimits;
  private readonly revocation = new AbortController();
  private readonly startMono = performance.now();
  private readonly startEpoch: number;
  private readonly deadlineMono: number;

  private worker: Worker | undefined;
  private workerStartMs: number | null = null;
  private compileMs: number | null = null;
  private mappings: DecodedMappings | undefined;
  private terminal: Terminal | undefined;
  private resolveTerminal: ((terminal: Terminal) => void) | undefined;
  private stopRequestedAt: number | undefined;
  private terminationLatencyMs: number | null = null;
  private deadlineTimer: NodeJS.Timeout | undefined;

  private readonly queue: QueuedCall[] = [];
  private running = 0;
  private runningAlone = false;
  private seq = 0;
  private readonly calls: CallRecord[] = [];
  private evidenceBytes = 0;
  private callsAdmitted = 0;
  private callsDenied = 0;
  private callsFailed = 0;
  private rpcBytes = 0;
  private hostCallMs = 0;
  private readonly logs: GuestLog[] = [];
  private logBytes = 0;
  private logsTruncated = false;
  private resultBytes = 0;
  private guestMemoryBytes: number | null = null;
  private eventCallbackErrors = 0;

  constructor(runtime: RuntimeCore<Context>, session: SessionCore<Context>, request: ExecutionRequest) {
    this.runtime = runtime;
    this.session = session;
    this.request = request;
    this.limits = request.limits;
    this.startEpoch = runtime.clock.now();
    this.deadlineMono = this.startMono + this.limits.timeoutMs;
  }

  async run(): Promise<ExecutionOutcome> {
    const terminal = await new Promise<Terminal>((resolve) => {
      this.resolveTerminal = resolve;
      void this.start();
    });
    return this.conclude(terminal);
  }

  // ---------- Lifecycle ----------

  /** Whether the execution has ended. A method, so a check after an await is not narrowed away. */
  private ended(): boolean {
    return this.terminal !== undefined;
  }

  private remainingMs(): number {
    return Math.max(0, this.deadlineMono - performance.now());
  }

  private elapsedMs(): number {
    return Math.round((performance.now() - this.startMono) * 1000) / 1000;
  }

  private async start(): Promise<void> {
    const signal = this.request.signal;
    if (signal?.aborted === true) {
      this.end({ status: 'cancelled' });
      return;
    }
    signal?.addEventListener('abort', this.onAbort, { once: true });
    this.deadlineTimer = setTimeout(() => {
      this.end({ status: 'timed-out' });
    }, this.limits.timeoutMs);

    try {
      await this.emit({
        type: 'execution-started',
        executionId: this.request.executionId,
        sessionId: this.session.id,
        language: this.request.language,
        at: new Date(this.startEpoch).toISOString(),
      });
    } catch (error) {
      this.endWithAuditFailure(error);
      return;
    }

    if (utf8Length(this.request.source) > this.limits.sourceBytes) {
      this.limitReached('source-bytes', `The source is larger than ${this.limits.sourceBytes} bytes.`);
      return;
    }

    let script: string;
    if (this.request.language === 'typescript') {
      const compiled = await this.compile();
      if (compiled === undefined) {
        return;
      }
      script = compiled;
    } else {
      script = javaScriptPrefix + this.request.source + javaScriptSuffix;
    }
    if (this.terminal !== undefined) {
      return;
    }
    this.startWorker(script);
  }

  private readonly onAbort = (): void => {
    this.end({ status: 'cancelled' });
  };

  private async compile(): Promise<string | undefined> {
    const started = performance.now();
    const budget = Math.min(this.limits.compileTimeoutMs, this.remainingMs());
    const outcome = await this.runtime.compiler.compile(
      this.request.source,
      this.runtime.declarations,
      this.runtime.declarationsKey,
      budget,
      this.limits.compilerHeapMb,
      this.revocation.signal,
    );
    this.compileMs = Math.round((performance.now() - started) * 1000) / 1000;
    if (this.terminal !== undefined) {
      return undefined;
    }
    switch (outcome.kind) {
      case 'compiled':
        this.mappings = decodeMappings(readMappings(outcome.map));
        return outcome.js;
      case 'rejected': {
        const first = outcome.diagnostics[0];
        this.end({
          status: 'failed',
          error: {
            code: outcome.category,
            name: outcome.category === 'type-check' ? 'TypeScriptError' : 'SyntaxError',
            message: first === undefined ? 'The script did not compile.' : first.message,
            line: first?.line ?? null,
            column: first?.column ?? null,
            stack: null,
            diagnostics: outcome.diagnostics,
          },
        });
        return undefined;
      }
      case 'timeout':
        if (this.remainingMs() <= 0) {
          this.end({ status: 'timed-out' });
        } else {
          this.limitReached('compile-time', `Checking the TypeScript took longer than ${this.limits.compileTimeoutMs} ms.`);
        }
        return undefined;
      case 'memory':
        this.limitReached('compiler-memory', `Checking the TypeScript needed more than ${this.limits.compilerHeapMb} MB.`);
        return undefined;
      case 'cancelled':
        this.end({ status: 'cancelled' });
        return undefined;
      case 'failed':
        this.fail('internal', 'InternalError', `TypeScript checking failed: ${outcome.message}`);
        return undefined;
    }
  }

  private startWorker(script: string): void {
    const started = performance.now();
    const data: GuestWorkerData = {
      protocol: workerProtocolVersion,
      module: this.runtime.module,
      abiVersion: guestAbiVersion,
      initialMemoryBytes: this.runtime.initialMemoryBytes,
      bootstrap: [
        {
          name: 'scriptbox.js',
          code: `globalThis.__scriptbox_options = ${JSON.stringify({ sealResults: this.runtime.sealResults, bootstrap: bootstrapVersion, maxDepth: this.limits.jsonDepth })};\n${this.runtime.bootstrapCode}`,
        },
        { name: 'apis.js', code: this.runtime.apisCode },
      ],
      script: { name: scriptName, code: script },
      limits: {
        memoryBytes: this.limits.memoryBytes,
        messageBytes: this.limits.messageBytes,
        rpcBytes: this.limits.rpcBytes,
        hostCalls: this.limits.hostCalls,
        outstandingCalls: this.limits.outstandingCalls,
        resultBytes: this.limits.resultBytes,
        logEntries: this.limits.logEntries,
        logEntryBytes: this.limits.logEntryBytes,
      },
      clockStartMs: Math.max(0, Math.floor(this.startEpoch)),
      frozenClock: this.runtime.frozenGuestClock,
    };
    const worker = new Worker(new URL('./guest/worker.js', import.meta.url), {
      workerData: data,
      resourceLimits: {
        maxOldGenerationSizeMb: this.limits.workerHeapMb,
        maxYoungGenerationSizeMb: Math.min(16, this.limits.workerHeapMb),
        stackSizeMb: this.limits.workerStackMb,
      },
      // Nothing from the application's process reaches the worker: no environment, no flags.
      env: {},
      execArgv: [],
      stdout: true,
      stderr: true,
    });
    worker.stdout.resume();
    worker.stderr.resume();
    this.worker = worker;
    worker.once('online', () => {
      this.workerStartMs = Math.round((performance.now() - started) * 1000) / 1000;
    });
    worker.on('message', (raw: unknown) => {
      const message = readWorkerMessage(raw);
      if (message === undefined) {
        this.fail('protocol-mismatch', 'ProtocolError', 'The guest worker sent a message this host does not understand.');
        return;
      }
      this.onWorkerMessage(message);
    });
    worker.on('error', (error: Error) => {
      const code: unknown = Reflect.get(error, 'code');
      if (code === 'ERR_WORKER_OUT_OF_MEMORY') {
        this.limitReached('worker-memory', `The guest worker needed more than ${this.limits.workerHeapMb} MB of heap.`);
      } else {
        this.fail('internal', 'InternalError', `The guest worker failed: ${error.message}`);
      }
    });
    worker.on('exit', () => {
      if (this.stopRequestedAt !== undefined && this.terminationLatencyMs === null) {
        this.terminationLatencyMs = Math.round((performance.now() - this.stopRequestedAt) * 1000) / 1000;
      }
      if (this.terminal === undefined) {
        this.fail('internal', 'InternalError', 'The guest worker exited before the execution ended.');
      }
    });
  }

  /** Ends the execution with its first terminal outcome; later ones are ignored. */
  private end(terminal: Terminal): void {
    if (this.terminal !== undefined) {
      return;
    }
    this.terminal = terminal;
    this.stopRequestedAt = performance.now();
    // Revoke first: from here no call is dispatched, and in-flight calls see their signal abort.
    this.revocation.abort();
    this.queue.length = 0;
    clearTimeout(this.deadlineTimer);
    this.request.signal?.removeEventListener('abort', this.onAbort);
    this.resolveTerminal?.(terminal);
  }

  private fail(code: FailureCode, name: string, message: string, extra?: Partial<ScriptDiagnostic>): void {
    this.end({
      status: 'failed',
      error: { code, name, message: message.slice(0, maxDiagnosticText), line: null, column: null, stack: null, diagnostics: null, ...extra },
    });
  }

  private endWithAuditFailure(error: unknown): void {
    const detail = error instanceof Error ? error.message : 'the audit sink failed';
    this.fail('audit-failure', 'AuditError', `A required audit record could not be written: ${detail}`.slice(0, maxDiagnosticText));
  }

  private limitReached(limit: ResourceLimit, detail: string): void {
    if (this.terminal !== undefined) {
      return;
    }
    this.end({ status: 'resource-limit', limit, detail });
  }

  private async conclude(terminal: Terminal): Promise<ExecutionOutcome> {
    const worker = this.worker;
    if (worker !== undefined) {
      await worker.terminate();
      if (this.terminationLatencyMs === null && this.stopRequestedAt !== undefined) {
        this.terminationLatencyMs = Math.round((performance.now() - this.stopRequestedAt) * 1000) / 1000;
      }
    }

    let final = terminal;
    if (terminal.status === 'resource-limit') {
      try {
        await this.emit({ type: 'limit-reached', executionId: this.request.executionId, sessionId: this.session.id, limit: terminal.limit, detail: terminal.detail });
      } catch (error) {
        final = { status: 'failed', error: auditDiagnostic(error) };
      }
    }
    const elapsedMs = this.elapsedMs();
    try {
      await this.emit({ type: 'execution-finished', executionId: this.request.executionId, sessionId: this.session.id, status: final.status, elapsedMs });
    } catch (error) {
      if (final.status === 'completed') {
        final = { status: 'failed', error: auditDiagnostic(error) };
      }
    }

    const evidence = this.evidence(final.status, final.status === 'resource-limit' ? final.limit : null, elapsedMs);
    const logs = Object.freeze([...this.logs]);
    switch (final.status) {
      case 'completed':
        return { status: 'completed', value: final.value, hasValue: final.hasValue, logs, evidence };
      case 'failed':
        return { status: 'failed', error: final.error, logs, evidence };
      case 'cancelled':
        return { status: 'cancelled', logs, evidence };
      case 'timed-out':
        return { status: 'timed-out', logs, evidence };
      case 'resource-limit':
        return { status: 'resource-limit', limit: final.limit, detail: final.detail, logs, evidence };
    }
  }

  // ---------- Events ----------

  /** Sends an event to every sink. Best-effort sinks never affect the execution; a required one that fails throws. */
  private async emit(event: ExecutionEvent): Promise<void> {
    for (const sinks of [this.runtime.events, this.session.events]) {
      for (const listener of sinks.onEvent) {
        try {
          listener(event);
        } catch {
          this.eventCallbackErrors++;
        }
      }
    }
    for (const sinks of [this.runtime.events, this.session.events]) {
      for (const audit of sinks.audit) {
        try {
          await audit(event);
        } catch (error) {
          throw new AuditFailure(error instanceof Error ? error.message : 'the audit sink failed');
        }
      }
    }
  }

  // ---------- Guest messages ----------

  private onWorkerMessage(message: WorkerMessage): void {
    if (this.terminal !== undefined) {
      return;
    }
    switch (message.t) {
      case 'call':
        this.queue.push({ seq: ++this.seq, id: message.id, payload: message.payload, bytes: message.bytes, receivedAt: performance.now() });
        this.rpcBytes += message.bytes;
        this.callsAdmitted++;
        if (this.rpcBytes > this.limits.rpcBytes) {
          this.limitReached('rpc-bytes', `Host calls exchanged more than ${this.limits.rpcBytes} bytes.`);
          return;
        }
        this.pump();
        return;
      case 'refused':
        this.rpcBytes += message.bytes;
        this.recordRefusal(message.method, message.reason, message.bytes);
        return;
      case 'log':
        this.addLog(message.level, message.text, message.bytes, message.cut);
        return;
      case 'logs-dropped':
        this.logsTruncated = true;
        return;
      case 'returned':
        // The script returned while calls it did not await are pending; they drain before the result is final.
        return;
      case 'result':
        this.guestMemoryBytes = message.memoryBytes;
        this.onResult(message.json, message.bytes);
        return;
      case 'error':
        this.guestMemoryBytes = message.memoryBytes;
        this.onGuestError(message.kind, message.name, message.message, message.stack);
        return;
      case 'limit':
        this.guestMemoryBytes = message.memoryBytes;
        this.limitReached(message.limit, message.detail);
        return;
    }
  }

  private addLog(level: number, text: string, bytes: number, cut: boolean): void {
    if (this.logs.length >= this.limits.logEntries) {
      this.logsTruncated = true;
      return;
    }
    const levels = ['log', 'info', 'warn', 'error'] as const;
    this.logBytes += Math.min(bytes, this.limits.logEntryBytes);
    this.logs.push(Object.freeze({ level: levels[level] ?? 'log', text: text.slice(0, this.limits.logEntryBytes), truncated: cut }));
  }

  private onResult(json: string | null, bytes: number): void {
    if (json === null) {
      this.end({ status: 'completed', value: null, hasValue: false });
      return;
    }
    if (bytes > this.limits.resultBytes) {
      this.limitReached('result-bytes', `The script returned ${bytes} bytes of JSON, more than the ${this.limits.resultBytes} allowed.`);
      return;
    }
    this.resultBytes = bytes;
    try {
      const value = freezeJson(asJsonValue(parseBoundedJson(json, this.limits.resultBytes, this.limits.jsonDepth)));
      this.end({ status: 'completed', value, hasValue: true });
    } catch (error) {
      this.fail('invalid-result', 'RangeError', error instanceof JsonBoundaryError ? `The script's result is invalid: ${error.message}` : 'The script\'s result is invalid.');
    }
  }

  private onGuestError(kind: GuestErrorKind, name: string, message: string, stack: string): void {
    const location = this.locate(stack);
    const extra: Partial<ScriptDiagnostic> = { line: location.line, column: location.column, stack: location.stack };
    switch (kind) {
      case 'syntax':
        this.fail('invalid-source', name || 'SyntaxError', message, extra);
        return;
      case 'script':
        this.fail(classifyScriptError(name, message), name || 'Error', message, extra);
        return;
      case 'unhandled':
        this.fail('unhandled-rejection', name || 'Error', `A promise was rejected and nothing handled it: ${message}`, extra);
        return;
      case 'never-settled':
        this.fail('never-settled', 'Error', message);
        return;
      case 'encode':
        this.fail('invalid-result', name || 'TypeError', message, extra);
        return;
      case 'bootstrap':
        this.fail(/bootstrap version|protocol/i.test(message) ? 'protocol-mismatch' : 'internal', name || 'InternalError', message);
        return;
      case 'protocol':
        this.fail(/ABI|protocol|another version/i.test(message) ? 'protocol-mismatch' : 'internal', name || 'InternalError', message);
        return;
    }
  }

  /** Maps the guest's stack to the submitted source, keeping only the script's own frames. */
  private locate(stack: string): { line: number | null; column: number | null; stack: string | null } {
    const sourceName = this.request.language === 'typescript' ? 'script.ts' : 'script.js';
    const userLines = this.request.source.split('\n').length;
    const frames: string[] = [];
    let first: { line: number; column: number } | undefined;
    for (const raw of stack.split('\n')) {
      const match = /^\s*at (?:(.*?) \()?script\.js:(\d+)(?::(\d+))?\)?\s*$/.exec(raw);
      // <eval> is the wrapper's own invocation, not the script's code.
      if (match === null || match[1] === '<eval>') {
        continue;
      }
      const position = this.mapPosition(Number(match[2]), match[3] === undefined ? 1 : Number(match[3]), userLines);
      first ??= position;
      const name = match[1];
      frames.push(name === undefined || name === '' ? `    at ${sourceName}:${position.line}:${position.column}` : `    at ${name.slice(0, 64)} (${sourceName}:${position.line}:${position.column})`);
      if (frames.length >= maxStackFrames) {
        break;
      }
    }
    return { line: first?.line ?? null, column: first?.column ?? null, stack: frames.length === 0 ? null : frames.join('\n') };
  }

  private mapPosition(line: number, column: number, userLines: number): { line: number; column: number } {
    if (this.request.language === 'javascript') {
      const userColumn = line === 1 ? Math.max(1, column - javaScriptPrefix.length) : column;
      return { line: Math.min(line, userLines), column: userColumn };
    }
    const mappings = this.mappings;
    const original = mappings === undefined ? undefined : originalPosition(mappings, line - 1, column - 1);
    if (original === undefined) {
      return { line: Math.min(Math.max(line - 1, 1), userLines), column };
    }
    // Line 0 of the checked file is the wrapper, so its line n is the script's line n.
    return { line: Math.min(Math.max(original.line, 1), userLines), column: original.column + 1 };
  }

  // ---------- Dispatch ----------

  private record(record: Omit<CallRecord, 'seq'> & { seq?: number }): number {
    const seq = record.seq ?? ++this.seq;
    const full: CallRecord = Object.freeze({ ...record, seq });
    this.evidenceBytes += utf8Length(JSON.stringify(full));
    if (this.calls.length >= this.limits.evidenceRecords || this.evidenceBytes > this.limits.evidenceBytes) {
      // Every call must be on record; one that cannot be is a hard stop, not a gap.
      this.limitReached('evidence', `The execution reached its limit of ${this.limits.evidenceRecords} call records or ${this.limits.evidenceBytes} bytes of evidence.`);
      return seq;
    }
    this.calls.push(full);
    return seq;
  }

  private recordRefusal(method: string, reason: 'queue-full' | 'request-too-large' | 'revoked', bytes: number): void {
    const at = this.elapsedMs();
    const descriptor = this.runtime.methods.get(method)?.descriptor;
    this.callsFailed++;
    const seq = this.record({
      callId: null,
      method: method.slice(0, 256),
      effect: descriptor?.effect ?? null,
      startedAtMs: at,
      endedAtMs: at,
      disposition: reason,
      handlerRan: false,
      requestBytes: bytes,
      responseBytes: 0,
      errorName: reason === 'queue-full' ? 'QueueFullError' : reason === 'request-too-large' ? 'RequestTooLargeError' : 'RevokedError',
    });
    this.notify({
      type: 'host-call-completed',
      executionId: this.request.executionId,
      sessionId: this.session.id,
      seq,
      callId: null,
      method: method.slice(0, 256),
      effect: descriptor?.effect ?? null,
      disposition: reason,
      handlerRan: false,
      durationMs: 0,
      hostError: undefined,
    });
  }

  /** Sends a best-effort event without waiting; a required sink's failure still stops the execution. */
  private notify(event: ExecutionEvent): void {
    this.emit(event).catch((error: unknown) => {
      this.endWithAuditFailure(error);
    });
  }

  /**
   * Dispatches queued calls in the order they were admitted. A concurrent call
   * joins running concurrent calls while there is a slot; any other call starts
   * only when nothing runs, and the calls after it wait for it. Each call is
   * settled as soon as it finishes.
   */
  private pump(): void {
    while (this.terminal === undefined) {
      const next = this.queue[0];
      if (next === undefined) {
        return;
      }
      next.concurrent ??= this.isConcurrent(next);
      if (this.running > 0 && (this.runningAlone || !next.concurrent || this.running >= this.limits.concurrentCalls)) {
        return;
      }
      this.queue.shift();
      this.running++;
      this.runningAlone = !next.concurrent;
      void this.dispatch(next).then((response) => {
        this.running--;
        this.runningAlone = false;
        if (this.terminal !== undefined || response === undefined) {
          return;
        }
        this.rpcBytes += utf8Length(response);
        if (this.rpcBytes > this.limits.rpcBytes) {
          this.limitReached('rpc-bytes', `Host calls exchanged more than ${this.limits.rpcBytes} bytes.`);
          return;
        }
        this.worker?.postMessage({ t: 'settle', id: next.id, response });
        this.pump();
      });
    }
  }

  /** A call that names no host method is answered without a handler, so it can share its turn with anything. */
  private isConcurrent(queued: QueuedCall): boolean {
    let method: string;
    try {
      method = readRequest(queued.payload, this.limits).method;
    } catch {
      return true;
    }
    return this.runtime.methods.get(method)?.descriptor.concurrent ?? true;
  }

  /** Handles one admitted call and returns the response for the guest, or undefined when the execution has ended. */
  private async dispatch(queued: QueuedCall): Promise<string | undefined> {
    const started = performance.now();
    const startedAtMs = this.elapsedMs();
    let request: { method: string; args: JsonValue[]; omitted: number[] };
    try {
      request = readRequest(queued.payload, this.limits);
    } catch {
      return this.respondError(queued, startedAtMs, started, null, 'unknown-method', 'UnknownMethodError', 'The host call was malformed.', false, undefined, '');
    }

    const registered = methodNamePattern.test(request.method) ? this.runtime.methods.get(request.method) : undefined;
    if (registered === undefined) {
      this.denied(queued, request.method, null, 'unknown-method');
      return this.respondError(queued, startedAtMs, started, null, 'unknown-method', 'UnknownMethodError',
        `'${request.method.slice(0, 128)}' is not a host API method.`, false, undefined, request.method);
    }
    const descriptor = registered.descriptor;
    if (!this.session.allows(descriptor)) {
      this.denied(queued, descriptor.qualifiedName, queued.id, 'capability');
      return this.respondError(queued, startedAtMs, started, descriptor, 'denied', 'PermissionDeniedError',
        `${descriptor.qualifiedName} is not available in this session.`, false, undefined, descriptor.qualifiedName);
    }

    try {
      await this.emit({
        type: 'host-call-started',
        executionId: this.request.executionId,
        sessionId: this.session.id,
        seq: queued.seq,
        callId: queued.id,
        method: descriptor.qualifiedName,
        effect: descriptor.effect,
        at: new Date(this.runtime.clock.now()).toISOString(),
      });
    } catch (error) {
      this.endWithAuditFailure(error);
      return undefined;
    }
    if (this.terminal !== undefined) {
      return undefined;
    }

    const outcome = await this.invoke(registered, request, queued);
    if (this.ended()) {
      // Revoked while the call ran: its result is discarded, and recorded as such.
      this.record({
        seq: queued.seq,
        callId: queued.id,
        method: descriptor.qualifiedName,
        effect: descriptor.effect,
        startedAtMs,
        endedAtMs: this.elapsedMs(),
        disposition: 'revoked',
        handlerRan: outcome.handlerRan,
        requestBytes: queued.bytes,
        responseBytes: 0,
        errorName: null,
      });
      return undefined;
    }
    if (outcome.kind === 'error') {
      if (outcome.code === 'denied') {
        this.denied(queued, descriptor.qualifiedName, queued.id, 'filter');
      }
      return this.respondError(queued, startedAtMs, started, descriptor, outcome.disposition, outcome.name, outcome.message, outcome.handlerRan, outcome.hostError, descriptor.qualifiedName);
    }

    let response = outcome.value === undefined ? `{"id":${queued.id}}` : `{"id":${queued.id},"result":${JSON.stringify(outcome.value)}}`;
    let disposition: CallDisposition = outcome.replaced ? 'replaced' : 'completed';
    let errorName: string | null = null;
    if (utf8Length(response) > this.limits.messageBytes) {
      disposition = 'response-too-large';
      errorName = 'ResponseTooLargeError';
      response = errorResponse(queued.id, errorName, `${descriptor.qualifiedName} returned more than one response may carry (${this.limits.messageBytes} bytes). Ask for less, for example a smaller page.`);
    }
    this.finishCall(queued, startedAtMs, started, descriptor.qualifiedName, descriptor.effect, disposition, outcome.handlerRan, utf8Length(response), errorName, undefined);
    return response;
  }

  private denied(queued: QueuedCall, method: string, callId: number | null, reason: 'capability' | 'unknown-method' | 'filter'): void {
    this.notify({ type: 'host-call-denied', executionId: this.request.executionId, sessionId: this.session.id, seq: queued.seq, callId, method: method.slice(0, 256), reason });
  }

  private respondError(
    queued: QueuedCall,
    startedAtMs: number,
    started: number,
    descriptor: MethodDescriptor | null,
    disposition: CallDisposition,
    name: string,
    message: string,
    handlerRan: boolean,
    hostError: unknown,
    method: string,
  ): string {
    const response = errorResponse(queued.id, name, message);
    this.finishCall(queued, startedAtMs, started, descriptor?.qualifiedName ?? method, descriptor?.effect ?? null, disposition, handlerRan, utf8Length(response), name, hostError);
    return response;
  }

  private finishCall(
    queued: QueuedCall,
    startedAtMs: number,
    started: number,
    method: string,
    effect: string | null,
    disposition: CallDisposition,
    handlerRan: boolean,
    responseBytes: number,
    errorName: string | null,
    hostError: unknown,
  ): void {
    const durationMs = Math.round((performance.now() - started) * 1000) / 1000;
    this.hostCallMs += durationMs;
    if (disposition === 'denied' || disposition === 'unknown-method') {
      this.callsDenied++;
    } else if (disposition !== 'completed' && disposition !== 'replaced') {
      this.callsFailed++;
    }
    this.record({
      seq: queued.seq,
      callId: queued.id,
      method: method.slice(0, 256),
      effect,
      startedAtMs,
      endedAtMs: this.elapsedMs(),
      disposition,
      handlerRan,
      requestBytes: queued.bytes,
      responseBytes,
      errorName,
    });
    this.notify({
      type: 'host-call-completed',
      executionId: this.request.executionId,
      sessionId: this.session.id,
      seq: queued.seq,
      callId: queued.id,
      method: method.slice(0, 256),
      effect,
      disposition,
      handlerRan,
      durationMs,
      hostError,
    });
  }

  /** Runs the filters and the method for one call, under the call's own deadline. */
  private async invoke(
    registered: RegisteredMethod<Context>,
    request: { method: string; args: JsonValue[]; omitted: number[] },
    queued: QueuedCall,
  ): Promise<InvokeOutcome> {
    const descriptor = registered.descriptor;
    const callController = new AbortController();
    const onRevoke = (): void => {
      callController.abort(new ScriptApiError({ code: 'revoked', message: 'The execution ended.' }));
    };
    this.revocation.signal.addEventListener('abort', onRevoke, { once: true });
    const timeoutMs = Math.max(1, Math.min(descriptor.timeoutMs ?? this.limits.hostCallTimeoutMs, this.remainingMs()));
    const deadline = this.runtime.clock.now() + timeoutMs;
    const signal = callController.signal;

    const call: HostCall<Context> = Object.freeze({
      context: this.session.context,
      method: descriptor,
      sessionId: this.session.id,
      executionId: this.request.executionId,
      callId: queued.id,
      signal,
      deadline,
      throwIfRevoked: () => {
        if (signal.aborted) {
          throw new ScriptApiError({ code: 'revoked', message: 'The call no longer has authority to act.' });
        }
      },
    });
    if (descriptor.namespace === docsNamespace && this.session.docsView !== undefined) {
      bindDocsView(call, this.session.docsView);
    }

    // Set by the handler step, which runs inside the filters; read after the chain settles.
    const state: { handlerRan: boolean; nextCalled: boolean; result: JsonValue | undefined } = { handlerRan: false, nextCalled: false, result: undefined };

    const handler: HostCallNext = async () => {
      if (state.nextCalled) {
        throw new Error('A filter called next() twice.');
      }
      state.nextCalled = true;
      const args = bindArguments(registered, request.args, request.omitted);
      if (signal.aborted) {
        throw new ScriptApiError({ code: 'revoked', message: 'The call no longer has authority to act.' });
      }
      state.handlerRan = true;
      const returned: unknown = await registered.invoke(args, call);
      if (isAborted(signal)) {
        throw new ScriptApiError({ code: 'revoked', message: 'The call ended before its handler finished.' });
      }
      state.result = this.projectResult(registered, returned);
      return state.result;
    };

    const filters = [...this.runtime.filters, ...this.session.filters];
    const filterCall: FilterCall<Context> = Object.freeze({
      method: descriptor,
      args: freezeJson(request.args),
      omitted: Object.freeze([...request.omitted]),
      context: this.session.context,
      sessionId: this.session.id,
      executionId: this.request.executionId,
      callId: queued.id,
      signal,
      deadline,
    });
    const chain = (index: number): Promise<JsonValue | undefined> => {
      const filter = filters[index];
      if (filter === undefined) {
        return handler();
      }
      return Promise.resolve(filter(filterCall, () => chain(index + 1)));
    };

    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        resolve('timeout');
      }, timeoutMs);
    });
    const revoked = new Promise<'revoked'>((resolve) => {
      if (this.revocation.signal.aborted) {
        resolve('revoked');
      }
      this.revocation.signal.addEventListener('abort', () => {
        resolve('revoked');
      }, { once: true });
    });

    try {
      const raced = await Promise.race([chain(0).then((value) => ({ value })), timedOut, revoked]);
      if (raced === 'timeout') {
        callController.abort(new ScriptApiError({ code: 'host-timeout', message: `${descriptor.qualifiedName} took longer than ${timeoutMs} ms.` }));
        return {
          kind: 'error', code: 'host-timeout', disposition: 'host-timeout', name: 'HostTimeoutError',
          message: `${descriptor.qualifiedName} did not finish within ${timeoutMs} ms.`, handlerRan: state.handlerRan, hostError: undefined,
        };
      }
      if (raced === 'revoked') {
        return { kind: 'error', code: 'revoked', disposition: 'revoked', name: 'RevokedError', message: 'The execution ended.', handlerRan: state.handlerRan, hostError: undefined };
      }
      let value = raced.value;
      const replaced = !state.handlerRan || value !== state.result;
      if (replaced) {
        value = this.projectResult(registered, value);
      }
      return { kind: 'ok', value, replaced, handlerRan: state.handlerRan };
    } catch (error) {
      return errorOutcome(descriptor, error, state.handlerRan);
    } finally {
      clearTimeout(timer);
      this.revocation.signal.removeEventListener('abort', onRevoke);
      // A call's authority ends with the call, however it ended, so a kept HostCall cannot act later.
      if (!callController.signal.aborted) {
        callController.abort(new ScriptApiError({ code: 'revoked', message: 'The call has ended.' }));
      }
    }
  }

  /** Projects a handler's or filter's value onto the method's result schema. */
  private projectResult(registered: RegisteredMethod<Context>, value: unknown): JsonValue | undefined {
    const node = registered.resultNode;
    if (node === undefined) {
      if (value !== undefined) {
        throw new ScriptApiError({ code: 'invalid-result', message: `${registered.descriptor.qualifiedName} returned a value but declares no result.` });
      }
      return undefined;
    }
    const issues: Issue[] = [];
    let projected: JsonValue | typeof invalid;
    try {
      projected = projectOutput(node, value, 'result', issues, this.limits.messageBytes);
    } catch (error) {
      if (error instanceof OutputTooLargeError) {
        throw new ScriptApiError({
          code: 'response-too-large',
          message: `${registered.descriptor.qualifiedName} returned more than one response may carry (${this.limits.messageBytes} bytes). Ask for less, for example a smaller page.`,
        });
      }
      throw error;
    }
    if (projected === invalid) {
      throw new ScriptApiError({
        code: 'invalid-result',
        message: `${registered.descriptor.qualifiedName} returned a value that does not match its declared result.`,
        cause: new Error(issues.map((i) => i.message).join('; ')),
      });
    }
    return projected;
  }

  // ---------- Evidence ----------

  private evidence(status: ExecutionStatus, limit: ResourceLimit | null, elapsedMs: number): ExecutionEvidence {
    const finishedEpoch = this.runtime.clock.now();
    return Object.freeze({
      executionId: this.request.executionId,
      sessionId: this.session.id,
      language: this.request.language,
      source: { sha256: createHash('sha256').update(this.request.source).digest('hex'), bytes: utf8Length(this.request.source) },
      runtime: {
        packageVersion: this.runtime.packageVersion,
        guestAbi: guestAbiVersion,
        bootstrapVersion,
        workerProtocol: workerProtocolVersion,
        artifact: this.runtime.artifact,
        artifactSha256: this.runtime.artifactSha256,
        quickjsCommit: this.runtime.quickjsCommit,
      },
      contract: { sha256: this.runtime.contractSha256, version: this.runtime.contractVersion },
      policyVersion: this.runtime.policyVersion,
      clock: this.runtime.clockSource,
      startedAt: new Date(this.startEpoch).toISOString(),
      finishedAt: new Date(finishedEpoch).toISOString(),
      elapsedMs,
      status,
      limitReached: limit,
      calls: Object.freeze([...this.calls]),
      counters: {
        callAttempts: this.seq,
        callsAdmitted: this.callsAdmitted,
        callsDenied: this.callsDenied,
        callsFailed: this.callsFailed,
        rpcBytes: this.rpcBytes,
        logEntries: this.logs.length,
        logBytes: this.logBytes,
        resultBytes: this.resultBytes,
        eventCallbackErrors: this.eventCallbackErrors,
      },
      truncated: { logs: this.logsTruncated },
      measurements: {
        compileMs: this.compileMs,
        hostCallMs: Math.round(this.hostCallMs * 1000) / 1000,
        workerStartMs: this.workerStartMs,
        guestMemoryBytes: this.guestMemoryBytes,
        terminationLatencyMs: this.terminal?.status === 'completed' ? null : this.terminationLatencyMs,
      },
      unavailable: ['guest-cpu-time', 'worker-heap-peak', 'compiler-heap-peak'],
      limits: this.limits,
    });
  }
}

type InvokeOutcome =
  | { readonly kind: 'ok'; readonly value: JsonValue | undefined; readonly replaced: boolean; readonly handlerRan: boolean }
  | {
    readonly kind: 'error';
    readonly code: CallErrorCode;
    readonly disposition: CallDisposition;
    readonly name: string;
    readonly message: string;
    readonly handlerRan: boolean;
    readonly hostError: unknown;
  };

function errorOutcome(descriptor: MethodDescriptor, error: unknown, handlerRan: boolean): InvokeOutcome {
  if (error instanceof ScriptApiError) {
    const disposition: CallDisposition = error.code === 'denied' ? 'denied'
      : error.code === 'unknown-method' ? 'unknown-method'
        : error.code === 'invalid-arguments' ? 'invalid-arguments'
          : error.code === 'invalid-result' ? 'invalid-result'
            : error.code === 'host-timeout' ? 'host-timeout'
              : error.code === 'response-too-large' ? 'response-too-large'
                : error.code === 'revoked' ? 'revoked'
                  : error.code === 'host-failure' ? 'host-failure'
                    : 'app-error';
    return {
      kind: 'error',
      code: error.code,
      disposition,
      name: error.guestName,
      message: error.message.slice(0, maxDiagnosticText),
      handlerRan,
      hostError: error.code === 'invalid-result' ? error : undefined,
    };
  }
  // Anything else stays on the host: the script learns only that the call failed.
  return {
    kind: 'error',
    code: 'host-failure',
    disposition: 'host-failure',
    name: 'HostError',
    message: `${descriptor.qualifiedName} failed on the host.`,
    handlerRan,
    hostError: error,
  };
}

/** Reads a signal's state afresh; after an await, a direct check would be narrowed by an earlier one. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function errorResponse(id: number, name: string, message: string): string {
  return JSON.stringify({ id, error: { name, message } });
}

/** Reads a request the guest posted: `{"method", "args", "omitted"?}`. */
function readRequest(payload: string, limits: ExecutionLimits): { method: string; args: JsonValue[]; omitted: number[] } {
  const parsed = parseBoundedJson(payload, limits.messageBytes, limits.jsonDepth + 2);
  if (!isRecord(parsed) || typeof parsed['method'] !== 'string' || !Array.isArray(parsed['args'])) {
    throw new JsonBoundaryError('The request is malformed.');
  }
  const argsValue: unknown[] = parsed['args'];
  const args = argsValue.map((value) => asJsonValue(value));
  const omittedValue: unknown = parsed['omitted'] ?? [];
  if (!Array.isArray(omittedValue)) {
    throw new JsonBoundaryError('The request is malformed.');
  }
  const omittedItems: unknown[] = omittedValue;
  const omitted = omittedItems.map((value) => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value >= args.length) {
      throw new JsonBoundaryError('The request is malformed.');
    }
    return value;
  });
  return { method: parsed['method'], args, omitted };
}

/** Binds positional arguments to the method's parameters, validating each and applying defaults. */
function bindArguments<Context>(registered: RegisteredMethod<Context>, args: readonly JsonValue[], omitted: readonly number[]): ReturnType<typeof markValidated> {
  const descriptor = registered.descriptor;
  const params = registered.params;
  if (args.length > params.length) {
    throw new ScriptApiError({
      code: 'invalid-arguments',
      message: `${descriptor.qualifiedName} takes ${params.length === 0 ? 'no arguments' : `at most ${params.length} argument${params.length === 1 ? '' : 's'}`}, not ${args.length}.`,
    });
  }
  const values: Record<string, JsonValue> = {};
  const issues: Issue[] = [];
  params.forEach((param, index) => {
    const label = `${descriptor.qualifiedName} argument ${index + 1} (${param.name})`;
    const provided = index < args.length && !omitted.includes(index);
    if (!provided) {
      if (param.node.defaultValue !== undefined) {
        values[param.name] = structuredClone(param.node.defaultValue);
      } else if (param.required) {
        issues.push({ path: label, message: `${label} is required.` });
      }
      return;
    }
    const checked = validateInput(param.node, args[index], label, issues);
    if (checked !== invalid) {
      values[param.name] = checked;
    }
  });
  if (issues.length > 0) {
    throw new ScriptApiError({ code: 'invalid-arguments', message: issues.map((i) => i.message).join(' ').slice(0, maxDiagnosticText) });
  }
  return markValidated(values);
}

function classifyScriptError(name: string, message: string): FailureCode {
  switch (name) {
    case 'PermissionDeniedError':
    case 'UnknownMethodError':
      return 'denied';
    case 'InvalidArgumentsError':
      return 'invalid-arguments';
    case 'HostError':
    case 'HostTimeoutError':
    case 'ResponseTooLargeError':
      return 'host-failure';
    default:
      return message.startsWith('The script\'s result') ? 'invalid-result' : 'script-error';
  }
}

function auditDiagnostic(error: unknown): ScriptDiagnostic {
  const detail = error instanceof Error ? error.message : 'the audit sink failed';
  return {
    code: 'audit-failure',
    name: 'AuditError',
    message: `A required audit record could not be written: ${detail}`.slice(0, maxDiagnosticText),
    line: null,
    column: null,
    stack: null,
    diagnostics: null,
  };
}

function readMappings(map: string): string {
  const parsed: unknown = JSON.parse(map);
  if (!isRecord(parsed) || typeof parsed['mappings'] !== 'string') {
    throw new Error('The TypeScript source map has no mappings.');
  }
  return parsed['mappings'];
}
