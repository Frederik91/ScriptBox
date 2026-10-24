/** Bounds on a virtual docs path. */
export const maxPathLength = 1024;
export const maxPathSegments = 64;

/** Thrown for a path that cannot name anything in the docs tree. */
export class DocsPathError extends Error {
  override readonly name = 'DocsPathError';
}

/**
 * Normalizes a virtual docs path: absolute, `/`-separated, no empty
 * segments. A `.` or `..` segment or a control character is refused rather
 * than resolved, so a path can only ever name something inside the tree; it is
 * never a filesystem path or a URL.
 */
export function normalizeDocsPath(path: string | null | undefined): string {
  if (path === null || path === undefined || path.trim().length === 0) {
    return '/';
  }
  if (path.length > maxPathLength) {
    throw new DocsPathError(`A docs path may be at most ${maxPathLength} characters.`);
  }
  if (/[\u0000-\u001f\u007f]/.test(path)) {
    throw new DocsPathError('A docs path may not contain control characters.');
  }
  const segments = path.replaceAll('\\', '/').split('/').filter((s) => s.length > 0);
  if (segments.some((s) => s === '.' || s === '..')) {
    throw new DocsPathError('A docs path may not contain . or .. segments. Paths are absolute, such as /api/catalog/README.md.');
  }
  if (segments.length > maxPathSegments) {
    throw new DocsPathError(`A docs path may have at most ${maxPathSegments} segments.`);
  }
  return `/${segments.join('/')}`;
}

export function parentPath(path: string): string {
  const normalized = normalizeDocsPath(path);
  const slash = normalized.lastIndexOf('/');
  return slash <= 0 ? '/' : normalized.slice(0, slash);
}

/** Whether `path` is `directory` or anywhere below it. */
export function isUnder(path: string, directory: string): boolean {
  return directory === '/' || path === directory || path.startsWith(`${directory}/`);
}
