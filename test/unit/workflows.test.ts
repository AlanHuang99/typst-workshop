import { readdirSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { pinnedTypst } from '../../scripts/typst-update.mjs';

const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
const ci = read('.github/workflows/ci.yml');
const release = read('.github/workflows/release.yml');
const typstUpdate = read('.github/workflows/typst-update.yml');
const workflows = readdirSync(new URL('../../.github/workflows/', import.meta.url)).map((file) => read(`.github/workflows/${file}`));

test('the workflows are CI, Release and Typst update', () => {
  expect(readdirSync(new URL('../../.github/workflows/', import.meta.url)).sort()).toEqual(['ci.yml', 'release.yml', 'typst-update.yml']);
});

test('third-party actions are pinned to a commit with the version as a comment; first-party actions use major tags', () => {
  const uses = [...workflows.join('\n').matchAll(/^\s*(?:- )?uses: (\S+)(.*)$/gm)].map((m) => ({ action: m[1], rest: m[2] }));
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
  for (const workflow of workflows) {
    const jobs = workflow.split(/\n(?= {2}[\w-]+:\n)/).slice(1);
    for (const job of jobs.filter((j) => j.includes('\n    steps:'))) expect(job).toMatch(/\n {4}timeout-minutes: \d+\n/);
  }
});

test('the release checks the version before the platform builds start: against the tag, or, started by hand, that it runs on main and the version has no tag yet', () => {
  expect(release).toMatch(/\non:\n {2}push:\n {4}tags: \['v\*'\]\n {2}workflow_dispatch:\n/);
  expect(release).toMatch(/\n {2}build:\n {4}needs: check\n {4}uses: \.\/\.github\/workflows\/ci\.yml\n/);
  expect(release).toContain('elif [ "$GITHUB_REF_NAME" != "v$version" ]; then');
  expect(release).toContain('if [ "$GITHUB_REF" != refs/heads/main ]; then');
  expect(release).toContain('tags="$(git ls-remote --tags origin "refs/tags/v$version")"');
  expect(release).toContain('node scripts/release-notes.mjs "$version" > /dev/null');
  expect(release).toContain('tag_name: v${{ env.VERSION }}');
  expect(release).toContain('target_commitish: ${{ github.sha }}');
});

test('ovsx is pinned to one version, installed from tools/ovsx/package-lock.json, and reads the token from the environment only', () => {
  const pinned = JSON.parse(read('tools/ovsx/package.json')).dependencies.ovsx;
  expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
  expect(JSON.parse(read('tools/ovsx/package-lock.json')).packages['node_modules/ovsx'].version).toBe(pinned);
  expect(release).toContain('run: npm ci --ignore-scripts --prefix tools/ovsx');
  expect(release).toContain('tools/ovsx/node_modules/.bin/ovsx publish "vsix/typst-workshop-$target-$VERSION.vsix" --skip-duplicate');
  expect(release).not.toMatch(/ovsx[^\n]*(?: -p | --pat)/);
  expect(release).toContain('OVSX_PAT: ${{ secrets.OVSX_PAT }}');
});

test('linux-x64 and darwin-arm64 are built, released and published; macOS builds target macOS 11; each package is checked by running the helper inside it', () => {
  const targets = [...ci.matchAll(/^ +target: (\S+)$/gm)].map((m) => m[1]);
  expect(targets).toEqual(['linux-x64', 'darwin-arm64']);
  for (const target of targets) expect(release).toContain(`vsix/typst-workshop-${target}-\${{ env.VERSION }}.vsix`);
  expect(release).toContain(`for target in ${targets.join(' ')}; do`);
  expect(ci).toContain('run: echo "MACOSX_DEPLOYMENT_TARGET=11.0" >> "$GITHUB_ENV"');
  expect(ci).toContain('unzip -q "typst-workshop-$TARGET-$version.vsix" -d "$dir"');
  expect(ci).toContain('actual="$("$dir/extension/bin/typst-workshop-helper" --version)"');
});

test('CI takes the Typst version from the pins of helper/Cargo.toml and runs once a week as well', () => {
  expect(ci).not.toMatch(/releases\/download\/v\d|\(typst \d|typst CLI \d/);
  expect(ci).not.toContain(pinnedTypst(read('helper/Cargo.toml')));
  expect(ci).toContain('version="$(node scripts/typst-update.mjs pinned)"');
  expect(ci).toContain('https://github.com/typst/typst/releases/download/v$version/$TYPST_ASSET');
  expect(ci).toContain('expected="typst-workshop-helper $helper_version (typst $PINNED_TYPST)"');
  expect(ci).toMatch(/\n {2}schedule:\n {4}- cron: '[\d*]+ [\d*]+ \* \* \d'\n/);
});

test('no workflow sets a variable named TYPST_VERSION, which typst-utils reads from the environment of the build: no env: key, no shell assignment, nothing written to $GITHUB_ENV', () => {
  const setsTypstVersion = /\bTYPST_VERSION\s*[:=]/;
  const settings = ['env:\n  TYPST_VERSION: 0.15.1', 'run: TYPST_VERSION=0.15.1 cargo build', 'run: echo "TYPST_VERSION=0.15.1" >> "$GITHUB_ENV"', 'run: export TYPST_VERSION="$version"'];
  expect(settings.filter((text) => !setsTypstVersion.test(text))).toEqual([]);
  for (const workflow of workflows) expect(workflow).not.toMatch(setsTypstVersion);
});

/** The jobs of a workflow by id. */
function jobsOf(workflow: string): Record<string, string> {
  const parts = workflow.split('\njobs:\n')[1].split(/\n(?= {2}[\w-]+:\n)/);
  return Object.fromEntries(parts.flatMap((part) => {
    const id = /^ {2}([\w-]+):$/m.exec(part)?.[1];
    return id === undefined ? [] : [[id, part]];
  }));
}

test('the Typst update runs once a week and when started by hand, on main only, in two jobs', () => {
  expect(typstUpdate).toMatch(/\n {2}schedule:\n {4}- cron: '[\d*]+ [\d*]+ \* \* \d'\n {2}workflow_dispatch:\n/);
  const jobs = jobsOf(typstUpdate);
  expect(Object.keys(jobs)).toEqual(['prepare', 'publish']);
  expect(jobs.prepare).toContain("\n    if: github.ref == 'refs/heads/main'\n");
  expect(jobs.publish).toContain('\n    needs: prepare\n');
});

test('the first job, with a token that only reads and is not kept by the checkout, looks for a newer Typst without a pull request of this repository, runs scripts/typst-update.mjs and uploads the patch and the summary', () => {
  const { prepare } = jobsOf(typstUpdate);
  expect(prepare).toMatch(/\n {4}permissions:\n {6}contents: read\b[^\n]*\n {6}pull-requests: read\b[^\n]*\n {4}outputs:\n/);
  expect(prepare).toContain('\n          fetch-depth: 0\n          persist-credentials: false\n');
  for (const output of ['newer', 'exists', 'latest', 'branch']) expect(prepare).toContain(`\n      ${output}: \${{ steps.check.outputs.${output} }}\n`);
  expect(prepare).toContain('versions="$(node scripts/typst-update.mjs check)"');
  // A pull request from a fork can have a branch of the same name.
  expect(prepare).toContain(`pulls="$(gh pr list --head "$branch" --state all --json isCrossRepository --jq '[.[] | select(.isCrossRepository | not)] | length')"`);
  expect(prepare).toContain('node scripts/typst-update.mjs apply "$LATEST" > "$RUNNER_TEMP/typst-update/summary.md"');
  expect(prepare).toContain('git diff --binary > "$RUNNER_TEMP/typst-update/update.patch"');
  expect(prepare).toContain('- uses: actions/upload-artifact@v7');
});

test('the second job runs only when an update is due and only git, gh and first-party actions: it applies the patch to the same commit, pushes the branch typst-<version>, opens its pull request and starts CI on it', () => {
  const { publish } = jobsOf(typstUpdate);
  expect(publish).toContain("\n    if: needs.prepare.outputs.newer == 'true' && needs.prepare.outputs.exists != 'true'\n");
  expect(publish).toMatch(/\n {4}permissions:\n {6}contents: write\b[^\n]*\n {6}pull-requests: write\b[^\n]*\n {6}actions: write\b[^\n]*\n {4}steps:\n/);
  expect([...publish.matchAll(/uses: (\S+)/g)].map((m) => m[1])).toEqual(['actions/checkout@v7', 'actions/download-artifact@v8']);
  expect(publish).not.toMatch(/\b(?:node|npm|npx|cargo|rustup)\b/);
  expect(publish).toContain('git apply --index "$RUNNER_TEMP/typst-update/update.patch"');
  expect(publish).toContain('git push --force origin "$BRANCH"');
  expect(publish).toContain('gh pr create --base main --head "$BRANCH" --title "Typst $LATEST" --body-file "$RUNNER_TEMP/typst-update/summary.md"');
  expect(publish).toContain('gh workflow run ci.yml --ref "$BRANCH"');
  // A push with the workflow token may not change workflow files, so the update leaves .github alone.
  expect(read('scripts/typst-update.mjs')).not.toMatch(/\.github\//);
});

test('Dependabot updates the npm packages and the GitHub Actions, but not the Rust crates, pdfjs-dist or @types/vscode', () => {
  const dependabot = read('.github/dependabot.yml');
  expect([...dependabot.matchAll(/- package-ecosystem: (\S+)\n {4}directory: (\S+)/g)].map((m) => `${m[1]} ${m[2]}`)).toEqual(['npm /', 'npm /tools/ovsx', 'github-actions /']);
  expect(dependabot).toContain('- dependency-name: pdfjs-dist\n');
  expect(dependabot).toContain("- dependency-name: '@types/vscode'\n");
});
