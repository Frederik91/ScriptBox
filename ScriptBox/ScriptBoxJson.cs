using System.Text.Json;
using System.Text.Json.Serialization;

namespace ScriptBox;

public static class ScriptBoxJson
{
    /// <summary>
    /// The options used for host call arguments and results unless the builder
    /// is given others: camelCase names, case-insensitive reads, and enums as
    /// their names. Generated TypeScript declarations assume the same shapes.
    /// </summary>
    public static JsonSerializerOptions CreateDefaultOptions()
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        options.Converters.Add(new JsonStringEnumConverter(namingPolicy: null, allowIntegerValues: false));
        return options;
    }
}
