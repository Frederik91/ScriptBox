// The matcher behind docs.grep. A script chooses the pattern, so it never
// reaches JavaScript's backtracking RegExp, where a pattern like (a+)+$ can run
// for minutes. Patterns compile to a small program that a Pike VM runs in time
// proportional to line length times program size, and every call has a budget
// of steps it cannot exceed.
//
// Supported syntax, always case-insensitive: literal characters; `.`; classes
// `[a-z]`, `[^...]`; escapes `\d \D \w \W \s \S \b \B \t` and escaped
// metacharacters; groups `(...)` and `(?:...)`; alternation `|`; quantifiers
// `* + ? {n} {n,} {n,m}` (n and m up to 100, lazy forms accepted); anchors
// `^ $`. Not supported: backreferences, lookaround, named groups, flags.
// A pattern that does not parse is matched as plain text.

export const maxPatternLength = 256;
const maxProgramSize = 4096;
const maxRepeat = 100;

type CharTest =
  | { readonly t: 'char'; readonly c: string }
  | { readonly t: 'any' }
  | { readonly t: 'class'; readonly negate: boolean; readonly ranges: readonly (readonly [number, number])[]; readonly sets: readonly string[] };

type Instruction =
  | { readonly op: 'test'; readonly test: CharTest }
  | { readonly op: 'split'; readonly a: number; readonly b: number }
  | { readonly op: 'jmp'; readonly to: number }
  | { readonly op: 'bol' }
  | { readonly op: 'eol' }
  | { readonly op: 'word'; readonly negate: boolean }
  | { readonly op: 'match' };

type Ast =
  | { readonly k: 'test'; readonly test: CharTest }
  | { readonly k: 'seq'; readonly items: readonly Ast[] }
  | { readonly k: 'alt'; readonly options: readonly Ast[] }
  | { readonly k: 'repeat'; readonly item: Ast; readonly min: number; readonly max: number | undefined }
  | { readonly k: 'bol' }
  | { readonly k: 'eol' }
  | { readonly k: 'word'; readonly negate: boolean }
  | { readonly k: 'empty' };

class PatternSyntaxError extends Error {}

/** Thrown when a grep runs out of its step budget. */
export class MatchBudgetError extends Error {
  override readonly name = 'MatchBudgetError';
}

class Parser {
  private i = 0;
  private readonly src: string;

  constructor(src: string) {
    this.src = src;
  }

  parse(): Ast {
    const ast = this.alternation();
    if (this.i < this.src.length) {
      throw new PatternSyntaxError(`Unexpected ${this.src.charAt(this.i)}`);
    }
    return ast;
  }

  private peek(): string | undefined {
    return this.i < this.src.length ? this.src.charAt(this.i) : undefined;
  }

  private alternation(): Ast {
    const options = [this.sequence()];
    while (this.peek() === '|') {
      this.i++;
      options.push(this.sequence());
    }
    return options.length === 1 && options[0] !== undefined ? options[0] : { k: 'alt', options };
  }

  private sequence(): Ast {
    const items: Ast[] = [];
    for (let c = this.peek(); c !== undefined && c !== '|' && c !== ')'; c = this.peek()) {
      items.push(this.quantified());
    }
    return items.length === 0 ? { k: 'empty' } : { k: 'seq', items };
  }

  private quantified(): Ast {
    const atom = this.atom();
    const c = this.peek();
    let min: number;
    let max: number | undefined;
    if (c === '*') {
      min = 0;
      max = undefined;
      this.i++;
    } else if (c === '+') {
      min = 1;
      max = undefined;
      this.i++;
    } else if (c === '?') {
      min = 0;
      max = 1;
      this.i++;
    } else if (c === '{' && /^\{\d{1,3}(,\d{0,3})?\}/.test(this.src.slice(this.i))) {
      const m = /^\{(\d{1,3})(,(\d{0,3}))?\}/.exec(this.src.slice(this.i));
      if (m === null || m[1] === undefined) {
        throw new PatternSyntaxError('Bad repeat');
      }
      min = Number(m[1]);
      max = m[2] === undefined ? min : (m[3] === undefined || m[3] === '' ? undefined : Number(m[3]));
      this.i += m[0].length;
      if (min > maxRepeat || (max !== undefined && (max > maxRepeat || max < min))) {
        throw new PatternSyntaxError('Repeat out of range');
      }
    } else {
      return atom;
    }
    if (atom.k === 'bol' || atom.k === 'eol' || atom.k === 'word') {
      throw new PatternSyntaxError('Nothing to repeat');
    }
    if (this.peek() === '?') {
      this.i++; // lazy and greedy match the same lines
    }
    return { k: 'repeat', item: atom, min, max };
  }

  private atom(): Ast {
    const c = this.peek();
    if (c === undefined) {
      throw new PatternSyntaxError('Unexpected end');
    }
    this.i++;
    switch (c) {
      case '(': {
        if (this.src.startsWith('?:', this.i)) {
          this.i += 2;
        } else if (this.peek() === '?') {
          throw new PatternSyntaxError('Unsupported group');
        }
        const inner = this.alternation();
        if (this.peek() !== ')') {
          throw new PatternSyntaxError('Unclosed group');
        }
        this.i++;
        return inner;
      }
      case ')':
      case '*':
      case '+':
      case '?':
        throw new PatternSyntaxError(`Unexpected ${c}`);
      case '[':
        return { k: 'test', test: this.charClass() };
      case '.':
        return { k: 'test', test: { t: 'any' } };
      case '^':
        return { k: 'bol' };
      case '$':
        return { k: 'eol' };
      case '\\':
        return this.escape();
      default:
        return { k: 'test', test: { t: 'char', c: c.toLowerCase() } };
    }
  }

  private escape(): Ast {
    const c = this.peek();
    if (c === undefined) {
      throw new PatternSyntaxError('Trailing backslash');
    }
    this.i++;
    switch (c) {
      case 'b':
        return { k: 'word', negate: false };
      case 'B':
        return { k: 'word', negate: true };
      case 'd':
      case 'D':
      case 'w':
      case 'W':
      case 's':
      case 'S':
        return { k: 'test', test: { t: 'class', negate: false, ranges: [], sets: [c] } };
      case 't':
        return { k: 'test', test: { t: 'char', c: '\t' } };
      default:
        if (/[A-Za-z0-9]/.test(c)) {
          throw new PatternSyntaxError(`Unsupported escape \\${c}`);
        }
        return { k: 'test', test: { t: 'char', c } };
    }
  }

  private charClass(): CharTest {
    let negate = false;
    if (this.peek() === '^') {
      negate = true;
      this.i++;
    }
    const ranges: [number, number][] = [];
    const sets: string[] = [];
    let first = true;
    for (;;) {
      const c = this.peek();
      if (c === undefined) {
        throw new PatternSyntaxError('Unclosed class');
      }
      if (c === ']' && !first) {
        this.i++;
        break;
      }
      first = false;
      this.i++;
      let low: string;
      if (c === '\\') {
        const e = this.peek();
        if (e === undefined) {
          throw new PatternSyntaxError('Trailing backslash');
        }
        this.i++;
        if ('dDwWsS'.includes(e)) {
          sets.push(e);
          continue;
        }
        if (/[A-Za-z0-9]/.test(e) && e !== 't') {
          throw new PatternSyntaxError(`Unsupported escape \\${e}`);
        }
        low = e === 't' ? '\t' : e;
      } else {
        low = c;
      }
      if (this.peek() === '-' && this.src.charAt(this.i + 1) !== ']' && this.i + 1 < this.src.length) {
        this.i++;
        let high = this.peek();
        if (high === undefined) {
          throw new PatternSyntaxError('Bad range');
        }
        this.i++;
        if (high === '\\') {
          high = this.peek();
          if (high === undefined) {
            throw new PatternSyntaxError('Bad range');
          }
          this.i++;
        }
        pushRange(ranges, low, high);
      } else {
        pushRange(ranges, low, low);
      }
    }
    return { t: 'class', negate, ranges, sets };
  }
}

function pushRange(ranges: [number, number][], low: string, high: string): void {
  const a = low.codePointAt(0) ?? 0;
  const b = high.codePointAt(0) ?? 0;
  if (b < a) {
    throw new PatternSyntaxError('Bad range');
  }
  ranges.push([a, b]);
  // Case-insensitive: add the lower-case form of the range's letters.
  const lowA = low.toLowerCase().codePointAt(0) ?? a;
  const lowB = high.toLowerCase().codePointAt(0) ?? b;
  if (lowA !== a || lowB !== b) {
    ranges.push([Math.min(lowA, lowB), Math.max(lowA, lowB)]);
  }
}

class Compiler {
  readonly program: Instruction[] = [];

  emit(instruction: Instruction): number {
    if (this.program.length >= maxProgramSize) {
      throw new PatternSyntaxError('Pattern too complex');
    }
    this.program.push(instruction);
    return this.program.length - 1;
  }

  patch(at: number, instruction: Instruction): void {
    this.program[at] = instruction;
  }

  compile(ast: Ast): void {
    switch (ast.k) {
      case 'test':
        this.emit({ op: 'test', test: ast.test });
        return;
      case 'bol':
        this.emit({ op: 'bol' });
        return;
      case 'eol':
        this.emit({ op: 'eol' });
        return;
      case 'word':
        this.emit({ op: 'word', negate: ast.negate });
        return;
      case 'empty':
        return;
      case 'seq':
        for (const item of ast.items) {
          this.compile(item);
        }
        return;
      case 'alt': {
        const jumps: number[] = [];
        ast.options.forEach((option, index) => {
          if (index < ast.options.length - 1) {
            const split = this.emit({ op: 'jmp', to: 0 });
            this.compile(option);
            jumps.push(this.emit({ op: 'jmp', to: 0 }));
            this.patch(split, { op: 'split', a: split + 1, b: this.program.length });
          } else {
            this.compile(option);
          }
        });
        for (const jump of jumps) {
          this.patch(jump, { op: 'jmp', to: this.program.length });
        }
        return;
      }
      case 'repeat': {
        for (let n = 0; n < ast.min; n++) {
          this.compile(ast.item);
        }
        if (ast.max === undefined) {
          const split = this.emit({ op: 'jmp', to: 0 });
          this.compile(ast.item);
          this.emit({ op: 'jmp', to: split });
          this.patch(split, { op: 'split', a: split + 1, b: this.program.length });
        } else {
          const splits: number[] = [];
          for (let n = ast.min; n < ast.max; n++) {
            splits.push(this.emit({ op: 'jmp', to: 0 }));
            this.compile(ast.item);
          }
          for (const split of splits) {
            this.patch(split, { op: 'split', a: split + 1, b: this.program.length });
          }
        }
        return;
      }
    }
  }
}

function isWordChar(code: number | undefined): boolean {
  return code !== undefined && ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95);
}

function inSet(set: string, ch: string, code: number): boolean {
  switch (set) {
    case 'd':
      return code >= 48 && code <= 57;
    case 'D':
      return !(code >= 48 && code <= 57);
    case 'w':
      return isWordChar(code);
    case 'W':
      return !isWordChar(code);
    case 's':
      return /\s/u.test(ch);
    default:
      return !/\s/u.test(ch);
  }
}

function testChar(test: CharTest, ch: string, code: number): boolean {
  switch (test.t) {
    case 'char':
      return test.c === ch;
    case 'any':
      return true;
    case 'class': {
      let hit = test.sets.some((set) => inSet(set, ch, code));
      if (!hit) {
        for (const [low, high] of test.ranges) {
          if (code >= low && code <= high) {
            hit = true;
            break;
          }
        }
      }
      return hit !== test.negate;
    }
  }
}

/** A compiled grep pattern with a step budget shared by every line it tests. */
export interface DocsMatcher {
  /** The pattern as given. */
  readonly pattern: string;
  /** Whether the pattern ran as plain text because it was not a supported regular expression. */
  readonly literal: boolean;
  /** Whether a line matches. Throws MatchBudgetError when the call's budget is spent or its signal aborted. */
  test(line: string): boolean;
}

/** Compiles a grep pattern, falling back to plain text for one that does not parse. */
export function compileMatcher(pattern: string, budgetSteps: number, signal: AbortSignal): DocsMatcher {
  let program: Instruction[];
  let literal = false;
  try {
    const compiler = new Compiler();
    compiler.compile(new Parser(pattern).parse());
    compiler.emit({ op: 'match' });
    program = compiler.program;
  } catch (error) {
    if (!(error instanceof PatternSyntaxError)) {
      throw error;
    }
    literal = true;
    const compiler = new Compiler();
    compiler.compile({ k: 'seq', items: Array.from(pattern).map((c): Ast => ({ k: 'test', test: { t: 'char', c: c.toLowerCase() } })) });
    compiler.emit({ op: 'match' });
    program = compiler.program;
  }

  let steps = 0;
  const size = program.length;
  let current = new Int32Array(size);
  let next = new Int32Array(size);
  const seen = new Int32Array(size);
  let generation = 0;

  return {
    pattern,
    literal,
    test(line: string): boolean {
      if (signal.aborted) {
        throw new MatchBudgetError('The grep was cancelled.');
      }
      const chars = Array.from(line.toLowerCase());
      let currentCount: number;
      let nextCount: number;

      // Follows jumps and zero-width tests from pc, adding the character tests reached.
      const add = (list: Int32Array, count: number, start: number, pos: number): number => {
        const stack = [start];
        let n = count;
        while (stack.length > 0) {
          const pc = stack.pop();
          if (pc === undefined || seen[pc] === generation) {
            continue;
          }
          seen[pc] = generation;
          steps++;
          const instruction = program[pc];
          if (instruction === undefined) {
            continue;
          }
          switch (instruction.op) {
            case 'jmp':
              stack.push(instruction.to);
              break;
            case 'split':
              stack.push(instruction.b, instruction.a);
              break;
            case 'bol':
              if (pos === 0) {
                stack.push(pc + 1);
              }
              break;
            case 'eol':
              if (pos === chars.length) {
                stack.push(pc + 1);
              }
              break;
            case 'word': {
              const before = isWordChar(pos > 0 ? chars[pos - 1]?.codePointAt(0) : undefined);
              const after = isWordChar(pos < chars.length ? chars[pos]?.codePointAt(0) : undefined);
              if ((before !== after) !== instruction.negate) {
                stack.push(pc + 1);
              }
              break;
            }
            default:
              list[n++] = pc;
              break;
          }
        }
        return n;
      };

      generation++;
      currentCount = add(current, 0, 0, 0);
      for (let pos = 0; ; pos++) {
        if (steps > budgetSteps) {
          throw new MatchBudgetError('The pattern took too long to match. Use a simpler one or a narrower folder.');
        }
        for (let i = 0; i < currentCount; i++) {
          const pc = current[i];
          if (pc !== undefined && program[pc]?.op === 'match') {
            return true;
          }
        }
        if (pos >= chars.length) {
          return false;
        }
        const ch = chars[pos] ?? '';
        const code = ch.codePointAt(0) ?? 0;
        generation++;
        nextCount = 0;
        for (let i = 0; i < currentCount; i++) {
          const pc = current[i];
          const instruction = pc === undefined ? undefined : program[pc];
          steps++;
          if (pc !== undefined && instruction?.op === 'test' && testChar(instruction.test, ch, code)) {
            nextCount = add(next, nextCount, pc + 1, pos + 1);
          }
        }
        // An unanchored search: a match may also start at the next character.
        nextCount = add(next, nextCount, 0, pos + 1);
        [current, next] = [next, current];
        currentCount = nextCount;
      }
    },
  };
}
