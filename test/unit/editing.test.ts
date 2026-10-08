import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { WorkshopConfig } from '../../src/config';
import { foldingRanges } from '../../src/editing/folding';
import { registerEditing } from '../../src/editing/index';
import { extractPathLiterals } from '../../src/editing/links';
import { parseHeadings } from '../../src/editing/outline';
import type { ProjectManager } from '../../src/project/manager';
import { DocumentSymbol, FakeDocument, FoldingRangeKind, SymbolKind, Uri, testHooks } from './vscode-stub';

describe('parseHeadings', () => {
  test('headings outside raw, comments and code', () => {
    const t = ['= One', 'text', '== Two <sec:two>', '```', '= not', '```', '// = not', '/* = not */', '#{', '= not', '}', '#block[', '= Inside', ']', '=== Three'].join('\n');
    expect(parseHeadings(t).map((h) => [h.level, h.title, h.line])).toEqual([
      [1, 'One', 0],
      [2, 'Two', 2],
      [1, 'Inside', 12],
      [3, 'Three', 14],
    ]);
  });

  test('each heading spans to the line before the next heading of the same or a higher level', () => {
    const t = ['= A', 'a', '== A.1', 'x', '=== A.1.a', 'y', '== A.2', '= B', 'b', ''].join('\n');
    expect(parseHeadings(t).map((h) => [h.title, h.line, h.endLine])).toEqual([
      ['A', 0, 6],
      ['A.1', 2, 5],
      ['A.1.a', 4, 5],
      ['A.2', 6, 6],
      ['B', 7, 9],
    ]);
  });

  test('a heading inside a content block ends at the closing bracket', () => {
    const t = ['#[= Three]', '#block[', '= Inside', 'text', ']', 'after', '= Next'].join('\n');
    expect(parseHeadings(t).map((h) => [h.title, h.line, h.endLine])).toEqual([
      ['Three', 0, 0],
      ['Inside', 2, 3],
      ['Next', 6, 6],
    ]);
    expect(foldingRanges(t)).toEqual([
      { start: 1, end: 3 },
      { start: 2, end: 3 },
    ]);
  });

  test('titles drop trailing labels and comments, keep markup', () => {
    const t = '= Results <sec:results>\n== Tool Use: _vs._ Auto <subsec:functions> // note\n=  Spaced   ';
    expect(parseHeadings(t).map((h) => h.title)).toEqual(['Results', 'Tool Use: _vs._ Auto', 'Spaced']);
  });
});

describe('foldingRanges', () => {
  test('folding: sections, brackets, comments', () => {
    const t = ['= A', 'x', '= B', '#table(', ' a,', ' b,', ')', '/*', ' c', '*/'].join('\n');
    // heading sections run to the line before the next heading of the same or higher level; bracket blocks end one line before the closing bracket
    expect(foldingRanges(t)).toEqual([{ start: 0, end: 1 }, { start: 2, end: 9 }, { start: 3, end: 5 }, { start: 7, end: 9, kind: 'comment' }]);
  });

  test('nested blocks, content blocks and single-line pairs', () => {
    const t = ['#figure(', '  table(', '    [a], [b],', '  ),', '  caption: [', '    Text.', '  ],', ')', '#f(x)', '#g(', ')'].join('\n');
    expect(foldingRanges(t)).toEqual([
      { start: 0, end: 6 },
      { start: 1, end: 2 },
      { start: 4, end: 5 },
    ]);
  });

  test('brackets in strings, raw blocks and line comments do not fold', () => {
    const t = ['#let s = "(', '"', '```', '{', '', '}', '```', '// [', '// ]'].join('\n');
    expect(foldingRanges(t)).toEqual([]);
  });
});

describe('extractPathLiterals', () => {
  test('path literals', () => {
    const t = '#include "Sections/results.typ"\n#image("fig.svg", width: 50%)\n#bibliography("refs.bib", style: "apa.csl")\n#import "@preview/x:1.0.0": y';
    expect(extractPathLiterals(t).map((l) => l.value)).toEqual(['Sections/results.typ', 'fig.svg', 'refs.bib', 'apa.csl']);
    expect(extractPathLiterals(t)[0]).toMatchObject({ line: 0, start: 10, end: 30 });
  });

  test('every data function, nested calls and set rules; methods, named styles and other strings are not paths', () => {
    const t = [
      '#let d = (read("a.txt"), csv("b.csv"), json("c.json"), yaml("d.yaml"), toml("e.toml"), xml("f.xml"), cbor("g.cbor"), plugin("h.wasm"))',
      '#figure(image("Graphs/fig 1.svg"), caption: [x])',
      '#set bibliography(style: "Others/apa.csl")',
      '#bibliography("refs.bib", style: "apa")',
      '#let j = json.decode("{}")',
      '#text("not/a/path.typ")',
      'Prose about image("x.png") is text.',
      '// #image("commented.png")',
    ].join('\n');
    expect(extractPathLiterals(t).map((l) => l.value)).toEqual([
      'a.txt',
      'b.csv',
      'c.json',
      'd.yaml',
      'e.toml',
      'f.xml',
      'g.cbor',
      'h.wasm',
      'Graphs/fig 1.svg',
      'Others/apa.csl',
      'refs.bib',
    ]);
  });

  test('columns are UTF-16 offsets of the string contents', () => {
    const t = '😀 #image("ä/😀.png")';
    expect(extractPathLiterals(t)).toEqual([{ value: 'ä/😀.png', line: 0, start: 11, end: 19 }]);
  });
});

describe('registerEditing', () => {
  let dir: string;
  const subscriptions: { dispose(): unknown }[] = [];
  const context = { subscriptions } as never;
  let mode: WorkshopConfig['editingEnabled'];
  const cfg = () => ({ editingEnabled: mode }) as WorkshopConfig;
  const projects = { mostRecentFor: () => undefined } as unknown as ProjectManager;

  beforeEach(() => {
    testHooks.reset();
    mode = 'auto';
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-edit-'));
  });
  afterEach(() => {
    for (const s of subscriptions.splice(0)) s.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('providers are on without Tinymist and follow extension and setting changes', () => {
    const d = registerEditing(context, cfg, projects);
    expect(testHooks.activeProviders('symbols')).toHaveLength(1);
    expect(testHooks.activeProviders('folding')).toHaveLength(1);
    expect(testHooks.activeProviders('links')).toHaveLength(1);
    testHooks.setInstalledExtensions(['myriad-dreamin.tinymist']);
    expect(testHooks.activeProviders('symbols')).toHaveLength(0);
    mode = 'on';
    testHooks.setConfig('typst-workshop.editing.enabled', 'on');
    expect(testHooks.activeProviders('folding')).toHaveLength(1);
    mode = 'off';
    testHooks.setConfig('typst-workshop.editing.enabled', 'off');
    expect(testHooks.providers.every((p) => p.disposed)).toBe(true);
    mode = 'auto';
    testHooks.setInstalledExtensions([]);
    expect(testHooks.activeProviders('links')).toHaveLength(1);
    d.dispose();
    expect(testHooks.providers.every((p) => p.disposed)).toBe(true);
  });

  test('document symbols are nested by level and span their sections', () => {
    registerEditing(context, cfg, projects);
    const doc = new FakeDocument(Uri.file('/w/a.typ'), ['= A', 'a', '== A.1', 'x', '= B', 'b'].join('\n'));
    const symbols: DocumentSymbol[] = testHooks.activeProviders('symbols')[0].provider.provideDocumentSymbols(doc);
    expect(symbols.map((s) => s.name)).toEqual(['A', 'B']);
    expect(symbols[0].kind).toBe(SymbolKind.String);
    expect(symbols[0].children.map((s) => s.name)).toEqual(['A.1']);
    expect([symbols[0].range.start.line, symbols[0].range.end.line, symbols[0].range.end.character]).toEqual([0, 3, 1]);
    expect([symbols[1].range.start.line, symbols[1].range.end.line]).toEqual([4, 5]);
    expect(symbols[0].selectionRange.end.line).toBe(0);
  });

  test('folding ranges carry the comment kind', () => {
    registerEditing(context, cfg, projects);
    const doc = new FakeDocument(Uri.file('/w/a.typ'), '/*\nx\n*/');
    const ranges = testHooks.activeProviders('folding')[0].provider.provideFoldingRanges(doc);
    expect(ranges).toEqual([{ start: 0, end: 2, kind: FoldingRangeKind.Comment }]);
  });

  test('links point to existing files; a leading slash resolves against the workspace folder', () => {
    fs.mkdirSync(path.join(dir, 'Sections'));
    fs.writeFileSync(path.join(dir, 'Sections', 'results.typ'), '');
    fs.writeFileSync(path.join(dir, 'refs.bib'), '');
    testHooks.setWorkspaceFolders([dir]);
    registerEditing(context, cfg, projects);
    const doc = new FakeDocument(Uri.file(path.join(dir, 'Sections', 'main.typ')), '#include "results.typ"\n#bibliography("/refs.bib")\n#image("missing.png")');
    const links = testHooks.activeProviders('links')[0].provider.provideDocumentLinks(doc);
    expect(links.map((l: { target: Uri }) => l.target.fsPath)).toEqual([path.join(dir, 'Sections', 'results.typ'), path.join(dir, 'refs.bib')]);
    expect(links[0].range.start).toMatchObject({ line: 0, character: 10 });
    expect(links[0].range.end).toMatchObject({ line: 0, character: 21 });
  });

  test('a leading slash prefers the root of the project that uses the file', () => {
    fs.mkdirSync(path.join(dir, 'root'));
    fs.writeFileSync(path.join(dir, 'root', 'refs.bib'), '');
    const withRoot = { mostRecentFor: () => ({ root: path.join(dir, 'root') }) } as unknown as ProjectManager;
    registerEditing(context, cfg, withRoot);
    const doc = new FakeDocument(Uri.file(path.join(dir, 'root', 'ch', 'one.typ')), '#bibliography("/refs.bib")');
    const links = testHooks.activeProviders('links')[0].provider.provideDocumentLinks(doc);
    expect(links.map((l: { target: Uri }) => l.target.fsPath)).toEqual([path.join(dir, 'root', 'refs.bib')]);
  });
});
