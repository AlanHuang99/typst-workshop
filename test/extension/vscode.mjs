// The VS Code that runs the extension-host tests, and whether it needs a virtual display (used by runTests.mjs).

const DESKTOP_CODE = '/usr/share/code/code';

/**
 * The VS Code executable to test in: VSCODE_EXECUTABLE when set, else the desktop VS Code at /usr/share/code/code when installed, else undefined (download VS Code stable).
 * @param {Record<string, string | undefined>} env
 * @param {(file: string) => boolean} exists
 * @returns {string | undefined}
 */
export function vscodeExecutable(env, exists) {
  if (env.VSCODE_EXECUTABLE) return env.VSCODE_EXECUTABLE;
  return exists(DESKTOP_CODE) ? DESKTOP_CODE : undefined;
}

/**
 * Whether VS Code must run under xvfb-run: on Linux without a display.
 * @param {string} platform `process.platform`
 * @param {Record<string, string | undefined>} env
 * @returns {boolean}
 */
export function needsXvfb(platform, env) {
  return platform === 'linux' && !env.DISPLAY;
}
