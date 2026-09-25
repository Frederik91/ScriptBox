using System;
using System.Threading.Tasks;
using global::ScriptBox;
using ScriptBox.Tests.TestApis;

namespace ScriptBox.Tests;

public class ScriptBoxBuilderTests
{
    [Fact]
    public async Task RegisterApisFrom_SingleType_ExposesApi()
    {
        var scriptBox = ScriptBoxBuilder
            .Create()
            .RegisterApisFrom(typeof(AttributedCalculatorApi))
            .Build();

        var session = scriptBox.CreateSession();
        await session.RunAsync(@"
const result = calculator.add(2, 3);
if (result !== 5) {
    throw new Error('calculator.add returned ' + result);
}");
    }

    [Fact]
    public async Task RegisterApisFrom_CanBeCalledMultipleTimes()
    {
        var scriptBox = ScriptBoxBuilder
            .Create()
            .RegisterApisFrom(typeof(AttributedCalculatorApi))
            .RegisterApisFrom(typeof(AttributedCalculatorApi))
            .Build();

        var session = scriptBox.CreateSession();
        await session.RunAsync("const sum = calculator.add(4, 6); if (sum !== 10) throw new Error('unexpected sum ' + sum);");
    }

    [Fact]
    public async Task RegisterApisFrom_InstanceType_UsesActivatorByDefault()
    {
        var scriptBox = ScriptBoxBuilder
            .Create()
            .RegisterApisFrom<InstanceCalculatorApi>()
            .Build();

        var session = scriptBox.CreateSession();
        await session.RunAsync("const sum = instanceCalc.add(1, 4); if (sum !== 5) throw new Error('unexpected sum ' + sum);");
    }

    [Fact]
    public async Task RegisterApisFrom_UsesCustomFactory()
    {
        var factoryCalled = false;
        var customInstance = new InstanceCalculatorApi();

        var scriptBox = ScriptBoxBuilder
            .Create()
            .WithApiFactory(type =>
            {
                if (type == typeof(InstanceCalculatorApi))
                {
                    factoryCalled = true;
                    return customInstance;
                }

                return Activator.CreateInstance(type);
            })
            .RegisterApisFrom<InstanceCalculatorApi>()
            .Build();

        // Instances are created on first use, not at Build.
        Assert.False(factoryCalled);

        var session = scriptBox.CreateSession();
        await session.RunAsync("const sum = instanceCalc.add(2, 8); if (sum !== 10) throw new Error('unexpected sum ' + sum);");

        Assert.True(factoryCalled);
    }

    [Fact]
    public async Task RegisterApisFrom_WithExplicitName_ExposesApiWithoutAttribute()
    {
        var scriptBox = ScriptBoxBuilder
            .Create()
            .RegisterApisFrom<UnnamedCalculatorApi>("my_calc")
            .Build();

        var session = scriptBox.CreateSession();
        await session.RunAsync(@"
const result = my_calc.add(10, 5);
if (result !== 15) {
    throw new Error('my_calc.add returned ' + result);
}");
    }
}
