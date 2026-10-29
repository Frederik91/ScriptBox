# @frederik91/scriptbox

Let an AI model work with your application by writing code. The model writes a short JavaScript or TypeScript program against the API you register, and ScriptBox runs it in a sandbox inside your Node.js server. The program can call only your methods, and your schemas and policies check every call before your code runs.

One program can do the work of a dozen tool calls. It can look up twenty records, work out what to change and stage that change in a single run, so the model needs no round trip per step and you get one result back. With `tasks` and `draft` namespaces registered, a run looks like this:

```ts
const outcome = await session.execute({
  language: 'typescript',
  source: `
    const overdue = await tasks.list({ status: 'open', dueBefore: '2026-11-01' });
    for (const task of overdue) {
      await draft.reassign({ id: task.id, to: 'triage' });
    }
    return { moved: overdue.length };
  `,
});
```

## Why use it

- **Scripts reach only what you register.** A script has the JavaScript language, `console` and your namespaces. It has no `process`, `require`, file system, network, timers or environment. It runs in QuickJS compiled to WebAssembly, in its own worker thread.
- **One schema per method.** You describe each method once with TypeBox. ScriptBox derives argument validation, result checks, the TypeScript declarations for the model's prompt and the docs the model can browse from that schema, so they cannot drift apart.
- **Your handlers stay async.** A handler is an ordinary async function, so a script can `await` your database, search index or HTTP service.
- **Limits a script cannot escape.** Time, memory, host calls, bytes and result size are hard limits. Cancelling stops even an endless loop or a long native operation. In the benchmark the outcome arrives within 6 ms of `abort()`.
- **Policy on every call.** Filters can let a call through, refuse it or answer in its place. Capabilities decide per request what a script may call, so a read-only session cannot write even when it finds the method in the docs.
- **Changes wait for approval.** A script stages changes in your draft. You validate the draft and apply it outside the script, so a model can propose a change but never approve one. `examples/catalog` shows the whole flow.
- **Evidence for every run.** Each outcome records every call attempt and its result, the source's hash and the versions that ran. An audit sink can stop a run when it cannot record a call.
- **Cheap enough to run per request.** A warm run takes about 22 ms and a host call about 0.08 ms on a desktop CPU. The figures and raw samples are in `bench/README.md`.
- **Plain npm.** No native code and no build tools. Node 24 or later.

It is part of [ScriptBox](https://github.com/Frederik91/ScriptBox), which also has a .NET host on NuGet.

## Requirements

- Node.js 24 or later. ESM only.
- No native code and no build tools. The package bundles its WebAssembly guest and needs no network at run time.
- Tested on Windows 11 x64 with Node 24.18.0 and on Linux x64 (Debian bookworm, `node:24-bookworm-slim`) with Node 24.22.1. Other platforms that run Node 24 should work, but they are not tested.

```sh
npm install @frederik91/scriptbox
```

## Quick start

```ts
import { createApiKit, createRuntime, ScriptApiError, Type } from '@frederik91/scriptbox';

interface RequestState { readonly notes: Map<string, string> }

const api = createApiKit<RequestState>();
const notes = api.namespace({
  name: 'notes',
  description: 'The notes of this request.',
  methods: {
    get: api.method({
      summary: 'Gets a note by id.',
      effect: 'read',
      params: { id: Type.String({ maxLength: 64 }) },
      result: Type.String(),
      handler: ({ id }, call) => {
        const note = call.context.notes.get(id);
        if (note === undefined) {
          throw new ScriptApiError({ name: 'NotFoundError', message: `There is no note '${id}'.` });
        }
        return note;
      },
    }),
  },
});

const runtime = await createRuntime<RequestState>({ apis: [notes] });
const session = runtime.createSession({ context: { notes: new Map([['a', 'hello']]) }, capabilities: ['notes.*'] });

const outcome = await session.execute({ language: 'typescript', source: 'return (await notes.get("a")).toUpperCase();' });
if (outcome.status === 'completed') {
  console.log(outcome.value); // "HELLO"
}

await session.dispose();
await runtime.dispose();
```

`examples/catalog` is a fuller example: a catalog with a draft per request, validation, proposals and acceptance outside the script. Run it with `node examples/catalog/main.ts`.

## How it fits together

1. `createRuntime` takes your namespaces, global filters, limits and docs. Create one per process.
2. `createSession` binds one request: its state (`context`), what it may call (`capabilities`), its own filters, limits and docs.
3. `session.execute` runs one script and returns one outcome. A session runs one script at a time. A second `execute` while one runs throws `SessionBusyError`; nothing queues.
4. Each execution gets a fresh worker and a fresh guest. Nothing a script defines survives into the next one.
5. `dispose` cancels what runs and refuses new work. Calling it twice is safe.

## Defining methods

`createApiKit<Context>()` returns `method` and `namespace`. A method has:

- `summary` and an optional `description`, shown in declarations and docs.
- `effect`, such as `read`, `draft-write` or `documentation`. Filters and capability rules read it. ScriptBox gives no effect special meaning.
- `params`, a TypeBox schema per parameter, in the order a script passes them. Mark trailing ones with `Type.Optional`.
- `result`, the result's schema. Leave it out for a method that returns nothing.
- `timeoutMs`, `metadata` and the `handler`.

The handler receives validated arguments by name and a `HostCall`:

| Field | Meaning |
| --- | --- |
| `context` | The session's request state. |
| `signal` | Aborts when the call loses its authority: the execution ends, the call times out, or the call itself has ended. Pass it to your I/O. |
| `deadline` | When the call must finish, in epoch milliseconds on the runtime's clock. |
| `throwIfRevoked()` | Call it right before you change state, in the same synchronous step. A call revoked while it waited then cannot write. |

To fail a call with a message the script can read and catch, throw `ScriptApiError`. Any other exception reaches the script only as `HostError` with the text "`<method>` failed on the host."; your exception goes to `onEvent` and `audit` as `hostError`.

The TypeBox schemas are the only contract. ScriptBox derives the TypeScript declarations, the generated docs, argument validation and result checks from them, so they cannot drift apart.

## The wire contract

Values cross between script and host as JSON.

- Allowed: strings, finite numbers, booleans, null, arrays and plain objects, up to 64 levels deep.
- Refused, with the path to the bad value: NaN, Infinity, BigInt, functions, symbols, class instances such as `Date` and `Map`, array holes, `undefined` inside an array, and cycles. The script sees a `TypeError` or `RangeError` and no call is made.
- A property set to `undefined` is left out.
- A trailing `undefined` argument is omitted, as is one in the middle. An omitted argument takes its schema `default`. `null` is a value, not an omission.
- Objects are closed. An argument with a property its schema does not declare fails with `InvalidArgumentsError`. A result keeps only declared properties; the rest are dropped.
- A handler result that breaks its schema fails the call with `HostError`.
- A method with no result resolves to `undefined` in the script.
- A script that returns nothing completes with `value: null` and `hasValue: false`.

Supported schema shapes: string (length, pattern), number and integer (ranges), boolean, null, literal, enum, array (item count and boolean `uniqueItems`), object, record (`Type.Record(Type.String(), ...)`), union, and any JSON (`Type.Unsafe<JsonValue>({})`). A union of objects needs a literal discriminant. `$ref`, `allOf`, `oneOf`, `not`, `if`, `format`, tuples and recursive schemas are refused when you register the method, with the path to the keyword.

Use `Type.Array(Type.String(), { uniqueItems: true, maxItems: 16 })` for a set of selector values. Uniqueness uses JSON structural equality: object property order does not matter, array order does, and `-0` equals `0`. Different JSON types stay distinct. Strings compare exactly, without Unicode normalization. Duplicate arguments fail with `InvalidArgumentsError` before the handler runs; duplicate handler or filter results fail with `HostError` and `invalid-result` evidence. `false` or omission permits duplicates. A nonboolean `uniqueItems` is refused at registration; other unsupported keywords remain refused.

Uniqueness checks the values the boundary exposes: arguments after defaults are filled in, and results after undeclared properties are projected away. For example, two result objects distinguished only by private fields are duplicates. A default that makes two argument objects equal also fails. Generated JSON schemas retain the boolean and declarations/docs describe the constraint; TypeScript array types alone cannot prove uniqueness.

The check runs after item validation and count limits, and after byte-budgeted result projection. Input message byte/depth limits still apply. One validation walk interns exact structural identities using immediate child IDs, with object keys sorted and subtree identities reused; it performs no pairwise deep comparisons and retains no identity cache across calls. Memory is proportional to the bounded validated JSON, with sorting work for object keys. No additional schema keyword or execution limit is introduced.

This keyword is enforced by the Node host. The .NET host gains no array-uniqueness option from this change; applications needing the same constraint on both hosts must enforce it there as well. The shared guest ABI, bootstrap, transport, and conformance fixtures are unchanged.

## Sessions, capabilities and discovery

`capabilities` decides what a session's scripts may call: `'*'`, `'catalog.*'`, `'catalog.get'`, or a function of the method's descriptor. A pattern that names nothing registered is a configuration error. A call outside the capabilities fails with `PermissionDeniedError`, whether the script used the namespace or the low-level `__scriptbox.hostCall`.

`discover` decides what a session's declarations and `/api` docs show. It is a prompt-size control, not an access control. A hidden method the capabilities allow still works; a hidden method they do not allow fails even when the script knows its name. TypeScript scripts are always checked against the whole contract.

`docs.*` follows the session's docs, not its capabilities. Set `docs: false` to turn it off for a session.

## Filters

A filter runs around every call, before the arguments are bound:

```ts
const noWritesOnFriday: HostCallFilter<RequestState> = (call, next) =>
  call.method.effect === 'draft-write' && new Date().getDay() === 5 ? Promise.reject(denyCall('No writes on Fridays.')) : next();
```

- Runtime filters wrap session filters, each in the order you added them, on the way in and out.
- A filter sees the method descriptor, the raw arguments (frozen), the omitted positions, the context, the ids, the signal and the deadline.
- `next()` runs the rest of the chain and the handler. It may be called once.
- A filter can continue, refuse with `denyCall` or a `ScriptApiError` with code `denied`, or answer in the method's place by returning a value. A replacement must match the result schema. The evidence records it as `replaced`, with `handlerRan: false` when the handler never ran.

## Outcomes

`execute` returns one of five outcomes. Script failures are outcomes, not exceptions.

| Status | Extra fields |
| --- | --- |
| `completed` | `value`, `hasValue` |
| `failed` | `error`: code, name, message, line, column, stack, diagnostics |
| `cancelled` | |
| `timed-out` | |
| `resource-limit` | `limit`, `detail` |

Every outcome also has `logs` (the script's console output, untrusted text) and `evidence`.

Failure codes: `invalid-source`, `type-check`, `script-error`, `unhandled-rejection`, `never-settled`, `invalid-result`, `denied`, `invalid-arguments`, `host-failure`, `protocol-mismatch`, `audit-failure` and `internal`. The codes `denied`, `invalid-arguments` and `host-failure` come from the name of the error the script let escape, which a script could imitate. The call records in the evidence say what the host actually did.

Lines and columns refer to the submitted source, for JavaScript and TypeScript alike. Stacks keep only the script's own frames.

## Limits

Set them on the runtime, the session or one execution. A script cannot change them.

| Limit | Default | Kind |
| --- | --- | --- |
| `timeoutMs`, end to end | 30 s | Hard: `timed-out` |
| `hostCallTimeoutMs`, per call | 5 s | Call fails with `HostTimeoutError` |
| `memoryBytes`, guest memory | 256 MiB | Hard |
| `sourceBytes` | 64 KiB | Hard, before compiling |
| `messageBytes`, one request or response | 256 KiB | Call fails with `RequestTooLargeError` or `ResponseTooLargeError` |
| `rpcBytes`, all requests and responses | 4 MiB | Hard |
| `hostCalls`, all attempts | 128 | Hard |
| `outstandingCalls` | 16 | Excess calls fail with `QueueFullError` before they start |
| `concurrentCalls` | 4 | Calls to concurrent methods running at once; further ones wait |
| `resultBytes`, the returned value | 256 KiB | Hard |
| `logEntries` and `logEntryBytes` | 100 of 2 KiB | Soft: cut and dropped, marked in `truncated` |
| `evidenceRecords` and `evidenceBytes` | 128, 256 KiB | Hard: a call that cannot be recorded stops the execution |
| `jsonDepth` | 64 | Value refused |
| `compileTimeoutMs` | 10 s | Hard |
| `compilerHeapMb` | 512 MB | Hard, V8 heap limit of the compiler worker |
| `workerHeapMb`, `workerStackMb` | 64 MB, 16 MB | V8 limits of the guest worker |

The guest worker copies nothing larger than `messageBytes`, `resultBytes` or `logEntryBytes` out of guest memory, so those limits bound its host-side buffers too. The registered contract is bounded as well: 64 namespaces, 512 methods, 16 parameters per method and 1 MiB of declarations.

## Cancellation, deadlines and calls the script did not await

- Pass `signal` to `execute`. Cancelling, the deadline and `dispose` all terminate the worker, which stops the guest even inside a long native operation. In the test suite the worker stops within 1 to 8 ms and the outcome arrives within 20 ms.
- When an execution ends, every call in progress loses its authority. Its signal aborts, its result is discarded and recorded as `revoked`, and `throwIfRevoked` throws.
- Host calls start in the order the script made them, one at a time, even under `Promise.all`. The exception is a method registered with `concurrent: true`: calls to such methods run together, up to `concurrentCalls`, and each settles when its handler finishes. Set it only when the handler, and the filters it passes through, are safe to run interleaved with themselves and the other concurrent methods, typically a read. Any other call runs alone: it starts once the calls made before it have settled, and the calls made after it wait for it. A call that exceeds its own timeout settles at once, so a handler that ignores its signal can still be running when the next call starts.
- With concurrent calls, events arrive interleaved and `evidence.calls` lists calls in the order they ended; `seq` gives the order they were made.
- If a script returns while calls it did not await are pending, those calls finish before the outcome, and no new call is admitted. If one of them fails, the execution fails with `unhandled-rejection`. If the script fails, pending calls are revoked at once.

## Evidence and events

`outcome.evidence` holds the execution and session ids, the source's SHA-256, the package, ABI, bootstrap and worker protocol versions, the guest artifact's digest, the contract's digest and your `contractVersion` and `policyVersion`, timestamps, every call attempt (method, effect, disposition, whether the handler ran, sizes, error name), counters and measurements. Fields the runtime cannot measure are named in `unavailable`. It holds no arguments, results or source text.

`onEvent` receives execution-started, host-call-started, host-call-completed, host-call-denied, limit-reached and execution-finished events. It is best effort: a throw is counted and ignored.

`audit` receives the same events and is awaited. If it throws, the execution stops with `audit-failure` before the call it could not record runs, and a completed execution becomes failed.

## TypeScript scripts

A TypeScript script is checked in a worker pool before it runs, against the declarations and ES2023. The configuration is fixed and strict. Scripts cannot import, export, use `import()`, `import.meta`, triple-slash directives, `@ts-` comments, decorators or namespaces. A type error stops the script before anything runs. Checking is an authoring aid, not a boundary: JavaScript and TypeScript scripts get the same runtime checks.

## Docs

Every session has a read-only `docs` namespace:

- `docs.ls(path?)` lists a folder.
- `docs.read(path | paths)` reads up to 20 files. A missing file comes back with an error instead of content.
- `docs.grep(pattern, path?, maxMatches?)` matches lines, case-insensitive. 50 matches by default, 200 at most.
- `docs.search(query, top?)` ranks files. 8 by default, 20 at most.

`/api` holds the generated reference: a folder per namespace with a README, `index.d.ts` and a `.d.ts` per method. Add your own docs with `DocsTree` or any `DocsSource`; a source can list and read lazily from your own storage. Paths are virtual: `.` and `..` segments are refused, and a path never becomes a file path or URL. grep supports `.`, `[]`, `^`, `$`, `|`, `()`, `*`, `+`, `?`, `{n,m}`, `\d`, `\w`, `\s` and `\b`, runs in linear time and stops at a step budget.

## Time and randomness

The guest's `Date` reads the runtime's clock, so a script sees the time you inject with `clock`. With `frozenGuestClock: true` the guest's time stands still at the execution's start. QuickJS seeds `Math.random` from that time, so two executions that start at the same injected time see the same time and the same random numbers. A script that only calls deterministic host methods then gives the same result each time. Host methods that read live data are not repeatable, and ScriptBox does not make them so.

## What the guest can reach

A script sees the JavaScript language, `console`, `__scriptbox` and your namespaces. There is no `process`, `require`, module loading, file system, network, timers, environment or `WebAssembly`. Its WASI imports give it a clock and nothing else. Workers start with an empty environment and no Node flags. ScriptBox never runs submitted code with `eval`, `Function`, `node:vm` or Node's module loader.

Known limitations:

- This QuickJS lets `Object.defineProperty` redefine read-only properties of the global object. A script can point its own `__scriptbox` or namespace globals at its own code. That changes only what the script itself calls; every host call still passes through the guest's C bridge and the host's dispatcher.
- A worker is a scheduling and termination boundary. The sandbox is the guest plus the dispatcher.
- ScriptBox cannot undo side effects a handler causes outside your draft, or make them happen exactly once. Make retried external operations idempotent in your application.
- The guest worker's V8 heap limit does not bound large strings in practice. Its host-side buffers are bounded by the message, result and log limits instead.

## ScriptBox for .NET

ScriptBox also has a .NET host, the `ScriptBox` package on NuGet. You need it only to run scripts from a .NET application. Version 4 runs the same guest, `scriptbox-async.wasm` (guest ABI 2), and the same `scriptbox.js` bootstrap, version 3. Each host refuses a guest or bootstrap of another version before a script runs.

`conformance/fixtures.json` holds cases both hosts run, and every case expects the same result from both. They cover values, defaults, `undefined` and `null`, void methods, errors and their lines, unawaited calls, unhandled rejections, the outstanding-call limit, filters, sealing and docs.

The hosts differ in features, not in contract. This package adds TypeScript checking, capabilities and discovery, per-call timeouts, message and RPC byte limits, and evidence with an audit sink. A script meets those only as errors with their own names, such as `PermissionDeniedError` or `ResponseTooLargeError`. On .NET, `ScriptError.Code` uses the failure codes above.

## Building and testing

From `ScriptBox.Node`:

```sh
npm ci
npm run build          # build-info.ts, dist and the bundled assets
npm run typecheck
npm run lint
npm test               # the acceptance tests, against the built package
node scripts/build.ts --check   # fails if build-info.ts does not match the artifacts
node scripts/package-test.ts    # npm pack, then a clean Node 24 container with the network off
npm run bench
```

The guest artifacts are rebuilt from pinned inputs with `bash ScriptBox.Wasm/docker-build.sh`, which needs only Docker. CI rebuilds them and fails if the digests differ from `ScriptBox.Wasm/artifacts.json`.

## Integration checklist

1. Define each namespace with `createApiKit` and TypeBox schemas. Give every method an effect.
2. Create one runtime with your global filters, limits, docs, `contractVersion` and `policyVersion`.
3. Per request, create a draft or other request state and a session bound to it, with only the capabilities that request needs.
4. In handlers, use `call.signal` for I/O and call `throwIfRevoked()` right before each write.
5. Execute with limits and a cancel signal. Store the evidence with your audit trail.
6. If the outcome is not `completed`, discard the draft. If it is, validate the draft yourself.
7. Persist a proposal bound to the draft's base revision. Make the submission idempotent per request.
8. Approve and apply it outside the script, and refuse it if the base revision has moved.
