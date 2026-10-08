// The sidebar's tree views on top of `model.ts`, and the commands of the Settings view.
import * as vscode from 'vscode';
import { SECTION } from '../config';
import type { Logger } from '../log';
import { decideEntry, entryFolderOf, type EntryContext } from '../project/entry';
import type { ProjectManager } from '../project/manager';
import type { Project } from '../project/project';
import { statusAfterBuild, type BuildStatus } from '../statusText';
import type { Event } from '../util/emitter';
import { errorText, isFile } from '../util/helpers';
import {
  OPEN_FILE,
  SIDEBAR_SETTINGS,
  commandNodes,
  projectNodes,
  settingArg,
  settingChoices,
  settingDescription,
  settingInput,
  settingInputProblem,
  settingInputValue,
  settingLabel,
  settingNodes,
  settingValueProblem,
  writeTarget,
  type ConfigLevel,
  type ProjectSummary,
  type ProjectViewState,
  type SettingsSchema,
  type SidebarNode,
} from './model';

export const PROJECT_VIEW = 'typst-workshop.project';
export const COMMANDS_VIEW = 'typst-workshop.commands';
export const SETTINGS_VIEW = 'typst-workshop.settings';

export interface SidebarDeps {
  projects: ProjectManager;
  /** Entry resolution (the view decides in `auto` mode, so it never opens a Quick Pick) and the pins. */
  entries: EntryContext & { onDidChangePins: Event<void> };
  /** The PDF an entry's build writes with the current settings, for an entry that has no project yet. */
  pdfFor(entry: string): string;
  /** The PDF of the focused PDF tab, if a PDF tab is the active editor. */
  activePdf(): string | undefined;
  /** The entry whose build writes a PDF, without creating a project for it. */
  entryOfPdf(pdf: string): string | undefined;
  /** Fires when a PDF tab becomes active or inactive, or opens or closes. */
  onDidChangeActivePdf: Event<void>;
  /** `contributes.configuration.properties` of the manifest. */
  schema: SettingsSchema;
  /** The extension's id, which filters the Settings editor. */
  extensionId: string;
  logger: Logger;
  /** How long a refresh waits for further changes, so that a build's end and its word count refresh the view once; default 100 ms. */
  refreshDelayMs?: number;
}

/** What the extension-host tests read through the extension's API. */
export interface SidebarApi {
  /** The root items the Project view last gave VS Code (children nested in them): what the view shows. */
  project(): SidebarNode[];
  commands(): SidebarNode[];
  settings(): SidebarNode[];
  visible(): { project: boolean; commands: boolean; settings: boolean };
}

const TARGETS: Record<ConfigLevel, vscode.ConfigurationTarget> = {
  workspaceFolder: vscode.ConfigurationTarget.WorkspaceFolder,
  workspace: vscode.ConfigurationTarget.Workspace,
  user: vscode.ConfigurationTarget.Global,
};

/** A tree item for a node; `vscode.open` gets its file path as a URI. */
export function treeItem(node: SidebarNode): vscode.TreeItem {
  const state = node.children && node.children.length > 0 ? (node.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed) : vscode.TreeItemCollapsibleState.None;
  const item = new vscode.TreeItem(node.label, state);
  item.id = node.id;
  if (node.description !== undefined) item.description = node.description;
  if (node.tooltip !== undefined) item.tooltip = node.tooltip;
  if (node.icon !== undefined) item.iconPath = new vscode.ThemeIcon(node.icon);
  if (node.contextValue !== undefined) item.contextValue = node.contextValue;
  if (node.command) {
    const args = node.command.id === OPEN_FILE ? node.command.args?.map((a) => (typeof a === 'string' ? vscode.Uri.file(a) : a)) : node.command.args;
    item.command = { command: node.command.id, title: node.command.title, arguments: args };
  }
  return item;
}

/** A view's items: computed when VS Code asks for them, and asked for again after a refresh. */
class NodeProvider implements vscode.TreeDataProvider<SidebarNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  /** The root items last given to VS Code. */
  shown: SidebarNode[] = [];
  private requests = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly roots: () => SidebarNode[] | Promise<SidebarNode[]>,
    private readonly delayMs: number,
  ) {}

  getTreeItem(node: SidebarNode): vscode.TreeItem {
    return treeItem(node);
  }

  async getChildren(node?: SidebarNode): Promise<SidebarNode[]> {
    if (node) return node.children ?? [];
    const request = ++this.requests;
    const roots = await this.roots();
    if (request === this.requests) this.shown = roots;
    return roots;
  }

  /** Asks VS Code for the items again once the quiet period has passed; requests during it are merged, and the items are computed when VS Code asks. */
  refresh(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.changed.fire();
    }, this.delayMs);
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.changed.dispose();
  }
}

function activeTypstFile(): string | undefined {
  const document = vscode.window.activeTextEditor?.document;
  return document?.languageId === 'typst' && document.uri.scheme === 'file' ? document.uri.fsPath : undefined;
}

/** The resource the settings are read and written for: the active editor's file, else the first workspace folder. */
function configScope(): vscode.Uri | undefined {
  const uri = vscode.window.activeTextEditor?.document.uri;
  if (uri?.scheme === 'file') return uri;
  return vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === 'file')?.uri;
}

/** Registers the Project, Commands and Settings views and the commands Change Setting and Open Settings; everything is disposed with the extension. */
export function registerSidebar(context: vscode.ExtensionContext, deps: SidebarDeps): SidebarApi {
  const delay = deps.refreshDelayMs ?? 100;
  /** Projects whose build has started and not yet ended (a project still reports itself as building while its end is being announced). */
  const running = new Set<Project>();

  const summary = (entry: string, project: Project | undefined): ProjectSummary => {
    const pdf = project?.pdf ?? deps.pdfFor(entry);
    let status: BuildStatus = { kind: 'idle' };
    if (project && running.has(project)) status = { kind: 'building', entry };
    else if (project?.lastOutcome) status = statusAfterBuild(entry, project.lastOutcome);
    const s: ProjectSummary = { entry, pdf, pdfExists: isFile(pdf), status, pinned: deps.entries.pinnedEntry(entryFolderOf(entry, deps.entries)) === entry };
    if (project?.lastWordCount) s.words = { result: project.lastWordCount, root: project.root };
    return s;
  };

  const projectState = async (): Promise<ProjectViewState> => {
    const built = deps.projects.all().filter((p) => p.lastOutcome !== undefined || running.has(p));
    built.sort((a, b) => (a.entry < b.entry ? -1 : a.entry > b.entry ? 1 : 0));
    const known = built.map((p) => summary(p.entry, p));
    const file = activeTypstFile();
    if (file === undefined) {
      const pdf = deps.activePdf();
      const entry = pdf === undefined ? undefined : deps.entryOfPdf(pdf);
      return pdf !== undefined && entry !== undefined ? { activePdf: { pdf, project: summary(entry, deps.projects.get(entry)) }, known } : { known };
    }
    try {
      const d = await decideEntry(file, 'auto', deps.entries);
      return { active: { file, rule: d.rule, project: d.entry === undefined ? undefined : summary(d.entry, deps.projects.get(d.entry)) }, known };
    } catch (err) {
      deps.logger.error(`The Project view could not find the entry file of ${file}: ${errorText(err)}`);
      return { known };
    }
  };

  const settingRoots = (): SidebarNode[] => {
    const config = vscode.workspace.getConfiguration(SECTION, configScope());
    const values: Record<string, unknown> = {};
    for (const key of SIDEBAR_SETTINGS) values[key] = config.get(key);
    return settingNodes(values, deps.schema);
  };

  const project = new NodeProvider(async () => projectNodes(await projectState()), delay);
  const commands = new NodeProvider(commandNodes, delay);
  const settings = new NodeProvider(settingRoots, delay);
  const views = {
    project: vscode.window.createTreeView(PROJECT_VIEW, { treeDataProvider: project }),
    commands: vscode.window.createTreeView(COMMANDS_VIEW, { treeDataProvider: commands }),
    settings: vscode.window.createTreeView(SETTINGS_VIEW, { treeDataProvider: settings }),
  };

  /** Change Setting refuses: a warning in the log next to the popup. */
  const refuse = (problem: string): void => {
    deps.logger.warn(problem);
    void vscode.window.showErrorMessage(`Typst Workshop: ${problem}.`);
  };

  /** Change Setting, for the settings the view lists: the Quick Pick of the allowed values (or the value passed to the command), written at the level where the setting is defined now. */
  const changeSetting = async (key: string, given?: unknown): Promise<void> => {
    const full = `${SECTION}.${key}`;
    const problem = !(SIDEBAR_SETTINGS as readonly string[]).includes(key) ? `${full} is not one of the settings in the sidebar` : given === undefined ? undefined : settingValueProblem(deps.schema, key, given);
    if (problem !== undefined) return refuse(problem);
    const config = vscode.workspace.getConfiguration(SECTION, configScope());
    const current = config.get(key);
    let value: unknown = given;
    if (given === undefined) {
      const title = settingLabel(key);
      const description = settingDescription(deps.schema, key);
      const picked = await vscode.window.showQuickPick(settingChoices(deps.schema, key, current), { title, placeHolder: description });
      if (!picked) return;
      if (picked.other) {
        const input = settingInput(deps.schema, key, current);
        const text = await vscode.window.showInputBox({ title, prompt: input.prompt, value: input.value, validateInput: (t) => settingInputProblem(deps.schema, key, t) });
        if (text === undefined) return;
        value = settingInputValue(key, text);
      } else {
        value = picked.value;
      }
    }
    if (value === current) return;
    const level = writeTarget(config.inspect(key), deps.schema[full]?.scope);
    try {
      await config.update(key, value, TARGETS[level]);
      deps.logger.info(`Set ${full} to ${JSON.stringify(value)} in the ${level === 'workspaceFolder' ? 'folder' : level} settings`);
    } catch (err) {
      deps.logger.error(`Cannot change ${full}: ${errorText(err)}`);
      void vscode.window.showErrorMessage(`Typst Workshop: cannot change ${full}: ${errorText(err)}`);
    }
  };

  context.subscriptions.push(
    project,
    commands,
    settings,
    views.project,
    views.commands,
    views.settings,
    vscode.window.onDidChangeActiveTextEditor(() => project.refresh()),
    deps.projects.onDidStartBuild(({ project: p }) => {
      running.add(p);
      project.refresh();
    }),
    deps.projects.onDidBuild(({ project: p }) => {
      running.delete(p);
      project.refresh();
    }),
    deps.projects.onDidCountWords(() => project.refresh()),
    deps.entries.onDidChangePins(() => project.refresh()),
    deps.onDidChangeActivePdf(() => project.refresh()),
    // A saved Typst file may include other files now (the include scan of its folder is read again).
    vscode.workspace.onDidSaveTextDocument((d) => {
      if (d.uri.scheme === 'file' && d.uri.fsPath.toLowerCase().endsWith('.typ')) project.refresh();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(SECTION)) return;
      project.refresh();
      settings.refresh();
    }),
    vscode.commands.registerCommand('typst-workshop.changeSetting', (arg?: unknown, value?: unknown) => {
      const key = settingArg(arg);
      return key === undefined ? refuse('Change Setting needs the key of a setting') : changeSetting(key, value);
    }),
    vscode.commands.registerCommand('typst-workshop.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${deps.extensionId}`)),
  );

  return {
    project: () => project.shown,
    commands: () => commands.shown,
    settings: () => settings.shown,
    visible: () => ({ project: views.project.visible, commands: views.commands.visible, settings: views.settings.visible }),
  };
}
