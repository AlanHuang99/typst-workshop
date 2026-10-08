import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import { binaryTarget, elfLinkage, findCargo, helperBuildArgs, helperProblem, hostTarget, packageOptions, vsixName } from '../../scripts/platform.mjs';

describe('findCargo', () => {
  const files = (...paths: string[]) => (p: string) => paths.includes(p);

  test('cargo on PATH comes first, in PATH order', () => {
    const env = { PATH: ['/opt/a', '/usr/bin', '/opt/b'].join(path.delimiter), CARGO_HOME: '/c' };
    expect(findCargo(env, '/home/u', files('/usr/bin/cargo', '/opt/b/cargo', '/c/bin/cargo', '/home/u/.cargo/bin/cargo'))).toBe('/usr/bin/cargo');
  });

  test('without cargo on PATH: $CARGO_HOME/bin, then ~/.cargo/bin', () => {
    const env = { PATH: '/usr/bin', CARGO_HOME: '/c' };
    expect(findCargo(env, '/home/u', files('/c/bin/cargo', '/home/u/.cargo/bin/cargo'))).toBe('/c/bin/cargo');
    expect(findCargo(env, '/home/u', files('/home/u/.cargo/bin/cargo'))).toBe('/home/u/.cargo/bin/cargo');
    expect(findCargo({}, '/home/u', files('/home/u/.cargo/bin/cargo'))).toBe('/home/u/.cargo/bin/cargo');
  });

  test('empty and relative PATH entries are skipped; no cargo anywhere is undefined', () => {
    const env = { PATH: ['', 'bin', '/usr/bin'].join(path.delimiter) };
    expect(findCargo(env, '/home/u', files('bin/cargo', '/home/u/.cargo/bin/cargo'))).toBe('/home/u/.cargo/bin/cargo');
    expect(findCargo(env, '/home/u', files())).toBeUndefined();
  });
});

describe('hostTarget', () => {
  test('the three release platforms', () => {
    expect(hostTarget('linux', 'x64')).toBe('linux-x64');
    expect(hostTarget('darwin', 'arm64')).toBe('darwin-arm64');
    expect(hostTarget('darwin', 'x64')).toBe('darwin-x64');
  });

  test('any other platform is refused with the list of supported ones', () => {
    expect(() => hostTarget('linux', 'arm64')).toThrow('Typst Workshop is packaged for linux-x64, darwin-arm64 and darwin-x64, not for linux-arm64');
    expect(() => hostTarget('win32', 'x64')).toThrow('not for win32-x64');
  });
});

describe('packageOptions', () => {
  test('the host target and the default helper build without arguments', () => {
    expect(packageOptions([], 'darwin', 'arm64')).toEqual({ target: 'darwin-arm64', helperArgs: [] });
  });

  test('--target <t> and --target=<t> choose the package target', () => {
    expect(packageOptions(['--target', 'darwin-x64'], 'linux', 'x64').target).toBe('darwin-x64');
    expect(packageOptions(['--target=linux-x64'], 'darwin', 'arm64').target).toBe('linux-x64');
  });

  test('--helper-target and --features go to the helper build as --target and --features', () => {
    expect(packageOptions(['--target', 'linux-x64', '--helper-target', 'x86_64-unknown-linux-musl', '--features', 'vendored-openssl'], 'linux', 'x64')).toEqual({
      target: 'linux-x64',
      helperTarget: 'x86_64-unknown-linux-musl',
      helperArgs: ['--target', 'x86_64-unknown-linux-musl', '--features', 'vendored-openssl'],
    });
    expect(packageOptions(['--helper-target=aarch64-apple-darwin', '--features', ''], 'darwin', 'arm64').helperArgs).toEqual(['--target', 'aarch64-apple-darwin']);
  });

  test('unknown targets, a missing value and other arguments are refused', () => {
    expect(() => packageOptions(['--target', 'win32-x64'], 'linux', 'x64')).toThrow('unknown target "win32-x64"; expected linux-x64, darwin-arm64 or darwin-x64');
    expect(() => packageOptions(['--target'], 'linux', 'x64')).toThrow('--target needs a value');
    expect(() => packageOptions(['--out', 'x.vsix'], 'linux', 'x64')).toThrow('unknown argument "--out"; usage: npm run package [-- --target <target>] [--helper-target <rust target>] [--features <features>]');
  });
});

describe('helperBuildArgs', () => {
  test('nothing by default: a release build for this machine', () => {
    expect(helperBuildArgs([])).toEqual([]);
  });

  test('--target and --features, in either spelling, go to cargo; empty features are left out', () => {
    expect(helperBuildArgs(['--target', 'x86_64-unknown-linux-musl', '--features', 'vendored-openssl'])).toEqual(['--target', 'x86_64-unknown-linux-musl', '--features', 'vendored-openssl']);
    expect(helperBuildArgs(['--features=vendored-openssl', '--target=x86_64-unknown-linux-musl'])).toEqual(['--target', 'x86_64-unknown-linux-musl', '--features', 'vendored-openssl']);
    expect(helperBuildArgs(['--target', 'aarch64-apple-darwin', '--features', ''])).toEqual(['--target', 'aarch64-apple-darwin']);
  });

  test('a missing value and other arguments are refused', () => {
    expect(() => helperBuildArgs(['--target'])).toThrow('--target needs a value');
    expect(() => helperBuildArgs(['--release'])).toThrow('unknown argument "--release"; usage: npm run build:helper [-- --target <rust target>] [--features <features>]');
  });
});

/** A 64-bit little-endian ELF header followed by program headers of the given types (1 PT_LOAD, 2 PT_DYNAMIC, 3 PT_INTERP, 6 PT_PHDR). */
function elf(machine: number, types: number[] = []): Buffer {
  const b = Buffer.alloc(64 + 56 * types.length);
  b.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  b.writeUInt16LE(machine, 18);
  b.writeBigUInt64LE(64n, 32);
  b.writeUInt16LE(56, 54);
  b.writeUInt16LE(types.length, 56);
  types.forEach((type, i) => b.writeUInt32LE(type, 64 + 56 * i));
  return b;
}

function macho(cputype: number): Buffer {
  const b = Buffer.alloc(32);
  b.writeUInt32LE(0xfeedfacf, 0);
  b.writeUInt32LE(cputype, 4);
  return b;
}

const DYNAMIC = [6, 3, 1, 1, 2];
const STATIC_PIE = [6, 1, 1, 2];

describe('binaryTarget', () => {
  test('64-bit ELF and Mach-O executables of the release platforms', () => {
    expect(binaryTarget(elf(0x3e))).toBe('linux-x64');
    expect(binaryTarget(macho(0x01000007))).toBe('darwin-x64');
    expect(binaryTarget(macho(0x0100000c))).toBe('darwin-arm64');
  });

  test('other machines are named; anything else is undefined', () => {
    expect(binaryTarget(elf(0xb7))).toBe('linux-arm64');
    expect(binaryTarget(Buffer.from('#!/bin/sh\necho hi\n'))).toBeUndefined();
    expect(binaryTarget(Buffer.alloc(0))).toBeUndefined();
    expect(binaryTarget(Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2]))).toBeUndefined();
  });
});

describe('elfLinkage', () => {
  test('an ELF executable with a program interpreter is dynamic; without one (static or static-pie) static', () => {
    expect(elfLinkage(elf(0x3e, DYNAMIC))).toBe('dynamic');
    expect(elfLinkage(elf(0x3e, STATIC_PIE))).toBe('static');
    expect(elfLinkage(elf(0x3e, [1, 1]))).toBe('static');
  });

  test('not ELF, or program headers beyond the bytes read: undefined', () => {
    expect(elfLinkage(macho(0x0100000c))).toBeUndefined();
    expect(elfLinkage(elf(0x3e, DYNAMIC).subarray(0, 100))).toBeUndefined();
  });
});

describe('helperProblem', () => {
  test('a helper for the package target passes; a musl helper must be static', () => {
    expect(helperProblem(elf(0x3e, DYNAMIC), 'linux-x64', undefined)).toBeUndefined();
    expect(helperProblem(elf(0x3e, STATIC_PIE), 'linux-x64', 'x86_64-unknown-linux-musl')).toBeUndefined();
    expect(helperProblem(macho(0x01000007), 'darwin-x64', 'x86_64-apple-darwin')).toBeUndefined();
    expect(helperProblem(elf(0x3e, DYNAMIC), 'linux-x64', 'x86_64-unknown-linux-musl')).toBe('bin/typst-workshop-helper was built for x86_64-unknown-linux-musl but is not a static executable');
  });

  test('a helper for another platform is refused', () => {
    expect(helperProblem(macho(0x0100000c), 'linux-x64', undefined)).toBe('bin/typst-workshop-helper is built for darwin-arm64, not for linux-x64');
    expect(helperProblem(Buffer.from('#!/bin/sh\n'), 'darwin-x64', undefined)).toBe('bin/typst-workshop-helper is built for an unknown platform, not for darwin-x64');
  });
});

test('vsixName', () => {
  expect(vsixName('darwin-arm64', '0.2.0')).toBe('typst-workshop-darwin-arm64-0.2.0.vsix');
});
