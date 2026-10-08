import * as path from 'node:path';
import { entryLikeTops, isEntryLike, topsAbove, type IncludeGraph } from './includeScan';
import { errorText } from '../util/helpers';

export type EntryMode = 'auto' | 'manual';

/** Everything entry resolution needs from its surroundings; `entryContext.ts` provides the VS Code-backed one. */
export interface EntryContext {
  /** The beginning of the file (the editor's text when it is open). */
  readHead(file: string): Promise<string>;
  exists(file: string): boolean;
  workspaceFolderOf(file: string): string | undefined;
  /** The entry pinned for a workspace folder (or for the file's folder outside a workspace). */
  pinnedEntry(folder: string): string | undefined;
  /** `typst-workshop.mainFile` for the file, resolved to an absolute path. */
  settingEntry(file: string): string | undefined;
  /** Entry of the most recently built project whose dependency set contains the file. */
  knownProjectFor(file: string): string | undefined;
  includeGraph(folder: string): Promise<IncludeGraph>;
  rememberedChoice(file: string): string | undefined;
  remember(file: string, entry: string): void;
  pick(candidates: string[], file: string): Promise<string | undefined>;
  lastBuiltAmong(candidates: string[]): string | undefined;
  log(message: string): void;
}

const MAGIC_ROOT = /^\s*\/\/\s*!\s*TYPST\s+root\s*=\s*(.+?)\s*$/i;
const MAGIC_LINES = 20;

/** The path of a `// !TYPST root = …` comment in the first 20 lines, if any. */
export function magicRoot(head: string): string | undefined {
  const lines = head.split(/\r\n|\n|\r/, MAGIC_LINES);
  for (const line of lines) {
    const m = MAGIC_ROOT.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

/** The folder whose pinned entry and include graph apply to a file. */
export function entryFolderOf(file: string, ctx: Pick<EntryContext, 'workspaceFolderOf'>): string {
  return ctx.workspaceFolderOf(file) ?? path.dirname(file);
}

/** The rule that decided the entry. */
export type EntryRule = 'magic comment' | 'pinned' | 'setting' | 'known project' | 'include scan' | 'the file itself' | 'no entry';

export interface EntryDecision {
  entry: string | undefined;
  rule: EntryRule;
  /** What else the log line should say (a missing magic target, several candidates, a cancelled choice). */
  notes: string[];
}

/** Applies the entry rules in order. */
export async function decideEntry(file: string, mode: EntryMode, ctx: EntryContext): Promise<EntryDecision> {
  const notes: string[] = [];
  const decided = (entry: string | undefined, rule: EntryRule): EntryDecision => ({ entry, rule, notes });

  const head = await ctx.readHead(file).catch((err: unknown) => {
    notes.push(`cannot read its first lines: ${errorText(err)}`);
    return '';
  });
  const magic = magicRoot(head);
  if (magic !== undefined) {
    const target = path.resolve(path.dirname(file), magic);
    if (ctx.exists(target)) return decided(target, 'magic comment');
    notes.push(`the !TYPST root comment names ${target}, which does not exist`);
  }

  const folder = entryFolderOf(file, ctx);
  const pinned = ctx.pinnedEntry(folder);
  if (pinned !== undefined && ctx.exists(pinned)) return decided(pinned, 'pinned');

  const setting = ctx.settingEntry(file);
  if (setting !== undefined && ctx.exists(setting)) return decided(setting, 'setting');

  const known = ctx.knownProjectFor(file);
  if (known !== undefined) return decided(known, 'known project');

  const graph = await ctx.includeGraph(folder);
  const tops = topsAbove(graph, file);
  if (tops.length > 0) {
    const entryLike = tops.filter((t) => isEntryLike(graph, t));
    const candidates = entryLike.length > 0 ? entryLike : tops;
    if (candidates.length === 1) return decided(candidates[0], 'include scan');
    notes.push(`several entry files use it: ${candidates.map((c) => path.basename(c)).join(', ')}`);
    if (mode === 'manual') {
      const remembered = ctx.rememberedChoice(file);
      if (remembered !== undefined && candidates.includes(remembered)) {
        notes.push('the remembered choice');
        return decided(remembered, 'include scan');
      }
      const picked = await ctx.pick(candidates, file);
      if (picked === undefined) {
        notes.push('the choice was cancelled');
        return decided(undefined, 'no entry');
      }
      ctx.remember(file, picked);
      notes.push('chosen in the Quick Pick');
      return decided(picked, 'include scan');
    }
    const last = ctx.lastBuiltAmong(candidates);
    notes.push(last ? 'the most recently built' : 'the first in path order');
    return decided(last ?? candidates[0], 'include scan');
  }

  if (isEntryLike(graph, file) || entryLikeTops(graph).length === 0 || mode === 'manual') return decided(file, 'the file itself');
  notes.push('it is not included or imported by an entry file; no automatic build');
  return decided(undefined, 'no entry');
}

/** The last entry logged per context and file, so that a decision is logged only when it changes. */
const lastLogged = new WeakMap<EntryContext, Map<string, string | undefined>>();

/** The entry file to build for `file`, or undefined when an automatic build should not happen. Logs one line naming the rule whenever the entry for the file changes. */
export async function resolveEntry(file: string, mode: EntryMode, ctx: EntryContext): Promise<string | undefined> {
  const d = await decideEntry(file, mode, ctx);
  let logged = lastLogged.get(ctx);
  if (!logged) lastLogged.set(ctx, (logged = new Map()));
  if (!logged.has(file) || logged.get(file) !== d.entry) {
    logged.set(file, d.entry);
    ctx.log(`Entry for ${file}: ${d.entry ?? 'none'} (${[d.rule, ...d.notes].join('; ')})`);
  }
  return d.entry;
}
