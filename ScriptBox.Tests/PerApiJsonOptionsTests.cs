using System.Text.Json;
using global::ScriptBox;
using ScriptBox.Core.Runtime;

namespace ScriptBox.Tests;

public class PerApiJsonOptionsTests
{
    public sealed record Shape(string DisplayName);

    [SandboxApi("snake")]
    public sealed class SnakeApi
    {
        [SandboxMethod("echo")]
        public Shape Echo(Shape shape) => shape;
    }

    [SandboxApi("camel")]
    public sealed class CamelApi
    {
        [SandboxMethod("echo")]
        public Shape Echo(Shape shape) => shape;
    }

    private static readonly JsonSerializerOptions SnakeCase = new() { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower };

    private static IScriptBox Build() => ScriptBoxBuilder.Create()
        .RegisterApisFrom(typeof(SnakeApi), null, SnakeCase)
        .RegisterApisFrom<CamelApi>()
        .Build();

    [Fact]
    public async Task Each_api_binds_and_returns_with_its_own_serializer()
    {
        var result = await Build().CreateSession().ExecuteAsync("""
            return [await snake.echo({ display_name: 'a' }), await camel.echo({ displayName: 'b' })];
            """);

        Assert.Equal("""[{"display_name":"a"},{"displayName":"b"}]""", result.Json);
    }

    [Fact]
    public void Each_api_is_declared_with_its_own_serializer()
    {
        var declarations = Build().GetTypeScriptDeclarations();

        Assert.Contains("display_name: string;", declarations);
        Assert.Contains("displayName: string;", declarations);
    }
}
