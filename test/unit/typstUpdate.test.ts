import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  changelogRenamed,
  changelogWith,
  compareVersions,
  download,
  extensionVersion,
  helperVersion,
  highestRust,
  lockedVersion,
  newerRust,
  nextVersion,
  noticesFor,
  pinnedTypst,
  pinTypst,
  readmeFor,
  rustVersion,
  sharedCrates,
  upstream,
  withHelperVersion,
  withRequirement,
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
  'serde = { version = "1.0.184", features = ["derive"] }',
  'serde_json = "1"',
  '',
].join('\n');

const REGISTRY = 'registry+https://github.com/rust-lang/crates.io-index#';
const HELPER = 'path+file:///repo/helper#typst-workshop-helper@0.1.0';

/** A `cargo metadata` output of the helper: each package (name@version) with its dependencies (name@version, or [name@version, kind] for a dev or build dependency) and its Rust version. */
function metadataOf(graph: Record<string, { deps?: (string | [string, string])[]; rust?: string }>) {
  const id = (spec: string) => (spec === 'typst-workshop-helper@0.1.0' ? HELPER : REGISTRY + spec);
  return {
    packages: Object.entries(graph).map(([spec, p]) => ({ id: id(spec), name: spec.split('@')[0], version: spec.split('@')[1], rust_version: p.rust ?? null })),
    resolve: {
      root: HELPER,
      nodes: Object.entries(graph).map(([spec, p]) => ({
        id: id(spec),
        deps: (p.deps ?? []).map((d) => {
          const [dep, kind] = typeof d === 'string' ? [d, null] : d;
          return { name: dep.split('@')[0].replaceAll('-', '_'), pkg: id(dep), dep_kinds: [{ kind, target: null }] };
        }),
      })),
    },
  };
}

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

  test('a requirement set to another version keeps the form of its line', () => {
    expect(withRequirement(manifest, 'comemo', '0.6.0')).toBe(manifest.replace('comemo = "0.5.1"', 'comemo = "0.6.0"'));
    expect(withRequirement(manifest, 'serde', '2.0.1')).toBe(manifest.replace('serde = { version = "1.0.184", features', 'serde = { version = "2.0.1", features'));
    expect(() => withRequirement(manifest, 'ecow', '0.3.0')).toThrow('helper/Cargo.toml has no text matching');
  });
});

describe('the crates of the helper in the resolve graph (cargo metadata)', () => {
  const metadata = metadataOf({
    'typst-workshop-helper@0.1.0': { deps: ['typst@0.16.0', 'typst-kit@0.16.0', 'comemo@0.5.1', 'ecow@0.3.0', 'chrono@0.4.40', 'serde_json@1.0.100', ['tempfile@3.10.0', 'dev']], rust: '1.92' },
    'typst@0.16.0': { deps: ['comemo@0.6.0', 'ecow@0.3.0', ['tempfile@2.0.0', 'build']], rust: '1.95' },
    'typst-kit@0.16.0': { deps: ['typst@0.16.0', 'comemo@0.5.1', 'chrono@0.5.0'], rust: '1.95' },
    'comemo@0.5.1': {},
    'comemo@0.6.0': { rust: '1.89' },
    'ecow@0.3.0': {},
    'chrono@0.4.40': {},
    'chrono@0.5.0': {},
    'serde_json@1.0.100': { rust: '1.56' },
    'tempfile@3.10.0': {},
    'tempfile@2.0.0': {},
  });

  test('the direct dependencies that the helper shares with the typst crates, with the version of the first typst crate that uses each, and all versions in the graph', () => {
    expect(sharedCrates(metadata)).toEqual([
      { name: 'comemo', ours: '0.5.1', theirs: '0.6.0', by: 'typst', versions: ['0.5.1', '0.6.0'] },
      { name: 'ecow', ours: '0.3.0', theirs: '0.3.0', by: 'typst', versions: ['0.3.0'] },
      { name: 'chrono', ours: '0.4.40', theirs: '0.5.0', by: 'typst-kit', versions: ['0.4.40', '0.5.0'] },
    ]);
  });

  test('the package with the highest Rust version, a typst crate among equals', () => {
    expect(highestRust(metadata.packages)).toMatchObject({ name: 'typst', version: '0.16.0', rust_version: '1.95' });
    const other = metadataOf({ 'hayro@0.5.0': { rust: '1.95.1' }, 'typst@0.16.0': { rust: '1.95' }, 'krilla@0.7.0': { rust: '1.95' } });
    expect(highestRust(other.packages)).toMatchObject({ name: 'hayro', rust_version: '1.95.1' });
    expect(highestRust(other.packages.slice(1).reverse())).toMatchObject({ name: 'typst' });
    expect(highestRust(metadataOf({ 'ecow@0.3.0': {} }).packages)).toBeUndefined();
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

  describe('the version of the extension after the update, from the tags v<x.y.z>', () => {
    const tags = ['v0.1.0', 'v0.2.0', 'v0.10.0-rc.1', 'nightly'];

    test('a released version gives the next version', () => {
      expect(extensionVersion('0.2.0', tags, '0.15.1', '0.15.2')).toBe('0.2.1');
      expect(extensionVersion('0.2.0', tags, '0.15.1', '0.16.0')).toBe('0.3.0');
    });

    test('an unreleased version lower than the version the newest release needs for the update is raised to it, else kept', () => {
      expect(extensionVersion('0.2.1', tags, '0.15.0', '0.15.1')).toBe('0.2.1');
      expect(extensionVersion('0.2.1', tags, '0.14.2', '0.15.1')).toBe('0.3.0');
      expect(extensionVersion('0.3.0', tags, '0.15.1', '0.16.0')).toBe('0.3.0');
      expect(extensionVersion('0.4.0', tags, '0.15.1', '0.15.2')).toBe('0.4.0');
    });

    test('the newest release is the highest tag by number', () => {
      expect(extensionVersion('0.9.5', ['v0.9.4', 'v0.10.0', 'v0.2.0'], '0.15.1', '0.16.0')).toBe('0.11.0');
    });

    test('without released versions the version is kept', () => {
      expect(extensionVersion('0.1.0', [], '0.15.1', '0.16.0')).toBe('0.1.0');
      expect(extensionVersion('0.1.0', ['nightly', 'v1.0.0-rc.1'], '0.15.1', '0.16.0')).toBe('0.1.0');
    });
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
  const changelog = ['# Changelog', '', '## 0.2.1 (2026-10-08)', '', '- One.', '- Two.', '', '## 0.2.0 (2026-10-07)', '', '- Compiles with Typst 0.15.0.', ''].join('\n');

  test('a new section above the first one for a new version', () => {
    expect(changelogWith(changelog, '0.2.2', '2026-11-02', '0.15.2')).toBe(
      ['# Changelog', '', '## 0.2.2 (2026-11-02)', '', '- Compiles with Typst 0.15.2.', '', '## 0.2.1 (2026-10-08)', '', '- One.', '- Two.', '', '## 0.2.0 (2026-10-07)', '', '- Compiles with Typst 0.15.0.', ''].join('\n'),
    );
  });

  test('an entry at the end of the first section when that section is the version, which is not released yet', () => {
    expect(changelogWith(changelog, '0.2.1', '2026-11-02', '0.15.2')).toBe(
      ['# Changelog', '', '## 0.2.1 (2026-10-08)', '', '- One.', '- Two.', '- Compiles with Typst 0.15.2.', '', '## 0.2.0 (2026-10-07)', '', '- Compiles with Typst 0.15.0.', ''].join('\n'),
    );
  });

  test('a "Compiles with Typst" line of the unreleased first section is replaced', () => {
    const earlier = ['# Changelog', '', '## 0.2.1 (2026-10-08)', '', '- Compiles with Typst 0.15.2.', '- One.', '', '## 0.2.0 (2026-10-07)', '', '- Compiles with Typst 0.15.0.', ''].join('\n');
    expect(changelogWith(earlier, '0.2.1', '2026-11-09', '0.15.3')).toBe(earlier.replace('Typst 0.15.2.', 'Typst 0.15.3.'));
  });

  test('the heading of the first section renamed to a raised version, keeping the rest of the heading; another first section is left alone', () => {
    expect(changelogRenamed(changelog, '0.2.1', '0.3.0')).toBe(changelog.replace('## 0.2.1 (2026-10-08)', '## 0.3.0 (2026-10-08)'));
    expect(changelogRenamed(changelog, '0.2.0', '0.3.0')).toBe(changelog);
    expect(changelogRenamed(changelog, '0.2', '0.3.0')).toBe(changelog);
  });

  test('a changelog without a version section is refused', () => {
    expect(() => changelogWith('# Changelog\n', '0.2.2', '2026-11-02', '0.15.2')).toThrow('CHANGELOG.md has no version section');
  });
});

describe('downloads', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Answers fetch from `files` (paths below https://raw.githubusercontent.com/typst/typst/), 404 for others; records the URLs and headers. */
  function serve(files: Record<string, string>): { url: string; headers: unknown }[] {
    const requests: { url: string; headers: unknown }[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: { headers?: unknown }) => {
      requests.push({ url, headers: init?.headers });
      const body = files[url.replace('https://raw.githubusercontent.com/typst/typst/', '')];
      return new Response(body ?? 'Not Found', { status: body === undefined ? 404 : 200 });
    });
    return requests;
  }

  test('a network failure names the URL and its cause', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND raw.githubusercontent.com') });
    });
    await expect(download('https://raw.githubusercontent.com/typst/typst/v0.16.0/NOTICE')).rejects.toThrow('https://raw.githubusercontent.com/typst/typst/v0.16.0/NOTICE: fetch failed (getaddrinfo ENOTFOUND raw.githubusercontent.com)');
  });

  test('a missing file is undefined, another HTTP error names the URL; the User-Agent names only the project', async () => {
    const requests = serve({ 'v0.16.0/NOTICE': 'notice' });
    await expect(download('https://raw.githubusercontent.com/typst/typst/v0.16.0/NOTICE')).resolves.toBe('notice');
    await expect(download('https://raw.githubusercontent.com/typst/typst/v0.16.0/none')).resolves.toBeUndefined();
    expect(requests[0].headers).toEqual({ 'User-Agent': 'typst-workshop-update (+https://github.com/AlanHuang99/typst-workshop)' });
    vi.stubGlobal('fetch', async () => new Response('', { status: 503 }));
    await expect(download('https://crates.io/api/v1/crates/typst')).rejects.toThrow('https://crates.io/api/v1/crates/typst: HTTP 503');
  });

  test("typst's NOTICE of the new version and both versions of each file that a helper source adapts", async () => {
    const requests = serve({
      'v0.16.0/NOTICE': 'notice',
      'v0.15.1/crates/typst-cli/src/world.rs': 'a',
      'v0.16.0/crates/typst-cli/src/world.rs': 'a',
      'v0.15.1/crates/typst-cli/src/fonts.rs': 'b',
      'v0.16.0/crates/typst-cli/src/fonts.rs': 'c',
      'v0.15.1/crates/typst-cli/src/compile.rs': 'd',
      'v0.15.1/crates/typst-ide/src/jump.rs': 'e',
      'v0.16.0/crates/typst-ide/src/jump.rs': 'e',
    });
    expect(await upstream('0.15.1', '0.16.0')).toEqual({
      notice: 'notice',
      adapted: [
        { file: 'crates/typst-cli/src/world.rs', ours: 'helper/src/world.rs', state: 'unchanged' },
        { file: 'crates/typst-cli/src/fonts.rs', ours: 'helper/src/fonts.rs', state: 'changed' },
        { file: 'crates/typst-cli/src/compile.rs', ours: 'helper/src/compile.rs', state: 'no longer exists in v0.16.0' },
        { file: 'crates/typst-ide/src/jump.rs', ours: 'helper/src/sync.rs', state: 'unchanged' },
      ],
    });
    expect(requests).toHaveLength(9);
  });

  test('without a NOTICE at the new version nothing else is downloaded', async () => {
    const requests = serve({});
    await expect(upstream('0.15.1', '0.16.0')).rejects.toThrow("Typst's repository has no NOTICE file at v0.16.0");
    expect(requests.map((r) => r.url)).toEqual(['https://raw.githubusercontent.com/typst/typst/v0.16.0/NOTICE']);
  });
});
