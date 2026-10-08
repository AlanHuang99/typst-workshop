import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { PdfRect, SourceLocation } from '../../src/helper/protocol';
import { memoryLogger } from '../../src/log';
import { chooseSourceColumn, inverseSearch, revealSource, syncAfterBuild, syncToPdf, type SyncDeps } from '../../src/navigation';
import type { ProjectManager } from '../../src/project/manager';
import type { Project } from '../../src/project/project';
import { FakeTextEditor, Position, Selection, TextEditorRevealType, ThemeColor, testHooks } from './vscode-stub';

beforeEach(() => testHooks.reset());
afterEach(() => vi.useRealTimers());

const rect: PdfRect = { page: 2, left: 72, bottom: 700, right: 140, top: 688, x: 80, y: 694 };

/** A project whose `ensureBuilt` answers `ensured` (default true). */
function fakeProject(o: { entry?: string; deps?: string[]; ensured?: boolean; positions?: PdfRect[]; location?: SourceLocation | null } = {}) {
  return {
    entry: o.entry ?? '/w/main.typ',
    pdf: (o.entry ?? '/w/main.typ').replace(/\.typ$/, '.pdf'),
    dependencies: new Set(o.deps ?? ['/w/main.typ', '/w/a.typ']),
    ensureBuilt: vi.fn(async (_trigger: string) => o.ensured ?? true),
    forward: vi.fn(async () => ({ positions: o.positions ?? [rect] })),
    inverse: vi.fn(async () => (o.location === undefined ? { path: '/w/a.typ', line: 0, character: 0 } : o.location)),
  };
}

type FakeProject = ReturnType<typeof fakeProject>;

function managerWith(project: FakeProject | undefined) {
  return {
    mostRecentFor: vi.fn((file: string) => (project && (project.entry === file || project.dependencies.has(file)) ? project : undefined)),
    getOrCreate: vi.fn((entry: string) => fakeProject({ entry, deps: [entry] })),
  };
}

function viewers(open = true) {
  return { open: vi.fn(async () => ({}) as never), forward: vi.fn(), isOpen: vi.fn(() => open) };
}

function editorAt(file: string, line: number, character: number): FakeTextEditor {
  const e = testHooks.editor(file);
  e.selection = new Selection(new Position(line, character), new Position(line, character));
  return e;
}

function syncDeps(over: Partial<SyncDeps> & { project?: FakeProject }): SyncDeps & { flashes: string[] } {
  const flashes: string[] = [];
  return Object.assign(
    {
      editor: editorAt('/w/a.typ', 3, 7) as never,
      projects: managerWith(over.project) as unknown as ProjectManager,
      resolveManual: vi.fn(async () => undefined),
      viewers: viewers() as never,
      indicator: () => 'circle' as const,
      flash: (m: string) => flashes.push(m),
      logger: memoryLogger(),
    },
    over,
    { flashes },
  );
}

describe('chooseSourceColumn', () => {
  test('source column choice', () => {
    expect(chooseSourceColumn({ lastTypstColumn: 1, visibleColumns: [1, 2], viewerColumn: 2 })).toBe(1);
    expect(chooseSourceColumn({ lastTypstColumn: 2, visibleColumns: [1, 2], viewerColumn: 2 })).toBe(1);
    expect(chooseSourceColumn({ visibleColumns: [2], viewerColumn: 2 })).toBe(1);
  });

  test('the last Typst column must still be visible; other groups are taken in order', () => {
    expect(chooseSourceColumn({ lastTypstColumn: 3, visibleColumns: [1, 2], viewerColumn: 2 })).toBe(1);
    expect(chooseSourceColumn({ lastTypstColumn: 3, visibleColumns: [3, 1, 2], viewerColumn: 1 })).toBe(3);
    expect(chooseSourceColumn({ visibleColumns: [3, 2, 1], viewerColumn: 1 })).toBe(2);
    expect(chooseSourceColumn({ lastTypstColumn: 2, visibleColumns: [1, 2] })).toBe(2);
    expect(chooseSourceColumn({ visibleColumns: [] })).toBe(1);
  });
});

describe('syncToPdf', () => {
  test('forward lookup at the cursor, PDF opened beside without taking focus, positions posted', async () => {
    const project = fakeProject();
    const d = syncDeps({ project });
    await syncToPdf(d);
    expect(project.forward).toHaveBeenCalledWith({ path: '/w/a.typ', line: 3, character: 7 });
    expect(d.viewers.open).toHaveBeenCalledWith('/w/main.pdf', { preserveFocus: true, beside: true });
    expect(d.viewers.forward).toHaveBeenCalledWith('/w/main.pdf', [rect], 'circle');
    expect(project.ensureBuilt).toHaveBeenCalledWith('show in PDF');
  });

  test('a file no project uses gets its entry from resolveEntry (manual)', async () => {
    const d = syncDeps({ project: undefined, resolveManual: vi.fn(async () => '/w/other.typ') });
    await syncToPdf(d);
    expect(d.resolveManual).toHaveBeenCalledWith('/w/a.typ');
    expect((d.projects as unknown as ReturnType<typeof managerWith>).getOrCreate).toHaveBeenCalledWith('/w/other.typ');
    expect(d.viewers.forward).toHaveBeenCalledWith('/w/other.pdf', [rect], 'circle');
  });

  test('the lookup needs a successful build; without one, a note in the status bar', async () => {
    const broken = fakeProject({ ensured: false });
    const d = syncDeps({ project: broken });
    await syncToPdf(d);
    expect(broken.ensureBuilt).toHaveBeenCalledWith('show in PDF');
    expect(broken.forward).not.toHaveBeenCalled();
    expect(d.viewers.open).not.toHaveBeenCalled();
    expect(d.flashes).toEqual(['No PDF position for the cursor']);
  });

  test('no positions: a status message, no tab', async () => {
    const d = syncDeps({ project: fakeProject({ positions: [] }) });
    await syncToPdf(d);
    expect(d.flashes).toEqual(['No PDF position for the cursor']);
    expect(d.viewers.open).not.toHaveBeenCalled();
  });

  test('a failing lookup is a status message, not an error', async () => {
    const project = fakeProject();
    project.forward.mockRejectedValueOnce(new Error('the helper exited (code 3)'));
    const d = syncDeps({ project });
    await expect(syncToPdf(d)).resolves.toBeUndefined();
    expect(d.flashes).toEqual(['No PDF position for the cursor']);
  });

  test('nothing happens without a Typst editor', async () => {
    const none = syncDeps({ project: fakeProject(), editor: undefined });
    await syncToPdf(none);
    const md = syncDeps({ project: fakeProject(), editor: testHooks.editor('/w/notes.md') as never });
    await syncToPdf(md);
    expect(none.viewers.open).not.toHaveBeenCalled();
    expect(md.viewers.open).not.toHaveBeenCalled();
  });
});

describe('syncAfterBuild', () => {
  test('posts the cursor position to an open tab without opening or focusing anything', async () => {
    const project = fakeProject();
    const v = viewers(true);
    await syncAfterBuild({ project: project as unknown as Project, editor: editorAt('/w/a.typ', 1, 2) as never, viewers: v as never, indicator: () => 'rectangle', logger: memoryLogger() });
    expect(v.forward).toHaveBeenCalledWith('/w/main.pdf', [rect], 'rectangle');
    expect(v.open).not.toHaveBeenCalled();
  });

  test('a failing lookup after the build is logged as a warning', async () => {
    const project = fakeProject();
    project.forward.mockRejectedValueOnce(new Error('no successful compilation yet'));
    const v = viewers(true);
    const logger = memoryLogger();
    await syncAfterBuild({ project: project as unknown as Project, editor: editorAt('/w/a.typ', 1, 2) as never, viewers: v as never, indicator: () => 'circle', logger });
    expect(v.forward).not.toHaveBeenCalled();
    expect(logger.lines).toEqual(['warn Forward lookup after the build failed: no successful compilation yet']);
  });

  test('skips when the tab is closed, the file is not part of the project, or nothing is found', async () => {
    const closed = viewers(false);
    await syncAfterBuild({ project: fakeProject() as unknown as Project, editor: editorAt('/w/a.typ', 0, 0) as never, viewers: closed as never, indicator: () => 'circle', logger: memoryLogger() });
    const other = viewers(true);
    await syncAfterBuild({ project: fakeProject() as unknown as Project, editor: editorAt('/w/elsewhere.typ', 0, 0) as never, viewers: other as never, indicator: () => 'circle', logger: memoryLogger() });
    const empty = viewers(true);
    await syncAfterBuild({ project: fakeProject({ positions: [] }) as unknown as Project, editor: editorAt('/w/a.typ', 0, 0) as never, viewers: empty as never, indicator: () => 'circle', logger: memoryLogger() });
    expect(closed.forward).not.toHaveBeenCalled();
    expect(other.forward).not.toHaveBeenCalled();
    expect(empty.forward).not.toHaveBeenCalled();
  });
});

describe('revealSource and inverseSearch', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-nav-'));
    fs.writeFileSync(path.join(dir, 'a b.typ'), 'first line\nsecond line here\nthird\n');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('cursor at the position, line revealed in the centre if outside the viewport, whole line highlighted for 600 ms', async () => {
    vi.useFakeTimers();
    const file = path.join(dir, 'a b.typ');
    await revealSource({ path: file, line: 1, character: 7 }, 1);
    const [shown] = testHooks.shownDocuments;
    expect(shown.uri.fsPath).toBe(file);
    expect(shown.options).toMatchObject({ viewColumn: 1, preserveFocus: false });
    const editor = shown.editor!;
    expect(editor.selection.active).toEqual(new Position(1, 7));
    expect(editor.reveals[0].type).toBe(TextEditorRevealType.InCenterIfOutsideViewport);
    const [type] = testHooks.decorationTypes;
    expect(type.options).toMatchObject({ isWholeLine: true, backgroundColor: new ThemeColor('editor.rangeHighlightBackground') });
    expect(editor.decorations[0].ranges[0].start.line).toBe(1);
    vi.advanceTimersByTime(599);
    expect(type.disposed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(type.disposed).toBe(true);
  });

  test('a stale position past the end lands on the last line', async () => {
    const file = path.join(dir, 'a b.typ');
    await revealSource({ path: file, line: 40, character: 99 }, 2);
    const editor = testHooks.shownDocuments[0].editor!;
    expect(editor.selection.active).toEqual(new Position(3, 0));
  });

  test('inverse: the owning project answers and the source opens in the chosen column', async () => {
    const file = path.join(dir, 'a b.typ');
    const project = fakeProject({ location: { path: file, line: 2, character: 3 } });
    const flashes: string[] = [];
    await inverseSearch('/w/main.pdf', { page: 1, x: 10, y: 20 }, { projectFor: () => project as unknown as Project, column: () => 1, flash: (m) => flashes.push(m), logger: memoryLogger() });
    expect(project.inverse).toHaveBeenCalledWith({ page: 1, x: 10, y: 20 });
    expect(testHooks.shownDocuments[0].editor!.selection.active).toEqual(new Position(2, 3));
    expect(flashes).toEqual([]);
  });

  test('inverse: nothing found, no project, or a failing helper give the status message', async () => {
    const flashes: string[] = [];
    const deps = (p: unknown) => ({ projectFor: () => p as Project | undefined, column: () => 1, flash: (m: string) => flashes.push(m), logger: memoryLogger() });
    await inverseSearch('/w/main.pdf', { page: 1, x: 0, y: 0 }, deps(fakeProject({ location: null })));
    await inverseSearch('/w/main.pdf', { page: 1, x: 0, y: 0 }, deps(undefined));
    const failing = fakeProject();
    failing.inverse.mockRejectedValueOnce(new Error('timeout'));
    await inverseSearch('/w/main.pdf', { page: 1, x: 0, y: 0 }, deps(failing));
    expect(flashes).toEqual(['No source found at this point', 'No source found at this point', 'No source found at this point']);
    expect(testHooks.shownDocuments).toEqual([]);
  });

  test('inverse needs a successful build (a tab restored after a restart); without one, the status note', async () => {
    const project = fakeProject({ location: null });
    const flashes: string[] = [];
    const deps = (p: FakeProject) => ({ projectFor: () => p as unknown as Project, column: () => 1, flash: (m: string) => flashes.push(m), logger: memoryLogger() });
    await inverseSearch('/w/main.pdf', { page: 1, x: 0, y: 0 }, deps(project));
    expect(project.ensureBuilt).toHaveBeenCalledWith('inverse');
    expect(project.inverse).toHaveBeenCalledTimes(1);
    const unbuilt = fakeProject({ ensured: false });
    flashes.length = 0;
    await inverseSearch('/w/main.pdf', { page: 1, x: 0, y: 0 }, deps(unbuilt));
    expect(unbuilt.inverse).not.toHaveBeenCalled();
    expect(flashes).toEqual(['No source found at this point']);
  });
});
