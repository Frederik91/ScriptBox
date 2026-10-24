// Acceptance 6: value shapes, optional fields and defaults, discriminated
// unions, and the values that have no place on the wire.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createApiKit, createRuntime, Type, type ScriptBoxRuntime, type Session } from '@frederik91/scriptbox';
import { completed, failed } from './helpers.ts';

const Shape = Type.Union([
  Type.Object({ kind: Type.Literal('circle'), radius: Type.Number({ exclusiveMinimum: 0 }) }),
  Type.Object({ kind: Type.Literal('rect'), width: Type.Number({ minimum: 0 }), height: Type.Number({ minimum: 0 }) }),
], { $id: 'Shape', description: 'A circle or a rectangle.' });

const Everything = Type.Object({
  text: Type.String({ maxLength: 20 }),
  ratio: Type.Number(),
  count: Type.Integer({ minimum: 0, maximum: 10 }),
  flag: Type.Boolean(),
  nothing: Type.Null(),
  list: Type.Array(Type.Number(), { maxItems: 5 }),
  scores: Type.Record(Type.String(), Type.Number()),
  note: Type.Optional(Type.String()),
  unit: Type.Optional(Type.String({ default: 'mm' })),
  color: Type.Union([Type.Literal('red'), Type.Literal('blue')]),
  shape: Shape,
  nested: Type.Object({ inner: Type.Object({ points: Type.Array(Type.Object({ x: Type.Number(), y: Type.Number() })) }) }),
}, { $id: 'Everything' });

const kit = createApiKit<null>();
const shapes = kit.namespace({
  name: 'shapes',
  methods: {
    roundTrip: kit.method({
      summary: 'Returns what it was given.',
      effect: 'read',
      params: { value: Everything },
      result: Everything,
      handler: ({ value }) => value,
    }),
    area: kit.method({
      summary: 'The area of a shape.',
      effect: 'read',
      params: { shape: Shape },
      result: Type.Number(),
      handler: ({ shape }) => shape.kind === 'circle' ? Math.PI * shape.radius ** 2 : shape.width * shape.height,
    }),
    positional: kit.method({
      summary: 'Reports which arguments arrived.',
      effect: 'read',
      params: {
        first: Type.String(),
        second: Type.Optional(Type.Integer({ default: 5 })),
        third: Type.Optional(Type.String()),
      },
      result: Type.Object({ first: Type.String(), second: Type.Integer(), third: Type.Union([Type.String(), Type.Null()]) }),
      handler: ({ first, second, third }) => ({ first, second: second ?? -1, third: third ?? null }),
    }),
    leaky: kit.method({
      summary: 'Returns more than it declares.',
      effect: 'read',
      result: Type.Object({ id: Type.String() }),
      handler: () => {
        const row = { id: 'a', passwordHash: 'x', internal: { path: '/srv' } };
        return row;
      },
    }),
    nothing: kit.method({
      summary: 'Returns nothing.',
      effect: 'read',
      handler: () => undefined,
    }),
  },
});

const sample = {
  text: 'hello',
  ratio: 0.5,
  count: 3,
  flag: true,
  nothing: null,
  list: [1, 2.5, -3],
  scores: { a: 1, 'with space': 2 },
  color: 'red',
  shape: { kind: 'rect', width: 2, height: 3 },
  nested: { inner: { points: [{ x: 1, y: 2 }] } },
};

let runtime: ScriptBoxRuntime<null>;
let session: Session<null>;

before(async () => {
  runtime = await createRuntime<null>({ apis: [shapes] });
  session = runtime.createSession({ context: null, capabilities: ['*'] });
});

after(async () => {
  await runtime.dispose();
});

async function call(source: string): Promise<unknown> {
  return completed(await session.execute({ language: 'javascript', source }));
}

/** Runs one call that should fail and returns the error's name and message as the script saw them. */
async function errorOf(expression: string): Promise<[string, string]> {
  const value = await call(`try { await ${expression}; return 'no error'; } catch (e) { return [e.name, e.message]; }`);
  const items: unknown = value;
  if (!Array.isArray(items)) {
    assert.fail(`expected an error, got ${JSON.stringify(value)}`);
  }
  const list: unknown[] = items;
  const name = list[0];
  const message = list[1];
  if (typeof name !== 'string' || typeof message !== 'string') {
    assert.fail(`expected a name and a message, got ${JSON.stringify(value)}`);
  }
  return [name, message];
}

describe('round trips (6)', () => {
  test('every supported shape survives the trip, an omitted optional stays omitted and a default is filled in', async () => {
    const value = await call(`return await shapes.roundTrip(${JSON.stringify(sample)});`);
    assert.deepEqual(value, { ...sample, unit: 'mm' });
  });

  test('the same script type-checks in TypeScript against the generated declarations', async () => {
    const value = completed(await session.execute({
      language: 'typescript',
      source: `const r = await shapes.roundTrip(${JSON.stringify(sample).replace('"rect"', '"rect" as const').replace('"red"', '"red" as const')});
const area: number = await shapes.area(r.shape);
return { area, unit: r.unit ?? null };`,
    }));
    assert.deepEqual(value, { area: 6, unit: 'mm' });
  });

  test('a discriminated union picks its branch by the discriminant', async () => {
    assert.equal(await call('return await shapes.area({ kind: "circle", radius: 1 });'), Math.PI);
    assert.equal(await call('return await shapes.area({ kind: "rect", width: 2, height: 4 });'), 8);
    assert.deepEqual(await errorOf('shapes.area({ kind: "triangle", side: 1 })'), ['InvalidArgumentsError', 'shapes.area argument 1 (shape).kind must be one of "circle", "rect".']);
    const [name] = await errorOf('shapes.area({ kind: "circle", width: 1, height: 1 })');
    assert.equal(name, 'InvalidArgumentsError');
  });

  test('an omitted argument takes its default; null is a value, not an omission', async () => {
    assert.deepEqual(await call('return await shapes.positional("a");'), { first: 'a', second: 5, third: null });
    assert.deepEqual(await call('return await shapes.positional("a", undefined, "c");'), { first: 'a', second: 5, third: 'c' });
    const [name, message] = await errorOf('shapes.positional("a", null)');
    assert.equal(name, 'InvalidArgumentsError');
    assert.match(message, /second\) must be an integer, not null/);
    assert.deepEqual(await errorOf('shapes.positional()'), ['InvalidArgumentsError', 'shapes.positional argument 1 (first) is required.']);
    assert.deepEqual(await errorOf('shapes.positional("a", 1, "c", "d")'), ['InvalidArgumentsError', 'shapes.positional takes at most 3 arguments, not 4.']);
  });

  test('a property set to undefined is omitted, like JSON', async () => {
    const value = await call(`const v = ${JSON.stringify(sample)}; v.note = undefined; return await shapes.roundTrip(v);`);
    assert.deepEqual(value, { ...sample, unit: 'mm' });
  });

  test('integer and range rules hold', async () => {
    for (const [count, pattern] of [[11, /at most 10/], [1.5, /integer/], [-1, /at least 0/]] as const) {
      const [name, message] = await errorOf(`shapes.roundTrip(${JSON.stringify({ ...sample, count })})`);
      assert.equal(name, 'InvalidArgumentsError');
      assert.match(message, pattern);
    }
  });

  test('an unknown field is refused, not ignored', async () => {
    const [name, message] = await errorOf(`shapes.roundTrip(${JSON.stringify({ ...sample, approved: true })})`);
    assert.equal(name, 'InvalidArgumentsError');
    assert.match(message, /approved is not a known property/);
  });

  test('a result keeps only its declared fields', async () => {
    assert.deepEqual(await call('return await shapes.leaky();'), { id: 'a' });
  });

  test('a void method resolves to undefined', async () => {
    assert.deepEqual(await call('const r = await shapes.nothing(); return [r === undefined, typeof r];'), [true, 'undefined']);
  });
});

describe('values without a JSON form (6)', () => {
  const cases: [string, string, RegExp][] = [
    ['NaN', 'NaN', /is NaN/],
    ['Infinity', 'Infinity', /is Infinity/],
    ['BigInt', '10n', /BigInt/],
    ['a function', '() => 1', /function/],
    ['a symbol', 'Symbol("s")', /symbol/],
    ['a Map', 'new Map()', /Map/],
    ['a Date', 'new Date(0)', /Date/],
    ['a class instance', 'new (class Point { constructor() { this.x = 1; } })()', /Point|plain/],
    ['a sparse array', '[1, , 3]', /hole|undefined/],
    ['undefined in an array', '[1, undefined]', /undefined/],
  ];
  for (const [what, expression, pattern] of cases) {
    test(`an argument holding ${what} is refused before it is sent`, async () => {
      const [name, message] = await errorOf(`shapes.roundTrip({ ...${JSON.stringify(sample)}, scores: { a: ${expression} } })`);
      assert.equal(name, 'TypeError');
      assert.match(message, pattern);
    });
  }

  test('a cycle is refused with its path', async () => {
    const [name, message] = await errorOf('(() => { const s = { a: 1 }; s.self = s; return shapes.roundTrip({ scores: s }); })()');
    assert.equal(name, 'TypeError');
    assert.match(message, /refers back/);
  });

  test('nesting deeper than the limit is refused', async () => {
    const [name, message] = await errorOf('(() => { let v = 1; for (let i = 0; i < 70; i++) v = { v }; return shapes.roundTrip(v); })()');
    assert.equal(name, 'RangeError');
    assert.match(message, /deeper than 64/);
  });

  test('no host call is made for a refused value', async () => {
    const outcome = await session.execute({ language: 'javascript', source: 'try { await shapes.area({ kind: "circle", radius: NaN }); } catch { } return 1;' });
    completed(outcome);
    assert.equal(outcome.evidence.counters.callAttempts, 0);
  });

  test('a result without a JSON form fails the execution', async () => {
    for (const [expression, pattern] of [['NaN', /NaN/], ['new Date()', /Date/], ['(() => { const a = {}; a.a = a; return a; })()', /refers back/], ['1n', /BigInt/]] as const) {
      const error = failed(await session.execute({ language: 'javascript', source: `return ${expression};` }));
      assert.equal(error.code, 'invalid-result', expression);
      assert.match(error.message, pattern);
    }
  });

  test('a returned object drops undefined properties, and undefined alone is no value', async () => {
    assert.deepEqual(await call('return { a: 1, b: undefined };'), { a: 1 });
    const outcome = await session.execute({ language: 'javascript', source: 'const x = 1;' });
    assert.ok(outcome.status === 'completed');
    assert.equal(outcome.value, null);
    assert.equal(outcome.hasValue, false);
    const nullOutcome = await session.execute({ language: 'javascript', source: 'return null;' });
    assert.ok(nullOutcome.status === 'completed');
    assert.equal(nullOutcome.hasValue, true);
  });
});

describe('unhandled rejections (6)', () => {
  test('a rejection nothing handles fails the execution, even after the script returned', async () => {
    const error = failed(await session.execute({ language: 'javascript', source: 'Promise.reject(new RangeError("lost")); return 1;' }));
    assert.equal(error.code, 'unhandled-rejection');
    assert.equal(error.name, 'RangeError');
    assert.match(error.message, /lost/);
  });

  test('a rejection handled later in the same job is not reported', async () => {
    assert.equal(await call('const p = Promise.reject(new Error("x")); await null; try { await p; } catch { return "handled"; }'), 'handled');
  });

  test('awaiting something nothing can settle ends with never-settled', async () => {
    const error = failed(await session.execute({ language: 'javascript', source: 'await new Promise(() => {});' }));
    assert.equal(error.code, 'never-settled');
  });
});

describe('result sealing', () => {
  test('without sealing a script gets its own mutable copy; with sealing, as in .NET, objects are sealed and arrays stay growable', async () => {
    const mutable = await call('const r = await shapes.leaky(); r.id = "changed"; r.extra = 1; return [r, Object.isFrozen(r)];');
    assert.deepEqual(mutable, [{ id: 'changed', extra: 1 }, false]);

    const sealed = await createRuntime<null>({ apis: [shapes], sealResults: true });
    try {
      const s = sealed.createSession({ context: null, capabilities: ['*'] });
      const value = completed(await s.execute({
        language: 'javascript',
        source: 'const r = await shapes.roundTrip(' + JSON.stringify(sample) + ');'
          + ' r.text = "changed"; r.list.push(9);'
          + ' const sealed = [Object.isSealed(r), Object.isSealed(r.nested.inner.points[0]), Object.isFrozen(r)];'
          + ' try { r.txet = "typo"; return "added"; } catch (e) { return [e.name, sealed, r.text, r.list.length]; }',
      }));
      assert.deepEqual(value, ['TypeError', [true, true, false], 'changed', 4]);
    } finally {
      await sealed.dispose();
    }
  });
});
