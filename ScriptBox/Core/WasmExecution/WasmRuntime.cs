using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Threading;
using Wasmtime;

namespace ScriptBox.Core.WasmExecution;

/// <summary>
/// The process-wide Wasmtime engine and its compiled modules. Compiling the
/// QuickJS module takes far longer than running a typical script, so each
/// distinct module is compiled once and shared by every box that uses it.
/// </summary>
/// <remarks>
/// The engine runs with epoch interruption on, and a timer advances the epoch
/// every <see cref="EpochTick"/>. That is the hard stop behind the timeout:
/// QuickJS's own interrupt handler stops a script cleanly, but it is only
/// polled between bytecodes, so a script stuck inside one long native
/// operation is ended by the epoch deadline instead.
/// </remarks>
internal static class WasmRuntime
{
    public static readonly TimeSpan EpochTick = TimeSpan.FromMilliseconds(50);

    /// <summary>
    /// WASM runs on the calling thread's native stack, which QuickJS's own
    /// recursion check cannot see: it measures the shadow stack in linear
    /// memory. Executions therefore run on a thread with
    /// <see cref="ExecutionThreadStackSize"/>, and Wasmtime may use this much
    /// of it, enough that QuickJS's limit is reached first.
    /// </summary>
    public const int MaxWasmStackSize = 8 * 1024 * 1024;

    public const int ExecutionThreadStackSize = 16 * 1024 * 1024;

    private static readonly Lazy<Engine> SharedEngine = new(CreateEngine, LazyThreadSafetyMode.ExecutionAndPublication);
    private static readonly ConcurrentDictionary<string, Lazy<Module>> Modules = new(StringComparer.Ordinal);
    private static Timer? _epochTimer;

    public static Engine Engine => SharedEngine.Value;

    public static Module GetModule(byte[] moduleBytes)
    {
        string key;
        using (var sha = SHA256.Create())
        {
            key = Convert.ToBase64String(sha.ComputeHash(moduleBytes));
        }

        return Modules.GetOrAdd(
            key,
            _ => new Lazy<Module>(() => Module.FromBytes(Engine, "scriptbox", moduleBytes), LazyThreadSafetyMode.ExecutionAndPublication))
            .Value;
    }

    public static ulong TicksFor(TimeSpan duration)
    {
        return (ulong)Math.Ceiling(duration.TotalMilliseconds / EpochTick.TotalMilliseconds);
    }

    private static Engine CreateEngine()
    {
        // The engine takes ownership of the config.
        var config = new Config()
            .WithEpochInterruption(true)
            .WithMaximumStackSize(MaxWasmStackSize);
        var engine = new Engine(config);
        _epochTimer = new Timer(_ => engine.IncrementEpoch(), null, EpochTick, EpochTick);
        return engine;
    }
}
