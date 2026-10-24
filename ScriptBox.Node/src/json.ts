/** A value with an exact JSON form: what crosses the boundary between a script and the host. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export function utf8Length(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Whether JSON text nests arrays and objects deeper than `maxDepth`, found by
 * one pass over the text without building anything.
 */
export function jsonNestsDeeperThan(text: string, maxDepth: number): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c) {
        i++;
      } else if (c === 0x22) {
        inString = false;
      }
      continue;
    }
    if (c === 0x22) {
      inString = true;
    } else if (c === 0x5b || c === 0x7b) {
      depth++;
      if (depth > maxDepth) {
        return true;
      }
    } else if (c === 0x5d || c === 0x7d) {
      depth--;
    }
  }
  return false;
}

export class JsonBoundaryError extends Error {
  override readonly name = 'JsonBoundaryError';
}

/**
 * Parses JSON text that came from outside the trusted code. The result is
 * `unknown` on purpose: it has to be validated before anything relies on it.
 */
export function parseBoundedJson(text: string, maxBytes: number, maxDepth: number): unknown {
  if (utf8Length(text) > maxBytes) {
    throw new JsonBoundaryError(`The JSON is larger than ${maxBytes} bytes.`);
  }
  if (jsonNestsDeeperThan(text, maxDepth)) {
    throw new JsonBoundaryError(`The JSON nests deeper than ${maxDepth} levels.`);
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    throw new JsonBoundaryError('The text is not valid JSON.');
  }
}

/** Array.isArray does not narrow a readonly array; this does. */
export function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Checks that a value parsed from JSON text is a JSON value; it always is, but this gives it the type. */
export function asJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    for (const item of value) {
      items.push(asJsonValue(item));
    }
    return items;
  }
  if (isRecord(value)) {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = asJsonValue(item);
    }
    return result;
  }
  throw new JsonBoundaryError('The value is not JSON.');
}

/** Deep-freezes a JSON value so trusted code downstream cannot change what a filter or handler saw. */
export function freezeJson<T extends JsonValue>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) {
      freezeJson(item);
    }
    Object.freeze(value);
  }
  return value;
}
