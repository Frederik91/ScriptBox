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
        SandboxApiDescriptor api,
        SandboxMethodDescriptor method,
        IReadOnlyList<JsonElement> arguments,
        IReadOnlyList<int> omittedArguments,
        ScriptSession session,
        JsonSerializerOptions jsonOptions,
        Func<SandboxApiDescriptor, object> resolveInstance,
        CancellationToken cancellationToken)
    {
        Api = api;
        MethodDescriptor = method;
        Arguments = arguments;
        OmittedArguments = omittedArguments;
        Session = session;
        JsonOptions = jsonOptions;
        _resolveInstance = resolveInstance;
        CancellationToken = cancellationToken;
    }

    /// <summary>The called method as the script names it, e.g. <c>tasks.get</c>.</summary>
    public string Method => MethodDescriptor.HostMethodName;

    public SandboxApiDescriptor Api { get; }

    public SandboxMethodDescriptor MethodDescriptor { get; }

    /// <summary>
    /// The arguments as the script passed them. Trailing undefined arguments are left out. An undefined argument
    /// before a given one holds JSON null and is listed in <see cref="OmittedArguments"/>.
    /// </summary>
    public IReadOnlyList<JsonElement> Arguments { get; }

    /// <summary>Positions in <see cref="Arguments"/> the script left undefined. They take the parameter's default.</summary>
    public IReadOnlyList<int> OmittedArguments { get; }

    public ScriptSession Session { get; }

    public JsonSerializerOptions JsonOptions { get; }

    /// <summary>Signalled when the script times out or the caller cancels the execution.</summary>
    public CancellationToken CancellationToken { get; }

    internal object ResolveInstance(SandboxApiDescriptor api) => _resolveInstance(api);
}
