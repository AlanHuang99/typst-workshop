import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  changelogWith,
  compareVersions,
  helperVersion,
  lockedVersion,
  newerRust,
  nextVersion,
  noticesFor,
  pinnedTypst,
  pinTypst,
  readmeFor,
  rustVersion,
  withHelperVersion,
  withTypstConstant,
} from '../../scripts/typst-update.mjs';

const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

const manifest = [
  '[package]',
  'name = "typst-workshop-helper"',
  'version = "0.1.0"',
  'rust-version = "1.92"',
  '',
  '[dependencies]',
  'typst = "=0.15.1"',
  'typst-layout = "=0.15.1"',
  'typst-pdf = "=0.15.1"',
  'typst-ide = "=0.15.1"',
  'typst-kit = { version = "=0.15.1", features = ["embedded-fonts"] }',
  'comemo = "0.5.1"',
  '',
].join('\n');

describe('the typst pins of helper/Cargo.toml', () => {
  test('the version the five typst crates are pinned to', () => {
    expect(pinnedTypst(manifest)).toBe('0.15.1');
  });

  test('moving the pins changes the five typst lines and nothing else', () => {
    const moved = pinTypst(manifest, '0.16.0');
    const before = manifest.split('\n');
    expect(moved.split('\n').filter((line, i) => line !== before[i])).toEqual([
      'typst = "=0.16.0"',
      'typst-layout = "=0.16.0"',
      'typst-pdf = "=0.16.0"',
      'typst-ide = "=0.16.0"',
      'typst-kit = { version = "=0.16.0", features = ["embedded-fonts"] }',
    ]);
  });

  test('a crate that is not pinned with =, or pinned to another version, is refused', () => {
    expect(() => pinnedTypst(manifest.replace('typst-pdf = "=0.15.1"', 'typst-pdf = "0.15.1"'))).toThrow('helper/Cargo.toml does not pin typst-pdf with "=<version>"');
    expect(() => pinTypst(manifest.replace('typst-ide = "=0.15.1"', 'typst-ide = "=0.15.0"'), '0.16.0')).toThrow(
      'the typst crates in helper/Cargo.toml are pinned to different versions: 0.15.1, 0.15.1, 0.15.1, 0.15.0, 0.15.1',
    );
  });

  test('the version of the helper and the Rust version it needs', () => {
    expect(helperVersion(manifest)).toBe('0.1.0');
    expect(helperVersion(withHelperVersion(manifest, '0.2.0'))).toBe('0.2.0');
    expect(rustVersion(manifest)).toBe('1.92');
    expect(rustVersion('[package]\nname = "x"\n')).toBeUndefined();
  });
});

describe('versions', () => {
  test('release versions compare by number; pre-releases are refused', () => {
    expect(compareVersions('0.16.0', '0.15.1')).toBeGreaterThan(0);
    expect(compareVersions('0.15.10', '0.15.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareVersions('0.15.1', '0.15.1')).toBe(0);
    expect(compareVersions('0.15.0', '0.15.1')).toBeLessThan(0);
    expect(() => compareVersions('0.16.0-rc.1', '0.15.1')).toThrow('not a release version: 0.16.0-rc.1');
  });

  test('a new Typst major or minor version gives a new minor version; a new Typst patch version gives a new patch version', () => {
    expect(nextVersion('0.2.1', '0.15.1', '0.16.0')).toBe('0.3.0');
    expect(nextVersion('0.2.1', '0.15.1', '1.0.0')).toBe('0.3.0');
    expect(nextVersion('0.2.1', '0.15.1', '0.15.2')).toBe('0.2.2');
  });

  test('Rust versions with two or three parts', () => {
    expect(newerRust('1.95', '1.92')).toBe(true);
    expect(newerRust('1.92.1', '1.92')).toBe(true);
    expect(newerRust('2.0', '1.92')).toBe(true);
    expect(newerRust('1.92', '1.92')).toBe(false);
    expect(newerRust('1.89', '1.92')).toBe(false);
  });

  test('the version of a package in a lock file, which must be the only one', () => {
    const lock = ['version = 4', '', '[[package]]', 'name = "typst-assets"', 'version = "0.15.1"', 'source = "registry+https://github.com/rust-lang/crates.io-index"', '', '[[package]]', 'name = "two"', 'version = "1.0.0"', '', '[[package]]', 'name = "two"', 'version = "2.0.0"', ''].join('\n');
    expect(lockedVersion(lock, 'typst-assets')).toBe('0.15.1');
    expect(() => lockedVersion(lock, 'two')).toThrow('helper/Cargo.lock has several versions of two');
    expect(() => lockedVersion(lock, 'three')).toThrow('helper/Cargo.lock has no versions of three');
  });
});

describe('the files that name the Typst version', () => {
  test('helper/src/lib.rs, README.md and THIRD_PARTY_NOTICES.md name the pinned Typst, the locked typst-assets and the Rust version of the helper', () => {
    const pinned = pinnedTypst(read('helper/Cargo.toml'));
    expect(read('helper/src/lib.rs')).toContain(`pub const TYPST_VERSION: &str = "${pinned}";`);
    const readme = read('README.md');
    expect(readmeFor(readme, pinned, rustVersion(read('helper/Cargo.toml')))).toBe(readme);
    const notices = read('THIRD_PARTY_NOTICES.md');
    expect(noticesFor(notices, pinned, lockedVersion(read('helper/Cargo.lock'), 'typst-assets'))).toBe(notices);
  });

  test('moving them to other versions', () => {
    const readme = readmeFor(read('README.md'), '0.16.0', '1.95');
    expect(readme).toContain('Compilation uses the Typst 0.16.0 compiler crates');
    expect(readme).toContain('needs the typst CLI 0.16.0 on PATH');
    expect(readme).toContain('and Rust 1.95 or later');
    expect(readmeFor(read('README.md'), '0.16.0')).toContain(`and Rust ${rustVersion(read('helper/Cargo.toml'))} or later`);
    const notices = noticesFor(read('THIRD_PARTY_NOTICES.md'), '0.16.0', '0.16.1');
    expect(notices).toContain('https://github.com/typst/typst (version 0.16.0)');
    expect(notices).toContain("typst's NOTICE file at v0.16.0, verbatim");
    expect(notices).toContain('from typst-assets 0.16.1 (https://github.com/typst/typst-assets)');
    expect(withTypstConstant(read('helper/src/lib.rs'), '0.16.0')).toContain('pub const TYPST_VERSION: &str = "0.16.0";');
  });

  test('a file without the expected wording is refused', () => {
    expect(() => readmeFor('# Typst Workshop\n', '0.16.0')).toThrow('README.md has no text matching');
    expect(() => noticesFor('# Third-party notices\n', '0.16.0', '0.16.0')).toThrow('THIRD_PARTY_NOTICES.md has no text matching');
    expect(() => withTypstConstant('pub fn main() {}\n', '0.16.0')).toThrow('helper/src/lib.rs has no text matching');
  });
});

describe('the CHANGELOG.md entry', () => {
  const changelog = ['# Changelog', '', '## 0.2.1 (2026-10-08)', '', '- One.', '- Two.', '', '## 0.2.0 (2026-10-07)', '', '- Zero.', ''].join('\n');

  test('a new section above the first one for a new version', () => {
    expect(changelogWith(changelog, '0.2.2', '2026-11-02', 'Compiles with Typst 0.15.2.')).toBe(
      ['# Changelog', '', '## 0.2.2 (2026-11-02)', '', '- Compiles with Typst 0.15.2.', '', '## 0.2.1 (2026-10-08)', '', '- One.', '- Two.', '', '## 0.2.0 (2026-10-07)', '', '- Zero.', ''].join('\n'),
    );
  });

  test('an entry at the end of the first section when that section is the version, which is not released yet', () => {
    expect(changelogWith(changelog, '0.2.1', '2026-11-02', 'Compiles with Typst 0.15.2.')).toBe(
      ['# Changelog', '', '## 0.2.1 (2026-10-08)', '', '- One.', '- Two.', '- Compiles with Typst 0.15.2.', '', '## 0.2.0 (2026-10-07)', '', '- Zero.', ''].join('\n'),
    );
  });

  test('a changelog without a version section is refused', () => {
    expect(() => changelogWith('# Changelog\n', '0.2.2', '2026-11-02', 'x')).toThrow('CHANGELOG.md has no version section');
  });
});
