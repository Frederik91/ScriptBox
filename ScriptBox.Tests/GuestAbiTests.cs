using global::ScriptBox;

namespace ScriptBox.Tests;

/// <summary>
/// This host and the Node host run the same guest, scriptbox-async.wasm (ABI 2).
/// A module of another ABI is refused before any script runs.
/// </summary>
public class GuestAbiTests
{
    // (module (import "host" "call" (func (param i32 i32) (result i32)))), the shape of ScriptBox 3's synchronous guest.
    private static readonly byte[] SyncGuest =
    [
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
        0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
        0x02, 0x0d, 0x01, 0x04, (byte)'h', (byte)'o', (byte)'s', (byte)'t', 0x04, (byte)'c', (byte)'a', (byte)'l', (byte)'l', 0x00, 0x00,
    ];

    // (module (import "env" "memory" (memory 1)) (func (export "sb_abi_version") (result i32) i32.const 1))
    private static readonly byte[] OtherAbiGuest =
    [
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
        0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f,
        0x02, 0x0f, 0x01, 0x03, (byte)'e', (byte)'n', (byte)'v', 0x06, (byte)'m', (byte)'e', (byte)'m', (byte)'o', (byte)'r', (byte)'y', 0x02, 0x00, 0x01,
        0x03, 0x02, 0x01, 0x00,
        0x07, 0x12, 0x01, 0x0e,
        (byte)'s', (byte)'b', (byte)'_', (byte)'a', (byte)'b', (byte)'i', (byte)'_', (byte)'v', (byte)'e', (byte)'r', (byte)'s', (byte)'i', (byte)'o', (byte)'n',
        0x00, 0x00,
        0x0a, 0x06, 0x01, 0x04, 0x00, 0x41, 0x01, 0x0b,
    ];

    [Fact]
    public void The_synchronous_guest_of_ScriptBox_3_is_refused()
    {
        var error = Assert.Throws<InvalidOperationException>(() => ScriptBoxBuilder.Create().WithWasmModule(SyncGuest).Build());

        Assert.Contains("ABI 1", error.Message);
    }

    [Fact]
    public async Task A_guest_of_another_abi_is_refused_before_any_script_runs()
    {
        var result = await ScriptBoxBuilder.Create().WithWasmModule(OtherAbiGuest).Build().CreateSession().ExecuteAsync("return 1;");

        Assert.Equal(ScriptErrorKind.Fault, result.Error?.Kind);
        Assert.Equal("protocol-mismatch", result.Error?.Code);
        Assert.Contains("guest ABI 1", result.Error?.Message);
    }

    [Fact]
    public async Task The_default_guest_speaks_ABI_2()
    {
        var result = await ScriptBoxBuilder.Create().Build().CreateSession().ExecuteAsync("return 1 + 1;");

        Assert.True(result.Succeeded, result.Error?.Message);
        Assert.Equal("2", result.Json);
    }
}
