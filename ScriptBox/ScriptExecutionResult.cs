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
        JsonSerializerOptions jsonOptions)
    {
        Json = json;
        Error = error;
        Logs = logs;
        Duration = duration;
        _jsonOptions = jsonOptions;
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
