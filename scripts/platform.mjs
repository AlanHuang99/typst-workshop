// Platform helpers of the build and package scripts: where cargo is, which release target this machine builds, and which target a helper binary was built for.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The release targets, as `vsce package --target` names them. */
export const TARGETS = ['linux-x64', 'darwin-arm64', 'darwin-x64'];

const TARGET_LIST = 'linux-x64, darwin-arm64 or darwin-x64';

/**
 * The cargo to run: the first `cargo` on PATH, else `$CARGO_HOME/bin/cargo`, else `~/.cargo/bin/cargo` (where rustup installs it without changing PATH for non-login shells).
 * @param {Record<string, string | undefined>} env
 * @param {string} homedir
 * @param {(file: string) => boolean} isExecutable
 * @returns {string | undefined}
 */
export function findCargo(env, homedir, isExecutable) {
  const candidates = (env.PATH ?? '')
    .split(path.delimiter)
    .filter((dir) => path.isAbsolute(dir))
    .map((dir) => path.join(dir, 'cargo'));
  if (env.CARGO_HOME) candidates.push(path.join(env.CARGO_HOME, 'bin', 'cargo'));
  candidates.push(path.join(homedir, '.cargo', 'bin', 'cargo'));
  return candidates.find((file) => isExecutable(file));
}

/**
 * Whether a path is an executable file.
 * @param {string} file
 * @returns {boolean}
 */
export function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * The error message when there is no cargo, with the Rust version that a manifest asks for (its `rust-version`).
 * @param {string} cargoToml
 * @returns {string}
 */
export function noCargoMessage(cargoToml) {
  const rust = /^rust-version = "([^"]+)"/m.exec(cargoToml)?.[1];
  return `cargo was not found on PATH, in $CARGO_HOME/bin or in ~/.cargo/bin; install Rust${rust === undefined ? '' : ` ${rust} or later`} (https://rustup.rs)`;
}

/**
 * The cargo of this machine (see `findCargo`); throws with installation advice when there is none, naming the Rust version of helper/Cargo.toml.
 * @returns {string}
 */
export function localCargo() {
  const cargo = findCargo(process.env, os.homedir(), isExecutable);
  if (cargo === undefined) throw new Error(noCargoMessage(fs.readFileSync(new URL('../helper/Cargo.toml', import.meta.url), 'utf8')));
  return cargo;
}

/**
 * The release target of a machine.
 * @param {string} platform `process.platform`
 * @param {string} arch `process.arch`
 * @returns {string}
 */
export function hostTarget(platform, arch) {
  const target = `${platform}-${arch}`;
  if (!TARGETS.includes(target)) throw new Error(`Typst Workshop is packaged for linux-x64, darwin-arm64 and darwin-x64, not for ${target}`);
  return target;
}

/**
 * The values of the options `--<name> <value>` or `--<name>=<value>` in `argv`, for the given names; any other argument is refused with `usage`.
 * @param {string[]} argv
 * @param {string[]} names
 * @param {string} usage
 * @returns {Record<string, string>}
 */
function parseOptions(argv, names, usage) {
  /** @type {Record<string, string>} */
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const name = names.find((n) => arg === `--${n}` || arg.startsWith(`--${n}=`));
    if (name === undefined) throw new Error(`unknown argument "${arg}"; usage: ${usage}`);
    if (arg === `--${name}`) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`--${name} needs a value; usage: ${usage}`);
      options[name] = value;
    } else {
      options[name] = arg.slice(name.length + 3);
    }
  }
  return options;
}

/**
 * The cargo arguments of a helper build for a Rust target and with crate features; empty values are left out.
 * @param {string | undefined} target
 * @param {string | undefined} features
 * @returns {string[]}
 */
function cargoTargetArgs(target, features) {
  return [...(target ? ['--target', target] : []), ...(features ? ['--features', features] : [])];
}

/**
 * The extra cargo arguments of `npm run build:helper [-- --target <rust target>] [--features <features>]`.
 * @param {string[]} argv the arguments after the script name
 * @returns {string[]}
 */
export function helperBuildArgs(argv) {
  const options = parseOptions(argv, ['target', 'features'], 'npm run build:helper [-- --target <rust target>] [--features <features>]');
  return cargoTargetArgs(options.target, options.features);
}

/**
 * The options of `npm run package [-- --target <target>] [--helper-target <rust target>] [--features <features>]`: the package target (default: the host target), the Rust target of the helper if one was given, and the arguments of the helper build.
 * @param {string[]} argv the arguments after the script name
 * @param {string} platform
 * @param {string} arch
 * @returns {{ target: string, helperTarget: string | undefined, helperArgs: string[] }}
 */
export function packageOptions(argv, platform, arch) {
  const options = parseOptions(argv, ['target', 'helper-target', 'features'], 'npm run package [-- --target <target>] [--helper-target <rust target>] [--features <features>]');
  const target = options.target ?? hostTarget(platform, arch);
  if (!TARGETS.includes(target)) throw new Error(`unknown target "${target}"; expected ${TARGET_LIST}`);
  const helperTarget = options['helper-target'] || undefined;
  return { target, helperTarget, helperArgs: cargoTargetArgs(helperTarget, options.features) };
}

/**
 * The target a 64-bit ELF or Mach-O executable was built for, from its header; undefined for anything else.
 * @param {Uint8Array} bytes the start of the file (at least 20 bytes)
 * @returns {string | undefined}
 */
export function binaryTarget(bytes) {
  if (bytes.length < 20) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // ELF: magic, 64-bit class, little-endian data; e_machine at offset 18.
  if (view.getUint32(0, false) === 0x7f454c46 && bytes[4] === 2 && bytes[5] === 1) {
    const machine = view.getUint16(18, true);
    if (machine === 0x3e) return 'linux-x64';
    if (machine === 0xb7) return 'linux-arm64';
    return undefined;
  }
  // Mach-O 64-bit, little-endian: magic 0xfeedfacf; cputype at offset 4.
  if (view.getUint32(0, true) === 0xfeedfacf) {
    const cputype = view.getUint32(4, true);
    if (cputype === 0x01000007) return 'darwin-x64';
    if (cputype === 0x0100000c) return 'darwin-arm64';
  }
  return undefined;
}

/**
 * Whether a 64-bit little-endian ELF executable is linked statically (static or static-pie: no program interpreter) or dynamically; undefined for anything else or when its program headers lie beyond `bytes`.
 * @param {Uint8Array} bytes the start of the file
 * @returns {'static' | 'dynamic' | undefined}
 */
export function elfLinkage(bytes) {
  if (bytes.length < 64) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, false) !== 0x7f454c46 || bytes[4] !== 2 || bytes[5] !== 1) return undefined;
  const offset = Number(view.getBigUint64(32, true));
  const size = view.getUint16(54, true);
  const count = view.getUint16(56, true);
  if (size < 4 || offset + size * count > bytes.length) return undefined;
  for (let i = 0; i < count; i++) {
    // PT_INTERP names the dynamic loader.
    if (view.getUint32(offset + i * size, true) === 3) return 'dynamic';
  }
  return 'static';
}

/**
 * Why a helper binary cannot go into the package of `target`, or undefined: it must be built for that target, and a helper built for a musl target must be a static executable.
 * @param {Uint8Array} bytes the start of the binary
 * @param {string} target the package target
 * @param {string | undefined} helperTarget the Rust target it was built for, if one was given
 * @returns {string | undefined}
 */
export function helperProblem(bytes, target, helperTarget) {
  const built = binaryTarget(bytes);
  if (built !== target) return `bin/typst-workshop-helper is built for ${built ?? 'an unknown platform'}, not for ${target}`;
  if (helperTarget?.endsWith('-musl') && elfLinkage(bytes) !== 'static') return `bin/typst-workshop-helper was built for ${helperTarget} but is not a static executable`;
  return undefined;
}

/**
 * The file name of the package of a target.
 * @param {string} target
 * @param {string} version
 * @returns {string}
 */
export function vsixName(target, version) {
  return `typst-workshop-${target}-${version}.vsix`;
}
