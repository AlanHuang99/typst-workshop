// Prints the CHANGELOG.md section of a version (the text under its "## <version>" heading), the body of the GitHub Release (release.yml).
// Usage: node scripts/release-notes.mjs <version>
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The text of the section of `version` in a changelog whose versions are "## <version>" headings, optionally followed by a date.
 * @param {string} changelog
 * @param {string} version
 * @returns {string}
 */
export function releaseNotes(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `## ${version}` || line.startsWith(`## ${version} `));
  if (start < 0) throw new Error(`CHANGELOG.md has no section for ${version}`);
  const next = lines.findIndex((line, i) => i > start && line.startsWith('## '));
  const body = lines
    .slice(start + 1, next < 0 ? lines.length : next)
    .join('\n')
    .trim();
  if (body === '') throw new Error(`the CHANGELOG.md section for ${version} is empty`);
  return body;
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === self) {
  try {
    const version = process.argv[2];
    if (!version) throw new Error('usage: node scripts/release-notes.mjs <version>');
    const changelog = readFileSync(path.join(path.dirname(self), '..', 'CHANGELOG.md'), 'utf8');
    process.stdout.write(`${releaseNotes(changelog, version)}\n`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
