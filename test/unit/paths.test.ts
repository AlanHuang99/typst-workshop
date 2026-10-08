import { describe, expect, test } from 'vitest';
import { expandPlaceholders, resolveProjectPaths } from '../../src/paths';

describe('expandPlaceholders', () => {
  test('replaces every placeholder', () => {
    const vars = { dir: '/w/a', workspaceFolder: '/w', tmpDir: '/tmp/typst-workshop' };
    expect(expandPlaceholders('%DIR%/out', vars)).toBe('/w/a/out');
    expect(expandPlaceholders('%WORKSPACE_FOLDER%/build/%DIR%', vars)).toBe('/w/build//w/a');
    expect(expandPlaceholders('%TMPDIR%', vars)).toBe('/tmp/typst-workshop');
    expect(expandPlaceholders('plain', vars)).toBe('plain');
  });

  test('%WORKSPACE_FOLDER% falls back to the entry folder outside a workspace', () => {
    expect(expandPlaceholders('%WORKSPACE_FOLDER%', { dir: '/x/y', tmpDir: '/t' })).toBe('/x/y');
  });
});

describe('resolveProjectPaths', () => {
  test('defaults', () =>
    expect(resolveProjectPaths('/w/Manuscript.typ', { rootDir: '', outDir: '%DIR%', fontPaths: ['fonts'] }, '/w', '/tmp')).toEqual({
      root: '/w',
      pdf: '/w/Manuscript.pdf',
      fontPaths: ['/w/fonts'],
    }));

  test('placeholders and relative outDir', () => {
    expect(resolveProjectPaths('/w/a/m.typ', { rootDir: '%WORKSPACE_FOLDER%', outDir: 'build', fontPaths: [] }, '/w', '/tmp').pdf).toBe('/w/build/m.pdf');
    expect(resolveProjectPaths('/w/a/m.typ', { rootDir: '', outDir: '%TMPDIR%', fontPaths: [] }, '/w', '/tmp').pdf).toBe('/tmp/typst-workshop/m.pdf');
  });

  test('paths with spaces', () =>
    expect(resolveProjectPaths('/x/Ä b/main.typ', { rootDir: '', outDir: '%DIR%', fontPaths: [] }, undefined, '/tmp').pdf).toBe('/x/Ä b/main.pdf'));

  test('root placeholders and relative root', () => {
    expect(resolveProjectPaths('/w/a/m.typ', { rootDir: '%WORKSPACE_FOLDER%', outDir: '%DIR%', fontPaths: [] }, '/w', '/tmp').root).toBe('/w');
    expect(resolveProjectPaths('/w/a/m.typ', { rootDir: '%DIR%/..', outDir: '%DIR%', fontPaths: [] }, '/w', '/tmp').root).toBe('/w');
    expect(resolveProjectPaths('/w/a/m.typ', { rootDir: 'a', outDir: '%DIR%', fontPaths: [] }, '/w', '/tmp').root).toBe('/w/a');
    expect(resolveProjectPaths('/w/a/m.typ', { rootDir: '/abs/root', outDir: '%DIR%', fontPaths: [] }, '/w', '/tmp').root).toBe('/abs/root');
  });

  test('relative values resolve against the entry folder when there is no workspace folder', () => {
    const r = resolveProjectPaths('/x/Ä b/main.typ', { rootDir: '', outDir: 'out', fontPaths: ['fonts', '/abs/fonts'] }, undefined, '/tmp');
    expect(r).toEqual({ root: '/x/Ä b', pdf: '/x/Ä b/out/main.pdf', fontPaths: ['/x/Ä b/fonts', '/abs/fonts'] });
  });

  test('empty outDir means the entry folder; blank font paths are dropped', () => {
    const r = resolveProjectPaths('/w/a/m.typ', { rootDir: '  ', outDir: '', fontPaths: ['', '  ', '%WORKSPACE_FOLDER%/f'] }, '/w', '/tmp');
    expect(r).toEqual({ root: '/w/a', pdf: '/w/a/m.pdf', fontPaths: ['/w/f'] });
  });

  test('only a trailing .typ is replaced by .pdf', () => {
    expect(resolveProjectPaths('/w/paper.v2.typ', { rootDir: '', outDir: '%DIR%', fontPaths: [] }, '/w', '/tmp').pdf).toBe('/w/paper.v2.pdf');
  });
});
