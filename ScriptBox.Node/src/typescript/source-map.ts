// A reader for the one source map the TypeScript emit produces, enough to map
// a guest stack position back to the submitted source.

const base64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

interface Segment {
  readonly column: number;
  readonly sourceLine: number;
  readonly sourceColumn: number;
}

/** Generated line (0-based) to its segments, sorted by column. */
export type DecodedMappings = readonly (readonly Segment[])[];

function decodeVlq(text: string, start: number): [number[], number] {
  const values: number[] = [];
  let value = 0;
  let shift = 0;
  let i = start;
  for (; i < text.length; i++) {
    const c = text.charAt(i);
    if (c === ',' || c === ';') {
      break;
    }
    const digit = base64.indexOf(c);
    if (digit < 0) {
      throw new Error('The source map is malformed.');
    }
    value += (digit & 31) << shift;
    if ((digit & 32) !== 0) {
      shift += 5;
    } else {
      values.push((value & 1) === 1 ? -(value >>> 1) : value >>> 1);
      value = 0;
      shift = 0;
    }
  }
  return [values, i];
}

/** Decodes a source map's `mappings` for a map with one source. */
export function decodeMappings(mappings: string): DecodedMappings {
  const lines: Segment[][] = [[]];
  let column = 0;
  let sourceLine = 0;
  let sourceColumn = 0;
  for (let i = 0; i < mappings.length;) {
    const c = mappings.charAt(i);
    if (c === ';') {
      lines.push([]);
      column = 0;
      i++;
      continue;
    }
    if (c === ',') {
      i++;
      continue;
    }
    const [values, next] = decodeVlq(mappings, i);
    i = next;
    column += values[0] ?? 0;
    if (values.length >= 4) {
      sourceLine += values[2] ?? 0;
      sourceColumn += values[3] ?? 0;
      lines[lines.length - 1]?.push({ column, sourceLine, sourceColumn });
    }
  }
  return lines;
}

/** The source position (0-based line and column) of a generated one, or undefined. */
export function originalPosition(mappings: DecodedMappings, line: number, column: number): { line: number; column: number } | undefined {
  const segments = mappings[line];
  if (segments === undefined || segments.length === 0) {
    return undefined;
  }
  let found: Segment | undefined;
  for (const segment of segments) {
    if (segment.column <= column) {
      found = segment;
    } else {
      break;
    }
  }
  found ??= segments[0];
  return found === undefined ? undefined : { line: found.sourceLine, column: found.sourceColumn + (column - found.column > 0 && found.column <= column ? column - found.column : 0) };
}
