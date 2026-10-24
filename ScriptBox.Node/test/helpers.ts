import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createApiKit,
  createRuntime,
  Type,
  type ExecutionOutcome,
  type JsonValue,
  type RuntimeOptions,
  type ScriptBoxRuntime,
  type SessionOptions,
} from '@frederik91/scriptbox';
import { CatalogStore, createCatalogApis, Draft, sampleItems, type RequestState } from '../examples/catalog/app.ts';

export { CatalogStore, Draft, sampleItems, type RequestState };

export function completed(outcome: ExecutionOutcome): JsonValue {
  assert.ok(outcome.status === 'completed', `expected completed, got ${JSON.stringify(outcome.status === 'failed' ? outcome.error : outcome.status)}`);
  return outcome.value;
}

export function failed(outcome: ExecutionOutcome): Extract<ExecutionOutcome, { status: 'failed' }>['error'] {
  assert.ok(outcome.status === 'failed', `expected failed, got ${outcome.status}`);
  return outcome.error;
}

export function limited(outcome: ExecutionOutcome): Extract<ExecutionOutcome, { status: 'resource-limit' }> {
  assert.ok(outcome.status === 'resource-limit', `expected resource-limit, got ${JSON.stringify(outcome.status === 'failed' ? outcome.error : outcome.status)}`);
  return outcome;
}

/** Measures the parent's event loop while something runs: the longest gap between 5 ms ticks. */
export function heartbeat(): { stop: () => number } {
  let last = performance.now();
  let maxGap = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 5);
  return {
    stop: () => {
      clearInterval(timer);
      return maxGap;
    },
  };
}

/** A runtime with the catalog example's API, and a request helper that binds a fresh draft. */
export async function catalogRuntime(options: { delayMs?: number } & Omit<RuntimeOptions<RequestState>, 'apis'> = {}): Promise<{
  runtime: ScriptBoxRuntime<RequestState>;
  store: CatalogStore;
  session: (draft: Draft, extra?: Partial<SessionOptions<RequestState>>) => ReturnType<ScriptBoxRuntime<RequestState>['createSession']>;
}> {
  const { delayMs, ...rest } = options;
  const runtime = await createRuntime<RequestState>({ ...rest, apis: createCatalogApis(delayMs === undefined ? {} : { delayMs }) });
  const store = new CatalogStore(sampleItems());
  return {
    runtime,
    store,
    session: (draft, extra = {}) => runtime.createSession({ capabilities: ['catalog.*', 'draft.*'], ...extra, context: { draft } }),
  };
}

/** A namespace of small test methods. `log` records every handler run, in order. */
export function testApis(log: string[] = []) {
  const kit = createApiKit<{ readonly tenant: string }>();
  const test = kit.namespace({
    name: 'test',
    description: 'Methods for tests.',
    methods: {
      echo: kit.method({
        summary: 'Returns its argument.',
        effect: 'read',
        params: { value: Type.Unsafe<JsonValue>({}) },
        result: Type.Unsafe<JsonValue>({}),
        handler: ({ value }) => {
          log.push('echo');
          return value;
        },
      }),
      repeat: kit.method({
        summary: 'Returns text repeated, to make a large response from a small request.',
        effect: 'read',
        params: { text: Type.String({ maxLength: 100 }), times: Type.Integer({ minimum: 0, maximum: 1_000_000 }) },
        result: Type.String(),
        handler: ({ text, times }) => {
          log.push('repeat');
          return text.repeat(times);
        },
      }),
      wait: kit.method({
        summary: 'Waits, then returns its argument.',
        effect: 'read',
        params: { ms: Type.Integer({ minimum: 0 }), value: Type.Optional(Type.String()) },
        result: Type.String(),
        handler: async ({ ms, value }, call) => {
          log.push(`wait:${value ?? ''}:start`);
          await delay(ms, undefined, { signal: call.signal });
          log.push(`wait:${value ?? ''}:end`);
          return value ?? 'waited';
        },
      }),
      tenant: kit.method({
        summary: 'Returns the tenant the session was bound to.',
        effect: 'read',
        result: Type.String(),
        handler: (_args, call) => {
          log.push('tenant');
          return call.context.tenant;
        },
      }),
      nothing: kit.method({
        summary: 'Returns nothing.',
        effect: 'draft-write',
        handler: () => {
          log.push('nothing');
        },
      }),
      fail: kit.method({
        summary: 'Throws an internal error.',
        effect: 'read',
        handler: () => {
          log.push('fail');
          throw new Error('database password is hunter2 at /srv/app/db.ts:12');
        },
      }),
      wrong: kit.method({
        summary: 'Returns a value that breaks its own result schema.',
        effect: 'read',
        result: Type.Object({ count: Type.Integer() }),
        handler: () => {
          log.push('wrong');
          // A number, so TypeScript accepts it, but not the integer the schema requires.
          return { count: 1.5 };
        },
      }),
    },
  });
  return { kit, test };
}
