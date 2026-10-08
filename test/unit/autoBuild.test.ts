import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AutoBuild, type AutoBuildRun } from '../../src/build/autoBuild';
import { memoryLogger } from '../../src/log';
import { ProjectManager } from '../../src/project/manager';
import { Project } from '../../src/project/project';
import { RelativePattern, Uri, testHooks } from './vscode-stub';

let auto: AutoBuild | undefined;
let manager: ProjectManager;
let mode: AutoBuildRun;
let resolveAuto: ReturnType<typeof vi.fn<(file: string) => Promise<string | undefined>>>;
let entryForPdf: ReturnType<typeof vi.fn<(pdf: string) => Promise<string | undefined>>>;
let typstChanged: string[];
let log: ReturnType<typeof memoryLogger>;

/** Projects whose automatic builds are only recorded. */
function makeManager(): ProjectManager {
  return new ProjectManager((entry) => {
    const project = new Project(
      { entry, root: '/w', pdf: entry.replace(/\.typ$/, '.pdf'), fontPaths: [], inputs: {} },
      {
        createClient: () => {
          throw new Error('no helper in this test');
        },
        logger: memoryLogger(),
        delayMs: () => 0,
      },
    );
    vi.spyOn(project, 'requestAuto').mockImplementation(() => {});
    return project;
  });
}

function project(entry: string, deps: string[]): Project {
  const p = manager.getOrCreate(entry);
  p.dependencies = new Set(deps);
  return p;
}

function start(): AutoBuild {
  auto = new AutoBuild({
    projects: manager,
    resolveAuto: (f) => resolveAuto(f),
    entryForPdf: (p) => entryForPdf(p),
    mode: () => mode,
    logger: log,
    onTypstFileChanged: (f) => typstChanged.push(f),
  });
  return auto;
}

const watcherOf = (base: string) => {
  const ws = testHooks.watchersOn(base);
  expect(ws).toHaveLength(1);
  return ws[0];
};

beforeEach(() => {
  testHooks.reset();
  testHooks.setWorkspaceFolders(['/w']);
  manager = makeManager();
  mode = 'onFileChange';
  resolveAuto = vi.fn(async () => undefined);
  entryForPdf = vi.fn(async () => undefined);
  typstChanged = [];
  log = memoryLogger();
});

afterEach(async () => {
  auto?.dispose();
  auto = undefined;
  vi.useRealTimers();
  await manager.disposeAll();
});

describe('saves', () => {
  test('a saved dependency triggers every project that uses it', () => {
    const a = project('/w/a.typ', ['/w/a.typ', '/w/refs.bib']);
    const b = project('/w/b.typ', ['/w/b.typ', '/w/refs.bib']);
    const c = project('/w/c.typ', ['/w/c.typ']);
    start();
    testHooks.save('/w/refs.bib');
    expect(a.requestAuto).toHaveBeenCalledWith('save');
    expect(b.requestAuto).toHaveBeenCalledWith('save');
    expect(c.requestAuto).not.toHaveBeenCalled();
    expect(resolveAuto).not.toHaveBeenCalled();
  });

  test('a saved Typst file that no project uses is resolved and its entry built', async () => {
    resolveAuto.mockResolvedValue('/w/main.typ');
    start();
    testHooks.save('/w/Sections/new.typ');
    await vi.waitFor(() => expect(manager.get('/w/main.typ')?.requestAuto).toHaveBeenCalledWith('save'));
    expect(resolveAuto).toHaveBeenCalledWith('/w/Sections/new.typ');
    expect(typstChanged).toEqual(['/w/Sections/new.typ']);
  });

  test('no entry, or a non-Typst file outside every project, builds nothing', async () => {
    start();
    testHooks.save('/w/notes.txt');
    testHooks.save('/w/lonely.typ');
    await vi.waitFor(() => expect(resolveAuto).toHaveBeenCalledTimes(1));
    expect(resolveAuto).toHaveBeenCalledWith('/w/lonely.typ');
    expect(manager.all()).toEqual([]);
  });

  test('saves of non-file documents are ignored', () => {
    start();
    testHooks.saveUri(Uri.parse('untitled:Untitled-1'));
    expect(resolveAuto).not.toHaveBeenCalled();
    expect(typstChanged).toEqual([]);
  });

  test('onSave mode builds on saves only; never mode builds nothing', () => {
    const a = project('/w/a.typ', ['/w/a.typ', '/w/data.csv']);
    mode = 'onSave';
    start();
    testHooks.save('/w/data.csv');
    expect(a.requestAuto).toHaveBeenCalledWith('save');
    watcherOf('/w').fire('change', '/w/data.csv');
    vi.useFakeTimers();
    vi.advanceTimersByTime(5000);
    watcherOf('/w').fire('change', '/w/data.csv');
    expect(a.requestAuto).toHaveBeenCalledTimes(1);

    mode = 'never';
    testHooks.save('/w/a.typ');
    expect(a.requestAuto).toHaveBeenCalledTimes(1);
    expect(resolveAuto).not.toHaveBeenCalled();
  });
});

describe('file watching', () => {
  test('one recursive watcher per workspace folder', () => {
    testHooks.setWorkspaceFolders(['/w', '/v']);
    start();
    expect(watcherOf('/w').pattern).toBeInstanceOf(RelativePattern);
    expect((watcherOf('/w').pattern as RelativePattern).pattern).toBe('**/*');
    expect(watcherOf('/v')).toBeDefined();
    testHooks.setWorkspaceFolders(['/v']);
    expect(testHooks.watchersOn('/w')).toEqual([]);
    expect(watcherOf('/v')).toBeDefined();
  });

  test('changes, creations and deletions of a dependency trigger its projects', () => {
    const a = project('/w/a.typ', ['/w/a.typ', '/w/data.csv', '/w/missing.typ']);
    const b = project('/w/b.typ', ['/w/b.typ']);
    start();
    const w = watcherOf('/w');
    w.fire('change', '/w/data.csv');
    w.fire('create', '/w/missing.typ');
    w.fire('delete', '/w/data.csv');
    w.fire('change', '/w/unrelated.png');
    expect(a.requestAuto).toHaveBeenCalledTimes(3);
    expect(a.requestAuto).toHaveBeenCalledWith('file change');
    expect(b.requestAuto).not.toHaveBeenCalled();
  });

  describe('the watcher event caused by a save', () => {
    let dir: string;
    let data: string;
    let a: Project;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-echo-'));
      data = path.join(dir, 'data.csv');
      fs.writeFileSync(data, '1\n');
      testHooks.setWorkspaceFolders([dir]);
      a = project(path.join(dir, 'a.typ'), [path.join(dir, 'a.typ'), data]);
      start();
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('is not a second request', () => {
      testHooks.save(data);
      watcherOf(dir).fire('change', data);
      watcherOf(dir).fire('change', data);
      expect(a.requestAuto).toHaveBeenCalledTimes(1);
      expect(a.requestAuto).toHaveBeenCalledWith('save');
    });

    test('another program rewriting the file right after the save still triggers a build', () => {
      testHooks.save(data);
      fs.writeFileSync(data, '1\n2\n');
      watcherOf(dir).fire('change', data);
      expect(a.requestAuto).toHaveBeenCalledTimes(2);
      expect(a.requestAuto).toHaveBeenLastCalledWith('file change');
      testHooks.save(data);
      const later = new Date(Date.now() + 5000);
      fs.writeFileSync(data, '3\n4\n');
      fs.utimesSync(data, later, later);
      watcherOf(dir).fire('change', data);
      expect(a.requestAuto).toHaveBeenCalledTimes(4);
      expect(a.requestAuto).toHaveBeenLastCalledWith('file change');
    });

    test('old saves are forgotten on the next save (the record does not grow in onSave mode)', () => {
      mode = 'onSave';
      vi.useFakeTimers();
      const files = Array.from({ length: 20 }, (_, k) => path.join(dir, `f${k}.typ`));
      for (const f of files) fs.writeFileSync(f, '');
      for (const f of files) testHooks.save(f);
      const recorded = () => (auto as unknown as { recentSaves: Map<string, unknown> }).recentSaves.size;
      expect(recorded()).toBe(20);
      vi.advanceTimersByTime(6000);
      testHooks.save(files[0]);
      expect(recorded()).toBe(1);
    });

    test('a Typst file that no project uses is resolved once for its save and the watcher event of that save', async () => {
      const fresh = path.join(dir, 'fresh.typ');
      const main = path.join(dir, 'main.typ');
      fs.writeFileSync(fresh, 'Fresh.');
      resolveAuto.mockResolvedValue(main);
      testHooks.save(fresh);
      watcherOf(dir).fire('change', fresh);
      await vi.waitFor(() => expect(manager.get(main)?.requestAuto).toHaveBeenCalledWith('save'));
      expect(resolveAuto).toHaveBeenCalledTimes(1);
      expect(manager.get(main)?.requestAuto).toHaveBeenCalledTimes(1);
    });

    test('a file that could not be read at save time, or an old save, does not hide a change', () => {
      const ghost = path.join(dir, 'ghost.csv');
      a.dependencies.add(ghost);
      testHooks.save(ghost);
      watcherOf(dir).fire('create', ghost);
      watcherOf(dir).fire('change', ghost);
      expect(a.requestAuto).toHaveBeenCalledTimes(3);
      vi.useFakeTimers();
      testHooks.save(data);
      vi.advanceTimersByTime(6000);
      watcherOf(dir).fire('change', data);
      expect(a.requestAuto).toHaveBeenCalledTimes(5);
      expect(a.requestAuto).toHaveBeenLastCalledWith('file change');
    });
  });

  test('a project whose output is among its dependencies is not triggered by its own PDF', () => {
    const a = project('/w/a.typ', ['/w/a.typ', '/w/a.pdf']);
    start();
    watcherOf('/w').fire('change', '/w/a.pdf');
    expect(a.requestAuto).not.toHaveBeenCalled();
  });

  test('Typst file events reach the include-scan cache in every mode', () => {
    mode = 'never';
    start();
    const w = watcherOf('/w');
    w.fire('create', '/w/x.typ');
    w.fire('delete', '/w/y.typ');
    w.fire('change', '/w/z.typ');
    w.fire('change', '/w/data.csv');
    testHooks.save('/w/s.typ');
    testHooks.rename('/w/old.typ', '/w/new.typ');
    expect(typstChanged).toEqual(['/w/x.typ', '/w/y.typ', '/w/z.typ', '/w/s.typ', '/w/old.typ', '/w/new.typ']);
  });

  test('dependencies outside the workspace folders get their own watchers, refreshed after builds', () => {
    const a = project('/w/a.typ', ['/w/a.typ', '/ext/lib/x.typ', '/ext/lib/y.bib', '/ext/fonts/z.typ']);
    const auto = start();
    auto.refreshExternalWatchers();
    const lib = watcherOf('/ext/lib');
    expect((lib.pattern as RelativePattern).pattern).toBe('*');
    expect(watcherOf('/ext/fonts')).toBeDefined();
    lib.fire('change', '/ext/lib/y.bib');
    expect(a.requestAuto).toHaveBeenCalledWith('file change');

    a.dependencies = new Set(['/w/a.typ', '/ext/lib/x.typ']);
    auto.refreshExternalWatchers();
    expect(watcherOf('/ext/lib')).toBe(lib);
    expect(testHooks.watchersOn('/ext/fonts')).toEqual([]);
  });

  test('an entry outside every workspace folder is watched through its folder', () => {
    testHooks.setWorkspaceFolders([]);
    const s = project('/s/paper.typ', ['/s/paper.typ']);
    const auto = start();
    auto.refreshExternalWatchers();
    watcherOf('/s').fire('change', '/s/paper.typ');
    expect(s.requestAuto).toHaveBeenCalledWith('file change');
  });

  test('with onFileChange, a Typst file that no project contains, changed or created on disk, is resolved like a save', async () => {
    resolveAuto.mockResolvedValue('/w/main.typ');
    start();
    const w = watcherOf('/w');
    w.fire('change', '/w/Sections/results.typ');
    await vi.waitFor(() => expect(manager.get('/w/main.typ')?.requestAuto).toHaveBeenCalledWith('file change'));
    w.fire('create', '/w/Sections/new.typ');
    await vi.waitFor(() => expect(resolveAuto).toHaveBeenCalledTimes(2));
    expect(resolveAuto.mock.calls.map((c) => c[0])).toEqual(['/w/Sections/results.typ', '/w/Sections/new.typ']);
  });

  test('deletions, other files, Typst files in hidden folders or node_modules, and changes in onSave or never mode are not resolved', async () => {
    resolveAuto.mockResolvedValue('/w/main.typ');
    start();
    const w = watcherOf('/w');
    w.fire('delete', '/w/old.typ');
    w.fire('change', '/w/data.csv');
    w.fire('change', '/w/.cache/copies/main.typ');
    w.fire('create', '/w/node_modules/pkg/lib.typ');
    mode = 'onSave';
    w.fire('change', '/w/Sections/results.typ');
    mode = 'never';
    w.fire('create', '/w/Sections/new.typ');
    await new Promise((r) => setTimeout(r, 20));
    expect(resolveAuto).not.toHaveBeenCalled();
    expect(manager.all()).toEqual([]);
  });

  test('dispose removes every watcher and listener', () => {
    project('/w/a.typ', ['/w/a.typ', '/ext/x.typ']);
    const auto = start();
    auto.refreshExternalWatchers();
    auto.dispose();
    expect(testHooks.watchers.every((w) => w.disposed)).toBe(true);
    testHooks.save('/w/a.typ');
    expect(manager.get('/w/a.typ')?.requestAuto).not.toHaveBeenCalled();
  });
});

describe('after a window reload, before any save', () => {
  test('activation builds the project of the active Typst editor once', async () => {
    resolveAuto.mockResolvedValue('/w/main.typ');
    const auto = start();
    await auto.start(testHooks.editor('/w/Sections/a.typ') as never);
    expect(resolveAuto).toHaveBeenCalledWith('/w/Sections/a.typ');
    expect(manager.get('/w/main.typ')?.requestAuto).toHaveBeenCalledTimes(1);
    expect(manager.get('/w/main.typ')?.requestAuto).toHaveBeenCalledWith('start');
  });

  test('activation builds nothing with autoBuild.run never, without an editor, or in a file of another language', async () => {
    resolveAuto.mockResolvedValue('/w/main.typ');
    const auto = start();
    mode = 'never';
    await auto.start(testHooks.editor('/w/main.typ') as never);
    mode = 'onSave';
    await auto.start(undefined);
    await auto.start(testHooks.editor('/w/notes.txt') as never);
    expect(resolveAuto).not.toHaveBeenCalled();
    expect(manager.all()).toEqual([]);
  });

  test('a restored PDF tab builds the entry that writes its PDF once', async () => {
    entryForPdf.mockResolvedValue('/w/main.typ');
    const auto = start();
    await auto.restoredTab('/w/main.pdf');
    expect(entryForPdf).toHaveBeenCalledWith('/w/main.pdf');
    expect(manager.get('/w/main.typ')?.requestAuto).toHaveBeenCalledTimes(1);
    expect(manager.get('/w/main.typ')?.requestAuto).toHaveBeenCalledWith('restored tab');
  });

  test('a restored tab of a PDF that an open project writes builds that project', async () => {
    const paper = project('/w/paper.typ', ['/w/paper.typ']);
    const auto = start();
    await auto.restoredTab('/w/paper.pdf');
    expect(paper.requestAuto).toHaveBeenCalledWith('restored tab');
    expect(entryForPdf).not.toHaveBeenCalled();
  });

  test('a restored tab builds nothing when no Typst file writes its PDF, or with autoBuild.run never', async () => {
    const auto = start();
    await auto.restoredTab('/w/lost.pdf');
    expect(manager.all()).toEqual([]);
    expect(log.lines.some((l) => l.includes('/w/lost.pdf'))).toBe(true);
    mode = 'never';
    entryForPdf.mockResolvedValue('/w/main.typ');
    await auto.restoredTab('/w/main.pdf');
    expect(entryForPdf).toHaveBeenCalledTimes(1);
    expect(manager.all()).toEqual([]);
  });
});
