// Builds the helper and the bundles and packages the extension as typst-workshop-<target>-<version>.vsix, for this machine's platform (linux-x64, darwin-arm64 or darwin-x64) or for --target <target>. --helper-target and --features go to the helper build (scripts/build-helper.mjs); the package is refused when the helper binary does not match the target, or when a helper built for a musl target is not a static executable.
// Usage: npm run package [-- --target <target>] [--helper-target <rust target>] [--features <features>]
import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, readSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { binaryTarget, elfLinkage, helperProblem, packageOptions, vsixName } from './platform.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Runs a command in the repository root; throws when it fails. */
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} ${args.join(' ')} failed (exit ${result.status ?? result.signal})`);
}

/** The first bytes of a file. */
function head(file, length) {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    return buffer.subarray(0, readSync(fd, buffer, 0, length, 0));
  } finally {
    closeSync(fd);
  }
}

try {
  const { target, helperTarget, helperArgs } = packageOptions(process.argv.slice(2), process.platform, process.arch);
  run(process.execPath, [path.join(root, 'scripts', 'build-helper.mjs'), ...helperArgs]);
  run(process.execPath, [path.join(root, 'esbuild.mjs')]);
  const helper = head(path.join(root, 'bin', 'typst-workshop-helper'), 64 * 1024);
  const problem = helperProblem(helper, target, helperTarget);
  if (problem !== undefined) throw new Error(problem);
  const linkage = elfLinkage(helper);
  console.log(`bin/typst-workshop-helper: ${binaryTarget(helper)}${linkage ? `, ${linkage}ally linked` : ''}`);
  const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  run(path.join(root, 'node_modules', '.bin', 'vsce'), ['package', '--target', target, '--out', vsixName(target, version)]);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
