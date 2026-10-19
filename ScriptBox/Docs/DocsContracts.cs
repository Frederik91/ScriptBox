using System.ComponentModel;
using System.Threading;

namespace ScriptBox.Docs;

[Description("A file or folder in the docs.")]
public sealed record DocsEntry(
    [property: Description("Absolute path, such as /api/files/index.d.ts.")] string Path,
    [property: Description("\"file\" or \"directory\".")] string Kind,
    [property: Description("One line on what it holds.")] string? Summary)
{
    public const string FileKind = "file";
    public const string DirectoryKind = "directory";

    public static DocsEntry File(string path, string? summary) => new(DocsPath.Normalize(path), FileKind, summary);

    public static DocsEntry Directory(string path, string? summary) => new(DocsPath.Normalize(path), DirectoryKind, summary);
}

[Description("A file read from the docs. Content is null when the path holds no file, and error says why.")]
public sealed record DocsFile(string Path, string? Content, string? Error);

[Description("A line that matched a grep.")]
public sealed record DocsMatch(string Path, int Line, string Text);

[Description("A file that matched a search, best first.")]
public sealed record DocsSearchHit(string Path, string? Summary, double Score);

/// <summary>
/// Part of the tree the <c>docs</c> namespace serves. Paths are absolute and use <c>/</c>.
/// </summary>
/// <remarks>
/// Each source answers only for the paths it holds and returns nothing for the rest, so several can share a
/// folder. A source whose files come from a large or remote catalogue can list and read on demand and leave
/// <see cref="GrepAsync"/> empty, as long as <see cref="SearchAsync"/> finds them.
/// </remarks>
public interface IDocsSource
{
    /// <summary>The files and folders directly inside <paramref name="directory"/>.</summary>
    Task<IReadOnlyList<DocsEntry>> ListAsync(string directory, CancellationToken cancellationToken);

    /// <summary>The file's text, or null when this source does not hold it.</summary>
    Task<string?> ReadAsync(string path, CancellationToken cancellationToken);

    Task<IReadOnlyList<DocsMatch>> GrepAsync(DocsGrep grep, CancellationToken cancellationToken);

    Task<IReadOnlyList<DocsSearchHit>> SearchAsync(string query, int top, CancellationToken cancellationToken);
}

/// <summary>A grep request: the pattern, the folder it is limited to, and the most matches wanted.</summary>
public sealed record DocsGrep(System.Text.RegularExpressions.Regex Pattern, string Directory, int MaxMatches);

public static class DocsPath
{
    public static string Normalize(string? path)
    {
        if (path is null || string.IsNullOrWhiteSpace(path))
        {
            return "/";
        }

        var parts = path.Replace('\\', '/').Split(new[] { '/' }, StringSplitOptions.RemoveEmptyEntries);
        return "/" + string.Join("/", parts);
    }

    public static string Parent(string path)
    {
        var normalized = Normalize(path);
        var slash = normalized.LastIndexOf('/');
        return slash <= 0 ? "/" : normalized.Substring(0, slash);
    }

    /// <summary>Whether <paramref name="path"/> is <paramref name="directory"/> or anywhere below it.</summary>
    public static bool IsUnder(string path, string directory)
    {
        var dir = Normalize(directory);
        var normalized = Normalize(path);
        return dir == "/"
            || normalized.Equals(dir, StringComparison.Ordinal)
            || normalized.StartsWith(dir + "/", StringComparison.Ordinal);
    }
}
