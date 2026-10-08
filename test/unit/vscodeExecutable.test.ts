import { describe, expect, test } from 'vitest';
import { needsXvfb, vscodeExecutable } from '../../test/extension/vscode.mjs';

describe('the VS Code the extension-host tests run in', () => {
  const exists = (...paths: string[]) => (p: string) => paths.includes(p);

  test('VSCODE_EXECUTABLE when set, even if the desktop VS Code is installed', () => {
    expect(vscodeExecutable({ VSCODE_EXECUTABLE: '/opt/code/code' }, exists('/usr/share/code/code'))).toBe('/opt/code/code');
  });

  test('otherwise the desktop VS Code at /usr/share/code/code', () => {
    expect(vscodeExecutable({}, exists('/usr/share/code/code'))).toBe('/usr/share/code/code');
    expect(vscodeExecutable({ VSCODE_EXECUTABLE: '' }, exists('/usr/share/code/code'))).toBe('/usr/share/code/code');
  });

  test('otherwise none, so that VS Code stable is downloaded', () => {
    expect(vscodeExecutable({}, exists())).toBeUndefined();
  });
});

describe('xvfb-run', () => {
  test('on Linux without a display', () => {
    expect(needsXvfb('linux', {})).toBe(true);
    expect(needsXvfb('linux', { DISPLAY: '' })).toBe(true);
  });

  test('not on Linux with a display, nor on macOS', () => {
    expect(needsXvfb('linux', { DISPLAY: ':99' })).toBe(false);
    expect(needsXvfb('darwin', {})).toBe(false);
  });
});
