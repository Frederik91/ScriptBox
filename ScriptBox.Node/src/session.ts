import { randomUUID } from 'node:crypto';
import type { MethodDescriptor } from './api.ts';
import { docsNamespace, DocsView } from './docs/docs-api.ts';
import type { DocsSource } from './docs/tree.ts';
import { buildApiReference } from './docs/api-reference.ts';
import { writeDeclarations, type DeclaredNamespace } from './declarations.ts';
import { ScriptBoxConfigurationError, SessionBusyError, SessionDisposedError } from './errors.ts';
import { runExecution, type EventSinks, type HostCallFilter, type RuntimeCore } from './execution.ts';
import { resolveLimits, type ExecutionLimits } from './limits.ts';
import type { ExecutionEvent, ExecutionOutcome, ScriptLanguage } from './outcome.ts';

/**
 * Which methods a session's scripts may call. Every call is checked; a method
 * not allowed fails with a `PermissionDeniedError` the script can catch.
 *
 * - `'*'`: every registered method.
 * - `'catalog.*'`: every method of a namespace.
 * - `'catalog.get'`: one method.
 * - A function: decides per method, from its descriptor.
 *
 * Patterns that name no registered namespace or method are a configuration
 * error. Capabilities limit what a script can do, not what it can see: the
 * declarations and docs describe the whole contract.
 */
export type Capabilities = readonly string[] | ((method: MethodDescriptor) => boolean);

export interface SessionOptions<Context> {
  /** The request-scoped state handlers receive as `call.context`, such as a draft and a project scope. */
  readonly context: Context;
  readonly capabilities: Capabilities;
  /** Runs inside the runtime's filters, for this session's calls only. */
  readonly filters?: readonly HostCallFilter<Context>[];
  /** Limits for this session's executions, applied over the runtime's. */
  readonly limits?: Partial<ExecutionLimits>;
  /**
   * Docs for this session, read after the API reference and the runtime's own
   * docs. Set `false` to turn `docs.*` off for this session.
   */
  readonly docs?: readonly DocsSource[] | false;
  /**
   * Which methods this session's declarations and /api docs describe; every
   * method when left out. It controls what a script is shown, not what it may
   * call: a hidden method that the capabilities allow still works, and one they
   * do not allow fails even when the script knows its name. TypeScript is
   * checked against the whole contract either way.
   */
  readonly discover?: (method: MethodDescriptor) => boolean;
  /** An id for evidence and events; a random UUID when left out. */
  readonly id?: string;
  readonly onEvent?: (event: ExecutionEvent) => void;
  readonly audit?: (event: ExecutionEvent) => void | Promise<void>;
}

export interface ExecuteOptions {
  readonly language: ScriptLanguage;
  readonly source: string;
  /** Cancels the execution. The outcome is `cancelled`, and calls in progress lose their authority. */
  readonly signal?: AbortSignal;
  /** Limits for this execution only, applied over the session's. */
  readonly limits?: Partial<ExecutionLimits>;
  /** An id for evidence and events; a random UUID when left out. */
  readonly executionId?: string;
}

/** What a session needs from its runtime, beyond the execution core. */
export interface SessionHost<Context> {
  readonly core: RuntimeCore<Context>;
  readonly limits: ExecutionLimits;
  /** The generated API reference for the whole contract, shared by sessions that do not filter discovery. */
  readonly apiReference: DocsSource;
  /** Docs the runtime adds after the API reference. */
  readonly docs: readonly DocsSource[];
  readonly namespaces: readonly DeclaredNamespace[];
  readonly declarations: string;
  readonly release: (session: Session<Context>) => void;
}

const idPattern = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Binds request state and policy to scripts. Runs one execution at a time:
 * a second `execute` while one runs is rejected with `SessionBusyError`,
 * never queued.
 */
export class Session<Context> {
  readonly id: string;
  private readonly host: SessionHost<Context>;
  private readonly allows: (method: MethodDescriptor) => boolean;
  private readonly filters: readonly HostCallFilter<Context>[];
  private readonly limits: ExecutionLimits;
  private readonly docsView: DocsView | undefined;
  private readonly events: EventSinks;
  private readonly context: Context;
  private readonly declarations: string;
  private active: AbortController | undefined;
  private activeDone: Promise<unknown> | undefined;
  private disposed = false;

  /** @internal Create sessions with `runtime.createSession`. */
  constructor(host: SessionHost<Context>, options: SessionOptions<Context>) {
    const id = options.id ?? randomUUID();
    if (!idPattern.test(id)) {
      throw new ScriptBoxConfigurationError('A session id is 1 to 128 letters, digits and . _ : -.');
    }
    this.id = id;
    this.host = host;
    this.context = options.context;
    this.limits = resolveLimits(host.limits, options.limits);
    const capable = compileCapabilities(options.capabilities, [...host.core.methods.values()].map((m) => m.descriptor));
    this.filters = Object.freeze([...(options.filters ?? [])]);
    checkFunctions('filter', this.filters);
    const discover = options.discover;
    if (discover !== undefined && typeof discover !== 'function') {
      throw new ScriptBoxConfigurationError('discover must be a function.');
    }
    // A filtered view gets its own declarations and reference, so nothing one session hides is cached for another.
    const visible = discover === undefined ? undefined : host.namespaces
      .map((ns) => ({ ...ns, methods: ns.methods.filter((m) => discover(m.descriptor)) }))
      .filter((ns) => ns.methods.length > 0);
    this.declarations = visible === undefined ? host.declarations : writeDeclarations(visible);
    const apiReference = visible === undefined ? host.apiReference : buildApiReference(visible);
    const docs = options.docs;
    const docsView = docs === false ? undefined : new DocsView([apiReference, ...host.docs, ...(docs ?? [])], this.limits.messageBytes);
    this.docsView = docsView;
    // The docs namespace describes the contract, so it follows the session's docs rather than its capabilities.
    this.allows = (method) => method.namespace === docsNamespace ? docsView !== undefined : capable(method);
    this.events = sinks(options.onEvent, options.audit);
  }

  /**
   * Declarations for a model's prompt or an editor: the methods this session's
   * `discover` shows, or every method. Capabilities do not narrow them.
   */
  getTypeScriptDeclarations(): string {
    return this.declarations;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get isBusy(): boolean {
    return this.active !== undefined;
  }

  /** Runs one script to its terminal outcome. Script failures are outcomes, not exceptions. */
  async execute(options: ExecuteOptions): Promise<ExecutionOutcome> {
    if (this.disposed) {
      throw new SessionDisposedError('The session has been disposed.');
    }
    if (this.active !== undefined) {
      throw new SessionBusyError('The session is running another execution. Executions on one session never overlap.');
    }
    const language: unknown = options.language;
    if (language !== 'javascript' && language !== 'typescript') {
      throw new ScriptBoxConfigurationError("language must be 'javascript' or 'typescript'.");
    }
    if (typeof options.source !== 'string') {
      throw new ScriptBoxConfigurationError('source must be a string.');
    }
    const executionId = options.executionId ?? randomUUID();
    if (!idPattern.test(executionId)) {
      throw new ScriptBoxConfigurationError('An execution id is 1 to 128 letters, digits and . _ : -.');
    }
    const limits = resolveLimits(this.limits, options.limits);

    // One signal for the caller's cancel and the session's dispose.
    const controller = new AbortController();
    const forward = (): void => {
      controller.abort();
    };
    if (options.signal?.aborted === true) {
      controller.abort();
    }
    options.signal?.addEventListener('abort', forward, { once: true });
    this.active = controller;
    const running = runExecution(this.host.core, {
      id: this.id,
      context: this.context,
      allows: this.allows,
      filters: this.filters,
      docsView: this.docsView,
      events: this.events,
    }, { executionId, language: options.language, source: options.source, limits, signal: controller.signal });
    this.activeDone = running;
    try {
      return await running;
    } finally {
      options.signal?.removeEventListener('abort', forward);
      this.active = undefined;
      this.activeDone = undefined;
    }
  }

  /** Cancels a running execution, waits for it to end and refuses further executions. */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.active?.abort();
    try {
      await this.activeDone;
    } finally {
      this.host.release(this);
    }
  }
}

function checkFunctions(kind: string, items: readonly unknown[]): void {
  for (const item of items) {
    if (typeof item !== 'function') {
      throw new ScriptBoxConfigurationError(`Every ${kind} must be a function.`);
    }
  }
}

/** @internal */
export function sinks(onEvent: ((event: ExecutionEvent) => void) | undefined, audit: ((event: ExecutionEvent) => void | Promise<void>) | undefined): EventSinks {
  if (onEvent !== undefined && typeof onEvent !== 'function') {
    throw new ScriptBoxConfigurationError('onEvent must be a function.');
  }
  if (audit !== undefined && typeof audit !== 'function') {
    throw new ScriptBoxConfigurationError('audit must be a function.');
  }
  return Object.freeze({
    onEvent: onEvent === undefined ? [] : [onEvent],
    audit: audit === undefined ? [] : [audit],
  });
}

function compileCapabilities(capabilities: Capabilities, methods: readonly MethodDescriptor[]): (method: MethodDescriptor) => boolean {
  if (typeof capabilities === 'function') {
    return (method) => {
      const allowed: unknown = capabilities(method);
      return allowed === true;
    };
  }
  if (!Array.isArray(capabilities)) {
    throw new ScriptBoxConfigurationError("capabilities must be an array of patterns such as 'catalog.*', or a function.");
  }
  const patterns: readonly unknown[] = capabilities;
  let all = false;
  const namespaces = new Set<string>();
  const exact = new Set<string>();
  const known = new Set(methods.map((m) => m.qualifiedName));
  const knownNamespaces = new Set(methods.map((m) => m.namespace));
  for (const pattern of patterns) {
    if (typeof pattern !== 'string') {
      throw new ScriptBoxConfigurationError('Every capability must be a string.');
    }
    if (pattern === '*') {
      all = true;
    } else if (pattern.endsWith('.*')) {
      const ns = pattern.slice(0, -2);
      if (!knownNamespaces.has(ns)) {
        throw new ScriptBoxConfigurationError(`The capability '${pattern}' names no registered namespace.`);
      }
      namespaces.add(ns);
    } else if (known.has(pattern)) {
      exact.add(pattern);
    } else {
      throw new ScriptBoxConfigurationError(`The capability '${pattern}' names no registered method. Use 'namespace.method', 'namespace.*' or '*'.`);
    }
  }
  return (method) => all || namespaces.has(method.namespace) || exact.has(method.qualifiedName);
}
