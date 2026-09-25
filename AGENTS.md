# ScriptBox Developer Guide for AI Agents

This document is designed to provide LLM agents with a comprehensive understanding of the ScriptBox repository. It covers the project's purpose, architecture, structure, and workflows for development, testing, and contribution.

## 1. Project Overview

**ScriptBox** is a reusable runtime for executing untrusted JavaScript and TypeScript code within a secure, deterministic **QuickJS-in-WASM** sandbox. It is designed for .NET applications, particularly AI copilots and agents, that need to run generated code safely.

**Key Features:**
*   **Isolation:** Runs code in a WebAssembly sandbox (using Wasmtime) with no direct access to the host system.
*   **Interop:** Provides a strongly-typed bridge between C# host APIs and the JavaScript environment.
*   **Semantic Kernel Integration:** Includes a plugin to easily expose the sandbox as a tool to Semantic Kernel agents.
*   **No External Processes:** Runs in-process via WASM, avoiding the overhead and complexity of managing separate Node.js or Python processes.

## 2. Repository Structure

The repository is organized as a Visual Studio solution (`ScriptBox.sln`) containing the following key components:

### Core Components
*   **`ScriptBox/`**: The core library. Contains the `ScriptBox` runtime, `ScriptBoxBuilder`, WASM bridge logic, and attribute-based API discovery (`[SandboxApi]`, `[SandboxMethod]`).
*   **`ScriptBox.DependencyInjection/`**: Extension methods for integrating ScriptBox with `Microsoft.Extensions.DependencyInjection`.
*   **`ScriptBox.SemanticKernel/`**: Integration library for Microsoft Semantic Kernel. Contains `ScriptBoxPlugin` and tools for exposing ScriptBox as an SK function.

### Testing & Examples
*   **`ScriptBox.Tests/`**: Unit and integration tests for the core library. Uses xUnit and Moq.
*   **`ScriptBox.SemanticKernel.Tests/`**: Tests for the Semantic Kernel integration.
*   **`Examples/ScriptBox.Example/`**: A simple console application demonstrating how to configure ScriptBox, register APIs, and run scripts without Semantic Kernel.
*   **`Examples/Scriptbox.SemanticKernel.Example/`**: A complete example showing how to use ScriptBox with Semantic Kernel, including plugin registration and chat completion.

### Supporting Files
*   **`scripts/`**: Contains the TypeScript SDK (`sdk/`) and build scripts for the JavaScript side of the bridge.
*   **`docs/`**: Documentation files (`vision.md`, `ci.md`).
*   **`.github/workflows/`**: CI/CD definitions.

## 3. Architecture & Concepts

Understanding the data flow is crucial for modifying the system:

1.  **Host (C#)**: The .NET application configures a `ScriptBox` instance using `ScriptBoxBuilder`. It registers C# classes as APIs. Nothing else is reachable from a script: there is no built-in file system or network API.
2.  **WASM Runtime**: `WasmRuntime` compiles `scriptbox.wasm` (QuickJS compiled to WASM) once per process and shares it.
3.  **Execution**: `ScriptSession.ExecuteAsync` runs on a dedicated 16 MB-stack thread. Each execution gets a fresh WASM instance, evaluates the bootstrap scripts (`scriptbox.js`, the generated `apis.js`, then any startup scripts) and finally the user script as `script.js`, wrapped in an async function in strict mode.
4.  **Interop**: the guest ABI is documented at the top of `ScriptBox.Wasm/scriptbox_wrapper.c`. A script calls `ns.method(...)`, which `scriptbox.js` sends through `__host.call` as JSON; the host binds the arguments to the C# parameters, invokes the method and returns `{result}` or `{error}`. There are no fixed-size buffers in either direction.
5.  **Limits**: on timeout or cancellation the host traps the instance from `host.interrupt` (polled by QuickJS) or `host.call`, which no script can catch. A Wasmtime epoch deadline backs that up for native code that never polls. Memory is capped with Wasmtime store limits. A changed C file means rebuilding the WASM with `ScriptBox.Wasm/build.sh` (WASI SDK 28).

## 4. Development Workflow

### Prerequisites
*   **.NET 9 SDK**: Required for building the solution.
*   **Node.js & npm**: Required if you need to modify the TypeScript SDK in `scripts/`.

### Build Commands
Run these commands from the repository root:

*   **Restore Dependencies**:
    ```powershell
    dotnet restore ScriptBox.sln
    ```
*   **Build Solution**:
    ```powershell
    dotnet build ScriptBox.sln -c Release
    ```
*   **Run Tests**:
    ```powershell
    dotnet test ScriptBox.Tests/ScriptBox.Tests.csproj -c Release
    ```
    *   *Note: Always run tests after modifying core logic.*

### Running Examples
*   **Basic Example**:
    ```powershell
    dotnet run --project Examples/ScriptBox.Example/ScriptBox.Example.csproj
    ```
*   **Semantic Kernel Example**:
    ```powershell
    dotnet run --project Examples/Scriptbox.SemanticKernel.Example/Scriptbox.SemanticKernel.Example.csproj
    ```
    *   *Note: This example may require configuring an LLM endpoint (e.g., OpenAI/Azure OpenAI) in the code or environment variables.*

## 5. Coding Standards

*   **Language**: C# 12 / .NET 9.
*   **Style**:
    *   Use file-scoped namespaces.
    *   Use `var` when the type is obvious.
    *   Enable nullable reference types.
    *   Public APIs should be PascalCase.
    *   JavaScript method aliases in `[SandboxMethod]` should be `snake_case` to match JS conventions.
*   **Formatting**: Run `dotnet format ScriptBox.sln` to ensure compliance.

## 6. Common Tasks for Agents

### Task: Add a New Host API
1.  Create a C# class (e.g., `MyNewApi`).
2.  Decorate the class with `[SandboxApi("my_namespace")]`.
3.  Decorate public methods with `[SandboxMethod("my_method")]`.
4.  Register it in the builder: `.RegisterApisFrom<MyNewApi>()`.
5.  **Test**: Add a test case in `ScriptBox.Tests` that runs a script calling `my_namespace.my_method()`.

### Task: Fix a Bug in the Runtime
1.  Identify the issue in `ScriptBox/Core/`.
2.  Create a reproduction test case in `ScriptBox.Tests/`.
3.  Apply the fix.
4.  Verify the test passes.

### Task: Update Semantic Kernel Integration
1.  Modify `ScriptBox.SemanticKernel/`.
2.  If changing the plugin interface, update `ScriptBoxPlugin.cs`.
3.  Run `ScriptBox.SemanticKernel.Tests/` to verify.

## 7. Troubleshooting

*   **"WASM module not found"**: Ensure the `ScriptBox.Wasm` package is referenced or the `.wasm` file is being copied to the output directory.
*   **"Method not found" in JS**: Check the `[SandboxApi]` and `[SandboxMethod]` names. They are case-sensitive in the JS bridge.
*   **Serialization Errors**: Ensure arguments and return types are JSON-serializable. Complex objects may need `JsonElement` or specific DTOs.

## 8. Vision & Roadmap
Refer to `docs/vision.md` for the long-term goals. The project aims to be the standard, safe way to run AI-generated code in .NET.
