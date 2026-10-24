import { isRecord } from '../json.ts';

/** One TypeScript diagnostic, positioned in the submitted source (1-based). */
export interface CompileDiagnostic {
  readonly message: string;
  readonly line: number;
  readonly column: number;
  /** The TypeScript error code, such as 2339; 0 for ScriptBox's own checks. */
  readonly code: number;
}

export interface CompileRequest {
  readonly t: 'compile';
  readonly id: number;
  readonly source: string;
  readonly declarations: string;
  readonly declarationsKey: string;
}

export type CompileResponse =
  | { readonly t: 'compiled'; readonly id: number; readonly js: string; readonly map: string }
  | { readonly t: 'rejected'; readonly id: number; readonly category: 'invalid-source' | 'type-check'; readonly diagnostics: readonly CompileDiagnostic[] }
  | { readonly t: 'failed'; readonly id: number; readonly message: string };

/**
 * The line the submitted source is wrapped in. It sits on its own line, so the
 * submitted source's line n is line n of the wrapped file, counting from 0.
 */
export const typeScriptPrefix = '(async function () {\n';
export const typeScriptSuffix = '\n})();\n';

function isDiagnostic(value: unknown): value is CompileDiagnostic {
  return isRecord(value)
    && typeof value['message'] === 'string'
    && typeof value['line'] === 'number'
    && typeof value['column'] === 'number'
    && typeof value['code'] === 'number';
}

export function readCompileRequest(value: unknown): CompileRequest | undefined {
  if (!isRecord(value) || value['t'] !== 'compile') {
    return undefined;
  }
  const { id, source, declarations, declarationsKey } = value;
  return typeof id === 'number' && typeof source === 'string' && typeof declarations === 'string' && typeof declarationsKey === 'string'
    ? { t: 'compile', id, source, declarations, declarationsKey }
    : undefined;
}

export function readCompileResponse(value: unknown): CompileResponse | undefined {
  if (!isRecord(value) || typeof value['id'] !== 'number') {
    return undefined;
  }
  const id = value['id'];
  switch (value['t']) {
    case 'compiled':
      return typeof value['js'] === 'string' && typeof value['map'] === 'string'
        ? { t: 'compiled', id, js: value['js'], map: value['map'] } : undefined;
    case 'rejected': {
      const category = value['category'];
      const diagnostics = value['diagnostics'];
      if ((category !== 'invalid-source' && category !== 'type-check') || !Array.isArray(diagnostics)) {
        return undefined;
      }
      const items: unknown[] = diagnostics;
      return items.every(isDiagnostic) ? { t: 'rejected', id, category, diagnostics: items.filter(isDiagnostic) } : undefined;
    }
    case 'failed':
      return typeof value['message'] === 'string' ? { t: 'failed', id, message: value['message'] } : undefined;
    default:
      return undefined;
  }
}
