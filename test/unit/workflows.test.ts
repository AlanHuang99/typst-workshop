import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
const ci = read('.github/workflows/ci.yml');
const release = read('.github/workflows/release.yml');

test('third-party actions are pinned to a commit with the version as a comment; first-party actions use major tags', () => {
  const uses = [...`${ci}\n${release}`.matchAll(/^\s*(?:- )?uses: (\S+)(.*)$/gm)].map((m) => ({ action: m[1], rest: m[2] }));
  expect(uses.length).toBeGreaterThan(0);
  for (const { action, rest } of uses) {
    if (action.startsWith('./')) continue;
    if (action.startsWith('actions/')) expect(action).toMatch(/^actions\/[a-z-]+@v\d+$/);
    else {
      expect(action).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
      expect(rest).toMatch(/^ # \S+/);
    }
  }
});

test('every job that runs steps has a timeout', () => {
  for (const workflow of [ci, release]) {
    const jobs = workflow.split(/\n(?= {2}[\w-]+:\n)/).slice(1);
    for (const job of jobs.filter((j) => j.includes('\n    steps:'))) expect(job).toMatch(/\n {4}timeout-minutes: \d+\n/);
  }
});

test('the release checks the tag before the platform builds start', () => {
  expect(release).toMatch(/\n {2}build:\n {4}needs: check\n {4}uses: \.\/\.github\/workflows\/ci\.yml\n/);
  expect(release).toContain('if [ "$GITHUB_REF_NAME" != "v$version" ]; then');
});

test('ovsx comes from tools/ovsx/package-lock.json and reads the token from the environment only', () => {
  const tool = JSON.parse(read('tools/ovsx/package.json'));
  expect(tool.dependencies).toEqual({ ovsx: '1.2.0' });
  expect(JSON.parse(read('tools/ovsx/package-lock.json')).packages['node_modules/ovsx'].version).toBe('1.2.0');
  expect(release).toContain('run: npm ci --ignore-scripts --prefix tools/ovsx');
  expect(release).toContain('tools/ovsx/node_modules/.bin/ovsx publish "vsix/typst-workshop-$target-$VERSION.vsix" --skip-duplicate');
  expect(release).not.toMatch(/ovsx[^\n]*(?: -p | --pat)/);
  expect(release).toContain('OVSX_PAT: ${{ secrets.OVSX_PAT }}');
});

test('macOS builds target macOS 11; each package is checked by running the helper inside it', () => {
  expect(ci).toContain('run: echo "MACOSX_DEPLOYMENT_TARGET=11.0" >> "$GITHUB_ENV"');
  expect(ci).toContain('unzip -q "typst-workshop-$TARGET-$version.vsix" -d "$dir"');
  expect(ci).toContain('actual="$("$dir/extension/bin/typst-workshop-helper" --version)"');
});
