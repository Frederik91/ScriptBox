// Acceptance 4 and 5: source locations, and what TypeScript and JavaScript
// scripts may not do.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createRuntime, type ScriptBoxRuntime, type Session } from '@frederik91/scriptbox';
import { completed, failed, heartbeat, limited, testApis } from './helpers.ts';

type Ctx = { readonly tenant: string };
let runtime: ScriptBoxRuntime<Ctx>;
let session: Session<Ctx>;

before(async () => {
  runtime = await createRuntime<Ctx>({ apis: [testApis().test] });
  session = runtime.createSession({ context: { tenant: 'a' }, capabilities: ['*'] });
});

after(async () => {
  await runtime.dispose();
});

describe('source locations (4)', () => {
  test('a JavaScript syntax error points at the submitted line and column', async () => {
    const error = failed(await session.execute({ language: 'javascript', source: 'const a = 1;\nconst b = ;\nreturn a;' }));
    assert.equal(error.code, 'invalid-source');
    assert.equal(error.name, 'SyntaxError');
    assert.equal(error.line, 2);
    assert.equal(error.column, 11);
  });

  test('a syntax error on the first line is not shifted by the wrapper', async () => {
    const error = failed(await session.execute({ language: 'javascript', source: 'return )' }));
    assert.equal(error.line, 1);
    assert.equal(error.column, 8);
  });

  test('a TypeScript syntax error points at the submitted source', async () => {
    const error = failed(await session.execute({ language: 'typescript', source: 'const a = 1;\nconst b = ;\nreturn a;' }));
    assert.equal(error.code, 'invalid-source');
    assert.equal(error.line, 2);
    assert.equal(error.column, 11);
    assert.equal(error.diagnostics?.[0]?.code, 1109);
  });

  test('a TypeScript type error points at the submitted source and blocks execution', async () => {
    const log: string[] = [];
    const local = await createRuntime<Ctx>({ apis: [testApis(log).test] });
    try {
      const s = local.createSession({ context: { tenant: 'a' }, capabilities: ['*'] });
      const error = failed(await s.execute({ language: 'typescript', source: 'await test.nothing();\n\nconst a: number = "s";\nreturn a;' }));
      assert.equal(error.code, 'type-check');
      assert.equal(error.line, 3);
      assert.equal(error.column, 7);
      assert.match(error.message, /not assignable to type 'number'/);
      assert.deepEqual(log, [], 'nothing ran');
    } finally {
      await local.dispose();
    }
  });

  test('a host method used with the wrong argument type is a type error', async () => {
    const error = failed(await session.execute({ language: 'typescript', source: 'return await test.wait("soon");' }));
    assert.equal(error.code, 'type-check');
    assert.equal(error.line, 1);
  });

  test('a thrown exception maps to the submitted line in JavaScript and TypeScript', async () => {
    const js = failed(await session.execute({ language: 'javascript', source: 'const x = 1;\n\nfunction f() { throw new TypeError("bad"); }\nf();' }));
    assert.equal(js.code, 'script-error');
    assert.equal(js.name, 'TypeError');
    assert.equal(js.line, 3);
    assert.match(js.stack ?? '', /at f \(script\.js:3:\d+\)/);
    assert.doesNotMatch(js.stack ?? '', /scriptbox\.js|<eval>|node:|[A-Z]:\\/);

    const ts = failed(await session.execute({ language: 'typescript', source: 'const x: number = 1;\n\nfunction f(): void { throw new TypeError("bad"); }\nf();' }));
    assert.equal(ts.line, 3);
    assert.match(ts.stack ?? '', /at f \(script\.ts:3:\d+\)/);
  });

  test('a TypeScript script needs no return', async () => {
    const outcome = await session.execute({ language: 'typescript', source: 'const x: number = 1;' });
    assert.equal(completed(outcome), null);
    assert.ok(outcome.status === 'completed' && !outcome.hasValue);
  });
});

describe('what scripts may not do (5)', () => {
  const rejected: [string, string, RegExp][] = [
    ['an import', 'import fs from "fs";\nreturn 1;', /cannot import/],
    ['an export', 'export const a = 1;', /cannot import or export/],
    ['a dynamic import', 'await import("fs");', /import\(\)/],
    ['an import type', 'let a: import("fs").Stats;', /module types/],
    ['import.meta', 'return import.meta.url;', /import\.meta/],
    ['a reference directive', '/// <reference path="/etc/passwd" />\nreturn 1;', /triple-slash/],
    ['a types directive', '/// <reference types="node" />\nreturn 1;', /triple-slash/],
    ['@ts-nocheck', '// @ts-nocheck\nreturn 1;', /@ts- comments/],
    ['@ts-ignore', '// @ts-ignore\nconst a: number = "s";', /@ts- comments/],
    ['a decorator', 'class A { @dec m() {} }', /decorators/],
    ['a namespace', 'namespace N { }', /modules or namespaces/],
  ];
  for (const [what, source, message] of rejected) {
    test(`TypeScript rejects ${what}`, async () => {
      const error = failed(await session.execute({ language: 'typescript', source }));
      assert.equal(error.code, 'invalid-source');
      assert.match(error.message, message);
    });
  }

  test('TypeScript has no require, process or Node types', async () => {
    for (const source of ['const fs = require("fs");', 'return process.env;', 'const b: Buffer = null!;']) {
      const error = failed(await session.execute({ language: 'typescript', source }));
      assert.equal(error.code, 'type-check', source);
    }
  });

  test('a compiler directive in the source is only a comment', async () => {
    // There is no way to submit a configuration; a tsconfig-looking comment changes nothing.
    const error = failed(await session.execute({ language: 'typescript', source: '/* { "compilerOptions": { "strict": false } } */\nfunction f(a) { return a; }\nreturn f(1);' }));
    assert.equal(error.code, 'type-check');
    assert.match(error.message, /implicitly has an 'any' type/);
  });

  test('JavaScript cannot load modules or reach require', async () => {
    const value = completed(await session.execute({
      language: 'javascript',
      source: 'const out = []; try { await import("fs"); out.push("loaded"); } catch (e) { out.push(e.name); } out.push(typeof require); return out;',
    }));
    assert.deepEqual(value, ['ReferenceError', 'undefined']);
  });

  test('a JavaScript import statement is a syntax error', async () => {
    const error = failed(await session.execute({ language: 'javascript', source: 'import fs from "fs";' }));
    assert.equal(error.code, 'invalid-source');
  });

  test('source over the limit is refused before compiling or running', async () => {
    const source = `return "${'x'.repeat(70 * 1024)}";`;
    for (const language of ['javascript', 'typescript'] as const) {
      const outcome = limited(await session.execute({ language, source }));
      assert.equal(outcome.limit, 'source-bytes');
      assert.equal(outcome.evidence.measurements.compileMs, null);
      assert.equal(outcome.evidence.measurements.workerStartMs, null);
    }
  });

  test('a pathological type program is stopped by the compile budget', async () => {
    // Each alias walks a 900-character template literal type one character at a
    // time: about 80 ms of checking apiece, so 200 of them run for many seconds.
    const head = [
      'type Rep<S extends string, N extends unknown[] = []> = N["length"] extends 900 ? S : Rep<`${S}x`, [...N, 0]>;',
      'type Len<S extends string, A extends unknown[] = []> = S extends `${string}${infer R}` ? Len<R, [...A, 0]> : A["length"];',
    ];
    const body = Array.from({ length: 200 }, (_, i) => `const v${i}: Len<Rep<"s${i}">> = 0 as never;`);
    const source = [...head, ...body, 'return 1;'].join('\n');
    const beat = heartbeat();
    const started = performance.now();
    const outcome = await session.execute({ language: 'typescript', source, limits: { compileTimeoutMs: 1500 } });
    const elapsed = performance.now() - started;
    const gap = beat.stop();
    assert.equal(limited(outcome).limit, 'compile-time');
    assert.ok(elapsed < 2500, `took ${elapsed} ms`);
    assert.ok(gap < 200, `the event loop stalled for ${gap} ms`);
  });

  test('a compile that runs out of compiler time ends with compile-time, and the next compile works', async () => {
    const source = Array.from({ length: 900 }, (_, i) => `const v${i}: { a: number } = { a: ${i} };`).join('\n');
    const outcome = await session.execute({ language: 'typescript', source, limits: { compileTimeoutMs: 1 } });
    assert.equal(limited(outcome).limit, 'compile-time');
    assert.equal(completed(await session.execute({ language: 'typescript', source: 'return 1 + 1;' })), 2);
  });
});
