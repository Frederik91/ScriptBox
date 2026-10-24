import { writeDeclarations, type DeclaredMethod, type DeclaredNamespace } from '../declarations.ts';
import { DocsTree } from './tree.ts';

export const apiRoot = '/api';

function firstSentence(text: string | undefined): string | undefined {
  if (text === undefined || text.trim().length === 0) {
    return undefined;
  }
  const trimmed = text.trim();
  const match = /\.\s/.exec(trimmed);
  return match === null ? trimmed : trimmed.slice(0, match.index + 1);
}

/**
 * The registered APIs as docs, laid out as the .NET host lays them out: a
 * folder per namespace under /api with a README, the namespace's declarations
 * in index.d.ts, and one .d.ts per function. Built from the same contract the
 * script is checked and called against, so it cannot drift from it.
 */
export function buildApiReference(namespaces: readonly DeclaredNamespace[]): DocsTree {
  const tree = new DocsTree().describeDirectory(apiRoot, 'The functions a script can call, one folder per namespace.');
  for (const ns of namespaces) {
    if (ns.methods.length === 0) {
      continue;
    }
    const folder = `${apiRoot}/${ns.name}`;
    tree.describeDirectory(folder, firstSentence(ns.description) ?? `The ${ns.name} functions.`);
    tree.addFile(`${folder}/README.md`, `What ${ns.name} is for, and its functions one line each.`, () => readme(ns));
    tree.addFile(
      `${folder}/index.d.ts`,
      `Declarations of every ${ns.name} function and the types they use.`,
      () => writeDeclarations([ns]),
    );
    for (const method of ns.methods) {
      tree.addFile(
        `${folder}/${method.descriptor.name}.d.ts`,
        method.descriptor.summary,
        () => writeDeclarations([{ ...ns, methods: [method] }]),
      );
    }
  }
  return tree;
}

function readme(ns: { readonly name: string; readonly description: string | undefined; readonly methods: readonly DeclaredMethod[] }): string {
  const lines = [`# ${ns.name}`, ''];
  if (ns.description !== undefined) {
    lines.push(ns.description, '');
  }
  lines.push('## Functions', '');
  for (const method of ns.methods) {
    lines.push(`- \`${method.descriptor.qualifiedName}\`: ${method.descriptor.summary}`);
  }
  lines.push('', `Read \`${apiRoot}/${ns.name}/index.d.ts\` for every signature, or \`${apiRoot}/${ns.name}/<function>.d.ts\` for one.`, '');
  return lines.join('\n');
}
