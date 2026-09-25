using System;
using System.Threading.Tasks;
using Moq;
using ScriptBox.SemanticKernel;
using ScriptBox.Tests.TestApis.SemanticKernel;

namespace ScriptBox.Tests;

public class SemanticKernelIntegrationTests
{
    private static IScriptBoxToolProvider CreateEmptyToolProvider()
    {
        var mock = new Mock<IScriptBoxToolProvider>();
        mock.Setup(x => x.GetTools()).Returns(new List<ScriptBoxToolDescriptor>());
        return mock.Object;
    }

    [Fact]
    public async Task RegisterApisFrom_ExposesNamespace()
    {
        var builder = ScriptBoxBuilder.Create();
        builder.RegisterApisFrom<TestSemanticKernelPlugin>("math");
        var scriptBox = builder.Build();

        var session = scriptBox.CreateSession();
        var result = await session.RunAsync("return math.add(4, 6);");
        Assert.Equal(10, Convert.ToInt32(result));
    }

    [Fact]
    public void TypeScriptGenerator_ProducesDeclarations()
    {
        var builder = ScriptBoxBuilder.Create();
        builder.RegisterApisFrom<TestSemanticKernelPlugin>("math");
        var scriptBox = builder.Build();

        var typescript = scriptBox.GenerateTypeScriptDeclarations();

        Assert.Contains("interface MathApi", typescript);
        Assert.Contains("add(a: number, b: number): Promise<number>;", typescript);
        Assert.Contains("declare const math: ScriptBox.MathApi;", typescript);
    }

    [Fact]
    public async Task ScriptBoxPlugin_RunJavaScriptAsync_ReturnsSerializedResult()
    {
        var scriptBox = ScriptBoxBuilder.Create().Build();
        var toolProvider = CreateEmptyToolProvider();
        var plugin = new ScriptBoxPlugin(scriptBox, toolProvider);

        var result = await plugin.RunJavaScriptAsync("return ({ total: 21 + 21 })");
        
        using var doc = System.Text.Json.JsonDocument.Parse(result);
        var total = doc.RootElement.GetProperty("result").GetProperty("total").GetInt32();
        Assert.Equal(42, total);
    }

    [Fact]
    public async Task ScriptBoxPlugin_PassesInputPayload()
    {
        var scriptBox = ScriptBoxBuilder.Create().Build();
        var toolProvider = CreateEmptyToolProvider();
        var plugin = new ScriptBoxPlugin(scriptBox, toolProvider);

        var result = await plugin.RunJavaScriptAsync("return scriptBoxInput.user.value * 2", "{\"value\":5}");
        
        using var doc = System.Text.Json.JsonDocument.Parse(result);
        var value = doc.RootElement.GetProperty("result").GetInt32();
        Assert.Equal(10, value);
    }
}
