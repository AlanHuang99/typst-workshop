import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { OTHER_VALUE, commandNodes, entryArg, plainValue, projectNodes, settingArg, settingChoices, settingInput, settingInputProblem, settingInputValue, settingLabel, settingNodes, settingValueProblem, writeTarget, type ProjectSummary, type SidebarNode } from '../../src/sidebar/model';
import type { BuildStatus } from '../../src/statusText';

const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
/** The extension's own `contributes.configuration`, which the Settings view and its Quick Picks read. */
const schema = manifest.contributes.configuration.properties;

const main = '/w/main.typ';
const section = '/w/sections/a.typ';

function summary(over: Partial<ProjectSummary> = {}): ProjectSummary {
  return { entry: main, pdf: '/w/main.pdf', pdfExists: true, status: { kind: 'idle' }, pinned: false, ...over };
}

function ids(nodes: SidebarNode[]): string[] {
  return nodes.flatMap((n) => [n.id, ...ids(n.children ?? [])]);
}

describe('Project view', () => {
  test('without a Typst editor and before any build it has no items (the view shows its welcome text)', () => {
    expect(projectNodes({ known: [] })).toEqual([]);
  });

  test('an included file: its entry found through #include, marked and expanded, with its PDF and last build', () => {
    const nodes = projectNodes({ active: { file: section, rule: 'include scan', project: summary({ pdfExists: false }) }, known: [] });
    expect(nodes).toHaveLength(1);
    const [entry] = nodes;
    expect(entry).toMatchObject({ label: 'main.typ', description: 'found through #include', icon: 'target', contextValue: 'entry', expanded: true, entry: main, command: { id: 'vscode.open', args: [main] } });
    expect(entry.tooltip).toBe(`${main}\nEntry of a.typ: it includes a.typ, directly or through other files (include scan).`);
    expect(entry.children).toMatchObject([
      { label: 'main.pdf', description: 'not built yet', icon: 'file-pdf', contextValue: 'pdf', entry: main, command: { id: 'typst-workshop.viewEntry', args: [main] } },
      { label: 'Not built in this window', icon: 'circle-outline', contextValue: 'build.none', entry: main, command: { id: 'typst-workshop.showLog' } },
    ]);
    expect(entry.children?.[0].tooltip).toBe('/w/main.pdf\nView PDF builds it first.');
  });

  test('each rule in plain words; the tooltip names the rule exactly and what it means', () => {
    const reason = (rule: 'magic comment' | 'pinned' | 'setting' | 'known project' | 'the file itself', file = section) => projectNodes({ active: { file, rule, project: summary() }, known: [] })[0];
    expect(reason('magic comment')).toMatchObject({ description: 'set by // !TYPST root', tooltip: `${main}\nEntry of a.typ: a // !TYPST root comment in a.typ names it (magic comment).` });
    expect(reason('pinned')).toMatchObject({ description: 'pinned', tooltip: `${main}\nEntry of a.typ: it is pinned as the entry of this folder (pinned).` });
    expect(reason('setting')).toMatchObject({ description: 'set in mainFile', tooltip: `${main}\nEntry of a.typ: the setting typst-workshop.mainFile names it (setting).` });
    expect(reason('known project')).toMatchObject({ description: 'built before', tooltip: `${main}\nEntry of a.typ: its last build read a.typ (known project).` });
    expect(reason('the file itself', main)).toMatchObject({ description: 'entry file', tooltip: `${main}\nEntry of main.typ: no other file includes or imports main.typ (the file itself).` });
  });

  test('a file that no entry file uses: not built automatically, with no children; its buttons build it on its own', () => {
    const nodes = projectNodes({ active: { file: '/w/notes.typ', rule: 'no entry' }, known: [] });
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ label: 'notes.typ', description: 'not built automatically; Build Project compiles it on its own', icon: 'circle-slash', contextValue: 'orphan', entry: '/w/notes.typ' });
    expect(nodes[0].tooltip).toBe('/w/notes.typ\nNot built automatically: nothing includes or imports notes.typ, it includes nothing itself, and the folder has another top-level file that includes files. Build Project compiles it on its own.');
    expect(nodes[0].children).toBeUndefined();
    expect(nodes[0].command).toBeUndefined();
  });

  test('two known projects: the active one first and marked, the other below and collapsed, each with the same children', () => {
    const other = summary({ entry: '/w/slides.typ', pdf: '/w/slides.pdf', status: { kind: 'stopped' } });
    const active = summary({ status: { kind: 'building', entry: main } });
    const nodes = projectNodes({ active: { file: section, rule: 'known project', project: active }, known: [other, active] });
    expect(nodes.map((n) => [n.label, n.description, n.icon, n.expanded])).toEqual([
      ['main.typ', 'built before', 'target', true],
      ['slides.typ', undefined, 'file', false],
    ]);
    expect(nodes[1]).toMatchObject({ tooltip: '/w/slides.typ', contextValue: 'entry', command: { id: 'vscode.open', args: ['/w/slides.typ'] } });
    expect(nodes.map((n) => n.children?.map((c) => c.label))).toEqual([
      ['main.pdf', 'Building…'],
      ['slides.pdf', 'Stopped'],
    ]);
    expect(new Set(ids(nodes)).size).toBe(ids(nodes).length);
  });

  test('without a Typst editor the projects built in this window are listed and none is marked', () => {
    const nodes = projectNodes({ known: [summary(), summary({ entry: '/w/slides.typ', pdf: '/w/slides.pdf' })] });
    expect(nodes.map((n) => [n.label, n.icon, n.expanded])).toEqual([
      ['main.typ', 'file', false],
      ['slides.typ', 'file', false],
    ]);
  });

  test('without a Typst editor, a focused PDF tab marks the project that writes the PDF', () => {
    const slides = summary({ entry: '/w/slides.typ', pdf: '/w/slides.pdf' });
    const nodes = projectNodes({ activePdf: { pdf: '/w/slides.pdf', project: slides }, known: [summary(), slides] });
    expect(nodes.map((n) => [n.label, n.description, n.icon, n.expanded])).toEqual([
      ['slides.typ', 'writes the focused PDF', 'target', true],
      ['main.typ', undefined, 'file', false],
    ]);
    expect(nodes[0].tooltip).toBe('/w/slides.typ\nWrites slides.pdf, the PDF of the focused tab.');
    expect(nodes[0].children?.map((c) => c.label)).toEqual(['slides.pdf', 'Not built in this window']);
    // A Typst editor comes first.
    expect(projectNodes({ active: { file: section, rule: 'include scan', project: summary() }, activePdf: { pdf: '/w/slides.pdf', project: slides }, known: [slides] }).map((n) => [n.label, n.icon])).toEqual([
      ['main.typ', 'target'],
      ['slides.typ', 'file'],
    ]);
  });

  test('a pinned entry offers to clear the pin; an entry listed below says it is pinned', () => {
    expect(projectNodes({ active: { file: section, rule: 'pinned', project: summary({ pinned: true }) }, known: [] })[0]).toMatchObject({ description: 'pinned', contextValue: 'entry.pinned' });
    expect(projectNodes({ known: [summary({ pinned: true })] })[0]).toMatchObject({ description: 'pinned', contextValue: 'entry.pinned' });
  });

  test('the last build in each state, and what clicking it opens', () => {
    const at = new Date(2026, 9, 7, 14, 2, 31);
    const build = (status: BuildStatus) => projectNodes({ known: [summary({ status })] })[0].children![1];
    expect(build({ kind: 'idle' })).toMatchObject({ label: 'Not built in this window', tooltip: 'Not built in this window', command: { id: 'typst-workshop.showLog' } });
    expect(build({ kind: 'building', entry: main })).toMatchObject({ label: 'Building…', icon: 'sync~spin', contextValue: 'build.running', tooltip: 'Building main.typ', command: { id: 'typst-workshop.showLog' } });
    expect(build({ kind: 'ok', entry: main, durationMs: 231, at, pageCount: 25 })).toMatchObject({
      label: 'Built at 14:02:31',
      description: '0.23 s · 25 pages',
      icon: 'check',
      contextValue: 'build.succeeded',
      tooltip: 'main.typ · built in 0.23 s at 14:02:31 · 25 pages',
      command: { id: 'typst-workshop.showLog' },
    });
    expect(build({ kind: 'ok', entry: main, durationMs: 5, at, pageCount: null }).description).toBe('0.01 s');
    expect(build({ kind: 'ok', entry: main, durationMs: 5, at, pageCount: 1 }).description).toBe('0.01 s · 1 page');
    expect(build({ kind: 'failed', entry: main, errors: 2 })).toMatchObject({ label: 'Failed with 2 errors', icon: 'error', contextValue: 'build.failed', tooltip: 'main.typ · build failed with 2 errors', command: { id: 'workbench.actions.view.problems' } });
    expect(build({ kind: 'failed', entry: main, errors: 1 }).label).toBe('Failed with 1 error');
    const helperFailure = build({ kind: 'failed', entry: main, errors: 0, message: 'helper binary not found: /x' });
    expect(helperFailure).toMatchObject({ label: 'Failed', description: 'helper binary not found: /x', icon: 'error', contextValue: 'build.failed', command: { id: 'typst-workshop.showLog' } });
    expect(build({ kind: 'stopped' })).toMatchObject({ label: 'Stopped', icon: 'debug-stop', contextValue: 'build.stopped', tooltip: 'The build was stopped', command: { id: 'typst-workshop.showLog' } });
  });

  test('the word count of the last successful build, when known; clicking it counts the words of that project', () => {
    const words = { result: { total: 6543, files: [{ path: section, words: 6000 }, { path: main, words: 543 }] }, root: '/w' };
    const withCount = projectNodes({ known: [summary({ words })] })[0].children!;
    expect(withCount).toHaveLength(3);
    expect(withCount[2]).toMatchObject({ label: '6,543 words', icon: 'whole-word', contextValue: 'words', entry: main, command: { id: 'typst-workshop.wordCount', args: [main] } });
    expect(withCount[2].tooltip).toBe('6,543 words in main.pdf\nsections/a.typ: 6,000\nmain.typ: 543');
    expect(projectNodes({ known: [summary()] })[0].children!.map((c) => c.contextValue)).toEqual(['pdf', 'build.none']);
  });

  test('an existing PDF opens on click', () => {
    expect(projectNodes({ known: [summary()] })[0].children![0]).toMatchObject({ label: 'main.pdf', description: undefined, tooltip: '/w/main.pdf' });
  });
});

describe('Commands view', () => {
  test('one item per command with the title of the manifest, each running its command', () => {
    const titles = new Map<string, string>(manifest.contributes.commands.map((c: { command: string; title: string }) => [c.command, c.title]));
    const nodes = commandNodes();
    expect(nodes.map((n) => n.command?.id)).toEqual([
      'typst-workshop.build',
      'typst-workshop.view',
      'typst-workshop.syncToPdf',
      'typst-workshop.kill',
      'typst-workshop.wordCount',
      'typst-workshop.pinEntry',
      'typst-workshop.unpinEntry',
      'typst-workshop.showLog',
    ]);
    expect(nodes.map((n) => n.label)).toEqual(['Build Project', 'View PDF', 'Show Cursor Position in PDF', 'Stop Build', 'Count Words', 'Set Current File as Entry', 'Clear Entry Setting', 'Show Log']);
    for (const n of nodes) {
      expect(n.label).toBe(titles.get(n.command!.id));
      expect(n.icon).toBeTruthy();
      expect(n.command?.args).toBeUndefined();
    }
    expect(new Set(ids(nodes)).size).toBe(nodes.length);
  });
});

describe('Settings view', () => {
  const values = { 'autoBuild.run': 'onSave', 'sync.keybinding': 'ctrl-click', 'sync.indicator': 'circle', 'view.pdf.invertMode': 'auto', 'sync.afterBuild': false, 'wordCount.statusBar': true, 'view.pdf.zoom': '1.25' };

  test('each frequently changed setting in plain words with its current value in plain words, then Open all settings', () => {
    const nodes = settingNodes(values, schema);
    expect(nodes.map((n) => [n.label, n.description])).toEqual([
      ['Automatic builds', 'on save'],
      ['Jump from the PDF', 'Ctrl/Cmd+click'],
      ['Marker in the PDF', 'circle'],
      ['Dark PDF pages', 'with a dark theme'],
      ['Show the cursor after builds', 'off'],
      ['Word count in the status bar', 'on'],
      ['PDF zoom', '125 %'],
      ['Open all settings', undefined],
    ]);
    expect(nodes[0]).toMatchObject({ id: 'setting:autoBuild.run', setting: 'autoBuild.run', icon: 'symbol-enum', contextValue: 'setting', command: { id: 'typst-workshop.changeSetting', args: ['autoBuild.run'] } });
    expect(nodes[4].icon).toBe('symbol-boolean');
    expect(nodes[6].icon).toBe('symbol-string');
    expect(nodes[7]).toMatchObject({ icon: 'settings-gear', command: { id: 'typst-workshop.openSettings' } });
  });

  test('the tooltip has the setting key and its description', () => {
    const nodes = settingNodes(values, schema);
    expect(nodes[0].tooltip).toBe('typst-workshop.autoBuild.run\nWhen to build automatically.');
    expect(nodes[1].tooltip).toBe('typst-workshop.sync.keybinding\nMouse gesture that jumps from the PDF to the source.');
    // Markdown code marks are dropped from the plain-text tooltip.
    expect(nodes[6].tooltip).toBe('typst-workshop.view.pdf.zoom\nInitial zoom of the PDF tab: auto, page-width, page-fit, page-actual, or a number such as 1.25.');
  });

  test('every value of every listed setting has its plain words; zoom numbers are percentages', () => {
    const plain = (key: string, value: unknown) => settingNodes({ ...values, [key]: value }, schema).find((n) => n.setting === key)?.description;
    expect(['never', 'onSave', 'onFileChange'].map((v) => plain('autoBuild.run', v))).toEqual(['never', 'on save', 'on file change']);
    expect(['ctrl-click', 'double-click'].map((v) => plain('sync.keybinding', v))).toEqual(['Ctrl/Cmd+click', 'double-click']);
    expect(['circle', 'rectangle', 'none'].map((v) => plain('sync.indicator', v))).toEqual(['circle', 'rectangle', 'none']);
    expect(['never', 'auto', 'always'].map((v) => plain('view.pdf.invertMode', v))).toEqual(['never', 'with a dark theme', 'always']);
    expect([true, false].map((v) => plain('sync.afterBuild', v))).toEqual(['on', 'off']);
    expect([true, false].map((v) => plain('wordCount.statusBar', v))).toEqual(['on', 'off']);
    expect(['auto', 'page-width', 'page-fit', 'page-actual', '1.25', '0.5', '2', '1.1', '.75', '1.333'].map((v) => plain('view.pdf.zoom', v))).toEqual(['automatic', 'page width', 'page fit', 'actual size', '125 %', '50 %', '200 %', '110 %', '75 %', '133.3 %']);
    expect(plain('view.pdf.zoom', 'huge')).toBe('huge');
  });

  test('a value or key named like an object property is shown as it is', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      expect(plainValue('autoBuild.run', name), name).toBe(name);
      expect(plainValue('view.pdf.zoom', name), name).toBe(name);
      expect(plainValue(name, 'onSave'), name).toBe('onSave');
      expect(settingLabel(name), name).toBe(name);
    }
    expect(settingNodes({ ...values, 'sync.indicator': 'constructor' }, schema).find((n) => n.setting === 'sync.indicator')?.description).toBe('constructor');
  });
});

describe('the Quick Pick of a setting', () => {
  test('an enum setting offers its values in plain words with the stored value as detail, marking the current value and the default', () => {
    expect(settingChoices(schema, 'autoBuild.run', 'onSave')).toEqual([
      { label: 'never', value: 'never', detail: 'never' },
      { label: 'on save', value: 'onSave', description: 'current', detail: 'onSave' },
      { label: 'on file change', value: 'onFileChange', description: 'default', detail: 'onFileChange' },
    ]);
    expect(settingChoices(schema, 'sync.indicator', 'circle')).toEqual([
      { label: 'circle', value: 'circle', description: 'current · default', detail: 'circle' },
      { label: 'rectangle', value: 'rectangle', detail: 'rectangle' },
      { label: 'none', value: 'none', detail: 'none' },
    ]);
    expect(settingChoices(schema, 'view.pdf.invertMode', 'never').map((c) => [c.label, c.detail])).toEqual([
      ['never', 'never'],
      ['with a dark theme', 'auto'],
      ['always', 'always'],
    ]);
    expect(settingChoices(schema, 'sync.keybinding', 'double-click').map((c) => [c.label, c.description, c.detail])).toEqual([
      ['Ctrl/Cmd+click', 'default', 'ctrl-click'],
      ['double-click', 'current', 'double-click'],
    ]);
  });

  test('a boolean setting offers on and off', () => {
    expect(settingChoices(schema, 'sync.afterBuild', true)).toEqual([
      { label: 'on', value: true, description: 'current', detail: 'true' },
      { label: 'off', value: false, description: 'default', detail: 'false' },
    ]);
    expect(settingChoices(schema, 'wordCount.statusBar', true)).toEqual([
      { label: 'on', value: true, description: 'current · default', detail: 'true' },
      { label: 'off', value: false, detail: 'false' },
    ]);
  });

  test('view.pdf.zoom offers its presets and Other value…', () => {
    expect(settingChoices(schema, 'view.pdf.zoom', '1.25')).toEqual([
      { label: 'automatic', value: 'auto', detail: 'auto' },
      { label: 'page width', value: 'page-width', description: 'default', detail: 'page-width' },
      { label: 'page fit', value: 'page-fit', detail: 'page-fit' },
      { label: 'actual size', value: 'page-actual', detail: 'page-actual' },
      { label: OTHER_VALUE, other: true, description: 'current: 125 %' },
    ]);
    expect(OTHER_VALUE).toBe('Other value…');
    expect(settingChoices(schema, 'view.pdf.zoom', 'page-fit').map((c) => [c.label, c.description])).toEqual([
      ['automatic', undefined],
      ['page width', 'default'],
      ['page fit', 'current'],
      ['actual size', undefined],
      ['Other value…', undefined],
    ]);
    expect(settingLabel('view.pdf.zoom')).toBe('PDF zoom');
    expect(settingLabel('autoBuild.run')).toBe('Automatic builds');
  });

  test('Other value… of view.pdf.zoom asks for a percentage, starting from the current zoom in percent', () => {
    expect(settingInput(schema, 'view.pdf.zoom', '1.25')).toEqual({ prompt: 'Zoom in percent, for example 125', value: '125' });
    expect(settingInput(schema, 'view.pdf.zoom', '1.333').value).toBe('133.3');
    expect(settingInput(schema, 'view.pdf.zoom', '1.1').value).toBe('110');
    expect(settingInput(schema, 'view.pdf.zoom', 'page-width')).toEqual({ prompt: 'Zoom in percent, for example 125', value: '' });
  });

  test('a percentage such as 125, 125 % or 133.3 is stored as the factor, matching the manifest pattern', () => {
    const pattern = new RegExp(schema['typst-workshop.view.pdf.zoom'].pattern);
    const cases: [string, string][] = [
      ['125', '1.25'],
      ['125 %', '1.25'],
      ['125%', '1.25'],
      [' 133.3 ', '1.333'],
      ['100', '1'],
      ['50', '0.5'],
      ['12.5', '0.125'],
      ['10', '0.1'],
      ['1000', '10'],
      ['33.333 %', '0.33333'],
    ];
    for (const [text, stored] of cases) {
      expect(settingInputProblem(schema, 'view.pdf.zoom', text), text).toBeUndefined();
      expect(settingInputValue('view.pdf.zoom', text), text).toBe(stored);
      expect(pattern.test(stored), stored).toBe(true);
    }
  });

  test('a zoom that is not a percentage from 10 to 1000 is refused with a message', () => {
    const notPercent = 'Enter the zoom in percent, for example 125.';
    const outOfRange = 'The zoom must be from 10 % to 1000 %.';
    for (const text of ['', '  ', 'huge', 'page-fit', '125 %%', '1,25', '-50', '1e3', '% 125']) expect(settingInputProblem(schema, 'view.pdf.zoom', text), text).toBe(notPercent);
    for (const text of ['9.9', '1.25', '0', '1000.1', '5000 %']) expect(settingInputProblem(schema, 'view.pdf.zoom', text), text).toBe(outOfRange);
  });

  test('a value given to the command must be one the setting allows', () => {
    expect(settingValueProblem(schema, 'autoBuild.run', 'onSave')).toBeUndefined();
    expect(settingValueProblem(schema, 'autoBuild.run', 'sometimes')).toBe('sometimes is not a value of typst-workshop.autoBuild.run');
    expect(settingValueProblem(schema, 'sync.afterBuild', false)).toBeUndefined();
    expect(settingValueProblem(schema, 'sync.afterBuild', 'off')).toBe('off is not a value of typst-workshop.sync.afterBuild');
    expect(settingValueProblem(schema, 'view.pdf.zoom', '2')).toBeUndefined();
    expect(settingValueProblem(schema, 'view.pdf.zoom', 2)).toBe('2 is not a value of typst-workshop.view.pdf.zoom');
    expect(settingValueProblem(schema, 'nope', 1)).toBe('typst-workshop.nope is not a setting of Typst Workshop');
  });
});

describe('where a new setting value is written', () => {
  test('the level where the setting is defined, the most specific first; the user settings when it is not set anywhere', () => {
    expect(writeTarget(undefined)).toBe('user');
    expect(writeTarget({})).toBe('user');
    expect(writeTarget({ globalValue: 'onSave' })).toBe('user');
    expect(writeTarget({ globalValue: 'onSave', workspaceValue: 'never' })).toBe('workspace');
    expect(writeTarget({ globalValue: 'a', workspaceValue: 'b', workspaceFolderValue: 'c' }, 'resource')).toBe('workspaceFolder');
    expect(writeTarget({ workspaceFolderValue: 'c' }, 'resource')).toBe('workspaceFolder');
  });

  test('the folder level counts only for settings a folder may set', () => {
    // A single-folder workspace reports .vscode/settings.json as both the workspace and the folder value, and VS Code refuses to write a window-scoped setting to the folder level.
    expect(writeTarget({ workspaceValue: 'b', workspaceFolderValue: 'b' })).toBe('workspace');
    expect(writeTarget({ workspaceValue: 'b', workspaceFolderValue: 'b' }, 'window')).toBe('workspace');
    expect(writeTarget({ workspaceFolderValue: 'c' })).toBe('user');
    expect(writeTarget({ workspaceFolderValue: 'c' }, 'language-overridable')).toBe('workspaceFolder');
    expect(writeTarget({ workspaceFolderValue: 'c' }, 'machine-overridable')).toBe('workspaceFolder');
  });
});

describe('command arguments', () => {
  test('a path from an item click, or the item itself from an inline button', () => {
    expect(entryArg(main)).toBe(main);
    expect(entryArg({ id: 'entry:/w/main.typ', label: 'main.typ', entry: main })).toBe(main);
    expect(entryArg(undefined)).toBeUndefined();
    expect(entryArg('main.typ')).toBeUndefined();
    expect(entryArg('/w/main.pdf')).toBeUndefined();
    expect(entryArg({ entry: 3 })).toBeUndefined();
    expect(settingArg('autoBuild.run')).toBe('autoBuild.run');
    expect(settingArg({ id: 'setting:sync.indicator', label: 'sync.indicator', setting: 'sync.indicator' })).toBe('sync.indicator');
    expect(settingArg(7)).toBeUndefined();
    expect(settingArg({})).toBeUndefined();
  });
});
