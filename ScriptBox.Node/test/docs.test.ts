// Acceptance 21 and 22: declarations and docs come from the registered
// contract; docs sources are bounded, lazy where the host wants, and private
// to the session that was given them.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, test } from 'node:test';
import { createApiKit, createRuntime, DocsTree, Type, type DocsEntry, type DocsSource } from '@frederik91/scriptbox';
import { completed, failed } from './helpers.ts';

const kit = createApiKit<null>();
const Shape = Type.Union([
  Type.Object({ kind: Type.Literal('circle'), radius: Type.Number({ exclusiveMinimum: 0 }) }),
  Type.Object({ kind: Type.Literal('square'), side: Type.Number({ minimum: 0 }) }),
], { $id: 'Shape', description: 'A circle or a square.' });
const geometry = kit.namespace({
  name: 'geometry',
  description: 'Measures shapes. Every unit is millimetres.',
  methods: {
    area: kit.method({
      summary: 'The area of a shape.',
      effect: 'read',
      params: {
        shape: Shape,
        precision: Type.Optional(Type.Integer({ minimum: 0, maximum: 6, default: 2, description: 'Decimal places.' })),
      },
      result: Type.Number(),
      handler: ({ shape, precision }) => Number((shape.kind === 'circle' ? Math.PI * shape.radius ** 2 : shape.side ** 2).toFixed(precision ?? 2)),
    }),
    tag: kit.method({
      summary: 'Labels a shape.',
      effect: 'draft-write',
      params: { label: Type.Object({ text: Type.String({ minLength: 1, maxLength: 40 }), color: Type.Optional(Type.Union([Type.Literal('red'), Type.Literal('green')])) }) },
      handler: () => undefined,
    }),
  },
});

const expectedGeometry = `/** Measures shapes. Every unit is millimetres. */
declare const geometry: {
  /**
   * The area of a shape.
   * @param precision Decimal places. An integer from 0 to 6. @default 2
   */
  area(shape: Shape, precision?: number): Promise<number>;
  /** Labels a shape. */
  tag(label: {
    /** 1 to 40 characters. */
    text: string;
    color?: "red" | "green";
  }): Promise<void>;
};
`;

const expectedShape = `/** A circle or a square. */
type Shape = {
  kind: "circle";
  /** A number, more than 0. */
  radius: number;
} | {
  kind: "square";
  /** A number, at least 0. */
  side: number;
};
`;

describe('declarations and generated docs (21)', () => {
  test('the declarations are written from the registered schemas, unions and optional fields included', async () => {
    const runtime = await createRuntime<null>({ apis: [geometry] });
    try {
      const declarations = runtime.getTypeScriptDeclarations((m) => m.namespace === 'geometry');
      assert.equal(declarations, `${expectedGeometry}\n${expectedShape}`);
    } finally {
      await runtime.dispose();
    }
  });

  test('the per-method docs file holds that method\'s declaration and the types it uses, and type-checks what runs', async () => {
    const runtime = await createRuntime<null>({ apis: [geometry] });
    try {
      const s = runtime.createSession({ context: null, capabilities: ['*'] });
      const files = completed(await s.execute({
        language: 'javascript',
        source: 'return (await docs.read(["/api/geometry/area.d.ts", "/api/geometry/README.md"])).map((f) => f.content);',
      }));
      assert.ok(Array.isArray(files));
      assert.match(String(files[0]), /area\(shape: Shape, precision\?: number\): Promise<number>;/);
      assert.doesNotMatch(String(files[0]), /tag\(/);
      assert.match(String(files[0]), /type Shape = \{/);
      assert.match(String(files[1]), /- `geometry\.area`: The area of a shape\./);

      assert.equal(completed(await s.execute({ language: 'typescript', source: 'return await geometry.area({ kind: "square", side: 3 });' })), 9);
      const wrong = failed(await s.execute({ language: 'typescript', source: 'return await geometry.area({ kind: "square", radius: 3 });' }));
      assert.equal(wrong.code, 'type-check');
      const badColor = failed(await s.execute({ language: 'typescript', source: 'await geometry.tag({ text: "a", color: "blue" });' }));
      assert.equal(badColor.code, 'type-check');
    } finally {
      await runtime.dispose();
    }
  });

  test('a discovery filter narrows a session\'s declarations and /api docs to what it shows', async () => {
    const runtime = await createRuntime<null>({ apis: [geometry] });
    try {
      const s = runtime.createSession({ context: null, capabilities: ['*'], discover: (m) => m.qualifiedName === 'geometry.area' });
      assert.equal(s.getTypeScriptDeclarations(), `${expectedGeometry.replace(/ {2}\/\*\* Labels a shape\. \*\/\n[\s\S]*?\): Promise<void>;\n/, '')}\n${expectedShape}`);
      const listed = completed(await s.execute({ language: 'javascript', source: 'return [(await docs.ls("/api")).map((e) => e.path), (await docs.ls("/api/geometry")).map((e) => e.path)];' }));
      assert.deepEqual(listed, [['/api/geometry'], ['/api/geometry/README.md', '/api/geometry/area.d.ts', '/api/geometry/index.d.ts']]);
    } finally {
      await runtime.dispose();
    }
  });
});

describe('docs sources and bounds (22)', () => {
  test('a lazy, asynchronous source is read on demand, through the same calls', async () => {
    const reads: string[] = [];
    const remote: DocsSource = {
      list: async (directory) => {
        await delay(10);
        return directory === '/guides' ? [{ path: '/guides/naming.md', kind: 'file', summary: 'How items are named.' }] satisfies DocsEntry[] : directory === '/' ? [{ path: '/guides', kind: 'directory', summary: 'Guides.' }] : [];
      },
      read: async (path, signal) => {
        await delay(10, undefined, { signal });
        reads.push(path);
        return path === '/guides/naming.md' ? '# Naming\nUse short names.' : undefined;
      },
      search: (query) => query.includes('nam') ? [{ path: '/guides/naming.md', summary: 'How items are named.', score: 10 }] : [],
    };
    let built = 0;
    const tree = new DocsTree().addFile('/guides/lazy.md', 'Built on first read.', () => {
      built++;
      return 'built';
    });
    const runtime = await createRuntime<null>({ apis: [geometry], docs: [remote, tree] });
    try {
      const s = runtime.createSession({ context: null, capabilities: [] });
      assert.equal(built, 0);
      const value = completed(await s.execute({
        language: 'javascript',
        source: `const ls = await docs.ls('/guides');
const files = await docs.read(['/guides/naming.md', '/guides/lazy.md', '/guides/lazy.md']);
const hits = await docs.search('naming rules');
return [ls.map((e) => e.path), files.map((f) => f.content), hits[0].path];`,
      }));
      assert.deepEqual(value, [['/guides/lazy.md', '/guides/naming.md'], ['# Naming\nUse short names.', 'built', 'built'], '/guides/naming.md']);
      assert.equal(built, 1, 'a lazy file is built once');
      assert.ok(reads.includes('/guides/naming.md'));
    } finally {
      await runtime.dispose();
    }
  });

  test('missing paths, folders and invalid paths come back as per-file errors', async () => {
    const runtime = await createRuntime<null>({ apis: [geometry] });
    try {
      const s = runtime.createSession({ context: null, capabilities: [] });
      const value = completed(await s.execute({
        language: 'javascript',
        source: 'return (await docs.read(["/api/geometry", "/nope.md", "/api/../../etc/passwd", "..\\\\secret", "/api/./geometry/README.md", "file:///etc/passwd", "/api/geometry/README.md"])).map((f) => [f.path, f.content === null, f.error === null ? null : f.error.split(".")[0]]);',
      }));
      // Each row: the path as returned, whether content is missing, and the error up to its first full stop.
      assert.deepEqual(value, [
        ['/api/geometry', true, '/api/geometry is a folder'],
        ['/nope.md', true, 'There is no file /nope'],
        ['/api/../../etc/passwd', true, 'A docs path may not contain '],
        ['..\\secret', true, 'A docs path may not contain '],
        ['/api/./geometry/README.md', true, 'A docs path may not contain '],
        ['/file:/etc/passwd', true, 'There is no file /file:/etc/passwd'],
        ['/api/geometry/README.md', false, null],
      ]);
      const folderError = completed(await s.execute({ language: 'javascript', source: 'try { await docs.ls("/../x"); } catch (e) { return e.name; }' }));
      assert.equal(folderError, 'InvalidPathError');
    } finally {
      await runtime.dispose();
    }
  });

  test('batch, result and argument bounds hold', async () => {
    const big = new DocsTree();
    for (let i = 0; i < 60; i++) {
      big.addFile(`/big/file-${String(i).padStart(2, '0')}.md`, null, `line\n${'z'.repeat(30 * 1024)}`);
    }
    const runtime = await createRuntime<null>({ apis: [geometry], docs: [big] });
    try {
      const s = runtime.createSession({ context: null, capabilities: [] });
      const value = completed(await s.execute({
        language: 'javascript',
        source: `const out = [];
try { await docs.read(Array.from({ length: 21 }, (_, i) => '/big/file-' + String(i).padStart(2, '0') + '.md')); } catch (e) { out.push(e.name); }
const files = await docs.read(Array.from({ length: 20 }, (_, i) => '/big/file-' + String(i).padStart(2, '0') + '.md'));
out.push(files.filter((f) => f.content !== null).length, files.filter((f) => f.error !== null).length);
out.push((await docs.grep('line', '/big')).length, (await docs.grep('line', '/big', 200)).length);
try { await docs.grep('line', '/', 201); } catch (e) { out.push(e.name); }
out.push((await docs.search('file')).length);
try { await docs.search('x'.repeat(513)); } catch (e) { out.push(e.name); }
try { await docs.grep('x'.repeat(257)); } catch (e) { out.push(e.name); }
return out;`,
      }));
      // A response carries at most 256 KiB, so only some of twenty 30 KiB files fit in one read.
      assert.deepEqual(value, ['InvalidArgumentsError', 8, 12, 50, 60, 'InvalidArgumentsError', 8, 'InvalidArgumentsError', 'InvalidArgumentsError']);
    } finally {
      await runtime.dispose();
    }
  });

  test('a pathological pattern is bounded and does not hold the event loop', async () => {
    const tree = new DocsTree();
    for (let i = 0; i < 50; i++) {
      tree.addFile(`/text/${i}.md`, null, `${'a'.repeat(400)}b\n`.repeat(200));
    }
    const runtime = await createRuntime<null>({ apis: [geometry], docs: [tree] });
    try {
      const s = runtime.createSession({ context: null, capabilities: [] });
      let maxGap = 0;
      let last = performance.now();
      const timer = setInterval(() => {
        const now = performance.now();
        maxGap = Math.max(maxGap, now - last);
        last = now;
      }, 5);
      const started = performance.now();
      const value = completed(await s.execute({ language: 'javascript', source: 'try { return (await docs.grep("(a+)+(a+)+c", "/text")).length; } catch (e) { return [e.name, e.message]; }' }));
      clearInterval(timer);
      const elapsed = performance.now() - started;
      // The Pike VM is linear in the text, so this finishes, finding nothing, or stops at its step budget.
      assert.ok(value === 0 || (Array.isArray(value) && value[0] === 'RangeError'), JSON.stringify(value));
      assert.ok(elapsed < 5000, `grep took ${elapsed} ms`);
      assert.ok(maxGap < 300, `the event loop stalled for ${maxGap} ms`);
    } finally {
      await runtime.dispose();
    }
  });

  test('a session\'s own docs are not visible to another session, through any docs call', async () => {
    const runtime = await createRuntime<null>({ apis: [geometry] });
    try {
      const a = runtime.createSession({ context: null, capabilities: [], docs: [new DocsTree().addFile('/notes/secret.md', 'Session A notes', 'alpha bravo')] });
      const b = runtime.createSession({ context: null, capabilities: [] });
      const off = runtime.createSession({ context: null, capabilities: ['*'], docs: false });
      const source = 'return [(await docs.ls("/")).map((e) => e.path), (await docs.grep("bravo")).length, (await docs.search("notes")).map((h) => h.path)];';
      assert.deepEqual(completed(await a.execute({ language: 'javascript', source })), [['/api', '/notes'], 1, ['/notes/secret.md']]);
      assert.deepEqual(completed(await b.execute({ language: 'javascript', source })), [['/api'], 0, []]);
      assert.equal(completed(await off.execute({ language: 'javascript', source: 'try { await docs.ls(); } catch (e) { return e.name; }' })), 'PermissionDeniedError');
    } finally {
      await runtime.dispose();
    }
  });
});
