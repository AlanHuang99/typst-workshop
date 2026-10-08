import { lineStarts, offsetToPosition, scanTypst, type TypstScan } from '../typst/scan';

export interface Heading {
  level: number;
  title: string;
  line: number;
  /** The line before the next heading of the same or a higher level, or the last line. */
  endLine: number;
}

/** Headings from an existing scan (shared with the folding ranges). */
export function headingsOf(text: string, scan: TypstScan, starts: number[]): Heading[] {
  const lastLine = starts.length - 1;
  const lineOf = (offset: number) => offsetToPosition(starts, offset).line;
  const headings: Heading[] = scan.headings.map((h) => {
    const title = scan.masked
      .slice(Math.min(h.contentStart, h.contentEnd), Math.min(h.contentEnd, text.length))
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\s*<[^<>\s]*>$/, '')
      .trim();
    return { level: h.level, title, line: lineOf(h.offset), endLine: lastLine };
  });
  const open: Heading[] = [];
  for (const h of headings) {
    while (open.length > 0 && open[open.length - 1].level >= h.level) open.pop()!.endLine = Math.max(h.line - 1, 0);
    open.push(h);
  }
  // A heading inside a content block ends with the block, one line before its closing bracket (as the block's own fold).
  scan.headings.forEach((mark, k) => {
    if (mark.blockEnd === undefined) return;
    const h = headings[k];
    h.endLine = Math.min(h.endLine, Math.max(h.line, lineOf(mark.blockEnd) - 1));
  });
  return headings;
}

/** Markup headings (`=` to `======` and a space at the start of a line, outside raw text, comments and code), titled by their text without a trailing `<label>`. */
export function parseHeadings(text: string): Heading[] {
  return headingsOf(text, scanTypst(text), lineStarts(text));
}
