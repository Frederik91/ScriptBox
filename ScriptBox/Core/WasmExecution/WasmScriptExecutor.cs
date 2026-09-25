using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using ScriptBox.Core.Runtime;
using Wasmtime;

namespace ScriptBox.Core.WasmExecution;

internal sealed class ExecutionLimits
{
    public TimeSpan Timeout { get; init; }
    public long MemoryBytes { get; init; }
    public int MaxLogEntries { get; init; }
    public int MaxLogEntryLength { get; init; }
    public int MaxResultBytes { get; init; }
}

internal sealed record BootstrapScript(string Name, string Code);

/// <summary>
/// Runs one script in a fresh WASM instance. See scriptbox_wrapper.c for the
/// guest side of the ABI implemented here.
/// </summary>
/// <remarks>
/// <see cref="Execute"/> is synchronous and blocks its thread for the whole
/// execution, including every host call the script makes, because a WASM host
/// import cannot yield. <see cref="ScriptSession"/> therefore runs it on a
/// dedicated thread rather than a thread-pool one.
/// </remarks>
internal sealed class WasmScriptExecutor
{
    public const string UserScriptName = "script.js";

    // The epoch deadline sits past the timeout so the clean interrupt, which
    // reports a proper error, gets the first chance to stop the script.
    private static readonly TimeSpan HardStopGrace = TimeSpan.FromSeconds(2);
    private static readonly Regex UserFrameLine = new(@"script\.js:(\d+)", RegexOptions.Compiled);

    private readonly Module _module;
    private readonly IReadOnlyDictionary<string, HostMethodHandler> _handlers;
    private readonly JsonSerializerOptions _jsonOptions;

    public WasmScriptExecutor(
        Module module,
        IReadOnlyDictionary<string, HostMethodHandler> handlers,
        JsonSerializerOptions jsonOptions)
    {
        _module = module;
        _handlers = handlers;
        _jsonOptions = jsonOptions;
    }

    public ScriptExecutionResult Execute(
        IReadOnlyList<BootstrapScript> bootstrap,
        string userScript,
        ScriptSession session,
        Func<SandboxApiDescriptor, object> resolveInstance,
        ExecutionLimits limits,
        CancellationToken cancellationToken)
    {
        var stopwatch = Stopwatch.StartNew();
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        if (limits.Timeout > TimeSpan.Zero)
        {
            linked.CancelAfter(limits.Timeout);
        }

        var run = new Execution(this, session, resolveInstance, limits, linked.Token);
        using var interruptOnCancel = linked.Token.Register(run.RequestInterrupt);

        ScriptError? error;
        var stopped = false;
        try
        {
            error = RunInstance(run, bootstrap, userScript, limits);
        }
        catch (ExecutionStoppedException)
        {
            stopped = true;
            error = null;
        }
        catch (WasmtimeException ex) when (run.InterruptRequested && (ex is TrapException || ex.InnerException is ExecutionStoppedException))
        {
            // Either host.interrupt or host.call refused to go on, or the epoch deadline fired inside a native
            // operation that never polled.
            stopped = true;
            error = null;
        }
        catch (TrapException ex) when (ex.Message.Contains("call stack exhausted"))
        {
            // Normally QuickJS raises its catchable "stack overflow" first; see WasmRuntime.MaxWasmStackSize.
            error = new ScriptError(ScriptErrorKind.Exception, "InternalError", "stack overflow", null, null);
        }
        catch (SandboxMemoryException)
        {
            error = new ScriptError(ScriptErrorKind.MemoryLimit, "InternalError", "The sandbox ran out of memory while loading the script.", null, null);
        }
        catch (WasmtimeException ex)
        {
            error = new ScriptError(ScriptErrorKind.Fault, "SandboxFault", ex.InnerException?.Message ?? FirstLine(ex.Message), null, null);
        }

        // Only a run the interrupt actually stopped is a timeout. One that finished while the timer fired keeps its result.
        if (stopped)
        {
            cancellationToken.ThrowIfCancellationRequested();
            error = new ScriptError(
                ScriptErrorKind.Timeout,
                "TimeoutError",
                $"The script was stopped after running longer than its {limits.Timeout.TotalSeconds.ToString("0.#", System.Globalization.CultureInfo.InvariantCulture)} s timeout.",
                null,
                null);
        }
        else if (error is null && run.OversizedResultBytes is { } size)
        {
            error = new ScriptError(
                ScriptErrorKind.Exception,
                "RangeError",
                $"The script returned {size} bytes of JSON, more than the {limits.MaxResultBytes} allowed. Return only what is needed.",
                null,
                null);
        }

        return new ScriptExecutionResult(
            error is null ? run.ResultJson : null,
            error,
            run.Logs,
            stopwatch.Elapsed,
            _jsonOptions);
    }

    private ScriptError? RunInstance(Execution run, IReadOnlyList<BootstrapScript> bootstrap, string userScript, ExecutionLimits limits)
    {
        using var store = new Store(WasmRuntime.Engine);
        store.SetLimits(memorySize: limits.MemoryBytes);
        store.SetWasiConfiguration(new WasiConfiguration());
        store.SetEpochDeadline(limits.Timeout > TimeSpan.Zero
            ? WasmRuntime.TicksFor(limits.Timeout + HardStopGrace)
            : ulong.MaxValue / 2);

        using var linker = new Linker(WasmRuntime.Engine);
        linker.DefineWasi();
        run.DefineImports(linker, store);

        var instance = linker.Instantiate(store, _module);
        var memory = instance.GetMemory("memory") ?? throw new InvalidOperationException("The module exports no memory.");
        var init = instance.GetFunction<int>("sb_init") ?? throw MissingExport("sb_init");
        var eval = instance.GetFunction<int, int, int, int, int, int>("sb_eval") ?? throw MissingExport("sb_eval");
        var alloc = instance.GetFunction<int, int>("sb_alloc") ?? throw MissingExport("sb_alloc");
        var free = instance.GetAction<int>("sb_free") ?? throw MissingExport("sb_free");

        if (init() != 0)
        {
            return run.TakeError(ScriptErrorKind.Fault);
        }

        foreach (var script in bootstrap)
        {
            if (Evaluate(memory, alloc, free, eval, script.Name, script.Code, reportResult: false) != 0)
            {
                var failure = run.TakeError(ScriptErrorKind.Fault);
                return failure with { Message = $"Bootstrap script '{script.Name}' failed: {failure.Message}" };
            }
        }

        // The prefix shares the first line with the user's code so reported
        // line numbers match the submitted source.
        var wrapped = "(async () => {\"use strict\";" + userScript + "\n})()";
        return Evaluate(memory, alloc, free, eval, UserScriptName, wrapped, reportResult: true) == 0
            ? null
            : run.TakeError(ScriptErrorKind.Exception);
    }

    private static int Evaluate(
        Memory memory,
        Func<int, int> alloc,
        Action<int> free,
        Func<int, int, int, int, int, int> eval,
        string name,
        string code,
        bool reportResult)
    {
        var codeBytes = Encoding.UTF8.GetBytes(code);
        var nameBytes = Encoding.UTF8.GetBytes(name);

        var codePtr = WriteBuffer(memory, alloc, codeBytes);
        var namePtr = WriteBuffer(memory, alloc, nameBytes);
        try
        {
            // sb_eval frees the code buffer itself.
            return eval(codePtr, codeBytes.Length, namePtr, nameBytes.Length, reportResult ? 1 : 0);
        }
        finally
        {
            free(namePtr);
        }
    }

    private static int WriteBuffer(Memory memory, Func<int, int> alloc, byte[] bytes)
    {
        var ptr = alloc(bytes.Length);
        if (ptr == 0)
        {
            throw new SandboxMemoryException();
        }

        // Fetched after alloc: growing the memory can move it.
        bytes.AsSpan().CopyTo(memory.GetSpan(ptr, bytes.Length));
        return ptr;
    }

    // Wasmtime appends the whole WASM backtrace to a trap's message.
    private static string FirstLine(string message)
    {
        var end = message.IndexOf('\n');
        return (end < 0 ? message : message.Substring(0, end)).TrimEnd('\r');
    }

    private sealed class SandboxMemoryException : Exception
    {
    }

    private sealed class ExecutionStoppedException : Exception
    {
    }

    private static InvalidOperationException MissingExport(string name)
    {
        return new InvalidOperationException($"The WASM module does not export '{name}'. It was built for another version of ScriptBox.");
    }

    internal static (string? Stack, int? Line) FilterStack(string? stack)
    {
        if (string.IsNullOrEmpty(stack))
        {
            return (null, null);
        }

        var frames = stack!
            .Split('\n')
            .Select(line => line.TrimEnd('\r'))
            .Where(line => line.Contains(UserScriptName))
            .ToList();

        if (frames.Count == 0)
        {
            return (null, null);
        }

        var match = UserFrameLine.Match(frames[0]);
        int? line = match.Success ? int.Parse(match.Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture) : null;
        return (string.Join("\n", frames), line);
    }

    /// <summary>
    /// State for one execution, shared between the host imports the guest calls.
    /// </summary>
    private sealed class Execution
    {
        private readonly WasmScriptExecutor _owner;
        private readonly ScriptSession _session;
        private readonly Func<SandboxApiDescriptor, object> _resolveInstance;
        private readonly ExecutionLimits _limits;
        private readonly CancellationToken _token;
        private readonly List<ScriptLogEntry> _logs = new();
        private byte[] _pendingResponse = Array.Empty<byte>();
        private (string Name, string Message, string Stack)? _error;
        private int _interrupt;
        private bool _logsTruncated;

        public Execution(
            WasmScriptExecutor owner,
            ScriptSession session,
            Func<SandboxApiDescriptor, object> resolveInstance,
            ExecutionLimits limits,
            CancellationToken token)
        {
            _owner = owner;
            _session = session;
            _resolveInstance = resolveInstance;
            _limits = limits;
            _token = token;
        }

        public string? ResultJson { get; private set; }

        public int? OversizedResultBytes { get; private set; }

        public IReadOnlyList<ScriptLogEntry> Logs => _logs;

        public bool InterruptRequested => Volatile.Read(ref _interrupt) != 0;

        public void RequestInterrupt() => Volatile.Write(ref _interrupt, 1);

        public ScriptError TakeError(ScriptErrorKind kind)
        {
            if (_error is not { } error)
            {
                return new ScriptError(ScriptErrorKind.Fault, "SandboxFault", "The script failed without reporting an error.", null, null);
            }

            _error = null;
            if (error.Name == "InternalError" && error.Message == "out of memory")
            {
                kind = ScriptErrorKind.MemoryLimit;
            }

            var (stack, line) = FilterStack(error.Stack);
            return new ScriptError(kind, error.Name, error.Message, stack, line);
        }

        public void DefineImports(Linker linker, Store store)
        {
            linker.Define("host", "call", Function.FromCallback(store, (Caller caller, int ptr, int len) => Call(caller, ptr, len)));
            linker.Define("host", "take", Function.FromCallback(store, (Caller caller, int ptr, int len) => Take(caller, ptr, len)));
            linker.Define("host", "log", Function.FromCallback(store, (Caller caller, int level, int ptr, int len) => Log(caller, level, ptr, len)));
            // Throwing traps the instance. QuickJS's own interrupt raises an error that an async function or a
            // promise turns into an ordinary rejection, which a script can catch and carry on from.
            linker.Define("host", "interrupt", Function.FromCallback(store, (Caller _) =>
            {
                ThrowIfStopping();
                return 0;
            }));
            linker.Define("host", "result", Function.FromCallback(store, (Caller caller, int ptr, int len) =>
            {
                if (len > _limits.MaxResultBytes)
                {
                    OversizedResultBytes = len;
                    return;
                }

                ResultJson = len == 0 ? null : ReadString(caller, ptr, len);
            }));
            linker.Define("host", "error", Function.FromCallback(store,
                (Caller caller, int namePtr, int nameLen, int messagePtr, int messageLen, int stackPtr, int stackLen) =>
                {
                    _error = (ReadString(caller, namePtr, nameLen), ReadString(caller, messagePtr, messageLen), ReadString(caller, stackPtr, stackLen));
                }));
        }

        private void ThrowIfStopping()
        {
            if (InterruptRequested)
            {
                throw new ExecutionStoppedException();
            }
        }

        private int Call(Caller caller, int ptr, int len)
        {
            ThrowIfStopping();
            _pendingResponse = Dispatch(ReadString(caller, ptr, len));
            return _pendingResponse.Length;
        }

        private void Take(Caller caller, int ptr, int len)
        {
            var memory = caller.GetMemory("memory")!;
            _pendingResponse.AsSpan(0, len).CopyTo(memory.GetSpan(ptr, len));
            _pendingResponse = Array.Empty<byte>();
        }

        private void Log(Caller caller, int level, int ptr, int len)
        {
            if (_logs.Count >= _limits.MaxLogEntries)
            {
                if (!_logsTruncated)
                {
                    _logsTruncated = true;
                    _logs.Add(new ScriptLogEntry(ScriptLogLevel.Warn, $"Further console output was dropped after {_limits.MaxLogEntries} entries."));
                }
                return;
            }

            // A UTF-8 character is at most four bytes, so this is enough for the part that is kept.
            var message = ReadString(caller, ptr, Math.Min(len, _limits.MaxLogEntryLength * 4));
            if (message.Length > _limits.MaxLogEntryLength)
            {
                message = message.Substring(0, _limits.MaxLogEntryLength) + $"... [{message.Length - _limits.MaxLogEntryLength} more characters]";
            }

            var logLevel = level is >= 0 and <= 3 ? (ScriptLogLevel)level : ScriptLogLevel.Log;
            _logs.Add(new ScriptLogEntry(logLevel, message));
        }

        private byte[] Dispatch(string payload)
        {
            string method;
            JsonElement[] arguments;
            try
            {
                using var document = JsonDocument.Parse(payload);
                var root = document.RootElement;
                method = root.GetProperty("method").GetString() ?? string.Empty;
                arguments = root.TryGetProperty("args", out var args) && args.ValueKind == JsonValueKind.Array
                    ? args.EnumerateArray().Select(a => a.Clone()).ToArray()
                    : Array.Empty<JsonElement>();
            }
            catch (Exception ex) when (ex is JsonException or KeyNotFoundException or InvalidOperationException)
            {
                return ErrorResponse("HostError", "Malformed host call: " + ex.Message);
            }

            if (!_owner._handlers.TryGetValue(method, out var handler))
            {
                return ErrorResponse("TypeError", $"'{method}' is not a host API method.");
            }

            var context = new HostCallContext(method, arguments, _session, _owner._jsonOptions, _resolveInstance, _token);
            try
            {
                var result = handler(context).GetAwaiter().GetResult();
                return ResultResponse(result);
            }
            catch (OperationCanceledException) when (InterruptRequested)
            {
                throw new ExecutionStoppedException();
            }
            catch (Exception ex)
            {
                return ExceptionResponse(ex);
            }
        }

        private byte[] ResultResponse(HostCallResult result)
        {
            using var buffer = new MemoryStream();
            using (var writer = new Utf8JsonWriter(buffer))
            {
                writer.WriteStartObject();
                writer.WritePropertyName("result");
                if (result.Value is null)
                {
                    writer.WriteNullValue();
                }
                else
                {
                    var type = result.DeclaredType == typeof(object) || result.DeclaredType == typeof(void)
                        ? result.Value.GetType()
                        : result.DeclaredType;
                    JsonSerializer.Serialize(writer, result.Value, type, _owner._jsonOptions);
                }
                writer.WriteEndObject();
            }

            return buffer.ToArray();
        }

        private static byte[] ExceptionResponse(Exception ex)
        {
            while (ex is AggregateException { InnerException: { } inner })
            {
                ex = inner;
            }

            return ex switch
            {
                ScriptApiException api => ErrorResponse(api.ErrorName, api.Message),
                OperationCanceledException => ErrorResponse("AbortError", "The host call was cancelled."),
                _ => ErrorResponse("HostError", ex.Message),
            };
        }

        private static byte[] ErrorResponse(string name, string message)
        {
            return JsonSerializer.SerializeToUtf8Bytes(new Dictionary<string, object>
            {
                ["error"] = new Dictionary<string, string> { ["name"] = name, ["message"] = message },
            });
        }

        private static string ReadString(Caller caller, int ptr, int len)
        {
            if (len <= 0)
            {
                return string.Empty;
            }

            var memory = caller.GetMemory("memory")!;
#if NETSTANDARD2_0
            return Encoding.UTF8.GetString(memory.GetSpan(ptr, len).ToArray());
#else
            return Encoding.UTF8.GetString(memory.GetSpan(ptr, len));
#endif
        }
    }
}
