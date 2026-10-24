using ScriptBox.Core.Runtime;

namespace ScriptBox;

/// <summary>
/// A configured sandbox: the host APIs scripts can call and the limits they
/// run under. Build one with <see cref="ScriptBoxBuilder"/> and keep it; each
/// session is cheap.
/// </summary>
public interface IScriptBox
{
    ScriptSession CreateSession(Action<ScriptSessionOptions>? configure = null);

    IReadOnlyList<SandboxApiDescriptor> Apis { get; }

    IReadOnlyDictionary<string, object> Metadata { get; }

    /// <summary>
    /// TypeScript declarations for every registered API and the types they
    /// take and return, with descriptions as JSDoc. This is what to show the
    /// model that writes scripts for this box.
    /// </summary>
    string GetTypeScriptDeclarations();

    /// <summary>
    /// Declarations for only the methods <paramref name="include"/> accepts, with the types those methods reach.
    /// A namespace none of whose methods is included is left out.
    /// </summary>
    string GetTypeScriptDeclarations(Func<SandboxMethodDescriptor, bool> include);
}
