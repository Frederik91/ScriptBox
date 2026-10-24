// Acceptance 28: the fixtures in conformance/fixtures.json, which the .NET
// host runs too (ScriptBox.Tests/ConformanceTests.cs). Each case names what
// both hosts must do; there are no per-host expectations.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import {
  createApiKit,
  createRuntime,
  ScriptApiError,
  Type,
  type ExecutionOutcome,
  type HostCallFilter,
  type JsonValue,
} from '@frederik91/scriptbox';

interface Expectation {
  readonly status: string;
  readonly value?: JsonValue;
  readonly code?: string;
  readonly errorName?: string;
  readonly line?: number;
}

interface Case {
  readonly name: string;
  readonly script: string;
  readonly before?: string;
  readonly expect: Expectation;
  readonly calls?: readonly string[];
  readonly filters?: { readonly global: readonly string[]; readonly session: readonly string[] };
  readonly filterLog?: readonly string[];
  readonly replace?: { readonly method: string; readonly value: JsonValue };
  readonly refuse?: { readonly method: string; readonly errorName: string; readonly message: string };
  readonly sealResults?: boolean;
}

function isCase(value: unknown): value is Case {
  return typeof value === 'object' && value !== null
    && typeof Reflect.get(value, 'name') === 'string'
    && typeof Reflect.get(value, 'script') === 'string'
    && typeof Reflect.get(value, 'expect') === 'object';
}

const fixtures: unknown = JSON.parse(readFileSync(new URL('../../conformance/fixtures.json', import.meta.url), 'utf8'));
const rawCases: unknown = typeof fixtures === 'object' && fixtures !== null ? Reflect.get(fixtures, 'cases') : undefined;
assert.ok(Array.isArray(rawCases));
const items: unknown[] = rawCases;
const cases = items.filter(isCase);
assert.equal(cases.length, items.length, 'every fixture case is well formed');

function confApi(calls: string[]) {
  const kit = createApiKit<null>();
  return kit.namespace({
    name: 'conf',
    description: 'Methods for conformance tests.',
    methods: {
      echo: kit.method({ summary: 'Returns its argument.', effect: 'read', params: { value: Type.Unsafe<JsonValue>({}) }, result: Type.Unsafe<JsonValue>({}), handler: ({ value }) => value }),
      add: kit.method({ summary: 'Adds two numbers.', effect: 'read', params: { a: Type.Number(), b: Type.Number() }, result: Type.Number(), handler: ({ a, b }) => a + b }),
      greet: kit.method({
        summary: 'Greets someone.',
        effect: 'read',
        params: { name: Type.String(), greeting: Type.Optional(Type.String({ default: 'Hello' })) },
        result: Type.String(),
        handler: ({ name, greeting }) => `${greeting ?? 'Hello'}, ${name}`,
      }),
      fail: kit.method({
        summary: 'Throws an API error.',
        effect: 'read',
        params: { message: Type.String() },
        handler: ({ message }) => {
          throw new ScriptApiError({ name: 'ConfError', message });
        },
      }),
      record: kit.method({
        summary: 'Records a tag.',
        effect: 'draft-write',
        params: { tag: Type.String() },
        handler: ({ tag }) => {
          calls.push(`conf.record:${tag}`);
        },
      }),
      item: kit.method({
        summary: 'Gets an item.',
        effect: 'read',
        params: { id: Type.String() },
        result: Type.Object({ id: Type.String(), name: Type.String() }),
        handler: ({ id }) => {
          calls.push(`conf.item:${id}`);
          return { id, name: `Item ${id}` };
        },
      }),
      rename: kit.method({
        summary: 'Renames an item.',
        effect: 'draft-write',
        params: { change: Type.Object({ id: Type.String(), name: Type.String() }) },
        result: Type.Object({ id: Type.String(), name: Type.String() }),
        handler: ({ change }) => change,
      }),
      crash: kit.method({
        summary: 'Fails on the host with an internal error.',
        effect: 'read',
        handler: () => {
          throw new Error('database password is hunter2');
        },
      }),
    },
  });
}

function normalize(outcome: ExecutionOutcome): Expectation {
  switch (outcome.status) {
    case 'completed':
      return { status: 'completed', value: outcome.value };
    case 'failed':
      return { status: 'failed', code: outcome.error.code, errorName: outcome.error.name, ...(outcome.error.line === null ? {} : { line: outcome.error.line }) };
    default:
      return { status: outcome.status };
  }
}

describe('conformance fixtures shared with .NET (28)', () => {
  for (const fixture of cases) {
    test(fixture.name, async () => {
      const calls: string[] = [];
      const filterLog: string[] = [];
      const recorder = (name: string): HostCallFilter<null> => async (call, next) => {
        filterLog.push(`${name}>${call.method.qualifiedName}`);
        const result = await next();
        filterLog.push(`${name}<${call.method.qualifiedName}`);
        return result;
      };
      const global: HostCallFilter<null>[] = (fixture.filters?.global ?? []).map(recorder);
      const { replace, refuse } = fixture;
      if (replace !== undefined) {
        global.push((call, next) => call.method.qualifiedName === replace.method ? replace.value : next());
      }
      if (refuse !== undefined) {
        global.push((call, next) => {
          if (call.method.qualifiedName === refuse.method) {
            throw new ScriptApiError({ code: 'denied', name: refuse.errorName, message: refuse.message });
          }
          return next();
        });
      }
      const runtime = await createRuntime<null>({ apis: [confApi(calls)], filters: global, sealResults: fixture.sealResults === true });
      try {
        const session = runtime.createSession({ context: null, capabilities: ['*'], filters: (fixture.filters?.session ?? []).map(recorder) });
        if (fixture.before !== undefined) {
          assert.equal((await session.execute({ language: 'javascript', source: fixture.before })).status, 'completed');
        }
        const actual = normalize(await session.execute({ language: 'javascript', source: fixture.script }));
        const expected = fixture.expect;
        const compared = Object.fromEntries(Object.keys(expected).map((key) => [key, Reflect.get(actual, key)]));
        assert.deepEqual(compared, expected);
        if (fixture.calls !== undefined) {
          assert.deepEqual(calls, fixture.calls);
        }
        if (fixture.filterLog !== undefined) {
          assert.deepEqual(filterLog, fixture.filterLog);
        }
      } finally {
        await runtime.dispose();
      }
    });
  }
});
