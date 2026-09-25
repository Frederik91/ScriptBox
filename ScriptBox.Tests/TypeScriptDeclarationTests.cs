using System.ComponentModel;
using System.Text.Json.Serialization;
using global::ScriptBox;
using ScriptBox.Core.Runtime;

namespace ScriptBox.Tests;

public class TypeScriptDeclarationTests
{
    [SandboxApi("shapes")]
    [Description("Reads and edits shapes.")]
    public sealed class ShapeApi
    {
        [SandboxMethod("get")]
        [Description("Returns one shape.")]
        public Shape Get([Description("The shape's id.")] string id) => new Circle(id, 1);

        [SandboxMethod("find")]
        public Task<IReadOnlyList<Shape>> FindAsync(string? name = null, int limit = 10) =>
            Task.FromResult<IReadOnlyList<Shape>>(Array.Empty<Shape>());

        [SandboxMethod("tryGet")]
        public Shape? TryGet(string id) => null;

        [SandboxMethod("colors")]
        public Dictionary<string, Color> Colors() => new();

        [SandboxMethod("remove")]
        public void Remove(string id, CancellationToken cancellationToken)
        {
        }
    }

    [JsonPolymorphic(TypeDiscriminatorPropertyName = "kind")]
    [JsonDerivedType(typeof(Circle), "circle")]
    [JsonDerivedType(typeof(Square), "square")]
    [Description("A shape on the canvas.")]
    public abstract record Shape(string Id);

    public sealed record Circle(string Id, double Radius) : Shape(Id);

    public sealed record Square(string Id, double Side) : Shape(Id)
    {
        [Description("Where the square is anchored.")]
        public Anchor? Anchor { get; init; }

        [JsonIgnore]
        public string Secret { get; init; } = "";

        [JsonPropertyName("label-text")]
        public string? Label { get; init; }
    }

    public sealed class Anchor
    {
        public int X { get; set; }

        public int Y { get; }
    }

    public enum Color
    {
        [Description("The default.")]
        Red,
        Green,
    }

    private static string Generate() =>
        ScriptBoxBuilder.Create().RegisterApisFrom<ShapeApi>().Build().GetTypeScriptDeclarations();

    [Fact]
    public void Declares_the_api_with_descriptions_and_parameter_docs()
    {
        var ts = Generate();

        Assert.Contains("/** Reads and edits shapes. */\ndeclare const shapes: {", ts);
        Assert.Contains("   * Returns one shape.\n   * @param id The shape's id.\n", ts);
        Assert.Contains("  get(id: string): Shape;", ts);
    }

    [Fact]
    public void Optional_nullable_and_injected_parameters_are_declared_as_the_script_sees_them()
    {
        var ts = Generate();

        Assert.Contains("  find(name?: string | null, limit?: number): Shape[];", ts);
        Assert.Contains("  tryGet(id: string): Shape | null;", ts);
        Assert.Contains("  remove(id: string): void;", ts);
    }

    [Fact]
    public void A_polymorphic_hierarchy_becomes_a_discriminated_union()
    {
        var ts = Generate();

        Assert.Contains("type Shape = Circle | Square;", ts);
        Assert.Contains("interface Circle {\n  kind: \"circle\";\n  radius: number;\n  id: string;\n}", ts);
        Assert.Contains("interface Square {\n  kind: \"square\";", ts);
    }

    [Fact]
    public void Properties_follow_the_serializer_contract()
    {
        var ts = Generate();

        Assert.Contains("  /** Where the square is anchored. */\n  anchor: Anchor | null;", ts);
        Assert.Contains("  \"label-text\": string | null;", ts);
        Assert.DoesNotContain("secret", ts, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("interface Anchor {\n  x: number;\n  readonly y: number;\n}", ts);
    }

    [Fact]
    public void Enums_are_string_unions_with_member_descriptions()
    {
        var ts = Generate();

        Assert.Contains("colors(): Record<string, Color>;", ts);
        Assert.Contains("/** Red: The default. */\ntype Color = \"Red\" | \"Green\";", ts);
    }

    [Fact]
    public async Task The_declared_discriminator_is_what_the_script_receives()
    {
        var box = ScriptBoxBuilder.Create().RegisterApisFrom<ShapeApi>().Build();

        var json = await box.CreateSession().RunAsync("return shapes.get('c1');");

        Assert.Equal("{\"kind\":\"circle\",\"radius\":1,\"id\":\"c1\"}", json);
    }
}
