import { ScriptBoxConfigurationError } from './errors.ts';
import { isRecord, utf8Length, type JsonValue } from './json.ts';
import { contractLimits } from './limits.ts';

/**
 * The part of JSON Schema a method contract may use, compiled once at
 * registration. Every keyword outside it is rejected then, with its path,
 * rather than ignored at run time.
 *
 * Objects are closed. An argument with a property the schema does not declare
 * is rejected; a handler's result is projected onto the declared properties,
 * so private fields of an in-memory object never reach a script.
 */
export type SchemaNode =
  | StringNode
  | NumberNode
  | BooleanNode
  | NullNode
  | LiteralNode
  | EnumNode
  | ArrayNode
  | ObjectNode
  | RecordNode
  | UnionNode
  | AnyJsonNode;

interface NodeBase {
  readonly description: string | undefined;
  /** A name for the declarations, from `$id` or `title`. */
  readonly typeName: string | undefined;
  readonly defaultValue: JsonValue | undefined;
}

export interface StringNode extends NodeBase {
  readonly kind: 'string';
  readonly minLength: number | undefined;
  readonly maxLength: number | undefined;
  readonly pattern: RegExp | undefined;
}

export interface NumberNode extends NodeBase {
  readonly kind: 'number';
  readonly integer: boolean;
  readonly minimum: number | undefined;
  readonly maximum: number | undefined;
  readonly exclusiveMinimum: number | undefined;
  readonly exclusiveMaximum: number | undefined;
}

export interface BooleanNode extends NodeBase {
  readonly kind: 'boolean';
}

export interface NullNode extends NodeBase {
  readonly kind: 'null';
}

export interface LiteralNode extends NodeBase {
  readonly kind: 'literal';
  readonly value: string | number | boolean | null;
}

export interface EnumNode extends NodeBase {
  readonly kind: 'enum';
  readonly values: readonly (string | number | boolean | null)[];
}

export interface ArrayNode extends NodeBase {
  readonly kind: 'array';
  readonly items: SchemaNode;
  readonly minItems: number | undefined;
  readonly maxItems: number | undefined;
}

export interface PropertyNode {
  readonly name: string;
  readonly node: SchemaNode;
  readonly required: boolean;
}

export interface ObjectNode extends NodeBase {
  readonly kind: 'object';
  readonly properties: readonly PropertyNode[];
}

export interface RecordNode extends NodeBase {
  readonly kind: 'record';
  readonly values: SchemaNode;
  readonly maxProperties: number | undefined;
}

export interface UnionNode extends NodeBase {
  readonly kind: 'union';
  readonly options: readonly SchemaNode[];
  /** The property whose literal value picks the option, when every option is an object that has one. */
  readonly discriminator: string | undefined;
}

/** `{}`: any JSON value, checked only for having an exact JSON form. */
export interface AnyJsonNode extends NodeBase {
  readonly kind: 'json';
}

const metadataKeys = new Set(['description', 'title', '$id', 'default', 'examples', '$comment', 'deprecated']);
const allowedKeys: Readonly<Record<string, ReadonlySet<string>>> = {
  string: new Set(['type', 'minLength', 'maxLength', 'pattern']),
  number: new Set(['type', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']),
  integer: new Set(['type', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']),
  boolean: new Set(['type']),
  null: new Set(['type']),
  array: new Set(['type', 'items', 'minItems', 'maxItems']),
  object: new Set(['type', 'properties', 'required', 'additionalProperties']),
  record: new Set(['type', 'patternProperties', 'maxProperties']),
  literal: new Set(['type', 'const']),
  enum: new Set(['type', 'enum']),
  union: new Set(['anyOf']),
  json: new Set<string>(),
};

const identifierPattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

interface CompileState {
  nodes: number;
}

/** Compiles one schema, throwing a configuration error that names the path of anything unsupported. */
export function compileSchema(schema: unknown, path: string): SchemaNode {
  return compileNode(schema, path, 0, { nodes: 0 });
}

function fail(path: string, message: string): never {
  throw new ScriptBoxConfigurationError(`${path}: ${message}`);
}

function compileNode(schema: unknown, path: string, depth: number, state: CompileState): SchemaNode {
  if (!isRecord(schema)) {
    fail(path, 'a schema must be an object.');
  }
  if (depth > contractLimits.schemaDepth) {
    fail(path, `schemas may nest at most ${contractLimits.schemaDepth} levels.`);
  }
  state.nodes++;
  if (state.nodes > contractLimits.schemaNodesPerMethod) {
    fail(path, `a method's schemas may have at most ${contractLimits.schemaNodesPerMethod} nodes.`);
  }

  const kind = classify(schema, path);
  for (const key of Object.keys(schema)) {
    if (!metadataKeys.has(key) && !(allowedKeys[kind]?.has(key) ?? false)) {
      fail(path, `the keyword '${key}' is not supported for a ${kind} schema. ScriptBox supports a closed subset of JSON Schema; see the README.`);
    }
  }

  const description = optionalString(schema, 'description', path);
  if (description !== undefined && utf8Length(description) > contractLimits.descriptionBytes) {
    fail(path, `a description may be at most ${contractLimits.descriptionBytes} bytes.`);
  }
  const typeName = typeNameOf(schema, path);
  const base = { description, typeName, defaultValue: undefined };

  let node: SchemaNode;
  switch (kind) {
    case 'string':
      node = {
        ...base,
        kind,
        minLength: optionalCount(schema, 'minLength', path),
        maxLength: optionalCount(schema, 'maxLength', path),
        pattern: optionalPattern(schema, path),
      };
      break;
    case 'number':
    case 'integer':
      node = {
        ...base,
        kind: 'number',
        integer: kind === 'integer',
        minimum: optionalNumber(schema, 'minimum', path),
        maximum: optionalNumber(schema, 'maximum', path),
        exclusiveMinimum: optionalNumber(schema, 'exclusiveMinimum', path),
        exclusiveMaximum: optionalNumber(schema, 'exclusiveMaximum', path),
      };
      break;
    case 'boolean':
      node = { ...base, kind };
      break;
    case 'null':
      node = { ...base, kind };
      break;
    case 'literal':
      node = { ...base, kind, value: literalValue(schema['const'], `${path}.const`) };
      break;
    case 'enum': {
      const values = schema['enum'];
      if (!Array.isArray(values) || values.length === 0) {
        fail(path, 'enum must be a non-empty array.');
      }
      node = { ...base, kind, values: values.map((value, i) => literalValue(value, `${path}.enum[${i}]`)) };
      break;
    }
    case 'array':
      node = {
        ...base,
        kind,
        items: compileNode(schema['items'], `${path}.items`, depth + 1, state),
        minItems: optionalCount(schema, 'minItems', path),
        maxItems: optionalCount(schema, 'maxItems', path),
      };
      break;
    case 'object':
      node = { ...base, kind, properties: compileProperties(schema, path, depth, state) };
      break;
    case 'record': {
      const patterns = schema['patternProperties'];
      if (!isRecord(patterns)) {
        fail(path, 'patternProperties must be an object.');
      }
      const keys = Object.keys(patterns);
      const only = keys[0];
      if (keys.length !== 1 || only === undefined || (only !== '^.*$' && only !== '^(.*)$')) {
        fail(path, 'only a record with string keys (patternProperties { "^.*$": ... }) is supported.');
      }
      node = {
        ...base,
        kind,
        values: compileNode(patterns[only], `${path}.patternProperties`, depth + 1, state),
        maxProperties: optionalCount(schema, 'maxProperties', path),
      };
      break;
    }
    case 'union': {
      const options = schema['anyOf'];
      if (!Array.isArray(options) || options.length < 2) {
        fail(path, 'anyOf must list at least two schemas.');
      }
      const compiled = options.map((option, i) => compileNode(option, `${path}.anyOf[${i}]`, depth + 1, state));
      node = { ...base, kind, options: compiled, discriminator: discriminatorOf(compiled, path) };
      break;
    }
    case 'json':
      node = { ...base, kind };
      break;
    default:
      fail(path, `unexpected schema kind ${kind}.`);
  }

  if ('default' in schema) {
    const value = schema['default'];
    const issues: Issue[] = [];
    const checked = validateInput(node, value, `${path}.default`, issues);
    if (issues.length > 0 || checked === invalid) {
      fail(path, `the default does not match the schema: ${issues.map((i) => i.message).join('; ')}`);
    }
    node = { ...node, defaultValue: checked };
  }
  return node;
}

function classify(schema: Readonly<Record<string, unknown>>, path: string): string {
  if ('anyOf' in schema) {
    return 'union';
  }
  for (const unsupported of ['oneOf', 'allOf', 'not', 'if', '$ref', '$defs', 'definitions', 'prefixItems', 'format', 'contentEncoding']) {
    if (unsupported in schema) {
      fail(path, `the keyword '${unsupported}' is not supported. ScriptBox supports a closed subset of JSON Schema; see the README.`);
    }
  }
  if ('const' in schema) {
    return 'literal';
  }
  if ('enum' in schema) {
    return 'enum';
  }
  const type = schema['type'];
  if (type === undefined) {
    return 'json';
  }
  if (typeof type !== 'string') {
    fail(path, 'type must be a single string; use anyOf for a union.');
  }
  switch (type) {
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'null':
    case 'array':
      return type;
    case 'object':
      return 'patternProperties' in schema ? 'record' : 'object';
    case 'void':
    case 'undefined':
      return fail(path, `the type '${type}' has no JSON form. Leave out a method's result schema when it returns nothing.`);
    default:
      return fail(path, `the type '${type}' is not supported.`);
  }
}

function compileProperties(schema: Readonly<Record<string, unknown>>, path: string, depth: number, state: CompileState): PropertyNode[] {
  const additional = schema['additionalProperties'];
  if (additional !== undefined && additional !== false) {
    fail(path, 'objects are closed: additionalProperties may only be false. Use a record for open keys.');
  }
  const properties = schema['properties'] ?? {};
  if (!isRecord(properties)) {
    fail(path, 'properties must be an object.');
  }
  const required = schema['required'] ?? [];
  if (!Array.isArray(required) || !required.every((name): name is string => typeof name === 'string')) {
    fail(path, 'required must be an array of property names.');
  }
  for (const name of required) {
    if (!(name in properties)) {
      fail(path, `'${name}' is required but not declared.`);
    }
  }
  return Object.entries(properties).map(([name, property]) => ({
    name,
    node: compileNode(property, `${path}.${name}`, depth + 1, state),
    required: required.includes(name),
  }));
}

function discriminatorOf(options: readonly SchemaNode[], path: string): string | undefined {
  const objects = options.filter((o): o is ObjectNode => o.kind === 'object');
  if (objects.length === 0) {
    return undefined;
  }
  if (objects.length !== options.filter((o) => o.kind !== 'null').length) {
    fail(path, 'a union may mix objects only with null; give every option an object shape.');
  }
  const first = objects[0];
  if (first === undefined) {
    return undefined;
  }
  for (const candidate of first.properties) {
    if (!candidate.required || candidate.node.kind !== 'literal') {
      continue;
    }
    const values = new Set<unknown>();
    const works = objects.every((option) => {
      const property = option.properties.find((p) => p.name === candidate.name);
      if (property?.required !== true || property.node.kind !== 'literal' || values.has(property.node.value)) {
        return false;
      }
      values.add(property.node.value);
      return true;
    });
    if (works) {
      return candidate.name;
    }
  }
  if (objects.length === 1) {
    return undefined;
  }
  return fail(path, 'a union of objects needs a discriminant: a required property with a different literal value in each option.');
}

function typeNameOf(schema: Readonly<Record<string, unknown>>, path: string): string | undefined {
  const name = schema['$id'] ?? schema['title'];
  if (name === undefined) {
    return undefined;
  }
  if (typeof name !== 'string' || !identifierPattern.test(name)) {
    fail(path, '$id or title names a declared type and must be a TypeScript identifier.');
  }
  return name;
}

function optionalString(schema: Readonly<Record<string, unknown>>, key: string, path: string): string | undefined {
  const value = schema[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    fail(path, `${key} must be a string.`);
  }
  return value;
}

function optionalNumber(schema: Readonly<Record<string, unknown>>, key: string, path: string): number | undefined {
  const value = schema[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(path, `${key} must be a finite number.`);
  }
  return value;
}

function optionalCount(schema: Readonly<Record<string, unknown>>, key: string, path: string): number | undefined {
  const value = optionalNumber(schema, key, path);
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    fail(path, `${key} must be a non-negative integer.`);
  }
  return value;
}

function optionalPattern(schema: Readonly<Record<string, unknown>>, path: string): RegExp | undefined {
  const source = optionalString(schema, 'pattern', path);
  if (source === undefined) {
    return undefined;
  }
  try {
    return new RegExp(source, 'u');
  } catch {
    return fail(path, `pattern '${source}' is not a valid regular expression.`);
  }
}

function literalValue(value: unknown, path: string): string | number | boolean | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
    return value;
  }
  return fail(path, 'a literal must be a string, finite number, boolean or null.');
}

// ---------- Validation ----------

export interface Issue {
  readonly path: string;
  readonly message: string;
}

/** Returned by the validators when a value fails; the reasons are in the issues list. */
export const invalid: unique symbol = Symbol('invalid');

const maxIssues = 8;

function report(issues: Issue[], path: string, message: string): typeof invalid {
  if (issues.length < maxIssues) {
    issues.push({ path, message: `${path} ${message}` });
  }
  return invalid;
}

export function describeValue(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'an array';
  }
  switch (typeof value) {
    case 'string':
      return 'a string';
    case 'number':
      return Number.isFinite(value) ? 'a number' : String(value);
    case 'boolean':
      return 'a boolean';
    case 'undefined':
      return 'undefined';
    case 'object':
      return 'an object';
    case 'bigint':
      return 'a BigInt';
    case 'function':
      return 'a function';
    default:
      return 'a symbol';
  }
}

function codePoints(text: string, stopAfter: number): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // A surrogate pair is one code point.
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        i++;
      }
    }
    count++;
    if (count > stopAfter) {
      break;
    }
  }
  return count;
}

function checkString(node: StringNode, value: string, path: string, issues: Issue[]): string | typeof invalid {
  if (node.minLength !== undefined && codePoints(value, node.minLength) < node.minLength) {
    return report(issues, path, `must be at least ${node.minLength} characters long.`);
  }
  if (node.maxLength !== undefined && codePoints(value, node.maxLength) > node.maxLength) {
    return report(issues, path, `must be at most ${node.maxLength} characters long.`);
  }
  if (node.pattern !== undefined && !node.pattern.test(value)) {
    return report(issues, path, `must match the pattern ${node.pattern.source}.`);
  }
  return value;
}

function checkNumber(node: NumberNode, value: number, path: string, issues: Issue[]): number | typeof invalid {
  if (!Number.isFinite(value)) {
    return report(issues, path, 'must be a finite number.');
  }
  if (node.integer && !Number.isSafeInteger(value)) {
    return report(issues, path, 'must be an integer between -(2^53 - 1) and 2^53 - 1.');
  }
  if (node.minimum !== undefined && value < node.minimum) {
    return report(issues, path, `must be at least ${node.minimum}.`);
  }
  if (node.maximum !== undefined && value > node.maximum) {
    return report(issues, path, `must be at most ${node.maximum}.`);
  }
  if (node.exclusiveMinimum !== undefined && value <= node.exclusiveMinimum) {
    return report(issues, path, `must be more than ${node.exclusiveMinimum}.`);
  }
  if (node.exclusiveMaximum !== undefined && value >= node.exclusiveMaximum) {
    return report(issues, path, `must be less than ${node.exclusiveMaximum}.`);
  }
  return value;
}

function expected(node: SchemaNode): string {
  switch (node.kind) {
    case 'string':
      return 'a string';
    case 'number':
      return node.integer ? 'an integer' : 'a number';
    case 'boolean':
      return 'a boolean';
    case 'null':
      return 'null';
    case 'literal':
      return JSON.stringify(node.value);
    case 'enum':
      return `one of ${node.values.map((v) => JSON.stringify(v)).join(', ')}`;
    case 'array':
      return 'an array';
    case 'object':
    case 'record':
      return 'an object';
    case 'union':
      return node.options.map(expected).join(' or ');
    case 'json':
      return 'a JSON value';
  }
}

function propertyPath(path: string, name: string): string {
  return identifierPattern.test(name) ? `${path}.${name}` : `${path}[${JSON.stringify(name)}]`;
}

/**
 * Checks a value a script sent against a schema and returns it with defaults
 * filled in. The value came from JSON text, so it holds only JSON types; an
 * object property the schema does not declare is an error.
 */
export function validateInput(node: SchemaNode, value: unknown, path: string, issues: Issue[]): JsonValue | typeof invalid {
  switch (node.kind) {
    case 'string':
      return typeof value === 'string' ? checkString(node, value, path, issues) : mismatch(node, value, path, issues);
    case 'number':
      return typeof value === 'number' ? checkNumber(node, value, path, issues) : mismatch(node, value, path, issues);
    case 'boolean':
      return typeof value === 'boolean' ? value : mismatch(node, value, path, issues);
    case 'null':
      return value === null ? null : mismatch(node, value, path, issues);
    case 'literal':
      return value === node.value ? node.value : mismatch(node, value, path, issues);
    case 'enum':
      for (const option of node.values) {
        if (option === value) {
          return option;
        }
      }
      return mismatch(node, value, path, issues);
    case 'array': {
      if (!Array.isArray(value)) {
        return mismatch(node, value, path, issues);
      }
      const items: unknown[] = value;
      if (node.minItems !== undefined && items.length < node.minItems) {
        return report(issues, path, `must have at least ${node.minItems} items.`);
      }
      if (node.maxItems !== undefined && items.length > node.maxItems) {
        return report(issues, path, `must have at most ${node.maxItems} items.`);
      }
      const result: JsonValue[] = [];
      let failed = false;
      for (let i = 0; i < items.length; i++) {
        const item = validateInput(node.items, items[i], `${path}[${i}]`, issues);
        if (item === invalid) {
          failed = true;
          if (issues.length >= maxIssues) {
            break;
          }
        } else {
          result.push(item);
        }
      }
      return failed ? invalid : result;
    }
    case 'object': {
      if (!isRecord(value)) {
        return mismatch(node, value, path, issues);
      }
      const result: Record<string, JsonValue> = {};
      let failed = false;
      for (const key of Object.keys(value)) {
        if (!node.properties.some((p) => p.name === key)) {
          failed = true;
          report(issues, propertyPath(path, key), `is not a known property. Expected ${node.properties.map((p) => p.name).join(', ') || 'no properties'}.`);
        }
      }
      for (const property of node.properties) {
        const itemPath = propertyPath(path, property.name);
        if (!Object.hasOwn(value, property.name)) {
          if (property.node.defaultValue !== undefined) {
            result[property.name] = structuredClone(property.node.defaultValue);
          } else if (property.required) {
            failed = true;
            report(issues, itemPath, 'is required.');
          }
          continue;
        }
        const item = validateInput(property.node, value[property.name], itemPath, issues);
        if (item === invalid) {
          failed = true;
        } else {
          result[property.name] = item;
        }
      }
      return failed ? invalid : result;
    }
    case 'record': {
      if (!isRecord(value)) {
        return mismatch(node, value, path, issues);
      }
      const keys = Object.keys(value);
      if (node.maxProperties !== undefined && keys.length > node.maxProperties) {
        return report(issues, path, `must have at most ${node.maxProperties} properties.`);
      }
      const result: Record<string, JsonValue> = {};
      let failed = false;
      for (const key of keys) {
        const item = validateInput(node.values, value[key], propertyPath(path, key), issues);
        if (item === invalid) {
          failed = true;
        } else {
          result[key] = item;
        }
      }
      return failed ? invalid : result;
    }
    case 'union':
      return validateUnion(node, value, path, issues, validateInput);
    case 'json':
      return copyJson(value, path, issues, 0);
  }
}

function mismatch(node: SchemaNode, value: unknown, path: string, issues: Issue[]): typeof invalid {
  return report(issues, path, `must be ${expected(node)}, not ${describeValue(value)}.`);
}

type Validator = (node: SchemaNode, value: unknown, path: string, issues: Issue[]) => JsonValue | typeof invalid;

function validateUnion(node: UnionNode, value: unknown, path: string, issues: Issue[], validate: Validator): JsonValue | typeof invalid {
  if (node.discriminator !== undefined && isRecord(value)) {
    const tag = value[node.discriminator];
    const option = node.options.find((o) =>
      o.kind === 'object' && o.properties.some((p) => p.name === node.discriminator && p.node.kind === 'literal' && p.node.value === tag));
    if (option === undefined) {
      const tags = node.options.flatMap((o) =>
        o.kind === 'object' ? o.properties.filter((p) => p.name === node.discriminator).map((p) => p.node.kind === 'literal' ? JSON.stringify(p.node.value) : '') : []);
      return report(issues, propertyPath(path, node.discriminator), `must be one of ${tags.join(', ')}.`);
    }
    return validate(option, value, path, issues);
  }
  for (const option of node.options) {
    const attempt: Issue[] = [];
    const result = validate(option, value, path, attempt);
    if (result !== invalid) {
      return result;
    }
  }
  return mismatch(node, value, path, issues);
}

function copyJson(value: unknown, path: string, issues: Issue[], depth: number, budget?: Budget): JsonValue | typeof invalid {
  if (depth > 64) {
    return report(issues, path, 'nests too deeply.');
  }
  if (value === null || typeof value === 'boolean') {
    if (budget !== undefined) {
      spend(budget, 5);
    }
    return value;
  }
  if (typeof value === 'string') {
    if (budget !== undefined) {
      spend(budget, utf8Length(value) + 2);
    }
    return value;
  }
  if (typeof value === 'number') {
    if (budget !== undefined) {
      spend(budget, 24);
    }
    return Number.isFinite(value) ? value : report(issues, path, `is ${String(value)}, which has no JSON form.`);
  }
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    const result: JsonValue[] = [];
    for (let i = 0; i < items.length; i++) {
      if (budget !== undefined) {
        spend(budget, 1);
      }
      const item = copyJson(items[i], `${path}[${i}]`, issues, depth + 1, budget);
      if (item === invalid) {
        return invalid;
      }
      result.push(item);
    }
    return result;
  }
  if (isRecord(value)) {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      return report(issues, path, 'is not a plain object, so it has no exact JSON form.');
    }
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) {
        continue;
      }
      if (budget !== undefined) {
        spend(budget, utf8Length(key) + 4);
      }
      const copied = copyJson(item, propertyPath(path, key), issues, depth + 1, budget);
      if (copied === invalid) {
        return invalid;
      }
      result[key] = copied;
    }
    return result;
  }
  return report(issues, path, `is ${describeValue(value)}, which has no JSON form.`);
}

/** Thrown by {@link projectOutput} when a result is larger than one message may carry. */
export class OutputTooLargeError extends Error {
  override readonly name = 'OutputTooLargeError';
}

interface Budget {
  used: number;
  readonly max: number;
  readonly seen: Set<object>;
}

function spend(budget: Budget, bytes: number): void {
  budget.used += bytes;
  if (budget.used > budget.max) {
    throw new OutputTooLargeError(`The result is larger than ${budget.max} bytes.`);
  }
}

/**
 * Turns a value trusted code produced (a handler's result, a filter's
 * replacement) into the JSON the schema declares: undeclared properties are
 * dropped, anything that does not fit is an issue. The budget stops the walk
 * as soon as the JSON would exceed `maxBytes`, so an oversized result costs no
 * more than the limit to reject.
 */
export function projectOutput(node: SchemaNode, value: unknown, path: string, issues: Issue[], maxBytes: number): JsonValue | typeof invalid {
  return project(node, value, path, issues, { used: 0, max: maxBytes, seen: new Set() });
}

function project(node: SchemaNode, value: unknown, path: string, issues: Issue[], budget: Budget): JsonValue | typeof invalid {
  switch (node.kind) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'null':
    case 'literal':
    case 'enum': {
      const result = validateInput(node, value, path, issues);
      if (result !== invalid) {
        spend(budget, typeof result === 'string' ? utf8Length(result) + 2 : 8);
      }
      return result;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        return mismatch(node, value, path, issues);
      }
      const items: unknown[] = value;
      if (node.minItems !== undefined && items.length < node.minItems) {
        return report(issues, path, `must have at least ${node.minItems} items.`);
      }
      if (node.maxItems !== undefined && items.length > node.maxItems) {
        return report(issues, path, `must have at most ${node.maxItems} items.`);
      }
      spend(budget, 2);
      const result: JsonValue[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = project(node.items, items[i], `${path}[${i}]`, issues, budget);
        if (item === invalid) {
          return invalid;
        }
        spend(budget, 1);
        result.push(item);
      }
      return result;
    }
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return mismatch(node, value, path, issues);
      }
      if (budget.seen.has(value)) {
        return report(issues, path, 'refers back to an object that contains it.');
      }
      budget.seen.add(value);
      spend(budget, 2);
      const result: Record<string, JsonValue> = {};
      for (const property of node.properties) {
        const itemPath = propertyPath(path, property.name);
        const item: unknown = Reflect.get(value, property.name);
        if (item === undefined) {
          if (property.required) {
            budget.seen.delete(value);
            return report(issues, itemPath, 'is required.');
          }
          continue;
        }
        const projected = project(property.node, item, itemPath, issues, budget);
        if (projected === invalid) {
          budget.seen.delete(value);
          return invalid;
        }
        spend(budget, utf8Length(property.name) + 4);
        result[property.name] = projected;
      }
      budget.seen.delete(value);
      return result;
    }
    case 'record': {
      if (!isRecord(value)) {
        return mismatch(node, value, path, issues);
      }
      const entries = Object.entries(value);
      if (node.maxProperties !== undefined && entries.length > node.maxProperties) {
        return report(issues, path, `must have at most ${node.maxProperties} properties.`);
      }
      if (budget.seen.has(value)) {
        return report(issues, path, 'refers back to an object that contains it.');
      }
      budget.seen.add(value);
      spend(budget, 2);
      const result: Record<string, JsonValue> = {};
      for (const [key, item] of entries) {
        if (item === undefined) {
          continue;
        }
        const projected = project(node.values, item, propertyPath(path, key), issues, budget);
        if (projected === invalid) {
          budget.seen.delete(value);
          return invalid;
        }
        spend(budget, utf8Length(key) + 4);
        result[key] = projected;
      }
      budget.seen.delete(value);
      return result;
    }
    case 'union': {
      // A failed option must not count against the budget.
      const before = budget.used;
      return validateUnion(node, value, path, issues, (option, item, itemPath, itemIssues) => {
        budget.used = before;
        return project(option, item, itemPath, itemIssues, budget);
      });
    }
    case 'json':
      return copyJson(value, path, issues, 0, budget);
  }
}
