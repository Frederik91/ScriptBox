using System;
using System.IO;
using System.Reflection;
using System.Text;

namespace ScriptBox.Core.WasmExecution;

internal static class DefaultRuntimeResources
{
    private const string WasmResourceName = "ScriptBox.Wasm.scriptbox-async.wasm";
    private const string CoreBootstrapResourceName = "ScriptBox.Js.sandbox-api.js";
    private const string ToolsBootstrapResourceName = "ScriptBox.Js.bootstrap-utils.js";

    public static ReadOnlyMemory<byte> LoadEmbeddedWasm()
    {
        return ReadAllBytes(WasmResourceName);
    }

    public static string LoadCoreBootstrap()
    {
        var coreBootstrap = ReadAllText(CoreBootstrapResourceName);
        var toolsBootstrap = ReadAllText(ToolsBootstrapResourceName);
        
        // Combine both bootstraps
        var combined = new StringBuilder();
        combined.AppendLine(coreBootstrap);
        combined.AppendLine();
        combined.AppendLine(toolsBootstrap);
        
        return combined.ToString();
    }

    private static ReadOnlyMemory<byte> ReadAllBytes(string resourceName)
    {
        using var stream = OpenResourceStream(resourceName);
        using var ms = new MemoryStream();
        stream.CopyTo(ms);
        return ms.ToArray();
    }

    private static string ReadAllText(string resourceName)
    {
        using var stream = OpenResourceStream(resourceName);
        using var reader = new StreamReader(stream, Encoding.UTF8);
        return reader.ReadToEnd();
    }

    private static Stream OpenResourceStream(string resourceName)
    {
        var assembly = typeof(DefaultRuntimeResources).GetTypeInfo().Assembly;
        return assembly.GetManifestResourceStream(resourceName)
               ?? throw new InvalidOperationException($"Embedded resource '{resourceName}' not found.");
    }
}
