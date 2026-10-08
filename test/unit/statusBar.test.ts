import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Project } from '../../src/project/project';
import { StatusBar } from '../../src/statusBar';
import { describeStatus, describeWordCount } from '../../src/statusText';
import { showWordCount } from '../../src/wordCount';
import { StatusBarAlignment, ThemeColor, testHooks } from './vscode-stub';

beforeEach(() => testHooks.reset());

describe('describeStatus', () => {
  test('status texts', () => {
    expect(describeStatus({ kind: 'building', entry: '/w/Manuscript.typ' }).text).toBe('$(sync~spin) Typst');
    const ok = describeStatus({ kind: 'ok', entry: '/w/Manuscript.typ', durationMs: 231, at: new Date(2026, 9, 7, 14, 2, 31), pageCount: 25 });
    expect(ok.text).toBe('$(check) Typst');
    expect(ok.tooltip).toBe('Manuscript.typ · built in 0.23 s at 14:02:31 · 25 pages');
    expect(describeStatus({ kind: 'failed', entry: '/w/M.typ', errors: 2 })).toMatchObject({ text: '$(error) Typst: 2 errors', error: true, command: 'workbench.actions.view.problems' });
    expect(describeStatus({ kind: 'failed', entry: '/w/M.typ', errors: 1 }).text).toBe('$(error) Typst: 1 error');
    expect(describeStatus({ kind: 'stopped' }).text).toBe('$(debug-stop) Typst');
    expect(describeWordCount({ total: 6543, files: [{ path: '/w/Sections/results.typ', words: 3210 }] }, '/w', 'Manuscript.pdf').text).toBe('6,543 words');
  });

  test('clicking opens the log except after a failure with errors', () => {
    expect(describeStatus({ kind: 'idle' })).toMatchObject({ error: false, command: 'typst-workshop.showLog' });
    expect(describeStatus({ kind: 'building', entry: '/w/M.typ' })).toMatchObject({ error: false, command: 'typst-workshop.showLog' });
    expect(describeStatus({ kind: 'ok', entry: '/w/M.typ', durationMs: 1, at: new Date(), pageCount: 1 })).toMatchObject({ error: false, command: 'typst-workshop.showLog' });
    expect(describeStatus({ kind: 'stopped' })).toMatchObject({ error: false, command: 'typst-workshop.showLog' });
    const helperFailure = describeStatus({ kind: 'failed', entry: '/w/M.typ', errors: 0, message: 'the helper exited (code 3)' });
    expect(helperFailure).toMatchObject({ text: '$(error) Typst', error: true, command: 'typst-workshop.showLog' });
    expect(helperFailure.tooltip).toContain('the helper exited (code 3)');
  });

  test('tooltips: one page, unknown page count, long builds, failures', () => {
    const at = new Date(2026, 0, 2, 3, 4, 5);
    expect(describeStatus({ kind: 'ok', entry: '/w/a.typ', durationMs: 12345, at, pageCount: 1 }).tooltip).toBe('a.typ · built in 12.35 s at 03:04:05 · 1 page');
    expect(describeStatus({ kind: 'ok', entry: '/w/a.typ', durationMs: 5, at, pageCount: null }).tooltip).toBe('a.typ · built in 0.01 s at 03:04:05');
    expect(describeStatus({ kind: 'failed', entry: '/w/a.typ', errors: 2 }).tooltip).toBe('a.typ · build failed with 2 errors');
    expect(describeStatus({ kind: 'building', entry: '/w/a.typ' }).tooltip).toBe('Building a.typ');
  });
});

describe('describeWordCount', () => {
  test('tooltip lists the top eight files relative to the root', () => {
    const files = Array.from({ length: 10 }, (_, k) => ({ path: `/w/Sections/s${k}.typ`, words: 1000 - k }));
    const r = describeWordCount({ total: 12345, files }, '/w', 'Manuscript.pdf');
    expect(r.text).toBe('12,345 words');
    const lines = r.tooltip.split('\n');
    expect(lines[0]).toBe('12,345 words in Manuscript.pdf');
    expect(lines.slice(1, 3)).toEqual(['Sections/s0.typ: 1,000', 'Sections/s1.typ: 999']);
    expect(lines).toHaveLength(1 + 8 + 1);
    expect(lines[9]).toBe('2 more files');
  });

  test('singular and empty', () => {
    expect(describeWordCount({ total: 1, files: [{ path: '/w/a.typ', words: 1 }] }, '/w', 'a.pdf')).toEqual({ text: '1 word', tooltip: '1 word in a.pdf\na.typ: 1' });
    expect(describeWordCount({ total: 0, files: [] }, '/w', 'a.pdf')).toEqual({ text: '0 words', tooltip: '0 words in a.pdf' });
  });
});

describe('StatusBar', () => {
  function makeBar(o: { viewer?: boolean; wordCount?: boolean } = {}) {
    const state = { viewer: o.viewer ?? false, wordCount: o.wordCount ?? true };
    const bar = new StatusBar({ isViewerActive: () => state.viewer, wordCountEnabled: () => state.wordCount });
    const [build, words] = testHooks.statusBarItems;
    return { bar, build, words, state };
  }

  test('a build item on the left and a word count item on the right', () => {
    const { build, words } = makeBar();
    expect(build.alignment).toBe(StatusBarAlignment.Left);
    expect(words.alignment).toBe(StatusBarAlignment.Right);
    expect(words.command).toBe('typst-workshop.wordCount');
  });

  test('the build item shows for Typst editors, the PDF tab, running and failed builds', () => {
    const { bar, build, state } = makeBar();
    expect(build.visible).toBe(false);
    testHooks.setActiveEditor(testHooks.editor('/w/a.typ'));
    expect(build.visible).toBe(true);
    testHooks.setActiveEditor(testHooks.editor('/w/notes.md'));
    expect(build.visible).toBe(false);
    bar.update({ kind: 'building', entry: '/w/a.typ' });
    expect(build.visible).toBe(true);
    bar.update({ kind: 'failed', entry: '/w/a.typ', errors: 3 });
    expect(build.visible).toBe(true);
    expect(build.text).toBe('$(error) Typst: 3 errors');
    expect(build.backgroundColor).toEqual(new ThemeColor('statusBarItem.errorBackground'));
    expect(build.command).toBe('workbench.actions.view.problems');
    bar.update({ kind: 'ok', entry: '/w/a.typ', durationMs: 10, at: new Date(), pageCount: 2 });
    expect(build.visible).toBe(false);
    expect(build.backgroundColor).toBeUndefined();
    state.viewer = true;
    bar.refreshVisibility();
    expect(build.visible).toBe(true);
  });

  test('the word count item needs a count, the setting and a Typst editor or the PDF tab', () => {
    const { bar, words, state } = makeBar();
    testHooks.setActiveEditor(testHooks.editor('/w/a.typ'));
    expect(words.visible).toBe(false);
    bar.setWordCount({ total: 6543, files: [] }, '/w', 'a.pdf');
    expect(words.visible).toBe(true);
    expect(words.text).toBe('6,543 words');
    state.wordCount = false;
    bar.refreshVisibility();
    expect(words.visible).toBe(false);
    state.wordCount = true;
    testHooks.setActiveEditor(undefined);
    expect(words.visible).toBe(false);
    testHooks.setActiveEditor(testHooks.editor('/w/a.typ'));
    bar.setWordCount(undefined);
    expect(words.visible).toBe(false);
  });

  test('flash shows a status bar message for 3 s; dispose removes the items', () => {
    const { bar, build, words } = makeBar();
    bar.flash('No source found at this point');
    expect(testHooks.statusMessages).toEqual([{ text: 'No source found at this point', timeout: 3000 }]);
    bar.dispose();
    expect(build.disposed && words.disposed).toBe(true);
  });
});

describe('showWordCount', () => {
  function fakeProject(o: { ensured: boolean }) {
    return {
      pdf: '/w/Manuscript.pdf',
      ensureBuilt: vi.fn(async (_trigger: string) => o.ensured),
      wordCount: vi.fn(async () => ({ total: 6543, files: [{ path: '/w/Sections/results.typ', words: 3210 }, { path: '/w/Manuscript.typ', words: 1 }] })),
    };
  }

  test('quick pick titled with the total, one item per file; picking opens the file', async () => {
    const project = fakeProject({ ensured: true });
    testHooks.quickPickAnswer = (items) => items[0];
    await showWordCount(project as unknown as Project, '/w');
    expect(project.ensureBuilt).toHaveBeenCalledWith('word count');
    const [pick] = testHooks.quickPicks;
    expect(pick.options?.title).toBe('6,543 words in Manuscript.pdf');
    expect(pick.items).toMatchObject([
      { label: 'Sections/results.typ', description: '3,210 words' },
      { label: 'Manuscript.typ', description: '1 word' },
    ]);
    expect(testHooks.shownDocuments.map((d) => d.uri.fsPath)).toEqual(['/w/Sections/results.typ']);
  });

  test('without a successful build, a status note instead of a popup', async () => {
    const failing = fakeProject({ ensured: false });
    await showWordCount(failing as unknown as Project, '/w');
    expect(failing.wordCount).not.toHaveBeenCalled();
    expect(testHooks.quickPicks).toEqual([]);
    expect(testHooks.messages).toEqual([]);
    expect(testHooks.statusMessages).toEqual([{ text: 'No word count: the build failed', timeout: 3000 }]);
  });
});
