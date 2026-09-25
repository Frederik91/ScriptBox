namespace ScriptBox.Core.Runtime;

/// <summary>
/// A host method's return value with the type it was declared as. Results are
/// serialized as the declared type so polymorphic contracts keep their type
/// discriminator; <c>object</c> falls back to the runtime type.
/// </summary>
internal sealed class HostCallResult
{
    public static readonly HostCallResult Void = new(null, typeof(void));

    public HostCallResult(object? value, Type declaredType)
    {
        Value = value;
        DeclaredType = declaredType;
    }

    public object? Value { get; }

    public Type DeclaredType { get; }
}

internal delegate Task<HostCallResult> HostMethodHandler(HostCallContext context);

internal sealed class HostApiBuilder
{
    private readonly Dictionary<string, HostMethodHandler> _handlers = new(StringComparer.Ordinal);

    public HostApiBuilder RegisterHandler(string methodName, HostMethodHandler handler)
    {
        if (string.IsNullOrWhiteSpace(methodName))
        {
            throw new ArgumentException("Method name cannot be null or empty", nameof(methodName));
        }

        if (_handlers.ContainsKey(methodName))
        {
            throw new InvalidOperationException($"The host method '{methodName}' is registered twice.");
        }

        _handlers[methodName] = handler ?? throw new ArgumentNullException(nameof(handler));
        return this;
    }

    internal IReadOnlyDictionary<string, HostMethodHandler> Build()
    {
        return new Dictionary<string, HostMethodHandler>(_handlers, StringComparer.Ordinal);
    }
}
