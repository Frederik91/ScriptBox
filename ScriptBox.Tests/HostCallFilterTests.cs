using System.ComponentModel;
using System.Text.Json;
using global::ScriptBox;
using ScriptBox.Core.Runtime;

namespace ScriptBox.Tests;

public class HostCallFilterTests
{
    [AttributeUsage(AttributeTargets.Method)]
    public sealed class EffectAttribute : Attribute;

    [SandboxApi("shop")]
    [Description("A small shop.")]
    public sealed class ShopApi
    {
        public List<string> Calls { get; } = new();

        [SandboxMethod("price")]
        [Description("The price of an item. Throws if unknown.")]
        public int Price(string item)
        {
            Calls.Add("price:" + item);
            return 10;
        }

        [SandboxMethod("buy")]
        [Effect]
        public string Buy(string item)
        {
            Calls.Add("buy:" + item);
            return "bought " + item;
        }
    }

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

    private sealed class ProposeEffects(List<string> proposed) : IHostCallFilter
    {
        public Task<HostCallResult> InvokeAsync(HostCallContext context, HostCallNext next)
        {
            if (context.MethodDescriptor.GetAttribute<EffectAttribute>() is null)
            {
                return next();
            }

            proposed.Add($"{context.Method}({context.Arguments[0].GetString()})");
            return Task.FromResult(HostCallResult.From(new { proposed = true }));
        }
    }

    private sealed class Refuse : IHostCallFilter
    {
        public Task<HostCallResult> InvokeAsync(HostCallContext context, HostCallNext next) =>
            throw new ScriptApiException($"{context.Method} needs approval.", "ApprovalRequiredError");
    }

    [Fact]
    public async Task A_filter_reads_the_methods_attributes_and_answers_in_its_place()
    {
        var shop = new ShopApi();
        var proposed = new List<string>();
        var box = ScriptBoxBuilder.Create().AddFromObject(shop).UseHostCallFilter(new ProposeEffects(proposed)).Build();

        var result = await box.CreateSession().ExecuteAsync("return [shop.price('tea'), shop.buy('tea')];");

        Assert.True(result.Succeeded, result.Error?.Message);
        Assert.Equal("""[10,{"proposed":true}]""", result.Json);
        Assert.Equal(["price:tea"], shop.Calls);
        Assert.Equal(["shop.buy(tea)"], proposed);
    }

    [Fact]
    public async Task A_refusal_is_an_error_the_script_can_catch()
    {
        var box = ScriptBoxBuilder.Create().AddFromObject(new ShopApi()).UseHostCallFilter(new Refuse()).Build();

        var result = await box.CreateSession().ExecuteAsync("""
            try { shop.buy('tea'); } catch (e) { return e.name + ': ' + e.message; }
            """);

        Assert.Equal("\"ApprovalRequiredError: shop.buy needs approval.\"", result.Json);
    }

    [Fact]
    public async Task Box_filters_run_outside_session_filters_in_the_order_they_were_added()
    {
        var log = new List<string>();
        var box = ScriptBoxBuilder.Create()
            .AddFromObject(new ShopApi())
            .UseHostCallFilter(new RecordingFilter(log, "box1"))
            .UseHostCallFilter(new RecordingFilter(log, "box2"))
            .Build();

        await box.CreateSession(o => o.UseHostCallFilter(new RecordingFilter(log, "session"))).ExecuteAsync("shop.price('tea');");

        Assert.Equal(["box1>shop.price", "box2>shop.price", "session>shop.price", "session<shop.price", "box2<shop.price", "box1<shop.price"], log);
    }

    [Fact]
    public async Task A_call_through_hostCall_passes_the_filters_too()
    {
        var box = ScriptBoxBuilder.Create().AddFromObject(new ShopApi()).UseHostCallFilter(new Refuse()).Build();

        var result = await box.CreateSession().ExecuteAsync("""
            try { __scriptbox.hostCall('shop.buy', ['tea']); } catch (e) { return e.name; }
            """);

        Assert.Equal("\"ApprovalRequiredError\"", result.Json);
    }

    [Fact]
    public async Task A_script_cannot_replace_how_calls_reach_the_host()
    {
        var box = ScriptBoxBuilder.Create().AddFromObject(new ShopApi()).Build();

        var result = await box.CreateSession().ExecuteAsync("""
            const errors = [];
            try { __scriptbox = {}; } catch (e) { errors.push(e.name); }
            try { __scriptbox.hostCall = () => 1; } catch (e) { errors.push(e.name); }
            return errors;
            """);

        Assert.Equal("""["TypeError","TypeError"]""", result.Json);
    }

    [Fact]
    public void Declarations_can_be_limited_to_some_methods()
    {
        var box = ScriptBoxBuilder.Create().AddFromObject(new ShopApi()).Build();

        var declarations = box.GetTypeScriptDeclarations(m => m.JsMethodName == "price");

        Assert.Contains("price(item: string): number;", declarations);
        Assert.DoesNotContain("buy(", declarations);
    }

    [Fact]
    public void A_namespace_with_no_included_method_is_left_out()
    {
        var box = ScriptBoxBuilder.Create().AddFromObject(new ShopApi()).Build();

        Assert.DoesNotContain("shop", box.GetTypeScriptDeclarations(_ => false));
    }

    [Fact]
    public void A_method_descriptor_offers_its_summary()
    {
        var box = ScriptBoxBuilder.Create().AddFromObject(new ShopApi()).Build();

        var price = box.Apis.Single().Methods.Single(m => m.JsMethodName == "price");

        Assert.Equal("The price of an item.", price.Summary);
    }
}
