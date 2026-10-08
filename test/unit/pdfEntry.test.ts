import * as path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { buildIncludeGraph } from '../../src/project/includeScan';
import { entryForPdf, type PdfEntryContext } from '../../src/project/pdfEntry';
import { manuscript } from './fixtures/shapes';

/** A context over sources (file → text) grouped by workspace folder; `pdfFor` maps an entry to its PDF. */
function context(folders: Record<string, Map<string, string>>, pdfFor: (entry: string) => string, extra: string[] = []): PdfEntryContext & { scanned: string[] } {
  const files = new Set([...Object.values(folders).flatMap((sources) => [...sources.keys()]), ...extra]);
  const exists = (p: string) => files.has(p);
  const scanned: string[] = [];
  return {
    scanned,
    exists,
    pdfFor,
    foldersFor: (pdf) => {
      const own = Object.keys(folders).find((f) => pdf.startsWith(`${f}/`));
      return own ? [own] : Object.keys(folders);
    },
    includeGraph: vi.fn(async (folder: string) => {
      scanned.push(folder);
      return buildIncludeGraph(folders[folder] ?? new Map(), folder, exists);
    }),
  };
}

const nextToEntry = (entry: string) => entry.replace(/\.typ$/, '.pdf');
const inFolder = (folder: string) => (entry: string) => path.join(folder, path.basename(entry).replace(/\.typ$/, '.pdf'));

describe('the entry that writes a PDF', () => {
  test('the Typst file next to the PDF with its name, when it writes that PDF; nothing is scanned', async () => {
    const ctx = context({ '/w': manuscript }, nextToEntry);
    expect(await entryForPdf('/w/Manuscript.pdf', ctx)).toBe('/w/Manuscript.typ');
    expect(ctx.scanned).toEqual([]);
  });

  test('otherwise the entry of the include scan of the workspace folder whose PDF it is', async () => {
    const ctx = context({ '/w': manuscript }, inFolder('/w/out'));
    expect(await entryForPdf('/w/out/Manuscript.pdf', ctx)).toBe('/w/Manuscript.typ');
    expect(ctx.scanned).toEqual(['/w']);
  });

  test('a file next to the PDF that writes another PDF does not count', async () => {
    const build = (entry: string) => path.join(path.dirname(entry), 'build', path.basename(entry).replace(/\.typ$/, '.pdf'));
    const ctx = context({ '/w': manuscript }, build, ['/w/build/Manuscript.typ']);
    expect(await entryForPdf('/w/build/Manuscript.pdf', ctx)).toBe('/w/Manuscript.typ');
  });

  test('only the entries automatic builds use: entry-like tops, or every top in a folder without one', async () => {
    const ctx = context({ '/w': manuscript }, inFolder('/w/out'));
    expect(await entryForPdf('/w/out/related.pdf', ctx)).toBeUndefined();
    expect(await entryForPdf('/w/out/template.pdf', ctx)).toBeUndefined();
    const letters = new Map([
      ['/l/letter.typ', '#import "style.typ": *\nDear reader.'],
      ['/l/style.typ', '#let x = 1'],
    ]);
    const other = context({ '/l': letters }, inFolder('/tmp/out'));
    expect(await entryForPdf('/tmp/out/letter.pdf', other)).toBe('/l/letter.typ');
    expect(await entryForPdf('/tmp/out/style.pdf', other)).toBeUndefined();
  });

  test('a PDF outside the workspace folders: the entries of every folder', async () => {
    const ctx = context({ '/v': new Map([['/v/notes.typ', 'Notes.']]), '/w': manuscript }, inFolder('/tmp/typst-workshop'));
    expect(await entryForPdf('/tmp/typst-workshop/Manuscript.pdf', ctx)).toBe('/w/Manuscript.typ');
    expect(ctx.scanned).toEqual(['/v', '/w']);
  });

  test('no entry writes the PDF', async () => {
    const ctx = context({ '/w': manuscript }, nextToEntry);
    expect(await entryForPdf('/w/Other.pdf', ctx)).toBeUndefined();
  });
});
