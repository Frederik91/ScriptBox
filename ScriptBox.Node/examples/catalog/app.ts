// A fake application that uses ScriptBox the way a real one would: it owns an
// accepted catalog, gives each request its own draft, lets a script read and
// stage changes through a typed API, and turns a completed draft into a
// proposal that a person accepts outside the script. Nothing here is part of
// ScriptBox; it shows where the application's responsibilities sit.
import { setTimeout as delay } from 'node:timers/promises';
import {
  createApiKit,
  ScriptApiError,
  Type,
  type ExecutionLimits,
  type ExecutionOutcome,
  type HostCall,
  type ScriptBoxRuntime,
  type ScriptLanguage,
  type Static,
} from '@frederik91/scriptbox';

export const Item = Type.Object({
  id: Type.String({ description: 'Assigned by the application; a script cannot choose it.' }),
  name: Type.String({ minLength: 1, maxLength: 120 }),
  kind: Type.Union([Type.Literal('desk'), Type.Literal('chair'), Type.Literal('lamp')]),
}, { $id: 'Item', description: 'One catalog item.' });
export type Item = Static<typeof Item>;

export const ItemPage = Type.Object({
  items: Type.Array(Item),
  nextCursor: Type.Union([Type.String(), Type.Null()], { description: 'Pass it to the next call; null on the last page.' }),
}, { $id: 'ItemPage', description: 'One page of items, ordered by id.' });

export const DraftSummary = Type.Object({
  baseRevision: Type.Integer(),
  added: Type.Array(Item),
  modified: Type.Array(Type.Object({ id: Type.String(), before: Item, after: Item })),
  removed: Type.Array(Type.String()),
}, { $id: 'DraftSummary', description: 'What the draft changes, compared with the catalog it started from.' });
export type DraftSummary = Static<typeof DraftSummary>;

/** An accepted catalog revision. Never changed in place. */
export interface AcceptedCatalog {
  readonly revision: number;
  readonly items: ReadonlyMap<string, Item>;
}

/** What a completed draft proposes, bound to the revision it started from. */
export interface Proposal {
  readonly baseRevision: number;
  readonly summary: DraftSummary;
}

export type AcceptResult =
  | { readonly accepted: true; readonly revision: number }
  | { readonly accepted: false; readonly reason: 'stale-base'; readonly currentRevision: number };

function freezeItem(item: Item): Item {
  return Object.freeze({ id: item.id, name: item.name, kind: item.kind });
}

/** The application's accepted state. Only `accept` changes it, and no script can reach `accept`. */
export class CatalogStore {
  private current: AcceptedCatalog;

  constructor(items: readonly Item[]) {
    this.current = Object.freeze({ revision: 1, items: new Map(items.map((item) => [item.id, freezeItem(item)])) });
  }

  snapshot(): AcceptedCatalog {
    return this.current;
  }

  /**
   * Applies a reviewed proposal. A proposal made against an older revision is
   * refused: the application must revalidate or rebase it, never apply it blind.
   */
  accept(proposal: Proposal): AcceptResult {
    if (proposal.baseRevision !== this.current.revision) {
      return { accepted: false, reason: 'stale-base', currentRevision: this.current.revision };
    }
    const items = new Map(this.current.items);
    for (const item of proposal.summary.added) {
      items.set(item.id, freezeItem(item));
    }
    for (const change of proposal.summary.modified) {
      items.set(change.id, freezeItem(change.after));
    }
    for (const id of proposal.summary.removed) {
      items.delete(id);
    }
    this.current = Object.freeze({ revision: this.current.revision + 1, items });
    return { accepted: true, revision: this.current.revision };
  }
}

/**
 * One request's staged changes over an accepted revision. Reads see the staged
 * values; the accepted catalog is never touched. Discarding drops everything.
 */
export class Draft {
  readonly base: AcceptedCatalog;
  private readonly staged = new Map<string, Item>();
  private readonly order: string[] = [];
  private nextNumber = 1;
  private discarded = false;

  constructor(base: AcceptedCatalog) {
    this.base = base;
  }

  get isDiscarded(): boolean {
    return this.discarded;
  }

  get(id: string): Item | undefined {
    return this.staged.get(id) ?? this.base.items.get(id);
  }

  list(cursor: string | undefined, limit: number): { items: Item[]; nextCursor: string | null } {
    const ids = [...new Set([...this.base.items.keys(), ...this.staged.keys()])].sort();
    const start = cursor === undefined ? 0 : ids.findIndex((id) => id > cursor);
    const from = start === -1 ? ids.length : start;
    const page = ids.slice(from, from + limit);
    const items = page.flatMap((id) => {
      const item = this.get(id);
      return item === undefined ? [] : [item];
    });
    const last = page.at(-1);
    return { items, nextCursor: from + limit < ids.length && last !== undefined ? last : null };
  }

  /** Stages a rename. The revocation check and the write happen in one synchronous step. */
  rename(id: string, name: string, call: HostCall<RequestState>): Item {
    const existing = this.get(id);
    if (existing === undefined) {
      throw notFound(id);
    }
    if ([...this.allItems()].some((item) => item.id !== id && item.name === name)) {
      throw new ScriptApiError({ name: 'ConflictError', message: `Another item is already called '${name}'.` });
    }
    call.throwIfRevoked();
    this.checkOpen();
    const renamed = freezeItem({ ...existing, name });
    this.stage(renamed);
    return renamed;
  }

  /** Stages a new item with an id the application allocates. */
  create(name: string, kind: Item['kind'], call: HostCall<RequestState>): Item {
    if ([...this.allItems()].some((item) => item.name === name)) {
      throw new ScriptApiError({ name: 'ConflictError', message: `An item is already called '${name}'.` });
    }
    call.throwIfRevoked();
    this.checkOpen();
    const item = freezeItem({ id: `new-${this.base.revision}-${this.nextNumber++}`, name, kind });
    this.stage(item);
    return item;
  }

  summary(): DraftSummary {
    const added: Item[] = [];
    const modified: { id: string; before: Item; after: Item }[] = [];
    for (const id of this.order) {
      const after = this.staged.get(id);
      const before = this.base.items.get(id);
      if (after === undefined) {
        continue;
      }
      if (before === undefined) {
        added.push(after);
      } else {
        modified.push({ id, before, after });
      }
    }
    return { baseRevision: this.base.revision, added, modified, removed: [] };
  }

  discard(): void {
    this.discarded = true;
    this.staged.clear();
    this.order.length = 0;
  }

  private *allItems(): Iterable<Item> {
    for (const id of new Set([...this.base.items.keys(), ...this.staged.keys()])) {
      const item = this.get(id);
      if (item !== undefined) {
        yield item;
      }
    }
  }

  private stage(item: Item): void {
    if (!this.staged.has(item.id)) {
      this.order.push(item.id);
    }
    this.staged.set(item.id, item);
  }

  private checkOpen(): void {
    if (this.discarded) {
      throw new ScriptApiError({ code: 'revoked', message: 'This draft has been discarded.' });
    }
  }
}

function notFound(id: string): ScriptApiError {
  return new ScriptApiError({ name: 'NotFoundError', message: `There is no item '${id}'.` });
}

/** The request state every handler receives. The application binds it; a script cannot name another draft. */
export interface RequestState {
  readonly draft: Draft;
}

export interface CatalogApiOptions {
  /** Simulated I/O latency for every call, to show that waiting does not block the application. */
  readonly delayMs?: number;
}

/** The script-facing API. It reads and stages; it has no way to accept, commit or approve. */
export function createCatalogApis(options: CatalogApiOptions = {}) {
  const api = createApiKit<RequestState>();
  const wait = async (call: HostCall<RequestState>): Promise<void> => {
    if (options.delayMs !== undefined && options.delayMs > 0) {
      await delay(options.delayMs, undefined, { signal: call.signal });
    }
  };

  const catalog = api.namespace({
    name: 'catalog',
    description: 'Reads the catalog as this request\'s draft sees it, staged changes included.',
    methods: {
      get: api.method({
        summary: 'Gets one item by its id.',
        description: 'Fails with NotFoundError when there is no such item.',
        effect: 'read',
        params: { query: Type.Object({ id: Type.String({ maxLength: 64 }) }) },
        result: Item,
        handler: async ({ query }, call) => {
          await wait(call);
          const item = call.context.draft.get(query.id);
          if (item === undefined) {
            throw notFound(query.id);
          }
          return item;
        },
      }),
      list: api.method({
        summary: 'Lists items in id order, one page at a time.',
        effect: 'read',
        params: {
          page: Type.Optional(Type.Object({
            cursor: Type.Optional(Type.String({ maxLength: 64, description: 'nextCursor from the previous page.' })),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 20 })),
          }, { default: {} })),
        },
        result: ItemPage,
        handler: async ({ page }, call) => {
          await wait(call);
          return call.context.draft.list(page?.cursor, page?.limit ?? 20);
        },
      }),
    },
  });

  const draft = api.namespace({
    name: 'draft',
    description: 'Stages changes in this request\'s draft. The application reviews the draft after the script ends; nothing here changes the accepted catalog.',
    methods: {
      rename: api.method({
        summary: 'Stages a new name for an item and returns the item as staged.',
        effect: 'draft-write',
        params: { change: Type.Object({ id: Type.String({ maxLength: 64 }), name: Type.String({ minLength: 1, maxLength: 120 }) }) },
        result: Item,
        handler: async ({ change }, call) => {
          await wait(call);
          return call.context.draft.rename(change.id, change.name, call);
        },
      }),
      create: api.method({
        summary: 'Stages a new item. The application assigns its id.',
        effect: 'draft-write',
        params: {
          item: Type.Object({
            name: Type.String({ minLength: 1, maxLength: 120 }),
            kind: Type.Union([Type.Literal('desk'), Type.Literal('chair'), Type.Literal('lamp')], { default: 'desk' }),
          }),
        },
        result: Item,
        handler: async ({ item }, call) => {
          await wait(call);
          return call.context.draft.create(item.name, item.kind, call);
        },
      }),
      summary: api.method({
        summary: 'Summarizes what the draft adds and changes.',
        effect: 'read',
        result: DraftSummary,
        handler: async (_args, call) => {
          await wait(call);
          return call.context.draft.summary();
        },
      }),
    },
  });

  return [catalog, draft] as const;
}

/** The application's own check of a completed draft, before anyone reviews it. */
export function validateDraft(draft: Draft): string[] {
  const problems: string[] = [];
  const summary = draft.summary();
  for (const item of [...summary.added, ...summary.modified.map((m) => m.after)]) {
    if (item.name.trim() !== item.name) {
      problems.push(`${item.id}: the name has leading or trailing spaces.`);
    }
  }
  return problems;
}

export function sampleItems(): Item[] {
  return [
    { id: 'chair-1', name: 'Office chair', kind: 'chair' },
    { id: 'desk-1', name: 'Standing desk', kind: 'desk' },
    { id: 'desk-2', name: 'Corner desk', kind: 'desk' },
    { id: 'lamp-1', name: 'Desk lamp', kind: 'lamp' },
  ];
}

/**
 * Where the application keeps proposals for review. Submitting is keyed by
 * the request id, so a request retried after a crash between "proposal made"
 * and "request marked done" files one proposal, not two. ScriptBox cannot make
 * external effects exactly-once; this is the application's job.
 */
export class ProposalInbox {
  private readonly byRequest = new Map<string, Proposal>();

  submit(requestId: string, proposal: Proposal): { proposal: Proposal; duplicate: boolean } {
    const existing = this.byRequest.get(requestId);
    if (existing !== undefined) {
      return { proposal: existing, duplicate: true };
    }
    this.byRequest.set(requestId, proposal);
    return { proposal, duplicate: false };
  }

  get size(): number {
    return this.byRequest.size;
  }
}

export interface RequestResult {
  readonly outcome: ExecutionOutcome;
  /** Set only when the script completed and the draft passed the application's checks. */
  readonly proposal: Proposal | undefined;
  /** The application's reasons for refusing a completed draft. */
  readonly problems: readonly string[];
  readonly draft: Draft;
}

/**
 * The application's request flow: a fresh draft and session per attempt, a
 * session that may read and stage but never accept, and a draft that is kept
 * only when the script completed and the draft passed validation.
 */
export class CatalogApplication {
  readonly store: CatalogStore;
  readonly inbox = new ProposalInbox();
  private readonly runtime: ScriptBoxRuntime<RequestState>;

  constructor(runtime: ScriptBoxRuntime<RequestState>, store: CatalogStore) {
    this.runtime = runtime;
    this.store = store;
  }

  async handle(
    requestId: string,
    language: ScriptLanguage,
    source: string,
    options: { readonly signal?: AbortSignal; readonly limits?: Partial<ExecutionLimits>; readonly readOnly?: boolean } = {},
  ): Promise<RequestResult> {
    // Every attempt starts from the accepted revision; a retry never sees an earlier attempt's writes.
    const draft = new Draft(this.store.snapshot());
    const session = this.runtime.createSession({
      context: { draft },
      capabilities: options.readOnly === true ? ['catalog.*'] : ['catalog.*', 'draft.*'],
    });
    try {
      const outcome = await session.execute({
        language,
        source,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.limits === undefined ? {} : { limits: options.limits }),
      });
      if (outcome.status !== 'completed') {
        draft.discard();
        return { outcome, proposal: undefined, problems: [], draft };
      }
      const problems = validateDraft(draft);
      if (problems.length > 0) {
        draft.discard();
        return { outcome, proposal: undefined, problems, draft };
      }
      const { proposal } = this.inbox.submit(requestId, { baseRevision: draft.base.revision, summary: draft.summary() });
      return { outcome, proposal, problems, draft };
    } finally {
      await session.dispose();
    }
  }
}
