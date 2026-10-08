// Regenerates helper/THIRD_PARTY_LICENSES.md: the licences of the Rust crates the helper is built from, listed by cargo-about (helper/about.toml, helper/about.hbs) with the features of the published builds, followed by the licence of OpenSSL, which the linux-x64 helper contains (built from source by the openssl-src crate), and the NOTICE files of typst-assets (the fonts and data files the helper embeds), hayagriva (its CSL styles and locales, through typst-library) and subsetter.
// Usage: npm run licenses:helper (needs cargo-about: cargo install cargo-about --locked --features cli)
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localCargo } from './platform.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = path.join(root, 'helper', 'Cargo.toml');
const output = path.join(root, 'helper', 'THIRD_PARTY_LICENSES.md');
// The features of the published linux-x64 build; they change nothing on macOS.
const features = 'vendored-openssl';

/** Runs cargo in the repository root and returns its standard output; throws when it fails. */
function cargo(args) {
  const result = spawnSync(localCargo(), args, { cwd: root, stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`cargo ${args[0]} failed (exit ${result.status ?? result.signal})`);
  return result.stdout;
}

/** A file of a dependency, read from its source in cargo's registry. */
function packageFile(packages, name, file) {
  const found = packages.find((p) => p.name === name);
  if (found === undefined) throw new Error(`${name} is not a dependency of the helper`);
  return { package: found, text: readFileSync(path.join(path.dirname(found.manifest_path), file), 'utf8').trimEnd() };
}

try {
  cargo(['about', 'generate', '--locked', '--fail', '--features', features, '--manifest-path', manifest, '--output-file', output, path.join(root, 'helper', 'about.hbs')]);
  const { packages } = JSON.parse(cargo(['metadata', '--format-version', '1', '--locked', '--features', features, '--manifest-path', manifest]));
  const openssl = packageFile(packages, 'openssl-src', 'openssl/LICENSE.txt');
  const opensslVersion = openssl.package.version.split('+')[1];
  appendFileSync(output, `## OpenSSL ${opensslVersion}\n\nThe linux-x64 helper contains OpenSSL ${opensslVersion}, built from source by [openssl-src](${openssl.package.repository}) ${openssl.package.version}. Its licence (openssl/LICENSE.txt):\n\n\`\`\`\`text\n${openssl.text}\n\`\`\`\`\n\n`);
  const notices = [
    ['typst-assets', (repo) => `The helper embeds fonts and data files of [typst-assets](${repo}).`],
    ['hayagriva', (repo) => `The helper embeds the CSL styles and locales of [hayagriva](${repo}) (its \`archive\` folder), which typst-library uses.`],
    ['subsetter', (repo) => `The helper contains [subsetter](${repo}), which adapts code from other projects.`],
  ];
  notices.forEach(([name, intro], i) => {
    const notice = packageFile(packages, name, 'NOTICE');
    appendFileSync(output, `## Notice of ${name} ${notice.package.version}\n\n${intro(notice.package.repository)} Its NOTICE file:\n\n\`\`\`\`text\n${notice.text}\n\`\`\`\`\n${i < notices.length - 1 ? '\n' : ''}`);
  });
  console.log(`wrote ${path.relative(root, output)}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
