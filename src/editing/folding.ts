import { lineStarts, offsetToPosition, scanTypst } from '../typst/scan';
import { headingsOf } from './outline';

export interface FoldRange {
  start: number;
  end: number;
  kind?: 'comment';
}

/** Folding ranges: heading sections; multi-line `[…]`, `{…}` and `(…)` blocks, ending one line before the closing bracket; multi-line block comments. Sorted by start line, outer ranges first. */
export function foldingRanges(text: string): FoldRange[] {
  const scan = scanTypst(text);
  const starts = lineStarts(text);
  const lineOf = (offset: number) => offsetToPosition(starts, offset).line;
  const ranges: FoldRange[] = [];
  for (const h of headingsOf(text, scan, starts)) {
    if (h.endLine > h.line) ranges.push({ start: h.line, end: h.endLine });
  }
  for (const b of scan.brackets) {
    const start = lineOf(b.start);
    const end = lineOf(b.end) - 1;
    if (end > start) ranges.push({ start, end });
  }
  for (const c of scan.comments) {
    if (!c.block) continue;
    const start = lineOf(c.start);
    const end = lineOf(Math.max(c.start, c.end - 1));
    if (end > start) ranges.push({ start, end, kind: 'comment' });
  }
  return ranges.sort((a, b) => a.start - b.start || b.end - a.end);
}
