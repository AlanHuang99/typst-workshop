// Extension-host tests of the sidebar on a copy of test/fixtures/workspace. The suite starts and ends with no PDF tab, no project and no main.pdf, so it does not depend on the suites before it and leaves nothing to the ones after it.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { TypstWorkshopApi } from '../../src/extension';
import type { SidebarNode } from '../../src/sidebar/model';

const EXTENSION_ID = 'alanhuang.typst-workshop';

/** Polls until the condition holds, failing after `ms`; `what` names the condition, or builds the text when the wait fails. */
async function waitFor(condition: () => boolean, ms: number, what: string | (() => string)): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${typeof what === 'string' ? what : what()}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function show(nodes: SidebarNode[]): string {
  return JSON.stringify(nodes, (key, value: unknown) => (key === 'tooltip' ? undefined : value), 1);
}

suite('Sidebar', function () {
  this.timeout(60_000);

  let api: TypstWorkshopApi;
  let main: string;
  let section: string;
  let pdf: string;

  async function closePdfTabs(): Promise<void> {
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.includes('typst-workshop.pdf'));
    if (tabs.length > 0) await vscode.window.tabGroups.close(tabs);
  }

  /** Closes the PDF tabs, forgets the projects (their helpers stop) and deletes main.pdf, as if nothing had been built in this window. */
  async function reset(): Promise<void> {
    await closePdfTabs();
    await api.projects.disposeAll();
    await fs.promises.rm(pdf, { force: true });
  }

  async function build(entry: string): Promise<void> {
    const outcome = (await vscode.commands.executeCommand('typst-workshop.buildEntry', entry)) as { result?: { success: boolean } } | undefined;
    assert.equal(outcome?.result?.success, true, `outcome of ${entry}: ${JSON.stringify(outcome)}`);
  }

  suiteSetup(async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'the fixture workspace is open');
    main = path.join(folder.uri.fsPath, 'main.typ');
    section = path.join(folder.uri.fsPath, 'sections', 'a.typ');
    pdf = path.join(folder.uri.fsPath, 'main.pdf');
    const extension = vscode.extensions.getExtension<TypstWorkshopApi>(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} is loaded`);
    api = await extension.activate();
    await reset();
  });

  suiteTeardown(() => reset());

  test('the Typst Workshop container opens with the Project, Commands and Settings views', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.typst-workshop');
    await waitFor(() => Object.values(api.sidebar.visible()).every((v) => v), 10_000, () => `the three views to be visible: ${JSON.stringify(api.sidebar.visible())}`);
    await waitFor(() => api.sidebar.commands().length > 0, 10_000, 'the Commands view to show its items');
    assert.deepEqual(
      api.sidebar.commands().map((n) => n.label),
      ['Build Project', 'View PDF', 'Show Cursor Position in PDF', 'Stop Build', 'Count Words', 'Set Current File as Entry', 'Clear Entry Setting', 'Show Log'],
    );
  });

  test('with sections/a.typ active the Project view shows main.typ found through #include; after a build, its PDF, the succeeded build and the word count', async () => {
    const document = await vscode.workspace.openTextDocument(section);
    await vscode.window.showTextDocument(document);
    await waitFor(() => api.sidebar.project()[0]?.entry === main, 10_000, () => `the Project view to show main.typ; it shows ${show(api.sidebar.project())}`);
    const [before] = api.sidebar.project();
    assert.equal(before.label, 'main.typ');
    assert.equal(before.description, 'found through #include');
    assert.match(before.tooltip ?? '', /\(include scan\)\.$/, 'the tooltip names the rule exactly');

    await build(main);
    const children = () => api.sidebar.project()[0]?.children ?? [];
    await waitFor(() => children().some((c) => c.contextValue === 'build.succeeded') && children().some((c) => c.contextValue === 'words'), 20_000, () => `a succeeded build and a word count; the view shows ${show(api.sidebar.project())}`);
    const [after] = api.sidebar.project();
    assert.equal(after.label, 'main.typ');
    assert.equal(after.description, 'built before');
    const pdf = children().find((c) => c.contextValue === 'pdf');
    assert.ok(pdf, `a PDF item: ${show(children())}`);
    assert.equal(pdf.label, 'main.pdf');
    assert.equal(pdf.description, undefined, 'the PDF exists');
    const last = children().find((c) => c.contextValue === 'build.succeeded');
    assert.match(last?.label ?? '', /^Built at \d\d:\d\d:\d\d$/);
    assert.match(last?.description ?? '', /^\d+\.\d\d s · 1 page$/);
    assert.match(children().find((c) => c.contextValue === 'words')?.label ?? '', /^\d+ words?$/);
  });

  test('a focused PDF tab marks the project that writes the PDF', async () => {
    await build(main);
    try {
      await api.viewers.open(pdf);
      await waitFor(() => api.sidebar.project()[0]?.description === 'writes the focused PDF', 10_000, () => `the Project view to mark main.typ for its PDF tab; it shows ${show(api.sidebar.project())}`);
      const [marked] = api.sidebar.project();
      assert.equal(marked.entry, main);
      assert.equal(marked.icon, 'target');
      assert.equal(marked.expanded, true);
    } finally {
      await closePdfTabs();
    }
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(section));
    await waitFor(() => api.sidebar.project()[0]?.description === 'built before', 10_000, () => `the Project view to follow sections/a.typ again; it shows ${show(api.sidebar.project())}`);
  });

  test('the clear-pin button works for a pinned entry whose file was deleted', async () => {
    const other = path.join(path.dirname(main), 'other.typ');
    await fs.promises.writeFile(other, 'Other.\n');
    const item = () => api.sidebar.project().find((n) => n.entry === other);
    try {
      await build(other);
      await vscode.commands.executeCommand('typst-workshop.pinEntryFile', other);
      await waitFor(() => item()?.contextValue === 'entry.pinned', 10_000, () => `other.typ to be pinned; the view shows ${show(api.sidebar.project())}`);
      await fs.promises.rm(other);
      await vscode.commands.executeCommand('typst-workshop.unpinEntryFile', other);
      await waitFor(() => item()?.contextValue === 'entry', 10_000, () => `the pin of the deleted other.typ to be cleared; the view shows ${show(api.sidebar.project())}`);
    } finally {
      // Clear Entry Setting for the folder of the active sections/a.typ, whatever happened above.
      await vscode.commands.executeCommand('typst-workshop.unpinEntry');
      await fs.promises.rm(other, { force: true });
      await fs.promises.rm(other.replace(/\.typ$/, '.pdf'), { force: true });
    }
  });

  test('the Settings view shows each setting in plain words, here Automatic builds with its current value; Change Setting writes where the setting is defined', async () => {
    const config = () => vscode.workspace.getConfiguration('typst-workshop', vscode.Uri.file(section));
    const item = (key: string) => api.sidebar.settings().find((n) => n.setting === key);
    assert.equal(config().get<string>('autoBuild.run'), 'onFileChange');
    await waitFor(() => item('autoBuild.run')?.description === 'on file change', 10_000, () => `Automatic builds with "on file change"; the view shows ${show(api.sidebar.settings())}`);
    assert.equal(item('autoBuild.run')?.label, 'Automatic builds');
    assert.match(item('autoBuild.run')?.tooltip ?? '', /^typst-workshop\.autoBuild\.run\n/);
    try {
      // Defined in the workspace settings of this single folder, which VS Code also reports as the folder value: the new value goes to the workspace settings.
      await config().update('sync.indicator', 'rectangle', vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand('typst-workshop.changeSetting', 'sync.indicator', 'none');
      assert.equal(config().inspect('sync.indicator')?.workspaceValue, 'none');
      assert.equal(config().inspect('sync.indicator')?.globalValue, undefined);
      await waitFor(() => item('sync.indicator')?.description === 'none', 10_000, () => `Marker in the PDF with none; the view shows ${show(api.sidebar.settings())}`);
      // Not set anywhere: the user settings.
      await vscode.commands.executeCommand('typst-workshop.changeSetting', 'sync.afterBuild', true);
      assert.equal(config().inspect('sync.afterBuild')?.globalValue, true);
      assert.equal(config().inspect('sync.afterBuild')?.workspaceValue, undefined);
    } finally {
      await config().update('sync.indicator', undefined, vscode.ConfigurationTarget.Workspace);
      await config().update('sync.afterBuild', undefined, vscode.ConfigurationTarget.Global);
    }
  });
});
