# ScriptBox – Product Vision & Architecture

## Why this project exists

Modern AI copilots constantly emit small snippets of JavaScript/TypeScript that need to be executed on behalf of the user. Running that code inside the host process is a non‑starter – it needs isolation, guard rails, and a clear contract describing what the AI is allowed to touch. ScriptBox turns the experimental prototype into a reusable runtime that lets developers:

1. **Execute untrusted TypeScript/JavaScript inside a deterministic QuickJS-in-WASM sandbox** without starting a new process.
2. **Expose their own “ScriptBox API”** – a curated set of file system, HTTP, or domain-specific helpers – while hiding the low-level JSON plumbing required to communicate with the host.
3. **Iterate quickly**: swap bootstrap scripts, develop helper libraries in TypeScript, and keep everything testable from .NET.

## North Star goals

- **Safety first**: single-process isolation, configurable timeouts, filesystem path validation, HTTP allowlists.
- **Extensibility by design**: developers bring their own APIs; we merely provide the transport bridge (`__scriptbox`) and sample ergonomics.
- **Framework agnostic**: ship .NET libraries plus a tiny TypeScript helper so teams can build their own CLI tools, web servers, or background workers on top.

## High-level architecture

```
┌──────────────┐      ┌────────────────┐      ┌────────────────┐
│ .NET Host    │      │ QuickJS + WASM │      │ User Script     │
│ (WasmScript  │◀────▶│ (scriptbox.wasm│◀────▶│ (AI-generated   │
│ Executor)    │host  │ + scriptbox│ API  │  TypeScript)    │
└──────────────┘call  └────────────────┘bridge└────────────────┘
```

- **ScriptBox/Core/WasmExecution** loads `scriptbox.wasm`, evaluates the bootstrap scripts, and feeds user code through `sb_eval`.
- The WASM module exposes a minimal `__host.call(requestJson)` entry point. All host APIs are funneled through that synchronous JSON call.
- **`scripts/sdk/scriptbox.js`** wraps `__host.call`, removes `__host` from the global scope, and exposes:
  - `__scriptbox.hostCall(method, args)` – synchronous host RPC.
  - `__scriptbox.createMethod("Namespace.Method")` – returns a callable that handles argument/response marshalling.
- **Bootstrap scripts**: `scriptbox.js`, then the namespaces generated from registered APIs, then anything added with `WithStartupScript`.

## Defining your own ScriptBox API

ScriptBox supports two approaches for exposing .NET APIs to JavaScript:

### 1. Attribute-Based APIs (Recommended)

The simplest way to expose APIs is using `[SandboxApi]` and `[SandboxMethod]` attributes:

```csharp
[SandboxApi("files")]
public class FileApi
{
    [SandboxMethod("read")]
    public string ReadText(string path) => File.ReadAllText(path);

    [SandboxMethod("write")]
    public void WriteText(string path, string content) => File.WriteAllText(path, content);
}

[SandboxApi("crm")]
public class CrmApi
{
    [SandboxMethod("createLead")]
    public async Task<Guid> CreateLeadAsync(string name, string email)
    {
        // Your CRM logic here
        return Guid.NewGuid();
    }
}

var scriptBox = ScriptBoxBuilder
    .Create()
    .RegisterApisFrom<FileApi>()
    .RegisterApisFrom<CrmApi>()
    .Build();
```

ScriptBox automatically generates the JavaScript bootstrap code, making these APIs available as:

```js
// Automatically generated, no manual bootstrap needed
const content = files.read('/path/to/file.txt');
files.write('/path/to/output.txt', 'Hello World');

const leadId = crm.createLead('John Doe', 'john@example.com');
```

### 2. Low-Level HostApiBuilder (Advanced)

For more control, use the low-level `HostApiBuilder` to register JSON-RPC style handlers:

```csharp
var scriptBox = ScriptBoxBuilder
    .Create()
    .ConfigureHostApi(builder => builder
        .RegisterHandler("MyFiles.Read", args => {
            var path = args.GetString(0);
            return File.ReadAllText(path);
        })
        .RegisterHandler("MyFiles.Write", args => {
            var path = args.GetString(0);
            var content = args.GetString(1);
            File.WriteAllText(path, content);
            return null;
        }))
    .WithStartupScript(async _ =>
        "globalThis.files = { read: (path) => __scriptbox.hostCall('MyFiles.Read', [path]) };")
    .Build();
```

## Developer workflow

1. **Define your APIs using attributes**:
   - Mark classes with `[SandboxApi("namespace")]`
   - Mark public methods with `[SandboxMethod("methodName")]`
   - Both static and instance methods are supported
   - Async methods (`Task<T>`) are automatically handled

2. **Register APIs with ScriptBoxBuilder**:
   ```csharp
   var scriptBox = ScriptBoxBuilder
       .Create()
       .RegisterApisFrom<MyApi>()
       .Build();
   ```

3. **Use dependency injection (optional)**:
   ```csharp
   services.AddScriptBox((box, sp) => {
       box.RegisterApisFrom<MyApi>();  // Instance resolved via DI
   });
   ```

4. **Write tests**:
   - Use the fluent builder in tests
   - Integration tests verify the full stack (C# → WASM → JavaScript)
   - Unit tests can mock individual components

## Future roadmap

| Area | Current State | Future Enhancements |
|------|--------------|---------------------|
| API Definition | Attribute-based with `[SandboxApi]` and `[SandboxMethod]` | TypeScript declaration file generation from attributes |
| Bootstrap system | Configurable via builder | Declarative manifest & hashed cache |
| Isolation | Timeouts + WASM sandbox | Fuel-based CPU limits, memory quotas |
| Semantic Kernel | Full integration with plugin discovery | Enhanced type mapping, streaming support |
| Tooling | Manual docs (README + this file) | `dotnet tool` / `npm` scaffolder to spin up new ScriptBox APIs |
| Observability | Basic logging | Structured tracing, metrics, script replay |

## Takeaways

- The **core deliverable** is the combination of `WasmScriptExecutor` + `scriptbox.wasm` + `__scriptbox`. Everything else is built on top of this foundation.
- **Attribute-based APIs** (`[SandboxApi]` and `[SandboxMethod]`) are the recommended way to expose .NET functionality to JavaScript, with automatic bootstrap generation.
- **Semantic Kernel integration** enables LLM agents to discover and invoke ScriptBox APIs through a unified `run_js` tool, providing significant token savings for multi-step tasks.
- Teams can extend ScriptBox by implementing custom `ISandboxApiScanner` instances or using the low-level `HostApiBuilder` for advanced scenarios.
