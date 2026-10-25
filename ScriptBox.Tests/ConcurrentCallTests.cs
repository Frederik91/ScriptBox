using global::ScriptBox;
using ScriptBox.Core.Runtime;

namespace ScriptBox.Tests;

public class ConcurrentCallTests
{
    [SandboxApi("gate")]
    public sealed class GateApi
    {
        private readonly object _lock = new();
        private readonly TaskCompletionSource<bool> _everyoneArrived = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int _arrived;
        private int _running;

        public List<string> Events { get; } = new();

        public int MaxRunning { get; private set; }

        public int Cancelled { get; private set; }

        public int Finished { get; private set; }

        /// <summary>Resolves once <paramref name="count"/> calls have arrived, so it can only succeed when they run together.</summary>
        [SandboxMethod("meet", Concurrent = true)]
        public async Task<int> MeetAsync(int count, CancellationToken cancellationToken)
        {
            if (Interlocked.Increment(ref _arrived) >= count)
            {
                _everyoneArrived.TrySetResult(true);
            }

            await _everyoneArrived.Task.WaitAsync(cancellationToken);
            return count;
        }

        [SandboxMethod("read", Concurrent = true)]
        public Task<string> ReadAsync(string name, int milliseconds, CancellationToken cancellationToken) =>
            HoldAsync(name, milliseconds, cancellationToken);

        [SandboxMethod("write")]
        public Task<string> WriteAsync(string name, int milliseconds, CancellationToken cancellationToken) =>
            HoldAsync(name, milliseconds, cancellationToken);

        [SandboxMethod("failSoon", Concurrent = true)]
        public async Task FailSoonAsync()
        {
            await Task.Delay(20);
            throw new ScriptApiException("Failed on purpose.", "PurposeError");
        }

        private async Task<string> HoldAsync(string name, int milliseconds, CancellationToken cancellationToken)
        {
            lock (_lock)
            {
                Events.Add("start:" + name);
                MaxRunning = Math.Max(MaxRunning, ++_running);
            }

            try
            {
                await Task.Delay(milliseconds, cancellationToken);
                return name;
            }
            catch (OperationCanceledException)
            {
                lock (_lock)
                {
                    Cancelled++;
                }

                throw;
            }
            finally
            {
                lock (_lock)
                {
                    _running--;
                    Finished++;
                    Events.Add("end:" + name);
                }
            }
        }
    }

    private static Task<ScriptExecutionResult> Execute(GateApi gate, string script, Action<ScriptBoxBuilder>? configure = null)
    {
        var builder = ScriptBoxBuilder.Create().AddFromObject(gate).WithExecutionTimeout(TimeSpan.FromSeconds(10));
        configure?.Invoke(builder);
        return builder.Build().CreateSession().ExecuteAsync(script);
    }

    [Fact]
    public async Task Concurrent_calls_the_script_awaits_together_run_at_the_same_time()
    {
        var gate = new GateApi();

        var result = await Execute(gate, "return await Promise.all([gate.meet(3), gate.meet(3), gate.meet(3)]);");

        Assert.True(result.Succeeded, result.Error?.ToString());
        Assert.Equal("[3,3,3]", result.Json);
    }

    [Theory]
    [InlineData(null, 4)]
    [InlineData(2, 2)]
    public async Task No_more_concurrent_calls_run_than_the_limit(int? limit, int expected)
    {
        var gate = new GateApi();

        var result = await Execute(
            gate,
            "return await Promise.all(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(n => gate.read(n, 200)));",
            builder =>
            {
                if (limit is { } value)
                {
                    builder.WithConcurrentCallLimit(value);
                }
            });

        Assert.True(result.Succeeded, result.Error?.ToString());
        Assert.Equal("[\"a\",\"b\",\"c\",\"d\",\"e\",\"f\",\"g\"]", result.Json);
        Assert.Equal(expected, gate.MaxRunning);
    }

    [Fact]
    public async Task A_call_to_a_method_not_marked_concurrent_runs_alone_in_the_order_it_was_made()
    {
        var gate = new GateApi();

        var result = await Execute(gate, """
            return await Promise.all([gate.read('r1', 100), gate.read('r2', 50), gate.write('w', 50), gate.read('r3', 10)]);
            """);

        Assert.True(result.Succeeded, result.Error?.ToString());
        var events = gate.Events;
        Assert.Equal(2, gate.MaxRunning);
        Assert.True(events.IndexOf("start:w") > events.IndexOf("end:r1"), string.Join(", ", events));
        Assert.True(events.IndexOf("start:w") > events.IndexOf("end:r2"), string.Join(", ", events));
        Assert.True(events.IndexOf("start:r3") > events.IndexOf("end:w"), string.Join(", ", events));
    }

    [Fact]
    public async Task Each_call_settles_when_its_handler_finishes()
    {
        var gate = new GateApi();

        var result = await Execute(gate, """
            const order = [];
            await Promise.all([gate.read('slow', 300).then(n => order.push(n)), gate.read('fast', 10).then(n => order.push(n))]);
            return order;
            """);

        Assert.True(result.Succeeded, result.Error?.ToString());
        Assert.Equal("[\"fast\",\"slow\"]", result.Json);
    }

    [Fact]
    public async Task Calls_still_running_when_the_script_fails_are_cancelled_before_the_execution_returns()
    {
        var gate = new GateApi();

        var result = await Execute(gate, "await Promise.all([gate.read('long', 5000), gate.failSoon()]);");

        Assert.Equal("PurposeError", result.Error?.Name);
        Assert.Equal(1, gate.Cancelled);
        Assert.Equal(1, gate.Finished);
        Assert.True(result.Duration < TimeSpan.FromSeconds(4), result.Duration.ToString());
        Assert.Empty(result.HostErrors);
    }

    [Fact]
    public async Task A_timeout_cancels_every_running_call_and_waits_for_them()
    {
        var gate = new GateApi();

        var result = await Execute(
            gate,
            "await Promise.all([gate.read('a', 5000), gate.read('b', 5000), gate.read('c', 5000)]);",
            builder => builder.WithExecutionTimeout(TimeSpan.FromMilliseconds(300)));

        Assert.Equal(ScriptErrorKind.Timeout, result.Error?.Kind);
        Assert.Equal(3, gate.Cancelled);
        Assert.Equal(3, gate.Finished);
    }

    [Fact]
    public void The_descriptor_reports_whether_a_method_is_concurrent()
    {
        var box = ScriptBoxBuilder.Create().AddFromObject(new GateApi()).Build();
        var methods = box.Apis.Single().Methods.ToDictionary(m => m.JsMethodName);

        Assert.True(methods["read"].Concurrent);
        Assert.False(methods["write"].Concurrent);
    }
}
