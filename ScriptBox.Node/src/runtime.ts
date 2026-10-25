import { contractDigest, type ApiDefinition, type MethodDescriptor, type RegisteredMethod } from './api.ts';
import { loadAssets } from './assets.ts';
import { writeDeclarations } from './declarations.ts';
import { buildApiReference } from './docs/api-reference.ts';
import { createDocsApi, docsNamespace } from './docs/docs-api.ts';
import type { DocsSource } from './docs/tree.ts';
import { ScriptBoxConfigurationError } from './errors.ts';
import type { Clock, HostCallFilter, RuntimeCore } from './execution.ts';
import { buildInfo } from './generated/build-info.ts';
import { utf8Length } from './json.ts';
import { contractLimits, defaultLimits, resolveLimits, type ExecutionLimits } from './limits.ts';
import type { ExecutionEvent } from './outcome.ts';
import { Session, sinks, type SessionOptions } from './session.ts';
import { CompilerPool } from './typescript/compiler.ts';

export interface RuntimeOptions<Context> {
  /** The namespaces scripts can reach, built with `createApiKit`. `docs` is added for you. */
  readonly apis: readonly ApiDefinition<Context>[];
  /** Run around every call of every session, outside the session's own filters. */
  readonly filters?: readonly HostCallFilter<Context>[];
  /** The defaults every session starts from. */
  readonly limits?: Partial<ExecutionLimits>;
  /** Docs every session can read through `docs.*`, after the generated API reference under /api. */
  readonly docs?: readonly DocsSource[];
  /** A label for the contract, recorded in evidence next to its digest. */
  readonly contractVersion?: string;
  /** A label for the policy (capabilities and filters), recorded in evidence. */
  readonly policyVersion?: string;
  /** The host's clock for evidence, events and call deadlines. Date.now when left out. */
  readonly clock?: Clock;
  /**
   * Stops the script's clock at the execution's start, so `Date.now()` and
   * `new Date()` return the same instant for the whole execution.
   */
  readonly frozenGuestClock?: boolean;
  /**
   * Seals every object in a host result before the script sees it, as .NET's
   * SealHostResults does: assigning a property an object does not have throws,
   * so a typo fails loudly. Existing properties stay writable and arrays stay
   * growable. It is neither immutability nor authorization; a script always
   * works on its own copy, and changing it never changes host state.
   */
  readonly sealResults?: boolean;
  /** TypeScript compiler workers, shared by every session. 1 when left out. */
  readonly compilerWorkers?: number;
  readonly onEvent?: (event: ExecutionEvent) => void;
  readonly audit?: (event: ExecutionEvent) => void | Promise<void>;
}

/** The registered contract, as discovery and policy see it. */
export interface ContractInfo {
  /** SHA-256 of every namespace, method, schema, effect, concurrency and description. */
  readonly sha256: string;
  readonly version: string | null;
  readonly namespaces: readonly { readonly name: string; readonly description: string | undefined; readonly methods: readonly MethodDescriptor[] }[];
}

export interface ScriptBoxRuntime<Context> {
  readonly contract: ContractInfo;
  /** The limits sessions start from. */
  readonly limits: ExecutionLimits;
  /**
   * Declarations for a model's prompt or an editor. With `include`, only the
   * methods it accepts and the types they use; scripts are always type-checked
   * against every method.
   */
  getTypeScriptDeclarations(include?: (method: MethodDescriptor) => boolean): string;
  createSession(options: SessionOptions<Context>): Session<Context>;
  /** Disposes every session, cancelling what runs, and stops the compiler workers. */
  dispose(): Promise<void>;
}

const minimumNodeMajor = 24;
const versionLabelPattern = /^[\x20-\x7e]{1,128}$/;

/**
 * Creates a runtime: the registered contract, its declarations and docs, the
 * global policy and the compiler workers. Create one per application and a
 * session per request.
 */
export async function createRuntime<Context>(options: RuntimeOptions<Context>): Promise<ScriptBoxRuntime<Context>> {
  const major = Number(process.versions.node.split('.')[0]);
  if (!(major >= minimumNodeMajor)) {
    throw new ScriptBoxConfigurationError(`ScriptBox needs Node.js ${minimumNodeMajor} or later; this is ${process.versions.node}.`);
  }
  if (!Array.isArray(options.apis)) {
    throw new ScriptBoxConfigurationError('apis must be an array of namespaces made with createApiKit.');
  }
  const apis: readonly ApiDefinition<Context>[] = options.apis;
  const limits = resolveLimits(defaultLimits, options.limits);
  checkLabel('contractVersion', options.contractVersion);
  checkLabel('policyVersion', options.policyVersion);
  const filters = Object.freeze([...(options.filters ?? [])]);
  for (const filter of filters) {
    if (typeof filter !== 'function') {
      throw new ScriptBoxConfigurationError('Every filter must be a function.');
    }
  }
  const workers = options.compilerWorkers ?? 1;
  if (!Number.isSafeInteger(workers) || workers < 1 || workers > 16) {
    throw new ScriptBoxConfigurationError('compilerWorkers must be an integer from 1 to 16.');
  }

  // The docs namespace is part of the contract like any other: declared, documented and dispatched the same way.
  const docsApi = createDocsApi();
  const namespaces: readonly ApiDefinition<Context>[] = [...apis, docsApi];
  const methods = new Map<string, RegisteredMethod<Context>>();
  const names = new Set<string>();
  if (namespaces.length > contractLimits.namespaces) {
    throw new ScriptBoxConfigurationError(`A runtime may register at most ${contractLimits.namespaces} namespaces.`);
  }
  for (const ns of namespaces) {
    const kind: unknown = ns.kind;
    if (kind !== 'scriptbox-namespace') {
      throw new ScriptBoxConfigurationError('Every api must be a namespace made with createApiKit().namespace.');
    }
    if (ns !== docsApi && ns.name === docsNamespace) {
      throw new ScriptBoxConfigurationError(`The namespace name '${docsNamespace}' is reserved for the built-in docs.`);
    }
    if (names.has(ns.name)) {
      throw new ScriptBoxConfigurationError(`The namespace '${ns.name}' is registered twice.`);
    }
    names.add(ns.name);
    for (const method of ns.methods) {
      methods.set(method.descriptor.qualifiedName, method);
    }
  }
  if (methods.size > contractLimits.methods) {
    throw new ScriptBoxConfigurationError(`A runtime may register at most ${contractLimits.methods} methods.`);
  }

  const contractNamespaces = Object.freeze(namespaces.map((ns) => Object.freeze({
    name: ns.name,
    description: ns.description,
    methods: Object.freeze(ns.methods.map((m) => m.descriptor)),
  })));
  const sha256 = contractDigest(contractNamespaces);
  const declarations = writeDeclarations(namespaces);
  if (utf8Length(declarations) > contractLimits.declarationBytes) {
    throw new ScriptBoxConfigurationError(`The declarations are larger than ${contractLimits.declarationBytes} bytes. Register fewer or smaller schemas.`);
  }
  const apisCode = namespaces.map((ns) => [
    '(function (root) {',
    '  var api = {};',
    ...ns.methods.map((m) => `  api.${m.descriptor.name} = __scriptbox.createMethod(${JSON.stringify(m.descriptor.qualifiedName)});`),
    `  Object.defineProperty(root, ${JSON.stringify(ns.name)}, { value: Object.freeze(api), writable: false, enumerable: false, configurable: false });`,
    '})(globalThis);',
  ].join('\n')).join('\n');

  const assets = await loadAssets();
  const compiler = new CompilerPool(workers, limits.compilerHeapMb);
  const clock = options.clock ?? { now: () => Date.now() };
  if (typeof clock.now !== 'function') {
    throw new ScriptBoxConfigurationError('clock must have a now() function.');
  }

  const core: RuntimeCore<Context> = Object.freeze({
    module: assets.module,
    initialMemoryBytes: buildInfo.artifact.initialMemoryBytes,
    bootstrapCode: assets.bootstrapCode,
    apisCode,
    methods,
    filters,
    declarations,
    declarationsKey: sha256,
    compiler,
    clock,
    clockSource: options.clock === undefined ? 'system' : 'injected',
    frozenGuestClock: options.frozenGuestClock === true,
    sealResults: options.sealResults === true,
    contractSha256: sha256,
    contractVersion: options.contractVersion ?? null,
    policyVersion: options.policyVersion ?? null,
    packageVersion: buildInfo.packageVersion,
    artifact: buildInfo.artifact.file,
    artifactSha256: buildInfo.artifact.sha256,
    quickjsCommit: buildInfo.quickjs.commit,
    events: sinks(options.onEvent, options.audit),
  });

  const apiReference = buildApiReference(namespaces);
  const docs = Object.freeze([...(options.docs ?? [])]);
  const sessions = new Set<Session<Context>>();
  let disposed = false;

  return Object.freeze({
    contract: Object.freeze({ sha256, version: options.contractVersion ?? null, namespaces: contractNamespaces }),
    limits,
    getTypeScriptDeclarations: (include?: (method: MethodDescriptor) => boolean): string => include === undefined
      ? declarations
      : writeDeclarations(namespaces.map((ns) => ({ ...ns, methods: ns.methods.filter((m) => include(m.descriptor)) }))),
    createSession: (sessionOptions: SessionOptions<Context>): Session<Context> => {
      if (disposed) {
        throw new ScriptBoxConfigurationError('The runtime has been disposed.');
      }
      const session = new Session<Context>({
        core,
        limits,
        apiReference,
        docs,
        namespaces,
        declarations,
        release: (s) => {
          sessions.delete(s);
        },
      }, sessionOptions);
      sessions.add(session);
      return session;
    },
    dispose: async (): Promise<void> => {
      if (disposed) {
        return;
      }
      disposed = true;
      await Promise.all([...sessions].map((s) => s.dispose()));
      await compiler.dispose();
    },
  });
}

function checkLabel(name: string, value: string | undefined): void {
  if (value !== undefined && (typeof value !== 'string' || !versionLabelPattern.test(value))) {
    throw new ScriptBoxConfigurationError(`${name} must be 1 to 128 printable ASCII characters.`);
  }
}
