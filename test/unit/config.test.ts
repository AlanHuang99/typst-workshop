import { beforeEach, expect, test } from 'vitest';
import { readConfig } from '../../src/config';
import { testHooks } from './vscode-stub';

beforeEach(() => testHooks.reset());

test('defaults of the settings', () => {
  expect(readConfig()).toEqual({
    mainFile: '',
    rootDir: '',
    outDir: '%DIR%',
    fontPaths: [],
    inputs: {},
    autoBuildRun: 'onFileChange',
    autoBuildDelay: 250,
    helperPath: '',
    diagnosticsEnabled: true,
    errorPopup: false,
    editorGroup: 'right',
    viewer: { zoom: 'page-width', scrollMode: 'vertical', spreadMode: 'none', invertMode: 'never', invert: 0.9, syncKeybinding: 'ctrl-click', indicator: 'circle' },
    syncAfterBuild: false,
    wordCountStatusBar: true,
    editingEnabled: 'auto',
  });
});

test('values are read from the typst-workshop section', () => {
  Object.assign(testHooks.config, {
    'typst-workshop.mainFile': 'Manuscript.typ',
    'typst-workshop.outDir': '%TMPDIR%',
    'typst-workshop.fontPaths': ['fonts', 3],
    'typst-workshop.inputs': { mode: 'final', bad: 1 },
    'typst-workshop.autoBuild.run': 'onSave',
    'typst-workshop.autoBuild.delay': 500,
    'typst-workshop.message.error.show': true,
    'typst-workshop.view.pdf.tab.editorGroup': 'current',
    'typst-workshop.view.pdf.zoom': '1.25',
    'typst-workshop.view.pdf.invertMode': 'auto',
    'typst-workshop.view.pdf.invert': 0.5,
    'typst-workshop.sync.keybinding': 'double-click',
    'typst-workshop.sync.indicator': 'rectangle',
    'typst-workshop.sync.afterBuild': true,
    'typst-workshop.editing.enabled': 'off',
  });
  const c = readConfig();
  expect(c).toMatchObject({ mainFile: 'Manuscript.typ', outDir: '%TMPDIR%', fontPaths: ['fonts'], inputs: { mode: 'final' }, autoBuildRun: 'onSave', autoBuildDelay: 500, errorPopup: true, editorGroup: 'current', syncAfterBuild: true, editingEnabled: 'off' });
  expect(c.viewer).toEqual({ zoom: '1.25', scrollMode: 'vertical', spreadMode: 'none', invertMode: 'auto', invert: 0.5, syncKeybinding: 'double-click', indicator: 'rectangle' });
});

test('invalid values fall back to the defaults; numbers are kept in range', () => {
  Object.assign(testHooks.config, {
    'typst-workshop.autoBuild.run': 'always',
    'typst-workshop.autoBuild.delay': -5,
    'typst-workshop.view.pdf.zoom': 'huge',
    'typst-workshop.view.pdf.scrollMode': 'sideways',
    'typst-workshop.view.pdf.invert': 7,
    'typst-workshop.sync.indicator': 'arrow',
    'typst-workshop.diagnostics.enabled': 'yes',
  });
  const c = readConfig();
  expect(c.autoBuildRun).toBe('onFileChange');
  expect(c.autoBuildDelay).toBe(0);
  expect(c.viewer.zoom).toBe('page-width');
  expect(c.viewer.scrollMode).toBe('vertical');
  expect(c.viewer.invert).toBe(1);
  expect(c.viewer.indicator).toBe('circle');
  expect(c.diagnosticsEnabled).toBe(true);
});
