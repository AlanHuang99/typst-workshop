import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { HelperClient } from '../../src/helper/client';
import { memoryLogger } from '../../src/log';
import { inverseSearch } from '../../src/navigation';
import { ProjectManager } from '../../src/project/manager';
import { Project, type BuildOutcome, type ProjectPaths } from '../../src/project/project';
import { statusAfterBuild } from '../../src/statusText';
import { testHooks } from './vscode-stub';

const fake = fileURLToPath(new URL('./fixtures/fakeHelper.mjs', import.meta.url));
const live: (Project | ProjectManager)[] = [];

afterEach(async () => {
  await Promise.all(live.splice(0).map((x) => (x instanceof Project ? x.dispose() : x.disposeAll())));
});

function pathsFor(entry: string): ProjectPaths {
  return { entry, root: '/w', pdf: entry.replace(/\.typ$/, '.pdf'), fontPaths: ['/w/fonts'], inputs: { mode: 'draft' } };
}

/** A project over the fake helper; `clients` collects every client it creates, the last one being current. */
function makeProject(entry = '/w/main.typ', deps = '/w/main.typ:/w/a.typ:/w/b.typ', extra: { delayMs?: number; preflight?: () => string | undefined; env?: Record<string, string> } = {}) {
  const logger = memoryLogger();
  const clients: HelperClient[] = [];
  const createClient = vi.fn(() => {
    const c = new HelperClient({ command: process.execPath, args: [fake], logger, env: { ...process.env, FAKE_DEPS: deps, ...extra.env } });
    clients.push(c);
    return c;
  });
  const project = new Project(pathsFor(entry), { createClient, logger, delayMs: () => extra.delayMs ?? 0, preflight: extra.preflight });
  live.push(project);
  const stats = () => clients[clients.length - 1].request('stats' as any, {} as any) as Promise<any>;
  const configure = (o: object) => clients[clients.length - 1].request('configure' as any, o as any);
  return { project, clients, createClient, logger, stats, configure };
}

describe('Project', () => {
  test('project build stores dependencies and initializes once', async () => {
    const { project, stats } = makeProject('/w/main.typ', '/w/a.typ:/w/b.typ');
    const first = await project.buildNow('manual');
    expect(first.result?.success).toBe(true);
    const second = await project.buildNow('manual');
    expect(second.result?.success).toBe(true);
    expect(project.dependencies).toEqual(new Set(['/w/a.typ', '/w/b.typ']));
    expect(project.hasSuccessfulBuild()).toBe(true);
    expect(project.lastSuccessAt).toBeInstanceOf(Date);
    const s = await stats();
    expect(s).toMatchObject({ initialize: 1, compile: 2 });
    expect(s.lastInitialize).toEqual({ root: '/w', main: '/w/main.typ', output: '/w/main.pdf', fontPaths: ['/w/fonts'], inputs: { mode: 'draft' } });
  });

  test('re-initializes after the helper crashed', async () => {
    const { project, clients, stats } = makeProject();
    await project.buildNow('manual');
    await clients[0].request('crash' as any, {} as any).catch(() => undefined);
    expect(project.hasSuccessfulBuild()).toBe(false);
    const again = await project.buildNow('manual');
    expect(again.result?.success).toBe(true);
    expect(clients).toHaveLength(1);
    expect(await stats()).toMatchObject({ initialize: 1, compile: 1 });
  });

  test('stop kills a hanging build and the next build starts a new helper', async () => {
    const { project, stats, configure } = makeProject();
    await project.buildNow('manual');
    await configure({ delayMs: 60000 });
    const hanging = project.buildNow('manual');
    await vi.waitFor(() => expect(project.building).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    project.stop();
    const stopped = await hanging;
    expect(stopped).toMatchObject({ stopped: true });
    expect(stopped.result).toBeUndefined();
    const next = await project.buildNow('manual');
    expect(next.result?.success).toBe(true);
    expect(await stats()).toMatchObject({ initialize: 1, compile: 1 });
  });

  test('automatic requests within the quiet period make one build carrying both triggers', async () => {
    const { project } = makeProject('/w/main.typ', '/w/main.typ', { delayMs: 50 });
    const starts: string[] = [];
    const builds: BuildOutcome[] = [];
    project.onDidStartBuild((e) => starts.push(e.trigger));
    project.onDidBuild((e) => builds.push(e.outcome));
    project.requestAuto('save');
    project.requestAuto('file change');
    project.requestAuto('save');
    await vi.waitFor(() => expect(builds).toHaveLength(1));
    expect(starts).toEqual(['save, file change']);
    expect(builds[0].trigger).toBe('save, file change');
    await new Promise((r) => setTimeout(r, 150));
    expect(builds).toHaveLength(1);
  });

  test('a failed build adds to the dependency set and keeps the last good document', async () => {
    const { project, configure } = makeProject('/w/main.typ', '/w/main.typ:/w/a.typ');
    await project.buildNow('manual');
    const success = project.lastSuccessAt;
    await configure({ fail: true, deps: ['/w/main.typ', '/w/c.typ'] });
    const failed = await project.buildNow('manual');
    expect(failed.result?.success).toBe(false);
    expect(failed.result?.diagnostics).toHaveLength(1);
    expect(project.dependencies).toEqual(new Set(['/w/main.typ', '/w/a.typ', '/w/c.typ']));
    expect(project.lastSuccessAt).toBe(success);
    expect(project.hasSuccessfulBuild()).toBe(true);
    await configure({ fail: false, deps: ['/w/main.typ'] });
    await project.buildNow('manual');
    expect(project.dependencies).toEqual(new Set(['/w/main.typ']));
  });

  test('a malformed compile result fails the build with a logged error; onDidBuild fires and the status settles', async () => {
    const { project, configure, logger } = makeProject();
    await project.buildNow('manual');
    await configure({ malformed: ['compile'] });
    const builds: BuildOutcome[] = [];
    project.onDidBuild((e) => builds.push(e.outcome));
    const outcome = await project.buildNow('manual');
    expect(outcome.result).toBeUndefined();
    expect(outcome.error).toMatch(/compile/);
    expect(builds).toEqual([outcome]);
    expect(project.building).toBe(false);
    expect(logger.lines.some((l) => l.startsWith('error') && l.includes('compile'))).toBe(true);
    expect(statusAfterBuild(project.entry, outcome)).toEqual({ kind: 'failed', entry: '/w/main.typ', errors: 0, message: outcome.error });
  });

  test('an exception anywhere in a build still reports it', async () => {
    const lines: string[] = [];
    const logger = {
      info: () => {
        throw new Error('log broke');
      },
      warn: (m: string) => lines.push(m),
      error: (m: string) => lines.push(m),
      show: () => {},
    };
    const project = new Project(pathsFor('/w/main.typ'), {
      createClient: () => new HelperClient({ command: process.execPath, args: [fake], logger: memoryLogger() }),
      logger,
      delayMs: () => 0,
    });
    live.push(project);
    const builds: BuildOutcome[] = [];
    project.onDidBuild((e) => builds.push(e.outcome));
    const outcome = await project.buildNow('manual');
    expect(outcome.error).toBe('log broke');
    expect(builds).toEqual([outcome]);
    expect(lines.some((l) => l.includes('log broke'))).toBe(true);
  });

  test('errors thrown by build listeners are logged', async () => {
    const { project, logger } = makeProject();
    project.onDidBuild(() => {
      throw new Error('listener boom');
    });
    await project.buildNow('manual');
    expect(logger.lines.some((l) => l.startsWith('error') && l.includes('listener boom'))).toBe(true);
  });

  test('status after a build: ok, failed with errors, stopped', () => {
    const at = new Date();
    const result = { success: true, durationMs: 12, pageCount: 3, pdfWritten: true, diagnostics: [], dependencies: [] };
    expect(statusAfterBuild('/w/a.typ', { trigger: 'x', at, result })).toEqual({ kind: 'ok', entry: '/w/a.typ', durationMs: 12, at, pageCount: 3 });
    const failed = { ...result, success: false, pdfWritten: false, diagnostics: [1, 2].map(() => ({ severity: 'error' as const, message: 'm', hints: [], path: null, range: null, trace: [] })) };
    expect(statusAfterBuild('/w/a.typ', { trigger: 'x', at, result: failed })).toEqual({ kind: 'failed', entry: '/w/a.typ', errors: 2 });
    expect(statusAfterBuild('/w/a.typ', { trigger: 'x', at, error: 'the build was stopped', stopped: true })).toEqual({ kind: 'stopped' });
  });

  test('a preflight problem fails the build without starting a helper', async () => {
    const { project, createClient, logger } = makeProject('/w/main.typ', '', { preflight: () => 'helper binary not found: /x/helper' });
    const outcome = await project.buildNow('manual');
    expect(outcome.error).toBe('helper binary not found: /x/helper');
    expect(createClient).not.toHaveBeenCalled();
    expect(logger.lines.some((l) => l.includes('helper binary not found'))).toBe(true);
  });

  test('ensureBuilt builds once when the helper holds no document, and is false when no successful build results', async () => {
    const { project, stats } = makeProject();
    expect(await project.ensureBuilt('inverse')).toBe(true);
    expect(await project.ensureBuilt('inverse')).toBe(true);
    expect(await stats()).toMatchObject({ compile: 1 });
    const { project: missing } = makeProject('/w/other.typ', '', { preflight: () => 'helper binary not found: /x/helper' });
    expect(await missing.ensureBuilt('inverse')).toBe(false);
  });

  test('inverse on a project with no build yet triggers one build and then answers', async () => {
    testHooks.reset();
    const answer = { path: '/w/a.typ', line: 0, character: 0 };
    const { project, stats } = makeProject('/w/main.typ', '/w/main.typ', { env: { FAKE_INVERSE: JSON.stringify(answer) } });
    await expect(project.inverse({ page: 1, x: 5, y: 5 })).rejects.toMatchObject({ kind: 'remote', message: 'no successful compilation yet' });
    const flashes: string[] = [];
    await inverseSearch('/w/main.pdf', { page: 1, x: 5, y: 5 }, { projectFor: () => project, column: () => 1, flash: (m) => flashes.push(m), logger: memoryLogger() });
    expect(flashes).toEqual([]);
    expect(testHooks.shownDocuments.map((d) => d.uri.fsPath)).toEqual(['/w/a.typ']);
    expect(await stats()).toMatchObject({ compile: 1 });
  });

  test('lookups go to the same initialized helper', async () => {
    const { project, stats } = makeProject();
    await project.buildNow('manual');
    expect(await project.inverse({ page: 1, x: 10, y: 10 })).toBeNull();
    expect(await project.forward({ path: '/w/main.typ', line: 0, character: 0 })).toEqual({ positions: [] });
    expect(await project.wordCount()).toEqual({ total: 0, files: [] });
    expect(await stats()).toMatchObject({ initialize: 1 });
  });

  test('the word count of the last successful build is kept and reported, until a newer build succeeds', async () => {
    const { project, configure } = makeProject();
    const counts: number[] = [];
    project.onDidCountWords((e) => counts.push(e.result.total));
    await project.buildNow('manual');
    expect(project.lastWordCount).toBeUndefined();
    await configure({ words: 7 });
    expect(await project.wordCount()).toEqual({ total: 7, files: [] });
    expect(project.lastWordCount).toEqual({ total: 7, files: [] });
    expect(counts).toEqual([7]);
    // A failed build leaves the last successful document in the helper, so its count still holds.
    await configure({ fail: true });
    await project.buildNow('manual');
    expect(project.lastWordCount?.total).toBe(7);
    await configure({ fail: false });
    await project.buildNow('manual');
    expect(project.lastWordCount).toBeUndefined();
  });

  test('concurrent first requests share one initialize', async () => {
    const { project, stats } = makeProject();
    await Promise.all([project.buildNow('manual'), project.wordCount(), project.inverse({ page: 1, x: 0, y: 0 })]);
    expect(await stats()).toMatchObject({ initialize: 1, compile: 1 });
  });

  test('reconfigure restarts the helper with the new paths', async () => {
    const { project, clients, stats } = makeProject();
    await project.buildNow('manual');
    await project.reconfigure({ ...pathsFor('/w/main.typ'), pdf: '/w/out/main.pdf' }, { rebuild: true });
    expect(clients[0].running).toBe(false);
    expect(project.pdf).toBe('/w/out/main.pdf');
    await project.buildNow('manual');
    expect(clients).toHaveLength(2);
    expect((await stats()).lastInitialize.output).toBe('/w/out/main.pdf');
  });

  test('a settings change during a build reports it as stopped and builds again with the new paths', async () => {
    const { project, clients, configure, stats } = makeProject();
    await project.buildNow('manual');
    await configure({ delayMs: 60000 });
    const builds: BuildOutcome[] = [];
    project.onDidBuild((e) => builds.push(e.outcome));
    const hanging = project.buildNow('manual');
    await vi.waitFor(() => expect(project.building).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    await project.reconfigure({ ...pathsFor('/w/main.typ'), pdf: '/w/out/main.pdf' }, { rebuild: true });
    expect(builds[0]).toMatchObject({ stopped: true, error: 'the build was stopped' });
    await vi.waitFor(() => expect(builds).toHaveLength(2));
    expect(builds[1]).toMatchObject({ trigger: 'settings change', result: { success: true } });
    expect(clients).toHaveLength(2);
    expect((await stats()).lastInitialize.output).toBe('/w/out/main.pdf');
    await hanging;
  });

  test('reconfiguring a project that was never built does not build it', async () => {
    const { project, createClient } = makeProject();
    await project.reconfigure({ ...pathsFor('/w/main.typ'), pdf: '/w/out/main.pdf' }, { rebuild: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(createClient).not.toHaveBeenCalled();
    expect(project.lastOutcome).toBeUndefined();
  });

  test('dispose shuts the helper down; later builds report an error', async () => {
    const { project, clients } = makeProject();
    await project.buildNow('manual');
    await project.dispose();
    expect(clients[0].running).toBe(false);
    expect((await project.buildNow('manual')).error).toBeDefined();
  });
});

describe('ProjectManager', () => {
  function makeManager() {
    const depsByEntry: Record<string, string> = {
      '/w/a.typ': '/w/a.typ:/w/shared.typ:/w/data.csv',
      '/w/b.typ': '/w/b.typ:/w/shared.typ',
    };
    const logger = memoryLogger();
    const manager = new ProjectManager(
      (entry) =>
        new Project(pathsFor(entry), {
          createClient: () => new HelperClient({ command: process.execPath, args: [fake], logger, env: { ...process.env, FAKE_DEPS: depsByEntry[entry] ?? entry } }),
          logger,
          delayMs: () => 0,
        }),
    );
    live.push(manager);
    return manager;
  }

  test('manager finds projects containing a dependency, most recent first', async () => {
    const m = makeManager();
    const a = m.getOrCreate('/w/a.typ');
    const b = m.getOrCreate('/w/b.typ');
    expect(m.getOrCreate('/w/a.typ')).toBe(a);
    expect(m.get('/w/b.typ')).toBe(b);
    expect(m.get('/w/c.typ')).toBeUndefined();
    expect(m.all()).toEqual([a, b]);
    expect(m.projectsContaining('/w/shared.typ')).toEqual([]);
    expect(m.projectsContaining('/w/a.typ')).toEqual([a]);

    await a.buildNow('manual');
    await b.buildNow('manual');
    expect(m.projectsContaining('/w/shared.typ')).toEqual([b, a]);
    await a.buildNow('manual');
    expect(m.projectsContaining('/w/shared.typ')).toEqual([a, b]);
    expect(m.mostRecentFor('/w/shared.typ')).toBe(a);
    expect(m.mostRecentFor('/w/data.csv')).toBe(a);
    expect(m.mostRecentFor('/w/other.typ')).toBeUndefined();
    expect(m.byPdf('/w/b.pdf')).toBe(b);
    expect(m.byPdf('/w/none.pdf')).toBeUndefined();
  });

  test('a settings change rebuilds the projects built before, unless autoBuild.run is never', async () => {
    const m = makeManager();
    const a = m.getOrCreate('/w/a.typ');
    m.getOrCreate('/w/b.typ');
    await a.buildNow('manual');
    const builds: string[] = [];
    m.onDidBuild((e) => builds.push(`${e.project.entry} (${e.outcome.trigger})`));
    await m.reconfigure(pathsFor, 'never');
    await new Promise((r) => setTimeout(r, 50));
    expect(builds).toEqual([]);
    expect(a.hasSuccessfulBuild()).toBe(false);
    await m.reconfigure(pathsFor, 'onSave');
    await vi.waitFor(() => expect(builds).toEqual(['/w/a.typ (settings change)']));
    await m.reconfigure(pathsFor, 'onFileChange');
    await vi.waitFor(() => expect(builds).toEqual(['/w/a.typ (settings change)', '/w/a.typ (settings change)']));
  });

  test('errors thrown by manager listeners are logged', async () => {
    const logger = memoryLogger();
    const m = new ProjectManager(
      (entry) => new Project(pathsFor(entry), { createClient: () => new HelperClient({ command: process.execPath, args: [fake], logger }), logger, delayMs: () => 0 }),
      logger,
    );
    live.push(m);
    m.onDidBuild(() => {
      throw new Error('manager listener boom');
    });
    await m.getOrCreate('/w/a.typ').buildNow('manual');
    expect(logger.lines.some((l) => l.startsWith('error') && l.includes('manager listener boom'))).toBe(true);
  });

  test('manager forwards build and word count events and stops or disposes every project', async () => {
    const m = makeManager();
    const started: string[] = [];
    const built: string[] = [];
    const counted: string[] = [];
    m.onDidStartBuild((e) => started.push(e.project.entry));
    m.onDidBuild((e) => built.push(`${e.project.entry} ${e.outcome.result?.success}`));
    m.onDidCountWords((e) => counted.push(`${e.project.entry} ${e.result.total}`));
    const a = m.getOrCreate('/w/a.typ');
    await a.buildNow('manual');
    expect(started).toEqual(['/w/a.typ']);
    expect(built).toEqual(['/w/a.typ true']);
    await a.wordCount();
    expect(counted).toEqual(['/w/a.typ 0']);
    const stop = vi.spyOn(a, 'stop');
    m.stopAll();
    expect(stop).toHaveBeenCalledTimes(1);
    const dispose = vi.spyOn(a, 'dispose');
    await m.disposeAll();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(m.all()).toEqual([]);
  });
});
