// Runs the extension-host tests (test/extension) in VS Code on a temporary copy of test/fixtures/workspace, so the repository is never modified.
// Usage: npm run test:extension (node esbuild.mjs --tests && node test/extension/runTests.mjs). Needs bin/typst-workshop-helper (npm run build:helper).
// VS Code: VSCODE_EXECUTABLE if set, else /usr/share/code/code if installed, else VS Code stable downloaded into .vscode-test/. On Linux without a display, the script runs itself again under xvfb-run -a.
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';
import { needsXvfb, vscodeExecutable } from './vscode.mjs';

const self = fileURLToPath(import.meta.url);
if (needsXvfb(process.platform, process.env)) {
  const result = spawnSync('xvfb-run', ['-a', process.execPath, self, ...process.argv.slice(2)], { stdio: 'inherit' });
  if (result.error) {
    console.error(`VS Code needs a display, and xvfb-run could not be started: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

const root = path.resolve(path.dirname(self), '..', '..');
// Chosen before the clean-up below, which also removes VSCODE_EXECUTABLE.
const chosen = vscodeExecutable(process.env, existsSync);

// A shell started from VS Code (integrated terminal, Remote-SSH) sets ELECTRON_RUN_AS_NODE and VSCODE_* variables, which would make the test instance run as plain Node or attach to that VS Code.
for (const key of Object.keys(process.env)) {
  if (key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('VSCODE_')) delete process.env[key];
}

// A short folder under the real path of the temporary folder: on macOS, os.tmpdir() lies below /var, a symbolic link to /private/var, and VS Code's socket in the user data folder needs a path of at most 103 characters.
const tmp = await mkdtemp(path.join(realpathSync(os.tmpdir()), 'tw-ext-'));
// A folder name with a space and a non-ASCII letter, so that paths like these go through the whole chain.
const workspace = path.join(tmp, 'fixture Ä b');
const userData = path.join(tmp, 'user-data');
// A PDF that a run of the Extension Development Host (F5) left in the fixture folder stays behind: the tests start without main.pdf.
await cp(path.join(root, 'test', 'fixtures', 'workspace'), workspace, { recursive: true, filter: (source) => !source.toLowerCase().endsWith('.pdf') });

try {
  const vscodeExecutablePath = chosen ?? (await downloadAndUnzipVSCode({ version: 'stable', cachePath: path.join(root, '.vscode-test') }));
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, 'dist', 'test', 'extension', 'index.js'),
    launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust', '--user-data-dir', userData],
    extensionTestsEnv: { TYPST_WORKSHOP_HELPER: path.join(root, 'bin', 'typst-workshop-helper') },
  });
} catch (err) {
  console.error(`Extension tests failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await rm(tmp, { recursive: true, force: true });
}
