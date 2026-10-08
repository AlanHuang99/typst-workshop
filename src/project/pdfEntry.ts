import * as path from 'node:path';
import { autoEntries, type IncludeGraph } from './includeScan';

/** What finding the entry of a PDF needs; `extension.ts` provides the VS Code-backed one. */
export interface PdfEntryContext {
  exists(file: string): boolean;
  /** The PDF an entry's build writes, with the current settings. */
  pdfFor(entry: string): string;
  /** The workspace folder that holds the PDF, or every workspace folder when it lies outside them. */
  foldersFor(pdf: string): string[];
  includeGraph(folder: string): Promise<IncludeGraph>;
}

/** The entry file whose build writes `pdf` (for a PDF tab that VS Code restores): `<pdf folder>/<pdf name>.typ` if it writes that PDF, else the first entry of the include scan (the entries automatic builds use) of the PDF's workspace folder whose PDF it is. */
export async function entryForPdf(pdf: string, ctx: PdfEntryContext): Promise<string | undefined> {
  const sibling = path.join(path.dirname(pdf), `${path.basename(pdf, '.pdf')}.typ`);
  if (ctx.exists(sibling) && ctx.pdfFor(sibling) === pdf) return sibling;
  for (const folder of ctx.foldersFor(pdf)) {
    const entry = autoEntries(await ctx.includeGraph(folder)).find((e) => ctx.pdfFor(e) === pdf);
    if (entry !== undefined) return entry;
  }
  return undefined;
}
