import * as path from 'node:path';
import { scanTypst } from '../typst/scan';

/** Include/import structure of the `.typ` files of one folder. Edges go from includer to included file. */
export interface IncludeGraph {
  files: Set<string>;
  /** Includes and imports. */
  edges: Map<string, Set<string>>;
  /** Included or imported file → files that include or import it. */
  reverse: Map<string, Set<string>>;
  /** Includes only. */
  includeEdges: Map<string, Set<string>>;
}

/** String-literal paths directly after the `include` and `import` keywords in code, outside comments, raw text and other strings. Package paths (`@…`) and non-literal expressions are skipped. */
export function extractRefs(text: string): { includes: string[]; imports: string[] } {
  const { tokens } = scanTypst(text);
  const includes: string[] = [];
  const imports: string[] = [];
  for (let k = 0; k + 1 < tokens.length; k++) {
    const t = tokens[k];
    if (t.kind !== 'ident' || (t.text !== 'include' && t.text !== 'import')) continue;
    const prev = tokens[k - 1];
    if (prev && prev.kind === 'punct' && prev.text === '.' && prev.end === t.start) continue;
    const next = tokens[k + 1];
    if (next.kind !== 'string' || next.value === '' || next.value.startsWith('@')) continue;
    (t.text === 'include' ? includes : imports).push(next.value);
  }
  return { includes, imports };
}

function addEdge(map: Map<string, Set<string>>, from: string, to: string): void {
  let set = map.get(from);
  if (!set) map.set(from, (set = new Set()));
  set.add(to);
}

/** Builds the graph of `sources` (file → text). Paths resolve against the including file's folder, or against `folder` when they start with `/`; targets that do not exist are dropped. */
export function buildIncludeGraph(sources: Map<string, string>, folder: string, exists: (p: string) => boolean): IncludeGraph {
  const g: IncludeGraph = { files: new Set(sources.keys()), edges: new Map(), reverse: new Map(), includeEdges: new Map() };
  for (const [file, text] of sources) {
    const { includes, imports } = extractRefs(text);
    const refs: [string, boolean][] = [...includes.map((r): [string, boolean] => [r, true]), ...imports.map((r): [string, boolean] => [r, false])];
    for (const [ref, isInclude] of refs) {
      const target = ref.startsWith('/') ? path.join(folder, ref) : path.resolve(path.dirname(file), ref);
      if (target === file || !exists(target)) continue;
      addEdge(g.edges, file, target);
      addEdge(g.reverse, target, file);
      if (isInclude) addEdge(g.includeEdges, file, target);
    }
  }
  return g;
}

function isTop(g: IncludeGraph, file: string): boolean {
  return (g.reverse.get(file)?.size ?? 0) === 0;
}

/** The tops (files nobody includes or imports) above `file`, sorted by path; empty when nothing includes or imports it. */
export function topsAbove(g: IncludeGraph, file: string): string[] {
  const tops = new Set<string>();
  const seen = new Set([file]);
  const stack = [file];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const parents = g.reverse.get(current);
    if (!parents || parents.size === 0) {
      if (current !== file) tops.add(current);
      continue;
    }
    for (const p of parents) {
      if (!seen.has(p)) {
        seen.add(p);
        stack.push(p);
      }
    }
  }
  return [...tops].sort();
}

/** A file is entry-like when it includes at least one existing file; imports alone do not count. */
export function isEntryLike(g: IncludeGraph, file: string): boolean {
  return (g.includeEdges.get(file)?.size ?? 0) > 0;
}

/** Entry-like tops of the whole folder, sorted by path. */
export function entryLikeTops(g: IncludeGraph): string[] {
  return [...g.files].filter((f) => isTop(g, f) && isEntryLike(g, f)).sort();
}

/** The files automatic builds use as entries: the entry-like tops, or every top when the folder has no entry-like top; sorted by path. */
export function autoEntries(g: IncludeGraph): string[] {
  const entryLike = entryLikeTops(g);
  return entryLike.length > 0 ? entryLike : [...g.files].filter((f) => isTop(g, f)).sort();
}
