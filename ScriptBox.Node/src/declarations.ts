import { canonicalJson, type RegisteredMethod } from './api.ts';
import { ScriptBoxConfigurationError } from './errors.ts';
import type { JsonValue } from './json.ts';
import type { SchemaNode } from './schema.ts';

/** The parts of a registered method the declarations are written from. */
export type DeclaredMethod = Pick<RegisteredMethod<never>, 'descriptor' | 'params' | 'resultNode'>;

/** A namespace as the declaration writer needs it. */
export interface DeclaredNamespace {
  readonly name: string;
  readonly description: string | undefined;
  readonly methods: readonly DeclaredMethod[];
}

const identifierPattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const jsonValueDeclaration =
  '/** Any value with an exact JSON form. */\n'
  + 'type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };\n';

/**
 * Writes TypeScript declarations for the given methods and the named types
 * they reach. Every method returns a promise, because every host call is
 * asynchronous in this host. The shapes are the wire contract: what the script
 * sends and receives, not the host's in-memory types.
 */
export function writeDeclarations(namespaces: readonly DeclaredNamespace[]): string {
  const writer = new DeclarationWriter();
  const parts: string[] = [];
  for (const ns of namespaces) {
    if (ns.methods.length > 0) {
      parts.push(writer.namespace(ns));
    }
  }
  const named = writer.namedTypes();
  const prelude = writer.usesJsonValue ? [jsonValueDeclaration] : [];
  return [...prelude, ...parts, ...named].join('\n').trimEnd() + '\n';
}

class DeclarationWriter {
  usesJsonValue = false;
  private readonly named = new Map<string, { node: SchemaNode; key: string; text: string | undefined }>();
  private readonly order: string[] = [];

  namespace(ns: DeclaredNamespace): string {
    const lines: string[] = [];
    pushDoc(lines, '', ns.description === undefined ? [] : [ns.description]);
    lines.push(`declare const ${ns.name}: {`);
    for (const method of ns.methods) {
      const d = method.descriptor;
      const doc = [d.summary];
      if (d.description !== undefined) {
        doc.push('', d.description);
      }
      for (const param of method.params) {
        const text = describe(param.node).join(' ');
        if (text.length > 0) {
          doc.push(`@param ${param.name} ${text}`);
        }
      }
      pushDoc(lines, '  ', doc);
      const signature = method.params.map((p) => `${p.name}${p.required ? '' : '?'}: ${this.type(p.node, '  ', true)}`).join(', ');
      const result = method.resultNode === undefined ? 'void' : this.type(method.resultNode, '  ', false);
      lines.push(`  ${d.name}(${signature}): Promise<${result}>;`);
    }
    lines.push('};', '');
    return lines.join('\n');
  }

  namedTypes(): string[] {
    const out: string[] = [];
    // Writing one named type can reach another, so the list may grow while it is written.
    for (let i = 0; i < this.order.length; i++) {
      const name = this.order[i];
      const entry = name === undefined ? undefined : this.named.get(name);
      if (name === undefined || entry === undefined) {
        continue;
      }
      const lines: string[] = [];
      pushDoc(lines, '', [entry.node.description, ...constraints(entry.node)].filter((t): t is string => t !== undefined));
      if (entry.node.kind === 'object') {
        lines.push(`interface ${name} ${this.objectBody(entry.node, '', true, false)}`);
      } else {
        lines.push(`type ${name} = ${this.inline(entry.node, '', false)};`);
      }
      lines.push('');
      out.push(lines.join('\n'));
    }
    return out;
  }

  /**
   * A reference to a node: its name if it has one, otherwise its shape. Named
   * types are written as results look. Where a script sends a value whose
   * schema fills in defaults, those fields are optional, so such a type is
   * written out in place instead of by name.
   */
  type(node: SchemaNode, indent: string, input: boolean): string {
    if (node.typeName !== undefined && !(input && hasDefaults(node, 0))) {
      const key = canonicalNode(node);
      const existing = this.named.get(node.typeName);
      if (existing === undefined) {
        this.named.set(node.typeName, { node, key, text: undefined });
        this.order.push(node.typeName);
      } else if (existing.key !== key) {
        throw new ScriptBoxConfigurationError(`Two different schemas are both named '${node.typeName}'.`);
      }
      return node.typeName;
    }
    return this.inline(node, indent, input);
  }

  private inline(node: SchemaNode, indent: string, input: boolean): string {
    switch (node.kind) {
      case 'string':
        return 'string';
      case 'number':
        return 'number';
      case 'boolean':
        return 'boolean';
      case 'null':
        return 'null';
      case 'literal':
        return JSON.stringify(node.value);
      case 'enum':
        return node.values.map((v) => JSON.stringify(v)).join(' | ');
      case 'array': {
        const item = this.type(node.items, indent, input);
        return /[|&]/.test(item) && !item.startsWith('{') ? `(${item})[]` : `${item}[]`;
      }
      case 'object':
        return this.objectBody(node, indent, false, input);
      case 'record':
        return `{ [key: string]: ${this.type(node.values, indent, input)} }`;
      case 'union':
        return node.options.map((o) => this.type(o, indent, input)).join(' | ');
      case 'json':
        this.usesJsonValue = true;
        return 'JsonValue';
    }
  }

  private objectBody(node: Extract<SchemaNode, { kind: 'object' }>, indent: string, alwaysMultiline: boolean, input: boolean): string {
    if (node.properties.length === 0) {
      return '{}';
    }
    const inner = `${indent}  `;
    const documented = node.properties.some((p) => describe(p.node).length > 0);
    const optional = (p: { required: boolean; node: SchemaNode }): boolean => !p.required || (input && p.node.defaultValue !== undefined);
    const fields = node.properties.map((p) => `${propertyKey(p.name)}${optional(p) ? '?' : ''}: ${this.type(p.node, inner, input)}`);
    const oneLine = `{ ${fields.join('; ')} }`;
    if (!alwaysMultiline && !documented && oneLine.length <= 80 && !oneLine.includes('\n')) {
      return oneLine;
    }
    const lines = ['{'];
    node.properties.forEach((p, i) => {
      pushDoc(lines, inner, describe(p.node));
      lines.push(`${inner}${fields[i] ?? ''};`);
    });
    lines.push(`${indent}}`);
    return lines.join('\n');
  }
}

/** What a reference to a node says about it. A named type carries its own description, so a reference to it adds only its default. */
function describe(node: SchemaNode): string[] {
  if (node.typeName !== undefined) {
    return node.defaultValue === undefined ? [] : [`@default ${JSON.stringify(node.defaultValue)}`];
  }
  return [node.description, ...constraints(node)].filter((t): t is string => t !== undefined);
}

/** Whether any field in a node's shape has a default, which makes it optional where a script sends it. */
function hasDefaults(node: SchemaNode, depth: number): boolean {
  if (depth > 64) {
    return false;
  }
  switch (node.kind) {
    case 'object':
      return node.properties.some((p) => p.node.defaultValue !== undefined || hasDefaults(p.node, depth + 1));
    case 'array':
      return hasDefaults(node.items, depth + 1);
    case 'record':
      return hasDefaults(node.values, depth + 1);
    case 'union':
      return node.options.some((o) => hasDefaults(o, depth + 1));
    default:
      return false;
  }
}

function propertyKey(name: string): string {
  return identifierPattern.test(name) ? name : JSON.stringify(name);
}

/** Constraints a type cannot express, written for the reader of the declarations. */
function constraints(node: SchemaNode): string[] {
  const notes: string[] = [];
  switch (node.kind) {
    case 'string':
      if (node.minLength !== undefined && node.maxLength !== undefined) {
        notes.push(`${node.minLength} to ${node.maxLength} characters.`);
      } else if (node.minLength !== undefined) {
        notes.push(`At least ${node.minLength} characters.`);
      } else if (node.maxLength !== undefined) {
        notes.push(`At most ${node.maxLength} characters.`);
      }
      if (node.pattern !== undefined) {
        notes.push(`Matches /${node.pattern.source}/.`);
      }
      break;
    case 'number': {
      const low = node.minimum ?? node.exclusiveMinimum;
      const high = node.maximum ?? node.exclusiveMaximum;
      const kind = node.integer ? 'An integer' : 'A number';
      if (low !== undefined && high !== undefined) {
        notes.push(`${kind} from ${low}${node.exclusiveMinimum !== undefined ? ' (exclusive)' : ''} to ${high}${node.exclusiveMaximum !== undefined ? ' (exclusive)' : ''}.`);
      } else if (low !== undefined) {
        notes.push(`${kind}, ${node.exclusiveMinimum !== undefined ? 'more than' : 'at least'} ${low}.`);
      } else if (high !== undefined) {
        notes.push(`${kind}, ${node.exclusiveMaximum !== undefined ? 'less than' : 'at most'} ${high}.`);
      } else if (node.integer) {
        notes.push('An integer.');
      }
      break;
    }
    case 'array':
      if (node.minItems !== undefined && node.maxItems !== undefined) {
        notes.push(`${node.minItems} to ${node.maxItems} items.`);
      } else if (node.minItems !== undefined) {
        notes.push(`At least ${node.minItems} items.`);
      } else if (node.maxItems !== undefined) {
        notes.push(`At most ${node.maxItems} items.`);
      }
      if (node.uniqueItems) {
        notes.push('Items must be unique (JSON structural equality).');
      }
      break;
    case 'record':
      if (node.maxProperties !== undefined) {
        notes.push(`At most ${node.maxProperties} keys.`);
      }
      break;
    default:
      break;
  }
  if (node.defaultValue !== undefined) {
    notes.push(`@default ${JSON.stringify(node.defaultValue)}`);
  }
  return notes;
}

function pushDoc(lines: string[], indent: string, text: readonly (string | undefined)[]): void {
  const content = text
    .filter((t): t is string => t !== undefined)
    .flatMap((t) => t.split('\n'))
    .map((t) => t.replaceAll('*/', '*\\/'));
  while (content.length > 0 && content[content.length - 1]?.trim() === '') {
    content.pop();
  }
  if (content.length === 0) {
    return;
  }
  if (content.length === 1) {
    lines.push(`${indent}/** ${content[0] ?? ''} */`);
    return;
  }
  lines.push(`${indent}/**`);
  for (const line of content) {
    lines.push(line.length === 0 ? `${indent} *` : `${indent} * ${line}`);
  }
  lines.push(`${indent} */`);
}

/** A stable key for a node's shape, to catch one name used for two shapes. */
function canonicalNode(node: SchemaNode): string {
  return canonicalJson(toJson(node));
}

function toJson(node: SchemaNode): JsonValue {
  switch (node.kind) {
    case 'string':
      return { kind: node.kind, min: node.minLength ?? null, max: node.maxLength ?? null, pattern: node.pattern?.source ?? null, name: node.typeName ?? null };
    case 'number':
      return { kind: node.kind, integer: node.integer, min: node.minimum ?? null, max: node.maximum ?? null, name: node.typeName ?? null };
    case 'literal':
      return { kind: node.kind, value: node.value };
    case 'enum':
      return { kind: node.kind, values: [...node.values], name: node.typeName ?? null };
    case 'array':
      return { kind: node.kind, items: toJson(node.items), uniqueItems: node.uniqueItems, name: node.typeName ?? null };
    case 'object':
      return { kind: node.kind, name: node.typeName ?? null, properties: node.properties.map((p) => ({ name: p.name, required: p.required, node: toJson(p.node) })) };
    case 'record':
      return { kind: node.kind, values: toJson(node.values), name: node.typeName ?? null };
    case 'union':
      return { kind: node.kind, options: node.options.map(toJson), name: node.typeName ?? null };
    default:
      return { kind: node.kind, name: node.typeName ?? null };
  }
}
