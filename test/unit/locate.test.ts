import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { helperCommand, helperSetting } from '../../src/helper/locate';

let ext: string;

beforeAll(() => {
  ext = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-locate-'));
  fs.mkdirSync(path.join(ext, 'bin'));
});

afterAll(() => fs.rmSync(ext, { recursive: true, force: true }));

test('bundled binary under <extension>/bin, reported missing until it exists', () => {
  const bundled = path.join(ext, 'bin', 'typst-workshop-helper');
  expect(helperCommand(ext, '')).toEqual({ command: bundled, exists: false });
  fs.writeFileSync(bundled, '#!/bin/sh\n', { mode: 0o755 });
  expect(helperCommand(ext, '  ')).toEqual({ command: bundled, exists: true });
});

test('the setting wins; a file that is not executable does not count', () => {
  const custom = path.join(ext, 'my helper');
  fs.writeFileSync(custom, 'x', { mode: 0o644 });
  expect(helperCommand(ext, custom)).toEqual({ command: custom, exists: false });
  fs.chmodSync(custom, 0o755);
  expect(helperCommand(ext, custom)).toEqual({ command: custom, exists: true });
});

test('a relative path resolves against the first workspace folder; without one, the bundled binary and a problem to log', () => {
  const ws = path.join(ext, 'work space');
  fs.mkdirSync(path.join(ws, 'tools'), { recursive: true });
  const local = path.join(ws, 'tools', 'helper');
  fs.writeFileSync(local, '#!/bin/sh\n', { mode: 0o755 });
  expect(helperCommand(ext, 'tools/helper', ws)).toEqual({ command: local, exists: true });
  expect(helperCommand(ext, './tools/helper', ws)).toEqual({ command: local, exists: true });
  const fallback = helperCommand(ext, 'tools/helper', undefined);
  expect(fallback.command).toBe(path.join(ext, 'bin', 'typst-workshop-helper'));
  expect(fallback.problem).toBe('typst-workshop.helperPath "tools/helper" is a relative path and no workspace folder is open; using the bundled helper');
  expect(helperCommand(ext, '/abs/helper', ws).problem).toBeUndefined();
});

test('TYPST_WORKSHOP_HELPER counts only in extension tests, and only without the setting', () => {
  const env = { TYPST_WORKSHOP_HELPER: '/test/helper' };
  expect(helperSetting('', true, env)).toBe('/test/helper');
  expect(helperSetting('', false, env)).toBe('');
  expect(helperSetting('/mine/helper', true, env)).toBe('/mine/helper');
  expect(helperSetting('/mine/helper', false, env)).toBe('/mine/helper');
  expect(helperSetting('', true, {})).toBe('');
});

test('a bare name is looked up on PATH; ~ expands to the home folder', () => {
  expect(helperCommand(ext, 'node').exists).toBe(true);
  expect(path.isAbsolute(helperCommand(ext, 'node').command)).toBe(true);
  expect(helperCommand(ext, 'no-such-helper-binary-xyz')).toEqual({ command: 'no-such-helper-binary-xyz', exists: false });
  expect(helperCommand(ext, '~/x/helper').command).toBe(path.join(os.homedir(), 'x/helper'));
});
