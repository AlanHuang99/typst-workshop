import { beforeEach, describe, expect, test } from 'vitest';
import { DiagnosticsPublisher, toPlainDiagnostics } from '../../src/diagnostics';
import type { HelperDiagnostic, LspRange } from '../../src/helper/protocol';
import type { Project } from '../../src/project/project';
import { DiagnosticSeverity, FakeDiagnosticCollection, Uri, testHooks } from './vscode-stub';

const R = (a: number, b: number, c: number, d: number): LspRange => ({ start: { line: a, character: b }, end: { line: c, character: d } });

function diag(over: Partial<HelperDiagnostic>): HelperDiagnostic {
  return { severity: 'error', message: 'm', hints: [], path: '/w/a.typ', range: R(0, 0, 0, 1), trace: [], ...over };
}

describe('toPlainDiagnostics', () => {
  test('hints, related trace, pathless diagnostics', () => {
    const out = toPlainDiagnostics(
      [
        {
          severity: 'error',
          message: 'unknown variable: foo',
          hints: ['did you mean `for`?'],
          path: null,
          range: null,
          trace: [
            { message: 'error occurred in this call', path: '/w/a.typ', range: R(1, 0, 1, 3) },
            { message: 'no path', path: null, range: null },
          ],
        },
      ],
      '/w/main.typ',
    );
    expect(out[0]).toEqual({
      path: '/w/main.typ',
      range: R(0, 0, 0, 0),
      severity: 'error',
      message: 'unknown variable: foo\nHint: did you mean `for`?',
      related: [{ path: '/w/a.typ', range: R(1, 0, 1, 3), message: 'error occurred in this call' }],
    });
  });

  test('warnings, several hints, a path without a range, a trace entry without a range', () => {
    const out = toPlainDiagnostics(
      [
        diag({ severity: 'warning', message: 'unknown font family', hints: ['a', 'b'], path: '/w/x y.typ', range: R(2, 4, 2, 9) }),
        diag({ message: 'file not found', path: '/w/refs.bib', range: null, trace: [{ message: 'here', path: '/w/a.typ', range: null }] }),
      ],
      '/w/main.typ',
    );
    expect(out).toEqual([
      { path: '/w/x y.typ', range: R(2, 4, 2, 9), severity: 'warning', message: 'unknown font family\nHint: a\nHint: b', related: [] },
      { path: '/w/refs.bib', range: R(0, 0, 0, 0), severity: 'error', message: 'file not found', related: [{ path: '/w/a.typ', range: R(0, 0, 0, 0), message: 'here' }] },
    ]);
  });
});

describe('DiagnosticsPublisher', () => {
  const p1 = { entry: '/w/main.typ' } as Project;
  const p2 = { entry: '/w/other.typ' } as Project;
  let collection: FakeDiagnosticCollection;
  let publisher: DiagnosticsPublisher;

  beforeEach(() => {
    testHooks.reset();
    collection = new FakeDiagnosticCollection('typst');
    publisher = new DiagnosticsPublisher(collection as never);
  });

  const at = (path: string) => collection.get(Uri.file(path)) ?? [];

  test('publishes VS Code diagnostics with source, severity and related information', () => {
    publisher.publish(p1, [diag({ message: 'boom', range: R(1, 2, 1, 4), trace: [{ message: 'in this call', path: '/w/main.typ', range: R(5, 0, 5, 3) }] }), diag({ severity: 'warning', message: 'w', path: null, range: null })], true);
    const [error] = at('/w/a.typ');
    expect(error.message).toBe('boom');
    expect(error.severity).toBe(DiagnosticSeverity.Error);
    expect(error.source).toBe('typst');
    expect(error.range.start).toEqual({ line: 1, character: 2 });
    expect(error.relatedInformation?.[0].message).toBe('in this call');
    expect(error.relatedInformation?.[0].location.uri.fsPath).toBe('/w/main.typ');
    expect(at('/w/main.typ').map((d) => [d.severity, d.message])).toEqual([[DiagnosticSeverity.Warning, 'w']]);
  });

  test('a new compile replaces the project’s previous diagnostics', () => {
    publisher.publish(p1, [diag({ path: '/w/a.typ' }), diag({ path: '/w/b.typ' })], true);
    publisher.publish(p1, [diag({ path: '/w/b.typ', message: 'new' })], true);
    expect(at('/w/a.typ')).toEqual([]);
    expect(at('/w/b.typ').map((d) => d.message)).toEqual(['new']);
    publisher.publish(p1, [], true);
    expect(collection.entries.size).toBe(0);
  });

  test('projects sharing a file keep each other’s diagnostics; duplicates are shown once', () => {
    publisher.publish(p1, [diag({ path: '/w/lib.typ', message: 'shared' }), diag({ path: '/w/lib.typ', message: 'only p1' })], true);
    publisher.publish(p2, [diag({ path: '/w/lib.typ', message: 'shared' })], true);
    expect(at('/w/lib.typ').map((d) => d.message)).toEqual(['shared', 'only p1']);
    publisher.clear(p1);
    expect(at('/w/lib.typ').map((d) => d.message)).toEqual(['shared']);
    publisher.publish(p2, [], true);
    expect(collection.entries.size).toBe(0);
  });

  test('publishing disabled clears the project’s diagnostics', () => {
    publisher.publish(p1, [diag({})], true);
    publisher.publish(p1, [diag({})], false);
    expect(collection.entries.size).toBe(0);
  });
});
