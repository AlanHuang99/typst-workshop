import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { readConfig } from '../config';
import type { Logger } from '../log';
import { Emitter, type Event } from '../util/emitter';
import { errorText, isFile, isInside } from '../util/helpers';
import { entryFolderOf, type EntryContext } from './entry';
import { buildIncludeGraph, type IncludeGraph } from './includeScan';
import type { ProjectManager } from './manager';

export const PINNED_ENTRIES = 'typst-workshop.pinnedEntries';
export const ENTRY_CHOICES = 'typst-workshop.entryChoices';

/** Hidden folders (`.git`, `.cache/copies`, …) and node_modules can hold copies of `.typ` files that must not become entry candidates. */
const EXCLUDE = '{**/node_modules/**,**/.*/**}';
const MAX_FILES = 5000;
/** Folders visited when scanning a folder outside the workspace (which may be large, like the home folder). */
const MAX_FOLDERS = 2000;
const HEAD_BYTES = 16384;

/** Whether a path below the scanned folder passes through a hidden folder or node_modules. */
function inExcludedFolder(folder: string, file: string): boolean {
  const parts = path.relative(folder, file).split(path.sep).slice(0, -1);
  return parts.some((p) => p === 'node_modules' || p.startsWith('.'));
}

function openDocument(file: string): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === file);
}

/** `.typ` files under a folder outside the workspace, skipping hidden folders and node_modules. */
async function walkTypstFiles(folder: string, onUnreadable: (dir: string, err: unknown) => void): Promise<string[]> {
  const files: string[] = [];
  const queue = [folder];
  let visited = 0;
  while (queue.length > 0 && visited < MAX_FOLDERS && files.length < MAX_FILES) {
    const dir = queue.shift()!;
    visited++;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      onUnreadable(dir, err);
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && !e.name.startsWith('.')) queue.push(p);
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.typ')) {
        files.push(p);
      }
    }
  }
  return files;
}

/** Entry resolution backed by VS Code: workspace state, settings, open documents, the projects and the include scan cache. */
export class VscodeEntryContext implements EntryContext {
  private readonly graphs = new Map<string, Promise<IncludeGraph>>();
  private readonly pinEmitter = new Emitter<void>();
  /** Fires after `pin` or `unpin` changed the workspace state. */
  readonly onDidChangePins: Event<void> = this.pinEmitter.event;

  constructor(private readonly o: { state: vscode.Memento; projects: ProjectManager; logger: Logger }) {}

  async readHead(file: string): Promise<string> {
    const document = openDocument(file);
    if (document) return document.getText();
    const handle = await fs.promises.open(file, 'r');
    try {
      const buffer = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  }

  exists(file: string): boolean {
    return isFile(file);
  }

  workspaceFolderOf(file: string): string | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file));
    return folder?.uri.scheme === 'file' ? folder.uri.fsPath : undefined;
  }

  pinnedEntry(folder: string): string | undefined {
    return this.o.state.get<Record<string, string>>(PINNED_ENTRIES, {})[folder];
  }

  settingEntry(file: string): string | undefined {
    const value = readConfig(vscode.Uri.file(file)).mainFile.trim();
    if (value === '') return undefined;
    return path.resolve(this.workspaceFolderOf(file) ?? path.dirname(file), value);
  }

  knownProjectFor(file: string): string | undefined {
    return this.o.projects.mostRecentFor(file)?.entry;
  }

  includeGraph(folder: string): Promise<IncludeGraph> {
    let graph = this.graphs.get(folder);
    if (!graph) {
      graph = this.scan(folder);
      this.graphs.set(folder, graph);
      graph.catch(() => this.graphs.delete(folder));
    }
    return graph;
  }

  rememberedChoice(file: string): string | undefined {
    return this.o.state.get<Record<string, string>>(ENTRY_CHOICES, {})[file];
  }

  remember(file: string, entry: string): void {
    void this.o.state.update(ENTRY_CHOICES, { ...this.o.state.get<Record<string, string>>(ENTRY_CHOICES, {}), [file]: entry });
  }

  async pick(candidates: string[], file: string): Promise<string | undefined> {
    const items = candidates.map((c) => ({ label: path.basename(c), description: vscode.workspace.asRelativePath(c), entry: c }));
    const picked = await vscode.window.showQuickPick(items, { title: `Entry file for ${path.basename(file)}`, placeHolder: 'Several files include this file; choose the one to build' });
    return picked?.entry;
  }

  lastBuiltAmong(candidates: string[]): string | undefined {
    return this.o.projects.lastBuiltAmong(candidates);
  }

  log(message: string): void {
    this.o.logger.info(message);
  }

  /** A `.typ` file was saved, created, changed, deleted or renamed: forget the scans of the folders containing it. */
  invalidate(file: string): void {
    for (const folder of [...this.graphs.keys()]) if (isInside(file, folder)) this.graphs.delete(folder);
  }

  /** Set Current File as Entry: pins the file for its workspace folder (or its own folder outside a workspace). */
  async pin(file: string): Promise<string> {
    const folder = entryFolderOf(file, this);
    await this.o.state.update(PINNED_ENTRIES, { ...this.o.state.get<Record<string, string>>(PINNED_ENTRIES, {}), [folder]: file });
    this.pinEmitter.fire();
    return folder;
  }

  /** Clear Entry Setting: drops the pin and the remembered choices of the file's folder, or all of them without a file. */
  async unpin(file: string | undefined): Promise<void> {
    if (file === undefined) {
      await this.o.state.update(PINNED_ENTRIES, undefined);
      await this.o.state.update(ENTRY_CHOICES, undefined);
      this.pinEmitter.fire();
      return;
    }
    const folder = entryFolderOf(file, this);
    const pinned = { ...this.o.state.get<Record<string, string>>(PINNED_ENTRIES, {}) };
    delete pinned[folder];
    const choices = Object.fromEntries(Object.entries(this.o.state.get<Record<string, string>>(ENTRY_CHOICES, {})).filter(([f]) => !isInside(f, folder)));
    await this.o.state.update(PINNED_ENTRIES, pinned);
    await this.o.state.update(ENTRY_CHOICES, choices);
    this.pinEmitter.fire();
  }

  private async scan(folder: string): Promise<IncludeGraph> {
    const files = await this.typstFiles(folder);
    const sources = new Map<string, string>();
    await Promise.all(
      files.map(async (f) => {
        const document = openDocument(f);
        if (document) {
          sources.set(f, document.getText());
          return;
        }
        try {
          sources.set(f, await fs.promises.readFile(f, 'utf8'));
        } catch (err) {
          this.o.logger.warn(`Cannot read ${f} for the include scan: ${errorText(err)}`);
        }
      }),
    );
    for (const document of vscode.workspace.textDocuments) {
      const f = document.uri.fsPath;
      if (document.uri.scheme === 'file' && f.toLowerCase().endsWith('.typ') && isInside(f, folder) && !inExcludedFolder(folder, f) && !sources.has(f)) sources.set(f, document.getText());
    }
    return buildIncludeGraph(sources, folder, (p) => this.exists(p));
  }

  private async typstFiles(folder: string): Promise<string[]> {
    const workspaceFolder = (vscode.workspace.workspaceFolders ?? []).some((f) => f.uri.scheme === 'file' && f.uri.fsPath === folder);
    if (!workspaceFolder) return walkTypstFiles(folder, (dir, err) => this.o.logger.warn(`Cannot read ${dir} for the include scan: ${errorText(err)}`));
    const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(vscode.Uri.file(folder), '**/*.typ'), EXCLUDE, MAX_FILES);
    return uris.map((u) => u.fsPath).filter((f) => !inExcludedFolder(folder, f));
  }
}
