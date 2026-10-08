import { describe, expect, test, vi } from 'vitest';
import { resolveEntry, type EntryContext, type EntryMode } from '../../src/project/entry';
import { buildIncludeGraph } from '../../src/project/includeScan';
import { manuscript } from './fixtures/shapes';

type TestContext = EntryContext & { logs: string[] };

/** An entry context over an in-memory file map; workspace folders are the first path segment (`/w`, `/m`, …) except for `/s`. */
function makeCtx(files: Map<string, string>, over: Partial<EntryContext> = {}): TestContext {
  const logs: string[] = [];
  const ctx: EntryContext = {
    readHead: async (f) => files.get(f) ?? '',
    exists: (f) => files.has(f),
    workspaceFolderOf: (f) => (f.startsWith('/s/') ? undefined : `/${f.split('/')[1]}`),
    pinnedEntry: () => undefined,
    settingEntry: () => undefined,
    knownProjectFor: () => undefined,
    includeGraph: async (folder) =>
      buildIncludeGraph(new Map([...files].filter(([f]) => f.startsWith(`${folder}/`))), folder, (p) => files.has(p)),
    rememberedChoice: () => undefined,
    remember: vi.fn(),
    pick: vi.fn(async () => undefined),
    lastBuiltAmong: () => undefined,
    log: (m) => logs.push(m),
    ...over,
  };
  return Object.assign(ctx, { logs });
}

const ctx = () => makeCtx(manuscript);

describe('resolveEntry on the manuscript shape', () => {
  test.each([
    ['/w/Sections/results.typ', 'auto', '/w/Manuscript.typ'],
    ['/w/Others/template.typ', 'auto', '/w/Manuscript.typ'],
    ['/w/Sections/related.typ', 'auto', undefined],
    ['/w/Sections/related.typ', 'manual', '/w/Sections/related.typ'],
    ['/w/Manuscript.typ', 'auto', '/w/Manuscript.typ'],
    ['/w/Tables/appendix_table.typ', 'manual', '/w/Manuscript.typ'],
  ])('%s (%s) → %s', async (file, mode, want) => {
    expect(await resolveEntry(file, mode as EntryMode, ctx())).toBe(want);
  });

  test('a file nobody uses in auto mode is logged and not built', async () => {
    const c = ctx();
    expect(await resolveEntry('/w/Sections/related.typ', 'auto', c)).toBeUndefined();
    expect(c.logs.join('\n')).toContain('related.typ');
  });
});

describe('rule order', () => {
  const file = '/w/Sections/results.typ';
  const files = new Map(manuscript);
  for (const n of ['A', 'B', 'C', 'D']) files.set(`/w/${n}.typ`, '');
  const withMagic = new Map(files).set(file, `// !TYPST root = ../A.typ\n${manuscript.get(file)}`);
  const pin = { pinnedEntry: (folder: string) => (folder === '/w' ? '/w/B.typ' : undefined) };
  const setting = { settingEntry: () => '/w/C.typ' };
  const known = { knownProjectFor: () => '/w/D.typ' };

  test('magic comment beats pin, pin beats setting, setting beats known project', async () => {
    expect(await resolveEntry(file, 'auto', makeCtx(withMagic, { ...pin, ...setting, ...known }))).toBe('/w/A.typ');
    expect(await resolveEntry(file, 'auto', makeCtx(files, { ...pin, ...setting, ...known }))).toBe('/w/B.typ');
    expect(await resolveEntry(file, 'auto', makeCtx(files, { ...setting, ...known }))).toBe('/w/C.typ');
    expect(await resolveEntry(file, 'auto', makeCtx(files, known))).toBe('/w/D.typ');
    expect(await resolveEntry(file, 'auto', makeCtx(files))).toBe('/w/Manuscript.typ');
  });

  test('magic comment: case, spacing, first 20 lines only, missing target ignored', async () => {
    const f = new Map(files);
    f.set(file, '\n\n  //  !typst ROOT=   ../B.typ  \nx');
    expect(await resolveEntry(file, 'manual', makeCtx(f))).toBe('/w/B.typ');
    f.set(file, `${'\n'.repeat(20)}// !TYPST root = ../B.typ`);
    expect(await resolveEntry(file, 'manual', makeCtx(f))).toBe('/w/Manuscript.typ');
    f.set(file, '// !TYPST root = ../Missing.typ');
    const c = makeCtx(f);
    expect(await resolveEntry(file, 'manual', c)).toBe('/w/Manuscript.typ');
    expect(c.logs.join('\n')).toContain('Missing.typ');
  });

  test('a pinned entry or setting that does not exist is skipped', async () => {
    const gone = { pinnedEntry: () => '/w/Gone.typ', settingEntry: () => '/w/AlsoGone.typ' };
    expect(await resolveEntry(file, 'auto', makeCtx(files, gone))).toBe('/w/Manuscript.typ');
  });

  test('outside a workspace folder the pin is looked up by the file folder', async () => {
    const f = new Map([['/s/x/paper.typ', 'Text.'], ['/s/x/main.typ', '']]);
    const seen: string[] = [];
    const c = makeCtx(f, { pinnedEntry: (folder) => (seen.push(folder), '/s/x/main.typ') });
    expect(await resolveEntry('/s/x/paper.typ', 'auto', c)).toBe('/s/x/main.typ');
    expect(seen).toEqual(['/s/x']);
  });
});

describe('logging entry decisions', () => {
  const file = '/w/Sections/results.typ';
  const files = new Map(manuscript);
  for (const n of ['A', 'B', 'C', 'D']) files.set(`/w/${n}.typ`, '');

  test('one line per resolution naming the rule, only when the entry for the file changes', async () => {
    let pinned: string | undefined;
    const c = makeCtx(files, { pinnedEntry: () => pinned });
    await resolveEntry(file, 'auto', c);
    await resolveEntry(file, 'manual', c);
    expect(c.logs).toEqual(['Entry for /w/Sections/results.typ: /w/Manuscript.typ (include scan)']);
    pinned = '/w/B.typ';
    await resolveEntry(file, 'auto', c);
    await resolveEntry(file, 'auto', c);
    pinned = undefined;
    await resolveEntry(file, 'auto', c);
    expect(c.logs).toEqual([
      'Entry for /w/Sections/results.typ: /w/Manuscript.typ (include scan)',
      'Entry for /w/Sections/results.typ: /w/B.typ (pinned)',
      'Entry for /w/Sections/results.typ: /w/Manuscript.typ (include scan)',
    ]);
  });

  test.each([
    ['magic comment', { head: '// !TYPST root = ../A.typ' }],
    ['pinned', { pinnedEntry: () => '/w/B.typ' }],
    ['setting', { settingEntry: () => '/w/C.typ' }],
    ['known project', { knownProjectFor: () => '/w/D.typ' }],
  ] as const)('the line names the rule: %s', async (rule, over) => {
    const f = new Map(files);
    if ('head' in over) f.set(file, over.head);
    const c = makeCtx(f, 'head' in over ? {} : over);
    await resolveEntry(file, 'auto', c);
    expect(c.logs).toHaveLength(1);
    expect(c.logs[0]).toMatch(new RegExp(`^Entry for /w/Sections/results\\.typ: /w/[A-D]\\.typ \\(${rule}\\)$`));
  });

  test('a file whose first lines cannot be read is resolved by the other rules, and the line says so', async () => {
    const c = makeCtx(files, { readHead: async () => Promise.reject(new Error('EACCES: permission denied')) });
    expect(await resolveEntry(file, 'auto', c)).toBe('/w/Manuscript.typ');
    expect(c.logs).toEqual(['Entry for /w/Sections/results.typ: /w/Manuscript.typ (include scan; cannot read its first lines: EACCES: permission denied)']);
  });

  test('the file itself and no entry are named too', async () => {
    const self = makeCtx(files);
    await resolveEntry('/w/Sections/related.typ', 'manual', self);
    expect(self.logs).toEqual(['Entry for /w/Sections/related.typ: /w/Sections/related.typ (the file itself)']);
    const none = makeCtx(files);
    await resolveEntry('/w/Sections/related.typ', 'auto', none);
    expect(none.logs).toHaveLength(1);
    expect(none.logs[0]).toMatch(/^Entry for \/w\/Sections\/related\.typ: none \(no entry; /);
  });
});

describe('include scan candidates', () => {
  test('single standalone file builds itself', async () => {
    const f = new Map([['/s/paper.typ', '= Paper\nText.']]);
    expect(await resolveEntry('/s/paper.typ', 'auto', makeCtx(f))).toBe('/s/paper.typ');
  });

  test('several entry-like tops: manual picks and remembers, auto uses last built', async () => {
    const f = new Map([
      ['/m/a.typ', '#include "common.typ"'],
      ['/m/b.typ', '#include "common.typ"'],
      ['/m/common.typ', 'Common.'],
    ]);
    const file = '/m/common.typ';
    const candidates = ['/m/a.typ', '/m/b.typ'];

    const picking = makeCtx(f, { pick: vi.fn(async () => '/m/b.typ') });
    expect(await resolveEntry(file, 'manual', picking)).toBe('/m/b.typ');
    expect(picking.pick).toHaveBeenCalledWith(candidates, file);
    expect(picking.remember).toHaveBeenCalledWith(file, '/m/b.typ');

    const remembered = makeCtx(f, { rememberedChoice: () => '/m/b.typ' });
    expect(await resolveEntry(file, 'manual', remembered)).toBe('/m/b.typ');
    expect(remembered.pick).not.toHaveBeenCalled();

    const stale = makeCtx(f, { rememberedChoice: () => '/m/old.typ', pick: vi.fn(async () => '/m/a.typ') });
    expect(await resolveEntry(file, 'manual', stale)).toBe('/m/a.typ');
    expect(stale.pick).toHaveBeenCalledTimes(1);

    const cancelled = makeCtx(f);
    expect(await resolveEntry(file, 'manual', cancelled)).toBeUndefined();
    expect(cancelled.remember).not.toHaveBeenCalled();

    const last = makeCtx(f, { lastBuiltAmong: (c) => (c.includes('/m/b.typ') ? '/m/b.typ' : undefined) });
    expect(await resolveEntry(file, 'auto', last)).toBe('/m/b.typ');
    expect(last.pick).not.toHaveBeenCalled();

    const first = makeCtx(f);
    expect(await resolveEntry(file, 'auto', first)).toBe('/m/a.typ');
    expect(first.pick).not.toHaveBeenCalled();
    expect(first.logs.join('\n')).toMatch(/a\.typ/);
  });

  test('tops that only import the file are used when no top includes anything', async () => {
    const f = new Map([
      ['/k/x.typ', '#import "lib.typ": *\nText.'],
      ['/k/lib.typ', '#let f(x) = x'],
    ]);
    expect(await resolveEntry('/k/lib.typ', 'auto', makeCtx(f))).toBe('/k/x.typ');
  });

  test('a file in an import cycle with no top falls back to rule 6', async () => {
    const f = new Map([
      ['/c/a.typ', '#import "b.typ": *'],
      ['/c/b.typ', '#import "a.typ": *'],
    ]);
    expect(await resolveEntry('/c/a.typ', 'auto', makeCtx(f))).toBe('/c/a.typ');
  });
});
