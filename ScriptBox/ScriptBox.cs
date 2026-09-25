using System.Collections.Concurrent;
using System.Text.Json;
using System.Threading;
using ScriptBox.Core.Runtime;
using ScriptBox.Core.TypeScript;
using ScriptBox.Core.WasmExecution;

namespace ScriptBox;

public sealed class ScriptBox : IScriptBox
{
    private readonly WasmScriptExecutor _executor;
    private readonly IReadOnlyList<BootstrapScript> _bootstrap;
    private readonly ExecutionLimits _limits;
    private readonly IReadOnlyDictionary<string, object> _fixedInstances;
    private readonly ConcurrentDictionary<string, Lazy<object>> _createdInstances = new(StringComparer.Ordinal);
    private readonly Func<Type, object?>? _apiFactory;
    private readonly JsonSerializerOptions _jsonOptions;
    private readonly Lazy<string> _declarations;

    internal ScriptBox(
        WasmScriptExecutor executor,
        IReadOnlyList<BootstrapScript> bootstrap,
        IReadOnlyList<SandboxApiDescriptor> apis,
        IReadOnlyDictionary<string, object> fixedInstances,
        Func<Type, object?>? apiFactory,
        ExecutionLimits limits,
        JsonSerializerOptions jsonOptions,
        IReadOnlyDictionary<Type, string> typeOverrides,
        IReadOnlyDictionary<string, object> metadata)
    {
        _executor = executor;
        _bootstrap = bootstrap;
        Apis = apis;
        _fixedInstances = fixedInstances;
        _apiFactory = apiFactory;
        _limits = limits;
        _jsonOptions = jsonOptions;
        Metadata = metadata;
        _declarations = new Lazy<string>(
            () => new TypeScriptDeclarationGenerator(jsonOptions, typeOverrides).Generate(apis),
            LazyThreadSafetyMode.ExecutionAndPublication);
    }

    public IReadOnlyList<SandboxApiDescriptor> Apis { get; }

    public IReadOnlyDictionary<string, object> Metadata { get; }

    internal TimeSpan DefaultTimeout => _limits.Timeout;

    public ScriptSession CreateSession(Action<ScriptSessionOptions>? configure = null)
    {
        var options = new ScriptSessionOptions();
        configure?.Invoke(options);
        return new ScriptSession(this, options);
    }

    public string GetTypeScriptDeclarations() => _declarations.Value;

    internal ScriptExecutionResult Execute(ScriptSession session, string script, CancellationToken cancellationToken)
    {
        var limits = session.Timeout == _limits.Timeout
            ? _limits
            : new ExecutionLimits
            {
                Timeout = session.Timeout,
                MemoryBytes = _limits.MemoryBytes,
                MaxLogEntries = _limits.MaxLogEntries,
                MaxLogEntryLength = _limits.MaxLogEntryLength,
                MaxResultBytes = _limits.MaxResultBytes,
            };

        return _executor.Execute(
            _bootstrap,
            script,
            session,
            api => ResolveInstance(session, api),
            limits,
            cancellationToken);
    }

    internal IReadOnlyDictionary<string, object> ResolveSessionApis(IEnumerable<(object Instance, string? Namespace)> requested)
    {
        var resolved = new Dictionary<string, object>(StringComparer.Ordinal);
        foreach (var (instance, jsNamespace) in requested)
        {
            var candidates = Apis
                .Where(api => api.RequiresInstance && api.ApiType.IsInstanceOfType(instance))
                .Where(api => jsNamespace is null || api.JsNamespace == jsNamespace)
                .ToList();

            if (candidates.Count != 1)
            {
                var what = jsNamespace is null ? $"type {instance.GetType().Name}" : $"'{jsNamespace}'";
                throw new InvalidOperationException(candidates.Count == 0
                    ? $"No registered API matches {what}. Register the API type on the builder before serving it per session."
                    : $"{what} matches several registered APIs ({string.Join(", ", candidates.Select(c => c.JsNamespace))}); name the namespace.");
            }

            resolved[candidates[0].JsNamespace] = instance;
        }

        return resolved;
    }

    private object ResolveInstance(ScriptSession session, SandboxApiDescriptor api)
    {
        if (session.ApiOverrides.TryGetValue(api.JsNamespace, out var sessionInstance))
        {
            return sessionInstance;
        }

        if (_fixedInstances.TryGetValue(api.JsNamespace, out var fixedInstance))
        {
            return fixedInstance;
        }

        return _createdInstances
            .GetOrAdd(api.JsNamespace, _ => new Lazy<object>(() => CreateInstance(api.ApiType), LazyThreadSafetyMode.ExecutionAndPublication))
            .Value;
    }

    private object CreateInstance(Type apiType)
    {
        return _apiFactory?.Invoke(apiType)
            ?? Activator.CreateInstance(apiType)
            ?? throw new InvalidOperationException($"Unable to create an instance of '{apiType.FullName}'. Provide one with WithApiFactory or UseApi.");
    }
}
