using System.ComponentModel;
using System.Text.Json;
using global::ScriptBox;
using ScriptBox.Core.Runtime;
using ScriptBox.Docs;

namespace ScriptBox.Tests;

public class DocsApiTests
{
    [SandboxApi("files")]
    [Description("Reads and writes files in the scratchpad. Paths are absolute.")]
    public sealed class FilesApi
    {
        [SandboxMethod("read")]
        [Description("Reads a text file. Throws if it is missing.")]
        public string Read(string path) => path;

        [SandboxMethod("write")]
        [Description("Writes a text file, replacing it.")]
        public void Write(string path, string text)
        {
        }
    }

    private static IScriptBox Build()
    {
        var guides = new DocsTree()
            .DescribeDirectory("/guides", "How to write scripts here.")
            .AddFile("/guides/rules.md", "The rules every script follows.", "Return only what you need.\nNever wait for a run.");
        return ScriptBoxBuilder.Create().AddFromObject(new FilesApi()).WithDocs([guides]).Build();
    }

    private static async Task<JsonElement> Run(string script)
    {
        var result = await Build().CreateSession().ExecuteAsync(script);
        Assert.True(result.Succeeded, result.Error?.Message);
        return JsonDocument.Parse(result.Json!).RootElement;
    }

    [Fact]
    public async Task The_root_lists_the_api_folder_and_the_guides()
    {
        var root = await Run("return docs.ls();");

        var paths = root.EnumerateArray().Select(e => e.GetProperty("path").GetString()).ToList();
        Assert.Equal(["/api", "/guides"], paths);
        Assert.Equal("How to write scripts here.", root[1].GetProperty("summary").GetString());
    }

    [Fact]
    public async Task A_namespace_folder_lists_its_readme_declarations_and_a_file_per_function()
    {
        var listing = await Run("return docs.ls('/api/files');");

        var entries = listing.EnumerateArray().ToDictionary(e => e.GetProperty("path").GetString()!, e => e.GetProperty("summary").GetString());
        Assert.Equal(["/api/files/README.md", "/api/files/index.d.ts", "/api/files/read.d.ts", "/api/files/write.d.ts"], entries.Keys);
        Assert.Equal("Reads a text file.", entries["/api/files/read.d.ts"]);
    }

    [Fact]
    public async Task Reading_a_function_gives_only_its_declaration()
    {
        var files = await Run("return docs.read('/api/files/read.d.ts');");

        var content = files[0].GetProperty("content").GetString();
        Assert.Contains("read(path: string): string;", content);
        Assert.DoesNotContain("write(", content);
    }

    [Fact]
    public async Task Several_files_are_read_at_once_and_a_missing_one_says_so()
    {
        var files = await Run("return docs.read(['/guides/rules.md', '/guides/nothing.md', '/api']);");

        Assert.StartsWith("Return only", files[0].GetProperty("content").GetString());
        Assert.Contains("There is no file /guides/nothing.md", files[1].GetProperty("error").GetString());
        Assert.Contains("is a folder", files[2].GetProperty("error").GetString());
    }

    [Fact]
    public async Task The_readme_lists_each_function_with_its_summary()
    {
        var files = await Run("return docs.read('/api/files/README.md');");

        var readme = files[0].GetProperty("content").GetString();
        Assert.Contains("Reads and writes files in the scratchpad.", readme);
        Assert.Contains("- `files.write`: Writes a text file, replacing it.", readme);
    }

    [Fact]
    public async Task Grep_finds_lines_across_sources()
    {
        var matches = await Run("return docs.grep('never wait');");

        Assert.Equal("/guides/rules.md", matches[0].GetProperty("path").GetString());
        Assert.Equal(2, matches[0].GetProperty("line").GetInt32());
    }

    [Fact]
    public async Task Search_ranks_a_function_by_its_name_and_summary()
    {
        var hits = await Run("return docs.search('write a file', 3);");

        Assert.Equal("/api/files/write.d.ts", hits[0].GetProperty("path").GetString());
    }

    [Fact]
    public async Task Listing_a_missing_folder_is_an_error_that_points_up()
    {
        var result = await Build().CreateSession().ExecuteAsync("return docs.ls('/api/nothing');");

        Assert.Equal("NotFoundError", result.Error?.Name);
        Assert.Contains("List /api", result.Error?.Message);
    }

    [Fact]
    public void The_declarations_type_read_as_one_path_or_several()
    {
        Assert.Contains("read(paths: string | string[]): DocsFile[];", Build().GetTypeScriptDeclarations());
    }

    [Fact]
    public void Docs_can_leave_an_api_out_of_the_reference()
    {
        var box = ScriptBoxBuilder.Create().AddFromObject(new FilesApi()).WithDocs(includeApi: a => a.JsNamespace != "docs").Build();

        var listing = box.CreateSession().ExecuteAsync("return docs.ls('/api').map(e => e.path);").Result;

        Assert.Equal("""["/api/files"]""", listing.Json);
    }
}
