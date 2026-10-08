import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { afterBuild, type AfterBuildDeps } from './build/afterBuild';
import { AutoBuild } from './build/autoBuild';
import { PROJECT_SETTINGS, SECTION, VIEWER_SETTINGS, readConfig } from './config';
import { DiagnosticsPublisher } from './diagnostics';
import { registerEditing } from './editing/index';
import { HelperClient } from './helper/client';
import { helperCommand, helperSetting } from './helper/locate';
import { LogTap, createLogger, type Logger } from './log';
import { chooseSourceColumn, inverseSearch, syncAfterBuild, syncToPdf } from './navigation';
import { resolveProjectPaths } from './paths';
import { resolveEntry, type EntryMode } from './project/entry';
import { VscodeEntryContext } from './project/entryContext';
import { ProjectManager } from './project/manager';
import { entryForPdf, type PdfEntryContext } from './project/pdfEntry';
import { Project, type BuildOutcome, type ProjectPaths } from './project/project';
import { entryArg, type SettingsSchema } from './sidebar/model';
import { registerSidebar, type SidebarApi } from './sidebar/views';
import { StatusBar } from './statusBar';
import { ViewerManager } from './viewer/manager';
import { Emitter } from './util/emitter';
import { errorText, isFile } from './util/helpers';
import { showWordCount } from './wordCount';

/** What `activate` returns; the integration tests drive the extension through it. */
export interface TypstWorkshopApi {
  projects: ProjectManager;
  viewers: ViewerManager;
  /** The last 500 lines written to the "Typst Workshop" log, oldest first, each as `<level>: <message>`. */
  logLines(): string[];
  /** What the sidebar's views show, and whether they are visible. */
  sidebar: SidebarApi;
}

let current: { projects: ProjectManager } | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<TypstWorkshopApi> {
  const channel = vscode.window.createOutputChannel('Typst Workshop', { log: true });
  context.subscriptions.push(channel);
  const logTap = new LogTap();
  const logger: Logger = createLogger(channel, logTap);

  // Helper binary: the setting (a relative path against the first workspace folder), else TYPST_WORKSHOP_HELPER in extension tests, else <extension>/bin.
  let reportedProblem: string | undefined;
  const helper = () => {
    const folder = vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === 'file')?.uri.fsPath;
    const h = helperCommand(context.extensionPath, helperSetting(readConfig().helperPath, context.extensionMode === vscode.ExtensionMode.Test), folder);
    if (h.problem !== undefined && h.problem !== reportedProblem) logger.error(h.problem);
    reportedProblem = h.problem;
    return h;
  };
  let reportedMissing: string | undefined;
  const preflight = (): string | undefined => {
    const h = helper();
    if (h.exists) {
      reportedMissing = undefined;
      return undefined;
    }
    if (reportedMissing !== h.command) {
      reportedMissing = h.command;
      void vscode.window.showErrorMessage(`Typst Workshop: the helper binary was not found at ${h.command}. Build it with \`npm run build:helper\` in the extension's folder, or set typst-workshop.helperPath.`);
    }
    return `helper binary not found: ${h.command}`;
  };

  const pathsFor = (entry: string): ProjectPaths => {
    const uri = vscode.Uri.file(entry);
    const cfg = readConfig(uri);
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const resolved = resolveProjectPaths(entry, cfg, folder?.uri.scheme === 'file' ? folder.uri.fsPath : undefined, os.tmpdir());
    return { entry, root: resolved.root, pdf: resolved.pdf, fontPaths: resolved.fontPaths, inputs: cfg.inputs };
  };

  const projects = new ProjectManager(
    (entry) =>
      new Project(pathsFor(entry), {
        createClient: () => new HelperClient({ command: helper().command, logger }),
        logger,
        delayMs: () => readConfig(vscode.Uri.file(entry)).autoBuildDelay,
        preflight,
      }),
    logger,
  );
  current = { projects };
  context.subscriptions.push({ dispose: () => void projects.disposeAll() });

  const entryContext = new VscodeEntryContext({ state: context.workspaceState, projects, logger });
  const resolve = (file: string, mode: EntryMode) => resolveEntry(file, mode, entryContext);

  const pdfEntryContext: PdfEntryContext = {
    exists: isFile,
    pdfFor: (entry) => pathsFor(entry).pdf,
    foldersFor: (pdf) => {
      const own = entryContext.workspaceFolderOf(pdf);
      return own !== undefined ? [own] : (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
    },
    includeGraph: (folder) => entryContext.includeGraph(folder),
  };
  const autoBuild = new AutoBuild({
    projects,
    resolveAuto: (file) => resolve(file, 'auto'),
    entryForPdf: (pdf) => entryForPdf(pdf, pdfEntryContext),
    mode: () => readConfig().autoBuildRun,
    logger,
    onTypstFileChanged: (file) => entryContext.invalidate(file),
  });
  context.subscriptions.push(autoBuild);

  /** The entry whose build writes a PDF: the most recently built project's, else (a tab restored after a restart) the entry next to the PDF if it writes there. */
  const entryOfPdf = (pdf: string): string | undefined => {
    const known = projects.byPdf(pdf);
    if (known) return known.entry;
    const entry = pdf.replace(/\.pdf$/i, '.typ');
    return entry !== pdf && fs.existsSync(entry) && pathsFor(entry).pdf === pdf ? entry : undefined;
  };

  /** The project writing a PDF, created for an entry next to the PDF when needed. */
  const projectForPdf = (pdf: string): Project | undefined => {
    const entry = entryOfPdf(pdf);
    return entry === undefined ? undefined : projects.getOrCreate(entry);
  };

  let lastTypstColumn: number | undefined;
  const noteEditor = (editor: vscode.TextEditor | undefined) => {
    if (editor?.document.languageId === 'typst' && editor.viewColumn !== undefined) lastTypstColumn = editor.viewColumn;
  };
  noteEditor(vscode.window.activeTextEditor);

  let statusBar: StatusBar | undefined;
  /** A PDF tab became active or inactive, or opened or closed (the Project view marks the project of a focused PDF tab). */
  const pdfTabChanged = new Emitter<void>((err) => logger.error(`A PDF tab listener failed: ${errorText(err)}`));
  context.subscriptions.push({ dispose: () => pdfTabChanged.dispose() });
  const viewers = new ViewerManager({
    extensionUri: context.extensionUri,
    logger,
    config: () => readConfig().viewer,
    editorGroup: () => readConfig().editorGroup,
    onInverse: (pdf, p, panel) =>
      void inverseSearch(pdf, p, {
        projectFor: projectForPdf,
        column: () => chooseSourceColumn({ lastTypstColumn, visibleColumns: vscode.window.tabGroups.all.map((g) => g.viewColumn), viewerColumn: panel.panel.viewColumn }),
        flash: (m) => statusBar?.flash(m),
        logger,
      }).catch((err) => logger.error(`Jump to the source failed: ${errorText(err)}`)),
    onOpenExternal: (url) => void vscode.env.openExternal(vscode.Uri.parse(url, true)),
    onDidChangeActive: () => {
      statusBar?.refreshVisibility();
      pdfTabChanged.fire();
    },
    onDidRestore: (pdf) => void autoBuild.restoredTab(pdf).catch((err: unknown) => logger.error(`Building the PDF of a restored tab failed: ${errorText(err)}`)),
  });
  const bar = new StatusBar({ isViewerActive: () => viewers.activePdf() !== undefined, wordCountEnabled: () => readConfig().wordCountStatusBar });
  statusBar = bar;
  context.subscriptions.push(viewers, viewers.registerSerializer(), bar);

  const collection = vscode.languages.createDiagnosticCollection('typst');
  const diagnostics = new DiagnosticsPublisher(collection);
  context.subscriptions.push(collection);

  const showBuildFailure = (project: Project, detail: string) => {
    void vscode.window.showErrorMessage(`Typst Workshop: building ${path.basename(project.entry)} failed: ${detail}`, 'Show Problems', 'Show Log').then((choice) => {
      if (choice === 'Show Problems') void vscode.commands.executeCommand('workbench.actions.view.problems');
      else if (choice === 'Show Log') logger.show();
    });
  };

  const afterBuildDeps: AfterBuildDeps = {
    config: (project) => readConfig(vscode.Uri.file(project.entry)),
    status: bar,
    diagnostics,
    viewers,
    showFailure: showBuildFailure,
    syncAfterBuild: (project, cfg) => syncAfterBuild({ project, editor: vscode.window.activeTextEditor, viewers, indicator: () => cfg.viewer.indicator, logger }),
    logger,
  };

  /** The PDF each running build writes, as it was when the build started (settings may change it meanwhile). */
  const buildingPdf = new Map<Project, string>();

  context.subscriptions.push(
    projects.onDidStartBuild(({ project }) => {
      bar.update({ kind: 'building', entry: project.entry });
      buildingPdf.set(project, project.pdf);
      viewers.buildStarted(project.pdf);
    }),
    projects.onDidBuild(({ project, outcome }) => {
      const pdf = buildingPdf.get(project) ?? project.pdf;
      buildingPdf.delete(project);
      void afterBuild(project, outcome, pdf, afterBuildDeps).catch((err) => logger.error(`After the build of ${project.entry}: ${errorText(err)}`));
    }),
    vscode.window.onDidChangeActiveTextEditor(noteEditor),
    vscode.window.onDidChangeTextEditorViewColumn((e) => noteEditor(e.textEditor)),
  );

  const typstEditor = (): vscode.TextEditor | undefined => {
    const editor = vscode.window.activeTextEditor;
    return editor?.document.languageId === 'typst' && editor.document.uri.scheme === 'file' ? editor : undefined;
  };

  /** The project of the active Typst editor (manual entry resolution), the active PDF tab, or a file a project uses. */
  const projectForCommand = async (): Promise<Project | undefined> => {
    const editor = typstEditor();
    if (editor) {
      const entry = await resolve(editor.document.uri.fsPath, 'manual');
      return entry === undefined ? undefined : projects.getOrCreate(entry);
    }
    const pdf = viewers.activePdf();
    if (pdf) {
      const project = projectForPdf(pdf);
      if (!project) void vscode.window.showInformationMessage(`Typst Workshop: no Typst file is known to write ${path.basename(pdf)}; open the entry file and build it.`);
      return project;
    }
    const other = vscode.window.activeTextEditor?.document.uri;
    const known = other?.scheme === 'file' ? projects.mostRecentFor(other.fsPath) : undefined;
    if (!known) void vscode.window.showInformationMessage('Typst Workshop: open a Typst file first.');
    return known;
  };

  /** Saves the dirty documents that are `.typ` files or that the project reads. */
  const saveDirty = async (project: Project): Promise<void> => {
    const dirty = vscode.workspace.textDocuments.filter((d) => d.isDirty && d.uri.scheme === 'file' && (d.uri.fsPath.toLowerCase().endsWith('.typ') || project.dependencies.has(d.uri.fsPath)));
    await Promise.all(dirty.map((d) => d.save()));
  };

  /** Build Project: saves the project's dirty files, then builds now. */
  const buildProject = async (project: Project): Promise<BuildOutcome> => {
    await saveDirty(project);
    return project.buildNow('manual');
  };

  /** View PDF: builds first if the PDF does not exist, then reveals or opens its tab. */
  const viewProject = async (project: Project): Promise<void> => {
    if (!fs.existsSync(project.pdf)) {
      await saveDirty(project);
      await project.buildNow('view');
    }
    if (!fs.existsSync(project.pdf)) {
      void vscode.window.showWarningMessage(`Typst Workshop: ${path.basename(project.pdf)} could not be built; see the Problems panel or the log.`);
      return;
    }
    await viewers.open(project.pdf, { preserveFocus: readConfig().editorGroup === 'right' });
  };

  /** Set Current File as Entry for a file: pinned for its workspace folder (or its own folder outside a workspace). */
  const pinFile = async (file: string): Promise<void> => {
    const folder = await entryContext.pin(file);
    logger.info(`Entry for ${folder}: ${file}`);
    void vscode.window.showInformationMessage(`Typst Workshop: ${path.basename(file)} is now the entry file for ${path.basename(folder)}.`);
  };

  /** Clear Entry Setting for the folder of a file, or for every folder without one. */
  const unpinFile = async (file: string | undefined): Promise<void> => {
    await entryContext.unpin(file);
    logger.info('Cleared the entry setting');
    void vscode.window.showInformationMessage('Typst Workshop: the entry file is detected automatically again.');
  };

  const register = (command: string, run: (...args: unknown[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(command, run));

  register('typst-workshop.build', async () => {
    const project = await projectForCommand();
    return project ? buildProject(project) : undefined;
  });

  register('typst-workshop.view', async () => {
    const project = await projectForCommand();
    if (project) await viewProject(project);
  });

  register('typst-workshop.syncToPdf', () =>
    syncToPdf({
      editor: vscode.window.activeTextEditor,
      projects,
      resolveManual: (file) => resolve(file, 'manual'),
      viewers,
      indicator: () => readConfig().viewer.indicator,
      flash: (m) => bar.flash(m),
      logger,
    }),
  );

  register('typst-workshop.kill', () => {
    projects.stopAll();
    bar.update({ kind: 'stopped' });
    logger.info('Stopped all builds');
  });

  register('typst-workshop.pinEntry', async () => {
    const editor = typstEditor();
    if (!editor) {
      void vscode.window.showInformationMessage('Typst Workshop: open the Typst file to use as the entry first.');
      return;
    }
    await pinFile(editor.document.uri.fsPath);
  });

  register('typst-workshop.unpinEntry', async () => {
    const uri = vscode.window.activeTextEditor?.document.uri;
    await unpinFile(uri?.scheme === 'file' ? uri.fsPath : undefined);
  });

  // The Project view's items and inline buttons name their entry file (a path, or the item itself).
  const forEntry = (run: (entry: string) => unknown) => (arg?: unknown) => {
    const entry = entryArg(arg);
    if (entry === undefined) return undefined;
    if (!isFile(entry)) {
      void vscode.window.showWarningMessage(`Typst Workshop: ${entry} does not exist.`);
      return undefined;
    }
    return run(entry);
  };

  // With an entry file (the word count item of the Project view), the words of that project; otherwise those of the active editor's project.
  const countEntryWords = forEntry((entry) => {
    const project = projects.getOrCreate(entry);
    return showWordCount(project, project.root);
  });
  register('typst-workshop.wordCount', async (arg?: unknown) => {
    if (entryArg(arg) !== undefined) {
      await countEntryWords(arg);
      return;
    }
    const project = await projectForCommand();
    if (project) await showWordCount(project, project.root);
  });

  register('typst-workshop.buildEntry', forEntry((entry) => buildProject(projects.getOrCreate(entry))));
  register('typst-workshop.viewEntry', forEntry((entry) => viewProject(projects.getOrCreate(entry))));
  register('typst-workshop.pinEntryFile', forEntry(pinFile));
  // A pin can outlive its file, so the clear-pin button also works for an entry that was deleted.
  register('typst-workshop.unpinEntryFile', (arg?: unknown) => {
    const entry = entryArg(arg);
    return entry === undefined ? undefined : unpinFile(entry);
  });

  register('typst-workshop.showLog', () => logger.show());

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (PROJECT_SETTINGS.some((s) => e.affectsConfiguration(s))) {
        const mode = readConfig().autoBuildRun;
        logger.info(mode === 'never' ? 'Project settings changed; the helpers stopped and start again at the next build' : 'Project settings changed; the helpers stopped and the projects built before are built again');
        reportedMissing = undefined;
        void projects.reconfigure(pathsFor, mode).catch((err: unknown) => logger.error(`Applying the new project settings failed: ${errorText(err)}`));
      }
      if (VIEWER_SETTINGS.some((s) => e.affectsConfiguration(s))) viewers.pushConfig();
      if (e.affectsConfiguration(`${SECTION}.wordCount.statusBar`)) bar.refreshVisibility();
      if (e.affectsConfiguration(`${SECTION}.diagnostics.enabled`) && !readConfig().diagnosticsEnabled) diagnostics.clearAll();
    }),
  );

  registerEditing(context, () => readConfig(), projects);

  // Builds start only after activation returns (timers, saves, restored tabs, commands), so the Project view registered here sees every build start.
  const manifest = context.extension.packageJSON as { contributes?: { configuration?: { properties?: SettingsSchema } } };
  const sidebar = registerSidebar(context, {
    projects,
    entries: entryContext,
    pdfFor: (entry) => pathsFor(entry).pdf,
    activePdf: () => viewers.activePdf(),
    entryOfPdf,
    onDidChangeActivePdf: pdfTabChanged.event,
    schema: manifest.contributes?.configuration?.properties ?? {},
    extensionId: context.extension.id,
    logger,
  });

  logger.info(`Typst Workshop ${String(context.extension.packageJSON.version ?? '')} started; helper ${helper().command}`);
  void autoBuild.start(vscode.window.activeTextEditor).catch((err: unknown) => logger.error(`The build at start failed: ${errorText(err)}`));
  return { projects, viewers, logLines: () => logTap.lines(), sidebar };
}

/** Shuts the helpers down (each gets `shutdown`, then is killed after 1 s). */
export async function deactivate(): Promise<void> {
  const state = current;
  current = undefined;
  await state?.projects.disposeAll();
}
