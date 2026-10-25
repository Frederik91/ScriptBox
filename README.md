# ScriptBox

ScriptBox runs untrusted JavaScript inside QuickJS compiled to WebAssembly, in-process in a .NET application. A script can reach exactly the C# APIs you register and nothing else: no file system, no network, no ambient globals. It is built for letting a language model write a short program against your application's API instead of making one tool call per step.

For Node.js servers, `ScriptBox.Node` is the same sandbox as an npm package, with TypeScript checking, filters, limits and evidence. See [its README](ScriptBox.Node/README.md). Both hosts run the same guest and the same bootstrap, and a shared set of conformance cases holds them to one contract. The rest of this page covers the .NET host.

## Quick start

```csharp
using ScriptBox;
using ScriptBox.Core.Runtime;

[SandboxApi("tasks")]
[Description("The tasks in the open project.")]
public sealed class TaskApi
{
    [SandboxMethod("list")]
    public IReadOnlyList<TaskItem> List() => /* ... */;

    [SandboxMethod("rename")]
    [Description("Renames a task. Throws if the id is unknown.")]
    public void Rename(string id, string name) => /* ... */;
}

var box = ScriptBoxBuilder.Create()
    .RegisterApisFrom<TaskApi>()
    .SealHostResults()
    .Build();

// Show this to the model that writes the scripts.
string declarations = box.GetTypeScriptDeclarations();

var result = await box.CreateSession().ExecuteAsync("""
    const stale = (await tasks.list()).filter(t => t.name.startsWith('old-'));
    for (const t of stale) await tasks.rename(t.id, t.name.slice(4));
    return stale.length;
    """);

if (result.Succeeded) Console.WriteLine(result.Json);     // "3"
else Console.WriteLine(result.Error);                      // name, message, stack with line numbers
```

A script is the body of an async function: `return` produces the result, and strict mode is on. Every host call returns a promise, so `await` it. The host answers calls one at a time, in the order the script made them, even under `Promise.all`.

## What a script sees

- **Registered APIs**, one global per `[SandboxApi]` namespace. Arguments are bound to the C# parameters with System.Text.Json: objects, lists, enums as names, optional parameters with defaults, and nullable parameters. A wrong argument count or shape fails with `InvalidArgumentsError` and a message naming the parameter. An object with a property its type does not declare is refused too.
- **`docs`**, when the host adds the [docs namespace](#docs-namespace): read-only reference for the registered APIs and the host's own guides.
- **`console.log/info/warn/error`**, captured in `ScriptExecutionResult.Logs`.
- **Errors from the host**: a failed call rejects its promise with an `Error` the script can catch. Throw `ScriptApiException` to choose its name and to write a message for the script's author. Any other exception reaches the script only as `HostError: <method> failed on the host.`, and the exception itself goes to `ScriptExecutionResult.HostErrors`. An uncaught error ends the script with a stack that points at the line that made the call.
- **A fresh realm every time**: nothing a script defines survives into the next execution. State that should persist lives host-side, in API instances or `ScriptSession.Items`.

## Values and outcomes

Values cross between script and host as JSON, with the same rules as the Node host:

- Refused, with the path to the bad value: NaN, Infinity, BigInt, functions, symbols, class instances such as `Date` and `Map`, array holes, and cycles. In an argument the call fails with a `TypeError`; as the script's result the execution fails.
- An `undefined` argument is omitted and takes its parameter's default. `null` is a value: a non-nullable parameter refuses it.
- A method that returns nothing resolves to `undefined`.
- A call the script did not await still runs before the outcome. If it fails and nothing handles it, the execution fails.
- A script that awaits a promise nothing can settle fails rather than hangs.
- At most 16 calls can wait at once. Calls beyond that fail with `QueueFullError` before they start.

`ScriptError.Code` names why a script failed, in the Node host's vocabulary: `invalid-source`, `script-error`, `unhandled-rejection`, `never-settled`, `invalid-result`, `denied`, `invalid-arguments`, `host-failure`, `protocol-mismatch`, `internal`, and `timed-out` or `resource-limit` for the limits.

## TypeScript declarations

`GetTypeScriptDeclarations()` declares every registered namespace and each type reachable from its signatures. Every method returns a `Promise`. `[Description]` on classes, methods, parameters, properties and enum members becomes JSDoc. Shapes are read from the serializer contract, so renamed and ignored properties, nullability, read-only members and `[JsonPolymorphic]` hierarchies (as discriminated unions) come out the way they are actually sent. For a type with a custom converter, declare it yourself with `WithTypeScriptType`.

A large box does not have to go into the prompt whole. Pass a method filter to declare only part of it, with the types those methods reach. A namespace with no included method is left out:

```csharp
string core = box.GetTypeScriptDeclarations(m => m.JsNamespace is "tasks" or "docs");
```

The rest can stay reachable through the [docs namespace](#docs-namespace).

## Host-call filters

A filter runs around every call a script makes into a host API, before the arguments are bound. It is the place for a policy that applies to every method, such as approval, auditing or a dry run. A filter can do one of three things:

- call `next()` to let the call through;
- throw `ScriptApiException` to refuse it, which the script sees as a catchable error at the calling line;
- return a `HostCallResult` of its own without running the method.

`HostCallContext` carries the method's name, its raw JSON arguments, the session and the `MethodDescriptor`. The descriptor gives access to the method's attributes, so methods can declare what they do and one filter can decide for all of them. This dry run lets reads through and records every write instead of running it:

```csharp
[AttributeUsage(AttributeTargets.Method)]
public sealed class ChangesStateAttribute : Attribute;

// On TaskApi:  [SandboxMethod("rename"), ChangesState] public void Rename(...)

public sealed class DryRun(List<string> proposed) : IHostCallFilter
{
    public Task<HostCallResult> InvokeAsync(HostCallContext context, HostCallNext next)
    {
        if (context.MethodDescriptor.GetAttribute<ChangesStateAttribute>() is null)
        {
            return next();
        }

        proposed.Add($"{context.Method} {string.Join(", ", context.Arguments)}");
        return Task.FromResult(HostCallResult.From(new { proposed = true }));
    }
}

var box = ScriptBoxBuilder.Create()
    .RegisterApisFrom<TaskApi>()
    .UseHostCallFilter(new AuditLog())                  // every session
    .Build();

var session = box.CreateSession(o => o.UseHostCallFilter(new DryRun(proposed)));
```

Box filters run outside session filters, each in the order it was added. Every call passes them, including one made through the low-level `__scriptbox.hostCall`. A script cannot replace `__scriptbox` or its functions.

## Docs namespace

`WithDocs` adds a read-only `docs` namespace that a script can browse like a file tree:

| Call | Returns |
| --- | --- |
| `docs.ls(path?)` | The files and folders directly in a folder, each with a one-line summary |
| `docs.read(path \| paths)` | One file, or up to 20 at once; a missing path comes back with an error instead of content |
| `docs.grep(pattern, path?, maxMatches?)` | Lines matching a case-insensitive regular expression, 50 by default and 200 at most |
| `docs.search(query, top?)` | The files about a topic, best first, 8 by default |

Under `/api` the box documents its own APIs, generated from their declarations. Each namespace gets a folder with a `README.md`, its full `index.d.ts`, and one `.d.ts` per function. Add your own guides next to them:

```csharp
var guides = new DocsTree()
    .DescribeDirectory("/guides", "How to write scripts for this app.")
    .AddFile("/guides/rules.md", "Rules every script follows.", File.ReadAllText("rules.md"));

var box = ScriptBoxBuilder.Create()
    .RegisterApisFrom<TaskApi>()
    .WithDocs([guides])
    .Build();
```

The `includeApi` parameter of `WithDocs` limits which APIs get a folder under `/api`. For docs held in a large or remote catalogue, implement `IDocsSource`. Such a source can list and read files on demand and leave grep empty, as long as search finds them.

Together with a declaration filter, this keeps the prompt small. Show the model the core API up front and let it read the rest when a task needs it.

## Limits

| Setting | Default | Behaviour when exceeded |
| --- | --- | --- |
| `WithExecutionTimeout` | 30 s, host calls included | `ScriptErrorKind.Timeout`; the host call in progress sees its `CancellationToken` cancelled |
| `WithMemoryLimit` | 256 MiB of linear memory, at least 32 MiB | `ScriptErrorKind.MemoryLimit` |
| Waiting host calls | 16 | the excess call fails with `QueueFullError` |
| Recursion | about 3,600 frames deep | a catchable `InternalError: stack overflow` |
| `WithLogLimits` | 1,000 entries of 8 KB | later output is dropped with a note |

Cancelling the token passed to `ExecuteAsync` stops the script and throws `OperationCanceledException`. Payload sizes are not limited beyond memory: arguments, results and host responses of several megabytes pass through.

## Per-session API instances

Register the API type once on the builder, then serve an instance per session. Use this when a script's calls should act on one request's state:

```csharp
var session = box.CreateSession(o => o.UseApi(new TaskApi(snapshot, changeSet)));
```

Instances not supplied per session are created on first use through `WithApiFactory` (or `Activator`), once per box.

## APIs with their own serializer

Every API uses the box's `JsonSerializerOptions` (`WithJsonSerializerOptions`) unless it is registered with options of its own. Those options then apply to its arguments, its results and its declarations, so APIs written against different serializers can share one box:

```csharp
var box = ScriptBoxBuilder.Create()
    .RegisterApisFrom(typeof(LegacyApi), null, snakeCaseOptions)   // { display_name: ... }
    .RegisterApisFrom<TaskApi>()                                     // { displayName: ... }
    .Build();
```

`AddFromObject` takes the same optional options.

## Sealed results

With `SealHostResults()`, every object a host call returns is sealed recursively. Changing an existing property works, but assigning one the object does not have throws a `TypeError` at that line, so `item.nmae = 'x'` fails loudly instead of being silently ignored. Arrays stay growable.

## Upgrading from ScriptBox 3

ScriptBox 4 gives the .NET host the Node host's contract. Scripts and hosts need these changes:

1. Host calls return promises. Add `await` to every call. A v3 script that used a call's value directly now sees a promise.
2. Calling an unknown method fails with `UnknownMethodError`, not `TypeError`. Bad arguments fail with `InvalidArgumentsError`, not `TypeError`.
3. A void method resolves to `undefined`, not `null`.
4. Values without a JSON form are refused instead of converted. `NaN` no longer becomes `null`.
5. Only `ScriptApiException` messages reach the script. Throw it wherever the script's author should read the message. Other exceptions are in `ScriptExecutionResult.HostErrors`.
6. Argument objects are closed, and `null` no longer takes a parameter's default.
7. A cancelled host call is a `HostError`. v3 named it `AbortError`.
8. The guest is `scriptbox-async.wasm`. `WithWasmModule` refuses ScriptBox 3's `scriptbox.wasm`, and the memory limit is at least 32 MiB.

## Packages

| Package | Description |
| ------- | ----------- |
| `ScriptBox` | Runtime, builder, API binding, host-call filters, TypeScript declarations, docs namespace |
| `ScriptBox.DependencyInjection` | Registers `IScriptBox` with `Microsoft.Extensions.DependencyInjection` |
| `ScriptBox.SemanticKernel` | Exposes Semantic Kernel plugins as script APIs and a `run_js` kernel function |
| `@frederik91/scriptbox` (npm, `ScriptBox.Node/`) | The Node host. Released from `node-v*` tags, see `docs/ci.md`. |

## Performance

On a desktop machine (Ryzen 7 7700X, .NET 10), building the first box and running a first script takes about 260 ms, most of it compiling the WASM module once per process. Each execution after that costs about 1.2 ms, and a host call about 18 µs. The benchmark in `Examples/Scriptbox.SemanticKernel.Example` compares a model calling tools one by one with the same model writing one script: 55–64% fewer tokens on 7–8 step tasks with GPT-4o-mini.

## Building the WASM module

`ScriptBox.Wasm/scriptbox_wrapper.c` is the guest side. Its header comment documents the ABI. It builds `scriptbox-async.wasm`, which both hosts run. After changing it:

```bash
bash ScriptBox.Wasm/docker-build.sh
```

This needs only Docker. It builds from pinned inputs and records the digests in `ScriptBox.Wasm/artifacts.json`. CI rebuilds the artifact and fails if it differs from the committed one. See [ScriptBox.Wasm/README.md](ScriptBox.Wasm/README.md).

## Repository structure

```
ScriptBox/                          Runtime
ScriptBox.Wasm/                     QuickJS guest (C), the artifact and its build
ScriptBox.Node/                     Node host (npm package)
scripts/sdk/                        JavaScript bootstrap evaluated before every script, shared by both hosts
conformance/                        Cases both hosts run
ScriptBox.DependencyInjection/      DI helpers
ScriptBox.SemanticKernel/           Semantic Kernel integration
ScriptBox.Tests/                    Runtime tests
ScriptBox.SemanticKernel.Tests/     Semantic Kernel tests
Examples/                           Console examples
```
