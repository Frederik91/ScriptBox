import { isJsonArray, type JsonValue } from './json.ts';

/** Exact structural identities for one validation walk, never retained across calls. */
export function createJsonIdentity() {
  const objects = new WeakMap<object, number>();
  const signatures = new Map<string, number>();

  function identify(value: JsonValue): number {
    if (typeof value === 'object' && value !== null) {
      const cached = objects.get(value);
      if (cached !== undefined) {
        return cached;
      }
    }
    // Signatures contain only immediate child IDs, not repeated subtree JSON.
    // JSON's number spelling equates -0 and 0; type tags distinguish all other primitives.
    const signature = isJsonArray(value) ? JSON.stringify(['array', value.map(identify)])
      : typeof value === 'object' && value !== null
        ? JSON.stringify(['object', Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
          .map(([key, item]) => [key, identify(item)])])
        : JSON.stringify([value === null ? 'null' : typeof value, value]);
    let id = signatures.get(signature);
    if (id === undefined) {
      id = signatures.size;
      signatures.set(signature, id);
    }
    if (typeof value === 'object' && value !== null) {
      objects.set(value, id);
    }
    return id;
  }

  return {
    firstDuplicate(items: readonly JsonValue[]): number | undefined {
      const seen = new Set<number>();
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item === undefined) {
          throw new Error('Structural identity requires validated JSON items.');
        }
        const id = identify(item);
        if (seen.has(id)) {
          return i;
        }
        seen.add(id);
      }
      return undefined;
    },
  };
}

export type JsonIdentity = ReturnType<typeof createJsonIdentity>;
