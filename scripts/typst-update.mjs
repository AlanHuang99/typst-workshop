// Moves the helper to a newer Typst release, as typst-update.yml does once a week: the pins of the typst crates and TYPST_VERSION, the helper's other crates (cargo update; the crates it shares with Typst at Typst's versions), the Rust version that the helper's crates need, typst's NOTICE, the licences of the helper crates (scripts/helper-licenses.mjs), the Typst versions named in README.md and THIRD_PARTY_NOTICES.md, the versions of the helper and of the extension, and a CHANGELOG.md entry.
// Usage: node scripts/typst-update.mjs pinned            prints the Typst version the helper is pinned to
//        node scripts/typst-update.mjs check             prints pinned=, latest= (the newest stable Typst on crates.io) and newer= lines, for $GITHUB_OUTPUT
//        node scripts/typst-update.mjs apply <version>   moves to Typst <version> and prints a summary in Markdown (needs cargo, cargo-about, npm, git and network access)
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localCargo } from './platform.mjs';

/** The typst crates the helper links, all pinned with `=` to the same version. */
export const TYPST_CRATES = ['typst', 'typst-layout', 'typst-pdf', 'typst-ide', 'typst-kit'];

/** The helper's sources that adapt files of Typst's repository, with the file each one adapts. */
export const ADAPTED = [
  ['helper/src/world.rs', 'crates/typst-cli/src/world.rs'],
  ['helper/src/fonts.rs', 'crates/typst-cli/src/fonts.rs'],
  ['helper/src/compile.rs', 'crates/typst-cli/src/compile.rs'],
  ['helper/src/sync.rs', 'crates/typst-ide/src/jump.rs'],
];

const USER_AGENT = 'typst-workshop-update (+https://github.com/AlanHuang99/typst-workshop)';

const pin = (name) => new RegExp(`^(${name} = (?:"|\\{ version = "))=([^"]+)"`, 'm');

/**
 * The version the typst crates are pinned to in helper/Cargo.toml; throws unless all of them are pinned with `=` to one version.
 * @param {string} cargoToml
 * @returns {string}
 */
export function pinnedTypst(cargoToml) {
  const versions = TYPST_CRATES.map((name) => {
    const match = pin(name).exec(cargoToml);
    if (match === null) throw new Error(`helper/Cargo.toml does not pin ${name} with "=<version>"`);
    return match[2];
  });
  if (new Set(versions).size > 1) throw new Error(`the typst crates in helper/Cargo.toml are pinned to different versions: ${versions.join(', ')}`);
  return versions[0];
}

/**
 * helper/Cargo.toml with the typst crates pinned to `version`.
 * @param {string} cargoToml
 * @param {string} version
 * @returns {string}
 */
export function pinTypst(cargoToml, version) {
  pinnedTypst(cargoToml);
  return TYPST_CRATES.reduce((text, name) => text.replace(pin(name), `$1=${version}"`), cargoToml);
}

/**
 * The parts of a release version x.y.z.
 * @param {string} version
 * @returns {number[]}
 */
function parts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) throw new Error(`not a release version: ${version}`);
  return match.slice(1).map(Number);
}

/**
 * Compares two release versions x.y.z: negative when `a` is older, zero when equal, positive when `a` is newer.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareVersions(a, b) {
  const [pa, pb] = [parts(a), parts(b)];
  return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
}

/**
 * The next version of the extension or of the helper for a move from Typst `from` to Typst `to`: a new minor version when Typst's major or minor version changes, else a new patch version.
 * @param {string} version
 * @param {string} from
 * @param {string} to
 * @returns {string}
 */
export function nextVersion(version, from, to) {
  const [major, minor, patch] = parts(version);
  const [f, t] = [parts(from), parts(to)];
  return f[0] !== t[0] || f[1] !== t[1] ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

/**
 * The extension's version after a move from Typst `from` to Typst `to`: the next version (`nextVersion`) when the current version is released (tagged v<version>); otherwise the version that the newest release (the highest tag v<x.y.z>) needs for the move when the current version is lower than that, else the current version; the current version when nothing is released.
 * @param {string} current the version in package.json
 * @param {string[]} tags the tags of the repository
 * @param {string} from
 * @param {string} to
 * @returns {string}
 */
export function extensionVersion(current, tags, from, to) {
  if (tags.includes(`v${current}`)) return nextVersion(current, from, to);
  const releases = tags.filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag)).map((tag) => tag.slice(1));
  if (releases.length === 0) return current;
  const needed = nextVersion(releases.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b)), from, to);
  return compareVersions(current, needed) < 0 ? needed : current;
}

/**
 * Applies each replacement once; throws when a pattern matches nothing, so that a reworded file is noticed instead of keeping an old version.
 * @param {string} text
 * @param {string} file the file's name, for the error
 * @param {[RegExp, string][]} replacements
 * @returns {string}
 */
function replaceEach(text, file, replacements) {
  return replacements.reduce((current, [pattern, replacement]) => {
    if (!pattern.test(current)) throw new Error(`${file} has no text matching ${pattern}`);
    return current.replace(pattern, replacement);
  }, text);
}

/**
 * helper/Cargo.toml with the helper's own version set to `version`.
 * @param {string} cargoToml
 * @param {string} version
 * @returns {string}
 */
export function withHelperVersion(cargoToml, version) {
  return replaceEach(cargoToml, 'helper/Cargo.toml', [[/^(\[package\]\nname = "typst-workshop-helper"\nversion = ")[^"]+"/m, `$1${version}"`]]);
}

/**
 * The version of the helper in helper/Cargo.toml.
 * @param {string} cargoToml
 * @returns {string}
 */
export function helperVersion(cargoToml) {
  const match = /^\[package\]\nname = "typst-workshop-helper"\nversion = "([^"]+)"/m.exec(cargoToml);
  if (match === null) throw new Error('helper/Cargo.toml has no version for typst-workshop-helper');
  return match[1];
}

/**
 * helper/Cargo.toml with the requirement of the dependency `name` set to `version`, in the line's form: `name = "<version>"` or `name = { version = "<version>", … }`.
 * @param {string} cargoToml
 * @param {string} name
 * @param {string} version
 * @returns {string}
 */
export function withRequirement(cargoToml, name, version) {
  return replaceEach(cargoToml, 'helper/Cargo.toml', [[new RegExp(`^(${name} = (?:"|\\{ version = "))[^"]+"`, 'm'), `$1${version}"`]]);
}

/**
 * The Rust version of a manifest (`rust-version = "1.92"`), or undefined.
 * @param {string} cargoToml
 * @returns {string | undefined}
 */
export function rustVersion(cargoToml) {
  return /^rust-version = "([^"]+)"/m.exec(cargoToml)?.[1];
}

/**
 * Whether Rust version `a` (such as 1.92 or 1.92.1) is newer than `b`.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function newerRust(a, b) {
  const [pa, pb] = [a, b].map((v) => [...v.split('.').map(Number), 0, 0].slice(0, 3));
  return (pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2]) > 0;
}

/**
 * @typedef {{ id: string, name: string, version: string, rust_version?: string | null }} CargoPackage
 * @typedef {{ packages: CargoPackage[], resolve: { root: string, nodes: { id: string, deps: { pkg: string, dep_kinds: { kind: string | null }[] }[] }[] } }} CargoMetadata the output of `cargo metadata --format-version 1`
 */

/**
 * The packages that a package of the resolve graph uses as normal dependencies (not dev or build), by name.
 * @param {CargoMetadata} metadata
 * @param {string} id
 * @returns {Map<string, CargoPackage>}
 */
function normalDependencies(metadata, id) {
  const packages = new Map(metadata.packages.map((p) => [p.id, p]));
  const deps = metadata.resolve.nodes.find((n) => n.id === id)?.deps ?? [];
  return new Map(deps.filter((d) => d.dep_kinds.some((k) => k.kind === null)).map((d) => packages.get(d.pkg)).filter((p) => p !== undefined).map((p) => [p.name, p]));
}

/**
 * The helper's direct dependencies, other than the typst crates, that a typst crate uses too: each with the version the helper resolves to (`ours`), the version of the first typst crate that uses it (`theirs`, of crate `by`), and the versions of that crate in the whole graph.
 * @param {CargoMetadata} metadata `cargo metadata` of the helper
 * @returns {{ name: string, ours: string, theirs: string, by: string, versions: string[] }[]}
 */
export function sharedCrates(metadata) {
  const ours = normalDependencies(metadata, metadata.resolve.root);
  const typst = TYPST_CRATES.filter((name) => ours.has(name)).map((name) => ({ name, deps: normalDependencies(metadata, ours.get(name).id) }));
  return [...ours].flatMap(([name, own]) => {
    const user = TYPST_CRATES.includes(name) ? undefined : typst.find(({ deps }) => deps.has(name));
    if (user === undefined) return [];
    const versions = metadata.packages.filter((p) => p.name === name).map((p) => p.version);
    return [{ name, ours: own.version, theirs: user.deps.get(name).version, by: user.name, versions }];
  });
}

/**
 * The package that needs the newest Rust (its `rust_version`), a typst crate among equals; undefined when no package names one.
 * @param {CargoPackage[]} packages
 * @returns {CargoPackage | undefined}
 */
export function highestRust(packages) {
  const rank = (p) => (TYPST_CRATES.includes(p.name) ? TYPST_CRATES.indexOf(p.name) : TYPST_CRATES.length);
  let highest;
  for (const p of [...packages].sort((a, b) => rank(a) - rank(b))) {
    if (p.rust_version && (highest === undefined || newerRust(p.rust_version, highest.rust_version))) highest = p;
  }
  return highest;
}

/**
 * helper/src/lib.rs with TYPST_VERSION set to `version`.
 * @param {string} libRs
 * @param {string} version
 * @returns {string}
 */
export function withTypstConstant(libRs, version) {
  return replaceEach(libRs, 'helper/src/lib.rs', [[/^(pub const TYPST_VERSION: &str = ")[^"]+";/m, `$1${version}";`]]);
}

/**
 * README.md naming Typst `typst` (and, when given, Rust `rust` as the oldest Rust that builds the helper).
 * @param {string} readme
 * @param {string} typst
 * @param {string} [rust]
 * @returns {string}
 */
export function readmeFor(readme, typst, rust) {
  const replacements = [
    [/(Compilation uses the Typst )\d+\.\d+\.\d+( compiler crates)/, `$1${typst}$2`],
    [/(needs the typst CLI )\d+\.\d+\.\d+( on PATH)/, `$1${typst}$2`],
  ];
  if (rust !== undefined) replacements.push([/(and Rust )\d+(?:\.\d+)+( or later)/, `$1${rust}$2`]);
  return replaceEach(readme, 'README.md', replacements);
}

/**
 * THIRD_PARTY_NOTICES.md naming Typst `typst` and typst-assets `assets`.
 * @param {string} notices
 * @param {string} typst
 * @param {string} assets
 * @returns {string}
 */
export function noticesFor(notices, typst, assets) {
  return replaceEach(notices, 'THIRD_PARTY_NOTICES.md', [
    [/(https:\/\/github\.com\/typst\/typst \(version )\d+\.\d+\.\d+\)/, `$1${typst})`],
    [/(typst's NOTICE file at v)\d+\.\d+\.\d+/, `$1${typst}`],
    [/(from typst-assets )\d+\.\d+\.\d+/, `$1${assets}`],
  ]);
}

/**
 * The version of a package in a Cargo.lock; throws when the lock file has none or several.
 * @param {string} cargoLock
 * @param {string} name
 * @returns {string}
 */
export function lockedVersion(cargoLock, name) {
  const versions = [...cargoLock.matchAll(/^\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"/gm)].filter((m) => m[1] === name).map((m) => m[2]);
  if (versions.length !== 1) throw new Error(`helper/Cargo.lock has ${versions.length === 0 ? 'no' : 'several'} versions of ${name}`);
  return versions[0];
}

/**
 * Whether a line of CHANGELOG.md is the heading of the section of `version` ("## <version>" or "## <version> (<date>)").
 * @param {string} line
 * @param {string} version
 * @returns {boolean}
 */
function isSection(line, version) {
  return line === `## ${version}` || line.startsWith(`## ${version} `);
}

/**
 * CHANGELOG.md with the entry "Compiles with Typst <typst>." for `version`: in the first section when that section is `version` (not released yet), in place of its "Compiles with Typst" line if it has one, else at its end; otherwise in a new section "## <version> (<date>)" above the first one.
 * @param {string} changelog
 * @param {string} version
 * @param {string} date YYYY-MM-DD
 * @param {string} typst
 * @returns {string}
 */
export function changelogWith(changelog, version, date, typst) {
  const entry = `- Compiles with Typst ${typst}.`;
  const lines = changelog.split('\n');
  const first = lines.findIndex((l) => l.startsWith('## '));
  if (first < 0) throw new Error('CHANGELOG.md has no version section');
  if (isSection(lines[first], version)) {
    const next = lines.findIndex((l, i) => i > first && l.startsWith('## '));
    let end = next < 0 ? lines.length : next;
    const earlier = lines.findIndex((l, i) => i > first && i < end && l.startsWith('- Compiles with Typst '));
    if (earlier >= 0) {
      lines[earlier] = entry;
    } else {
      while (end > first + 1 && lines[end - 1].trim() === '') end--;
      lines.splice(end, 0, entry);
    }
  } else {
    lines.splice(first, 0, `## ${version} (${date})`, '', entry, '');
  }
  return lines.join('\n');
}

/**
 * CHANGELOG.md with the first section's heading renamed from version `from` to `to`, keeping the rest of the heading; unchanged when the first section is not `from`.
 * @param {string} changelog
 * @param {string} from
 * @param {string} to
 * @returns {string}
 */
export function changelogRenamed(changelog, from, to) {
  const lines = changelog.split('\n');
  const first = lines.findIndex((l) => l.startsWith('## '));
  if (first < 0 || !isSection(lines[first], from)) return changelog;
  lines[first] = `## ${to}${lines[first].slice(`## ${from}`.length)}`;
  return lines.join('\n');
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');
const write = (file, text) => writeFileSync(path.join(root, file), text);

/** Runs a command in the repository root and returns its standard output; throws when it fails. */
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} ${args[0]} failed (exit ${result.status ?? result.signal})`);
  return result.stdout;
}

/**
 * The body of a web resource; undefined when it does not exist (404). Its errors name the URL.
 * @param {string} url
 * @returns {Promise<string | undefined>}
 */
export async function download(url) {
  try {
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } catch (err) {
    // fetch reports a network failure as "fetch failed", with the reason in `cause`.
    const reason = err instanceof Error && err.cause instanceof Error ? err.cause.message || err.cause.code : undefined;
    throw new Error(`${url}: ${err instanceof Error ? err.message : String(err)}${reason ? ` (${reason})` : ''}`);
  }
}

/**
 * What a move from Typst `from` to Typst `to` takes from Typst's repository: typst's NOTICE at v<to>, and for each file that a helper source adapts whether it changed between the two versions.
 * @param {string} from
 * @param {string} to
 * @returns {Promise<{ notice: string, adapted: { file: string, ours: string, state: string }[] }>}
 */
export async function upstream(from, to) {
  const notice = await download(`https://raw.githubusercontent.com/typst/typst/v${to}/NOTICE`);
  if (notice === undefined) throw new Error(`Typst's repository has no NOTICE file at v${to}`);
  const adapted = [];
  for (const [ours, file] of ADAPTED) {
    const [old, current] = await Promise.all([from, to].map((v) => download(`https://raw.githubusercontent.com/typst/typst/v${v}/${file}`)));
    adapted.push({ file, ours, state: current === undefined ? `no longer exists in v${to}` : old === current ? 'unchanged' : 'changed' });
  }
  return { notice, adapted };
}

/** The newest stable release of the typst crate on crates.io. */
async function latestTypst() {
  const body = await download('https://crates.io/api/v1/crates/typst');
  const version = body === undefined ? undefined : JSON.parse(body).crate?.max_stable_version;
  if (typeof version !== 'string') throw new Error('crates.io did not report a stable version of typst');
  return version;
}

/** The helper's other crates move to their newest versions that helper/Cargo.toml allows. */
const updateCrates = () => run(localCargo(), ['update', '--manifest-path', 'helper/Cargo.toml']);

/** @returns {CargoMetadata} `cargo metadata` of the helper with all its features, so that it covers the published builds. */
const cargoMetadata = () => JSON.parse(run(localCargo(), ['metadata', '--format-version', '1', '--locked', '--all-features', '--manifest-path', 'helper/Cargo.toml']));

/** Moves to Typst `to`; returns a summary in Markdown. */
async function apply(to) {
  const cargoToml = read('helper/Cargo.toml');
  const from = pinnedTypst(cargoToml);
  if (compareVersions(to, from) <= 0) throw new Error(`the helper is pinned to Typst ${from}, which is not older than ${to}`);
  // Everything from Typst's repository first, so that a failed download leaves every file as it was.
  const { notice, adapted } = await upstream(from, to);

  const helperFrom = helperVersion(cargoToml);
  const helperTo = nextVersion(helperFrom, from, to);
  write('helper/Cargo.toml', withHelperVersion(pinTypst(cargoToml, to), helperTo));
  write('helper/src/lib.rs', withTypstConstant(read('helper/src/lib.rs'), to));
  updateCrates();
  let metadata = cargoMetadata();

  // A crate that the helper shares with Typst must be the same version for both, else the helper does not build: the helper takes Typst's.
  const aligned = sharedCrates(metadata).filter((c) => c.ours !== c.theirs);
  if (aligned.length > 0) {
    write('helper/Cargo.toml', aligned.reduce((text, c) => withRequirement(text, c.name, c.theirs), read('helper/Cargo.toml')));
    updateCrates();
    metadata = cargoMetadata();
  }

  const needs = highestRust(metadata.packages);
  const ownRust = rustVersion(read('helper/Cargo.toml'));
  const rust = needs?.rust_version && ownRust && newerRust(needs.rust_version, ownRust) ? needs : undefined;
  if (rust !== undefined) {
    write('helper/Cargo.toml', read('helper/Cargo.toml').replace(/^rust-version = "[^"]+"/m, `rust-version = "${rust.rust_version}"`));
    // cargo picks the versions that the manifest's Rust version builds with, so the other crates move again.
    updateCrates();
    metadata = cargoMetadata();
  }
  const several = sharedCrates(metadata).filter((c) => c.versions.length > 1);

  write('licenses/typst-NOTICE.txt', notice);
  write('README.md', readmeFor(read('README.md'), to, rust?.rust_version));
  write('THIRD_PARTY_NOTICES.md', noticesFor(read('THIRD_PARTY_NOTICES.md'), to, lockedVersion(read('helper/Cargo.lock'), 'typst-assets')));
  run(process.execPath, [path.join(root, 'scripts', 'helper-licenses.mjs')]);

  const extensionFrom = JSON.parse(read('package.json')).version;
  const tags = run('git', ['tag', '--list']).split('\n');
  const released = tags.includes(`v${extensionFrom}`);
  const extensionTo = extensionVersion(extensionFrom, tags, from, to);
  if (extensionTo !== extensionFrom) run('npm', ['version', extensionTo, '--no-git-tag-version']);
  const before = read('CHANGELOG.md');
  // An unreleased version raised for the update keeps its CHANGELOG section, under the new version.
  const changelog = released ? before : changelogRenamed(before, extensionFrom, extensionTo);
  const renamed = changelog !== before;
  const date = new Date().toISOString().slice(0, 10);
  write('CHANGELOG.md', changelogWith(changelog, extensionTo, date, to));

  return [
    `Typst ${from} → ${to}: [release notes](https://github.com/typst/typst/releases/tag/v${to}), [changes](https://github.com/typst/typst/compare/v${from}...v${to}).`,
    '',
    `- Extension ${extensionFrom}${released ? '' : ' (not released yet)'}${extensionTo === extensionFrom ? '' : ` → ${extensionTo}`}, helper ${helperFrom} → ${helperTo}; ${renamed ? `the CHANGELOG.md section of ${extensionFrom} is now ${extensionTo} and has the entry` : 'CHANGELOG.md has the entry'}.`,
    `- The helper's other crates are at their newest versions that helper/Cargo.toml allows (cargo update)${rust === undefined ? '' : `; the helper needs Rust ${rust.rust_version}, as ${rust.name} ${rust.version} does`}.`,
    ...(aligned.length === 0 ? [] : [`- The crates that the helper shares with Typst are at Typst's versions: ${aligned.map((c) => `${c.name} ${c.ours} → ${c.theirs}, as ${c.by} uses`).join('; ')}.`]),
    ...several.map((c) => `- helper/Cargo.lock still has several versions of ${c.name}: ${c.versions.join(', ')}.`),
    '- `licenses/typst-NOTICE.txt`, `helper/THIRD_PARTY_LICENSES.md`, `THIRD_PARTY_NOTICES.md` and `README.md` follow.',
    '- Files of Typst that helper sources adapt, from the old to the new version:',
    ...adapted.map(({ file, ours, state }) => `  - \`${file}\` (adapted in \`${ours}\`): ${state}`),
    '',
  ].join('\n');
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === self) {
  try {
    const [command, version] = process.argv.slice(2);
    if (command === 'pinned') {
      process.stdout.write(`${pinnedTypst(read('helper/Cargo.toml'))}\n`);
    } else if (command === 'check') {
      const pinned = pinnedTypst(read('helper/Cargo.toml'));
      const latest = await latestTypst();
      process.stdout.write(`pinned=${pinned}\nlatest=${latest}\nnewer=${compareVersions(latest, pinned) > 0}\n`);
    } else if (command === 'apply' && version !== undefined) {
      process.stdout.write(await apply(version));
    } else {
      throw new Error('usage: node scripts/typst-update.mjs pinned | check | apply <version>');
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
