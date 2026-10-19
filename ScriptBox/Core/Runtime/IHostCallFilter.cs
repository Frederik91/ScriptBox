namespace ScriptBox.Core.Runtime;

/// <summary>Runs the rest of the filter pipeline and, at its end, the host method itself.</summary>
public delegate Task<HostCallResult> HostCallNext();

/// <summary>
/// Runs around every call a script makes into a host API, before its arguments are bound.
/// </summary>
/// <remarks>
/// A filter is where a policy that applies to every method belongs: approval, auditing, a dry run. It can call
/// <c>next</c> to let the call through, throw <see cref="ScriptApiException"/> to refuse it at the script's line,
/// or return a result of its own without calling the method at all. <see cref="HostCallContext.MethodDescriptor"/>
/// carries the method's attributes, so a filter can decide from what the method declares about itself.
/// Box filters run outside session filters, each in the order it was added.
/// </remarks>
public interface IHostCallFilter
{
    Task<HostCallResult> InvokeAsync(HostCallContext context, HostCallNext next);
}
