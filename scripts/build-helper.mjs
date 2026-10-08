// Builds the helper in release mode with the versions in helper/Cargo.lock and copies the binary to bin/typst-workshop-helper. Cargo is looked up on PATH, then in $CARGO_HOME/bin and ~/.cargo/bin; CARGO_TARGET_DIR is respected. Without arguments the build is for this machine; the published Linux helper is built with --target x86_64-unknown-linux-musl --features vendored-openssl, a static executable.
// Usage: npm run build:helper [-- --target <rust target>] [--features <features>]
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { helperBuildArgs, localCargo } from './platform.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const name = 'typst-workshop-helper';

try {
  const extra = helperBuildArgs(process.argv.slice(2));
  // Diagnostics go to stderr as usual; stdout carries cargo's JSON messages, one of which names the built executable.
  const result = spawnSync(localCargo(), ['build', '--release', '--locked', '--manifest-path', path.join(root, 'helper', 'Cargo.toml'), '--message-format=json-render-diagnostics', ...extra], {
    cwd: root,
    stdio: ['inherit', 'pipe', 'inherit'],
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`cargo build failed (exit ${result.status ?? result.signal})`);
  let executable;
  for (const line of result.stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    const message = JSON.parse(line);
    if (message.reason === 'compiler-artifact' && message.target?.name === name && message.executable) executable = message.executable;
  }
  if (executable === undefined) throw new Error(`cargo did not report the ${name} executable`);
  // Copy next to the destination and rename, so that a running helper keeps its file and macOS does not see a signed binary change in place.
  const bin = path.join(root, 'bin');
  const dest = path.join(bin, name);
  const tmp = path.join(bin, `.${name}.${process.pid}`);
  mkdirSync(bin, { recursive: true });
  try {
    copyFileSync(executable, tmp);
    chmodSync(tmp, 0o755);
    renameSync(tmp, dest);
  } finally {
    rmSync(tmp, { force: true });
  }
  console.log(`copied ${executable} to ${path.relative(root, dest)}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
