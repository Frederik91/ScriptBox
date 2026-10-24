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

    /// <summary>Calls a script has made and the host has not yet answered. The same default as the Node host.</summary>
    public int MaxOutstandingCalls { get; init; } = 16;
}

internal sealed record BootstrapScript(string Name, string Code);

/// <summary>
/// Runs one script in a fresh WASM instance of the guest the Node host runs
/// too. See scriptbox_wrapper.c for the guest side of the ABI implemented here.
/// </summary>
/// <remarks>
/// A host call is posted: the guest returns to the host with the call queued,
/// the host answers it, and <c>sb_resume</c> settles the script's promise.
/// Calls are answered one at a time, in the order the script made them.
/// <see cref="Execute"/> blocks its thread for the whole execution, host calls
/// included: Wasmtime runs the guest on the calling thread's native stack, and
/// QuickJS's recursion needs more of it than a thread-pool thread has.
/// <see cref="ScriptSession"/> therefore runs it on a dedicated thread with a
/// large stack.
/// </remarks>
internal sealed class WasmScriptExecutor
{
    public const string UserScriptName = "script.js";

    /// <summary>The guest ABI this host speaks: scriptbox-async.wasm's sb_abi_version.</summary>
    public const int GuestAbiVersion = 2;

    private const int SbOk = 0;
    private const int SbScriptError = 1;
    private const int SbPending = 4;
    private const int SbUnhandledRejection = 5;
    private const int SbSyntaxError = 7;

    private const long PageSize = 64 * 1024;

    // The epoch deadline sits past the timeout so the clean interrupt, which
    // reports a proper error, gets the first chance to stop the script.
    private static readonly TimeSpan HardStopGrace = TimeSpan.FromSeconds(2);
    private static readonly Regex UserFrameLine = new(@"script\.js:(\d+)", RegexOptions.Compiled);

    private readonly Module _module;
    private readonly long _initialMemoryPages;
    private readonly IReadOnlyDictionary<string, HostMethod> _methods;
    private readonly IReadOnlyList<IHostCallFilter> _filters;
    private readonly JsonSerializerOptions _jsonOptions;

    public WasmScriptExecutor(
        Module module,
        IReadOnlyDictionary<string, HostMethod> methods,
        IReadOnlyList<IHostCallFilter> filters,
        JsonSerializerOptions jsonOptions)
    {
        _module = module;
        _initialMemoryPages = module.Imports.OfType<MemoryImport>().FirstOrDefault(i => i.ModuleName == "env" && i.Name == "memory")?.Minimum
            ?? throw new InvalidOperationException("The WASM module does not import its memory. It was built for another version of ScriptBox.");
        _methods = methods;
        _filters = filters;
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
        catch (WasmtimeException ex) when (ex.InnerException is SandboxMemoryException || ex is TrapException && run.MemoryExhausted)
        {
            error = MemoryError(limits);
        }
        catch (WasmtimeException ex) when (run.InterruptRequested && (ex is TrapException || ex.InnerException is ExecutionStoppedException))
        {
            // Either host.interrupt or host.post refused to go on, or the epoch deadline fired inside a native
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
            error = MemoryError(limits);
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
                null) { Code = "resource-limit" };
        }

        return new ScriptExecutionResult(
            error is null ? run.ResultJson : null,
            error,
            run.Logs,
            stopwatch.Elapsed,
            _jsonOptions,
            run.HostErrors);
    }

    private static ScriptError MemoryError(ExecutionLimits limits) => new(
        ScriptErrorKind.MemoryLimit,
        "InternalError",
        $"The script used all {limits.MemoryBytes} bytes of its memory.",
        null,
        null);

    private ScriptError? RunInstance(Execution run, IReadOnlyList<BootstrapScript> bootstrap, string userScript, ExecutionLimits limits)
    {
        using var store = new Store(WasmRuntime.Engine);
        store.SetLimits(memorySize: limits.MemoryBytes);
        store.SetEpochDeadline(limits.Timeout > TimeSpan.Zero
            ? WasmRuntime.TicksFor(limits.Timeout + HardStopGrace)
            : ulong.MaxValue / 2);

        // The guest imports its memory, so its maximum is the memory limit. Its allocator traps through host.limit
        // when it cannot grow further, rather than raising an error a script could catch.
        var memory = new Memory(store, _initialMemoryPages, Math.Max(_initialMemoryPages, limits.MemoryBytes / PageSize));

        using var linker = new Linker(WasmRuntime.Engine);
        linker.Define("env", "memory", memory);
        run.DefineImports(linker, store, memory);
        DefineWasi(linker, store, memory);

        var instance = linker.Instantiate(store, _module);
        var abiVersion = instance.GetFunction<int>("sb_abi_version") ?? throw MissingExport("sb_abi_version");

        // Checked before anything runs in the guest.
        var abi = abiVersion();
        if (abi != GuestAbiVersion)
        {
            return new ScriptError(
                ScriptErrorKind.Fault,
                "SandboxFault",
                $"The WASM module speaks guest ABI {abi}, but this host needs ABI {GuestAbiVersion}. It was built for another version of ScriptBox.",
                null,
                null) { Code = "protocol-mismatch" };
        }

        var init = instance.GetFunction<int>("sb_init") ?? throw MissingExport("sb_init");
        var eval = instance.GetFunction<int, int, int, int, int, int>("sb_eval") ?? throw MissingExport("sb_eval");
        var resume = instance.GetFunction<int, int, int>("sb_resume") ?? throw MissingExport("sb_resume");
        var finish = instance.GetFunction<int>("sb_finish") ?? throw MissingExport("sb_finish");
        var alloc = instance.GetFunction<int, int>("sb_alloc") ?? throw MissingExport("sb_alloc");
        var free = instance.GetAction<int>("sb_free") ?? throw MissingExport("sb_free");

        if (init() != SbOk)
        {
            return run.TakeError(ScriptErrorKind.Fault, "internal");
        }

        foreach (var script in bootstrap)
        {
            if (Evaluate(memory, alloc, free, eval, script.Name, script.Code, mode: 0) != SbOk)
            {
                var failure = run.TakeError(ScriptErrorKind.Fault, "internal");
                return failure with
                {
                    Message = $"Bootstrap script '{script.Name}' failed: {failure.Message}",
                    Code = failure.Message.Contains("bootstrap version") || failure.Message.Contains("protocol") ? "protocol-mismatch" : "internal",
                };
            }
        }

        // The prefix shares the first line with the user's code so reported
        // line numbers match the submitted source.
        var wrapped = "(async () => {\"use strict\";" + userScript + "\n})()";
        var status = Evaluate(memory, alloc, free, eval, UserScriptName, wrapped, mode: 2);
        return run.Drive(status, response => resume(WriteBuffer(memory, alloc, response), response.Length), finish);
    }

    private const int ErrnoBadf = 8;
    private const int ErrnoNosys = 52;

    // The WASI functions the guest imports, as the Node host provides them: a clock and nothing else. No files, no
    // environment, no arguments. Output to stdout and stderr is discarded; QuickJS writes there only from debugging
    // helpers this build never calls. Wasmtime's own WASI needs the memory exported, and this guest imports it.
    private static void DefineWasi(Linker linker, Store store, Memory memory)
    {
        const string module = "wasi_snapshot_preview1";
        var started = Stopwatch.StartNew();
        linker.Define(module, "clock_time_get", Function.FromCallback(store, (Caller _, int clockId, long precision, int timePtr) =>
        {
            var nanoseconds = clockId == 0
                ? (DateTimeOffset.UtcNow - DateTimeOffset.FromUnixTimeMilliseconds(0)).Ticks * 100
                : started.Elapsed.Ticks * 100;
            memory.WriteInt64(timePtr, nanoseconds);
            return 0;
        }));
        linker.Define(module, "args_sizes_get", Function.FromCallback(store, (Caller _, int countPtr, int sizePtr) =>
        {
            memory.WriteInt32(countPtr, 0);
            memory.WriteInt32(sizePtr, 0);
            return 0;
        }));
        linker.Define(module, "args_get", Function.FromCallback(store, (Caller _, int argv, int argvBuffer) => 0));
        linker.Define(module, "fd_write", Function.FromCallback(store, (Caller _, int fd, int iovs, int iovsLength, int writtenPtr) =>
        {
            if (fd != 1 && fd != 2)
            {
                return ErrnoBadf;
            }

            var total = 0;
            for (var i = 0; i < iovsLength; i++)
            {
                total += memory.ReadInt32(iovs + i * 8 + 4);
            }

            memory.WriteInt32(writtenPtr, total);
            return 0;
        }));
        linker.Define(module, "fd_close", Function.FromCallback(store, (Caller _, int fd) => ErrnoBadf));
        linker.Define(module, "fd_seek", Function.FromCallback(store, (Caller _, int fd, long offset, int whence, int newOffsetPtr) => ErrnoBadf));
        linker.Define(module, "poll_oneoff", Function.FromCallback(store, (Caller _, int input, int output, int subscriptions, int eventsPtr) => ErrnoNosys));
        linker.Define(module, "proc_exit", Function.FromCallback(store, (Caller _, int code) =>
        {
            throw new InvalidOperationException("The guest exited.");
        }));
    }

    private static int Evaluate(
        Memory memory,
        Func<int, int> alloc,
        Action<int> free,
        Func<int, int, int, int, int, int> eval,
        string name,
        string code,
        int mode)
    {
        var codeBytes = Encoding.UTF8.GetBytes(code);
        var nameBytes = Encoding.UTF8.GetBytes(name);

        var codePtr = WriteBuffer(memory, alloc, codeBytes);
        var namePtr = WriteBuffer(memory, alloc, nameBytes);
        try
        {
            // sb_eval frees the code buffer itself.
            return eval(codePtr, codeBytes.Length, namePtr, nameBytes.Length, mode);
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
        private readonly List<HostCallError> _hostErrors = new();
        private readonly Queue<(int Id, string Payload)> _queue = new();
        private Memory? _memory;
        private (string Name, string Message, string Stack)? _error;
        private int _interrupt;
        private int _nextId = 1;
        private bool _mainSettled;
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

        public bool MemoryExhausted { get; private set; }

        public IReadOnlyList<ScriptLogEntry> Logs => _logs;

        public IReadOnlyList<HostCallError> HostErrors => _hostErrors;

        // The token is checked too: a host call can see it cancelled before the registration has set the flag.
        public bool InterruptRequested => Volatile.Read(ref _interrupt) != 0 || _token.IsCancellationRequested;

        public void RequestInterrupt() => Volatile.Write(ref _interrupt, 1);

        public ScriptError TakeError(ScriptErrorKind kind, string? code = null)
        {
            if (_error is not { } error)
            {
                return new ScriptError(ScriptErrorKind.Fault, "SandboxFault", "The script failed without reporting an error.", null, null);
            }

            _error = null;
            var (stack, line) = FilterStack(error.Stack);
            var result = new ScriptError(kind, error.Name, error.Message, stack, line);
            return code is null ? result : result with { Code = code };
        }

        /// <summary>
        /// Answers the script's posted calls, one at a time in the order it made them, until its outcome is known.
        /// <paramref name="status"/> is what starting the script returned.
        /// </summary>
        public ScriptError? Drive(int status, Func<byte[], int> resume, Func<int> finish)
        {
            while (true)
            {
                if (!_mainSettled)
                {
                    if (status == SbPending)
                    {
                        if (_queue.Count == 0)
                        {
                            return new ScriptError(
                                ScriptErrorKind.Exception,
                                "Error",
                                "The script awaited a promise that nothing can settle: no host call is pending.",
                                null,
                                null) { Code = "never-settled" };
                        }
                    }
                    else
                    {
                        // From here on no new call is admitted. Calls the script made and did not await still run.
                        _mainSettled = true;
                        if (status is SbScriptError or SbSyntaxError)
                        {
                            // A failed script's pending calls are revoked: they never reach the host.
                            return TakeError(ScriptErrorKind.Exception, status == SbSyntaxError ? "invalid-source" : null);
                        }

                        if (status != SbOk)
                        {
                            return TakeError(ScriptErrorKind.Fault, "internal");
                        }
                    }
                }
                else if (status != SbOk)
                {
                    return TakeError(status == SbScriptError ? ScriptErrorKind.Exception : ScriptErrorKind.Fault, status == SbScriptError ? null : "internal");
                }

                if (_queue.Count == 0)
                {
                    var finished = finish();
                    if (finished == SbUnhandledRejection)
                    {
                        var rejection = TakeError(ScriptErrorKind.Exception, "unhandled-rejection");
                        return rejection with { Message = "A promise was rejected and nothing handled it: " + rejection.Message };
                    }

                    return finished == SbOk ? null : TakeError(ScriptErrorKind.Fault, "internal");
                }

                ThrowIfStopping();
                var (id, payload) = _queue.Dequeue();
                var response = Dispatch(id, payload);
                ThrowIfStopping();
                status = resume(response);
            }
        }

        public void DefineImports(Linker linker, Store store, Memory memory)
        {
            _memory = memory;
            linker.Define("host", "post", Function.FromCallback(store, (Caller _, int ptr, int len) => Post(ptr, len)));
            linker.Define("host", "limit", Function.FromCallback(store, (Caller _, int kind) =>
            {
                MemoryExhausted = true;
                throw new SandboxMemoryException();
            }));
            linker.Define("host", "log", Function.FromCallback(store, (Caller _, int level, int ptr, int len) => Log(level, ptr, len)));
            // Throwing traps the instance. QuickJS's own interrupt raises an error that an async function or a
            // promise turns into an ordinary rejection, which a script can catch and carry on from.
            linker.Define("host", "interrupt", Function.FromCallback(store, (Caller _) =>
            {
                ThrowIfStopping();
                return 0;
            }));
            linker.Define("host", "result", Function.FromCallback(store, (Caller _, int ptr, int len) =>
            {
                if (len > _limits.MaxResultBytes)
                {
                    OversizedResultBytes = len;
                    return;
                }

                ResultJson = len == 0 ? null : ReadString(ptr, len);
            }));
            linker.Define("host", "error", Function.FromCallback(store,
                (Caller _, int namePtr, int nameLen, int messagePtr, int messageLen, int stackPtr, int stackLen) =>
                {
                    _error = (ReadString(namePtr, nameLen), ReadString(messagePtr, messageLen), ReadString(stackPtr, stackLen));
                }));
        }

        private void ThrowIfStopping()
        {
            if (InterruptRequested)
            {
                throw new ExecutionStoppedException();
            }
        }

        // Returns the call's id, or the code for a call refused before it started: 0 when the execution no longer
        // admits calls, -1 when too many are waiting. The bootstrap turns a code into a rejected promise.
        private int Post(int ptr, int len)
        {
            ThrowIfStopping();
            if (_mainSettled)
            {
                return 0;
            }

            if (_queue.Count >= _limits.MaxOutstandingCalls)
            {
                return -1;
            }

            var id = _nextId++;
            _queue.Enqueue((id, ReadString(ptr, len)));
            return id;
        }

        private void Log(int level, int ptr, int len)
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
            var message = ReadString(ptr, Math.Min(len, _limits.MaxLogEntryLength * 4));
            if (message.Length > _limits.MaxLogEntryLength)
            {
                message = message.Substring(0, _limits.MaxLogEntryLength) + $"... [{message.Length - _limits.MaxLogEntryLength} more characters]";
            }

            var logLevel = level is >= 0 and <= 3 ? (ScriptLogLevel)level : ScriptLogLevel.Log;
            _logs.Add(new ScriptLogEntry(logLevel, message));
        }

        private byte[] Dispatch(int id, string payload)
        {
            string method;
            JsonElement[] arguments;
            int[] omitted;
            try
            {
                using var document = JsonDocument.Parse(payload);
                var root = document.RootElement;
                method = root.GetProperty("method").GetString() ?? string.Empty;
                arguments = root.TryGetProperty("args", out var args) && args.ValueKind == JsonValueKind.Array
                    ? args.EnumerateArray().Select(a => a.Clone()).ToArray()
                    : Array.Empty<JsonElement>();
                omitted = root.TryGetProperty("omitted", out var gaps) && gaps.ValueKind == JsonValueKind.Array
                    ? gaps.EnumerateArray().Select(g => g.GetInt32()).ToArray()
                    : Array.Empty<int>();
            }
            catch (Exception ex) when (ex is JsonException or KeyNotFoundException or InvalidOperationException or FormatException)
            {
                return ErrorResponse(id, "UnknownMethodError", "The host call was malformed.");
            }

            if (!_owner._methods.TryGetValue(method, out var hostMethod))
            {
                var shown = method.Length > 128 ? method.Substring(0, 128) : method;
                return ErrorResponse(id, "UnknownMethodError", $"'{shown}' is not a host API method.");
            }

            var context = new HostCallContext(
                hostMethod.Api, hostMethod.Descriptor, arguments, omitted, _session, hostMethod.Api.JsonOptions ?? _owner._jsonOptions, _resolveInstance, _token);
            try
            {
                var result = Invoke(hostMethod, context).GetAwaiter().GetResult();
                return ResultResponse(id, hostMethod, result, context.JsonOptions);
            }
            catch (OperationCanceledException) when (InterruptRequested)
            {
                throw new ExecutionStoppedException();
            }
            catch (Exception ex)
            {
                return ExceptionResponse(id, hostMethod.Descriptor.HostMethodName, ex);
            }
        }

        private Task<HostCallResult> Invoke(HostMethod hostMethod, HostCallContext context)
        {
            var filters = _owner._filters.Count == 0 && _session.Filters.Count == 0
                ? Array.Empty<IHostCallFilter>()
                : _owner._filters.Concat(_session.Filters).ToArray();

            Task<HostCallResult> Next(int index) => index == filters.Length
                ? hostMethod.Handler(context)
                : filters[index].InvokeAsync(context, () => Next(index + 1));

            return Next(0);
        }

        // A method that declares no result sends none, so the script's promise resolves to undefined.
        private byte[] ResultResponse(int id, HostMethod hostMethod, HostCallResult result, JsonSerializerOptions options)
        {
            var declaresNoResult = AttributedSandboxApiRegistry.GetDeclaredResultType(hostMethod.Descriptor.Method.ReturnType) == typeof(void);
            if (declaresNoResult && result.Value is not null)
            {
                var message = $"{hostMethod.Descriptor.HostMethodName} returned a value but declares no result.";
                _hostErrors.Add(new HostCallError(hostMethod.Descriptor.HostMethodName, new InvalidOperationException(message)));
                return ErrorResponse(id, "HostError", message);
            }

            using var buffer = new MemoryStream();
            using (var writer = new Utf8JsonWriter(buffer))
            {
                writer.WriteStartObject();
                writer.WriteNumber("id", id);
                if (!declaresNoResult)
                {
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
                        JsonSerializer.Serialize(writer, result.Value, type, options);
                    }
                }
                writer.WriteEndObject();
            }

            return buffer.ToArray();
        }

        // Only a ScriptApiException's message reaches the script. Any other exception may carry internal detail,
        // so the script sees that the method failed and the exception goes to ScriptExecutionResult.HostErrors.
        private byte[] ExceptionResponse(int id, string method, Exception ex)
        {
            while (ex is AggregateException { InnerException: { } inner })
            {
                ex = inner;
            }

            if (ex is ScriptApiException api)
            {
                return ErrorResponse(id, api.ErrorName, api.Message);
            }

            _hostErrors.Add(new HostCallError(method, ex));
            return ErrorResponse(id, "HostError", $"{method} failed on the host.");
        }

        private static byte[] ErrorResponse(int id, string name, string message)
        {
            return JsonSerializer.SerializeToUtf8Bytes(new Dictionary<string, object>
            {
                ["id"] = id,
                ["error"] = new Dictionary<string, string> { ["name"] = name, ["message"] = message },
            });
        }

        private string ReadString(int ptr, int len)
        {
            if (len <= 0)
            {
                return string.Empty;
            }

#if NETSTANDARD2_0
            return Encoding.UTF8.GetString(_memory!.GetSpan(ptr, len).ToArray());
#else
            return Encoding.UTF8.GetString(_memory!.GetSpan(ptr, len));
#endif
        }
    }
}
