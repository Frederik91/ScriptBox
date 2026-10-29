import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createApiKit, createRuntime, Type, type JsonValue } from '@frederik91/scriptbox';
import { compileSchema, invalid, OutputTooLargeError, projectOutput, validateInput, type Issue } from '../src/schema.ts';
import { parseBoundedJson } from '../src/json.ts';
import { completed } from './helpers.ts';

const uniqueJson = { type: 'array', items: {}, uniqueItems: true };
function check(value: unknown, schema: unknown = uniqueJson) {
  const issues: Issue[] = [];
  return { value: validateInput(compileSchema(schema, 'values'), value, 'values', issues), issues };
}

describe('uniqueItems compilation and JSON equality', () => {
  test('only boolean array configuration is admitted; other unsupported keywords still fail', () => {
    for (const uniqueItems of [null, 0, 1, 'true', [], {}, undefined]) {
      assert.throws(() => compileSchema({ ...uniqueJson, uniqueItems }, 'values'), /values: uniqueItems must be a boolean/);
    }
    assert.throws(() => compileSchema({ ...uniqueJson, contains: {} }, 'values'), /keyword 'contains'.*not supported/);
    assert.throws(() => compileSchema({ type: 'string', uniqueItems: true }, 'values'), /keyword 'uniqueItems'.*not supported/);
    assert.throws(() => compileSchema({ ...uniqueJson, default: [1, 1] }, 'values'), /default does not match.*unique/);
  });

  test('JSON primitive types stay distinct, except equal numeric values including signed zero', () => {
    const value = [null, false, true, 0, 1, '0', '1', '', 'null'];
    assert.deepEqual(check(value).value, value);
    for (const value of [[0, -0], [1, 1.0], [null, null], [true, true], ['a', 'a']]) {
      const result = check(value);
      assert.equal(result.value, invalid);
      assert.match(result.issues[0]?.message ?? '', /values\[1\].*unique/);
    }
    assert.deepEqual(check(['é', 'e\u0301']).value, ['é', 'e\u0301']);
  });

  test('nested object key ordering is irrelevant, array ordering and key names are significant', () => {
    const duplicates = [{ a: [1, { x: null, y: false }], b: 'x' }, { b: 'x', a: [1, { y: false, x: null }] }];
    assert.equal(check(duplicates).value, invalid);
    const different = [[1, 2], [2, 1], { a: 1 }, { b: 1 }, {}, [], { 'a,b': [1, 2] }, { a: ['b', 1, 2] }];
    assert.deepEqual(check(different).value, different);
    assert.equal(check([[1, [2, 3]], [1, [2, 3]]]).value, invalid);
    assert.equal(check([{ points: [[-0, 1]] }, { points: [[0, 1.0]] }]).value, invalid);
  });

  test('false and omission retain duplicates, nested unique arrays still enforce their own contract', () => {
    for (const schema of [{ type: 'array', items: {} }, { ...uniqueJson, uniqueItems: false }]) {
      assert.deepEqual(check([1, 1], schema).value, [1, 1]);
      assert.deepEqual(projectOutput(compileSchema(schema, 'values'), [1, 1], 'result', [], 1024), [1, 1]);
    }
    const schema = { type: 'array', items: { type: 'array', items: { type: 'number' }, uniqueItems: true } };
    assert.equal(check([[1, 1]], schema).value, invalid);
    assert.deepEqual(check([[1, 2], [1, 2]], schema).value, [[1, 2], [1, 2]]);
  });

  test('uniqueness checks bound defaults and projected results rather than hidden host properties', () => {
    const schema = { type: 'array', uniqueItems: true,
      items: { type: 'object', properties: { x: { type: 'number', default: 0 } } } };
    assert.equal(check([{}, { x: 0 }], schema).value, invalid);
    const resultSchema = compileSchema(Type.Array(Type.Object({ id: Type.String() }), { uniqueItems: true }), 'result');
    const issues: Issue[] = [];
    assert.equal(projectOutput(resultSchema, [{ id: 'x', secret: 1 }, { id: 'x', secret: 2 }], 'result', issues, 1024), invalid);
    assert.match(issues[0]?.message ?? '', /result\[1\].*unique/);
  });

  test('existing item, output-byte and JSON-depth limits still bound work', () => {
    const schema = { ...uniqueJson, maxItems: 2 };
    assert.match(check([1, 2, 3], schema).issues[0]?.message ?? '', /at most 2 items/);
    assert.throws(() => projectOutput(compileSchema(uniqueJson, 'result'), ['x'.repeat(2048)], 'result', [], 1024), OutputTooLargeError);
    assert.throws(() => parseBoundedJson(JSON.stringify(['x'.repeat(2048)]), 1024, 64), /larger/);
    assert.throws(() => parseBoundedJson('['.repeat(66) + '0' + ']'.repeat(66), 4096, 64), /deeper/);
    const values = Array.from({ length: 2048 }, (_, id) => ({ prefix: [1, 2, { stable: true }], id }));
    assert.deepEqual(check(values).value, values);
    const last = values[2047]; assert.ok(last);
    assert.equal(check([...values, { id: last.id, prefix: [1, 2, { stable: true }] }]).value, invalid);
    const inner = { type: 'array', items: { type: 'number' }, uniqueItems: true };
    const nested = { type: 'array', items: inner, uniqueItems: true };
    assert.deepEqual(check([[1, 2], [2, 1]], nested).value, [[1, 2], [2, 1]]);
    assert.equal(check([[1, 2], [1, 2]], nested).value, invalid);
  });
});

describe('uniqueItems on real JS and TS guest calls', () => {
  test('public registration refuses nonboolean uniqueness and unrelated unsupported keywords', () => {
    const kit = createApiKit<null>();
    for (const uniqueItems of [null, 1, 'true', [], {}]) {
      assert.throws(() => kit.namespace({ name: 'sets', methods: {
        echo: kit.method({ summary: 'Invalid contract.', effect: 'read',
          params: { values: Type.Unsafe<JsonValue>({ type: 'array', items: {}, uniqueItems }) }, handler: () => undefined }),
      } }), /uniqueItems must be a boolean/);
    }
    assert.throws(() => kit.namespace({ name: 'sets', methods: {
      echo: kit.method({ summary: 'Invalid contract.', effect: 'read',
        params: { values: Type.Unsafe<JsonValue>({ type: 'array', items: {}, uniqueItems: true, contains: {} }) }, handler: () => undefined }),
    } }), /keyword 'contains'.*not supported/);
  });

  test('one named type cannot describe conflicting uniqueness rules', async () => {
    const kit = createApiKit<null>();
    const apis = kit.namespace({ name: 'sets', methods: {
      strict: kit.method({ summary: 'Unique items.', effect: 'read', result: Type.Array(Type.Number(), { $id: 'Values', uniqueItems: true }), handler: () => [1] }),
      loose: kit.method({ summary: 'Repeated items.', effect: 'read', result: Type.Array(Type.Number(), { $id: 'Values', uniqueItems: false }), handler: () => [1, 1] }),
    } });
    await assert.rejects(createRuntime<null>({ apis: [apis] }), /Values/);
  });

  test('duplicates never reach handlers; results, docs, schemas, filters and limits use the same contract', async () => {
    const calls: string[] = [];
    const kit = createApiKit<null>();
    const values = Type.Array(Type.Unsafe<JsonValue>({}), { uniqueItems: true, maxItems: 4096 });
    const selectors = Type.Object({
      classes: Type.Array(Type.String(), { uniqueItems: true, maxItems: 16 }),
      categories: Type.Array(Type.Union([Type.Literal('wall'), Type.Literal('space')]), { uniqueItems: true, maxItems: 16 }),
    });
    const sets = kit.namespace({ name: 'sets', methods: {
      echo: kit.method({ summary: 'Returns unique JSON items.', effect: 'read', params: { values }, result: values,
        handler: ({ values }) => { calls.push('echo'); return values; } }),
      select: kit.method({ summary: 'Reads class and category sets.', effect: 'read', params: { query: selectors }, result: selectors,
        handler: ({ query }) => { calls.push('select'); return query; } }),
      bad: kit.method({ summary: 'Returns duplicate projected items.', effect: 'read', result: Type.Array(Type.Object({ id: Type.String() }), { uniqueItems: true }),
        handler: () => { calls.push('bad'); return [{ id: 'x', private: 1 }, { id: 'x', private: 2 }]; } }),
      closed: kit.method({ summary: 'Refuses unknown input fields.', effect: 'read', params: { values: Type.Array(Type.Object({ id: Type.String() }), { uniqueItems: true }) },
        result: Type.Boolean(), handler: () => { calls.push('closed'); return true; } }),
      loose: kit.method({ summary: 'Allows repeated items.', effect: 'read', params: { values: Type.Array(Type.Number(), { uniqueItems: false }) },
        result: Type.Array(Type.Number()), handler: ({ values }) => { calls.push('loose'); return values; } }),
    } });
    const runtime = await createRuntime<null>({ apis: [sets] });
    try {
      const session = runtime.createSession({ context: null, capabilities: ['sets.*', 'docs.*'] });
      for (const language of ['javascript', 'typescript'] as const) {
        assert.deepEqual(completed(await session.execute({ language, source: 'return await sets.echo([null, false, 0, "0", [1,2], [2,1], {a:1}]);' })),
          [null, false, 0, '0', [1, 2], [2, 1], { a: 1 }]);
        assert.deepEqual(completed(await session.execute({ language, source: 'return await sets.select({classes:["IfcWall","IfcDoor"],categories:["wall","space"]});' })),
          { classes: ['IfcWall', 'IfcDoor'], categories: ['wall', 'space'] });
        for (const expression of ['sets.echo([1,1])', 'sets.echo([0,-0])', 'sets.echo([{points:[[-0,1]]},{points:[[0,1.0]]}])', 'sets.echo([{a:[1,{x:2,y:3}]},{a:[1,{y:3,x:2}]}])',
          'sets.echo([[1,2],[1,2]])', 'sets.select({classes:["IfcWall","IfcWall"],categories:["wall"]})',
          'sets.select({classes:["IfcWall"],categories:["wall","wall"]})']) {
          const before = calls.length;
          const outcome = await session.execute({ language, source: `try { await ${expression}; return "accepted"; } catch { return "rejected"; }` });
          assert.equal(completed(outcome), 'rejected', expression);
          assert.equal(calls.length, before, 'duplicate input never invokes a handler');
          assert.deepEqual(outcome.evidence.calls.map(call => [call.disposition, call.handlerRan]), [['invalid-arguments', false]]);
        }
        const beforeExtra = calls.length;
        const extra = await session.execute({ language, source: 'const values = [{id:"x",private:1}]; try { await sets.closed(values); return "accepted"; } catch { return "rejected"; }' });
        assert.equal(completed(extra), 'rejected'); assert.equal(calls.length, beforeExtra);
        assert.deepEqual(extra.evidence.calls.map(call => [call.disposition, call.handlerRan]), [['invalid-arguments', false]]);
        const bad = await session.execute({ language, source: 'try { await sets.bad(); return "accepted"; } catch { return "rejected"; }' });
        assert.equal(completed(bad), 'rejected');
        assert.deepEqual(bad.evidence.calls.map(call => [call.disposition, call.handlerRan]), [['invalid-result', true]]);
        assert.deepEqual(completed(await session.execute({ language, source: 'return await sets.loose([1,1]);' })), [1, 1]);
        const oversized = await session.execute({ language, source: 'try { await sets.echo(["x".repeat(2048)]); return "accepted"; } catch { return "rejected"; }', limits: { messageBytes: 1024 } });
        assert.equal(completed(oversized), 'rejected');
        assert.equal(oversized.evidence.calls.some(call => call.handlerRan), false);
        const beforeLimit = calls.length;
        const tooMany = await session.execute({ language, source: 'try { await sets.echo(Array.from({length:4097}, (_,i) => i)); return "accepted"; } catch { return "rejected"; }' });
        assert.equal(completed(tooMany), 'rejected'); assert.equal(calls.length, beforeLimit);
        assert.deepEqual(tooMany.evidence.calls.map(call => [call.disposition, call.handlerRan]), [['invalid-arguments', false]]);
        const declaration = language === 'typescript' ? 'let value: JsonValue = {};' : 'let value = {};';
        const deep = await session.execute({ language, source: declaration + ' for (let i=0;i<70;i++) value = {child:value}; try { await sets.echo([value]); return "accepted"; } catch { return "rejected"; }' });
        assert.equal(completed(deep), 'rejected'); assert.equal(calls.length, beforeLimit); assert.equal(deep.evidence.counters.callAttempts, 0);
      }
      const method = runtime.contract.namespaces.flatMap(ns => ns.methods).find(method => method.name === 'echo');
      assert.ok(method);
      assert.match(JSON.stringify(method.params[0]?.schema), /"uniqueItems":true/);
      assert.match(JSON.stringify(method.result), /"uniqueItems":true/);
      assert.match(runtime.getTypeScriptDeclarations(), /Items must be unique \(JSON structural equality\)/);
      const docs = completed(await session.execute({ language: 'javascript', source: 'return (await docs.read(["/api/sets/echo.d.ts"]))[0].content;' }));
      assert.ok(typeof docs === 'string');
      assert.match(docs, /Items must be unique/);
      const replaced = runtime.createSession({ context: null, capabilities: ['sets.*'], filters: [() => [1, 1]] });
      const before = calls.length;
      const outcome = await replaced.execute({ language: 'javascript', source: 'try { await sets.echo([1,2]); return "accepted"; } catch { return "rejected"; }' });
      assert.equal(completed(outcome), 'rejected'); assert.equal(calls.length, before);
      assert.deepEqual(outcome.evidence.calls.map(call => [call.disposition, call.handlerRan]), [['invalid-result', false]]);
    } finally {
      await runtime.dispose();
    }
  });
});
