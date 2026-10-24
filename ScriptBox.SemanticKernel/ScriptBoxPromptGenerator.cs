using System.Text;

namespace ScriptBox.SemanticKernel;

/// <summary>
/// Generates system prompts for LLMs to effectively use ScriptBox APIs.
/// </summary>
public static class ScriptBoxPromptGenerator
{
    /// <summary>
    /// Generates a system prompt that includes the API schema and usage rules for the registered Semantic Kernel plugins.
    /// </summary>
    /// <param name="scriptBox">The ScriptBox instance containing the registered plugins.</param>
    /// <returns>A string containing the system prompt.</returns>
    public static string GenerateSystemPrompt(IScriptBox scriptBox)
    {
        if (scriptBox is null) throw new ArgumentNullException(nameof(scriptBox));

        var sb = new StringBuilder();
        sb.AppendLine("You are a JavaScript code generator.");
        sb.AppendLine("You have access to the following global objects and methods:");
        sb.AppendLine();

        if (scriptBox.Metadata.TryGetValue("SemanticKernelPlugins", out var pluginsObj) && 
            pluginsObj is List<SemanticKernelNamespaceMetadata> plugins)
        {
            foreach (var plugin in plugins)
            {
                sb.AppendLine($"Object: {plugin.Name}");
                foreach (var func in plugin.Functions)
                {
                    var parameters = string.Join(", ", func.Parameters.Select(p => p.Name));
                    sb.Append($"  - {plugin.Name}.{func.Name}({parameters})");
                    if (!string.IsNullOrEmpty(func.Description))
                    {
                        sb.Append($" : {func.Description}");
                    }
                    sb.AppendLine();
                }
                sb.AppendLine();
            }
        }

        sb.AppendLine("IMPORTANT RULES:");
        sb.AppendLine("1. Every API call returns a promise. Always `await` it.");
        sb.AppendLine("2. Do NOT use .then(). Use await instead.");
        sb.AppendLine("3. Use the exact method names listed above.");
        sb.AppendLine("4. Do not invent methods that are not listed.");
        sb.AppendLine("5. Do NOT chain methods.");
        sb.AppendLine("   BAD: `(await utils.math_add(1, 2)).round()`");
        sb.AppendLine("   GOOD: `let sum = await utils.math_add(1, 2); let rounded = await utils.math_round(sum);`");
        sb.AppendLine("6. Do NOT reference a variable inside its own definition. Use intermediate variables.");
        sb.AppendLine("7. Write a valid JavaScript script to solve the user's task.");
        sb.AppendLine("8. ALWAYS use the `return` keyword to return the final result object at the end of the script.");
        sb.AppendLine("9. Return ONLY the raw JavaScript code. Do not use markdown blocks. Do not explain.");

        return sb.ToString();
    }
}
