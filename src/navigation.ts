import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ForwardResult, InverseParams, SourceLocation } from './helper/protocol';
import type { Logger } from './log';
import { errorText } from './util/helpers';
import type { ProjectManager } from './project/manager';
import type { Project } from './project/project';
import type { ViewerManager } from './viewer/manager';
import type { IndicatorStyle } from './viewer/messages';

export const NO_SOURCE = 'No source found at this point';
export const NO_POSITION = 'No PDF position for the cursor';
const HIGHLIGHT_MS = 600;

/** A file for the log: relative to the project root with `/` as separator, or the absolute path when the file lies outside the root. */
function logPath(file: string, root: string): string {
  const relative = path.relative(root, file);
  const outside = relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  return outside ? file : relative.split(path.sep).join('/');
}

/** The start of the log line of a source → PDF jump, `Show a.typ:4:8 in main.pdf`; line and character are 1-based. */
function showLine(project: Pick<Project, 'root' | 'pdf'>, file: string, position: { line: number; character: number }): string {
  return `Show ${logPath(file, project.root)}:${position.line + 1}:${position.character + 1} in ${path.basename(project.pdf)}`;
}

/** The editor column for a PDF → source jump: the column of the last active Typst editor if it is visible and is not the tab's column, else the first other editor group, else column one. */
export function chooseSourceColumn(a: { lastTypstColumn?: number; visibleColumns: number[]; viewerColumn?: number }): number {
  const visible = [...new Set(a.visibleColumns)].sort((x, y) => x - y);
  if (a.lastTypstColumn !== undefined && visible.includes(a.lastTypstColumn) && a.lastTypstColumn !== a.viewerColumn) return a.lastTypstColumn;
  return visible.find((c) => c !== a.viewerColumn) ?? 1;
}

/** Opens the file with the cursor at the location, reveals the line in the centre if it is outside the viewport, and highlights the whole line for 600 ms. */
export async function revealSource(loc: SourceLocation, column: number): Promise<void> {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(loc.path));
  const editor = await vscode.window.showTextDocument(document, { viewColumn: column, preserveFocus: false });
  const line = Math.min(Math.max(loc.line, 0), Math.max(document.lineCount - 1, 0));
  const character = Math.min(Math.max(loc.character, 0), document.lineAt(line).text.length);
  const position = new vscode.Position(line, character);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  const highlight = vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground') });
  editor.setDecorations(highlight, [new vscode.Range(line, 0, line, 0)]);
  setTimeout(() => highlight.dispose(), HIGHLIGHT_MS);
}

/** The editor parts navigation reads. */
type CursorEditor = Pick<vscode.TextEditor, 'document' | 'selection'>;

function typstFile(editor: CursorEditor | undefined): string | undefined {
  if (!editor || editor.document.languageId !== 'typst' || editor.document.uri.scheme !== 'file') return undefined;
  return editor.document.uri.fsPath;
}

export interface SyncDeps {
  editor: CursorEditor | undefined;
  projects: ProjectManager;
  /** `resolveEntry(file, 'manual')`. */
  resolveManual(file: string): Promise<string | undefined>;
  viewers: Pick<ViewerManager, 'open' | 'forward'>;
  indicator(): IndicatorStyle;
  flash(message: string): void;
  logger: Logger;
}

/** Show Cursor Position in PDF: the project comes from the dependency sets or entry resolution; without a successful build it builds first; the tab opens beside if needed, keeping the focus on the editor. The result is logged: the cursor position and the page shown, or that there is no position. */
export async function syncToPdf(d: SyncDeps): Promise<void> {
  const file = typstFile(d.editor);
  if (file === undefined || !d.editor) return;
  let project = d.projects.mostRecentFor(file);
  if (!project) {
    const entry = await d.resolveManual(file);
    if (entry === undefined) return;
    project = d.projects.getOrCreate(entry);
  }
  if (!(await project.ensureBuilt('show in PDF'))) {
    d.logger.info(`${showLine(project, file, d.editor.selection.active)}: no position`);
    d.flash(NO_POSITION);
    return;
  }
  const cursor = d.editor.selection.active;
  const shown = showLine(project, file, cursor);
  let result: ForwardResult;
  try {
    result = await project.forward({ path: file, line: cursor.line, character: cursor.character });
  } catch (err) {
    d.logger.warn(`Forward lookup failed: ${errorText(err)}`);
    d.logger.info(`${shown}: no position`);
    d.flash(NO_POSITION);
    return;
  }
  if (result.positions.length === 0) {
    d.logger.info(`${shown}: no position`);
    d.flash(NO_POSITION);
    return;
  }
  d.logger.info(`${shown}: page ${result.positions[0].page}`);
  await d.viewers.open(project.pdf, { preserveFocus: true, beside: true });
  d.viewers.forward(project.pdf, result.positions, d.indicator());
}

export interface SyncAfterBuildDeps {
  project: Project;
  editor: CursorEditor | undefined;
  viewers: Pick<ViewerManager, 'isOpen' | 'forward'>;
  indicator(): IndicatorStyle;
  logger: Logger;
}

/** Sync after build: when the active Typst editor belongs to the project and its PDF tab is open, post the cursor position without opening or focusing anything. */
export async function syncAfterBuild(d: SyncAfterBuildDeps): Promise<void> {
  const file = typstFile(d.editor);
  if (file === undefined || !d.editor) return;
  if (file !== d.project.entry && !d.project.dependencies.has(file)) return;
  if (!d.viewers.isOpen(d.project.pdf)) return;
  const cursor = d.editor.selection.active;
  const result = await d.project.forward({ path: file, line: cursor.line, character: cursor.character }).catch((err: unknown) => {
    d.logger.warn(`Forward lookup after the build failed: ${errorText(err)}`);
    return undefined;
  });
  if (result && result.positions.length > 0) d.viewers.forward(d.project.pdf, result.positions, d.indicator());
}

export interface InverseDeps {
  /** The project owning the tab's PDF. */
  projectFor(pdf: string): Project | undefined;
  /** The column to open the source in. */
  column(): number;
  flash(message: string): void;
  logger: Logger;
}

/** PDF → source: the project owning the PDF answers `inverse` and the source opens at that character. Every jump is logged: the PDF page and point, and the source file, line and character (1-based) or that nothing was found. */
export async function inverseSearch(pdf: string, p: InverseParams, d: InverseDeps): Promise<void> {
  const from = `Jump from ${path.basename(pdf)} page ${p.page}`;
  const noSource = (): void => {
    d.logger.info(`${from}: no source at this point`);
    d.flash(NO_SOURCE);
  };
  const project = d.projectFor(pdf);
  if (!project) {
    d.logger.info(`No project writes ${pdf}; build it once to jump from this tab to the source`);
    noSource();
    return;
  }
  if (!(await project.ensureBuilt('inverse'))) {
    noSource();
    return;
  }
  let location: SourceLocation | null;
  try {
    location = await project.inverse(p);
  } catch (err) {
    d.logger.warn(`Inverse lookup failed: ${errorText(err)}`);
    noSource();
    return;
  }
  if (!location) {
    noSource();
    return;
  }
  d.logger.info(`${from} (${Math.round(p.x)}, ${Math.round(p.y)} pt): ${logPath(location.path, project.root)}:${location.line + 1}:${location.character + 1}`);
  await revealSource(location, d.column());
}
