import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const vscodeignore = readFileSync(new URL('../../.vscodeignore', import.meta.url), 'utf8').split('\n');

test('publisher alanhuang, MIT licence, and the links of the public repository', () => {
  expect(manifest.publisher).toBe('alanhuang');
  expect(manifest.license).toBe('MIT');
  expect(manifest.repository).toEqual({ type: 'git', url: 'https://github.com/AlanHuang99/typst-workshop.git' });
  expect(manifest.homepage).toBe('https://github.com/AlanHuang99/typst-workshop#readme');
  expect(manifest.bugs).toEqual({ url: 'https://github.com/AlanHuang99/typst-workshop/issues' });
  expect(manifest.icon).toBe('media/icon.png');
});

test('the MIT licence text names the copyright holder', () => {
  const license = readFileSync(new URL('../../LICENSE', import.meta.url), 'utf8');
  expect(license.startsWith('MIT License\n\nCopyright (c) 2026 Alan Huang\n')).toBe(true);
  expect(license).toContain('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND');
});

test('the package includes the licence, the notices, the licence texts and the icon', () => {
  for (const line of ['!LICENSE', '!THIRD_PARTY_NOTICES.md', '!licenses/**', '!helper/THIRD_PARTY_LICENSES.md', '!media/**']) expect(vscodeignore).toContain(line);
});

test('the notices point to the Apache-2.0 text and to the generated licences of the helper crates', () => {
  const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
  const notices = read('THIRD_PARTY_NOTICES.md');
  expect(notices).toContain('`licenses/Apache-2.0.txt`');
  expect(notices).toContain('`helper/THIRD_PARTY_LICENSES.md`');
  expect(read('licenses/Apache-2.0.txt')).toMatch(/^\s*Apache License\n\s*Version 2\.0, January 2004\n/);
  const crates = read('helper/THIRD_PARTY_LICENSES.md');
  expect(crates).toMatch(/^# Third-party licences of the helper\n/);
  expect(crates).toContain('x86_64-unknown-linux-musl, aarch64-apple-darwin and x86_64-apple-darwin');
  expect(crates).toContain('[typst 0.15.1](https://github.com/typst/typst)');
  expect(crates).toMatch(/\n- \[mimalloc 0\.1\.\d+\]/);
  expect(crates).toMatch(/\n## OpenSSL 3\.\d+\.\d+\n/);
  expect(crates).toContain('## Notice of typst-assets 0.15.1');
  expect(crates).toMatch(/\n## Notice of hayagriva \d+\.\d+\.\d+\n[^]*The Creative Commons BY-SA 3\.0 DEED License applies to:/);
  expect(crates).toMatch(/\n## Notice of subsetter \d+\.\d+\.\d+\n[^]*Code from ttf-parser was used\/adapted/);
  expect(manifest.scripts['licenses:helper']).toBe('node scripts/helper-licenses.mjs');
});

test("typst's own NOTICE is shipped verbatim and named in the Typst section of the notices", () => {
  const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
  expect(read('licenses/typst-NOTICE.txt')).toMatch(/^Licenses for third party components used by this project can be found below\.\n/);
  const typst = read('THIRD_PARTY_NOTICES.md').split('\n## ').find((section) => section.startsWith('Typst\n'));
  expect(typst).toContain('`licenses/typst-NOTICE.txt`');
  expect(vscodeignore).toContain('!licenses/**');
});

test('the notices name musl, whose licence is shipped, and say that the embedded fonts are unmodified, with the link to their sources', () => {
  const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
  const notices = read('THIRD_PARTY_NOTICES.md');
  expect(notices).toContain('`licenses/musl-COPYRIGHT.txt`');
  expect(read('licenses/musl-COPYRIGHT.txt')).toMatch(/^musl as a whole is licensed under the following standard MIT license:\n/);
  expect(notices).toContain('The embedded fonts are distributed unmodified; their sources are available in the typst-assets repository (https://github.com/typst/typst-assets)');
});

test('the Build button is in the title bar of Typst editors and of the PDF tab', () => {
  const title = manifest.contributes.menus['editor/title'];
  expect(title).toContainEqual({ command: 'typst-workshop.build', when: 'resourceLangId == typst', group: 'navigation@1' });
  expect(title).toContainEqual({ command: 'typst-workshop.build', when: "activeWebviewPanelId == 'typst-workshop.pdf'", group: 'navigation@1' });
});

test('the sidebar: an Activity Bar container with the Project, Commands and Settings views', () => {
  expect(manifest.contributes.viewsContainers.activitybar).toEqual([{ id: 'typst-workshop', title: 'Typst Workshop', icon: 'media/typst-workshop.svg' }]);
  expect(manifest.contributes.views['typst-workshop'].map((v: { id: string; name: string }) => [v.id, v.name])).toEqual([
    ['typst-workshop.project', 'Project'],
    ['typst-workshop.commands', 'Commands'],
    ['typst-workshop.settings', 'Settings'],
  ]);
  expect(manifest.contributes.viewsWelcome).toEqual([{ view: 'typst-workshop.project', contents: 'Open a Typst file to see the entry file that builds it, its PDF and its last build.' }]);
});

test('the Activity Bar icon is an original monochrome 24×24 SVG without text, packaged with the extension', () => {
  const svg = readFileSync(new URL('../../media/typst-workshop.svg', import.meta.url), 'utf8');
  expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="24" height="24" viewBox="0 0 24 24"/);
  expect(svg).toContain('stroke="currentColor"');
  expect(svg).not.toMatch(/<text|<image|fill="#|stroke="#|<style|<script/);
  expect(vscodeignore).toContain('!media/**');
});

test('the marketplace icon is a 128×128 PNG rendered from an SVG source without text', () => {
  const png = readFileSync(new URL('../../media/icon.png', import.meta.url));
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  expect(png.toString('latin1', 12, 16)).toBe('IHDR');
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([128, 128]);
  const svg = readFileSync(new URL('../../media/icon.svg', import.meta.url), 'utf8');
  expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="128" height="128" viewBox="0 0 128 128"/);
  expect(svg).not.toMatch(/<text|<image|<style|<script/);
  expect(manifest.scripts.icon).toBe('node scripts/render-icon.mjs');
});

test('inline buttons on project items: build, view PDF, and pin the entry or clear the pin by context value', () => {
  const project = 'view == typst-workshop.project && viewItem =~ /^(entry|orphan)/';
  expect(manifest.contributes.menus['view/item/context']).toEqual([
    { command: 'typst-workshop.buildEntry', when: project, group: 'inline@1' },
    { command: 'typst-workshop.viewEntry', when: project, group: 'inline@2' },
    { command: 'typst-workshop.pinEntryFile', when: 'view == typst-workshop.project && viewItem == entry', group: 'inline@3' },
    { command: 'typst-workshop.unpinEntryFile', when: 'view == typst-workshop.project && viewItem == entry.pinned', group: 'inline@3' },
  ]);
  expect(manifest.contributes.menus['view/title']).toEqual([{ command: 'typst-workshop.openSettings', when: 'view == typst-workshop.settings', group: 'navigation' }]);
});

test('the sidebar commands have titles and icons; the internal ones are hidden from the Command Palette, Open Settings is not', () => {
  const commands = new Map<string, { title: string; icon?: string; category?: string }>(manifest.contributes.commands.map((c: { command: string }) => [c.command, c]));
  expect(commands.get('typst-workshop.buildEntry')).toMatchObject({ title: 'Build Project', icon: '$(play)' });
  expect(commands.get('typst-workshop.viewEntry')).toMatchObject({ title: 'View PDF', icon: '$(open-preview)' });
  expect(commands.get('typst-workshop.pinEntryFile')).toMatchObject({ title: 'Pin as Entry', icon: '$(pin)' });
  expect(commands.get('typst-workshop.unpinEntryFile')).toMatchObject({ title: 'Clear Entry Setting', icon: '$(pinned)' });
  expect(commands.get('typst-workshop.changeSetting')).toMatchObject({ title: 'Change Setting' });
  expect(commands.get('typst-workshop.openSettings')).toMatchObject({ title: 'Open Settings', icon: '$(gear)', category: 'Typst Workshop' });
  const palette = manifest.contributes.menus.commandPalette;
  for (const id of ['typst-workshop.buildEntry', 'typst-workshop.viewEntry', 'typst-workshop.pinEntryFile', 'typst-workshop.unpinEntryFile', 'typst-workshop.changeSetting']) expect(palette).toContainEqual({ command: id, when: 'false' });
  expect(palette.some((m: { command: string }) => m.command === 'typst-workshop.openSettings')).toBe(false);
});
