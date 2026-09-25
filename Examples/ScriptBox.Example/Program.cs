using ScriptBox;
using ScriptBox.Demo;

Console.WriteLine("=== ScriptBox Demo ===");

var scriptBox = ScriptBoxBuilder
    .Create()
    .RegisterApisFrom(typeof(DemoCalculatorApi))
    .WithExecutionTimeout(TimeSpan.FromSeconds(5))
    .Build();

Console.WriteLine(scriptBox.GetTypeScriptDeclarations());

var scriptPath = Path.Combine(AppContext.BaseDirectory, "scripts", "sample-script.js");
var result = await scriptBox.CreateSession().ExecuteAsync(File.ReadAllText(scriptPath));

foreach (var entry in result.Logs)
{
    Console.WriteLine($"[{entry.Level}] {entry.Message}");
}

Console.WriteLine(result.Succeeded ? $"Returned: {result.Json}" : $"Failed: {result.Error}");
