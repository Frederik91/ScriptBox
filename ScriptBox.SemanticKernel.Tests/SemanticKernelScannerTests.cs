using System.ComponentModel;
using Microsoft.SemanticKernel;
using ScriptBox.Core.Runtime;

namespace ScriptBox.SemanticKernel.Tests;

public class SemanticKernelScannerTests
{
    [SandboxApi("sk_plugin")]
    public class MySkPlugin
    {
        [KernelFunction("add")]
        [Description("Adds two numbers")]
        public int Add(int a, int b) => a + b;
    }

    [Fact]
    public async Task CanRegisterPluginUsingScanner()
    {
        var builder = ScriptBoxBuilder.Create()
            .WithApiScanner(new SemanticKernelApiScanner())
            .RegisterApisFrom<MySkPlugin>();

        var box = builder.Build();
        var session = box.CreateSession();

        var result = await session.RunAsync("return sk_plugin.add(10, 20);");
        Assert.Equal("30", result);
    }

    [Fact]
    public async Task CanRegisterPluginWithoutExplicitScanner_UsingModuleInitializer()
    {
        // This test verifies that the SemanticKernelApiScanner is automatically registered
        // via the module initializer, so users don't need to call WithApiScanner
        var builder = ScriptBoxBuilder.Create()
            .RegisterApisFrom<MySkPlugin>(); // No explicit WithApiScanner call!

        var box = builder.Build();
        var session = box.CreateSession();

        var result = await session.RunAsync("return sk_plugin.add(15, 25);");
        Assert.Equal("40", result);
    }

    [Fact]
    public async Task RegisterApisFrom_StoresMetadata_ForTypeScriptGeneration()
    {
        // This test verifies that metadata is automatically stored when using RegisterApisFrom
        // so users can generate TypeScript declarations without needing RegisterSemanticKernelPlugin
        var builder = ScriptBoxBuilder.Create()
            .RegisterApisFrom<MySkPlugin>(); // Metadata should be automatically stored

        var box = builder.Build();

        // Retrieve metadata using extension method
        var metadata = box.GetSemanticKernelMetadata();

        Assert.Single(metadata);
        Assert.Equal("sk_plugin", metadata[0].Name);
        Assert.Single(metadata[0].Functions);
        Assert.Equal("add", metadata[0].Functions[0].Name);

        // Verify TypeScript generation works
        var typescript = box.GenerateTypeScriptDeclarations();
        Assert.Contains("interface SkPluginApi", typescript);
        Assert.Contains("add(a: number, b: number): Promise<number>;", typescript);
        Assert.Contains("declare const sk_plugin: ScriptBox.SkPluginApi;", typescript);
    }
}
