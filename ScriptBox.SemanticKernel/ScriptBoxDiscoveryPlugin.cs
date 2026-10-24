using System.ComponentModel;
using System.Text;
using Microsoft.SemanticKernel;

namespace ScriptBox.SemanticKernel;

/// <summary>
/// A Semantic Kernel plugin that allows an agent to discover available ScriptBox APIs.
/// </summary>
public sealed class ScriptBoxDiscoveryPlugin
{
    private readonly IScriptBox _scriptBox;

    public ScriptBoxDiscoveryPlugin(IScriptBox scriptBox)
    {
        _scriptBox = scriptBox ?? throw new ArgumentNullException(nameof(scriptBox));
    }

    [KernelFunction("get_schema")]
    [Description("Retrieves the API schema. You MUST call this tool first to understand the available functions and generation rules before writing any JavaScript code.")]
    public string GetSchema()
    {
        if (_scriptBox.Metadata.TryGetValue("SemanticKernelPlugins", out var value) &&
            value is List<SemanticKernelNamespaceMetadata> plugins)
        {
            var sb = new StringBuilder();
            
            foreach (var plugin in plugins)
            {
                sb.AppendLine($"Namespace: {plugin.Name}");
                foreach (var func in plugin.Functions)
                {
                    var parameters = string.Join(", ", func.Parameters.Select(p => $"{p.Name}: {p.Type}"));
                    sb.AppendLine($"- {plugin.Name}.{func.Name}({parameters}) -> {func.ReturnType}");
                    if (!string.IsNullOrEmpty(func.Description))
                    {
                        sb.AppendLine($"  Description: {func.Description}");
                    }
                }
                sb.AppendLine();
            }

            sb.AppendLine("IMPORTANT GENERATION RULES:");
            sb.AppendLine("1. Every API call returns a promise. Always use 'await'.");
            sb.AppendLine("2. MUST use 'return' keyword to output the result. (e.g. `return result;`).");
            sb.AppendLine("3. Do NOT output bare object literals at the end.");
            sb.AppendLine("4. Use the exact namespace and function names listed above.");
            sb.AppendLine("5. Do NOT use 'require' or 'import'. The namespaces are already global.");
            sb.AppendLine("6. Do NOT include comments in the code to keep it concise.");
            sb.AppendLine();
            sb.AppendLine("NOW, based on the user's request and this schema, WRITE THE JAVASCRIPT CODE IMMEDIATELY.");

            return sb.ToString();
        }
        return "No plugins found.";
    }
}
