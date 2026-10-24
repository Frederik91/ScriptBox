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

const runtime = await createRuntime<RequestState>({ apis: [notes], filters: [recordCalls] });
try {
  const state: RequestState = { notes: new Map() };
  const session = runtime.createSession({ context: state, capabilities: ['notes.*'] });

  const js = await session.execute({ language: 'javascript', source: 'const n = await notes.add("hello"); return (await notes.get(n.id)).text;' });
  assert.equal(js.status, 'completed', describeOutcome(js));
  assert.equal(js.status === 'completed' ? js.value : null, 'hello');

  const ts = await session.execute({ language: 'typescript', source: 'const n = await notes.get("n1");\nreturn n === null ? 0 : n.text.length;' });
  assert.equal(describeOutcome(ts), '5');

  const typeError = await session.execute({ language: 'typescript', source: 'const n = await notes.get(1);' });
  assert.ok(typeError.status === 'failed' && typeError.error.code === 'type-check', describeOutcome(typeError));

  assert.deepEqual(audit, ['notes.add', 'notes.get', 'notes.get']);
  assert.match(runtime.getTypeScriptDeclarations(), /get\(id: string\): Promise<Note \| null>;/);
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
