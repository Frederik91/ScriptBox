using System.Text.Json;

namespace ScriptBox;

/// <summary>
/// The outcome of one script execution. A script that throws, times out or
/// runs out of memory still produces a result: <see cref="Error"/> says what
/// happened, so the caller can hand it back to whoever wrote the script.
/// Only cancellation through the caller's token is raised as an exception.
/// </summary>
public sealed class ScriptExecutionResult
{
    private readonly JsonSerializerOptions _jsonOptions;

    internal ScriptExecutionResult(
        string? json,
        ScriptError? error,
        IReadOnlyList<ScriptLogEntry> logs,
        TimeSpan duration,
        JsonSerializerOptions jsonOptions,
        IReadOnlyList<HostCallError> hostErrors)
    {
        Json = json;
        Error = error;
        Logs = logs;
        Duration = duration;
        _jsonOptions = jsonOptions;
        HostErrors = hostErrors;
    }

    public bool Succeeded => Error is null;

    /// <summary>
    /// The script's return value as JSON, or null when it returned undefined
    /// or failed. A returned promise is settled first.
    /// </summary>
    public string? Json { get; }

    public ScriptError? Error { get; }

    public IReadOnlyList<ScriptLogEntry> Logs { get; }

    public TimeSpan Duration { get; }

    /// <summary>
    /// Exceptions host methods threw, other than <see cref="ScriptApiException"/>, in the order they happened. The
    /// script saw each only as a <c>HostError</c> saying the method failed, so their detail stays on the host.
    /// </summary>
    public IReadOnlyList<HostCallError> HostErrors { get; }

    public T? GetValue<T>()
    {
        return Json is null ? default : JsonSerializer.Deserialize<T>(Json, _jsonOptions);
    }
}

public enum ScriptErrorKind
{
    /// <summary>The script threw, or let an error from a host API call escape.</summary>
    Exception,

    /// <summary>The script ran past its execution timeout and was stopped.</summary>
    Timeout,

    /// <summary>The script exhausted the sandbox's memory limit.</summary>
    MemoryLimit,

    /// <summary>The sandbox itself failed; the script is not necessarily at fault.</summary>
    Fault,
}

/// <summary>
/// Why a script did not complete. <see cref="Stack"/> keeps only the frames in
/// the submitted script, so its line numbers refer to the source as written.
/// </summary>
public sealed record ScriptError(ScriptErrorKind Kind, string Name, string Message, string? Stack, int? Line)
{
    private readonly string? _code;

    /// <summary>
    /// Why the script failed, in the vocabulary of the Node host's failure codes: <c>invalid-source</c>,
    /// <c>script-error</c>, <c>unhandled-rejection</c>, <c>never-settled</c>, <c>invalid-result</c>, <c>denied</c>,
    /// <c>invalid-arguments</c>, <c>host-failure</c>, <c>protocol-mismatch</c> or <c>internal</c>. A timeout is
    /// <c>timed-out</c> and an exhausted memory limit <c>resource-limit</c>, the statuses Node reports for them.
    /// </summary>
    /// <remarks>
    /// <c>denied</c>, <c>invalid-arguments</c> and <c>host-failure</c> come from the name of the error the script let
    /// escape, which a script could imitate.
    /// </remarks>
    public string Code
    {
        get => _code ?? Classify(Kind, Name, Message);
        init => _code = value;
    }

    private static string Classify(ScriptErrorKind kind, string name, string message) => kind switch
    {
        ScriptErrorKind.Timeout => "timed-out",
        ScriptErrorKind.MemoryLimit => "resource-limit",
        ScriptErrorKind.Fault => "internal",
        _ => name switch
        {
            "PermissionDeniedError" or "UnknownMethodError" => "denied",
            "InvalidArgumentsError" => "invalid-arguments",
            "HostError" or "HostTimeoutError" or "ResponseTooLargeError" => "host-failure",
            _ => message.StartsWith("The script's result", StringComparison.Ordinal) ? "invalid-result" : "script-error",
        },
    };

    public override string ToString()
    {
        var head = string.IsNullOrEmpty(Name) ? Message : $"{Name}: {Message}";
        return string.IsNullOrEmpty(Stack) ? head : $"{head}\n{Stack}";
    }
}

public enum ScriptLogLevel
{
    Log,
    Info,
    Warn,
    Error,
}

public sealed record ScriptLogEntry(ScriptLogLevel Level, string Message);

/// <summary>An exception a host method threw, which the script saw only as a <c>HostError</c>.</summary>
public sealed record HostCallError(string Method, Exception Exception);
