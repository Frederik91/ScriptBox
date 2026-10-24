import type { JsonValue } from './json.ts';
import type { ExecutionLimits } from './limits.ts';
import type { ResourceLimit } from './protocol.ts';
import type { CompileDiagnostic } from './typescript/compile-protocol.ts';

export type { ResourceLimit } from './protocol.ts';
export type { CompileDiagnostic } from './typescript/compile-protocol.ts';

export type ScriptLanguage = 'javascript' | 'typescript';

export type ExecutionStatus = 'completed' | 'failed' | 'cancelled' | 'timed-out' | 'resource-limit';

/**
 * Why a failed execution failed. The categories are the same for every
 * ScriptBox host; see the README for how .NET's results map onto them.
 *
 * Categories derived from an error the script let escape (`denied`,
 * `invalid-arguments`, `host-failure`) are read from that error's name, which
 * a script could imitate. The call records in the evidence are what the host
 * actually did.
 */
export type FailureCode =
  /** The source did not parse, or used a construct scripts may not use. */
  | 'invalid-source'
  /** TypeScript found type errors. */
  | 'type-check'
  /** The script threw, or its promise rejected. */
  | 'script-error'
  /** A promise rejected and nothing handled it, though the script itself completed. */
  | 'unhandled-rejection'
  /** The script awaited something nothing could settle. */
  | 'never-settled'
  /** The script's result has no exact JSON form. */
  | 'invalid-result'
  /** The script let a denied or unknown host call's error escape. */
  | 'denied'
  /** The script let a host call's argument error escape. */
  | 'invalid-arguments'
  /** The script let a failed host call's error escape. */
  | 'host-failure'
  /** The guest, bootstrap or worker did not speak this host's protocol. */
  | 'protocol-mismatch'
  /** A required audit record could not be written, so the execution stopped. */
  | 'audit-failure'
  /** ScriptBox failed; the script is not at fault. */
  | 'internal';

/** What went wrong, positioned in the submitted source where that is known. */
export interface ScriptDiagnostic {
  readonly code: FailureCode;
  /** The error's name as the script saw it, such as `TypeError`. */
  readonly name: string;
  readonly message: string;
  /** 1-based, in the submitted source. */
  readonly line: number | null;
  readonly column: number | null;
  /** The script's own frames only, positioned in the submitted source. */
  readonly stack: string | null;
  /** For `invalid-source` and `type-check` from TypeScript: every diagnostic, up to 20. */
  readonly diagnostics: readonly CompileDiagnostic[] | null;
}

/** A line the script wrote with console.*. Untrusted text: never an audit event. */
export interface GuestLog {
  readonly level: 'log' | 'info' | 'warn' | 'error';
  readonly text: string;
  /** Whether the entry was cut to the log entry limit. */
  readonly truncated: boolean;
}

/** What happened to one host-call attempt. */
export type CallDisposition =
  /** The handler ran and its result went back. */
  | 'completed'
  /** A filter answered in the handler's place, or changed the handler's result. */
  | 'replaced'
  | 'denied'
  | 'unknown-method'
  | 'invalid-arguments'
  | 'invalid-result'
  /** The handler threw a ScriptApiError, which went back to the script. */
  | 'app-error'
  /** The handler or a filter threw something else; the script saw a generic HostError. */
  | 'host-failure'
  | 'host-timeout'
  | 'response-too-large'
  /** The call was refused, or its result discarded, because the execution had ended or stopped admitting calls. */
  | 'revoked'
  | 'queue-full'
  | 'request-too-large';

/** One host-call attempt, as the host recorded it. Holds no argument or result data. */
export interface CallRecord {
  /** The attempt's place in the execution, from 1. */
  readonly seq: number;
  /** The guest's correlation id, or null for an attempt refused before it was admitted. */
  readonly callId: number | null;
  /** The method as the script named it, cut to 256 characters. */
  readonly method: string;
  /** The registered method's effect, or null for an unknown method. */
  readonly effect: string | null;
  /** Milliseconds from the execution's start. */
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly disposition: CallDisposition;
  /** Whether the method's handler was invoked. A replaced result says false. */
  readonly handlerRan: boolean;
  readonly requestBytes: number;
  readonly responseBytes: number;
  /** The error name the script saw, or null when the call succeeded. */
  readonly errorName: string | null;
}

/** Host-authenticated facts about one execution, for audit and progress. */
export interface ExecutionEvidence {
  readonly executionId: string;
  readonly sessionId: string;
  readonly language: ScriptLanguage;
  readonly source: { readonly sha256: string; readonly bytes: number };
  readonly runtime: {
    readonly packageVersion: string;
    readonly guestAbi: number;
    readonly bootstrapVersion: number;
    readonly workerProtocol: number;
    readonly artifact: string;
    readonly artifactSha256: string;
    readonly quickjsCommit: string;
  };
  readonly contract: { readonly sha256: string; readonly version: string | null };
  readonly policyVersion: string | null;
  /** `system` is Date.now; `injected` is the runtime's `clock` option. */
  readonly clock: 'system' | 'injected';
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly elapsedMs: number;
  readonly status: ExecutionStatus;
  readonly limitReached: ResourceLimit | null;
  readonly calls: readonly CallRecord[];
  readonly counters: {
    readonly callAttempts: number;
    readonly callsAdmitted: number;
    readonly callsDenied: number;
    readonly callsFailed: number;
    readonly rpcBytes: number;
    readonly logEntries: number;
    readonly logBytes: number;
    readonly resultBytes: number;
    readonly eventCallbackErrors: number;
  };
  readonly truncated: { readonly logs: boolean };
  readonly measurements: {
    /** TypeScript checking and emit, or null for JavaScript. */
    readonly compileMs: number | null;
    /** Time spent in host-call handling, filters included. */
    readonly hostCallMs: number;
    /** Starting the guest worker and its WebAssembly instance. */
    readonly workerStartMs: number | null;
    /** The guest's linear memory when the execution ended, or null if the guest never reported. */
    readonly guestMemoryBytes: number | null;
    /** From the stop request (cancel, deadline, hard limit) to the worker's exit. */
    readonly terminationLatencyMs: number | null;
  };
  /** Measurements this runtime cannot make, named rather than estimated. */
  readonly unavailable: readonly string[];
  readonly limits: ExecutionLimits;
}

interface OutcomeBase {
  /** The script's console output: untrusted text, separate from the evidence. */
  readonly logs: readonly GuestLog[];
  readonly evidence: ExecutionEvidence;
}

/** How an execution ended. Every execution ends in exactly one of these. */
export type ExecutionOutcome =
  | (OutcomeBase & {
    readonly status: 'completed';
    /** The returned value; null when the script returned nothing (undefined). */
    readonly value: JsonValue;
    /** False when the script returned undefined or had no return. */
    readonly hasValue: boolean;
  })
  | (OutcomeBase & { readonly status: 'failed'; readonly error: ScriptDiagnostic })
  | (OutcomeBase & { readonly status: 'cancelled' })
  | (OutcomeBase & { readonly status: 'timed-out' })
  | (OutcomeBase & { readonly status: 'resource-limit'; readonly limit: ResourceLimit; readonly detail: string });

/** A structured event, emitted as the execution runs. Host-authenticated; never derived from guest text. */
export type ExecutionEvent =
  | { readonly type: 'execution-started'; readonly executionId: string; readonly sessionId: string; readonly language: ScriptLanguage; readonly at: string }
  | {
    readonly type: 'host-call-started';
    readonly executionId: string;
    readonly sessionId: string;
    readonly seq: number;
    readonly callId: number;
    readonly method: string;
    readonly effect: string;
    readonly at: string;
  }
  | {
    readonly type: 'host-call-completed';
    readonly executionId: string;
    readonly sessionId: string;
    readonly seq: number;
    readonly callId: number | null;
    readonly method: string;
    readonly effect: string | null;
    readonly disposition: CallDisposition;
    readonly handlerRan: boolean;
    readonly durationMs: number;
    /** What the handler or filter threw, for the host's own logs. Never sent to the script. */
    readonly hostError: unknown;
  }
  | {
    readonly type: 'host-call-denied';
    readonly executionId: string;
    readonly sessionId: string;
    readonly seq: number;
    readonly callId: number | null;
    readonly method: string;
    readonly reason: 'capability' | 'unknown-method' | 'filter';
  }
  | { readonly type: 'limit-reached'; readonly executionId: string; readonly sessionId: string; readonly limit: ResourceLimit; readonly detail: string }
  | { readonly type: 'execution-finished'; readonly executionId: string; readonly sessionId: string; readonly status: ExecutionStatus; readonly elapsedMs: number };
