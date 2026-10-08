import { describe, expect, test } from 'vitest';
import { releaseNotes } from '../../scripts/release-notes.mjs';

const changelog = ['# Changelog', '', '## 0.3.0 (2026-11-01)', '', '- Third.', '', '## 0.2.0 (2026-10-07)', '', 'First public release.', '', '- One.', '- Two.', '', '## 0.1.0', '', '- Zero.', ''].join('\n');

describe('the release notes of a version: its CHANGELOG.md section', () => {
  test('the text between its heading and the next heading', () => {
    expect(releaseNotes(changelog, '0.2.0')).toBe('First public release.\n\n- One.\n- Two.');
    expect(releaseNotes(changelog, '0.3.0')).toBe('- Third.');
  });

  test('a heading without a date, at the end of the file', () => {
    expect(releaseNotes(changelog, '0.1.0')).toBe('- Zero.');
  });

  test('only the exact version counts', () => {
    expect(() => releaseNotes(changelog, '0.2')).toThrow('CHANGELOG.md has no section for 0.2');
    expect(() => releaseNotes(changelog, '2.0')).toThrow('CHANGELOG.md has no section for 2.0');
  });

  test('an empty section is refused', () => {
    expect(() => releaseNotes('## 1.0.0\n\n## 0.9.0\n- x\n', '1.0.0')).toThrow('the CHANGELOG.md section for 1.0.0 is empty');
  });
});
