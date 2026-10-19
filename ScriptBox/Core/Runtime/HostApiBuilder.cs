namespace ScriptBox.Core.Runtime;

/// <summary>
/// A host method's return value with the type it is serialized as. Results are
/// serialized as the declared type so polymorphic contracts keep their type
/// discriminator; <c>object</c> falls back to the runtime type.
/// </summary>
public sealed class HostCallResult
{
    public static readonly HostCallResult Void = new(null, typeof(void));

    public HostCallResult(object? value, Type declaredType)
    {
        Value = value;
        DeclaredType = declaredType ?? throw new ArgumentNullException(nameof(declaredType));
    }

    public object? Value { get; }

    public Type DeclaredType { get; }

    /// <summary>A result serialized as the runtime type of <paramref name="value"/>.</summary>
    public static HostCallResult From(object? value) => value is null ? Void : new HostCallResult(value, value.GetType());
}

internal delegate Task<HostCallResult> HostMethodHandler(HostCallContext context);

internal sealed record HostMethod(SandboxApiDescriptor Api, SandboxMethodDescriptor Descriptor, HostMethodHandler Handler);

internal sealed class HostApiBuilder
{
    private readonly Dictionary<string, HostMethod> _methods = new(StringComparer.Ordinal);

    public HostApiBuilder Register(SandboxApiDescriptor api, SandboxMethodDescriptor method, HostMethodHandler handler)
    {
        if (_methods.ContainsKey(method.HostMethodName))
        {
            throw new InvalidOperationException($"The host method '{method.HostMethodName}' is registered twice.");
        }

        _methods[method.HostMethodName] = new HostMethod(api, method, handler ?? throw new ArgumentNullException(nameof(handler)));
        return this;
    }

    internal IReadOnlyDictionary<string, HostMethod> Build() => new Dictionary<string, HostMethod>(_methods, StringComparer.Ordinal);
}
