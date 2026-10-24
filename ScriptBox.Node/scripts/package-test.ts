// Installs the packed tarball the way a consumer would and runs it in a clean
// Node 24 Linux container: no .NET, no C compiler, no WASI SDK, and no network
// while it runs. Checks what the tarball holds, type-checks a strict consumer
// project against the published declarations, and runs a consumer and the
// catalog example from a directory unrelated to the package.
//
//   npm run build && node scripts/package-test.ts
//
// Set DOCKER to choose the client, e.g. DOCKER="docker --context desktop-linux".
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// node:24-bookworm-slim, pinned. Debian with Node only: no compiler, no .NET.
const image = 'node@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205';
const [dockerCommand = 'docker', ...dockerArgs] = (process.env['DOCKER'] ?? 'docker').split(' ').filter((part) => part.length > 0);

function docker(args: readonly string[], options: { capture?: boolean } = {}): string {
  const output = execFileSync(dockerCommand, [...dockerArgs, ...args], {
    encoding: 'utf8',
    stdio: options.capture === true ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });
  return typeof output === 'string' ? output : '';
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('npm pack did not describe the tarball.');
  }
  return Object.fromEntries(Object.entries(value));
}

const work = mkdtempSync(join(tmpdir(), 'scriptbox-package-'));
try {
  // npm's own script, run with this Node. On Windows the npm command is a .cmd
  // file, which execFile cannot start without a shell.
  const npmCli = process.env['npm_execpath'] ?? (process.platform === 'win32'
    ? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  const packed: unknown = JSON.parse(execFileSync(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', work], { cwd: root, encoding: 'utf8' }));
  const first: unknown = Array.isArray(packed) ? packed[0] : undefined;
  const info = record(first);
  const filename = info['filename'];
  const files = info['files'];
  if (typeof filename !== 'string' || !Array.isArray(files)) {
    throw new Error('npm pack did not name the tarball and its files.');
  }
  const paths = files.map((file: unknown) => record(file)['path']).filter((path): path is string => typeof path === 'string');
  const required = [
    'package.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
    'dist/index.js', 'dist/index.d.ts', 'dist/guest/worker.js', 'dist/typescript/compiler-worker.js',
    'dist/assets/scriptbox-async.wasm', 'dist/assets/scriptbox.js',
  ];
  const missing = required.filter((path) => !paths.includes(path));
  const unexpected = paths.filter((path) => !path.startsWith('dist/') && !required.includes(path));
  const sources = paths.filter((path) => path.endsWith('.ts') && !path.endsWith('.d.ts'));
  if (missing.length > 0 || unexpected.length > 0 || sources.length > 0) {
    throw new Error(`The tarball is wrong. Missing: ${missing.join(', ') || 'none'}. Unexpected: ${[...unexpected, ...sources].join(', ') || 'none'}.`);
  }
  console.log(`Tarball ${filename}: ${paths.length} files, ${String(info['size'])} bytes packed, ${String(info['unpackedSize'])} unpacked.`);

  const context = join(work, 'context');
  mkdirSync(join(context, 'examples'), { recursive: true });
  for (const file of ['package.json', 'tsconfig.json', 'consumer.ts']) {
    cpSync(join(root, 'test', 'consumer', file), join(context, file));
  }
  cpSync(join(root, 'examples', 'catalog'), join(context, 'examples', 'catalog'), { recursive: true });
  cpSync(join(work, filename), join(context, 'scriptbox.tgz'));
  writeFileSync(join(context, 'Dockerfile'), `FROM ${image}
WORKDIR /work
COPY scriptbox.tgz /pkg/scriptbox.tgz
COPY package.json tsconfig.json consumer.ts ./
COPY examples ./examples
# The only step with network access: installing from the registry, as a consumer does.
RUN npm install --no-audit --no-fund --ignore-scripts /pkg/scriptbox.tgz typescript@6.0.3 @types/node@24.19.2
`);

  const tag = 'scriptbox-package-test:latest';
  docker(['build', '-q', '-t', tag, context]);
  const script = [
    'set -e',
    'cd /',
    'for tool in dotnet gcc cc clang wasm-ld; do if command -v "$tool" >/dev/null; then echo "unexpected toolchain: $tool"; exit 1; fi; done',
    'echo "toolchain: none of dotnet, gcc, cc, clang, wasm-ld"',
    'if node -e "require(\'node:dns\').lookup(\'registry.npmjs.org\', (e) => process.exit(e ? 0 : 1))"; then echo "network: off"; else echo "network: on"; exit 1; fi',
    'echo "cwd: $(pwd), node $(node --version)"',
    'node /work/node_modules/typescript/bin/tsc -p /work/tsconfig.json && echo "strict consumer type-check: ok"',
    'node /work/consumer.ts',
    'node /work/examples/catalog/main.ts',
  ].join('\n');
  docker(['run', '--rm', '--network', 'none', '--read-only', '--tmpfs', '/tmp', tag, 'sh', '-c', script]);
  console.log('Package test passed.');
} finally {
  rmSync(work, { recursive: true, force: true });
}
