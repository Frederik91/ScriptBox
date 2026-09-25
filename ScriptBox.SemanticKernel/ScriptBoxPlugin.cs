using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.SemanticKernel;
using ScriptBox;

namespace ScriptBox.SemanticKernel;

/// <summary>
/// Semantic Kernel plugin that exposes a single tool for executing ScriptBox-powered JavaScript.
/// Provides discovered tools as metadata in scriptBoxInput so they're available to scripts.
/// </summary>
public sealed class ScriptBoxPlugin
{
    private static readonly JsonSerializerOptions SerializerOptions = new(JsonSerializerDefaults.Web);
    private readonly IScriptBox _scriptBox;
    private readonly IScriptBoxToolProvider _toolProvider;

    public ScriptBoxPlugin(IScriptBox scriptBox, IScriptBoxToolProvider toolProvider)
    {
        _scriptBox = scriptBox ?? throw new ArgumentNullException(nameof(scriptBox));
        _toolProvider = toolProvider ?? throw new ArgumentNullException(nameof(toolProvider));
    }

    /// <summary>
    /// Executes JavaScript code inside ScriptBox and returns the serialized result.
    /// Discovers available tools and injects them as metadata in scriptBoxInput.
    /// </summary>
    [KernelFunction("run_js")]
    [Description("Executes JavaScript inside ScriptBox. Provide code and optional JSON input payload.")]
    public async Task<string> RunJavaScriptAsync(
        string code,
        string? inputJson = null,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(code))
        {
            throw new ArgumentException("Code must be provided.", nameof(code));
        }

        var session = _scriptBox.CreateSession();

        // Discover tools and merge with user input
        var tools = _toolProvider.GetTools();
        var scriptBoxInput = BuildScriptBoxInput(inputJson, tools);
        var mergedInputJson = JsonSerializer.Serialize(scriptBoxInput, SerializerOptions);
        
        var script = BuildScript(code, mergedInputJson);
        var executionResult = await session.ExecuteAsync(script, cancellationToken).ConfigureAwait(false);
        
        var output = new
        {
            result = ParseResult(executionResult.Json),
            error = executionResult.Error?.ToString(),
            logs = executionResult.Logs.Select(entry => entry.Message).ToList()
        };

        return JsonSerializer.Serialize(output, SerializerOptions);
    }

    private static object? ParseResult(object? result)
    {
        if (result is string s)
        {
            try
            {
                return JsonSerializer.Deserialize<JsonElement>(s);
            }
            catch
            {
                return s;
            }
        }
        return result;
    }

    private static string BuildScript(string code, string? inputJson)
    {
        if (string.IsNullOrWhiteSpace(inputJson))
        {
            // Create empty scriptBoxInput if no input provided
            inputJson = JsonSerializer.Serialize(new { user = new object(), tools = new { descriptors = new object[0] } }, SerializerOptions);
        }

        ValidateJson(inputJson);
        
        // inputJson is already a JSON string, so inject it directly without re-serializing
        var sb = new StringBuilder();
        sb.AppendLine($"const scriptBoxInput = {inputJson};");
        sb.AppendLine("globalThis.scriptBoxInput = scriptBoxInput;");
        
        // Initialize tools now that scriptBoxInput is available
        sb.AppendLine("if (typeof __scriptbox !== 'undefined' && typeof __scriptbox.initializeTools === 'function') {");
        sb.AppendLine("    __scriptbox.initializeTools();");
        sb.AppendLine("}");
        
        sb.AppendLine(code);
        return sb.ToString();
    }

    private static void ValidateJson(string inputJson)
    {
        try
        {
            using var _ = JsonDocument.Parse(inputJson);
        }
        catch (JsonException ex)
        {
            throw new ArgumentException("inputJson must be valid JSON.", nameof(inputJson), ex);
        }
    }

    private static object BuildScriptBoxInput(string? userInputJson, IReadOnlyList<ScriptBoxToolDescriptor> tools)
    {
        // Parse user input if provided, otherwise use empty object
        object? userInput = null;
        if (!string.IsNullOrWhiteSpace(userInputJson))
        {
            try
            {
                userInput = JsonSerializer.Deserialize<object>(userInputJson, SerializerOptions);
            }
            catch (JsonException ex)
            {
                throw new ArgumentException("inputJson must be valid JSON.", nameof(userInputJson), ex);
            }
        }

        // Build the scriptBoxInput object with user data and tools
        var scriptBoxInput = new Dictionary<string, object>
        {
            { "user", userInput ?? new object() },
            { "tools", new Dictionary<string, object>
                {
                    { "descriptors", tools.ToList() }
                }
            }
        };

        return scriptBoxInput;
    }
}
