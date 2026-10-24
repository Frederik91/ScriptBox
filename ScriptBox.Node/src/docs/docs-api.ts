import { Type } from 'typebox';
import { createApiKit, type ApiDefinition, type HostCall } from '../api.ts';
import { ScriptApiError } from '../errors.ts';
import { utf8Length } from '../json.ts';
import { compileMatcher, MatchBudgetError, maxPatternLength } from './matcher.ts';
import { DocsPathError, isUnder, normalizeDocsPath, parentPath } from './paths.ts';
import { orderEntries, type DocsEntry, type DocsMatch, type DocsSearchHit, type DocsSource } from './tree.ts';

export const docsNamespace = 'docs';

/** Bounds on the docs calls, on top of the execution's message and call limits. */
export const docsLimits = Object.freeze({
  readPaths: 20,
  grepDefault: 50,
  grepMax: 200,
  searchDefault: 8,
  searchMax: 20,
  queryLength: 512,
  listEntries: 1_000,
  lineLength: 500,
  /** Pike VM steps one grep may take; about a quarter of a second of matching. */
  grepSteps: 20_000_000,
});

/** The sources one session reads through `docs.*`, in the order they are asked. */
export class DocsView {
  readonly sources: readonly DocsSource[];
  private readonly maxResponseBytes: number;

  constructor(sources: readonly DocsSource[], maxResponseBytes: number) {
    this.sources = sources;
    // Room for the response's own JSON around the file contents.
    this.maxResponseBytes = Math.max(1024, maxResponseBytes - 4096);
  }

  async ls(path: string | undefined, signal: AbortSignal): Promise<DocsEntry[]> {
    const directory = checkedPath(path);
    const entries = new Map<string, DocsEntry>();
    for (const source of this.sources) {
      for (const entry of await source.list(directory, signal)) {
        const checked = checkEntry(entry);
        const existing = entries.get(checked.path);
        // A folder two sources share keeps the first summary given.
        if (existing?.summary == null) {
          entries.set(checked.path, checked);
        }
        if (entries.size > docsLimits.listEntries) {
          break;
        }
      }
    }
    if (entries.size === 0 && directory !== '/') {
      throw new ScriptApiError({ name: 'NotFoundError', message: `There is no folder ${directory}. List ${parentPath(directory)} or use docs.search.` });
    }
    return orderEntries(entries.values()).slice(0, docsLimits.listEntries);
  }

  async read(paths: readonly string[], signal: AbortSignal): Promise<{ path: string; content: string | null; error: string | null }[]> {
    if (paths.length > docsLimits.readPaths) {
      throw new ScriptApiError({ name: 'RangeError', message: `docs.read takes at most ${docsLimits.readPaths} paths at once.` });
    }
    const files: { path: string; content: string | null; error: string | null }[] = [];
    let used = 0;
    for (const requested of paths) {
      let path: string;
      try {
        path = normalizeDocsPath(requested);
      } catch (error) {
        files.push({ path: requested.slice(0, 256), content: null, error: error instanceof DocsPathError ? error.message : 'The path is not valid.' });
        continue;
      }
      const content = await this.readOne(path, signal);
      if (typeof content !== 'string') {
        files.push({ path, content: null, error: content.error });
        continue;
      }
      const size = utf8Length(content);
      if (used + size > this.maxResponseBytes) {
        files.push({
          path,
          content: null,
          error: size > this.maxResponseBytes
            ? `${path} is larger than one response may carry (${this.maxResponseBytes} bytes). Use docs.grep to find the part you need.`
            : `${path} was not returned: the files read together are larger than one response may carry. Read fewer at once.`,
        });
        continue;
      }
      used += size;
      files.push({ path, content, error: null });
    }
    return files;
  }

  async grep(pattern: string, path: string | undefined, maxMatches: number, signal: AbortSignal): Promise<DocsMatch[]> {
    const directory = checkedPath(path);
    const matcher = compileMatcher(pattern, docsLimits.grepSteps, signal);
    const matches: DocsMatch[] = [];
    try {
      for (const source of this.sources) {
        if (matches.length >= maxMatches || source.grep === undefined) {
          continue;
        }
        const found = await source.grep({ matcher, directory, maxMatches: maxMatches - matches.length }, signal);
        for (const match of found) {
          const path = normalizeDocsPath(match.path);
          if (!isUnder(path, directory) || !Number.isSafeInteger(match.line)) {
            continue;
          }
          matches.push({ path, line: match.line, text: match.text.slice(0, docsLimits.lineLength) });
          if (matches.length >= maxMatches) {
            break;
          }
        }
      }
    } catch (error) {
      if (error instanceof MatchBudgetError) {
        throw new ScriptApiError({ name: 'RangeError', message: error.message });
      }
      throw error;
    }
    return matches;
  }

  async search(query: string, top: number, signal: AbortSignal): Promise<DocsSearchHit[]> {
    const best = new Map<string, DocsSearchHit>();
    for (const source of this.sources) {
      if (source.search === undefined) {
        continue;
      }
      for (const hit of await source.search(query, top, signal)) {
        const path = normalizeDocsPath(hit.path);
        if (!Number.isFinite(hit.score)) {
          continue;
        }
        const existing = best.get(path);
        if (existing === undefined || hit.score > existing.score) {
          best.set(path, { path, summary: hit.summary === null ? null : hit.summary.slice(0, 1024), score: hit.score });
        }
      }
    }
    return [...best.values()]
      .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .slice(0, top);
  }

  private async readOne(path: string, signal: AbortSignal): Promise<string | { error: string }> {
    for (const source of this.sources) {
      const content = await source.read(path, signal);
      if (typeof content === 'string') {
        return content;
      }
    }
    for (const source of this.sources) {
      if ((await source.list(path, signal)).length > 0) {
        return { error: `${path} is a folder. List it with docs.ls.` };
      }
    }
    return { error: `There is no file ${path}. List ${parentPath(path)} or use docs.search.` };
  }
}

function checkedPath(path: string | undefined): string {
  try {
    return normalizeDocsPath(path);
  } catch (error) {
    throw new ScriptApiError({ name: 'InvalidPathError', message: error instanceof DocsPathError ? error.message : 'The path is not valid.' });
  }
}

function checkEntry(entry: DocsEntry): DocsEntry {
  return {
    path: normalizeDocsPath(entry.path),
    kind: entry.kind === 'directory' ? 'directory' : 'file',
    summary: typeof entry.summary === 'string' ? entry.summary.slice(0, 1024) : null,
  };
}

const views = new WeakMap<object, DocsView>();

/** @internal Gives a docs call the session's view; the dispatcher does this before invoking a docs method. */
export function bindDocsView(call: object, view: DocsView): void {
  views.set(call, view);
}

function viewOf(call: HostCall<unknown>): DocsView {
  const view = views.get(call);
  if (view === undefined) {
    throw new Error('A docs call arrived without the session\'s docs view.');
  }
  return view;
}

const DocsEntrySchema = Type.Object({
  path: Type.String({ description: 'Absolute path, such as /api/catalog/index.d.ts.' }),
  kind: Type.Union([Type.Literal('file'), Type.Literal('directory')]),
  summary: Type.Union([Type.String(), Type.Null()], { description: 'One line on what it holds.' }),
}, { $id: 'DocsEntry', description: 'A file or folder in the docs.' });

const DocsFileSchema = Type.Object({
  path: Type.String(),
  content: Type.Union([Type.String(), Type.Null()]),
  error: Type.Union([Type.String(), Type.Null()]),
}, { $id: 'DocsFile', description: 'A file read from the docs. Content is null when the path holds no file, and error says why.' });

const DocsMatchSchema = Type.Object({
  path: Type.String(),
  line: Type.Integer({ minimum: 1 }),
  text: Type.String(),
}, { $id: 'DocsMatch', description: 'A line that matched a grep.' });

const DocsSearchHitSchema = Type.Object({
  path: Type.String(),
  summary: Type.Union([Type.String(), Type.Null()]),
  score: Type.Number(),
}, { $id: 'DocsSearchHit', description: 'A file that matched a search, best first.' });

/** The built-in `docs` namespace. Its calls pass the same dispatcher, filters and limits as any other. */
export function createDocsApi(): ApiDefinition<unknown> {
  const kit = createApiKit<unknown>();
  return kit.namespace({
    name: docsNamespace,
    description: 'Read-only documentation of everything a script can call, laid out as files. '
      + 'List a folder with docs.ls, read files with docs.read, find text with docs.grep and find a topic with docs.search.',
    methods: {
      ls: kit.method({
        summary: 'Lists the files and folders directly inside a folder, each with a one-line summary.',
        effect: 'documentation',
        params: { path: Type.Optional(Type.String({ maxLength: 1024, description: 'The folder; "/" when left out.' })) },
        result: Type.Array(DocsEntrySchema),
        handler: ({ path }, call) => viewOf(call).ls(path, call.signal),
      }),
      read: kit.method({
        summary: 'Reads one file, or several at once by passing an array of paths.',
        description: 'A path that holds no file comes back with an error instead of content.',
        effect: 'documentation',
        params: {
          paths: Type.Union([
            Type.String({ maxLength: 1024 }),
            Type.Array(Type.String({ maxLength: 1024 }), { maxItems: docsLimits.readPaths }),
          ], { description: `A path, or an array of up to ${docsLimits.readPaths}.` }),
        },
        result: Type.Array(DocsFileSchema),
        handler: ({ paths }, call) => viewOf(call).read(typeof paths === 'string' ? [paths] : paths, call.signal),
      }),
      grep: kit.method({
        summary: 'Finds the lines that match a regular expression, case-insensitive, in every file under a folder.',
        description: 'Supports . [] ^ $ | () * + ? {n,m} and \\d \\w \\s \\b; a pattern that is not one of those is matched as plain text.',
        effect: 'documentation',
        params: {
          pattern: Type.String({ minLength: 1, maxLength: maxPatternLength, description: 'A regular expression, or plain text.' }),
          path: Type.Optional(Type.String({ maxLength: 1024, description: 'The folder to look in; "/" when left out.' })),
          maxMatches: Type.Optional(Type.Integer({
            minimum: 1, maximum: docsLimits.grepMax, default: docsLimits.grepDefault,
            description: `The most lines to return; ${docsLimits.grepDefault} when left out.`,
          })),
        },
        result: Type.Array(DocsMatchSchema),
        handler: ({ pattern, path, maxMatches }, call) => viewOf(call).grep(pattern, path, maxMatches ?? docsLimits.grepDefault, call.signal),
      }),
      search: kit.method({
        summary: 'Finds the files about a topic, best first.',
        description: 'Describe what you want to do in a few words.',
        effect: 'documentation',
        params: {
          query: Type.String({ maxLength: docsLimits.queryLength }),
          top: Type.Optional(Type.Integer({
            minimum: 1, maximum: docsLimits.searchMax, default: docsLimits.searchDefault,
            description: `The most files to return; ${docsLimits.searchDefault} when left out.`,
          })),
        },
        result: Type.Array(DocsSearchHitSchema),
        handler: ({ query, top }, call) => viewOf(call).search(query, top ?? docsLimits.searchDefault, call.signal),
      }),
    },
  });
}
