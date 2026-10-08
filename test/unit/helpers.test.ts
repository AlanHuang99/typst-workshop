import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from 'vitest';
import { errorText, formatCount, isFile, isInside, plural } from '../../src/util/helpers';

test('isInside: the folder itself and paths below it, never a sibling with the same prefix', () => {
  expect(isInside('/w', '/w')).toBe(true);
  expect(isInside('/w/a/b.typ', '/w')).toBe(true);
  expect(isInside('/w/a/b.typ', '/w/')).toBe(true);
  expect(isInside('/wx/a.typ', '/w')).toBe(false);
  expect(isInside('/w/a.typ', ['/v', '/w'])).toBe(true);
  expect(isInside('/u/a.typ', ['/v', '/w'])).toBe(false);
  expect(isInside('/u/a.typ', [])).toBe(false);
});

test('isFile: files only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-helpers-'));
  try {
    fs.writeFileSync(path.join(dir, 'a b.typ'), '');
    expect(isFile(path.join(dir, 'a b.typ'))).toBe(true);
    expect(isFile(dir)).toBe(false);
    expect(isFile(path.join(dir, 'missing.typ'))).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('counts and plurals', () => {
  expect(formatCount(6543)).toBe('6,543');
  expect(plural(1, 'page')).toBe('1 page');
  expect(plural(0, 'error')).toBe('0 errors');
  expect(plural(1234, 'word')).toBe('1,234 words');
});

test('errorText', () => {
  expect(errorText(new Error('boom'))).toBe('boom');
  expect(errorText('plain')).toBe('plain');
  expect(errorText(42)).toBe('42');
});
