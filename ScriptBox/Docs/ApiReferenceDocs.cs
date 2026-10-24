using System.Text;
using System.Threading;
using ScriptBox.Core.Runtime;

namespace ScriptBox.Docs;

/// <summary>
/// The box's own APIs as docs: a folder per namespace under <c>/api</c> with a README, the namespace's
/// TypeScript declarations in <c>index.d.ts</c>, and one <c>.d.ts</c> per function.
/// </summary>
public sealed class ApiReferenceDocs : IDocsSource
{
    public const string Root = "/api";

    private readonly Lazy<DocsTree> _tree;

    public ApiReferenceDocs(IScriptBox box, Func<SandboxApiDescriptor, bool>? include = null)
    {
        if (box is null)
        {
            throw new ArgumentNullException(nameof(box));
        }

        _tree = new Lazy<DocsTree>(() => Build(box, include ?? (_ => true)), LazyThreadSafetyMode.ExecutionAndPublication);
    }

    public Task<IReadOnlyList<DocsEntry>> ListAsync(string directory, CancellationToken cancellationToken) =>
        _tree.Value.ListAsync(directory, cancellationToken);

    public Task<string?> ReadAsync(string path, CancellationToken cancellationToken) => _tree.Value.ReadAsync(path, cancellationToken);

    public Task<IReadOnlyList<DocsMatch>> GrepAsync(DocsGrep grep, CancellationToken cancellationToken) =>
        _tree.Value.GrepAsync(grep, cancellationToken);

    public Task<IReadOnlyList<DocsSearchHit>> SearchAsync(string query, int top, CancellationToken cancellationToken) =>
        _tree.Value.SearchAsync(query, top, cancellationToken);

    private static DocsTree Build(IScriptBox box, Func<SandboxApiDescriptor, bool> include)
    {
        var tree = new DocsTree().DescribeDirectory(Root, "The functions a script can call, one folder per namespace.");
        foreach (var api in box.Apis.Where(include))
        {
            var folder = $"{Root}/{api.JsNamespace}";
            tree.DescribeDirectory(folder, Text.FirstSentence(api.Description) ?? $"The {api.JsNamespace} functions.");
            tree.AddFile($"{folder}/README.md", $"What {api.JsNamespace} is for, and its functions one line each.", () => Readme(api));
            tree.AddFile(
                $"{folder}/index.d.ts",
                $"Declarations of every {api.JsNamespace} function and the types they use.",
                () => box.GetTypeScriptDeclarations(m => m.JsNamespace == api.JsNamespace));

            foreach (var method in api.Methods)
            {
                tree.AddFile(
                    $"{folder}/{method.JsMethodName}.d.ts",
                    method.Summary ?? $"{method.HostMethodName}.",
                    () => box.GetTypeScriptDeclarations(m => m.HostMethodName == method.HostMethodName));
            }
        }

        return tree;
    }

    private static string Readme(SandboxApiDescriptor api)
    {
        var sb = new StringBuilder();
        sb.Append("# ").AppendLine(api.JsNamespace).AppendLine();
        if (api.Description is { } description)
        {
            sb.AppendLine(description).AppendLine();
        }

        sb.AppendLine("## Functions").AppendLine();
        foreach (var method in api.Methods)
        {
            sb.Append("- `").Append(method.HostMethodName).Append("`");
            if (method.Summary is { } summary)
            {
                sb.Append(": ").Append(summary);
            }

            sb.AppendLine();
        }

        sb.AppendLine()
            .Append("Read `").Append(Root).Append('/').Append(api.JsNamespace).Append("/index.d.ts` for every signature, or `")
            .Append(Root).Append('/').Append(api.JsNamespace).AppendLine("/<function>.d.ts` for one.");
        return sb.ToString();
    }
}
