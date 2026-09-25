using System.Text.Json;
using System.Threading;

namespace ScriptBox;

/// <summary>
/// Interface for configuring ScriptBox instances without exposing the Build method.
/// </summary>
public interface IScriptBoxConfigurator
{
    IScriptBoxConfigurator WithWasmModuleFromPath(string path);
    IScriptBoxConfigurator WithWasmModule(ReadOnlyMemory<byte> moduleBytes);
    IScriptBoxConfigurator WithStartupFile(string path);
    IScriptBoxConfigurator WithStartupScript(Func<CancellationToken, Task<string>> loader);
    IScriptBoxConfigurator WithExecutionTimeout(TimeSpan timeout);
    IScriptBoxConfigurator WithMemoryLimit(long bytes);
    IScriptBoxConfigurator WithResultLimit(int maxBytes);
    IScriptBoxConfigurator SealHostResults(bool seal = true);
    IScriptBoxConfigurator WithJsonSerializerOptions(JsonSerializerOptions options);
    IScriptBoxConfigurator WithTypeScriptType(Type type, string typeScript);
    IScriptBoxConfigurator RegisterApisFrom<T>(string? name = null);
    IScriptBoxConfigurator RegisterApisFrom(Type type, string? name = null);
    IScriptBoxConfigurator AddFromType<T>(string? name = null);
    IScriptBoxConfigurator AddFromObject(object instance, string? name = null);
    IScriptBoxConfigurator WithApiFactory(Func<Type, object?> apiFactory);
    IScriptBoxConfigurator WithMetadata(string key, object value);
}
