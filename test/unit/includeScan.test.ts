import { describe, expect, test } from 'vitest';
import { buildIncludeGraph, entryLikeTops, extractRefs, isEntryLike, topsAbove } from '../../src/project/includeScan';
import { manuscript } from './fixtures/shapes';

describe('extractRefs', () => {
  test('extracts literal include/import paths and skips comments, raw, packages', () => {
    const text = [
      '#include "a.typ"',
      '#import "b.typ": x',
      '// #include "c.typ"',
      '/* #include "d.typ" /* nested */ still */',
      '#import "@preview/cetz:0.3.4": canvas',
      '#let p = "e.typ"',
      '`#include "f.typ"`',
      '#{ include "g.typ" }',
    ].join('\n');
    expect(extractRefs(text)).toEqual({ includes: ['a.typ', 'g.typ'], imports: ['b.typ'] });
  });

  test('prose, strings and field names are not includes', () => {
    const text = [
      'We include "everything" here.',
      '#let s = "#include \\"x.typ\\""',
      '#let m = (include: 1)',
      '#m.include',
      '#import "y.typ" as y',
      '#let doc = { import "h.typ": f; include "i.typ" }',
    ].join('\n');
    expect(extractRefs(text)).toEqual({ includes: ['i.typ'], imports: ['y.typ', 'h.typ'] });
  });
});

describe('include graph', () => {
  test('manuscript shape', () => {
    const f = manuscript;
    const g = buildIncludeGraph(f, '/w', (p) => f.has(p));
    expect(topsAbove(g, '/w/Sections/results.typ')).toEqual(['/w/Manuscript.typ']);
    expect(topsAbove(g, '/w/Tables/results_table.typ')).toEqual(['/w/Manuscript.typ']);
    expect(topsAbove(g, '/w/Others/template.typ')).toEqual(['/w/Manuscript.typ', '/w/Sections/related.typ']);
    expect(isEntryLike(g, '/w/Manuscript.typ')).toBe(true);
    expect(isEntryLike(g, '/w/Sections/related.typ')).toBe(false);
    expect(entryLikeTops(g)).toEqual(['/w/Manuscript.typ']);
  });

  test('a top has no tops above it; unknown files have none', () => {
    const g = buildIncludeGraph(manuscript, '/w', (p) => manuscript.has(p));
    expect(topsAbove(g, '/w/Manuscript.typ')).toEqual([]);
    expect(topsAbove(g, '/w/nowhere.typ')).toEqual([]);
    expect(isEntryLike(g, '/w/nowhere.typ')).toBe(false);
  });

  test('edges keep includes and imports apart and skip missing files', () => {
    const f = new Map<string, string>([
      ['/p/main.typ', '#include "ch/one.typ"\n#include "missing.typ"\n#import "lib.typ": *'],
      ['/p/ch/one.typ', 'One.'],
      ['/p/lib.typ', ''],
    ]);
    const g = buildIncludeGraph(f, '/p', (p) => f.has(p));
    expect([...(g.edges.get('/p/main.typ') ?? [])].sort()).toEqual(['/p/ch/one.typ', '/p/lib.typ']);
    expect([...(g.includeEdges.get('/p/main.typ') ?? [])]).toEqual(['/p/ch/one.typ']);
    expect([...(g.reverse.get('/p/lib.typ') ?? [])]).toEqual(['/p/main.typ']);
    expect(g.files).toEqual(new Set(['/p/main.typ', '/p/ch/one.typ', '/p/lib.typ']));
  });

  test('a leading slash resolves against the scanned folder; .. and spaces are normalized', () => {
    const f = new Map<string, string>([
      ['/x/Ä b/main.typ', '#include "/parts/a b.typ"'],
      ['/x/Ä b/parts/a b.typ', '#include "../parts/./c.typ"'],
      ['/x/Ä b/parts/c.typ', 'C.'],
    ]);
    const g = buildIncludeGraph(f, '/x/Ä b', (p) => f.has(p));
    expect(topsAbove(g, '/x/Ä b/parts/c.typ')).toEqual(['/x/Ä b/main.typ']);
  });

  test('cycles without a top yield no tops; a file importing itself is ignored', () => {
    const f = new Map<string, string>([
      ['/c/a.typ', '#import "b.typ": *'],
      ['/c/b.typ', '#import "a.typ": *'],
      ['/c/self.typ', '#include "self.typ"'],
    ]);
    const g = buildIncludeGraph(f, '/c', (p) => f.has(p));
    expect(topsAbove(g, '/c/a.typ')).toEqual([]);
    expect(isEntryLike(g, '/c/self.typ')).toBe(false);
    expect(entryLikeTops(g)).toEqual([]);
  });
});
