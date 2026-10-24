using System.Text;

namespace ScriptBox.Docs;

/// <summary>
/// The word matching <see cref="DocsTree"/> searches with. It finds names and words, not meanings: a source that
/// should find "export to IFC" from "save as IFC" needs a search of its own.
/// </summary>
public static class DocsSearchScoring
{
    private static readonly HashSet<string> StopWords = new(StringComparer.Ordinal)
    {
        "a", "an", "and", "the", "to", "of", "in", "on", "for", "with", "by", "from", "is", "it", "or", "how", "do", "i",
    };

    /// <summary>The query's words, lower case, with camelCase and snake_case names split into their parts.</summary>
    public static IReadOnlyList<string> Terms(string? text)
    {
        var terms = new List<string>();
        if (text is null)
        {
            return terms;
        }

        var word = new StringBuilder();
        void Flush()
        {
            if (word.Length > 1)
            {
                var term = Stem(word.ToString().ToLowerInvariant());
                if (!StopWords.Contains(term) && !terms.Contains(term))
                {
                    terms.Add(term);
                }
            }

            word.Clear();
        }

        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            if (!char.IsLetterOrDigit(c))
            {
                Flush();
                continue;
            }

            if (char.IsUpper(c) && word.Length > 0 && char.IsLower(text[i - 1]))
            {
                Flush();
            }

            word.Append(c);
        }

        Flush();
        return terms;
    }

    public static double Score(IReadOnlyList<string> terms, string path, string? summary, string content)
    {
        if (terms.Count == 0)
        {
            return 0;
        }

        var pathTerms = Terms(path);
        var summaryTerms = Terms(summary);
        var lowerContent = content.ToLowerInvariant();
        double score = 0;
        foreach (var term in terms)
        {
            if (pathTerms.Contains(term))
            {
                score += 3;
            }

            if (summaryTerms.Contains(term))
            {
                score += 2;
            }

            score += Math.Min(Occurrences(lowerContent, term), 5) * 0.2;
        }

        return Math.Round(score / terms.Count, 3);
    }

    private static string Stem(string term) =>
        term.Length > 3 && term.EndsWith("s", StringComparison.Ordinal) && !term.EndsWith("ss", StringComparison.Ordinal)
            ? term.Substring(0, term.Length - 1)
            : term;

    private static int Occurrences(string text, string term)
    {
        var count = 0;
        for (var i = text.IndexOf(term, StringComparison.Ordinal); i >= 0; i = text.IndexOf(term, i + term.Length, StringComparison.Ordinal))
        {
            count++;
        }

        return count;
    }
}
