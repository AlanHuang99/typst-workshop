import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { WordCountResult } from '../../src/helper/protocol';
import { memoryLogger } from '../../src/log';
import { VscodeEntryContext } from '../../src/project/entryContext';
import { ProjectManager } from '../../src/project/manager';
import type { BuildOutcome, Project } from '../../src/project/project';
import type { SidebarNode } from '../../src/sidebar/model';
import { registerSidebar, treeItem, type SidebarApi } from '../../src/sidebar/views';
import { Emitter } from '../../src/util/emitter';
import { ConfigurationTarget, FakeMemento, ThemeIcon, TreeItemCollapsibleState, Uri, testHooks } from './vscode-stub';

const manifest = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const schema = manifest.contributes.configuration.properties;

let finished = 0;

/** A project as the sidebar sees it, driven by the test. */
class FakeProject {
  dependencies = new Set<string>();
  buildSeq = 0;
  lastOutcome?: BuildOutcome;
  lastWordCount?: WordCountResult;
  private readonly started = new Emitter<{ project: FakeProject; trigger: string }>();
  private readonly built = new Emitter<{ project: FakeProject; outcome: BuildOutcome }>();
  private readonly counted = new Emitter<{ project: FakeProject; result: WordCountResult }>();
  readonly onDidStartBuild = this.started.event;
  readonly onDidBuild = this.built.event;
  readonly onDidCountWords = this.counted.event;
  constructor(readonly entry: string) {}
  get pdf(): string {
    return this.entry.replace(/\.typ$/, '.pdf');
  }
  get root(): string {
    return path.dirname(this.entry);
  }
  start(): void {
    this.started.fire({ project: this, trigger: 'test' });
  }
  finish(outcome: BuildOutcome, dependencies: string[] = []): void {
    this.lastOutcome = outcome;
    this.buildSeq = ++finished;
    for (const d of dependencies) this.dependencies.add(d);
    this.built.fire({ project: this, outcome });
  }
  count(result: WordCountResult): void {
    this.lastWordCount = result;
    this.counted.fire({ project: this, result });
  }
  stop(): void {}
  async dispose(): Promise<void> {}
}

const success = (at = new Date(2026, 9, 7, 14, 2, 31)): BuildOutcome => ({ trigger: 'test', at, result: { success: true, durationMs: 231, pageCount: 1, pdfWritten: true, diagnostics: [], dependencies: [] } });

let dir: string;
let main: string;
let section: string;
let notes: string;
let projects: ProjectManager;
let entries: VscodeEntryContext;
let api: SidebarApi;
let context: { subscriptions: { dispose(): void }[] };
let log: ReturnType<typeof memoryLogger>;
/** The logger of the entry context: entry decisions logged by resolveEntry would land here. */
let entryLog: ReturnType<typeof memoryLogger>;
/** The PDF of the focused PDF tab, set by the tests. */
let focusedPdf: string | undefined;
let pdfTabs: Emitter<void>;

function write(rel: string, text: string): string {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}

function view(id: string) {
  const v = testHooks.treeViews.find((t) => t.id === id);
  if (!v) throw new Error(`no tree view ${id}`);
  return v;
}

/** The root items, fetched as VS Code does after the view fired a change. */
async function roots(id: string): Promise<SidebarNode[]> {
  return view(id).provider.getChildren();
}

/** Resolves when the view asks VS Code to fetch its items again. */
function nextChange(id: string): Promise<void> {
  return new Promise((resolve) => {
    const listener = view(id).provider.onDidChangeTreeData(() => {
      listener.dispose();
      resolve();
    });
  });
}

function command(id: string): (...args: unknown[]) => unknown {
  const handler = testHooks.commands.get(id);
  if (!handler) throw new Error(`no command ${id}`);
  return handler;
}

function fake(entry: string): FakeProject {
  return projects.getOrCreate(entry) as unknown as FakeProject;
}

beforeEach(() => {
  testHooks.reset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-sidebar Ä '));
  main = write('main.typ', '#include "sections/a.typ"\n');
  section = write('sections/a.typ', 'Alpha.\n');
  notes = write('notes.typ', 'Notes.\n');
  testHooks.setWorkspaceFolders([dir]);
  for (const [key, value] of Object.entries({ 'autoBuild.run': 'onFileChange', 'sync.keybinding': 'ctrl-click', 'sync.indicator': 'circle', 'view.pdf.invertMode': 'never', 'sync.afterBuild': false, 'wordCount.statusBar': true, 'view.pdf.zoom': 'page-width' })) {
    testHooks.config[`typst-workshop.${key}`] = value;
  }
  projects = new ProjectManager((entry) => new FakeProject(entry) as unknown as Project);
  entryLog = memoryLogger();
  entries = new VscodeEntryContext({ state: new FakeMemento() as never, projects, logger: entryLog });
  context = { subscriptions: [] };
  log = memoryLogger();
  focusedPdf = undefined;
  pdfTabs = new Emitter<void>();
  api = registerSidebar(context as never, { ...pdfDeps(), projects, entries, pdfFor: (entry) => entry.replace(/\.typ$/, '.pdf'), schema, extensionId: 'alanhuang.typst-workshop', logger: log, refreshDelayMs: 0 });
});

/** The focused PDF tab as the extension reports it: main.pdf is written by main.typ, slides.pdf by slides.typ. */
function pdfDeps() {
  return {
    activePdf: () => focusedPdf,
    entryOfPdf: (pdf: string) => (pdf === path.join(dir, 'main.pdf') ? main : pdf === path.join(dir, 'slides.pdf') ? path.join(dir, 'slides.typ') : undefined),
    onDidChangeActivePdf: pdfTabs.event,
  };
}

afterEach(() => {
  for (const s of context.subscriptions) s.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the three views', () => {
  test('are registered as tree views; the API reports their visibility and the items they last gave VS Code', async () => {
    expect(testHooks.treeViews.map((v) => v.id)).toEqual(['typst-workshop.project', 'typst-workshop.commands', 'typst-workshop.settings']);
    expect(api.visible()).toEqual({ project: false, commands: false, settings: false });
    view('typst-workshop.settings').visible = true;
    expect(api.visible()).toEqual({ project: false, commands: false, settings: true });
    expect(api.project()).toEqual([]);
    expect(await roots('typst-workshop.project')).toEqual([]);
    const commandItems = await roots('typst-workshop.commands');
    expect(commandItems.map((n) => n.label)).toContain('Build Project');
    expect(api.commands()).toEqual(commandItems);
  });

  test('dispose with the extension', () => {
    for (const s of context.subscriptions) s.dispose();
    expect(testHooks.treeViews.every((v) => v.disposed)).toBe(true);
    expect(testHooks.commands.has('typst-workshop.changeSetting')).toBe(false);
    context.subscriptions = [];
  });
});

describe('Project view', () => {
  test('follows the active editor: an included file shows its entry chosen by the include scan', async () => {
    const changed = nextChange('typst-workshop.project');
    testHooks.setActiveEditor(testHooks.editor(section));
    await changed;
    const [entry, ...others] = await roots('typst-workshop.project');
    expect(others).toEqual([]);
    expect(entry).toMatchObject({ label: 'main.typ', description: 'found through #include', entry: main, contextValue: 'entry' });
    expect(entry.children?.map((c) => c.label)).toEqual(['main.pdf', 'Not built in this window']);
    expect(api.project()[0].label).toBe('main.typ');
    // The view decides in auto mode: no Quick Pick, and nothing is logged as an entry decision.
    expect(testHooks.quickPicks).toEqual([]);
    expect(entryLog.lines).toEqual([]);
  });

  test('a file that no entry file uses is not built automatically', async () => {
    testHooks.setActiveEditor(testHooks.editor(notes));
    const [node] = await roots('typst-workshop.project');
    expect(node).toMatchObject({ label: 'notes.typ', description: 'not built automatically; Build Project compiles it on its own', contextValue: 'orphan', entry: notes });
  });

  test('a non-Typst editor shows only the projects built in this window', async () => {
    fake(main).finish(success(), [main, section]);
    testHooks.setActiveEditor(testHooks.editor(path.join(dir, 'README.md')));
    expect((await roots('typst-workshop.project')).map((n) => [n.label, n.icon])).toEqual([['main.typ', 'file']]);
  });

  test('refreshes when a build starts and ends and when a word count arrives, showing each state', async () => {
    testHooks.setActiveEditor(testHooks.editor(section));
    const project = fake(main);
    let changed = nextChange('typst-workshop.project');
    project.start();
    await changed;
    expect((await roots('typst-workshop.project'))[0].children?.[1]).toMatchObject({ label: 'Building…', contextValue: 'build.running' });

    write('main.pdf', '%PDF-1.7');
    changed = nextChange('typst-workshop.project');
    project.finish(success(), [main, section]);
    await changed;
    const [entry] = await roots('typst-workshop.project');
    expect(entry).toMatchObject({ label: 'main.typ', description: 'built before' });
    expect(entry.children?.map((c) => [c.label, c.description])).toEqual([
      ['main.pdf', undefined],
      ['Built at 14:02:31', '0.23 s · 1 page'],
    ]);

    changed = nextChange('typst-workshop.project');
    project.count({ total: 1234, files: [{ path: section, words: 1234 }] });
    await changed;
    const words = (await roots('typst-workshop.project'))[0].children?.[2];
    expect(words).toMatchObject({ label: '1,234 words', tooltip: '1,234 words in main.pdf\nsections/a.typ: 1,234', command: { id: 'typst-workshop.wordCount', args: [main] } });
  });

  test('a build that starts and ends within one quiet period refreshes the view once', async () => {
    let changes = 0;
    view('typst-workshop.project').provider.onDidChangeTreeData(() => changes++);
    const project = fake(main);
    project.start();
    project.finish(success());
    project.count({ total: 1, files: [] });
    await vi.waitFor(() => expect(changes).toBe(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(changes).toBe(1);
  });

  test('other projects built in this window are listed below the active one, in path order', async () => {
    const slides = write('slides.typ', '#include "notes.typ"\n');
    fake(slides).finish(success(), [slides, notes]);
    fake(main).finish(success(), [main, section]);
    projects.getOrCreate(write('never.typ', ''));
    testHooks.setActiveEditor(testHooks.editor(section));
    expect((await roots('typst-workshop.project')).map((n) => [n.label, n.icon])).toEqual([
      ['main.typ', 'target'],
      ['slides.typ', 'file'],
    ]);
    testHooks.setActiveEditor(undefined);
    expect((await roots('typst-workshop.project')).map((n) => n.label)).toEqual(['main.typ', 'slides.typ']);
  });

  test('without a Typst editor, a focused PDF tab marks the project that writes the PDF, and the view follows the tab', async () => {
    fake(main).finish(success(), [main, section]);
    const slides = write('slides.typ', 'Slides.\n');
    let changed = nextChange('typst-workshop.project');
    focusedPdf = path.join(dir, 'main.pdf');
    pdfTabs.fire();
    await changed;
    expect((await roots('typst-workshop.project')).map((n) => [n.label, n.description, n.icon, n.expanded])).toEqual([['main.typ', 'writes the focused PDF', 'target', true]]);
    // The PDF of an entry that was not built in this window: the entry is marked all the same.
    changed = nextChange('typst-workshop.project');
    focusedPdf = path.join(dir, 'slides.pdf');
    pdfTabs.fire();
    await changed;
    expect((await roots('typst-workshop.project')).map((n) => [n.label, n.description, n.icon])).toEqual([
      ['slides.typ', 'writes the focused PDF', 'target'],
      ['main.typ', undefined, 'file'],
    ]);
    expect(projects.get(slides)).toBeUndefined();
    // A PDF that no entry writes marks nothing; a Typst editor comes before the PDF tab.
    focusedPdf = path.join(dir, 'other.pdf');
    expect((await roots('typst-workshop.project')).map((n) => [n.label, n.icon])).toEqual([['main.typ', 'file']]);
    focusedPdf = path.join(dir, 'main.pdf');
    testHooks.setActiveEditor(testHooks.editor(notes));
    expect((await roots('typst-workshop.project')).map((n) => [n.label, n.contextValue])).toEqual([
      ['notes.typ', 'orphan'],
      ['main.typ', 'entry'],
    ]);
  });

  test('refreshes when the pin changes, switching the inline button', async () => {
    testHooks.setActiveEditor(testHooks.editor(section));
    expect((await roots('typst-workshop.project'))[0].contextValue).toBe('entry');
    let changed = nextChange('typst-workshop.project');
    await entries.pin(main);
    await changed;
    expect((await roots('typst-workshop.project'))[0]).toMatchObject({ description: 'pinned', contextValue: 'entry.pinned' });
    changed = nextChange('typst-workshop.project');
    await entries.unpin(main);
    await changed;
    expect((await roots('typst-workshop.project'))[0]).toMatchObject({ description: 'found through #include', contextValue: 'entry' });
  });

  test('refreshes when a setting of the extension changes (mainFile changes the entry)', async () => {
    testHooks.setActiveEditor(testHooks.editor(section));
    const changed = nextChange('typst-workshop.project');
    testHooks.setConfig('typst-workshop.mainFile', 'notes.typ');
    await changed;
    expect((await roots('typst-workshop.project'))[0]).toMatchObject({ label: 'notes.typ', description: 'set in mainFile' });
  });

  test('refreshes when a Typst file is saved, since its includes may have changed', async () => {
    const changed = nextChange('typst-workshop.project');
    testHooks.save(notes);
    await changed;
  });

  test('a failing entry decision is logged and the known projects are still listed', async () => {
    const logger = memoryLogger();
    for (const s of context.subscriptions) s.dispose();
    testHooks.treeViews = [];
    const broken = Object.create(entries, { includeGraph: { value: () => Promise.reject(new Error('scan broke')) } });
    api = registerSidebar(context as never, { ...pdfDeps(), projects, entries: broken, pdfFor: (e) => e.replace(/\.typ$/, '.pdf'), schema, extensionId: 'x.y', logger, refreshDelayMs: 0 });
    fake(main).finish(success());
    testHooks.setActiveEditor(testHooks.editor(notes));
    expect((await roots('typst-workshop.project')).map((n) => n.label)).toEqual(['main.typ']);
    expect(logger.lines.some((l) => l.startsWith('error') && l.includes('scan broke'))).toBe(true);
  });
});

describe('Settings view', () => {
  test('lists the settings and their current values in plain words and refreshes when they change', async () => {
    const items = await roots('typst-workshop.settings');
    expect(items.find((n) => n.setting === 'autoBuild.run')).toMatchObject({ label: 'Automatic builds', description: 'on file change', tooltip: 'typst-workshop.autoBuild.run\nWhen to build automatically.' });
    expect(items.find((n) => n.setting === 'sync.afterBuild')).toMatchObject({ label: 'Show the cursor after builds', description: 'off' });
    expect(items.find((n) => n.setting === 'view.pdf.zoom')).toMatchObject({ label: 'PDF zoom', description: 'page width' });
    expect(api.settings()).toEqual(items);
    const changed = nextChange('typst-workshop.settings');
    testHooks.setConfig('typst-workshop.view.pdf.zoom', '1.25');
    await changed;
    expect((await roots('typst-workshop.settings')).find((n) => n.setting === 'view.pdf.zoom')).toMatchObject({ label: 'PDF zoom', description: '125 %' });
  });

  test('Change Setting offers the allowed values and writes the choice where the setting is defined', async () => {
    // A single-folder workspace reports .vscode/settings.json as both levels; autoBuild.run is window-scoped, so it goes to the workspace.
    testHooks.configLevels['typst-workshop.autoBuild.run'] = { globalValue: 'onSave', workspaceValue: 'onFileChange', workspaceFolderValue: 'onFileChange' };
    testHooks.quickPickAnswer = (items) => (items as { label: string }[]).find((i) => i.label === 'never');
    await command('typst-workshop.changeSetting')('autoBuild.run');
    expect(testHooks.quickPicks[0].options).toMatchObject({ title: 'Automatic builds', placeHolder: 'When to build automatically.' });
    expect(testHooks.quickPicks[0].items).toMatchObject([
      { label: 'never', detail: 'never' },
      { label: 'on save', detail: 'onSave' },
      { label: 'on file change', description: 'current · default', detail: 'onFileChange' },
    ]);
    expect(testHooks.configUpdates).toEqual([{ key: 'typst-workshop.autoBuild.run', value: 'never', target: ConfigurationTarget.Workspace, scope: Uri.file(dir) }]);
  });

  test('a setting set nowhere is written to the user settings; booleans are offered as on and off', async () => {
    testHooks.setActiveEditor(testHooks.editor(section));
    testHooks.quickPickAnswer = (items) => (items as { label: string }[]).find((i) => i.label === 'on');
    await command('typst-workshop.changeSetting')({ id: 'setting:sync.afterBuild', label: 'sync.afterBuild', setting: 'sync.afterBuild' });
    expect(testHooks.quickPicks[0].items).toMatchObject([
      { label: 'on', detail: 'true' },
      { label: 'off', description: 'current · default', detail: 'false' },
    ]);
    expect(testHooks.configUpdates).toMatchObject([{ key: 'typst-workshop.sync.afterBuild', value: true, target: ConfigurationTarget.Global }]);
    expect(testHooks.configUpdates[0].scope).toEqual(Uri.file(section));
  });

  test('Other value… of PDF zoom asks for a percentage and writes the factor', async () => {
    testHooks.quickPickAnswer = (items) => (items as { label: string }[]).find((i) => i.label === 'Other value…');
    testHooks.inputBoxAnswer = () => '125 %';
    await command('typst-workshop.changeSetting')('view.pdf.zoom');
    const [box] = testHooks.inputBoxes;
    expect(box).toMatchObject({ title: 'PDF zoom', prompt: 'Zoom in percent, for example 125', value: '' });
    expect(box.validateInput?.('huge')).toBe('Enter the zoom in percent, for example 125.');
    expect(box.validateInput?.('5')).toBe('The zoom must be from 10 % to 1000 %.');
    expect(box.validateInput?.('133.3')).toBeUndefined();
    expect(testHooks.configUpdates).toMatchObject([{ key: 'typst-workshop.view.pdf.zoom', value: '1.25', target: ConfigurationTarget.Global }]);
    // From the zoom of 1.25 just written, the box starts at 125; 133.3 is stored as 1.333.
    testHooks.inputBoxAnswer = () => '133.3';
    await command('typst-workshop.changeSetting')('view.pdf.zoom');
    expect(testHooks.inputBoxes[1].value).toBe('125');
    expect(testHooks.configUpdates[1]).toMatchObject({ key: 'typst-workshop.view.pdf.zoom', value: '1.333' });
  });

  test('the zoom presets are written as they are', async () => {
    testHooks.quickPickAnswer = (items) => (items as { label: string }[]).find((i) => i.label === 'page fit');
    await command('typst-workshop.changeSetting')('view.pdf.zoom');
    expect(testHooks.quickPicks[0].items).toMatchObject([{ label: 'automatic' }, { label: 'page width' }, { label: 'page fit' }, { label: 'actual size' }, { label: 'Other value…' }]);
    expect(testHooks.inputBoxes).toEqual([]);
    expect(testHooks.configUpdates).toMatchObject([{ key: 'typst-workshop.view.pdf.zoom', value: 'page-fit' }]);
  });

  test('cancelling, or choosing the current value, writes nothing', async () => {
    await command('typst-workshop.changeSetting')('sync.indicator');
    testHooks.quickPickAnswer = (items) => (items as { label: string }[]).find((i) => i.label === 'Other value…');
    await command('typst-workshop.changeSetting')('view.pdf.zoom');
    testHooks.quickPickAnswer = (items) => (items as { label: string }[]).find((i) => i.label === 'circle');
    await command('typst-workshop.changeSetting')('sync.indicator');
    expect(testHooks.quickPicks).toHaveLength(3);
    expect(testHooks.configUpdates).toEqual([]);
  });

  test('a value passed to the command is written without asking, if the setting allows it', async () => {
    await command('typst-workshop.changeSetting')('sync.indicator', 'none');
    expect(log.lines).toContain('info Set typst-workshop.sync.indicator to "none" in the user settings');
    await command('typst-workshop.changeSetting')('sync.indicator', 'square');
    await command('typst-workshop.changeSetting')('nope', 1);
    await command('typst-workshop.changeSetting')(undefined);
    await command('typst-workshop.changeSetting')(7);
    expect(testHooks.quickPicks).toEqual([]);
    expect(testHooks.configUpdates).toMatchObject([{ key: 'typst-workshop.sync.indicator', value: 'none', target: ConfigurationTarget.Global }]);
    expect(testHooks.messages.map((m) => [m.level, m.message])).toEqual([
      ['error', 'Typst Workshop: square is not a value of typst-workshop.sync.indicator.'],
      ['error', 'Typst Workshop: typst-workshop.nope is not one of the settings in the sidebar.'],
      ['error', 'Typst Workshop: Change Setting needs the key of a setting.'],
      ['error', 'Typst Workshop: Change Setting needs the key of a setting.'],
    ]);
    // Each refusal is also logged as a warning.
    expect(log.lines.filter((l) => l.startsWith('warn'))).toEqual([
      'warn square is not a value of typst-workshop.sync.indicator',
      'warn typst-workshop.nope is not one of the settings in the sidebar',
      'warn Change Setting needs the key of a setting',
      'warn Change Setting needs the key of a setting',
    ]);
  });

  test('only the settings the sidebar lists can be changed this way (an array setting would get a string)', async () => {
    await command('typst-workshop.changeSetting')('fontPaths');
    expect(testHooks.quickPicks).toEqual([]);
    expect(testHooks.configUpdates).toEqual([]);
    expect(testHooks.messages.map((m) => m.message)).toEqual(['Typst Workshop: typst-workshop.fontPaths is not one of the settings in the sidebar.']);
    expect(log.lines).toEqual(['warn typst-workshop.fontPaths is not one of the settings in the sidebar']);
  });

  test('a write that VS Code refuses is reported', async () => {
    testHooks.configUpdateError = 'Unable to write to Workspace Settings';
    await command('typst-workshop.changeSetting')('sync.indicator', 'none');
    expect(testHooks.messages).toMatchObject([{ level: 'error', message: 'Typst Workshop: cannot change typst-workshop.sync.indicator: Unable to write to Workspace Settings' }]);
    expect(log.lines).toContain('error Cannot change typst-workshop.sync.indicator: Unable to write to Workspace Settings');
  });

  test('Open Settings opens the Settings editor filtered to this extension', async () => {
    await command('typst-workshop.openSettings')();
    expect(testHooks.executedCommands).toEqual([{ id: 'workbench.action.openSettings', args: ['@ext:alanhuang.typst-workshop'] }]);
  });
});

describe('tree items', () => {
  test('an item with children is expanded or collapsed as the model says; icons, context values and commands carry over', () => {
    const entry: SidebarNode = { id: 'entry:/w/main.typ', label: 'main.typ', description: 'include scan', tooltip: '/w/main.typ', icon: 'target', contextValue: 'entry', command: { id: 'vscode.open', title: 'Open File', args: ['/w/main.typ'] }, children: [{ id: 'pdf:/w/main.typ', label: 'main.pdf' }], expanded: true };
    const item = treeItem(entry);
    expect(item).toMatchObject({ id: 'entry:/w/main.typ', label: 'main.typ', description: 'include scan', tooltip: '/w/main.typ', contextValue: 'entry', collapsibleState: TreeItemCollapsibleState.Expanded });
    expect(item.iconPath).toEqual(new ThemeIcon('target'));
    // vscode.open takes a URI.
    expect(item.command).toEqual({ command: 'vscode.open', title: 'Open File', arguments: [Uri.file('/w/main.typ')] });
    expect(treeItem({ ...entry, expanded: false }).collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
    const leaf = treeItem({ id: 'build:/w/main.typ', label: 'Built at 14:02:31', command: { id: 'typst-workshop.showLog', title: 'Show Log' } });
    expect(leaf.collapsibleState).toBe(TreeItemCollapsibleState.None);
    expect(leaf.command).toEqual({ command: 'typst-workshop.showLog', title: 'Show Log', arguments: undefined });
    expect(leaf.iconPath).toBeUndefined();
  });
});
