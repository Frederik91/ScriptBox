// The TypeScript compiler worker. It checks a submitted script against the
// generated declarations and emits JavaScript, with a fixed configuration and
// no access to anything but the files below: the script, the declarations, the
// guest's globals and TypeScript's own lib files. The parent terminates this
// worker when a compile overruns its time, and V8 stops it at its heap limit.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { parentPort } from 'node:worker_threads';
import ts from 'typescript';
import {
  readCompileRequest,
  typeScriptPrefix,
  typeScriptSuffix,
  type CompileDiagnostic,
  type CompileResponse,
} from './compile-protocol.ts';

// Nothing here writes output: the parent does not pipe this worker's stdio.
for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
  console[level] = () => undefined;
}

const scriptFile = '/script.ts';
const declarationsFile = '/scriptbox-api.d.ts';
const globalsFile = '/scriptbox-globals.d.ts';
const libDirectory = '/lib';
const maxDiagnostics = 20;
const maxMessageLength = 1000;

/** What a script can use besides the registered APIs: the language and console. */
const guestGlobals = `/** Writes to the execution's log, which the host returns with the result. */
interface Console {
  log(...data: unknown[]): void;
  debug(...data: unknown[]): void;
  info(...data: unknown[]): void;
  warn(...data: unknown[]): void;
  error(...data: unknown[]): void;
}
declare const console: Console;
`;

const options: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.ESNext,
  moduleDetection: ts.ModuleDetectionKind.Legacy,
  lib: ['lib.es2023.d.ts'],
  types: [],
  strict: true,
  noEmitOnError: true,
  noResolve: true,
  skipLibCheck: true,
  sourceMap: true,
  inlineSources: false,
  removeComments: false,
  allowJs: false,
  experimentalDecorators: false,
  emitDecoratorMetadata: false,
  noImplicitReturns: false,
  newLine: ts.NewLineKind.LineFeed,
  rootDir: '/',
  outDir: '/',
};

const libSource = dirname(createRequire(import.meta.url).resolve('typescript'));
const libCache = new Map<string, ts.SourceFile>();
let declarationsCache: { key: string; file: ts.SourceFile } | undefined;
const globalsSourceFile = ts.createSourceFile(globalsFile, guestGlobals, ts.ScriptTarget.ES2023, true);

function libFile(fileName: string): ts.SourceFile | undefined {
  if (!fileName.startsWith(`${libDirectory}/`)) {
    return undefined;
  }
  const name = fileName.slice(libDirectory.length + 1);
  // Only TypeScript's own lib files, by name; nothing else on disk is readable.
  if (!/^lib(\.[a-z0-9]+)*\.d\.ts$/.test(name)) {
    return undefined;
  }
  const cached = libCache.get(name);
  if (cached !== undefined) {
    return cached;
  }
  let text: string;
  try {
    text = readFileSync(join(libSource, name), 'utf8');
  } catch {
    return undefined;
  }
  const file = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2023, true);
  libCache.set(name, file);
  return file;
}

function userPosition(file: ts.SourceFile, position: number): { line: number; column: number } {
  const { line, character } = file.getLineAndCharacterOfPosition(position);
  const lastUserLine = file.getLineAndCharacterOfPosition(file.text.length - typeScriptSuffix.length).line;
  return { line: Math.min(Math.max(line, 1), Math.max(lastUserLine, 1)), column: line === 0 ? 1 : character + 1 };
}

function toDiagnostic(file: ts.SourceFile, diagnostic: ts.Diagnostic): CompileDiagnostic {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n').slice(0, maxMessageLength);
  if (diagnostic.file?.fileName !== scriptFile || diagnostic.start === undefined) {
    return { message, line: 1, column: 1, code: diagnostic.code };
  }
  return { ...userPosition(file, diagnostic.start), message, code: diagnostic.code };
}

function forbidden(file: ts.SourceFile, node: ts.Node, message: string): CompileDiagnostic {
  return { ...userPosition(file, node.getStart(file)), message, code: 0 };
}

/** Constructs a script may not use, whatever the type checker would say about them. */
function findForbidden(file: ts.SourceFile, source: string): CompileDiagnostic[] {
  const found: CompileDiagnostic[] = [];
  const visit = (node: ts.Node): void => {
    if (found.length >= maxDiagnostics) {
      return;
    }
    const exported = ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false);
    if (exported || ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) || ts.isExportDeclaration(node) || ts.isExportAssignment(node)) {
      found.push(forbidden(file, node, 'Scripts cannot import or export. Use the registered APIs, which are already in scope.'));
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      found.push(forbidden(file, node, 'Scripts cannot load modules with import().'));
    } else if (ts.isImportTypeNode(node)) {
      found.push(forbidden(file, node, 'Scripts cannot refer to module types with import("...").'));
    } else if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
      found.push(forbidden(file, node, 'Scripts cannot use import.meta.'));
    } else if (ts.isDecorator(node)) {
      found.push(forbidden(file, node, 'Scripts cannot use decorators.'));
    } else if (ts.isModuleDeclaration(node)) {
      found.push(forbidden(file, node, 'Scripts cannot declare modules or namespaces.'));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  // Comments that would switch checking off or pull in other files.
  const scanner = ts.createScanner(ts.ScriptTarget.ES2023, false, ts.LanguageVariant.Standard, source);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken && found.length < maxDiagnostics; token = scanner.scan()) {
    if (token !== ts.SyntaxKind.SingleLineCommentTrivia && token !== ts.SyntaxKind.MultiLineCommentTrivia) {
      continue;
    }
    const text = scanner.getTokenText();
    const position = scanner.getTokenStart() + typeScriptPrefix.length;
    if (/@ts-(nocheck|ignore|expect-error)\b/.test(text)) {
      found.push({ ...userPosition(file, position), message: 'Scripts cannot turn type checking off with @ts- comments.', code: 0 });
    } else if (/^\/\/\/\s*<\s*(reference|amd-module|amd-dependency)\b/.test(text)) {
      found.push({ ...userPosition(file, position), message: 'Scripts cannot use triple-slash directives.', code: 0 });
    }
  }
  return found;
}

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

function compile(source: string, declarations: string, declarationsKey: string): WithoutId<CompileResponse> {
  const wrapped = typeScriptPrefix + source + typeScriptSuffix;
  const scriptSourceFile = ts.createSourceFile(scriptFile, wrapped, ts.ScriptTarget.ES2023, true);

  const forbiddenFound = findForbidden(scriptSourceFile, source);
  if (forbiddenFound.length > 0) {
    return { t: 'rejected', category: 'invalid-source', diagnostics: forbiddenFound };
  }

  if (declarationsCache?.key !== declarationsKey) {
    declarationsCache = { key: declarationsKey, file: ts.createSourceFile(declarationsFile, declarations, ts.ScriptTarget.ES2023, true) };
  }
  const declarationsSourceFile = declarationsCache.file;

  const outputs = new Map<string, string>();
  const host: ts.CompilerHost = {
    getSourceFile: (fileName) => {
      switch (fileName) {
        case scriptFile:
          return scriptSourceFile;
        case declarationsFile:
          return declarationsSourceFile;
        case globalsFile:
          return globalsSourceFile;
        default:
          return libFile(fileName);
      }
    },
    getDefaultLibFileName: () => `${libDirectory}/lib.d.ts`,
    getDefaultLibLocation: () => libDirectory,
    writeFile: (fileName, text) => {
      outputs.set(fileName, text);
    },
    getCurrentDirectory: () => '/',
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (fileName) => fileName === scriptFile || fileName === declarationsFile || fileName === globalsFile || libFile(fileName) !== undefined,
    readFile: () => undefined,
    directoryExists: () => false,
    getDirectories: () => [],
    realpath: (fileName) => fileName,
  };

  const program = ts.createProgram({ rootNames: [scriptFile, declarationsFile, globalsFile], options, host });

  const syntactic = program.getSyntacticDiagnostics(scriptSourceFile);
  if (syntactic.length > 0) {
    return { t: 'rejected', category: 'invalid-source', diagnostics: syntactic.slice(0, maxDiagnostics).map((d) => toDiagnostic(scriptSourceFile, d)) };
  }

  const configuration = [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()];
  if (configuration.length > 0) {
    const first = configuration[0];
    return { t: 'failed', message: `The TypeScript configuration is invalid: ${first === undefined ? '' : ts.flattenDiagnosticMessageText(first.messageText, ' ')}` };
  }

  const declarationErrors = program.getSemanticDiagnostics(declarationsSourceFile);
  if (declarationErrors.length > 0) {
    const first = declarationErrors[0];
    return { t: 'failed', message: `The generated declarations do not compile: ${first === undefined ? '' : ts.flattenDiagnosticMessageText(first.messageText, ' ')}` };
  }

  const semantic = program.getSemanticDiagnostics(scriptSourceFile);
  if (semantic.length > 0) {
    return { t: 'rejected', category: 'type-check', diagnostics: semantic.slice(0, maxDiagnostics).map((d) => toDiagnostic(scriptSourceFile, d)) };
  }

  const emitted = program.emit(scriptSourceFile);
  const js = outputs.get('/script.js');
  const map = outputs.get('/script.js.map');
  if (emitted.emitSkipped || js === undefined || map === undefined) {
    return { t: 'failed', message: 'TypeScript produced no output.' };
  }
  // The emit ends with a pointer to the map file, which the guest has no use for.
  return { t: 'compiled', js: js.replace(/\n\/\/# sourceMappingURL=.*\n?$/, '\n'), map };
}

const port = parentPort;
if (port === null) {
  throw new Error('The compiler worker must run as a worker thread.');
}

port.on('message', (raw: unknown) => {
  const request = readCompileRequest(raw);
  if (request === undefined) {
    return;
  }
  let response: CompileResponse;
  try {
    response = { ...compile(request.source, request.declarations, request.declarationsKey), id: request.id };
  } catch (error) {
    response = { t: 'failed', id: request.id, message: error instanceof Error ? error.message : 'The compiler failed.' };
  }
  port.postMessage(response);
});
