import * as vscode from 'vscode';
import type { HelperDiagnostic, LspRange } from './helper/protocol';
import type { Project } from './project/project';

export interface PlainDiagnostic {
  path: string;
  range: LspRange;
  severity: 'error' | 'warning';
  message: string;
  related: { path: string; range: LspRange; message: string }[];
}

function zeroRange(): LspRange {
  return { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
}

/** Helper diagnostics as the Problems panel shows them: hints on their own lines as `Hint: …`, trace entries with a path as related information, diagnostics without a path on the entry file at 0:0. */
export function toPlainDiagnostics(diagnostics: HelperDiagnostic[], entry: string): PlainDiagnostic[] {
  return diagnostics.map((d) => ({
    path: d.path ?? entry,
    range: d.path !== null && d.range !== null ? d.range : zeroRange(),
    severity: d.severity,
    message: [d.message, ...d.hints.map((h) => `Hint: ${h}`)].join('\n'),
    related: d.trace.filter((t) => t.path !== null).map((t) => ({ path: t.path as string, range: t.range ?? zeroRange(), message: t.message })),
  }));
}

function toRange(r: LspRange): vscode.Range {
  return new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
}

function toVscode(p: PlainDiagnostic): vscode.Diagnostic {
  const severity = p.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
  const d = new vscode.Diagnostic(toRange(p.range), p.message, severity);
  d.source = 'typst';
  if (p.related.length > 0) {
    d.relatedInformation = p.related.map((r) => new vscode.DiagnosticRelatedInformation(new vscode.Location(vscode.Uri.file(r.path), toRange(r.range)), r.message));
  }
  return d;
}

function keyOf(d: vscode.Diagnostic): string {
  const r = d.range;
  return `${d.severity}|${r.start.line}:${r.start.character}-${r.end.line}:${r.end.character}|${d.message}`;
}

/** Publishes each project's diagnostics into one collection (source `typst`). A compile replaces its project's previous diagnostics; projects that share a file (a common template) keep each other's, and identical ones are shown once. */
export class DiagnosticsPublisher {
  private readonly byProject = new Map<Project, Map<string, vscode.Diagnostic[]>>();

  constructor(private readonly collection: vscode.DiagnosticCollection) {}

  publish(project: Project, diagnostics: HelperDiagnostic[], enabled: boolean): void {
    const previous = this.byProject.get(project);
    const next = new Map<string, vscode.Diagnostic[]>();
    if (enabled) {
      for (const p of toPlainDiagnostics(diagnostics, project.entry)) {
        let list = next.get(p.path);
        if (!list) next.set(p.path, (list = []));
        list.push(toVscode(p));
      }
    }
    if (next.size > 0) this.byProject.set(project, next);
    else this.byProject.delete(project);
    this.refresh(new Set([...(previous?.keys() ?? []), ...next.keys()]));
  }

  clear(project: Project): void {
    const previous = this.byProject.get(project);
    if (!previous) return;
    this.byProject.delete(project);
    this.refresh(new Set(previous.keys()));
  }

  clearAll(): void {
    this.byProject.clear();
    this.collection.clear();
  }

  private refresh(paths: Set<string>): void {
    for (const path of paths) {
      const merged: vscode.Diagnostic[] = [];
      const seen = new Set<string>();
      for (const files of this.byProject.values()) {
        for (const d of files.get(path) ?? []) {
          const key = keyOf(d);
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(d);
        }
      }
      const uri = vscode.Uri.file(path);
      if (merged.length > 0) this.collection.set(uri, merged);
      else this.collection.delete(uri);
    }
  }
}
