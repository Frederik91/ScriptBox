import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { ScriptBoxConfigurationError } from '../errors.ts';
import { utf8Length } from '../json.ts';
import type { DocsMatcher } from './matcher.ts';
import { isUnder, normalizeDocsPath } from './paths.ts';
import { searchScore, searchTerms } from './search.ts';

/** A file or folder in the docs. */
export interface DocsEntry {
  /** Absolute path, such as /api/catalog/index.d.ts. */
  readonly path: string;
  readonly kind: 'file' | 'directory';
  /** One line on what it holds. */
  readonly summary: string | null;
}

/** A line that matched a grep. */
export interface DocsMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

/** A file that matched a search, best first. */
export interface DocsSearchHit {
  readonly path: string;
  readonly summary: string | null;
  readonly score: number;
}

/** A grep request: the matcher, the folder it is limited to, and the most matches wanted. */
export interface DocsGrepRequest {
  readonly matcher: DocsMatcher;
  readonly directory: string;
  readonly maxMatches: number;
}

/**
 * Part of the tree the `docs` namespace serves. The host supplies sources;
 * scripts only read them through `docs.*`. Paths are absolute and use `/`.
 *
 * Each source answers only for the paths it holds and returns nothing for the
 * rest, so several can share a folder. A source whose files come from a large
 * or remote catalogue can list and read on demand, leave `grep` out, and still
 * be found through `search`. A source reaches its own storage; a script never
 * does, so a source is how remote docs become readable without giving the
 * script network access.
 */
export interface DocsSource {
  /** The files and folders directly inside `directory`. */
  list(directory: string, signal: AbortSignal): readonly DocsEntry[] | Promise<readonly DocsEntry[]>;
  /** The file's text, or undefined when this source does not hold it. */
  read(path: string, signal: AbortSignal): string | undefined | Promise<string | undefined>;
  grep?(request: DocsGrepRequest, signal: AbortSignal): readonly DocsMatch[] | Promise<readonly DocsMatch[]>;
  search?(query: string, top: number, signal: AbortSignal): readonly DocsSearchHit[] | Promise<readonly DocsSearchHit[]>;
}

/** Bounds on an in-memory docs tree. */
export const docsTreeLimits = Object.freeze({
  files: 10_000,
  fileBytes: 1024 * 1024,
  summaryBytes: 1024,
});

type Content = string | (() => string | Promise<string>);

interface Node {
  readonly summary: string | null;
  readonly content: Content;
  loaded: string | undefined;
}

/** Order listings as the .NET host does: folders first, then a folder's README, then by path. */
export function orderEntries(entries: Iterable<DocsEntry>): DocsEntry[] {
  return [...entries].sort((a, b) => {
    const kind = (a.kind === 'directory' ? 0 : 1) - (b.kind === 'directory' ? 0 : 1);
    if (kind !== 0) {
      return kind;
    }
    const readme = (a.path.endsWith('/README.md') ? 0 : 1) - (b.path.endsWith('/README.md') ? 0 : 1);
    if (readme !== 0) {
      return readme;
    }
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
}

/** Lines between yields while a docs tree is grepped, so a long grep never holds the event loop. */
const linesPerSlice = 2_000;

/**
 * Docs held in memory: files added by path, folders implied by them. A file's
 * text can be produced on first read, from a function the host supplies.
 */
export class DocsTree implements DocsSource {
  private readonly files = new Map<string, Node>();
  private readonly directorySummaries = new Map<string, string>();

  addFile(path: string, summary: string | null | undefined, content: Content): this {
    const normalized = normalizeDocsPath(path);
    if (normalized === '/') {
      throw new ScriptBoxConfigurationError('A docs file needs a name.');
    }
    if (!this.files.has(normalized) && this.files.size >= docsTreeLimits.files) {
      throw new ScriptBoxConfigurationError(`A docs tree may hold at most ${docsTreeLimits.files} files.`);
    }
    if (typeof content === 'string' && utf8Length(content) > docsTreeLimits.fileBytes) {
      throw new ScriptBoxConfigurationError(`${normalized} is larger than ${docsTreeLimits.fileBytes} bytes.`);
    }
    this.files.set(normalized, { summary: checkSummary(summary), content, loaded: typeof content === 'string' ? content : undefined });
    return this;
  }

  /** Gives a folder the one-line summary its listing shows. */
  describeDirectory(path: string, summary: string): this {
    this.directorySummaries.set(normalizeDocsPath(path), checkSummary(summary) ?? '');
    return this;
  }

  /** Every file in the tree, sorted by path. */
  get entries(): DocsEntry[] {
    return [...this.files.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, node]) => ({ path, kind: 'file', summary: node.summary }));
  }

  list(directory: string): DocsEntry[] {
    const dir = normalizeDocsPath(directory);
    const entries = new Map<string, DocsEntry>();
    for (const [path, node] of this.files) {
      if (!isUnder(path, dir) || path === dir) {
        continue;
      }
      const rest = dir === '/' ? path.slice(1) : path.slice(dir.length + 1);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        entries.set(path, { path, kind: 'file', summary: node.summary });
        continue;
      }
      const child = `${dir === '/' ? '' : dir}/${rest.slice(0, slash)}`;
      if (!entries.has(child)) {
        entries.set(child, { path: child, kind: 'directory', summary: this.directorySummaries.get(child) ?? null });
      }
    }
    return orderEntries(entries.values());
  }

  async read(path: string): Promise<string | undefined> {
    const node = this.files.get(normalizeDocsPath(path));
    return node === undefined ? undefined : this.load(path, node);
  }

  async grep(request: DocsGrepRequest, signal: AbortSignal): Promise<DocsMatch[]> {
    const matches: DocsMatch[] = [];
    let sinceYield = 0;
    for (const entry of this.entries) {
      if (!isUnder(entry.path, request.directory)) {
        continue;
      }
      const node = this.files.get(entry.path);
      if (node === undefined) {
        continue;
      }
      const lines = (await this.load(entry.path, node)).split('\n');
      for (let i = 0; i < lines.length && matches.length < request.maxMatches; i++) {
        const line = lines[i] ?? '';
        if (request.matcher.test(line)) {
          matches.push({ path: entry.path, line: i + 1, text: line.replace(/\r$/, '').trim() });
        }
        if (++sinceYield >= linesPerSlice) {
          sinceYield = 0;
          await yieldToEventLoop(undefined, { signal });
        }
      }
      if (matches.length >= request.maxMatches) {
        break;
      }
    }
    return matches;
  }

  async search(query: string, top: number): Promise<DocsSearchHit[]> {
    const terms = searchTerms(query);
    const hits: DocsSearchHit[] = [];
    for (const entry of this.entries) {
      const node = this.files.get(entry.path);
      if (node === undefined) {
        continue;
      }
      const score = searchScore(terms, entry.path, entry.summary, await this.load(entry.path, node));
      if (score > 0) {
        hits.push({ path: entry.path, summary: entry.summary, score });
      }
    }
    return hits.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).slice(0, top);
  }

  private async load(path: string, node: Node): Promise<string> {
    if (node.loaded !== undefined) {
      return node.loaded;
    }
    if (typeof node.content === 'string') {
      return node.content;
    }
    const text = await node.content();
    if (typeof text !== 'string' || utf8Length(text) > docsTreeLimits.fileBytes) {
      throw new ScriptBoxConfigurationError(`${path} did not produce text of at most ${docsTreeLimits.fileBytes} bytes.`);
    }
    node.loaded = text;
    return text;
  }
}

function checkSummary(summary: string | null | undefined): string | null {
  if (summary === null || summary === undefined) {
    return null;
  }
  if (utf8Length(summary) > docsTreeLimits.summaryBytes) {
    throw new ScriptBoxConfigurationError(`A docs summary may be at most ${docsTreeLimits.summaryBytes} bytes.`);
  }
  return summary;
}
