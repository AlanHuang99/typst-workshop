import * as path from 'node:path';
import * as vscode from 'vscode';
import { SECTION, type WorkshopConfig } from '../config';
import type { ProjectManager } from '../project/manager';
import { isFile } from '../util/helpers';
import { foldingRanges } from './folding';
import { extractPathLiterals } from './links';
import { parseHeadings } from './outline';

export const TINYMIST = 'myriad-dreamin.tinymist';

const SELECTOR: vscode.DocumentSelector = [
  { language: 'typst', scheme: 'file' },
  { language: 'typst', scheme: 'untitled' },
];

/** Headings in the Outline view, nested by level, each spanning its section. */
function documentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
  const roots: vscode.DocumentSymbol[] = [];
  const stack: { level: number; symbol: vscode.DocumentSymbol }[] = [];
  const lastLine = document.lineCount - 1;
  for (const h of parseHeadings(document.getText())) {
    const endLine = Math.min(h.endLine, lastLine);
    const range = new vscode.Range(h.line, 0, endLine, document.lineAt(endLine).text.length);
    const selection = new vscode.Range(h.line, 0, h.line, document.lineAt(h.line).text.length);
    const symbol = new vscode.DocumentSymbol(h.title || '(untitled)', '', vscode.SymbolKind.String, range, selection);
    while (stack.length > 0 && stack[stack.length - 1].level >= h.level) stack.pop();
    if (stack.length > 0) stack[stack.length - 1].symbol.children.push(symbol);
    else roots.push(symbol);
    stack.push({ level: h.level, symbol });
  }
  return roots;
}

function folding(document: vscode.TextDocument): vscode.FoldingRange[] {
  return foldingRanges(document.getText()).map((r) => new vscode.FoldingRange(r.start, r.end, r.kind === 'comment' ? vscode.FoldingRangeKind.Comment : undefined));
}

/** Clickable paths that exist; a leading `/` resolves against the project root if known, else the workspace folder. */
function links(document: vscode.TextDocument, projects: ProjectManager): vscode.DocumentLink[] {
  if (document.uri.scheme !== 'file') return [];
  const file = document.uri.fsPath;
  const dir = path.dirname(file);
  const absoluteBase = projects.mostRecentFor(file)?.root ?? vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? dir;
  const result: vscode.DocumentLink[] = [];
  for (const literal of extractPathLiterals(document.getText())) {
    const target = literal.value.startsWith('/') ? path.join(absoluteBase, literal.value) : path.resolve(dir, literal.value);
    if (!isFile(target)) continue;
    result.push(new vscode.DocumentLink(new vscode.Range(literal.line, literal.start, literal.line, literal.end), vscode.Uri.file(target)));
  }
  return result;
}

/** Registers the editing basics when `typst-workshop.editing.enabled` is `on`, or `auto` and Tinymist is not installed; re-evaluated when extensions or the setting change. The returned disposable is also added to the context. */
export function registerEditing(context: vscode.ExtensionContext, cfg: () => WorkshopConfig, projects: ProjectManager): vscode.Disposable {
  let providers: vscode.Disposable[] | undefined;
  const wanted = () => {
    const mode = cfg().editingEnabled;
    return mode === 'on' || (mode === 'auto' && vscode.extensions.getExtension(TINYMIST) === undefined);
  };
  const update = () => {
    const on = wanted();
    if (on && !providers) {
      providers = [
        vscode.languages.registerDocumentSymbolProvider(SELECTOR, { provideDocumentSymbols: documentSymbols }, { label: 'Typst headings' }),
        vscode.languages.registerFoldingRangeProvider(SELECTOR, { provideFoldingRanges: folding }),
        vscode.languages.registerDocumentLinkProvider(SELECTOR, { provideDocumentLinks: (document) => links(document, projects) }),
      ];
    } else if (!on && providers) {
      for (const p of providers) p.dispose();
      providers = undefined;
    }
  };
  update();
  const listeners = [
    vscode.extensions.onDidChange(update),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${SECTION}.editing.enabled`)) update();
    }),
  ];
  const disposable = new vscode.Disposable(() => {
    for (const l of listeners) l.dispose();
    listeners.length = 0;
    for (const p of providers ?? []) p.dispose();
    providers = undefined;
  });
  context.subscriptions.push(disposable);
  return disposable;
}
