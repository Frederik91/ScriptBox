import { createHash } from 'node:crypto';
import { Type, type Static, type TObject, type TProperties, type TSchema } from 'typebox';
import { ScriptBoxConfigurationError } from './errors.ts';
import { asJsonValue, freezeJson, isJsonArray, utf8Length, type JsonValue } from './json.ts';
import { contractLimits } from './limits.ts';
import { compileSchema, type SchemaNode } from './schema.ts';

/**
 * What a method does, as the host declares it. Filters and capability rules
 * read it; ScriptBox itself gives no effect special treatment except
 * `documentation`, which it uses for the built-in docs namespace.
 */
export type MethodEffect = 'read' | 'draft-write' | 'documentation' | (string & Record<never, never>);

/** One call into a host method, as its handler sees it. Everything here is set by trusted code. */
export interface HostCall<Context> {
  /** The request-scoped state the session was created with. */
  readonly context: Context;
  readonly method: MethodDescriptor;
  readonly sessionId: string;
  readonly executionId: string;
  /** The call's sequence number within its execution, from 1. */
  readonly callId: number;
  /**
   * Aborted when the call loses its authority: the execution is cancelled,
   * times out, fails or is disposed, this call exceeds its own timeout, or the
   * call has ended, however it ended. Pass it to the I/O the handler starts.
   */
  readonly signal: AbortSignal;
  /** When the call must finish, in milliseconds since the epoch on the runtime's clock. */
  readonly deadline: number;
  /**
   * Throws if the call has lost its authority. Call it immediately before
   * changing state, in the same synchronous step as the change, so a call
   * revoked while it awaited cannot write.
   */
  throwIfRevoked(): void;
}

/** The arguments a handler receives: the method's parameters by name, validated, with defaults applied. */
export type MethodArgs<Params extends TProperties> = Static<TObject<Params>>;

/** A handler returns its result schema's static type, or nothing for a method without a result. */
export type MethodHandler<Context, Params extends TProperties, Result> = Result extends TSchema
  ? (args: MethodArgs<Params>, call: HostCall<Context>) => Static<Result> | Promise<Static<Result>>
  : (args: MethodArgs<Params>, call: HostCall<Context>) => void | Promise<void>;

export interface MethodSpec<Context, Params extends TProperties, Result extends TSchema | undefined> {
  /** One sentence: what the method does. Shown in declarations, docs listings and evidence. */
  readonly summary: string;
  /** More detail, appended after the summary in declarations and docs. */
  readonly description?: string;
  readonly effect: MethodEffect;
  /**
   * The parameters in the order a script passes them, each with its schema.
   * Mark trailing ones with `Type.Optional`; a `default` in the schema fills in
   * an omitted one.
   */
  readonly params?: Params;
  /** The result's schema. Leave it out for a method that returns nothing. */
  readonly result?: Result;
  /** This method's time limit, at most the execution's remaining time. */
  readonly timeoutMs?: number;
  /**
   * Lets calls to this method run at the same time as other concurrent calls
   * of the same execution, up to the `concurrentCalls` limit, so a script that
   * awaits several together waits about as long as the slowest. Set it only
   * when the handler, and the filters it passes through, are safe to run
   * interleaved with themselves and the other concurrent methods: typically
   * a read. Every other call runs alone: it starts once the calls before it
   * have finished, and the calls after it wait for it.
   */
  readonly concurrent?: boolean;
  /** Facts for filters and capability rules, such as a required role. Never sent to the script. */
  readonly metadata?: Readonly<Record<string, JsonValue>>;
  readonly handler: MethodHandler<Context, Params, Result>;
}

/** A method ready to be placed in a namespace. Create it with {@link ApiKit.method}. */
export interface MethodDefinition<Context> {
  readonly kind: 'scriptbox-method';
  /** @internal */
  readonly compile: (namespace: string, name: string) => RegisteredMethod<Context>;
}

export interface NamespaceSpec<Context> {
  /** The global the script reaches the methods through, such as `catalog`. */
  readonly name: string;
  readonly description?: string;
  readonly methods: Readonly<Record<string, MethodDefinition<Context>>>;
}

/** A namespace of methods, ready for {@link createRuntime}. */
export interface ApiDefinition<Context> {
  readonly kind: 'scriptbox-namespace';
  readonly name: string;
  readonly description: string | undefined;
  /** @internal */
  readonly methods: readonly RegisteredMethod<Context>[];
}

/** One parameter of a registered method. */
export interface ParamDescriptor {
  readonly name: string;
  readonly optional: boolean;
  readonly description: string | undefined;
  /** The parameter's JSON Schema, as registered. */
  readonly schema: JsonValue;
}

/** A registered method as filters, capability rules and discovery see it. Immutable. */
export interface MethodDescriptor {
  readonly namespace: string;
  readonly name: string;
  /** `namespace.name`, as a script calls it. */
  readonly qualifiedName: string;
  readonly summary: string;
  readonly description: string | undefined;
  readonly effect: MethodEffect;
  readonly params: readonly ParamDescriptor[];
  /** The result's JSON Schema, or undefined for a method that returns nothing. */
  readonly result: JsonValue | undefined;
  readonly metadata: Readonly<Record<string, JsonValue>>;
  readonly timeoutMs: number | undefined;
  /** Whether calls may run alongside other concurrent calls. See {@link MethodSpec.concurrent}. */
  readonly concurrent: boolean;
}

/** @internal A method with its compiled schemas and its handler. */
export interface RegisteredMethod<Context> {
  readonly descriptor: MethodDescriptor;
  readonly params: readonly { readonly name: string; readonly node: SchemaNode; readonly required: boolean }[];
  readonly resultNode: SchemaNode | undefined;
  /** Runs the handler with arguments that came out of the validator. */
  readonly invoke: (args: ValidatedArgs, call: HostCall<Context>) => unknown;
}

/** @internal Arguments the validator produced; only those are passed to a handler. */
export interface ValidatedArgs {
  readonly values: Readonly<Record<string, JsonValue>>;
}

const validatedArgs = new WeakSet<object>();

/** @internal Marks an object as produced by argument validation. */
export function markValidated(values: Record<string, JsonValue>): ValidatedArgs {
  validatedArgs.add(values);
  return { values };
}

const identifierPattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Names a namespace cannot take: the bridge's own globals and the standard
 * globals the bootstrap and scripts rely on.
 */
const reservedNames = new Set([
  'console', 'globalThis', '__scriptbox', '__host', '__scriptbox_options',
  'Object', 'Function', 'Array', 'Number', 'parseFloat', 'parseInt', 'Infinity', 'NaN', 'undefined', 'Boolean', 'String',
  'Symbol', 'Date', 'Promise', 'RegExp', 'Error', 'AggregateError', 'EvalError', 'RangeError', 'ReferenceError',
  'SyntaxError', 'TypeError', 'URIError', 'JSON', 'Math', 'Intl', 'ArrayBuffer', 'Atomics', 'Uint8Array', 'Int8Array',
  'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array', 'Uint8ClampedArray',
  'BigUint64Array', 'BigInt64Array', 'DataView', 'Map', 'BigInt', 'Set', 'WeakMap', 'WeakSet', 'Proxy', 'Reflect',
  'FinalizationRegistry', 'WeakRef', 'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'escape',
  'unescape', 'isFinite', 'isNaN', 'eval', 'SharedArrayBuffer', 'Iterator', 'Float16Array',
]);

function checkName(kind: string, name: string): void {
  if (!identifierPattern.test(name) || name.length > 64) {
    throw new ScriptBoxConfigurationError(`The ${kind} name '${name}' is not a JavaScript identifier of at most 64 characters.`);
  }
  if (name.startsWith('__') || reservedNames.has(name)) {
    throw new ScriptBoxConfigurationError(`The ${kind} name '${name}' is reserved.`);
  }
}

function checkText(label: string, text: string | undefined): void {
  if (text !== undefined && utf8Length(text) > contractLimits.descriptionBytes) {
    throw new ScriptBoxConfigurationError(`${label} may be at most ${contractLimits.descriptionBytes} bytes.`);
  }
}

/** Copies a schema object into plain JSON, so the contract holds no functions or symbols. */
function schemaJson(schema: unknown, label: string): JsonValue {
  try {
    const text = JSON.stringify(schema);
    return freezeJson(asJsonValue(JSON.parse(text)));
  } catch {
    throw new ScriptBoxConfigurationError(`${label} is not a JSON Schema object.`);
  }
}

function descriptionOf(schema: JsonValue): string | undefined {
  if (typeof schema === 'object' && schema !== null && !Array.isArray(schema)) {
    const description: unknown = Reflect.get(schema, 'description');
    return typeof description === 'string' ? description : undefined;
  }
  return undefined;
}

/** Defines methods and namespaces whose handlers share one request-state type. */
export interface ApiKit<Context> {
  method<const Params extends TProperties = Record<string, never>, Result extends TSchema | undefined = undefined>(
    spec: MethodSpec<Context, Params, Result>,
  ): MethodDefinition<Context>;
  namespace(spec: NamespaceSpec<Context>): ApiDefinition<Context>;
}

/**
 * Starts an API for handlers that receive `Context`: the request-scoped state
 * each session binds, such as a draft and a project scope.
 *
 * ```ts
 * const api = createApiKit<RequestState>();
 * const catalog = api.namespace({
 *   name: 'catalog',
 *   methods: {
 *     get: api.method({
 *       summary: 'Gets one item by its id.',
 *       effect: 'read',
 *       params: { query: Type.Object({ id: Type.String() }) },
 *       result: Item,
 *       handler: ({ query }, call) => call.context.draft.get(query.id),
 *     }),
 *   },
 * });
 * ```
 */
export function createApiKit<Context>(): ApiKit<Context> {
  return {
    method: (spec) => defineMethod(spec),
    namespace: (spec) => defineNamespace(spec),
  };
}

function defineMethod<Context, Params extends TProperties, Result extends TSchema | undefined>(
  spec: MethodSpec<Context, Params, Result>,
): MethodDefinition<Context> {
  const isArgs = (values: object): values is MethodArgs<Params> => validatedArgs.has(values);
  const handler = spec.handler;

  const compile = (namespace: string, name: string): RegisteredMethod<Context> => {
    const qualifiedName = `${namespace}.${name}`;
    checkName('method', name);
    if (typeof spec.summary !== 'string' || spec.summary.trim().length === 0) {
      throw new ScriptBoxConfigurationError(`${qualifiedName} needs a summary.`);
    }
    checkText(`${qualifiedName}'s summary`, spec.summary);
    checkText(`${qualifiedName}'s description`, spec.description);
    if (typeof spec.effect !== 'string' || spec.effect.length === 0 || spec.effect.length > 64) {
      throw new ScriptBoxConfigurationError(`${qualifiedName} needs an effect such as 'read' or 'draft-write'.`);
    }
    if (spec.timeoutMs !== undefined && (!Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs < 1)) {
      throw new ScriptBoxConfigurationError(`${qualifiedName}'s timeoutMs must be a positive integer.`);
    }
    if (spec.concurrent !== undefined && typeof spec.concurrent !== 'boolean') {
      throw new ScriptBoxConfigurationError(`${qualifiedName}'s concurrent must be true or false.`);
    }

    const paramEntries = Object.entries(spec.params ?? {});
    if (paramEntries.length > contractLimits.paramsPerMethod) {
      throw new ScriptBoxConfigurationError(`${qualifiedName} may have at most ${contractLimits.paramsPerMethod} parameters.`);
    }
    // TypeBox's own object builder decides which parameters are required, from Type.Optional.
    const objectSchema = schemaJson(Type.Object(spec.params ?? {}), `${qualifiedName}'s params`);
    const paramsNode = compileSchema(objectSchema, `${qualifiedName} params`);
    if (paramsNode.kind !== 'object') {
      throw new ScriptBoxConfigurationError(`${qualifiedName}'s params must be an object of parameter schemas.`);
    }
    const params = paramsNode.properties.map((p) => ({ name: p.name, node: p.node, required: p.required }));
    let sawOptional = false;
    for (const param of params) {
      checkName('parameter', param.name);
      if (!param.required) {
        sawOptional = true;
      } else if (sawOptional) {
        throw new ScriptBoxConfigurationError(`${qualifiedName}: the required parameter '${param.name}' follows an optional one.`);
      }
    }

    const resultJson = spec.result === undefined ? undefined : schemaJson(spec.result, `${qualifiedName}'s result`);
    const resultNode = resultJson === undefined ? undefined : compileSchema(resultJson, `${qualifiedName} result`);

    const metadata = freezeJson(schemaJsonRecord(spec.metadata ?? {}, `${qualifiedName}'s metadata`));
    const descriptor: MethodDescriptor = Object.freeze({
      namespace,
      name,
      qualifiedName,
      summary: spec.summary.trim(),
      description: spec.description,
      effect: spec.effect,
      params: Object.freeze(params.map((param) => {
        const schema = schemaJson(Reflect.get(spec.params ?? {}, param.name), `${qualifiedName} parameter ${param.name}`);
        return Object.freeze({ name: param.name, optional: !param.required, description: descriptionOf(schema), schema });
      })),
      result: resultJson,
      metadata,
      timeoutMs: spec.timeoutMs,
      concurrent: spec.concurrent === true,
    });

    return Object.freeze({
      descriptor,
      params: Object.freeze(params),
      resultNode,
      invoke: (args: ValidatedArgs, call: HostCall<Context>): unknown => {
        const values = args.values;
        if (!isArgs(values)) {
          throw new TypeError(`${qualifiedName} was invoked with arguments that did not come from validation.`);
        }
        return handler(values, call);
      },
    });
  };

  return Object.freeze({ kind: 'scriptbox-method', compile });
}

function schemaJsonRecord(value: Readonly<Record<string, JsonValue>>, label: string): Record<string, JsonValue> {
  const json = schemaJson(value, label);
  if (typeof json !== 'object' || json === null || isJsonArray(json)) {
    throw new ScriptBoxConfigurationError(`${label} must be an object.`);
  }
  return { ...json };
}

function defineNamespace<Context>(spec: NamespaceSpec<Context>): ApiDefinition<Context> {
  checkName('namespace', spec.name);
  checkText(`The ${spec.name} namespace's description`, spec.description);
  const entries = Object.entries(spec.methods);
  if (entries.length === 0) {
    throw new ScriptBoxConfigurationError(`The ${spec.name} namespace has no methods.`);
  }
  const methods = entries.map(([name, definition]) => {
    const kind: unknown = definition.kind;
    if (kind !== 'scriptbox-method') {
      throw new ScriptBoxConfigurationError(`${spec.name}.${name} was not created with ApiKit.method.`);
    }
    return definition.compile(spec.name, name);
  });
  return Object.freeze({ kind: 'scriptbox-namespace', name: spec.name, description: spec.description, methods: Object.freeze(methods) });
}

/** Canonical JSON: keys sorted, so equal contracts hash equally. */
export function canonicalJson(value: JsonValue | undefined): string {
  if (value === undefined) {
    return 'null';
  }
  if (typeof value !== 'object' || value === null) {
    return JSON.stringify(value);
  }
  if (isJsonArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const record: Readonly<Record<string, JsonValue>> = value;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

/** The SHA-256 of the registered contract: every namespace, method, schema, effect and description. */
export function contractDigest(namespaces: readonly { name: string; description: string | undefined; methods: readonly MethodDescriptor[] }[]): string {
  const contract: JsonValue = namespaces.map((ns) => ({
    name: ns.name,
    description: ns.description ?? null,
    methods: ns.methods.map((m) => ({
      name: m.name,
      summary: m.summary,
      description: m.description ?? null,
      effect: m.effect,
      timeoutMs: m.timeoutMs ?? null,
      // Only when set, so a contract that opts nothing in keeps the digest it had before concurrency existed.
      ...(m.concurrent ? { concurrent: true } : {}),
      metadata: m.metadata,
      params: m.params.map((p) => ({ name: p.name, optional: p.optional, schema: p.schema })),
      result: m.result ?? null,
    })),
  }));
  return createHash('sha256').update(canonicalJson(contract)).digest('hex');
}
