import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const HELPER_NAME = 'typst-workshop-helper';

function isExecutableFile(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function searchPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir === '') continue;
    const candidate = path.join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

/** The helper path to use instead of the bundled binary: `typst-workshop.helperPath`, else, in extension tests only (`ExtensionMode.Test`), the environment variable TYPST_WORKSHOP_HELPER. */
export function helperSetting(configured: string, testMode: boolean, env: Record<string, string | undefined> = process.env): string {
  return configured || (testMode ? (env.TYPST_WORKSHOP_HELPER ?? '') : '');
}

/** The helper binary to start: `setting` (`typst-workshop.helperPath`; `~` expands, a bare name is looked up on PATH, a relative path resolves against the first workspace folder), else `<extension>/bin/typst-workshop-helper`. `exists` tells whether it is an executable file; `problem` is set when the setting could not be used and the bundled binary is used instead. */
export function helperCommand(extensionPath: string, setting: string, workspaceFolder?: string): { command: string; exists: boolean; problem?: string } {
  const bundled = () => {
    const command = path.join(extensionPath, 'bin', HELPER_NAME);
    return { command, exists: isExecutableFile(command) };
  };
  const value = setting.trim();
  if (value === '') return bundled();
  const expanded = value === '~' ? os.homedir() : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
  if (!expanded.includes('/')) {
    const found = searchPath(expanded);
    return { command: found ?? expanded, exists: found !== undefined };
  }
  if (!path.isAbsolute(expanded)) {
    if (workspaceFolder === undefined) {
      return { ...bundled(), problem: `typst-workshop.helperPath "${value}" is a relative path and no workspace folder is open; using the bundled helper` };
    }
    const command = path.resolve(workspaceFolder, expanded);
    return { command, exists: isExecutableFile(command) };
  }
  const command = path.resolve(expanded);
  return { command, exists: isExecutableFile(command) };
}
