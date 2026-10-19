using System.ComponentModel;
using System.Reflection;

namespace ScriptBox.Core.Runtime;

/// <summary>
/// Describes a sandbox API that has been discovered by a scanner.
/// </summary>
public sealed record SandboxApiDescriptor(
    Type ApiType,
    string JsNamespace,
    IReadOnlyList<SandboxMethodDescriptor> Methods,
    bool RequiresInstance)
{
    /// <summary>The API's <see cref="DescriptionAttribute"/>, if it has one.</summary>
    public string? Description => ApiType.GetCustomAttribute<DescriptionAttribute>()?.Description;
}

/// <summary>
/// Describes a method within a sandbox API.
/// </summary>
public sealed record SandboxMethodDescriptor(string JsNamespace, string JsMethodName, MethodInfo Method)
{
    /// <summary>
    /// Gets the full host method name used for registration.
    /// </summary>
    public string HostMethodName => $"{JsNamespace}.{JsMethodName}";

    /// <summary>The method's <see cref="DescriptionAttribute"/>, if it has one.</summary>
    public string? Description => Method.GetCustomAttribute<DescriptionAttribute>()?.Description;

    /// <summary>The first sentence of <see cref="Description"/>, for listings.</summary>
    public string? Summary => Text.FirstSentence(Description);

    public T? GetAttribute<T>() where T : Attribute => Method.GetCustomAttribute<T>();
}

internal static class Text
{
    public static string? FirstSentence(string? text)
    {
        if (text is null || string.IsNullOrWhiteSpace(text))
        {
            return null;
        }

        var trimmed = text.Trim();
        for (var i = 0; i < trimmed.Length - 1; i++)
        {
            if (trimmed[i] == '.' && char.IsWhiteSpace(trimmed[i + 1]))
            {
                return trimmed.Substring(0, i + 1);
            }
        }

        return trimmed;
    }
}
