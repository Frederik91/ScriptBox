using global::ScriptBox;

namespace ScriptBox.Tests;

/// <summary>
/// The two guest artifacts are built from one source: scriptbox.wasm (ABI 1)
/// for this host and scriptbox-async.wasm (ABI 2) for the Node host. Each
/// host refuses the other's before any script runs.
/// </summary>
public class GuestAbiTests
{
    [Fact]
    public void The_async_guest_built_for_Node_is_refused()
    {
        var path = Path.Combine(RepositoryRoot(), "ScriptBox.Wasm", "scriptbox-async.wasm");

        var error = Assert.Throws<InvalidOperationException>(() => ScriptBoxBuilder.Create().WithWasmModuleFromPath(path).Build());

        Assert.Contains("ABI 2", error.Message);
    }

    [Fact]
    public async Task The_default_guest_speaks_ABI_1()
    {
        var result = await ScriptBoxBuilder.Create().Build().CreateSession().ExecuteAsync("return 1 + 1;");

        Assert.True(result.Succeeded, result.Error?.Message);
        Assert.Equal("2", result.Json);
    }

    private static string RepositoryRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "ScriptBox.sln")))
        {
            directory = directory.Parent;
        }

        Assert.NotNull(directory);
        return directory.FullName;
    }
}
