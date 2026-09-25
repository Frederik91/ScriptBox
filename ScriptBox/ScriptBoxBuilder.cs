using System.IO;
using System.Text.Json;
using System.Threading;
using ScriptBox.Core.Runtime;
using ScriptBox.Core.WasmExecution;

namespace ScriptBox;

/// <summary>
/// Thread-local context for passing builder metadata to scanner factories.
/// This allows extension packages to store metadata during API scanning.
/// </summary>
public static class BuilderMetadataContext
{
    [ThreadStatic]
    private static Dictionary<string, object>? _current;

    public static Dictionary<string, object>? Current
    {
        get => _current;
        set => _current = value;
    }
}

/// <summary>
/// Configures a <see cref="IScriptBox"/>. A script can reach nothing but the
/// APIs registered here: there is no file system, network or clock beyond
/// what those APIs provide.
/// </summary>
public sealed class ScriptBoxBuilder : IScriptBoxConfigurator
{
    public static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(30);
    public const long DefaultMemoryLimitBytes = 256L * 1024 * 1024;

    private static readonly List<Func<ISandboxApiScanner>> _defaultScannerFactories = new();
    private static readonly object _scannerLock = new();

    private readonly List<Func<CancellationToken, Task<string>>> _startupScriptLoaders = new();
    private readonly List<(Type Type, string? Namespace)> _registeredApiTypes = new();
    private readonly List<(object Instance, string? Namespace)> _registeredApiInstances = new();
    private readonly Dictionary<string, object> _metadata = new();
    private readonly List<ISandboxApiScanner> _apiScanners = new();
    private readonly Dictionary<Type, string> _typeScriptOverrides = new();
    private string? _wasmModulePath;
    private byte[]? _wasmModuleBytes;
    private TimeSpan _executionTimeout = DefaultTimeout;
    private long _memoryLimitBytes = DefaultMemoryLimitBytes;
    private int _maxLogEntries = 1000;
    private int _maxLogEntryLength = 8 * 1024;
    private int _maxResultBytes = 4 * 1024 * 1024;
    private bool _sealHostResults;
    private JsonSerializerOptions? _jsonOptions;
    private Func<Type, object?>? _apiFactory;

    private ScriptBoxBuilder()
    {
        _apiScanners.Add(new AttributedSandboxApiScanner());
    }

    public static ScriptBoxBuilder Create() => new();

    /// <summary>
    /// Registers a default scanner factory that will be automatically added to all new ScriptBoxBuilder instances.
    /// This is typically called by package module initializers (e.g., ScriptBox.SemanticKernel).
    /// </summary>
    public static void RegisterDefaultScanner(Func<ISandboxApiScanner> scannerFactory)
    {
        if (scannerFactory is null)
        {
            throw new ArgumentNullException(nameof(scannerFactory));
        }

        lock (_scannerLock)
        {
            _defaultScannerFactories.Add(scannerFactory);
        }
    }

    private void EnsureDefaultScannersLoaded()
    {
        lock (_scannerLock)
        {
            // -1 for the AttributedSandboxApiScanner every builder starts with.
            var alreadyLoaded = _apiScanners.Count - 1;
            if (_defaultScannerFactories.Count <= alreadyLoaded)
            {
                return;
            }

            var previousMetadata = BuilderMetadataContext.Current;
            BuilderMetadataContext.Current = _metadata;
            try
            {
                for (var i = alreadyLoaded; i < _defaultScannerFactories.Count; i++)
                {
                    _apiScanners.Add(_defaultScannerFactories[i]());
                }
            }
            finally
            {
                BuilderMetadataContext.Current = previousMetadata;
            }
        }
    }

    internal ScriptBoxBuilder WithApiScanner(ISandboxApiScanner scanner)
    {
        _apiScanners.Add(scanner ?? throw new ArgumentNullException(nameof(scanner)));
        return this;
    }

    public ScriptBoxBuilder WithWasmModuleFromPath(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            throw new ArgumentException("WASM path cannot be null or empty", nameof(path));
        }

        _wasmModulePath = path;
        _wasmModuleBytes = null;
        return this;
    }

    public ScriptBoxBuilder WithWasmModule(ReadOnlyMemory<byte> moduleBytes)
    {
        if (moduleBytes.IsEmpty)
        {
            throw new ArgumentException("WASM module bytes cannot be empty", nameof(moduleBytes));
        }

        _wasmModuleBytes = moduleBytes.ToArray();
        _wasmModulePath = null;
        return this;
    }

    public ScriptBoxBuilder WithStartupFile(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            throw new ArgumentException("Startup script path cannot be null or empty", nameof(path));
        }

        return WithStartupScript(_ => Task.FromResult(BootstrapScriptLoader.LoadScriptFile(path)));
    }

    /// <summary>
    /// Adds JavaScript evaluated before every script, after the registered APIs are defined.
    /// </summary>
    public ScriptBoxBuilder WithStartupScript(Func<CancellationToken, Task<string>> loader)
    {
        _startupScriptLoaders.Add(loader ?? throw new ArgumentNullException(nameof(loader)));
        return this;
    }

    /// <summary>
    /// Wall-clock limit for one execution, host calls included. Zero means no limit.
    /// </summary>
    public ScriptBoxBuilder WithExecutionTimeout(TimeSpan timeout)
    {
        if (timeout < TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(timeout), "Timeout must be non-negative");
        }

        _executionTimeout = timeout;
        return this;
    }

    /// <summary>
    /// Upper bound on the sandbox's linear memory, which holds the whole
    /// JavaScript heap. A script that exceeds it fails with <see cref="ScriptErrorKind.MemoryLimit"/>.
    /// </summary>
    public ScriptBoxBuilder WithMemoryLimit(long bytes)
    {
        if (bytes < 16 * 1024 * 1024)
        {
            throw new ArgumentOutOfRangeException(nameof(bytes), "The QuickJS runtime needs at least 16 MB.");
        }

        _memoryLimitBytes = bytes;
        return this;
    }

    public ScriptBoxBuilder WithLogLimits(int maxEntries, int maxEntryLength)
    {
        _maxLogEntries = maxEntries > 0 ? maxEntries : throw new ArgumentOutOfRangeException(nameof(maxEntries));
        _maxLogEntryLength = maxEntryLength > 0 ? maxEntryLength : throw new ArgumentOutOfRangeException(nameof(maxEntryLength));
        return this;
    }

    /// <summary>
    /// The largest return value, as UTF-8 JSON, a script may produce. A larger one fails the run with a
    /// message asking for less, rather than handing the caller a payload it did not plan for.
    /// </summary>
    public ScriptBoxBuilder WithResultLimit(int maxBytes)
    {
        _maxResultBytes = maxBytes > 0 ? maxBytes : throw new ArgumentOutOfRangeException(nameof(maxBytes));
        return this;
    }

    /// <summary>
    /// Seals every object a host call returns, recursively. Assigning a
    /// property the object does not already have then throws a TypeError at
    /// that line instead of silently adding it, which turns a misspelt member
    /// name into an error the script's author sees. Arrays stay growable.
    /// </summary>
    public ScriptBoxBuilder SealHostResults(bool seal = true)
    {
        _sealHostResults = seal;
        return this;
    }

    /// <summary>
    /// The serializer for host call arguments and results, which also decides
    /// the property names in the generated TypeScript declarations. Defaults to
    /// <see cref="ScriptBoxJson.CreateDefaultOptions"/>.
    /// </summary>
    public ScriptBoxBuilder WithJsonSerializerOptions(JsonSerializerOptions options)
    {
        _jsonOptions = options ?? throw new ArgumentNullException(nameof(options));
        return this;
    }

    /// <summary>
    /// Declares a type as <paramref name="typeScript"/> in the generated
    /// declarations, for types whose JSON shape comes from a custom converter.
    /// </summary>
    public ScriptBoxBuilder WithTypeScriptType(Type type, string typeScript)
    {
        _typeScriptOverrides[type ?? throw new ArgumentNullException(nameof(type))] =
            string.IsNullOrWhiteSpace(typeScript) ? throw new ArgumentException("A TypeScript type is required.", nameof(typeScript)) : typeScript;
        return this;
    }

    public ScriptBoxBuilder RegisterApisFrom<T>(string? name = null) => RegisterApisFrom(typeof(T), name);

    public ScriptBoxBuilder RegisterApisFrom(Type type, string? name = null)
    {
        _registeredApiTypes.Add((type ?? throw new ArgumentNullException(nameof(type)), name));
        return this;
    }

    public ScriptBoxBuilder AddFromType<T>(string? name = null) => RegisterApisFrom(typeof(T), name);

    public ScriptBoxBuilder AddFromObject(object instance, string? name = null)
    {
        _registeredApiInstances.Add((instance ?? throw new ArgumentNullException(nameof(instance)), name));
        return this;
    }

    public ScriptBoxBuilder WithApiFactory(Func<Type, object?> apiFactory)
    {
        _apiFactory = apiFactory ?? throw new ArgumentNullException(nameof(apiFactory));
        return this;
    }

    public ScriptBoxBuilder WithMetadata(string key, object value)
    {
        if (string.IsNullOrWhiteSpace(key))
        {
            throw new ArgumentException("Key cannot be null or empty", nameof(key));
        }

        _metadata[key] = value;
        return this;
    }

    public T? GetMetadata<T>(string key)
    {
        return _metadata.TryGetValue(key, out var value) && value is T typedValue ? typedValue : default;
    }

    public IScriptBox Build()
    {
        EnsureDefaultScannersLoaded();

        var apis = new List<SandboxApiDescriptor>();
        var fixedInstances = new Dictionary<string, object>(StringComparer.Ordinal);
        foreach (var (type, ns) in _registeredApiTypes.Distinct())
        {
            apis.Add(Describe(type, ns));
        }

        foreach (var (instance, ns) in _registeredApiInstances)
        {
            var descriptor = Describe(instance.GetType(), ns);
            apis.Add(descriptor);
            fixedInstances[descriptor.JsNamespace] = instance;
        }

        foreach (var api in apis)
        {
            RequireIdentifier(api.JsNamespace, api.ApiType);
            foreach (var method in api.Methods)
            {
                RequireIdentifier(method.JsMethodName, api.ApiType);
            }
        }

        var duplicate = apis.GroupBy(a => a.JsNamespace).FirstOrDefault(g => g.Count() > 1);
        if (duplicate is not null)
        {
            throw new InvalidOperationException($"More than one API is registered as '{duplicate.Key}'.");
        }

        var handlers = new HostApiBuilder();
        AttributedSandboxApiRegistry.RegisterHandlers(apis, handlers);

        var jsonOptions = _jsonOptions ?? ScriptBoxJson.CreateDefaultOptions();
        var executor = new WasmScriptExecutor(ResolveModule(), handlers.Build(), jsonOptions);
        var limits = new ExecutionLimits
        {
            Timeout = _executionTimeout,
            MemoryBytes = _memoryLimitBytes,
            MaxLogEntries = _maxLogEntries,
            MaxLogEntryLength = _maxLogEntryLength,
            MaxResultBytes = _maxResultBytes,
        };

        return new ScriptBox(
            executor,
            BuildBootstrap(apis),
            apis,
            fixedInstances,
            _apiFactory,
            limits,
            jsonOptions,
            new Dictionary<Type, string>(_typeScriptOverrides),
            _metadata);
    }

    private static readonly HashSet<string> ReservedNames = new(StringComparer.Ordinal) { "console", "globalThis", "__scriptbox", "__host" };

    private static void RequireIdentifier(string name, Type apiType)
    {
        var valid = name.Length > 0
            && (char.IsLetter(name[0]) || name[0] == '_' || name[0] == '$')
            && name.All(c => char.IsLetterOrDigit(c) || c == '_' || c == '$')
            && !ReservedNames.Contains(name);
        if (!valid)
        {
            throw new InvalidOperationException($"'{name}' on {apiType.Name} is not usable as a JavaScript name.");
        }
    }

    private SandboxApiDescriptor Describe(Type type, string? ns)
    {
        foreach (var scanner in _apiScanners)
        {
            if (scanner.TryCreateDescriptor(type, ns, out var descriptor))
            {
                return descriptor;
            }
        }

        throw new InvalidOperationException(
            $"Type '{type.FullName}' could not be processed by any registered API scanner. Ensure it has the correct attributes (e.g. [SandboxApi]).");
    }

    private List<BootstrapScript> BuildBootstrap(IReadOnlyList<SandboxApiDescriptor> apis)
    {
        var options = JsonSerializer.Serialize(new Dictionary<string, object> { ["sealResults"] = _sealHostResults });
        var scripts = new List<BootstrapScript>
        {
            new("scriptbox.js", $"globalThis.__scriptbox_options = {options};\n{DefaultRuntimeResources.LoadCoreBootstrap()}"),
        };

        var apiBootstrap = AttributedSandboxApiRegistry.BuildBootstrap(apis);
        if (!string.IsNullOrWhiteSpace(apiBootstrap))
        {
            scripts.Add(new BootstrapScript("apis.js", apiBootstrap));
        }

        for (var i = 0; i < _startupScriptLoaders.Count; i++)
        {
            var code = _startupScriptLoaders[i](CancellationToken.None).GetAwaiter().GetResult();
            if (!string.IsNullOrWhiteSpace(code))
            {
                scripts.Add(new BootstrapScript($"startup-{i + 1}.js", code));
            }
        }

        return scripts;
    }

    private Wasmtime.Module ResolveModule()
    {
        var bytes = _wasmModuleBytes
            ?? (_wasmModulePath is not null ? File.ReadAllBytes(_wasmModulePath) : null)
            ?? DefaultRuntimeResources.LoadEmbeddedWasm().ToArray();
        return WasmRuntime.GetModule(bytes);
    }

    #region IScriptBoxConfigurator Explicit Implementation

    IScriptBoxConfigurator IScriptBoxConfigurator.WithWasmModuleFromPath(string path) => WithWasmModuleFromPath(path);
    IScriptBoxConfigurator IScriptBoxConfigurator.WithWasmModule(ReadOnlyMemory<byte> moduleBytes) => WithWasmModule(moduleBytes);
    IScriptBoxConfigurator IScriptBoxConfigurator.WithStartupFile(string path) => WithStartupFile(path);
    IScriptBoxConfigurator IScriptBoxConfigurator.WithStartupScript(Func<CancellationToken, Task<string>> loader) => WithStartupScript(loader);
    IScriptBoxConfigurator IScriptBoxConfigurator.WithExecutionTimeout(TimeSpan timeout) => WithExecutionTimeout(timeout);
    IScriptBoxConfigurator IScriptBoxConfigurator.WithMemoryLimit(long bytes) => WithMemoryLimit(bytes);
    IScriptBoxConfigurator IScriptBoxConfigurator.WithResultLimit(int maxBytes) => WithResultLimit(maxBytes);
    IScriptBoxConfigurator IScriptBoxConfigurator.SealHostResults(bool seal) => SealHostResults(seal);
    IScriptBoxConfigurator IScriptBoxConfigurator.WithJsonSerializerOptions(JsonSerializerOptions options) => WithJsonSerializerOptions(options);
    IScriptBoxConfigurator IScriptBoxConfigurator.WithTypeScriptType(Type type, string typeScript) => WithTypeScriptType(type, typeScript);
    IScriptBoxConfigurator IScriptBoxConfigurator.RegisterApisFrom<T>(string? name) => RegisterApisFrom<T>(name);
    IScriptBoxConfigurator IScriptBoxConfigurator.RegisterApisFrom(Type type, string? name) => RegisterApisFrom(type, name);
    IScriptBoxConfigurator IScriptBoxConfigurator.AddFromType<T>(string? name) => AddFromType<T>(name);
    IScriptBoxConfigurator IScriptBoxConfigurator.AddFromObject(object instance, string? name) => AddFromObject(instance, name);
    IScriptBoxConfigurator IScriptBoxConfigurator.WithApiFactory(Func<Type, object?> apiFactory) => WithApiFactory(apiFactory);
    IScriptBoxConfigurator IScriptBoxConfigurator.WithMetadata(string key, object value) => WithMetadata(key, value);

    #endregion
}
