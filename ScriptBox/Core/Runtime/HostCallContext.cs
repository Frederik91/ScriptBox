using System.Text.Json;
using System.Threading;

namespace ScriptBox.Core.Runtime;

/// <summary>
/// One call from a script into a host API. A host method can take this as a
/// parameter, or a <see cref="CancellationToken"/>, alongside its arguments.
/// </summary>
public sealed class HostCallContext
{
    private readonly Func<SandboxApiDescriptor, object> _resolveInstance;

    internal HostCallContext(
        string method,
        IReadOnlyList<JsonElement> arguments,
        ScriptSession session,
        JsonSerializerOptions jsonOptions,
        Func<SandboxApiDescriptor, object> resolveInstance,
        CancellationToken cancellationToken)
    {
        Method = method;
        Arguments = arguments;
        Session = session;
        JsonOptions = jsonOptions;
        _resolveInstance = resolveInstance;
        CancellationToken = cancellationToken;
    }

    /// <summary>The called method as the script names it, e.g. <c>tasks.get</c>.</summary>
    public string Method { get; }

    /// <summary>The arguments as the script passed them. An undefined argument arrives as JSON null.</summary>
    public IReadOnlyList<JsonElement> Arguments { get; }

    public ScriptSession Session { get; }

    public JsonSerializerOptions JsonOptions { get; }

    /// <summary>Signalled when the script times out or the caller cancels the execution.</summary>
    public CancellationToken CancellationToken { get; }

    internal object ResolveInstance(SandboxApiDescriptor api) => _resolveInstance(api);
}
