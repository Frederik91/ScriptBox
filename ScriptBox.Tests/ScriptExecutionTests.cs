using System.Diagnostics;
using global::ScriptBox;
using ScriptBox.Core.Runtime;

namespace ScriptBox.Tests;

public class ScriptExecutionTests
{
    [SandboxApi("store")]
    public sealed class StoreApi
    {
        private readonly Dictionary<string, Item> _items = new();

        public List<string> Calls { get; } = new();

        [SandboxMethod("put")]
        public Item Put(Item item)
        {
            Calls.Add("put:" + item.Id);
            _items[item.Id] = item;
            return item;
        }

        [SandboxMethod("get")]
        public Item Get(string id)
        {
            Calls.Add("get:" + id);
            return _items.TryGetValue(id, out var item)
                ? item
                : throw new ScriptApiException($"No item has the id '{id}'.", "NotFoundError");
        }

        [SandboxMethod("echo")]
        public string Echo(string text)
        {
            Calls.Add("echo");
            return text;
        }

        [SandboxMethod("repeat")]
        public string Repeat(string text, int count = 2) => string.Concat(Enumerable.Repeat(text, count));

        [SandboxMethod("fail")]
        public void Fail() => throw new InvalidOperationException("the host broke");

        [SandboxMethod("slow")]
        public async Task<int> SlowAsync(int milliseconds, CancellationToken cancellationToken)
        {
            await Task.Delay(milliseconds, cancellationToken);
            return milliseconds;
        }
    }

    public sealed record Item(string Id, string Name, List<string> Tags, Nested Nested);

    public sealed record Nested(bool Enabled, int Count);

    private static IScriptBox Build(Action<ScriptBoxBuilder>? configure = null)
    {
        var builder = ScriptBoxBuilder.Create().RegisterApisFrom<StoreApi>();
        configure?.Invoke(builder);
        return builder.Build();
    }

    private static Task<ScriptExecutionResult> Execute(string script, Action<ScriptBoxBuilder>? configure = null)
    {
        return Build(configure).CreateSession().ExecuteAsync(script);
    }

    [Theory]
    [InlineData("return 1 + 2;", "3")]
    [InlineData("return 'text';", "\"text\"")]
    [InlineData("return true;", "true")]
    [InlineData("return null;", "null")]
    [InlineData("return { a: [1, 2] };", "{\"a\":[1,2]}")]
    public async Task Returns_the_value_as_json(string script, string expected)
    {
        var result = await Execute(script);

        Assert.True(result.Succeeded, result.Error?.ToString());
        Assert.Equal(expected, result.Json);
    }

    [Fact]
    public async Task Undefined_has_no_json()
    {
        var result = await Execute("const x = 1;");

        Assert.True(result.Succeeded);
        Assert.Null(result.Json);
    }

    [Fact]
    public async Task Await_is_allowed_and_a_returned_promise_is_settled()
    {
        var result = await Execute("const v = await Promise.resolve(store.echo('hi')); return v + '!';");

        Assert.Equal("\"hi!\"", result.Json);
    }

    [Fact]
    public async Task Console_output_is_captured_with_levels()
    {
        var result = await Execute("console.log('a', 1, { b: 2 }); console.warn('careful'); console.error(new Error('bad'));");

        Assert.Equal(ScriptLogLevel.Log, result.Logs[0].Level);
        Assert.Equal("a 1 {\"b\":2}", result.Logs[0].Message);
        Assert.Equal(ScriptLogLevel.Warn, result.Logs[1].Level);
        Assert.Equal(ScriptLogLevel.Error, result.Logs[2].Level);
        Assert.StartsWith("Error: bad", result.Logs[2].Message);
    }

    [Fact]
    public async Task Complex_arguments_and_results_round_trip()
    {
        var result = await Execute("""
            store.put({ id: 'a', name: 'First', tags: ['x', 'y'], nested: { enabled: true, count: 3 } });
            const item = store.get('a');
            return item.nested.count + item.tags.length;
            """);

        Assert.True(result.Succeeded, result.Error?.ToString());
        Assert.Equal("5", result.Json);
    }

    [Fact]
    public async Task Payloads_far_beyond_the_old_buffer_sizes_pass_both_ways()
    {
        var result = await Execute("""
            const big = 'x'.repeat(300000) + 'é漢';
            const back = store.echo(big);
            if (back !== big) throw new Error('mismatch');
            return back;
            """);

        Assert.True(result.Succeeded, result.Error?.ToString());
        var value = result.GetValue<string>()!;
        Assert.Equal(300002, value.Length);
        Assert.EndsWith("é漢", value);
    }

    [Fact]
    public async Task A_thrown_error_reports_its_line_in_the_submitted_script()
    {
        var result = await Execute("const a = 1;\nconst b = 2;\nthrow new TypeError('broken here');");

        Assert.Equal(ScriptErrorKind.Exception, result.Error!.Kind);
        Assert.Equal("TypeError", result.Error.Name);
        Assert.Equal("broken here", result.Error.Message);
        Assert.Equal(3, result.Error.Line);
        Assert.DoesNotContain("scriptbox.js", result.Error.Stack);
    }

    [Fact]
    public async Task A_syntax_error_is_reported_as_an_exception()
    {
        var result = await Execute("const = ;");

        Assert.Equal(ScriptErrorKind.Exception, result.Error!.Kind);
        Assert.Equal("SyntaxError", result.Error.Name);
    }

    [Fact]
    public async Task A_host_api_rejection_reaches_the_script_as_a_catchable_error()
    {
        var result = await Execute("""
            try { store.get('missing'); } catch (e) { return e.name + ': ' + e.message; }
            """);

        Assert.Equal("\"NotFoundError: No item has the id 'missing'.\"", result.Json);
    }

    [Fact]
    public async Task An_uncaught_host_error_points_at_the_calling_line()
    {
        var result = await Execute("const x = 1;\nstore.fail();");

        Assert.Equal("HostError", result.Error!.Name);
        Assert.Equal("the host broke", result.Error.Message);
        Assert.Equal(2, result.Error.Line);
    }

    [Theory]
    [InlineData("store.get();", "requires the argument 'id'")]
    [InlineData("store.echo('a', 'b');", "takes 1 argument(s) but was given 2")]
    [InlineData("store.put({ id: 1 });", "not a valid Item")]
    [InlineData("store.nope();", "not a function")]
    public async Task Bad_calls_fail_with_a_message_naming_the_problem(string script, string expected)
    {
        var result = await Execute(script);

        Assert.False(result.Succeeded);
        Assert.Contains(expected, result.Error!.Message);
    }

    [Fact]
    public async Task Omitted_trailing_arguments_take_their_defaults()
    {
        var result = await Execute("return [store.repeat('ab'), store.repeat('ab', 3)];");

        Assert.Equal("[\"abab\",\"ababab\"]", result.Json);
    }

    [Fact]
    public async Task Scripts_run_in_strict_mode()
    {
        var result = await Execute("undeclared = 5;");

        Assert.Equal("ReferenceError", result.Error!.Name);
    }

    [Fact]
    public async Task Sealed_results_reject_a_misspelt_member_but_allow_edits()
    {
        var script = """
            store.put({ id: 'a', name: 'First', tags: [], nested: { enabled: true, count: 0 } });
            const item = store.get('a');
            item.name = 'Renamed';
            item.tags.push('new');
            item.nested.enabeld = false;
            """;

        var sealedResult = await Execute(script, b => b.SealHostResults());
        var openResult = await Execute(script);

        Assert.Equal("TypeError", sealedResult.Error!.Name);
        Assert.Equal(5, sealedResult.Error.Line);
        Assert.True(openResult.Succeeded);
    }

    [Fact]
    public async Task The_raw_bridge_and_ambient_capabilities_are_not_reachable()
    {
        var result = await Execute("return [typeof __host, typeof require, typeof fetch, typeof std, typeof os];");

        Assert.Equal("[\"undefined\",\"undefined\",\"undefined\",\"undefined\",\"undefined\"]", result.Json);
    }

    [Fact]
    public async Task An_infinite_loop_is_stopped_at_the_timeout()
    {
        var stopwatch = Stopwatch.StartNew();
        var result = await Execute("let i = 0;\nwhile (true) { i++; }", b => b.WithExecutionTimeout(TimeSpan.FromMilliseconds(300)));

        Assert.Equal(ScriptErrorKind.Timeout, result.Error!.Kind);
        Assert.True(stopwatch.Elapsed < TimeSpan.FromSeconds(2), $"took {stopwatch.Elapsed}");
    }

    [Fact]
    public async Task The_timeout_also_cancels_a_host_call_in_progress()
    {
        var stopwatch = Stopwatch.StartNew();
        var result = await Execute("store.slow(10000);", b => b.WithExecutionTimeout(TimeSpan.FromMilliseconds(300)));

        Assert.Equal(ScriptErrorKind.Timeout, result.Error!.Kind);
        Assert.True(stopwatch.Elapsed < TimeSpan.FromSeconds(2), $"took {stopwatch.Elapsed}");
    }

    [Theory]
    [InlineData("async function spin() { while (true) {} }\nfor (;;) { try { await spin(); } catch (e) { store.echo('caught'); } }")]
    [InlineData("for (;;) { await new Promise(r => { while (true) {} }).catch(() => store.echo('caught')); }")]
    public async Task A_script_cannot_catch_the_timeout_and_carry_on(string script)
    {
        var api = new StoreApi();
        var box = ScriptBoxBuilder.Create().AddFromObject(api).WithExecutionTimeout(TimeSpan.FromMilliseconds(300)).Build();
        var stopwatch = Stopwatch.StartNew();

        var result = await box.CreateSession().ExecuteAsync(script);

        Assert.Equal(ScriptErrorKind.Timeout, result.Error!.Kind);
        Assert.True(stopwatch.Elapsed < TimeSpan.FromSeconds(1.5), $"took {stopwatch.Elapsed}");
    }

    [Fact]
    public async Task Cancelling_stops_a_script_that_has_no_timeout()
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(200));
        var session = Build(b => b.WithExecutionTimeout(TimeSpan.Zero)).CreateSession();

        var run = session.ExecuteAsync("async function spin() { while (true) {} }\nfor (;;) { try { await spin(); } catch (e) {} }", cts.Token);

        var finished = await Task.WhenAny(run, Task.Delay(TimeSpan.FromSeconds(3)));
        Assert.Same(run, finished);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => run);
    }

    [Fact]
    public async Task No_host_call_runs_after_the_timeout()
    {
        var api = new StoreApi();
        var box = ScriptBoxBuilder.Create().AddFromObject(api).WithExecutionTimeout(TimeSpan.FromMilliseconds(200)).Build();

        await box.CreateSession().ExecuteAsync("store.slow(400); store.echo('after');");

        Assert.DoesNotContain(api.Calls, c => c.StartsWith("echo", StringComparison.Ordinal));
    }

    [Fact]
    public async Task An_enum_argument_must_be_one_of_its_names()
    {
        var box = ScriptBoxBuilder.Create().AddFromObject(new LevelApi()).Build();

        var byName = await box.CreateSession().RunAsync("return levels.set('High');");
        var byNumber = await box.CreateSession().ExecuteAsync("return levels.set(999);");

        Assert.Equal(("\"High\"", "TypeError"), (byName, byNumber.Error?.Name));
    }

    [Fact]
    public async Task A_result_over_the_limit_fails_with_a_message_asking_for_less()
    {
        var result = await Execute("return 'x'.repeat(5000);", b => b.WithResultLimit(1000));

        Assert.Contains("Return only what is needed", result.Error!.Message);
    }

    [Fact]
    public void A_negative_session_timeout_is_refused()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => Build().CreateSession(o => o.Timeout = TimeSpan.FromSeconds(-1)));
    }

    [SandboxApi("levels")]
    public sealed class LevelApi
    {
        [SandboxMethod("set")]
        public Level Set(Level level) => level;
    }

    public enum Level
    {
        Low,
        High,
    }

    [Fact]
    public async Task Cancelling_the_token_stops_the_script_and_throws()
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(200));
        var session = Build().CreateSession();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => session.ExecuteAsync("while (true) {}", cts.Token));
    }

    [Fact]
    public async Task Exceeding_the_memory_limit_is_reported_as_such()
    {
        var result = await Execute(
            "const parts = []; while (true) { parts.push('x'.repeat(1 << 20) + parts.length); }",
            b => b.WithMemoryLimit(32L * 1024 * 1024));

        Assert.Equal(ScriptErrorKind.MemoryLimit, result.Error!.Kind);
    }

    [Fact]
    public async Task Deep_recursion_is_a_catchable_error()
    {
        var result = await Execute("function f(n) { return f(n + 1) + 1; }\ntry { f(0); } catch (e) { return e.message; }");

        Assert.Equal("\"stack overflow\"", result.Json);
    }

    [Fact]
    public async Task Each_execution_starts_from_a_fresh_realm()
    {
        var session = Build().CreateSession();

        await session.RunAsync("globalThis.leftover = 1;");
        var second = await session.RunAsync("return typeof leftover;");

        Assert.Equal("\"undefined\"", second);
    }

    [Fact]
    public async Task A_session_can_serve_its_own_api_instance()
    {
        var box = Build();
        var mine = new StoreApi();
        var session = box.CreateSession(o => o.UseApi(mine));

        await session.RunAsync("store.put({ id: 'a', name: 'n', tags: [], nested: { enabled: false, count: 0 } });");
        var otherSession = await box.CreateSession().ExecuteAsync("return store.get('a');");

        Assert.Equal(new[] { "put:a" }, mine.Calls);
        Assert.Equal("NotFoundError", otherSession.Error!.Name);
    }

    [Fact]
    public void Serving_an_unregistered_api_per_session_is_refused()
    {
        var box = Build();

        Assert.Throws<InvalidOperationException>(() => box.CreateSession(o => o.UseApi(new object())));
    }

    [Fact]
    public async Task RunAsync_throws_a_script_exception_carrying_the_error()
    {
        var session = Build().CreateSession();

        var ex = await Assert.ThrowsAsync<ScriptException>(() => session.RunAsync("throw new Error('nope');"));

        Assert.Equal("nope", ex.Error.Message);
    }

    [Fact]
    public async Task Executions_do_not_run_on_the_callers_thread()
    {
        var callerThread = Environment.CurrentManagedThreadId;
        var box = ScriptBoxBuilder.Create().AddFromObject(new ThreadProbe()).Build();

        var result = await box.CreateSession().ExecuteAsync("return probe.threadId();");

        Assert.NotEqual(callerThread.ToString(), result.Json);
    }

    [SandboxApi("probe")]
    public sealed class ThreadProbe
    {
        [SandboxMethod("threadId")]
        public int ThreadId() => Environment.CurrentManagedThreadId;
    }
}
