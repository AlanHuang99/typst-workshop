import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Logger } from '../log';
import type { ProjectManager } from '../project/manager';
import { errorText, isInside } from '../util/helpers';

export type AutoBuildRun = 'never' | 'onSave' | 'onFileChange';

export interface AutoBuildDeps {
  projects: ProjectManager;
  /** `resolveEntry(file, 'auto')`. */
  resolveAuto(file: string): Promise<string | undefined>;
  /** The entry file whose build writes a PDF (`entryForPdf`), for a restored PDF tab. */
  entryForPdf(pdf: string): Promise<string | undefined>;
  /** `typst-workshop.autoBuild.run`, read at each event. */
  mode(): AutoBuildRun;
  logger: Logger;
  /** A `.typ` file was saved, created, changed on disk, deleted or renamed: the include scan of its folder is stale. */
  onTypstFileChanged(file: string): void;
}

/** How long after a save in VS Code a watcher `change` event of the same, unmodified file counts as the echo of that save. */
const SAVE_ECHO_MS = 5000;

interface FileStamp {
  mtimeMs: number;
  size: number;
}

function stampOf(file: string): FileStamp | undefined {
  try {
    const s = fs.statSync(file);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return undefined;
  }
}

function isTypst(file: string): boolean {
  return file.toLowerCase().endsWith('.typ');
}

/** Whether a path below `folder` passes through a hidden folder or node_modules, which the include scan leaves out. */
function inExcludedFolder(folder: string, file: string): boolean {
  const parts = path.relative(folder, file).split(path.sep).slice(0, -1);
  return parts.some((p) => p === 'node_modules' || p.startsWith('.'));
}

/** Automatic build triggers: saves in VS Code, and in `onFileChange` mode changes on disk to any file a project read, through one watcher per workspace folder plus watchers for dependency folders outside the workspace. After a window reload, when no project exists yet, the active Typst editor at activation, a restored PDF tab and (in `onFileChange` mode) a Typst file changed on disk each lead to their project. */
export class AutoBuild implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly folderWatchers = new Map<string, vscode.FileSystemWatcher>();
  private readonly externalWatchers = new Map<string, vscode.FileSystemWatcher>();
  private readonly recentSaves = new Map<string, FileStamp & { at: number }>();
  private disposed = false;

  constructor(private readonly deps: AutoBuildDeps) {
    this.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument((doc) => void this.onSave(doc.uri)),
      vscode.workspace.onDidRenameFiles((e) => {
        for (const f of e.files) {
          this.noteTypst(f.oldUri);
          this.noteTypst(f.newUri);
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.refreshFolderWatchers();
        this.refreshExternalWatchers();
      }),
      deps.projects.onDidBuild(() => this.refreshExternalWatchers()),
    );
    this.refreshFolderWatchers();
  }

  /** Watches the folders of dependencies that lie outside every workspace folder (called after each build). */
  refreshExternalWatchers(): void {
    if (this.disposed) return;
    const workspace = this.workspaceFolders();
    const needed = new Set<string>();
    for (const project of this.deps.projects.all()) {
      for (const file of [project.entry, ...project.dependencies]) {
        if (!isInside(file, workspace)) needed.add(path.dirname(file));
      }
    }
    for (const [folder, watcher] of this.externalWatchers) {
      if (!needed.has(folder)) {
        watcher.dispose();
        this.externalWatchers.delete(folder);
      }
    }
    for (const folder of needed) {
      if (this.externalWatchers.has(folder)) continue;
      this.externalWatchers.set(folder, this.watch(new vscode.RelativePattern(vscode.Uri.file(folder), '*')));
      this.deps.logger.info(`Watching ${folder} (outside the workspace)`);
    }
  }

  /** On activation: the project of the active Typst editor builds once, unless `autoBuild.run` is `never`. */
  async start(editor: Pick<vscode.TextEditor, 'document'> | undefined): Promise<void> {
    const document = editor?.document;
    if (this.disposed || !document || document.uri.scheme !== 'file' || document.languageId !== 'typst' || this.deps.mode() === 'never') return;
    await this.buildUsersOf(document.uri.fsPath, 'start');
  }

  /** A PDF tab that VS Code restored: the project writing its PDF builds once, unless `autoBuild.run` is `never`. */
  async restoredTab(pdf: string): Promise<void> {
    if (this.disposed || this.deps.mode() === 'never') return;
    const known = this.deps.projects.byPdf(pdf);
    if (known) {
      known.requestAuto('restored tab');
      return;
    }
    let entry: string | undefined;
    try {
      entry = await this.deps.entryForPdf(pdf);
    } catch (err) {
      this.deps.logger.error(`Cannot find the Typst file that writes ${pdf}: ${errorText(err)}`);
      return;
    }
    if (this.disposed) return;
    if (entry === undefined) {
      this.deps.logger.info(`No Typst file is known to write ${pdf}; the restored tab shows it as it is on disk`);
      return;
    }
    this.deps.projects.getOrCreate(entry).requestAuto('restored tab');
  }

  dispose(): void {
    this.disposed = true;
    for (const s of this.subscriptions) s.dispose();
    this.subscriptions.length = 0;
    for (const w of [...this.folderWatchers.values(), ...this.externalWatchers.values()]) w.dispose();
    this.folderWatchers.clear();
    this.externalWatchers.clear();
  }

  private workspaceFolders(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
  }

  private refreshFolderWatchers(): void {
    if (this.disposed) return;
    const folders = new Set(this.workspaceFolders());
    for (const [folder, watcher] of this.folderWatchers) {
      if (!folders.has(folder)) {
        watcher.dispose();
        this.folderWatchers.delete(folder);
      }
    }
    for (const folder of folders) {
      if (!this.folderWatchers.has(folder)) this.folderWatchers.set(folder, this.watch(new vscode.RelativePattern(vscode.Uri.file(folder), '**/*')));
    }
  }

  private watch(pattern: vscode.RelativePattern): vscode.FileSystemWatcher {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    watcher.onDidChange((uri) => this.onFileEvent('change', uri));
    watcher.onDidCreate((uri) => this.onFileEvent('create', uri));
    watcher.onDidDelete((uri) => this.onFileEvent('delete', uri));
    return watcher;
  }

  private noteTypst(uri: vscode.Uri): void {
    if (uri.scheme === 'file' && isTypst(uri.fsPath)) this.deps.onTypstFileChanged(uri.fsPath);
  }

  private async onSave(uri: vscode.Uri): Promise<void> {
    if (this.disposed || uri.scheme !== 'file') return;
    const file = uri.fsPath;
    this.noteTypst(uri);
    if (this.deps.mode() === 'never') return;
    const now = Date.now();
    for (const [saved, record] of this.recentSaves) if (now - record.at > SAVE_ECHO_MS) this.recentSaves.delete(saved);
    const stamp = stampOf(file);
    if (stamp) this.recentSaves.set(file, { ...stamp, at: now });
    else this.recentSaves.delete(file);
    await this.buildUsersOf(file, 'save');
  }

  /** Requests a build of every project that uses the file; a Typst file that no project uses is resolved to its entry. */
  private async buildUsersOf(file: string, trigger: string): Promise<void> {
    const projects = this.deps.projects.projectsContaining(file);
    if (projects.length > 0) {
      for (const project of projects) project.requestAuto(trigger);
      return;
    }
    if (isTypst(file)) await this.buildEntryOf(file, trigger);
  }

  /** Resolves the entry of a Typst file (auto mode) and requests its build. */
  private async buildEntryOf(file: string, trigger: string): Promise<void> {
    let entry: string | undefined;
    try {
      entry = await this.deps.resolveAuto(file);
    } catch (err) {
      this.deps.logger.error(`Cannot find the entry file for ${file}: ${errorText(err)}`);
      return;
    }
    if (entry !== undefined && !this.disposed) this.deps.projects.getOrCreate(entry).requestAuto(trigger);
  }

  private onFileEvent(kind: 'change' | 'create' | 'delete', uri: vscode.Uri): void {
    if (this.disposed || uri.scheme !== 'file') return;
    const file = uri.fsPath;
    this.noteTypst(uri);
    if (this.deps.mode() !== 'onFileChange') return;
    if (kind === 'change' && this.isSaveEcho(file)) return;
    const projects = this.deps.projects.projectsContaining(file);
    for (const project of projects) {
      if (project.pdf !== file) project.requestAuto('file change');
    }
    // A Typst file that no project uses yet (after a window reload, before any build) is resolved like a save; not a deleted file, nor copies in hidden folders and node_modules, which the include scan leaves out.
    if (projects.length === 0 && kind !== 'delete' && isTypst(file) && !this.inExcludedWorkspaceFolder(file)) void this.buildEntryOf(file, 'file change');
  }

  /** Whether the file lies in a hidden folder or node_modules of its workspace folder. */
  private inExcludedWorkspaceFolder(file: string): boolean {
    const folder = this.workspaceFolders().find((f) => isInside(file, f));
    return folder !== undefined && inExcludedFolder(folder, file);
  }

  /** The file is as VS Code saved it moments ago: the save already requested the build. */
  private isSaveEcho(file: string): boolean {
    const saved = this.recentSaves.get(file);
    if (saved === undefined) return false;
    if (Date.now() - saved.at > SAVE_ECHO_MS) {
      this.recentSaves.delete(file);
      return false;
    }
    const now = stampOf(file);
    return now !== undefined && now.mtimeMs === saved.mtimeMs && now.size === saved.size;
  }
}
