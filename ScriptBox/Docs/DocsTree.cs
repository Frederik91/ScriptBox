using System.Threading;

namespace ScriptBox.Docs;

/// <summary>
/// Docs held in memory: files added by path, folders implied by them. A file's text can be produced on first read.
/// </summary>
public sealed class DocsTree : IDocsSource
{
    private readonly object _lock = new();
    private readonly Dictionary<string, Node> _files = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> _directorySummaries = new(StringComparer.Ordinal);

    public DocsTree AddFile(string path, string? summary, string content) => AddFile(path, summary, () => content);

    public DocsTree AddFile(string path, string? summary, Func<string> content)
    {
        if (content is null)
        {
            throw new ArgumentNullException(nameof(content));
        }

        var normalized = DocsPath.Normalize(path);
        if (normalized == "/")
        {
            throw new ArgumentException("A file needs a name.", nameof(path));
        }

        lock (_lock)
        {
            _files[normalized] = new Node(summary, new Lazy<string>(content, LazyThreadSafetyMode.ExecutionAndPublication));
        }

        return this;
    }

    /// <summary>Gives a folder the one-line summary its listing shows.</summary>
    public DocsTree DescribeDirectory(string path, string summary)
    {
        lock (_lock)
        {
            _directorySummaries[DocsPath.Normalize(path)] = summary;
        }

        return this;
    }

    public IReadOnlyList<DocsEntry> Files
    {
        get
        {
            lock (_lock)
            {
                return _files.Select(f => DocsEntry.File(f.Key, f.Value.Summary)).ToList();
            }
        }
    }

    public Task<IReadOnlyList<DocsEntry>> ListAsync(string directory, CancellationToken cancellationToken)
    {
        var dir = DocsPath.Normalize(directory);
        var entries = new Dictionary<string, DocsEntry>(StringComparer.Ordinal);
        lock (_lock)
        {
            foreach (var file in _files)
            {
                if (!DocsPath.IsUnder(file.Key, dir) || file.Key == dir)
                {
                    continue;
                }

                var rest = dir == "/" ? file.Key.Substring(1) : file.Key.Substring(dir.Length + 1);
                var slash = rest.IndexOf('/');
                if (slash < 0)
                {
                    entries[file.Key] = DocsEntry.File(file.Key, file.Value.Summary);
                    continue;
                }

                var child = (dir == "/" ? "" : dir) + "/" + rest.Substring(0, slash);
                if (!entries.ContainsKey(child))
                {
                    _directorySummaries.TryGetValue(child, out var summary);
                    entries[child] = DocsEntry.Directory(child, summary);
                }
            }
        }

        return Task.FromResult<IReadOnlyList<DocsEntry>>(Order(entries.Values));
    }

    public Task<string?> ReadAsync(string path, CancellationToken cancellationToken)
    {
        Node? node;
        lock (_lock)
        {
            _files.TryGetValue(DocsPath.Normalize(path), out node);
        }

        return Task.FromResult(node?.Content.Value);
    }

    public Task<IReadOnlyList<DocsMatch>> GrepAsync(DocsGrep grep, CancellationToken cancellationToken)
    {
        var matches = new List<DocsMatch>();
        foreach (var (path, node) in Snapshot().Where(f => DocsPath.IsUnder(f.Path, grep.Directory)))
        {
            var lines = node.Content.Value.Split('\n');
            for (var i = 0; i < lines.Length && matches.Count < grep.MaxMatches; i++)
            {
                if (grep.Pattern.IsMatch(lines[i]))
                {
                    matches.Add(new DocsMatch(path, i + 1, lines[i].TrimEnd('\r').Trim()));
                }
            }

            if (matches.Count >= grep.MaxMatches)
            {
                break;
            }
        }

        return Task.FromResult<IReadOnlyList<DocsMatch>>(matches);
    }

    public Task<IReadOnlyList<DocsSearchHit>> SearchAsync(string query, int top, CancellationToken cancellationToken)
    {
        var terms = DocsSearchScoring.Terms(query);
        var hits = Snapshot()
            .Select(f => new DocsSearchHit(f.Path, f.Node.Summary, DocsSearchScoring.Score(terms, f.Path, f.Node.Summary, f.Node.Content.Value)))
            .Where(h => h.Score > 0)
            .OrderByDescending(h => h.Score)
            .ThenBy(h => h.Path, StringComparer.Ordinal)
            .Take(top)
            .ToList();
        return Task.FromResult<IReadOnlyList<DocsSearchHit>>(hits);
    }

    internal static IReadOnlyList<DocsEntry> Order(IEnumerable<DocsEntry> entries) =>
        entries
            .OrderBy(e => e.Kind == DocsEntry.DirectoryKind ? 0 : 1)
            .ThenBy(e => e.Path.EndsWith("/README.md", StringComparison.Ordinal) ? 0 : 1)
            .ThenBy(e => e.Path, StringComparer.Ordinal)
            .ToList();

    private List<(string Path, Node Node)> Snapshot()
    {
        lock (_lock)
        {
            return _files.OrderBy(f => f.Key, StringComparer.Ordinal).Select(f => (f.Key, f.Value)).ToList();
        }
    }

    private sealed record Node(string? Summary, Lazy<string> Content);
}
