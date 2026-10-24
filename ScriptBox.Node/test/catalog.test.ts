// Acceptance 23 to 27: the transactional-draft example. The application owns
// the draft, its validation and acceptance; the script only reads and stages.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createApiKit, createRuntime, type HostCall, type ScriptBoxRuntime } from '@frederik91/scriptbox';
import { CatalogApplication, CatalogStore, createCatalogApis, Draft, sampleItems, type RequestState } from '../examples/catalog/app.ts';
import { completed, failed } from './helpers.ts';

let runtime: ScriptBoxRuntime<RequestState>;

before(async () => {
  runtime = await createRuntime<RequestState>({ apis: createCatalogApis({ delayMs: 20 }) });
});

after(async () => {
  await runtime.dispose();
});

function newApp(): CatalogApplication {
  return new CatalogApplication(runtime, new CatalogStore(sampleItems()));
}

describe('staged changes (23)', () => {
  test('renames and creates are visible in the draft, not in the accepted catalog, and summarized', async () => {
    const app = newApp();
    const result = await app.handle('r1', 'typescript', `
await draft.rename({ id: 'desk-2', name: 'Corner desk, oak' });
const lamp = await draft.create({ name: 'Floor lamp', kind: 'lamp' });
const seen = await catalog.get({ id: lamp.id });
const page = await catalog.list({ limit: 10 });
return { seen: seen.name, ids: page.items.map((i) => i.id), summary: await draft.summary() };`);
    const value = completed(result.outcome);
    assert.deepEqual(value, {
      seen: 'Floor lamp',
      ids: ['chair-1', 'desk-1', 'desk-2', 'lamp-1', 'new-1-1'],
      summary: {
        baseRevision: 1,
        added: [{ id: 'new-1-1', name: 'Floor lamp', kind: 'lamp' }],
        modified: [{ id: 'desk-2', before: { id: 'desk-2', name: 'Corner desk', kind: 'desk' }, after: { id: 'desk-2', name: 'Corner desk, oak', kind: 'desk' } }],
        removed: [],
      },
    });
    assert.equal(app.store.snapshot().items.get('desk-2')?.name, 'Corner desk');
    assert.equal(app.store.snapshot().items.has('new-1-1'), false);
    assert.equal(result.proposal?.summary.added.length, 1);
  });

  test('pages are stable and bounded, and a script cannot widen its scope with arguments', async () => {
    const app = newApp();
    const result = await app.handle('r1', 'javascript', `
const pages = [];
let cursor;
do {
  const page = await catalog.list({ cursor, limit: 2 });
  pages.push(page.items.map((i) => i.id));
  cursor = page.nextCursor ?? undefined;
} while (cursor !== undefined);
let wide;
try { await catalog.list({ limit: 1000 }); } catch (e) { wide = e.name; }
let scoped;
try { await catalog.list({ limit: 2, projectId: 'other' }); } catch (e) { scoped = e.name; }
return { pages, wide, scoped };`);
    assert.deepEqual(completed(result.outcome), { pages: [['chair-1', 'desk-1'], ['desk-2', 'lamp-1']], wide: 'InvalidArgumentsError', scoped: 'InvalidArgumentsError' });
  });

  test('a caught business error can be repaired, and a failed write leaves nothing behind', async () => {
    const app = newApp();
    const result = await app.handle('r1', 'javascript', `
try { await draft.rename({ id: 'desk-1', name: 'Office chair' }); } catch (e) { console.log(e.name); }
await draft.rename({ id: 'desk-1', name: 'Office desk' });
return (await draft.summary()).modified.map((m) => m.after.name);`);
    assert.deepEqual(completed(result.outcome), ['Office desk']);
    assert.deepEqual(result.outcome.logs.map((l) => l.text), ['ConflictError']);
  });
});

describe('discarded drafts (24)', () => {
  const failures: [string, string, Partial<{ timeoutMs: number }>, boolean][] = [
    ['an uncaught error', 'await draft.rename({ id: "desk-1", name: "Gone" }); throw new Error("script bug");', {}, false],
    ['a timeout', 'await draft.rename({ id: "desk-1", name: "Gone" }); for (;;) {}', { timeoutMs: 400 }, false],
    ['a cancellation', 'await draft.rename({ id: "desk-1", name: "Gone" }); for (;;) {}', {}, true],
    ['a result with no JSON form', 'await draft.rename({ id: "desk-1", name: "Gone" }); return NaN;', {}, false],
    ['failed validation', 'await draft.rename({ id: "desk-1", name: " Gone " }); return "ok";', {}, false],
  ];
  for (const [what, source, limits, cancel] of failures) {
    test(`a write followed by ${what} leaves the accepted catalog unchanged and discards the draft`, async () => {
      const app = newApp();
      const controller = new AbortController();
      if (cancel) {
        setTimeout(() => {
          controller.abort();
        }, 200);
      }
      const result = await app.handle('r1', 'javascript', source, { signal: controller.signal, limits });
      assert.equal(result.proposal, undefined);
      assert.ok(result.draft.isDiscarded);
      assert.deepEqual(result.draft.summary().modified, []);
      assert.equal(app.store.snapshot().items.get('desk-1')?.name, 'Standing desk');
      assert.equal(app.store.snapshot().revision, 1);
      assert.equal(app.inbox.size, 0);
    });
  }
});

describe('retries (25)', () => {
  test('a retry starts clean, creates the item once and files one proposal', async () => {
    const app = newApp();
    const source = (fail: boolean): string => `
const lamp = await draft.create({ name: 'Desk lamp, brass', kind: 'lamp' });
${fail ? 'throw new Error("network blip");' : ''}
return lamp.id;`;
    const first = await app.handle('request-7', 'javascript', source(true));
    assert.equal(failed(first.outcome).message, 'network blip');
    const second = await app.handle('request-7', 'javascript', source(false));
    assert.equal(completed(second.outcome), 'new-1-1');
    assert.equal(second.proposal?.summary.added.length, 1);
    // The application crashes before marking the request done and runs it again: still one proposal.
    const third = await app.handle('request-7', 'javascript', source(false));
    assert.equal(third.proposal, second.proposal);
    assert.equal(app.inbox.size, 1);
  });

  test('a call\'s authority ends with its execution and cannot be reused', async () => {
    // A handler is trusted code; this one keeps its call the way buggy application code might.
    const kept: HostCall<RequestState>[] = [];
    const kit = createApiKit<RequestState>();
    const leaky = kit.namespace({
      name: 'leaky',
      methods: {
        keep: kit.method({
          summary: 'Keeps its call.',
          effect: 'read',
          handler: (_args, call) => {
            kept.push(call);
          },
        }),
      },
    });
    const local = await createRuntime<RequestState>({ apis: [...createCatalogApis(), leaky] });
    try {
      const draft = new Draft(new CatalogStore(sampleItems()).snapshot());
      const session = local.createSession({ context: { draft }, capabilities: ['*'] });
      completed(await session.execute({ language: 'javascript', source: 'await leaky.keep(); return 1;' }));
      const [stale] = kept;
      assert.ok(stale !== undefined);
      assert.equal(stale.signal.aborted, true);
      assert.throws(() => draft.rename('desk-1', 'Stolen', stale), { name: 'ScriptApiError', code: 'revoked' });
      assert.equal(draft.get('desk-1')?.name, 'Standing desk');
    } finally {
      await local.dispose();
    }
  });
});

describe('acceptance stays with the application (26)', () => {
  test('a proposal made against an older revision is refused', async () => {
    const app = newApp();
    const a = await app.handle('a', 'javascript', 'await draft.rename({ id: "desk-1", name: "First" }); return 1;');
    const b = await app.handle('b', 'javascript', 'await draft.rename({ id: "lamp-1", name: "Second" }); return 1;');
    assert.ok(a.proposal !== undefined && b.proposal !== undefined);
    assert.deepEqual(app.store.accept(a.proposal), { accepted: true, revision: 2 });
    assert.deepEqual(app.store.accept(b.proposal), { accepted: false, reason: 'stale-base', currentRevision: 2 });
    assert.equal(app.store.snapshot().items.get('lamp-1')?.name, 'Desk lamp');
    // Rerunning against the new revision is the application's explicit rebase.
    const rebased = await app.handle('b-2', 'javascript', 'await draft.rename({ id: "lamp-1", name: "Second" }); return 1;');
    assert.ok(rebased.proposal !== undefined);
    assert.equal(rebased.proposal.baseRevision, 2);
    assert.deepEqual(app.store.accept(rebased.proposal), { accepted: true, revision: 3 });
  });

  test('the script API has no way to accept, commit or approve', async () => {
    const names = runtime.contract.namespaces.flatMap((ns) => ns.methods.map((m) => m.qualifiedName));
    assert.deepEqual(names, ['catalog.get', 'catalog.list', 'draft.rename', 'draft.create', 'draft.summary', 'docs.ls', 'docs.read', 'docs.grep', 'docs.search']);
    assert.ok(names.every((name) => !/accept|approve|commit|apply|publish/i.test(name)));
    const app = newApp();
    const result = await app.handle('r', 'javascript', `
const out = [];
for (const name of ['draft.accept', 'draft.commit', 'catalog.approve', 'store.accept']) {
  try { await __scriptbox.hostCall(name, []); out.push('called'); } catch (e) { out.push(e.name); }
}
return out;`);
    assert.deepEqual(completed(result.outcome), ['UnknownMethodError', 'UnknownMethodError', 'UnknownMethodError', 'UnknownMethodError']);
    assert.equal(app.store.snapshot().revision, 1);
  });
});

describe('read-only sessions (27)', () => {
  test('a read-only session can read about a write method but cannot call it', async () => {
    const app = newApp();
    const result = await app.handle('r', 'javascript', `
const doc = (await docs.read('/api/draft/rename.d.ts'))[0].content;
const out = [doc.includes('rename(change')];
try { await draft.rename({ id: 'desk-1', name: 'Nope' }); out.push('renamed'); } catch (e) { out.push(e.name); }
try { await __scriptbox.hostCall('draft.rename', [{ id: 'desk-1', name: 'Nope' }]); out.push('renamed'); } catch (e) { out.push(e.name); }
out.push((await catalog.get({ id: 'desk-1' })).name);
return out;`, { readOnly: true });
    assert.deepEqual(completed(result.outcome), [true, 'PermissionDeniedError', 'PermissionDeniedError', 'Standing desk']);
    assert.deepEqual(result.draft.summary().modified, []);
    assert.deepEqual(result.outcome.evidence.calls.map((c) => [c.method, c.disposition, c.handlerRan]), [
      ['docs.read', 'completed', true],
      ['draft.rename', 'denied', false],
      ['draft.rename', 'denied', false],
      ['catalog.get', 'completed', true],
    ]);
  });
});
