using System.Threading;
using ScriptBox.Core.WasmExecution;

namespace ScriptBox;

/// <summary>
/// A context for running scripts against one set of host API instances.
/// Every execution still starts from a fresh JavaScript realm: nothing a
/// script defines survives into the next one. What a session carries across
/// executions is host-side state, in its API instances and <see cref="Items"/>.
/// </summary>
public sealed class ScriptSession
{
    private readonly ScriptBox _box;

    internal ScriptSession(ScriptBox box, ScriptSessionOptions options)
    {
        _box = box;
        Timeout = options.Timeout ?? box.DefaultTimeout;
        if (Timeout < TimeSpan.Zero || Timeout.TotalMilliseconds > int.MaxValue)
        {
            throw new ArgumentOutOfRangeException(nameof(options), "The session timeout must be zero (no limit) or a positive span under 24 days.");
        }

        ApiOverrides = box.ResolveSessionApis(options.Apis);
    }

    public TimeSpan Timeout { get; }

    /// <summary>State host APIs can share for the lifetime of the session, safe to use from concurrent executions.</summary>
    public IDictionary<string, object?> Items { get; } = new System.Collections.Concurrent.ConcurrentDictionary<string, object?>(StringComparer.Ordinal);

    internal IReadOnlyDictionary<string, object> ApiOverrides { get; }

    /// <summary>
    /// Runs a script and reports its outcome, including failures. The script
    /// is the body of an async function: use <c>return</c> to produce a value,
    /// and <c>await</c> freely.
    /// </summary>
    /// <exception cref="OperationCanceledException">The token was cancelled.</exception>
    public Task<ScriptExecutionResult> ExecuteAsync(string script, CancellationToken cancellationToken = default)
    {
        if (script is null)
        {
            throw new ArgumentNullException(nameof(script));
        }

        cancellationToken.ThrowIfCancellationRequested();

        // A dedicated thread, because the execution blocks it throughout, and
        // one with a large stack, because WASM runs on it.
        var completion = new TaskCompletionSource<ScriptExecutionResult>(TaskCreationOptions.RunContinuationsAsynchronously);
        var thread = new Thread(
            () =>
            {
                try
                {
                    completion.SetResult(_box.Execute(this, script, cancellationToken));
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    completion.SetCanceled();
                }
                catch (Exception ex)
                {
                    completion.SetException(ex);
                }
            },
            WasmRuntime.ExecutionThreadStackSize)
        {
            IsBackground = true,
            Name = "ScriptBox execution",
        };
        thread.Start();
        return completion.Task;
    }

    /// <summary>
    /// Runs a script and returns its value as JSON, or null for undefined.
    /// </summary>
    /// <exception cref="ScriptException">The script did not complete.</exception>
    public async Task<string?> RunAsync(string script, CancellationToken cancellationToken = default)
    {
        var result = await ExecuteAsync(script, cancellationToken).ConfigureAwait(false);
        if (result.Error is not null)
        {
            throw new ScriptException(result.Error);
        }

        return result.Json;
    }
}

public sealed class ScriptSessionOptions
{
    internal List<(object Instance, string? Namespace)> Apis { get; } = new();

    /// <summary>Overrides the box's execution timeout for this session.</summary>
    public TimeSpan? Timeout { get; set; }

    /// <summary>
    /// Serves a registered API from this instance for the session, in place of
    /// the box-wide one. The instance's type must match exactly one registered
    /// API, or the one named by <paramref name="jsNamespace"/>.
    /// </summary>
    public ScriptSessionOptions UseApi(object instance, string? jsNamespace = null)
    {
        Apis.Add((instance ?? throw new ArgumentNullException(nameof(instance)), jsNamespace));
        return this;
    }
}
