import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ProtocolMismatchError } from './errors.ts';
import { buildInfo } from './generated/build-info.ts';
import { compileModule, moduleExports, moduleImports, type WasmModule } from './wasm.ts';

/** The guest's imports, all of which the guest worker provides. Anything else means another build. */
const expectedImports: readonly string[] = [
  'env.memory:memory',
  'host.error:function',
  'host.interrupt:function',
  'host.limit:function',
  'host.log:function',
  'host.post:function',
  'host.result:function',
  'wasi_snapshot_preview1.args_get:function',
  'wasi_snapshot_preview1.args_sizes_get:function',
  'wasi_snapshot_preview1.clock_time_get:function',
  'wasi_snapshot_preview1.fd_close:function',
  'wasi_snapshot_preview1.fd_seek:function',
  'wasi_snapshot_preview1.fd_write:function',
  'wasi_snapshot_preview1.poll_oneoff:function',
  'wasi_snapshot_preview1.proc_exit:function',
];

const requiredExports: readonly string[] = ['sb_abi_version', 'sb_alloc', 'sb_free', 'sb_init', 'sb_eval', 'sb_resume', 'sb_finish'];

export interface RuntimeAssets {
  readonly module: WasmModule;
  readonly bootstrapCode: string;
}

let loading: Promise<RuntimeAssets> | undefined;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Loads the guest module and bootstrap that ship in this package, once per
 * process. Both are checked against the digests recorded when the package was
 * built, and the module's imports against the list the guest worker provides,
 * so a swapped or stale file stops the runtime instead of running.
 */
export function loadAssets(): Promise<RuntimeAssets> {
  loading ??= load().catch((error: unknown) => {
    loading = undefined;
    throw error;
  });
  return loading;
}

async function load(): Promise<RuntimeAssets> {
  const [wasm, bootstrap] = await Promise.all([
    readFile(new URL(`./assets/${buildInfo.artifact.file}`, import.meta.url)),
    readFile(new URL(`./assets/${buildInfo.bootstrap.file}`, import.meta.url)),
  ]);
  if (sha256(wasm) !== buildInfo.artifact.sha256) {
    throw new ProtocolMismatchError(`${buildInfo.artifact.file} does not match the digest this package was built with.`);
  }
  if (sha256(bootstrap) !== buildInfo.bootstrap.sha256) {
    throw new ProtocolMismatchError(`${buildInfo.bootstrap.file} does not match the digest this package was built with.`);
  }
  const module = await compileModule(wasm);
  const imports = moduleImports(module).map((i) => `${i.module ?? ''}.${i.name}:${i.kind}`).sort();
  if (imports.join('\n') !== [...expectedImports].sort().join('\n')) {
    throw new ProtocolMismatchError(`${buildInfo.artifact.file} imports something the guest worker does not provide: ${imports.join(', ')}.`);
  }
  const exports = new Set(moduleExports(module).filter((e) => e.kind === 'function').map((e) => e.name));
  const missing = requiredExports.filter((name) => !exports.has(name));
  if (missing.length > 0) {
    throw new ProtocolMismatchError(`${buildInfo.artifact.file} does not export ${missing.join(', ')}.`);
  }
  return { module, bootstrapCode: bootstrap.toString('utf8') };
}
