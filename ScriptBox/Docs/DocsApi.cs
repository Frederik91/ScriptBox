using System.ComponentModel;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using System.Threading;
using ScriptBox.Core.Runtime;

namespace ScriptBox.Docs;

/// <summary>
/// The <c>docs</c> namespace: a read-only tree of documentation a script can list, read, grep and search.
/// </summary>
[SandboxApi("docs")]
[Description("Read-only documentation of everything a script can call, laid out as files. "
    + "List a folder with docs.ls, read files with docs.read, find text with docs.grep and find a topic with docs.search.")]
public sealed class DocsApi
{
    public const int MaxReadPaths = 20;
    public const int MaxGrepMatches = 200;
    private static readonly TimeSpan GrepTimeout = TimeSpan.FromSeconds(1);

    private readonly List<IDocsSource> _sources;
    private readonly object _lock = new();

    public DocsApi(IEnumerable<IDocsSource> sources)
    {
        _sources = (sources ?? throw new ArgumentNullException(nameof(sources))).ToList();
    }

    /// <summary>Adds a source, for one that can only be made once the box exists, such as <see cref="ApiReferenceDocs"/>.</summary>
    public void Add(IDocsSource source)
    {
        lock (_lock)
        {
            _sources.Add(source ?? throw new ArgumentNullException(nameof(source)));
        }
    }

    [SandboxMethod("ls")]
    [Description("Lists the files and folders directly inside a folder, each with a one-line summary.")]
    public async Task<IReadOnlyList<DocsEntry>> ListAsync(
        [Description("The folder; \"/\" when left out.")] string? path = null,
        CancellationToken cancellationToken = default)
    {
        var directory = DocsPath.Normalize(path);
        var entries = new Dictionary<string, DocsEntry>(StringComparer.Ordinal);
        foreach (var source in Sources())
        {
            foreach (var entry in await source.ListAsync(directory, cancellationToken).ConfigureAwait(false))
            {
                // A folder two sources share keeps the first summary given.
                if (!entries.TryGetValue(entry.Path, out var existing) || existing.Summary is null)
                {
                    entries[entry.Path] = entry;
                }
            }
        }

        if (entries.Count == 0 && directory != "/")
        {
            throw new ScriptApiException(
                $"There is no folder {directory}. List {DocsPath.Parent(directory)} or use docs.search.", "NotFoundError");
        }

        return DocsTree.Order(entries.Values);
    }

    [SandboxMethod("read")]
    [Description("Reads one file, or several at once by passing an array of paths. A path that holds no file comes back with an error instead of content.")]
    public async Task<IReadOnlyList<DocsFile>> ReadAsync(
        [Description("A path, or an array of up to 20.")] DocsPaths paths,
        CancellationToken cancellationToken = default)
    {
        if (paths.Values.Count > MaxReadPaths)
        {
            throw new ScriptApiException($"docs.read takes at most {MaxReadPaths} paths at once.", "RangeError");
        }

        var files = new List<DocsFile>();
        foreach (var requested in paths.Values)
        {
            var path = DocsPath.Normalize(requested);
            files.Add(await ReadOneAsync(path, cancellationToken).ConfigureAwait(false));
        }

        return files;
    }

    [SandboxMethod("grep")]
    [Description("Finds the lines that match a regular expression, case-insensitive, in every file under a folder.")]
    public async Task<IReadOnlyList<DocsMatch>> GrepAsync(
        [Description("A regular expression, or plain text.")] string pattern,
        [Description("The folder to look in; \"/\" when left out.")] string? path = null,
        [Description("The most lines to return; 50 when left out.")] int? maxMatches = null,
        CancellationToken cancellationToken = default)
    {
        var limit = Math.Max(1, Math.Min(maxMatches ?? 50, MaxGrepMatches));
        var grep = new DocsGrep(Compile(pattern), DocsPath.Normalize(path), limit);
        var matches = new List<DocsMatch>();
        foreach (var source in Sources())
        {
            if (matches.Count >= limit)
            {
                break;
            }

            try
            {
                var found = await source.GrepAsync(grep with { MaxMatches = limit - matches.Count }, cancellationToken).ConfigureAwait(false);
                matches.AddRange(found.Take(limit - matches.Count));
            }
            catch (RegexMatchTimeoutException)
            {
                throw new ScriptApiException("The pattern took too long to match. Use a simpler one.", "RangeError");
            }
        }

        return matches;
    }

    [SandboxMethod("search")]
    [Description("Finds the files about a topic, best first. Describe what you want to do in a few words.")]
    public async Task<IReadOnlyList<DocsSearchHit>> SearchAsync(
        string query,
        [Description("The most files to return; 8 when left out.")] int? top = null,
        CancellationToken cancellationToken = default)
    {
        var count = Math.Max(1, Math.Min(top ?? 8, 50));
        var hits = new List<DocsSearchHit>();
        foreach (var source in Sources())
        {
            hits.AddRange(await source.SearchAsync(query ?? string.Empty, count, cancellationToken).ConfigureAwait(false));
        }

        return hits
            .GroupBy(h => h.Path, StringComparer.Ordinal)
            .Select(g => g.OrderByDescending(h => h.Score).First())
            .OrderByDescending(h => h.Score)
            .ThenBy(h => h.Path, StringComparer.Ordinal)
            .Take(count)
            .ToList();
    }

    private async Task<DocsFile> ReadOneAsync(string path, CancellationToken cancellationToken)
    {
        foreach (var source in Sources())
        {
            var content = await source.ReadAsync(path, cancellationToken).ConfigureAwait(false);
            if (content is not null)
            {
                return new DocsFile(path, content, null);
            }
        }

        foreach (var source in Sources())
        {
            if ((await source.ListAsync(path, cancellationToken).ConfigureAwait(false)).Count > 0)
            {
                return new DocsFile(path, null, $"{path} is a folder. List it with docs.ls.");
            }
        }

        return new DocsFile(path, null, $"There is no file {path}. List {DocsPath.Parent(path)} or use docs.search.");
    }

    private IReadOnlyList<IDocsSource> Sources()
    {
        lock (_lock)
        {
            return _sources.ToList();
        }
    }

    private static Regex Compile(string pattern)
    {
        if (string.IsNullOrEmpty(pattern))
        {
            throw new ScriptApiException("docs.grep needs a pattern.", "InvalidArgumentsError");
        }

        const RegexOptions options = RegexOptions.IgnoreCase | RegexOptions.CultureInvariant;
        try
        {
            return new Regex(pattern, options, GrepTimeout);
        }
        catch (ArgumentException)
        {
            return new Regex(Regex.Escape(pattern), options, GrepTimeout);
        }
    }
}

/// <summary>One path or several, as <c>docs.read</c> accepts them.</summary>
[JsonConverter(typeof(DocsPathsConverter))]
public sealed class DocsPaths
{
    public const string TypeScript = "string | string[]";

    public DocsPaths(IReadOnlyList<string> values) => Values = values;

    public IReadOnlyList<string> Values { get; }
}

internal sealed class DocsPathsConverter : JsonConverter<DocsPaths>
{
    public override DocsPaths Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType == JsonTokenType.String)
        {
            return new DocsPaths(new[] { reader.GetString() ?? string.Empty });
        }

        if (reader.TokenType != JsonTokenType.StartArray)
        {
            throw new JsonException("Expected a path or an array of paths.");
        }

        var values = new List<string>();
        while (reader.Read() && reader.TokenType != JsonTokenType.EndArray)
        {
            values.Add(reader.TokenType == JsonTokenType.String
                ? reader.GetString() ?? string.Empty
                : throw new JsonException("Every path must be a string."));
        }

        return new DocsPaths(values);
    }

    public override void Write(Utf8JsonWriter writer, DocsPaths value, JsonSerializerOptions options)
    {
        writer.WriteStartArray();
        foreach (var path in value.Values)
        {
            writer.WriteStringValue(path);
        }

        writer.WriteEndArray();
    }
}
