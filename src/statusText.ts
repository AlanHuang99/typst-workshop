// Texts of the build status and the word count, shared by the status bar and the sidebar; no VS Code API, so the sidebar model stays testable on its own.
import * as path from 'node:path';
import type { WordCountResult } from './helper/protocol';
import type { BuildOutcome } from './project/project';
import { formatCount, plural } from './util/helpers';

export type BuildStatus =
  | { kind: 'idle' }
  | { kind: 'building'; entry: string }
  | { kind: 'ok'; entry: string; durationMs: number; at: Date; pageCount: number | null }
  | { kind: 'failed'; entry: string; errors: number; message?: string }
  | { kind: 'stopped' };

export const SHOW_LOG = 'typst-workshop.showLog';
export const SHOW_PROBLEMS = 'workbench.actions.view.problems';
const TOOLTIP_FILES = 8;

/** `6,543 words`, `1 word`. */
export function formatWords(n: number): string {
  return plural(n, 'word');
}

/** `14:02:31`. */
export function clock(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** `0.23` for 231 ms. */
export function seconds(ms: number): string {
  return (Math.round(ms / 10) / 100).toFixed(2);
}

/** Text, tooltip, error background and click command of the build item. */
export function describeStatus(s: BuildStatus): { text: string; tooltip: string; error: boolean; command: string } {
  switch (s.kind) {
    case 'idle':
      return { text: 'Typst', tooltip: 'Typst Workshop: not built yet', error: false, command: SHOW_LOG };
    case 'building':
      return { text: '$(sync~spin) Typst', tooltip: `Building ${path.basename(s.entry)}`, error: false, command: SHOW_LOG };
    case 'ok': {
      const parts = [path.basename(s.entry), `built in ${seconds(s.durationMs)} s at ${clock(s.at)}`];
      if (s.pageCount !== null) parts.push(plural(s.pageCount, 'page'));
      return { text: '$(check) Typst', tooltip: parts.join(' · '), error: false, command: SHOW_LOG };
    }
    case 'failed':
      if (s.errors > 0) {
        return { text: `$(error) Typst: ${plural(s.errors, 'error')}`, tooltip: `${path.basename(s.entry)} · build failed with ${plural(s.errors, 'error')}`, error: true, command: SHOW_PROBLEMS };
      }
      return { text: '$(error) Typst', tooltip: `${path.basename(s.entry)} · build failed: ${s.message ?? 'see the log'}`, error: true, command: SHOW_LOG };
    case 'stopped':
      return { text: '$(debug-stop) Typst', tooltip: 'Typst Workshop: build stopped', error: false, command: SHOW_LOG };
  }
}

/** The build item's status after a build: stopped, failed (with the number of errors, or the reason when the helper could not compile), or ok. */
export function statusAfterBuild(entry: string, outcome: BuildOutcome): BuildStatus {
  if (outcome.stopped) return { kind: 'stopped' };
  const r = outcome.result;
  if (!r) return { kind: 'failed', entry, errors: 0, message: outcome.error };
  if (r.success) return { kind: 'ok', entry, durationMs: r.durationMs, at: outcome.at, pageCount: r.pageCount };
  return { kind: 'failed', entry, errors: r.diagnostics.filter((d) => d.severity === 'error').length };
}

/** Word count item: the total, with the top eight files (paths relative to the root) in the tooltip. */
export function describeWordCount(r: WordCountResult, root: string, pdfName: string): { text: string; tooltip: string } {
  const lines = [`${formatWords(r.total)} in ${pdfName}`];
  for (const f of r.files.slice(0, TOOLTIP_FILES)) lines.push(`${path.relative(root, f.path) || path.basename(f.path)}: ${formatCount(f.words)}`);
  if (r.files.length > TOOLTIP_FILES) lines.push(plural(r.files.length - TOOLTIP_FILES, 'more file'));
  return { text: formatWords(r.total), tooltip: lines.join('\n') };
}
