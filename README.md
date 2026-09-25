# ScriptBox

ScriptBox runs untrusted JavaScript inside QuickJS compiled to WebAssembly, in-process in a .NET application. A script can reach exactly the C# APIs you register and nothing else: no file system, no network, no ambient globals. It is built for letting a language model write a short program against your application's API instead of making one tool call per step.

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
    const stale = tasks.list().filter(t => t.name.startsWith('old-'));
    for (const t of stale) tasks.rename(t.id, t.name.slice(4));
    return stale.length;
    """);

if (result.Succeeded) Console.WriteLine(result.Json);     // "3"
else Console.WriteLine(result.Error);                      // name, message, stack with line numbers
```

A script is the body of an async function: `return` produces the result, `await` works, and strict mode is on. Host calls are synchronous and return their values directly.

## What a script sees

- **Registered APIs**, one global per `[SandboxApi]` namespace. Arguments are bound to the C# parameters with System.Text.Json: objects, lists, enums as names, optional parameters with defaults, and nullable parameters. A wrong argument count or shape fails with a message naming the parameter.
- **`console.log/info/warn/error`**, captured in `ScriptExecutionResult.Logs`.
- **Errors from the host**: an exception in a host method becomes a JavaScript `Error` the script can catch. Throw `ScriptApiException` to choose its name and to write a message for the script's author. An uncaught error ends the script with a stack that refers to the submitted source's line numbers.
- **A fresh realm every time**: nothing a script defines survives into the next execution. State that should persist lives host-side, in API instances or `ScriptSession.Items`.

## TypeScript declarations

`GetTypeScriptDeclarations()` declares every registered namespace and each type reachable from its signatures. `[Description]` on classes, methods, parameters, properties and enum members becomes JSDoc. Shapes are read from the serializer contract, so renamed and ignored properties, nullability, read-only members and `[JsonPolymorphic]` hierarchies (as discriminated unions) come out the way they are actually sent. For a type with a custom converter, declare it yourself with `WithTypeScriptType`.

## Limits

| Setting | Default | Behaviour when exceeded |
| --- | --- | --- |
| `WithExecutionTimeout` | 30 s, host calls included | `ScriptErrorKind.Timeout`; the host call in progress sees its `CancellationToken` cancelled |
| `WithMemoryLimit` | 256 MB of linear memory | `ScriptErrorKind.MemoryLimit` |
| Recursion | about 3,600 frames deep | a catchable `InternalError: stack overflow` |
| `WithLogLimits` | 1,000 entries of 8 KB | later output is dropped with a note |

Cancelling the token passed to `ExecuteAsync` stops the script and throws `OperationCanceledException`. Payload sizes are not limited beyond memory: arguments, results and host responses of several megabytes pass through.

## Per-session API instances

Register the API type once on the builder, then serve an instance per session. Use this when a script's calls should act on one request's state:

```csharp
var session = box.CreateSession(o => o.UseApi(new TaskApi(snapshot, changeSet)));
```

Instances not supplied per session are created on first use through `WithApiFactory` (or `Activator`), once per box.

## Sealed results

With `SealHostResults()`, every object a host call returns is sealed recursively. Changing an existing property works, but assigning one the object does not have throws a `TypeError` at that line, so `item.nmae = 'x'` fails loudly instead of being silently ignored. Arrays stay growable.

## Packages

| Package | Description |
| ------- | ----------- |
| `ScriptBox` | Runtime, builder, API binding, TypeScript declarations |
| `ScriptBox.DependencyInjection` | Registers `IScriptBox` with `Microsoft.Extensions.DependencyInjection` |
| `ScriptBox.SemanticKernel` | Exposes Semantic Kernel plugins as script APIs and a `run_js` kernel function |

## Performance

On a desktop machine, building the first box (which compiles the WASM module once per process) takes about 150 ms. Each execution after that costs about 1.3 ms, and a host call about 20 µs. The benchmark in `Examples/Scriptbox.SemanticKernel.Example` compares a model calling tools one by one with the same model writing one script: 55–64% fewer tokens on 7–8 step tasks with GPT-4o-mini.

## Building the WASM module

`ScriptBox.Wasm/scriptbox_wrapper.c` is the guest side; its header comment documents the ABI. After changing it:

```bash
WASI_SDK_PATH=~/wasi-sdk-28.0 bash ScriptBox.Wasm/build.sh
```

The script clones QuickJS into `ScriptBox.Wasm/quickjs` on first use. CI builds the module the same way (`.github/workflows/build-wasm.yml`).

## Repository structure

```
ScriptBox/                          Runtime
ScriptBox.Wasm/                     QuickJS guest (C) and build script
scripts/sdk/                        JavaScript bootstrap evaluated before every script
ScriptBox.DependencyInjection/      DI helpers
ScriptBox.SemanticKernel/           Semantic Kernel integration
ScriptBox.Tests/                    Runtime tests
ScriptBox.SemanticKernel.Tests/     Semantic Kernel tests
Examples/                           Console examples
```
