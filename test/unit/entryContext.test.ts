import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { memoryLogger } from '../../src/log';
import { resolveEntry } from '../../src/project/entry';
import { VscodeEntryContext } from '../../src/project/entryContext';
import { ProjectManager } from '../../src/project/manager';
import { FakeMemento, globToRegExp, testHooks } from './vscode-stub';

let dir: string;
let state: FakeMemento;
let projects: ProjectManager;
let ctx: VscodeEntryContext;

function write(rel: string, text: string): string {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}

beforeEach(() => {
  testHooks.reset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-ctx Ä '));
  state = new FakeMemento();
  projects = new ProjectManager(() => {
    throw new Error('no projects in this test');
  });
  ctx = new VscodeEntryContext({ state: state as never, projects, logger: memoryLogger() });
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test('include graph of a workspace folder, cached until a Typst file in it changes', async () => {
  testHooks.setWorkspaceFolders([dir]);
  const main = write('main.typ', '#include "ch/one.typ"');
  const one = write('ch/one.typ', 'One.');
  write('node_modules/x/lib.typ', '#include "../../ch/one.typ"');
  const g = await ctx.includeGraph(dir);
  expect([...g.files].sort()).toEqual([one, main].sort());
  expect(await resolveEntry(one, 'auto', ctx)).toBe(main);
  expect(await ctx.includeGraph(dir)).toBe(g);
  expect(testHooks.findFilesCalls).toHaveLength(1);
  expect(testHooks.findFilesCalls[0].base).toBe(dir);
  // The stub applies the exclude pattern the extension passes, so the pattern itself keeps node_modules out.
  expect(testHooks.findFilesCalls[0].results.sort()).toEqual([one, main].sort());

  const other = write('other.typ', '#include "ch/one.typ"');
  ctx.invalidate(other);
  const g2 = await ctx.includeGraph(dir);
  expect(g2).not.toBe(g);
  expect(g2.files.has(other)).toBe(true);
  ctx.invalidate('/elsewhere/x.typ');
  expect(await ctx.includeGraph(dir)).toBe(g2);
});

test('the stub glob matcher', () => {
  const exclude = globToRegExp('{**/node_modules/**,**/.*/**}');
  for (const p of ['node_modules/a.typ', 'x/node_modules/y/b.typ', '.git/c.typ', 'x/.cache/copies/w/main.typ']) expect(exclude.test(p)).toBe(true);
  for (const p of ['a.typ', 'x.y/z.typ', 'ch/one.typ', 'node_modules.typ']) expect(exclude.test(p)).toBe(false);
  expect(globToRegExp('**/*.typ').test('a/b/c.typ')).toBe(true);
  expect(globToRegExp('**/*.typ').test('c.typ')).toBe(true);
  expect(globToRegExp('**/*.typ').test('c.typst')).toBe(false);
});

test('hidden folders and node_modules are left out of the include scan, in a workspace and outside one', async () => {
  const main = write('main.typ', '#include "ch/one.typ"');
  const one = write('ch/one.typ', 'One.');
  write('.cache/copies/main.typ', '#include "ch/one.typ"');
  write('.cache/copies/ch/one.typ', 'One.');
  write('.git/stray.typ', '');
  write('node_modules/pkg/lib.typ', '');
  write('sub/.hidden/deep/x.typ', '');

  testHooks.setWorkspaceFolders([dir]);
  const inWorkspace = await ctx.includeGraph(dir);
  expect([...inWorkspace.files].sort()).toEqual([one, main].sort());
  expect(testHooks.findFilesCalls[0].results.sort()).toEqual([one, main].sort());

  testHooks.setWorkspaceFolders([]);
  const outside = new VscodeEntryContext({ state: state as never, projects, logger: memoryLogger() });
  expect([...(await outside.includeGraph(dir)).files].sort()).toEqual([one, main].sort());
});

test('outside a workspace the file folder is walked; open documents count with their editor text', async () => {
  const main = write('main.typ', 'No includes yet.');
  const part = write('part.typ', 'Part.');
  testHooks.openDocument(main, '#include "part.typ"');
  const g = await ctx.includeGraph(dir);
  expect(testHooks.findFilesCalls).toHaveLength(0);
  expect([...(g.includeEdges.get(main) ?? [])]).toEqual([part]);
});

test.skipIf(process.getuid?.() === 0)('an unreadable Typst file is logged with its path and left out', async () => {
  const log = memoryLogger();
  ctx = new VscodeEntryContext({ state: state as never, projects, logger: log });
  const locked = write('locked.typ', '#include "x.typ"');
  write('x.typ', '');
  fs.chmodSync(locked, 0o000);
  try {
    const g = await ctx.includeGraph(dir);
    expect(g.includeEdges.size).toBe(0);
    expect(log.lines.some((l) => l.startsWith('warn') && l.includes(locked) && l.includes('EACCES'))).toBe(true);
  } finally {
    fs.chmodSync(locked, 0o644);
  }
});

test.skipIf(process.getuid?.() === 0)('an unreadable folder outside a workspace is logged and skipped', async () => {
  const log = memoryLogger();
  ctx = new VscodeEntryContext({ state: state as never, projects, logger: log });
  const main = write('main.typ', '');
  write('locked/inner.typ', '');
  const locked = path.join(dir, 'locked');
  fs.chmodSync(locked, 0o000);
  try {
    const g = await ctx.includeGraph(dir);
    expect([...g.files]).toEqual([main]);
    expect(log.lines.some((l) => l.startsWith('warn') && l.includes(locked) && l.includes('EACCES'))).toBe(true);
  } finally {
    fs.chmodSync(locked, 0o755);
  }
});

test('readHead prefers the editor text; exists checks files', async () => {
  const f = write('a.typ', '// on disk');
  expect(await ctx.readHead(f)).toBe('// on disk');
  testHooks.openDocument(f, '// !TYPST root = main.typ');
  expect(await ctx.readHead(f)).toBe('// !TYPST root = main.typ');
  expect(ctx.exists(f)).toBe(true);
  expect(ctx.exists(dir)).toBe(false);
  expect(ctx.exists(path.join(dir, 'nope.typ'))).toBe(false);
});

test('mainFile resolves against the workspace folder; absolute paths stay', () => {
  testHooks.setWorkspaceFolders([dir]);
  const f = path.join(dir, 'ch', 'a.typ');
  expect(ctx.settingEntry(f)).toBeUndefined();
  testHooks.config['typst-workshop.mainFile'] = 'Manuscript.typ';
  expect(ctx.settingEntry(f)).toBe(path.join(dir, 'Manuscript.typ'));
  testHooks.config['typst-workshop.mainFile'] = '/abs/main.typ';
  expect(ctx.settingEntry(f)).toBe('/abs/main.typ');
});

test('pins per workspace folder and remembered choices live in workspace state', async () => {
  testHooks.setWorkspaceFolders([dir]);
  const main = write('main.typ', '');
  const a = path.join(dir, 'ch', 'a.typ');
  await ctx.pin(main);
  expect(state.get('typst-workshop.pinnedEntries')).toEqual({ [dir]: main });
  expect(ctx.pinnedEntry(dir)).toBe(main);
  ctx.remember(a, main);
  await new Promise((r) => setTimeout(r, 0));
  expect(ctx.rememberedChoice(a)).toBe(main);
  expect(state.get('typst-workshop.entryChoices')).toEqual({ [a]: main });
  await ctx.unpin(a);
  expect(ctx.pinnedEntry(dir)).toBeUndefined();
  expect(ctx.rememberedChoice(a)).toBeUndefined();
});

test('pinning and clearing the pin are reported after the workspace state changed', async () => {
  testHooks.setWorkspaceFolders([dir]);
  const main = write('main.typ', '');
  const seen: (string | undefined)[] = [];
  ctx.onDidChangePins(() => seen.push(ctx.pinnedEntry(dir)));
  await ctx.pin(main);
  await ctx.unpin(main);
  await ctx.pin(main);
  await ctx.unpin(undefined);
  expect(seen).toEqual([main, undefined, main, undefined]);
});

test('pick offers the candidates and returns the chosen entry', async () => {
  testHooks.setWorkspaceFolders([dir]);
  const candidates = [path.join(dir, 'a.typ'), path.join(dir, 'b.typ')];
  testHooks.quickPickAnswer = (items) => items[1];
  expect(await ctx.pick(candidates, path.join(dir, 'common.typ'))).toBe(candidates[1]);
  expect(testHooks.quickPicks[0].items).toMatchObject([{ label: 'a.typ' }, { label: 'b.typ' }]);
  testHooks.quickPickAnswer = () => undefined;
  expect(await ctx.pick(candidates, path.join(dir, 'common.typ'))).toBeUndefined();
});
