// Node has WebAssembly at runtime, but @types/node does not declare it and
// lib.dom would bring the whole browser with it. This is the part ScriptBox
// uses, typed, and checked once when the module loads.
import { isRecord } from './json.ts';

declare const moduleBrand: unique symbol;

/** A compiled WebAssembly module. */
export interface WasmModule {
  readonly [moduleBrand]: true;
}

export interface WasmMemory {
  readonly buffer: ArrayBuffer;
}

export interface WasmModuleEntry {
  readonly module?: string;
  readonly name: string;
  readonly kind: string;
}

interface WasmApi {
  compile(bytes: Uint8Array): Promise<unknown>;
  readonly Module: {
    imports(module: WasmModule): unknown;
    exports(module: WasmModule): unknown;
  };
  readonly Memory: new (descriptor: { initial: number; maximum: number }) => unknown;
  readonly Instance: new (module: WasmModule, imports: Readonly<Record<string, Readonly<Record<string, unknown>>>>) => unknown;
}

function isWasmApi(value: unknown): value is WasmApi {
  return isRecord(value)
    && typeof value['compile'] === 'function'
    && typeof value['Module'] === 'function'
    && typeof value['Memory'] === 'function'
    && typeof value['Instance'] === 'function';
}

const api: unknown = Reflect.get(globalThis, 'WebAssembly');
if (!isWasmApi(api)) {
  throw new Error('This JavaScript runtime has no WebAssembly.');
}
const wasm = api;
const moduleClass: unknown = wasm.Module;
const memoryClass: unknown = wasm.Memory;

export function isWasmModule(value: unknown): value is WasmModule {
  return typeof moduleClass === 'function' && value instanceof moduleClass;
}

function isMemory(value: unknown): value is WasmMemory {
  return typeof memoryClass === 'function' && value instanceof memoryClass;
}

function entries(value: unknown): WasmModuleEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const items: unknown[] = value;
  return items.flatMap((item) => isRecord(item) && typeof item['name'] === 'string' && typeof item['kind'] === 'string'
    ? [{ name: item['name'], kind: item['kind'], ...(typeof item['module'] === 'string' ? { module: item['module'] } : {}) }]
    : []);
}

export async function compileModule(bytes: Uint8Array): Promise<WasmModule> {
  const module: unknown = await wasm.compile(bytes);
  if (!isWasmModule(module)) {
    throw new Error('WebAssembly.compile did not return a module.');
  }
  return module;
}

export function moduleImports(module: WasmModule): WasmModuleEntry[] {
  return entries(wasm.Module.imports(module));
}

export function moduleExports(module: WasmModule): WasmModuleEntry[] {
  return entries(wasm.Module.exports(module));
}

export function createMemory(initialPages: number, maximumPages: number): WasmMemory {
  const memory: unknown = new wasm.Memory({ initial: initialPages, maximum: maximumPages });
  if (!isMemory(memory)) {
    throw new Error('WebAssembly.Memory did not return a memory.');
  }
  return memory;
}

/** Instantiates a module and returns its exports. */
export function instantiate(module: WasmModule, imports: Readonly<Record<string, Readonly<Record<string, unknown>>>>): Readonly<Record<string, unknown>> {
  const instance: unknown = new wasm.Instance(module, imports);
  const exports: unknown = Reflect.get(Object(instance), 'exports');
  if (!isRecord(exports)) {
    throw new Error('The WebAssembly instance has no exports.');
  }
  return exports;
}
