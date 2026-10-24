using System.ComponentModel;
using System.Text.Json;
using System.Text.Json.Nodes;
using global::ScriptBox;
using ScriptBox.Core.Runtime;

namespace ScriptBox.Tests;

/// <summary>
/// Runs conformance/fixtures.json, which the Node host runs too
/// (ScriptBox.Node/test/conformance.test.ts). A case states what both hosts
/// do; there are no per-host expectations.
/// </summary>
public class ConformanceTests
{
    [SandboxApi("conf")]
    [Description("Methods for conformance tests.")]
    public sealed class ConfApi
    {
        public List<string> Calls { get; } = new();

        [SandboxMethod("echo")]
        [Description("Returns its argument.")]
        public JsonElement Echo(JsonElement value) => value;

        [SandboxMethod("add")]
        [Description("Adds two numbers.")]
        public double Add(double a, double b) => a + b;

        [SandboxMethod("greet")]
        [Description("Greets someone.")]
        public string Greet(string name, string greeting = "Hello") => $"{greeting}, {name}";

        [SandboxMethod("fail")]
        [Description("Throws an API error.")]
        public void Fail(string message) => throw new ScriptApiException(message, "ConfError");

        [SandboxMethod("record")]
        [Description("Records a tag.")]
        public void Record(string tag) => Calls.Add($"conf.record:{tag}");

        [SandboxMethod("item")]
        [Description("Gets an item.")]
        public Item GetItem(string id)
        {
            Calls.Add($"conf.item:{id}");
            return new Item(id, $"Item {id}");
        }

        [SandboxMethod("rename")]
        [Description("Renames an item.")]
        public Item Rename(Item change) => change;

        [SandboxMethod("crash")]
        [Description("Fails on the host with an internal error.")]
        public void Crash() => throw new InvalidOperationException("database password is hunter2");
    }

    public sealed record Item(string Id, string Name);

    private sealed class RecordingFilter(List<string> log, string name) : IHostCallFilter
    {
        public async Task<HostCallResult> InvokeAsync(HostCallContext context, HostCallNext next)
        {
            log.Add($"{name}>{context.Method}");
            var result = await next();
            log.Add($"{name}<{context.Method}");
            return result;
        }
    }

    private sealed class ReplaceFilter(string method, JsonNode? value) : IHostCallFilter
    {
        public Task<HostCallResult> InvokeAsync(HostCallContext context, HostCallNext next) =>
            context.Method == method ? Task.FromResult(HostCallResult.From(value)) : next();
    }

    private sealed class RefuseFilter(string method, string errorName, string message) : IHostCallFilter
    {
        public Task<HostCallResult> InvokeAsync(HostCallContext context, HostCallNext next) =>
            context.Method == method ? throw new ScriptApiException(message, errorName) : next();
    }

    public static TheoryData<string> CaseNames()
    {
        var data = new TheoryData<string>();
        foreach (var fixture in LoadCases())
        {
            data.Add(fixture["name"]!.GetValue<string>());
        }

        return data;
    }

    [Theory]
    [MemberData(nameof(CaseNames))]
    public async Task Fixture(string name)
    {
        var fixture = LoadCases().Single(c => c["name"]!.GetValue<string>() == name);
        var api = new ConfApi();
        var filterLog = new List<string>();
        var builder = ScriptBoxBuilder.Create().AddFromObject(api).WithDocs();

        if (fixture["filters"] is JsonObject filters)
        {
            foreach (var filter in filters["global"]!.AsArray())
            {
                builder.UseHostCallFilter(new RecordingFilter(filterLog, filter!.GetValue<string>()));
            }
        }

        if (fixture["replace"] is JsonObject replace)
        {
            builder.UseHostCallFilter(new ReplaceFilter(replace["method"]!.GetValue<string>(), replace["value"]?.DeepClone()));
        }

        if (fixture["refuse"] is JsonObject refuse)
        {
            builder.UseHostCallFilter(new RefuseFilter(
                refuse["method"]!.GetValue<string>(),
                refuse["errorName"]!.GetValue<string>(),
                refuse["message"]!.GetValue<string>()));
        }

        if (fixture["sealResults"]?.GetValue<bool>() == true)
        {
            builder.SealHostResults();
        }

        var box = builder.Build();
        var session = box.CreateSession(options =>
        {
            if (fixture["filters"] is JsonObject sessionFilters)
            {
                foreach (var filter in sessionFilters["session"]!.AsArray())
                {
                    options.UseHostCallFilter(new RecordingFilter(filterLog, filter!.GetValue<string>()));
                }
            }
        });

        if (fixture["before"] is JsonValue before)
        {
            var first = await session.ExecuteAsync(before.GetValue<string>());
            Assert.True(first.Succeeded, first.Error?.Message);
        }

        var result = await session.ExecuteAsync(fixture["script"]!.GetValue<string>());
        var expected = fixture["expect"]!.AsObject();
        var actual = Normalize(result);
        foreach (var (key, value) in expected)
        {
            Assert.True(
                JsonNode.DeepEquals(value, actual[key]),
                $"{key}: expected {value?.ToJsonString() ?? "null"}, got {actual[key]?.ToJsonString() ?? "null"} ({result.Error})");
        }

        if (fixture["calls"] is JsonArray calls)
        {
            Assert.Equal(calls.Select(c => c!.GetValue<string>()), api.Calls);
        }

        if (fixture["filterLog"] is JsonArray log)
        {
            Assert.Equal(log.Select(c => c!.GetValue<string>()), filterLog);
        }
    }

    /// <summary>The .NET result in the shared vocabulary: status, value, failure code, error name and line.</summary>
    private static JsonObject Normalize(ScriptExecutionResult result)
    {
        if (result.Succeeded)
        {
            return new JsonObject { ["status"] = "completed", ["value"] = result.Json is null ? null : JsonNode.Parse(result.Json) };
        }

        var error = result.Error!;
        var normalized = error.Kind switch
        {
            ScriptErrorKind.Timeout => new JsonObject { ["status"] = "timed-out" },
            ScriptErrorKind.MemoryLimit => new JsonObject { ["status"] = "resource-limit" },
            _ => new JsonObject { ["status"] = "failed", ["code"] = error.Code },
        };
        normalized["errorName"] = error.Name;
        if (error.Line is int line)
        {
            normalized["line"] = line;
        }

        return normalized;
    }

    private static IReadOnlyList<JsonObject> LoadCases()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "conformance", "fixtures.json")))
        {
            directory = directory.Parent;
        }

        Assert.NotNull(directory);
        var root = JsonNode.Parse(File.ReadAllText(Path.Combine(directory.FullName, "conformance", "fixtures.json")))!;
        return root["cases"]!.AsArray().Select(c => c!.AsObject()).ToList();
    }
}
