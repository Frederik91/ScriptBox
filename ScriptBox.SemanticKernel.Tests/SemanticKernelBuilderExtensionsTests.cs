using System;
using System.Linq;
using System.Threading.Tasks;
using ScriptBox.SemanticKernel.Tests.TestPlugins;

namespace ScriptBox.SemanticKernel.Tests;

public class SemanticKernelBuilderExtensionsTests
{
    [Fact]
    public async Task RegisterApisFrom_ExposesNamespaceAndMetadata()
    {
        var builder = ScriptBoxBuilder.Create();
        builder.RegisterApisFrom<SampleMathPlugin>("math_test");

        var scriptBox = builder.Build();

        var metadata = scriptBox.GetSemanticKernelMetadata().Single();
        Assert.Equal("math_test", metadata.Name);
        Assert.Equal(2, metadata.Functions.Count);
        Assert.Contains(metadata.Functions, f => f.Name == "add" && f.Parameters.Count == 2);

        var session = scriptBox.CreateSession();
        var result = await session.RunAsync("return math_test.add(3, 4);");
        Assert.Equal(7, Convert.ToInt32(result));
    }

    [Fact]
    public void TypeScriptGenerator_RendersNamespaces()
    {
        var builder = ScriptBoxBuilder.Create();
        builder.RegisterApisFrom<SampleMathPlugin>("math_test");

        var scriptBox = builder.Build();
        var declaration = scriptBox.GenerateTypeScriptDeclarations();

        Assert.Contains("interface MathTestApi", declaration);
        Assert.Contains("add(left: number, right: number): Promise<number>;", declaration);
        Assert.Contains("format_sum(left: number, right: number, prefix?: string): Promise<string>;", declaration);
        Assert.Contains("declare const math_test: ScriptBox.MathTestApi;", declaration);
    }

    [Fact]
    public void RegisterApisFrom_PreservesDescriptions()
    {
        var builder = ScriptBoxBuilder.Create();
        builder.RegisterApisFrom<SampleMathPlugin>("math_test");

        var scriptBox = builder.Build();
        var metadata = scriptBox.GetSemanticKernelMetadata().Single();
        var add = metadata.Functions.Single(f => f.Name == "add");

        Assert.Equal("Adds two integers.", add.Description);
        Assert.Equal("number", add.Parameters.First().Type);
    }
}
