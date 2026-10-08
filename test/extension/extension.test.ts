// Extension-host tests against the real helper on a copy of test/fixtures/workspace. Run with `npm run test:extension`.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { TypstWorkshopApi } from '../../src/extension';
import type { BuildOutcome } from '../../src/project/project';
import { linesSince } from './logSince';

const EXTENSION_ID = 'alanhuang.typst-workshop';

/** Polls until the condition holds, failing after `ms`; `what` names the condition, or builds the text when the wait fails. */
async function waitFor(condition: () => boolean, ms: number, what: string | (() => string)): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${typeof what === 'string' ? what : what()}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The next build outcome that matches, failing after `ms`. */
function nextBuild(api: TypstWorkshopApi, matches: (o: BuildOutcome) => boolean, ms: number): Promise<BuildOutcome> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      listener.dispose();
      reject(new Error(`no matching build within ${ms} ms`));
    }, ms);
    const listener = api.projects.onDidBuild(({ outcome }) => {
      if (!matches(outcome)) return;
      clearTimeout(timer);
      listener.dispose();
      resolve(outcome);
    });
  });
}

function typstDiagnostics(uri: vscode.Uri): vscode.Diagnostic[] {
  return vscode.languages.getDiagnostics(uri).filter((d) => d.source === 'typst');
}

suite('Typst Workshop', function () {
  this.timeout(60_000);

  let api: TypstWorkshopApi;
  let main: string;
  let section: string;
  let numbers: string;
  let pdf: string;

  suiteSetup(async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'the fixture workspace is open');
    const root = folder.uri.fsPath;
    main = path.join(root, 'main.typ');
    section = path.join(root, 'sections', 'a.typ');
    numbers = path.join(root, 'data', 'numbers.csv');
    pdf = path.join(root, 'main.pdf');
    const extension = vscode.extensions.getExtension<TypstWorkshopApi>(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} is loaded`);
    api = await extension.activate();
  });

  test('a manual build from an included file writes the entry PDF', async () => {
    // No project uses sections/a.typ yet, so the include scan finds main.typ; and this build is the one that writes main.pdf.
    assert.equal(api.projects.mostRecentFor(section), undefined, 'no project uses sections/a.typ yet');
    assert.equal(fs.existsSync(pdf), false, 'main.pdf does not exist yet');
    const started = Date.now();
    const document = await vscode.workspace.openTextDocument(section);
    await vscode.window.showTextDocument(document);
    const outcome = (await vscode.commands.executeCommand('typst-workshop.build')) as BuildOutcome | undefined;
    assert.ok(outcome?.trigger.split(', ').includes('manual'), `outcome: ${JSON.stringify(outcome)}`);
    assert.equal(outcome?.result?.success, true, `outcome: ${JSON.stringify(outcome)}`);
    const project = api.projects.get(main);
    assert.ok(project, 'main.typ became the project of sections/a.typ');
    assert.ok(project.lastOutcome !== undefined && project.lastOutcome.at.getTime() >= started, `main.typ was built during this test: ${JSON.stringify(project.lastOutcome)}`);
    assert.ok(fs.existsSync(pdf), 'main.pdf exists');
    assert.ok(project.dependencies.has(numbers), 'the CSV is a dependency');
  });

  test('saving a broken file publishes an error; fixing it clears the diagnostics', async () => {
    const document = await vscode.workspace.openTextDocument(section);
    const editor = await vscode.window.showTextDocument(document);
    const original = document.getText();
    await editor.edit((e) => e.insert(new vscode.Position(0, 0), '#nope\n'));
    await document.save();
    await waitFor(() => typstDiagnostics(document.uri).some((d) => d.severity === vscode.DiagnosticSeverity.Error), 10_000, 'an error diagnostic on sections/a.typ');
    const whole = new vscode.Range(0, 0, document.lineCount, 0);
    await editor.edit((e) => e.replace(whole, original));
    await document.save();
    assert.equal(document.getText(), original);
    await waitFor(() => typstDiagnostics(document.uri).length === 0, 10_000, 'the diagnostics of sections/a.typ to clear');
  });

  test('a dependency changed on disk triggers an automatic build', async () => {
    const built = nextBuild(api, (o) => o.trigger.split(', ').includes('file change'), 20_000);
    await fs.promises.writeFile(numbers, '1\n2\n3\n');
    const outcome = await built;
    assert.equal(outcome.result?.success, true, `outcome: ${JSON.stringify(outcome)}`);
  });

  test('Show Cursor Position in PDF finds the word under the cursor, and the PDF tab shows main.pdf without warnings', async () => {
    // Only the log lines written during this test count: another suite may have shown main.pdf in a tab before.
    const earlier = api.logLines();
    const logged = () => linesSince(earlier, api.logLines());
    const document = await vscode.workspace.openTextDocument(section);
    const editor = await vscode.window.showTextDocument(document);
    const column = document.lineAt(0).text.indexOf('beta');
    assert.ok(column >= 0, 'sections/a.typ contains "beta"');
    editor.selection = new vscode.Selection(0, column + 1, 0, column + 1);
    await vscode.commands.executeCommand('typst-workshop.syncToPdf');
    assert.equal(api.viewers.lastForward?.pdf, pdf);
    assert.ok((api.viewers.lastForward?.positions.length ?? 0) > 0, `positions: ${JSON.stringify(api.viewers.lastForward)}`);
    // The tab reports a shown document through the log: pdf.js started in the real webview (the bundle and the blob-URL worker under its CSP) and the one-page PDF is in place. Any warning or error from the tab, such as the worker fallback, fails the test.
    const shown = 'info: [viewer] Showing main.pdf: 1 page';
    await waitFor(() => logged().includes(shown), 20_000, () => `the PDF tab to log "${shown}"; the log of this test:\n${logged().join('\n')}`);
    const problems = logged().filter((line) => line.startsWith('warn: [viewer]') || line.startsWith('error: [viewer]'));
    assert.deepEqual(problems, []);
  });
});
