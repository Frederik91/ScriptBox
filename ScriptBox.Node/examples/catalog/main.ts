// Runs the catalog example end to end: one request, one draft, one script,
// then the application's own validation and a proposal that is accepted
// outside the script. Run it with `node examples/catalog/main.ts`.
import { createRuntime } from '@frederik91/scriptbox';
import { CatalogApplication, CatalogStore, createCatalogApis, sampleItems, type RequestState } from './app.ts';

const runtime = await createRuntime<RequestState>({
  apis: createCatalogApis({ delayMs: 25 }),
  contractVersion: 'catalog-example-1',
  policyVersion: 'catalog-writers-1',
});
const app = new CatalogApplication(runtime, new CatalogStore(sampleItems()));

const js = await app.handle('request-1', 'javascript', `
const item = await catalog.get({ id: 'desk-1' });
await draft.rename({ id: item.id, name: 'Desk by window' });
const updated = await catalog.get({ id: item.id });
return { id: updated.id, name: updated.name };
`);
console.log('JavaScript:', js.outcome.status, JSON.stringify(js.outcome.status === 'completed' ? js.outcome.value : js.outcome));
console.log('Calls:', js.outcome.evidence.calls.map((c) => `${c.method} ${c.disposition}`).join(', '));
console.log('Accepted catalog still says:', app.store.snapshot().items.get('desk-1')?.name);

const ts = await app.handle('request-2', 'typescript', `
const created = await draft.create({ name: 'Reading lamp', kind: 'lamp' });
const summary = await draft.summary();
const names: string[] = summary.added.map((item) => item.name);
return { created: created.id, added: names };
`);
console.log('TypeScript:', ts.outcome.status, JSON.stringify(ts.outcome.status === 'completed' ? ts.outcome.value : ts.outcome));

// A person reviews the proposals; the application applies them. The second is
// now stale, because the first advanced the revision.
if (js.proposal !== undefined && ts.proposal !== undefined) {
  console.log('Accept first:', app.store.accept(js.proposal));
  console.log('Accept second:', app.store.accept(ts.proposal));
}
console.log('Accepted catalog now says:', app.store.snapshot().items.get('desk-1')?.name);

await runtime.dispose();
