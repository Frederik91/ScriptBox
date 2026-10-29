// A consumer of the packed package: strict TypeScript, no casts, no `any`.
// It defines an API, runs a JavaScript and a TypeScript script, and checks
// the outcomes. scripts/package-test.ts runs it in a clean Node 24 container
// with the network off, from a directory unrelated to the package.
import assert from 'node:assert/strict';
import {
  createApiKit,
  createRuntime,
  Type,
  versions,
  type ExecutionOutcome,
  type HostCallFilter,
  type JsonValue,
  type Static,
} from '@frederik91/scriptbox';

const Note = Type.Object({ id: Type.String(), text: Type.String({ maxLength: 200 }) }, { $id: 'Note' });
type Note = Static<typeof Note>;

interface RequestState {
  readonly notes: Map<string, Note>;
}

const api = createApiKit<RequestState>();
const notes = api.namespace({
  name: 'notes',
  description: 'Reads and adds notes in this request.',
  methods: {
    get: api.method({
      summary: 'Gets a note by id.',
      effect: 'read',
      params: { id: Type.String() },
      result: Type.Union([Note, Type.Null()]),
      handler: ({ id }, call) => call.context.notes.get(id) ?? null,
    }),
    add: api.method({
      summary: 'Adds a note.',
      effect: 'draft-write',
      params: { text: Type.String({ maxLength: 200 }) },
      result: Note,
      handler: async ({ text }, call) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        call.throwIfRevoked();
        const note: Note = { id: `n${call.context.notes.size + 1}`, text };
        call.context.notes.set(note.id, note);
        return note;
      },
    }),
  },
});

let uniqueDispatches = 0;
const UniqueValues = Type.Array(Type.Unsafe<JsonValue>({}), { uniqueItems: true, maxItems: 1024 });
const sets = api.namespace({ name: 'sets', methods: {
  echo: api.method({ summary: 'Returns unique JSON values.', effect: 'read', params: { values: UniqueValues }, result: UniqueValues,
    handler: ({ values }) => { uniqueDispatches++; return values; } }),
  selectors: api.method({ summary: 'Returns unique classes and categories.', effect: 'read', params: {
    classes: Type.Array(Type.String(), { uniqueItems: true }), categories: Type.Array(Type.String(), { uniqueItems: true }),
  }, result: Type.Boolean(), handler: () => { uniqueDispatches++; return true; } }),
  bad: api.method({ summary: 'Breaks its result contract.', effect: 'read', result: UniqueValues,
    handler: () => { uniqueDispatches++; return [{ a: 1, b: [2] }, { b: [2], a: 1 }]; } }),
  projected: api.method({ summary: 'Refuses duplicate public result objects.', effect: 'read', result: Type.Array(Type.Object({ id: Type.String() }), { uniqueItems: true }),
    handler: () => { uniqueDispatches++; return [{ id: 'x', private: 1 }, { id: 'x', private: 2 }]; } }),
  closed: api.method({ summary: 'Refuses extra input keys.', effect: 'read', params: { values: Type.Array(Type.Object({ id: Type.String() }), { uniqueItems: true }) },
    result: Type.Boolean(), handler: () => { uniqueDispatches++; return true; } }),
  loose: api.method({ summary: 'Allows repeats.', effect: 'read', params: { values: Type.Array(Type.Number(), { uniqueItems: false }) },
    result: Type.Array(Type.Number()), handler: ({ values }) => values }),
} });

const audit: string[] = [];
const recordCalls: HostCallFilter<RequestState> = async (call, next) => {
  audit.push(call.method.qualifiedName);
  return next();
};

function describeOutcome(outcome: ExecutionOutcome): string {
  switch (outcome.status) {
    case 'completed':
      return JSON.stringify(outcome.value);
    case 'failed':
      return `${outcome.error.code}: ${outcome.error.message}`;
    case 'resource-limit':
      return `${outcome.limit}: ${outcome.detail}`;
    case 'cancelled':
    case 'timed-out':
      return outcome.status;
  }
}

const runtime = await createRuntime<RequestState>({ apis: [notes, sets], filters: [recordCalls] });
try {
  const state: RequestState = { notes: new Map() };
  const session = runtime.createSession({ context: state, capabilities: ['notes.*', 'sets.*', 'docs.*'] });

  const js = await session.execute({ language: 'javascript', source: 'const n = await notes.add("hello"); return (await notes.get(n.id)).text;' });
  assert.equal(js.status, 'completed', describeOutcome(js));
  assert.equal(js.status === 'completed' ? js.value : null, 'hello');

  const ts = await session.execute({ language: 'typescript', source: 'const n = await notes.get("n1");\nreturn n === null ? 0 : n.text.length;' });
  assert.equal(describeOutcome(ts), '5');

  const typeError = await session.execute({ language: 'typescript', source: 'const n = await notes.get(1);' });
  assert.ok(typeError.status === 'failed' && typeError.error.code === 'type-check', describeOutcome(typeError));

  assert.deepEqual(audit, ['notes.add', 'notes.get', 'notes.get']);
  assert.match(runtime.getTypeScriptDeclarations(), /get\(id: string\): Promise<Note \| null>;/);
  for (const language of ['javascript', 'typescript'] as const) {
    const valid = await session.execute({ language, source: 'return await sets.echo([null,false,0,"0",[1,2],[2,1],{a:1}]);' });
    assert.equal(valid.status, 'completed', describeOutcome(valid));
    assert.deepEqual(valid.status === 'completed' ? valid.value : null, [null, false, 0, '0', [1, 2], [2, 1], { a: 1 }]);
    for (const expression of ['sets.echo([1,1])', 'sets.echo([0,-0])', 'sets.echo([{points:[[-0,1]]},{points:[[0,1.0]]}])', 'sets.echo([{a:[1,{x:2,y:3}]},{a:[1,{y:3,x:2}]}])',
      'sets.echo([[1,2],[1,2]])', 'sets.selectors(["IfcWall","IfcWall"],["wall"])', 'sets.selectors(["IfcWall"],["wall","wall"])']) {
      const before = uniqueDispatches;
      const outcome = await session.execute({ language, source: `try { await ${expression}; return "accepted"; } catch { return "rejected"; }` });
      assert.equal(describeOutcome(outcome), '"rejected"', expression);
      assert.equal(uniqueDispatches, before);
      assert.deepEqual(outcome.evidence.calls.map(call => [call.disposition, call.handlerRan]), [['invalid-arguments', false]]);
    }
    for (const expression of ['sets.bad()', 'sets.projected()']) {
      const bad = await session.execute({ language, source: `try { await ${expression}; return "accepted"; } catch { return "rejected"; }` });
      assert.equal(describeOutcome(bad), '"rejected"');
      assert.deepEqual(bad.evidence.calls.map(call => [call.disposition, call.handlerRan]), [['invalid-result', true]]);
    }
    const beforeExtra = uniqueDispatches;
    const extra = await session.execute({ language, source: 'const values = [{id:"x",private:1}]; try { await sets.closed(values); return "accepted"; } catch { return "rejected"; }' });
    assert.equal(describeOutcome(extra), '"rejected"'); assert.equal(uniqueDispatches, beforeExtra);
    assert.deepEqual(extra.evidence.calls.map(call => [call.disposition, call.handlerRan]), [['invalid-arguments', false]]);
    const loose = await session.execute({ language, source: 'return await sets.loose([1,1]);' });
    assert.equal(describeOutcome(loose), '[1,1]');
    const before = uniqueDispatches;
    const limited = await session.execute({ language, source: 'try { await sets.echo(["x".repeat(2048)]); return "accepted"; } catch { return "rejected"; }', limits: { messageBytes: 1024 } });
    assert.equal(describeOutcome(limited), '"rejected"'); assert.equal(uniqueDispatches, before);
    const tooMany = await session.execute({ language, source: 'try { await sets.echo(Array.from({length:1025}, (_,i) => i)); return "accepted"; } catch { return "rejected"; }' });
    assert.equal(describeOutcome(tooMany), '"rejected"'); assert.equal(uniqueDispatches, before);
    assert.deepEqual(tooMany.evidence.calls.map(call => [call.disposition, call.handlerRan]), [['invalid-arguments', false]]);
    const declaration = language === 'typescript' ? 'let value: JsonValue = {};' : 'let value = {};';
    const deep = await session.execute({ language, source: declaration + ' for (let i=0;i<70;i++) value = {child:value}; try { await sets.echo([value]); return "accepted"; } catch { return "rejected"; }' });
    assert.equal(describeOutcome(deep), '"rejected"'); assert.equal(uniqueDispatches, before); assert.equal(deep.evidence.counters.callAttempts, 0);
  }
  const echo = runtime.contract.namespaces.flatMap(namespace => namespace.methods).find(method => method.qualifiedName === 'sets.echo');
  assert.ok(echo); assert.match(JSON.stringify(echo.params[0]?.schema), /"uniqueItems":true/); assert.match(JSON.stringify(echo.result), /"uniqueItems":true/);
  assert.match(runtime.getTypeScriptDeclarations(), /Items must be unique \(JSON structural equality\)/);
  const docs = await session.execute({ language: 'javascript', source: 'return (await docs.read(["/api/sets/echo.d.ts"]))[0].content;' });
  assert.equal(docs.status, 'completed', describeOutcome(docs));
  assert.match(describeOutcome(docs), /Items must be unique/);
  console.log(JSON.stringify({
    node: process.versions.node,
    platform: `${process.platform}-${process.arch}`,
    package: versions.packageVersion,
    artifact: versions.artifact.sha256.slice(0, 12),
    js: describeOutcome(js),
    ts: describeOutcome(ts),
    cwd: process.cwd(),
  }));
} finally {
  await runtime.dispose();
}
