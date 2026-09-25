using System.ComponentModel;
using Microsoft.SemanticKernel;
using ScriptBox.Core.Runtime;
using Xunit;

namespace ScriptBox.SemanticKernel.Tests;

public class SemanticKernelScannerRefactorTests
{
    public class VanillaSkPlugin
    {
        [KernelFunction("multiply")]
        [Description("Multiplies two numbers")]
        public int Multiply(int a, int b) => a * b;
    }

    [Fact]
    public async Task CanRegisterVanillaPlugin_WithFallbackName()
    {
        var builder = ScriptBoxBuilder.Create()
            .WithApiScanner(new SemanticKernelApiScanner())
            .RegisterApisFrom<VanillaSkPlugin>(); // Should default to "vanilla_sk_plugin"

        var box = builder.Build();
        var session = box.CreateSession();

        var result = await session.RunAsync("return vanilla_sk_plugin.multiply(10, 20);");
        Assert.Equal("200", result);
    }

    [Fact]
    public async Task CanRegisterVanillaPlugin_WithExplicitName()
    {
        var builder = ScriptBoxBuilder.Create()
            .WithApiScanner(new SemanticKernelApiScanner())
            .RegisterApisFrom<VanillaSkPlugin>("my_math");

        var box = builder.Build();
        var session = box.CreateSession();

        var result = await session.RunAsync("return my_math.multiply(5, 5);");
        Assert.Equal("25", result);
    }
}
